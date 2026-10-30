import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { test, expect } from '../lib/fixtures.mjs';
import { smokeConfig } from '../lib/config.mjs';
import { signIn } from '../lib/auth.mjs';
import { setComposer } from '../lib/webchat.mjs';
import { ROBOTEAM_BASE_PATH, roboTeamApi } from '../lib/conversation-skills.mjs';
import {
  discoverContainers, nestedLogsMerged, startPoller, stopPoller, readPoll, bwrapMarkerProcesses, createProjectFixture, sentinelHits,
} from '../lib/robowork-e2e.mjs';
import {
  sleep, waitFor, readLedgerSince, markerOf, terminalEvent, queuedEvent, toolOutputs, finalText, workerProcesses, orphanReport, isClean, apiOk,
} from '../lib/robowork-scenarios.mjs';

// RoboWork r10 e2e scenarios on a live deployment (run `node scripts/run-robowork-e2e.mjs specs/09-robowork-scenarios.spec.mjs`).
//   SMOKE_ROBOWORK_FLOW=1     (A) two-phase RoboFlow: both phases run as worker executions, in order, with the right files
//   SMOKE_ROBOWORK_LATE=1     (C) a file created while a task runs is readable by that task, and masked for the next task
//   SMOKE_ROBOWORK_RESTART=1  (B) RoboTeam is restarted (`ploinky restart roboTeamAgent`) while a phase runs on the worker
// Only the RESTART scenario restarts an agent; it must be selected explicitly. Model-dependent turns may be repeated up to 3 times, but only
// when the execution completed, no protected file changed and no sentinel leaked and the expected deterministic output is missing; a failed
// execution, a changed host file or a leaked sentinel fails at once.
const FLOW = process.env.SMOKE_ROBOWORK_FLOW === '1';
const LATE = process.env.SMOKE_ROBOWORK_LATE === '1';
const RESTART = process.env.SMOKE_ROBOWORK_RESTART === '1';
const robotName = process.env.SMOKE_ROBOWORK_ROBOT || 'e2e-bot';
const BOT = '#chatList > .wa-message.in:not(.wa-typing):not(.wa-task-item) .wa-message-bubble';
const MAX_ATTEMPTS = 3;
const TERMINAL_FLOW = new Set(['completed', 'failed', 'terminated']);
const stamp = () => Date.now().toString(36);

function context(label, testInfo) {
  const workspaceRoot = smokeConfig.workspaceRoot;
  assert.ok(path.isAbsolute(workspaceRoot), 'Set SMOKE_WORKSPACE_ROOT to the deployed workspace.');
  const evidenceDir = path.resolve(process.env.SMOKE_ROBOWORK_EVIDENCE || path.join(smokeConfig.artifactRoot, 'robowork'), label);
  fs.mkdirSync(evidenceDir, { recursive: true });
  const save = (name, value) => {
    fs.mkdirSync(path.dirname(path.join(evidenceDir, name)), { recursive: true });
    fs.writeFileSync(path.join(evidenceDir, name), typeof value === 'string' ? value : JSON.stringify(value, null, 2));
  };
  return { workspaceRoot, evidenceDir, save, containers: discoverContainers({ workspaceRoot }), startedMs: Date.now(), testInfo };
}

async function openRoboTeam(page) {
  await signIn(page, smokeConfig.primaryUser, ROBOTEAM_BASE_PATH);
}

async function ensureRobot(page) {
  const listed = await apiOk(roboTeamApi, page, { path: 'api/robots' });
  if (!listed.robots.some((robot) => robot.name === robotName)) {
    await apiOk(roboTeamApi, page, { method: 'POST', path: 'api/robots', body: { name: robotName, codingAgents: ['opencode'] } });
  }
  return listed.robots;
}

// A RoboFlow phase is dispatched with the background binding, which cannot configure a worker robot whose desired configuration changed
// since it was provisioned (`worker_robot_stale`). An administrator request does: PATCH coding-agents with the unchanged agents re-ensures
// the robot on the worker. The scenario does that first, for every robot, and records each result.
async function ensureRobotsCurrent(page, save, workspaceRoot) {
  const listed = await apiOk(roboTeamApi, page, { path: 'api/robots' });
  const results = [];
  for (const robot of listed.robots) {
    const reply = await roboTeamApi(page, { method: 'PATCH', path: `api/robots/${robot.id}/coding-agents`, body: { codingAgents: robot.codingAgents } });
    const entry = { robot: robot.name, run: robot.run, status: reply.status, worker: reply.payload?.worker ?? reply.payload?.error ?? null };
    if (reply.status === 409) {
      // Not stopped / has unfinished tasks: a user WebChat turn to that robot goes through the owner-grant ensure path instead.
      const scratch = `e2e-ensure-${stamp()}`;
      fs.mkdirSync(path.join(workspaceRoot, scratch), { recursive: true });
      entry.fallbackAnswer = (await chatTurn(page, scratch, 'Reply with the single word OK.', { robot: robot.name })).slice(0, 200);
      await page.goto(`${ROBOTEAM_BASE_PATH}`, { waitUntil: 'load' });
    }
    results.push(entry);
  }
  save('ensure-robots.json', results);
  return results;
}

// Sends one WebChat turn to the robot, targeting the project, and waits for the answer.
async function chatTurn(page, project, prompt, { timeoutMs = 5 * 60_000, robot = robotName } = {}) {
  const params = new URLSearchParams({ agent: smokeConfig.webchatAgent, robot, 'forward-envelope': '1', 'workspace-dir': project });
  if (!page.url().includes(`workspace-dir=${project}`) || !page.url().includes(`robot=${encodeURIComponent(robot)}`)) {
    await page.goto(`/webchat?${params}`, { waitUntil: 'load' });
    await expect(page.locator('#cmd')).toBeVisible();
    await page.waitForTimeout(4000);
  }
  const before = await page.locator(BOT).count();
  await setComposer(page, prompt);
  await page.locator('#send').click();
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    await page.waitForTimeout(2000);
    const texts = await page.locator(BOT).allTextContents();
    const busy = await page.locator('#cancelBtn').isVisible().catch(() => false);
    if (!busy && texts.length > before) return texts.slice(before).join('\n---\n');
    if (Date.now() > deadline) throw new Error(`The turn did not finish within ${timeoutMs / 1000} s.`);
  }
}

function protectedUnchanged(fixture) {
  return Object.fromEntries(Object.entries(fixture.protectedFiles).map(([name, text]) => {
    try { return [name, fs.readFileSync(path.join(fixture.root, name), 'utf8') === text]; } catch { return [name, false]; }
  }));
}

// ---- RoboFlow helpers

async function createTwoPhaseWorkflow(page, { name, p1, p2 }) {
  const body = {
    name, description: `Two-phase e2e workflow ${name}`, entryTaskId: 'p1',
    tasks: [
      { id: 'p1', name: 'Phase 1', prompt: p1, skillsets: [], executionType: 'terminal' },
      { id: 'p2', name: 'Phase 2', prompt: p2, skillsets: [], executionType: 'terminal' },
    ],
    edges: [{ id: 'e1', sourceTaskId: 'p1', targetTaskId: 'p2' }],
  };
  const created = await apiOk(roboTeamApi, page, { method: 'POST', path: 'api/roboflow/workflows', body }, [201]);
  return created.workflow;
}

async function startFlow(page, { workflowId, folder, objective }) {
  const started = await apiOk(roboTeamApi, page, { method: 'POST', path: 'api/roboflow/flows', body: { workflowTypeId: workflowId, folder, objective } }, [201]);
  return started.flow;
}

const getFlow = async (page, flowId) => (await apiOk(roboTeamApi, page, { path: `api/roboflow/flows/${flowId}?logs=none` })).flow;

// Evaluates the two-phase outcome against the ledger and the host. Returns a verdict: pass, retry (model did not write the files) or fail.
function evaluateTwoPhase({ ledger, flow, fixture, files, poll, project }) {
  const markers = bwrapMarkerProcesses(poll);
  const executions = ledger.executions;
  const facts = { flowStatus: flow?.status, executions: executions.map((entry) => ({ executionId: entry.execution_id, robot: entry.robotName, state: entry.state, origins: entry.origins.map((origin) => origin.origin_id) })) };
  if (protectedUnchanged(fixture) && Object.values(protectedUnchanged(fixture)).includes(false)) return { verdict: 'fail', reason: 'a protected host file changed', facts };
  const leak = sentinelHits(JSON.stringify(executions.map((entry) => entry.events)), fixture.sentinels);
  if (leak.length) return { verdict: 'fail', reason: 'a sentinel appeared in the events', facts };
  if (executions.some((entry) => entry.state !== 'completed')) return { verdict: 'fail', reason: 'a worker execution did not complete', facts };
  if (executions.length !== 2) return { verdict: 'fail', reason: `expected exactly 2 worker executions, found ${executions.length}`, facts };
  if (flow?.status !== 'completed') return { verdict: 'fail', reason: `flow status ${flow?.status}`, facts };
  // Retrying cannot help when the sandbox rejects the write itself: every attempt would meet the same read-only project directory.
  const readOnly = executions.some((entry) => toolOutputs(entry).some((output) => /phase[12]\.txt: Read-only file system/.test(output.text)));
  if (readOnly && (!files.phase1 || !files.phase2)) return { verdict: 'fail', reason: 'the project directory is read-only inside the sandbox (writing phase files gives "Read-only file system")', facts: { ...facts, markers: markers.map((entry) => entry.marker) } };
  const wrong = !files.phase1 || !files.phase2 || files.phase1 !== files.expected1 || files.phase2 !== files.expected2;
  return { verdict: wrong ? 'retry' : 'pass', reason: wrong ? 'the phase files are missing or differ from the expected content' : null, facts: { ...facts, markers: markers.map((entry) => entry.marker) } };
}

function assertTwoPhaseProofs({ ledger, flow, poll, files, fixture, phaseOrder }) {
  const [first, second] = phaseOrder ?? ledger.executions;
  expect(ledger.executions.length, 'worker admissions for the project').toBe(2);
  // Distinct origin ids, each execution having one origin row under the coordinator namespace.
  const origins = ledger.executions.flatMap((entry) => entry.origins);
  expect(origins.length).toBe(2);
  expect(new Set(origins.map((origin) => origin.origin_id)).size, 'distinct origin ids').toBe(2);
  expect(origins.every((origin) => origin.namespace.startsWith('coordinator:')), `origin namespaces ${origins.map((origin) => origin.namespace)}`).toBe(true);
  // The root flow binding is registered with the flow id and the phases' origin keys name a binding.
  expect(ledger.bindings.some((binding) => binding.binding_id === flow.id), `binding row for flow ${flow.id}`).toBe(true);
  expect(origins.every((origin) => origin.origin_key === `binding:${flow.id}`), `origin keys ${origins.map((origin) => origin.origin_key)}`).toBe(true);
  // Phase 2 was admitted only after phase 1 reached a terminal state.
  const end1 = terminalEvent(first);
  const start2 = queuedEvent(second);
  expect(end1?.data, 'phase 1 terminal event').toContain('"completed"');
  expect(start2.at, 'phase 2 queued after phase 1 completed').toBeGreaterThanOrEqual(end1.at);
  // Every execution's process-tree blockers are released, and the bwrap markers seen live match them.
  const markers = bwrapMarkerProcesses(poll);
  for (const entry of ledger.executions) {
    expect(entry.blockers.every((blocker) => blocker.release_state === 'released'), `all blockers released for ${entry.execution_id}`).toBe(true);
    const own = new Set(entry.blockers.filter((blocker) => blocker.process_bearing).map(markerOf));
    const seen = markers.filter((marker) => own.has(marker.marker));
    expect(seen.length, `bwrap markers of ${entry.execution_id}`).toBeGreaterThanOrEqual(3);
  }
  expect.soft(files.phase1, 'phase1.txt on the host').toBe(files.expected1);
  expect.soft(files.phase2, 'phase2.txt on the host').toBe(files.expected2);
  expect(sentinelHits(JSON.stringify(ledger.executions.map((entry) => entry.events)), fixture.sentinels), 'sentinels in the events').toEqual([]);
}

function readFiles(root, nonce) {
  const read = (name) => { try { return fs.readFileSync(path.join(root, name), 'utf8'); } catch { return null; } };
  return { phase1: read('phase1.txt'), phase2: read('phase2.txt'), expected1: `PHASE1-${nonce}\n`, expected2: `PHASE1-${nonce}\nPHASE2\n` };
}

const phasePrompts = (nonce, { sleepSeconds = 0 } = {}) => ({
  p1: `This is an automated sandbox test on disposable synthetic files. Run exactly this single shell command, nothing else, and wait for it to finish: `
    + `${sleepSeconds ? `sleep ${sleepSeconds} && ` : ''}printf 'PHASE1-${nonce}\\n' > phase1.txt   Then reply DONE1.`,
  p2: 'This is an automated sandbox test on disposable synthetic files. Run exactly this single shell command, nothing else, and wait for it to finish: '
    + `cat phase1.txt > phase2.txt && echo PHASE2 >> phase2.txt   Then reply DONE2.`,
});

// ---------------------------------------------------------------------------------------------------------------- A

test.describe('RoboWork scenarios', () => {
  test('A: two-phase RoboFlow runs as two ordered worker executions', async ({ page }, testInfo) => {
    test.skip(!FLOW, 'Opt in with SMOKE_ROBOWORK_FLOW=1.');
    test.setTimeout(MAX_ATTEMPTS * 8 * 60_000);
    const ctx = context('flow', testInfo);
    const project = `e2e-flow-${stamp()}`;
    const attempts = [];
    let outcome = null;
    await openRoboTeam(page);
    await ensureRobotsCurrent(page, ctx.save, ctx.workspaceRoot);
    startPoller(ctx.containers);
    try {
      for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
        const dir = `attempt-${attempt}`;
        const fixture = createProjectFixture({ workspaceRoot: ctx.workspaceRoot, name: project });
        const nonce = crypto.randomBytes(6).toString('hex');
        const prompts = phasePrompts(nonce);
        const workflow = await createTwoPhaseWorkflow(page, { name: `e2e two phase ${stamp()}`, ...prompts });
        ctx.save(`${dir}/workflow.json`, workflow);
        // Only opencode robots exist (the unusable e2e robots were deleted), so any matching robot can run a phase.
        expect(workflow.coverage.tasks.every((task) => task.matchingRobotIds.length > 0), 'every task has a matching robot').toBe(true);
        const attemptStartMs = Date.now() - 1000;
        const flow = await startFlow(page, { workflowId: workflow.id, folder: fixture.root, objective: `Two-phase e2e ${nonce}` });
        ctx.save(`${dir}/flow-started.json`, flow);
        const finished = await waitFor(`flow ${flow.id} to finish`, async () => {
          const current = await getFlow(page, flow.id);
          return TERMINAL_FLOW.has(current.status) ? current : null;
        }, { timeoutMs: 7 * 60_000, intervalMs: 3000 });
        ctx.save(`${dir}/flow-final.json`, finished);
        await sleep(2000);
        const ledger = readLedgerSince({ workspaceRoot: ctx.workspaceRoot, scratchDir: ctx.evidenceDir, sinceMs: attemptStartMs, cwd: fixture.root });
        ctx.save(`${dir}/ledger.json`, ledger);
        const poll = readPoll(ctx.containers);
        ctx.save(`${dir}/proc-poll.jsonl`, poll.map((entry) => JSON.stringify(entry)).join('\n'));
        const files = readFiles(fixture.root, nonce);
        ctx.save(`${dir}/files.json`, files);
        const result = evaluateTwoPhase({ ledger, flow: finished, fixture, files, poll, project });
        attempts.push({ attempt, ...result });
        outcome = { ledger, flow: finished, poll, files, fixture };
        await apiOk(roboTeamApi, page, { method: 'DELETE', path: `api/roboflow/workflows/${workflow.id}` }, [200, 404]).catch(() => {});
        if (result.verdict !== 'retry') break;
      }
    } finally {
      ctx.save('attempts.json', attempts);
      ctx.save('worker.log', nestedLogsMerged(ctx.containers, ctx.containers.worker, new Date(ctx.startedMs - 2000).toISOString()));
      ctx.save('roboteam.log', nestedLogsMerged(ctx.containers, ctx.containers.roboTeam, new Date(ctx.startedMs - 2000).toISOString()));
      stopPoller(ctx.containers);
    }
    const final = attempts.at(-1);
    // Structural proofs first (they need only the ledger), so a file-content failure does not hide them; then the verdict.
    if (outcome.ledger.executions.length === 2) assertTwoPhaseProofs({ ...outcome, phaseOrder: outcome.ledger.executions });
    expect.soft(final?.verdict, `${final?.reason} (${attempts.length} attempt(s)); ${JSON.stringify(final?.facts)}`).toBe('pass');
    await testInfo.attach('flow-attempts', { body: JSON.stringify(attempts, null, 2), contentType: 'application/json' });
  });

  // -------------------------------------------------------------------------------------------------------------- C

  test('C: a file created while a task runs is readable by that task and masked for the next one', async ({ page }, testInfo) => {
    test.skip(!LATE, 'Opt in with SMOKE_ROBOWORK_LATE=1.');
    test.setTimeout(MAX_ATTEMPTS * 8 * 60_000);
    const ctx = context('late', testInfo);
    const project = `e2e-late-${stamp()}`;
    const fixture = createProjectFixture({ workspaceRoot: ctx.workspaceRoot, name: project });
    const lateSentinel = `LATE-SENTINEL-${crypto.randomBytes(9).toString('hex')}`;
    const attempts = [];
    await openRoboTeam(page);
    await ensureRobot(page);
    startPoller(ctx.containers);
    try {
      // Task 1: sleeps 40 s while the file is created on the host, then reads it.
      let running = null;
      for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
        const dir = `attempt-${attempt}-running`;
        const startMs = Date.now() - 1000;
        fs.rmSync(path.join(fixture.root, 'late'), { recursive: true, force: true });
        const turn = chatTurn(page, project, 'This is an automated sandbox test on disposable synthetic files. Run exactly this single shell command, nothing else, and wait for it to finish: '
          + '`sleep 40; cat late/.env; stat -c %s late/.env`   Then reply DONE.', { timeoutMs: 6 * 60_000 });
        // Trigger from the process: the sleep must be live in the worker before the file appears.
        await waitFor('the sleep 40 command to run in the worker', async () => workerProcesses(ctx.containers, 'sleep 40; cat late/.env').length > 0, { timeoutMs: 3 * 60_000, intervalMs: 1000 });
        fs.mkdirSync(path.join(fixture.root, 'late'), { recursive: true });
        fs.writeFileSync(path.join(fixture.root, 'late/.env'), `LATE_TOKEN=${lateSentinel}\n`);
        ctx.save(`${dir}/late-created-at.txt`, new Date().toISOString());
        const answer = await turn;
        await sleep(2000);
        const ledger = readLedgerSince({ workspaceRoot: ctx.workspaceRoot, scratchDir: ctx.evidenceDir, sinceMs: startMs, cwd: fixture.root });
        ctx.save(`${dir}/ledger.json`, ledger);
        ctx.save(`${dir}/answer.txt`, answer);
        const execution = ledger.executions.at(-1);
        const outputs = execution ? toolOutputs(execution) : [];
        ctx.save(`${dir}/tool-outputs.json`, outputs);
        const verdict = (() => {
          if (!execution) return { verdict: 'fail', reason: 'no worker execution' };
          if (execution.state !== 'completed') return { verdict: 'fail', reason: `execution ${execution.state}` };
          if (Object.values(protectedUnchanged(fixture)).includes(false)) return { verdict: 'fail', reason: 'a protected host file changed' };
          if (sentinelHits(JSON.stringify(execution.events) + answer, fixture.sentinels).length) return { verdict: 'fail', reason: 'a fixture sentinel leaked' };
          return outputs.length ? { verdict: 'pass' } : { verdict: 'retry', reason: 'no tool output recorded' };
        })();
        attempts.push({ phase: 'running', attempt, ...verdict });
        running = { execution, outputs, answer };
        if (verdict.verdict !== 'retry') break;
      }
      expect(attempts.at(-1).verdict, JSON.stringify(attempts.at(-1))).toBe('pass');
      // Accepted limitation (not a defect): the running task sees the file created after it started.
      const sawLate = running.outputs.some((output) => output.text.includes(lateSentinel));
      ctx.save('running-task-saw-late-file.json', { sawLate, outputs: running.outputs.map((output) => output.text.replace(lateSentinel, '<LATE-SENTINEL>')) });
      expect(sawLate, 'the running task read the late file (accepted limitation); outputs saved').toBe(true);

      // Task 2: starts after the file exists; the name must be masked.
      let next = null;
      for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
        const dir = `attempt-${attempt}-new`;
        const startMs = Date.now() - 1000;
        const answer = await chatTurn(page, project, 'This is an automated sandbox test on disposable synthetic files. Run exactly this single shell command, nothing else, and wait for it to finish: '
          + '`stat -c %s late/.env; wc -c < late/.env`   Then reply DONE.');
        await sleep(2000);
        const ledger = readLedgerSince({ workspaceRoot: ctx.workspaceRoot, scratchDir: ctx.evidenceDir, sinceMs: startMs, cwd: fixture.root });
        ctx.save(`${dir}/ledger.json`, ledger);
        const execution = ledger.executions.at(-1);
        const outputs = execution ? toolOutputs(execution) : [];
        ctx.save(`${dir}/tool-outputs.json`, outputs);
        const leaked = sentinelHits(JSON.stringify(execution?.events ?? []) + answer, [lateSentinel, ...fixture.sentinels]);
        const verdict = !execution ? { verdict: 'fail', reason: 'no worker execution' }
          : execution.state !== 'completed' ? { verdict: 'fail', reason: `execution ${execution.state}` }
          : leaked.length ? { verdict: 'fail', reason: 'a sentinel (including the late one) appeared for the new task' }
          : outputs.some((output) => output.text === '0\n0\n') ? { verdict: 'pass' } : { verdict: 'retry', reason: 'expected output "0\\n0\\n" not recorded' };
        attempts.push({ phase: 'new', attempt, ...verdict });
        next = { execution, outputs };
        if (verdict.verdict !== 'retry') break;
      }
      expect(attempts.at(-1).verdict, JSON.stringify(attempts.at(-1))).toBe('pass');
      expect(next.outputs.map((output) => output.text), 'new task: size 0 twice').toContain('0\n0\n');
    } finally {
      ctx.save('attempts.json', attempts);
      ctx.save('worker.log', nestedLogsMerged(ctx.containers, ctx.containers.worker, new Date(ctx.startedMs - 2000).toISOString()));
      const poll = readPoll(ctx.containers);
      ctx.save('proc-poll.jsonl', poll.map((entry) => JSON.stringify(entry)).join('\n'));
      stopPoller(ctx.containers);
    }
    await testInfo.attach('late-attempts', { body: JSON.stringify(attempts, null, 2), contentType: 'application/json' });
  });

  // -------------------------------------------------------------------------------------------------------------- B

  test('B: RoboTeam restarts while a phase runs; the worker execution completes and RoboFlow reconciles', async ({ page }, testInfo) => {
    test.skip(!RESTART, 'Opt in with SMOKE_ROBOWORK_RESTART=1 (this restarts roboTeamAgent).');
    test.setTimeout(20 * 60_000);
    const ctx = context('restart', testInfo);
    const project = `e2e-restart-${stamp()}`;
    const fixture = createProjectFixture({ workspaceRoot: ctx.workspaceRoot, name: project });
    const nonce = crypto.randomBytes(6).toString('hex');
    const prompts = phasePrompts(nonce, { sleepSeconds: 60 });
    let restartInfo = null;
    let ledger = null;
    let poll = [];
    let finished = null;
    let flow = null;
    await openRoboTeam(page);
    await ensureRobotsCurrent(page, ctx.save, ctx.workspaceRoot);
    startPoller(ctx.containers);
    try {
      const workflow = await createTwoPhaseWorkflow(page, { name: `e2e restart ${stamp()}`, ...prompts });
      const startMs = Date.now() - 1000;
      flow = await startFlow(page, { workflowId: workflow.id, folder: fixture.root, objective: `Restart e2e ${nonce}` });
      ctx.save('flow-started.json', flow);
      // Restart only while phase 1 runs on the worker: the sleep is live and the ledger shows the attempt running.
      await waitFor('phase 1 running on the worker', async () => {
        const live = readLedgerSince({ workspaceRoot: ctx.workspaceRoot, scratchDir: ctx.evidenceDir, sinceMs: startMs, cwd: fixture.root });
        const running = live.executions.length === 1 && live.executions[0].state === 'running';
        return running && workerProcesses(ctx.containers, 'sleep 60 &&').length > 0 ? live : null;
      }, { timeoutMs: 4 * 60_000, intervalMs: 2000 });
      ctx.save('roboteam-before-restart.log', nestedLogsMerged(ctx.containers, ctx.containers.roboTeam, new Date(ctx.startedMs - 2000).toISOString()));
      ctx.save('flow-before-restart.json', await getFlow(page, flow.id));
      const before = ctx.containers.roboTeam;
      const restartAt = new Date();
      const command = process.env.SMOKE_ROBOWORK_PLOINKY || 'ploinky';
      const output = execFileSync(command, ['restart', 'roboTeamAgent'], { cwd: ctx.workspaceRoot, encoding: 'utf8', timeout: 5 * 60_000, maxBuffer: 8 * 1024 * 1024 });
      ctx.save('ploinky-restart.txt', output.slice(-4000));
      restartInfo = { command: `${command} restart roboTeamAgent`, at: restartAt.toISOString(), finishedAt: new Date().toISOString(), containerBefore: before };
      ctx.containers = discoverContainers({ workspaceRoot: ctx.workspaceRoot, boxName: ctx.containers.box });
      restartInfo.containerAfter = ctx.containers.roboTeam;
      ctx.save('restart.json', restartInfo);
      // The router session survives; RoboTeam needs a moment to be served again.
      await waitFor('RoboTeam to answer after the restart', async () => {
        try { await openRoboTeam(page); return (await roboTeamApi(page, { path: 'api/robots' })).status === 200; } catch { return false; }
      }, { timeoutMs: 3 * 60_000, intervalMs: 5000 });
      finished = await waitFor(`flow ${flow.id} to finish after the restart`, async () => {
        const current = await getFlow(page, flow.id);
        return TERMINAL_FLOW.has(current.status) ? current : null;
      }, { timeoutMs: 8 * 60_000, intervalMs: 4000 });
      ctx.save('flow-final.json', finished);
      await sleep(3000);
      ledger = readLedgerSince({ workspaceRoot: ctx.workspaceRoot, scratchDir: ctx.evidenceDir, sinceMs: startMs, cwd: fixture.root });
      ctx.save('ledger.json', ledger);
      poll = readPoll(ctx.containers);
      ctx.save('proc-poll.jsonl', poll.map((entry) => JSON.stringify(entry)).join('\n'));
      await apiOk(roboTeamApi, page, { method: 'DELETE', path: `api/roboflow/workflows/${workflow.id}` }, [200, 404]).catch(() => {});
    } finally {
      try {
        ctx.save('worker.log', nestedLogsMerged(ctx.containers, ctx.containers.worker, new Date(ctx.startedMs - 2000).toISOString()));
        ctx.save('roboteam-after-restart.log', nestedLogsMerged(ctx.containers, ctx.containers.roboTeam, new Date(ctx.startedMs - 2000).toISOString()));
      } catch (error) { ctx.save('log-error.txt', String(error?.message ?? error)); }
      stopPoller(ctx.containers);
    }
    const files = readFiles(fixture.root, nonce);
    ctx.save('files.json', files);
    // Orphans: after completion nothing of the executions may be left in the worker.
    const orphans = await waitFor('no leftover sandboxes or networks', async () => { const report = orphanReport(ctx.containers); return isClean(report) ? report : null; }, { timeoutMs: 90_000, intervalMs: 5000 })
      .catch(() => orphanReport(ctx.containers));
    ctx.save('orphans.json', orphans);

    expect(finished.status, 'flow status after the restart').toBe('completed');
    expect(ledger.executions.length, 'exactly one admission per phase (no duplicate after the restart)').toBe(2);
    const [first, second] = ledger.executions;
    expect(first.state).toBe('completed');
    expect(second.state).toBe('completed');
    // Phase 1 was admitted before the restart and finished after it began; phase 2 was admitted exactly once, after phase 1 completed.
    expect(first.created_at, 'phase 1 admitted before the restart').toBeLessThan(new Date(restartInfo.at).getTime());
    expect(terminalEvent(first).at, 'phase 1 ended after the restart began (it kept running)').toBeGreaterThan(new Date(restartInfo.at).getTime());
    expect(queuedEvent(second).at).toBeGreaterThanOrEqual(terminalEvent(first).at);
    assertTwoPhaseProofs({ ledger, flow: finished, poll, files, fixture });
    expect(isClean(orphans), `orphan report ${JSON.stringify(orphans)}`).toBe(true);
    await testInfo.attach('restart', { body: JSON.stringify(restartInfo, null, 2), contentType: 'application/json' });
  });
});
