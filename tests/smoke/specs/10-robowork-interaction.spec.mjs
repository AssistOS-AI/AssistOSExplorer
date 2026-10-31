import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { test, expect } from '../lib/fixtures.mjs';
import { smokeConfig } from '../lib/config.mjs';
import { signIn } from '../lib/auth.mjs';
import { ROBOTEAM_BASE_PATH, roboTeamApi } from '../lib/conversation-skills.mjs';
import {
  discoverContainers, nestedLogsMerged, startPoller, stopPoller, readPoll, bwrapMarkerProcesses, createProjectFixture, sentinelHits, collectEnvironment, removeRunDirectory,
} from '../lib/robowork-e2e.mjs';
import { ProviderStall, makeStallGuard, terminateFlows, sleep, waitFor, readLedgerSince, markerOf, toolOutputs, workerProcesses, apiOk } from '../lib/robowork-scenarios.mjs';
import { readControls, workerRobots, workerRobotDirs, channelEvents, singleTaskWorkflow, chatTurn, stopChatTurn, applySelectedModel, restrictFlowsToRobot, postQuietly } from '../lib/robowork-interaction.mjs';

// RoboWork r10 e2e: worker channels and robot delete on a live deployment (run `node scripts/run-robowork-e2e.mjs specs/10-robowork-interaction.spec.mjs`).
//   SMOKE_ROBOWORK_HUMAN=1    (D) a phase asks a question through require-human-input; answering continues it as a new admission
//   SMOKE_ROBOWORK_FAILURE=1  (E) a phase reports a blocked task through report-task-blocked; the phase fails with that message
//   SMOKE_ROBOWORK_DELETE=1   (F) robot delete: worker store dir removed; a robot with running local work is refused and kept (the worker's own robot_busy refusal is
//                             covered cross-side by roboTeamAgent/tests/robot-delete-cross-side.test.mjs, decision M-49)
// Model-dependent turns repeat at most 3 times, and only when no execution failed, no protected file changed, no sentinel leaked and the model
// did not do the asked thing (no question, no failure report, wrong file). A failed execution, a changed host file or a leaked sentinel fails at once.
const HUMAN = process.env.SMOKE_ROBOWORK_HUMAN === '1';
const FAILURE = process.env.SMOKE_ROBOWORK_FAILURE === '1';
const DELETE = process.env.SMOKE_ROBOWORK_DELETE === '1';
const MAX_ATTEMPTS = 3;
const TERMINAL_FLOW = new Set(['completed', 'failed', 'terminated']);
const stamp = () => Date.now().toString(36);

const flowIds = [];
const runDirectories = [];
function context(label) {
  const workspaceRoot = smokeConfig.workspaceRoot;
  assert.ok(path.isAbsolute(workspaceRoot), 'Set SMOKE_WORKSPACE_ROOT to the deployed workspace.');
  const evidenceDir = path.resolve(process.env.SMOKE_ROBOWORK_EVIDENCE || path.join(smokeConfig.artifactRoot, 'robowork'), label);
  fs.mkdirSync(evidenceDir, { recursive: true });
  const save = (name, value) => {
    fs.mkdirSync(path.dirname(path.join(evidenceDir, name)), { recursive: true });
    fs.writeFileSync(path.join(evidenceDir, name), typeof value === 'string' ? value : JSON.stringify(value, null, 2));
  };
  const containers = discoverContainers({ workspaceRoot });
  save('environment.json', collectEnvironment({ workspaceRoot, containers }));
  return { workspaceRoot, evidenceDir, save, containers, startedMs: Date.now() };
}
const ownProject = (ctx, name) => { runDirectories.push({ ctx, name }); return name; };
const getFlow = async (page, flowId) => (await apiOk(roboTeamApi, page, { path: `api/roboflow/flows/${flowId}?logs=none` })).flow;
const flowTerminal = (flow) => TERMINAL_FLOW.has(flow.status);

async function finishEvidence(ctx, page) {
  ctx.save('worker.log', nestedLogsMerged(ctx.containers, ctx.containers.worker, new Date(ctx.startedMs - 2000).toISOString()));
  ctx.save('roboteam.log', nestedLogsMerged(ctx.containers, ctx.containers.roboTeam, new Date(ctx.startedMs - 2000).toISOString()));
  void page;
}

test.describe('RoboWork interaction scenarios', () => {
  test.afterEach(async ({ page }) => {
    // Stop what the scenario left running, through the product, so a stall cannot starve the next scenario.
    await stopChatTurn(page);
    if (flowIds.length) {
      if (!new URL(page.url()).pathname.startsWith(ROBOTEAM_BASE_PATH)) await page.goto(ROBOTEAM_BASE_PATH, { waitUntil: 'load' }).catch(() => {});
      const stopped = await terminateFlows(roboTeamApi, page, flowIds.splice(0)).catch(() => []);
      if (stopped.length && runDirectories[0]) runDirectories[0].ctx.save('teardown-terminated-flows.json', stopped);
    }
    for (const { ctx, name } of runDirectories.splice(0)) {
      try {
        const root = path.join(ctx.workspaceRoot, name);
        const listing = [];
        const walk = (directory, prefix) => {
          for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
            const relative = path.posix.join(prefix, entry.name);
            if (entry.isDirectory()) { listing.push({ path: `${relative}/` }); walk(path.join(directory, entry.name), relative); }
            else listing.push({ path: relative, bytes: fs.statSync(path.join(directory, entry.name)).size });
          }
        };
        walk(root, '');
        ctx.save('project-listing.json', listing);
      } catch (error) { ctx.save('project-listing.json', { error: String(error?.code ?? error) }); }
      removeRunDirectory({ workspaceRoot: ctx.workspaceRoot, name, prefixes: ['e2e-human-', 'e2e-fail-', 'e2e-delete-'] });
    }
  });

  // -------------------------------------------------------------------------------------------------------------- D

  test('D: a phase asks one question; the answer continues it as a new admission', async ({ page }, testInfo) => {
    test.skip(!HUMAN, 'Opt in with SMOKE_ROBOWORK_HUMAN=1.');
    test.setTimeout(MAX_ATTEMPTS * 10 * 60_000);
    const ctx = context('human-input');
    const guard = makeStallGuard({ workspaceRoot: ctx.workspaceRoot, scratchDir: ctx.evidenceDir, sinceMs: ctx.startedMs - 1000, testInfo, scope: () => ({ cwd: path.join(ctx.workspaceRoot, project) }) });
    const project = ownProject(ctx, `e2e-human-${stamp()}`);
    const attempts = [];
    let kept = null;
    await signIn(page, smokeConfig.primaryUser, ROBOTEAM_BASE_PATH);
    const skill = await restrictFlowsToRobot(roboTeamApi, page, { workspaceRoot: ctx.workspaceRoot, robotName: process.env.SMOKE_ROBOWORK_ROBOT || 'e2e-bot' });
    startPoller(ctx.containers);
    try {
      for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
        const dir = `attempt-${attempt}`;
        const fixture = createProjectFixture({ workspaceRoot: ctx.workspaceRoot, name: project });
        const prompt = 'This is an automated test on disposable synthetic files. You must ask the user exactly ONE question, using the required require-human-input skill, '
          + 'with exactly these three options: ALPHA, BRAVO, CHARLIE. Do not decide for the user. After the user answers, write the chosen answer text, exactly as '
          + 'chosen, followed by a newline, to the file answer.txt in the project directory with a shell command (printf), then reply DONE.'
          + ' This is an execution request. Use a shell or read tool now to read /run/robo-work/skills/require-human-input/SKILL.md. Follow that skill to ask the required question now, then end this execution as instructed. '
          + 'Do not acknowledge readiness or ask for another task. On the later continuation with the user\'s answer, call the bash tool to perform the printf write above before replying DONE.';
        const workflow = (await apiOk(roboTeamApi, page, { method: 'POST', path: 'api/roboflow/workflows', body: singleTaskWorkflow({ name: `e2e human ${stamp()}`, prompt, allowsHumanInput: true, skill }) }, [201])).workflow;
        const startMs = Date.now() - 1000;
        const flow = (await apiOk(roboTeamApi, page, { method: 'POST', path: 'api/roboflow/flows', body: { workflowTypeId: workflow.id, folder: fixture.root, objective: `Human input e2e ${stamp()}` } }, [201])).flow;
        flowIds.push(flow.id);
        ctx.save(`${dir}/flow-started.json`, flow);
        // Wait for the question (or the end of the flow: the model did not ask).
        const waiting = await waitFor('a pending question or the end of the flow', async () => {
          const current = await getFlow(page, flow.id);
          if (current.humanInput?.status === 'pending' && current.humanInput.executionEnded) return { current, asked: true };
          return flowTerminal(current) ? { current, asked: false } : null;
        }, { timeoutMs: 6 * 60_000, intervalMs: 3000, check: guard });
        ctx.save(`${dir}/flow-at-question.json`, waiting.current);
        let verdict = { verdict: 'pass' };
        let answerReply = null;
        let secondReply = null;
        let beforeLedger = null;
        if (!waiting.asked) {
          verdict = waiting.current.status === 'completed' ? { verdict: 'retry', reason: 'the model finished without asking the question' } : { verdict: 'fail', reason: `flow ${waiting.current.status} without a question: ${waiting.current.error}` };
        } else {
          const question = waiting.current.humanInput;
          beforeLedger = readLedgerSince({ workspaceRoot: ctx.workspaceRoot, scratchDir: ctx.evidenceDir, sinceMs: startMs, cwd: fixture.root });
          ctx.save(`${dir}/ledger-at-question.json`, beforeLedger);
          // The phase is paused with the question in RoboFlow; the worker holds a `human-input-request` event.
          expect.soft(waiting.current.status, 'flow status while the question is open').toBe('paused');
          expect.soft(question.options?.length, 'three suggestions').toBe(3);
          expect.soft(new Set(question.options).size, 'distinct suggestions').toBe(3);
          expect.soft(channelEvents(beforeLedger.executions[0]).map((event) => event.type), 'worker channel events of the first admission').toContain('human-input-request');
          // Answer through the API route that mints the owner grant; then repeat the same answer (it must be refused, never a second control).
          const choice = 1;
          answerReply = await roboTeamApi(page, { method: 'POST', path: 'api/roboflow/human-input/answer', body: { flowId: flow.id, requestId: question.id, option: choice } });
          ctx.save(`${dir}/answer-reply.json`, { status: answerReply.status, flowStatus: answerReply.payload?.flow?.status, error: answerReply.payload?.error });
          expect(answerReply.status, `answer: ${JSON.stringify(answerReply.payload).slice(0, 300)}`).toBe(200);
          secondReply = await postQuietly(page, ROBOTEAM_BASE_PATH, 'api/roboflow/human-input/answer', { flowId: flow.id, requestId: question.id, option: choice });
          ctx.save(`${dir}/second-answer-reply.json`, { status: secondReply.status, error: secondReply.payload?.error });
          expect(secondReply.status, `the repeated answer must be refused: ${JSON.stringify(secondReply.payload).slice(0, 200)}`).toBe(409);
          const finished = await waitFor('the flow to finish after the answer', async () => { const current = await getFlow(page, flow.id); return flowTerminal(current) ? current : null; }, { timeoutMs: 6 * 60_000, intervalMs: 3000, check: guard });
          ctx.save(`${dir}/flow-final.json`, finished);
          await sleep(2000);
          const ledger = readLedgerSince({ workspaceRoot: ctx.workspaceRoot, scratchDir: ctx.evidenceDir, sinceMs: startMs, cwd: fixture.root });
          ctx.save(`${dir}/ledger.json`, ledger);
          const controls = readControls({ workspaceRoot: ctx.workspaceRoot, scratchDir: ctx.evidenceDir, executionIds: ledger.executions.map((entry) => entry.execution_id) });
          ctx.save(`${dir}/controls.json`, controls);
          const poll = readPoll(ctx.containers);
          ctx.save(`${dir}/proc-poll.jsonl`, poll.map((entry) => JSON.stringify(entry)).join('\n'));
          let written = null;
          try { written = fs.readFileSync(path.join(fixture.root, 'answer.txt'), 'utf8'); } catch { written = null; }
          ctx.save(`${dir}/answer-file.json`, { written, chosen: question.options[choice] });
          const unchanged = Object.entries(fixture.protectedFiles).every(([name, text]) => { try { return fs.readFileSync(path.join(fixture.root, name), 'utf8') === text; } catch { return false; } });
          const answerControls = controls.filter((control) => String(control.op) === 'answer');
          const readOnly = ledger.executions.some((entry) => toolOutputs(entry).some((output) => /answer\.txt: Read-only file system/.test(output.text)));
          const facts = { executions: ledger.executions.map((entry) => ({ id: entry.execution_id, state: entry.state, origins: entry.origins.map((origin) => origin.origin_id) })), answerControls: answerControls.length, secondAnswerStatus: secondReply.status, flowStatus: finished.status, written };
          kept = { ledger, controls, poll, finished, question, choice };
          if (!unchanged) verdict = { verdict: 'fail', reason: 'a protected host file changed', facts };
          else if (sentinelHits(JSON.stringify(ledger.executions.map((entry) => entry.events)), fixture.sentinels).length) verdict = { verdict: 'fail', reason: 'a sentinel leaked into the events', facts };
          else if (ledger.executions.length !== 2 || ledger.executions.some((entry) => !['completed', 'paused', 'human-input'].includes(entry.state))) verdict = { verdict: 'fail', reason: 'expected two admissions (question, continuation) that did not fail', facts };
          else if (answerControls.length !== 1) verdict = { verdict: 'fail', reason: `expected exactly one answer control, found ${answerControls.length}`, facts };
          else if (written === null || written.trim() !== question.options[choice]) verdict = readOnly ? { verdict: 'fail', reason: 'the project directory is read-only in the sandbox', facts } : { verdict: 'retry', reason: `answer.txt is ${JSON.stringify(written)}, expected the chosen option`, facts };
          else verdict = { verdict: 'pass', facts };
        }
        attempts.push({ attempt, ...verdict });
        await apiOk(roboTeamApi, page, { method: 'DELETE', path: `api/roboflow/workflows/${workflow.id}` }, [200, 404]).catch(() => {});
        if (verdict.verdict !== 'retry') break;
      }
    } finally {
      ctx.save('attempts.json', attempts);
      await finishEvidence(ctx, page);
      stopPoller(ctx.containers);
    }
    const final = attempts.at(-1);
    expect(final?.verdict, `${final?.reason}; ${attempts.length} attempt(s); ${JSON.stringify(final?.facts)}`).toBe('pass');
    // Structural proofs on the kept attempt.
    const [first, second] = kept.ledger.executions;
    expect(first.origins[0].origin_id).not.toBe(second.origins[0].origin_id);
    expect(second.created_at, 'the continuation was admitted after the question').toBeGreaterThan(first.created_at);
    const answerControl = kept.controls.find((control) => String(control.op) === 'answer');
    expect(answerControl.executionId, 'the answer control belongs to the first admission').toBe(first.execution_id);
    expect(kept.finished.status).toBe('completed');
    for (const entry of kept.ledger.executions) {
      expect(entry.blockers.every((blocker) => blocker.release_state === 'released'), `blockers released for ${entry.execution_id}`).toBe(true);
      const own = new Set(entry.blockers.filter((blocker) => blocker.process_bearing).map(markerOf));
      expect(bwrapMarkerProcesses(kept.poll).filter((marker) => own.has(marker.marker)).length, `bwrap markers of ${entry.execution_id}`).toBeGreaterThanOrEqual(3);
    }
    await testInfo.attach('human-input', { body: JSON.stringify(attempts, null, 2), contentType: 'application/json' });
  });

  // -------------------------------------------------------------------------------------------------------------- E

  test('E: a phase reports a blocked task; the phase fails with that message', async ({ page }, testInfo) => {
    test.skip(!FAILURE, 'Opt in with SMOKE_ROBOWORK_FAILURE=1.');
    test.setTimeout(MAX_ATTEMPTS * 8 * 60_000);
    const ctx = context('task-failure');
    const guard = makeStallGuard({ workspaceRoot: ctx.workspaceRoot, scratchDir: ctx.evidenceDir, sinceMs: ctx.startedMs - 1000, testInfo, scope: () => ({ cwd: path.join(ctx.workspaceRoot, project) }) });
    const project = ownProject(ctx, `e2e-fail-${stamp()}`);
    const attempts = [];
    let kept = null;
    await signIn(page, smokeConfig.primaryUser, ROBOTEAM_BASE_PATH);
    const skill = await restrictFlowsToRobot(roboTeamApi, page, { workspaceRoot: ctx.workspaceRoot, robotName: process.env.SMOKE_ROBOWORK_ROBOT || 'e2e-bot' });
    try {
      for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
        const dir = `attempt-${attempt}`;
        const fixture = createProjectFixture({ workspaceRoot: ctx.workspaceRoot, name: project });
        const nonce = crypto.randomBytes(5).toString('hex');
        const message = `BLOCKED-${nonce}: the required database is unavailable`;
        const prompt = 'This is an automated test on disposable synthetic files. This task cannot be fulfilled: the required database is unavailable and no workaround is allowed. '
          + `Report that with the bundled report-task-blocked skill, using exactly this message: ${message}   Do nothing else.`
          + ' This is an execution request. Use a shell or read tool now to read /run/robo-work/skills/report-task-blocked/SKILL.md. Follow that skill now to report exactly the blocker message above. '
          + 'Do not acknowledge readiness, ask for another task, or replace the required report with a plain-text answer. Do not continue after invoking the skill.';
        const workflow = (await apiOk(roboTeamApi, page, { method: 'POST', path: 'api/roboflow/workflows', body: singleTaskWorkflow({ name: `e2e fail ${stamp()}`, prompt, skill }) }, [201])).workflow;
        const startMs = Date.now() - 1000;
        const flow = (await apiOk(roboTeamApi, page, { method: 'POST', path: 'api/roboflow/flows', body: { workflowTypeId: workflow.id, folder: fixture.root, objective: `Task failure e2e ${nonce}` } }, [201])).flow;
        flowIds.push(flow.id);
        const finished = await waitFor('the flow to finish', async () => { const current = await getFlow(page, flow.id); return flowTerminal(current) ? current : null; }, { timeoutMs: 6 * 60_000, intervalMs: 3000, check: guard });
        ctx.save(`${dir}/flow-final.json`, finished);
        await sleep(2000);
        const ledger = readLedgerSince({ workspaceRoot: ctx.workspaceRoot, scratchDir: ctx.evidenceDir, sinceMs: startMs, cwd: fixture.root });
        ctx.save(`${dir}/ledger.json`, ledger);
        const execution = ledger.executions.at(-1);
        const events = execution ? channelEvents(execution) : [];
        const failedEvent = events.find((event) => event.type === 'task-failed');
        const instance = finished.instances?.[0];
        const facts = { flowStatus: finished.status, instanceState: instance?.state, instanceError: instance?.error, workerState: execution?.state, channelEvents: events.map((event) => `${event.type}:${event.data.slice(0, 200)}`) };
        let verdict;
        if (!execution) verdict = { verdict: 'fail', reason: 'no worker execution', facts };
        else if (!failedEvent && finished.status === 'completed') verdict = { verdict: 'retry', reason: 'the model did not report the blocked task', facts };
        else if (!failedEvent) verdict = { verdict: 'fail', reason: 'no task-failed event in the worker ledger', facts };
        else verdict = { verdict: 'pass', facts };
        attempts.push({ attempt, ...verdict });
        kept = { finished, execution, failedEvent, message, instance };
        await apiOk(roboTeamApi, page, { method: 'DELETE', path: `api/roboflow/workflows/${workflow.id}` }, [200, 404]).catch(() => {});
        if (verdict.verdict !== 'retry') break;
      }
    } finally {
      ctx.save('attempts.json', attempts);
      await finishEvidence(ctx, page);
    }
    const final = attempts.at(-1);
    expect(final?.verdict, `${final?.reason}; ${attempts.length} attempt(s); ${JSON.stringify(final?.facts)}`).toBe('pass');
    expect(kept.failedEvent.data, 'the worker event carries the message').toContain(kept.message.split(':')[0]);
    expect(kept.finished.status, 'flow status').toBe('failed');
    expect(kept.instance.state, 'phase state').toBe('failed');
    expect(kept.instance.error ?? kept.finished.error, 'the phase failed with the reported message').toContain(kept.message);
    await testInfo.attach('task-failure', { body: JSON.stringify(attempts, null, 2), contentType: 'application/json' });
  });

  // -------------------------------------------------------------------------------------------------------------- F

  test('F: robot delete removes the worker store dir; a robot with running work is refused and kept', async ({ page }, testInfo) => {
    test.skip(!DELETE, 'Opt in with SMOKE_ROBOWORK_DELETE=1.');
    test.setTimeout(30 * 60_000);
    const ctx = context('robot-delete');
    let projectDir = null; // set once the scenario project exists (the guard scope reads it)
    const guard = makeStallGuard({ workspaceRoot: ctx.workspaceRoot, scratchDir: ctx.evidenceDir, sinceMs: ctx.startedMs - 1000, testInfo, scope: () => ({ cwd: projectDir && path.join(ctx.workspaceRoot, projectDir) }) });
    const outcome = { steps: [] };
    const record = (step) => { outcome.steps.push(step); ctx.save('outcome.json', outcome); };
    const robotsList = async () => (await apiOk(roboTeamApi, page, { path: 'api/robots' })).robots;
    const createRobot = async (name) => {
      const before = workerRobotDirs(ctx.workspaceRoot);
      const made = (await apiOk(roboTeamApi, page, { method: 'POST', path: 'api/robots', body: { name, codingAgents: ['opencode'] } }, [201])).robot;
      await applySelectedModel(roboTeamApi, page, made);
      const row = workerRobots({ workspaceRoot: ctx.workspaceRoot, scratchDir: ctx.evidenceDir }).find((entry) => entry.name === name);
      const dir = row?.id ?? workerRobotDirs(ctx.workspaceRoot).find((entry) => !before.includes(entry));
      return { name, workerId: dir };
    };
    const deleteRobot = (name) => roboTeamApi(page, { method: 'POST', path: 'api/control', body: { robotName: name, operation: 'robot-delete' } });
    // Expected refusals (409, and the 500 of finding F12) are read through the APIRequestContext, so the browser does not log them as console errors
    // that the strict page diagnostics would count against the test.
    const deleteRobotQuietly = async (target, name) => {
      const proof = await target.evaluate(async () => (await (await fetch('/auth/token?mutationRoute=roboTeamAgent', { credentials: 'include', cache: 'no-store' })).json()).browserMutation);
      const reply = await target.request.post(`${ROBOTEAM_BASE_PATH}api/control`, { headers: { origin: new URL(target.url()).origin, 'x-ploinky-browser-csrf-token': proof.csrfToken, 'content-type': 'application/json', accept: 'application/json' }, data: JSON.stringify({ robotName: name, operation: 'robot-delete' }) });
      return { status: reply.status(), payload: await reply.json().catch(() => ({})) };
    };
    const created = [];
    await signIn(page, smokeConfig.primaryUser, ROBOTEAM_BASE_PATH);
    try {
    // 1. An idle scratch robot: deleting it removes RoboTeam's record and the worker's robots/<id> directory.
    const idle = await createRobot(`e2e-del-${stamp()}`);
    created.push(idle.name);
    expect(idle.workerId, 'the worker created a robot directory').toBeTruthy();
    expect(workerRobotDirs(ctx.workspaceRoot)).toContain(idle.workerId);
    const deletedAt = Date.now();
    const removed = await deleteRobot(idle.name);
    record({ step: 'delete idle robot', robot: idle, status: removed.status, payload: removed.payload });
    expect(removed.status, JSON.stringify(removed.payload)).toBe(200);
    // The worker completes a deletion asynchronously (its lifecycle driver); the directory must disappear shortly after the accepted delete.
    const goneAfter = await waitFor('the worker robots/<id> directory to be removed', async () => (!workerRobotDirs(ctx.workspaceRoot).includes(idle.workerId) ? { ms: Date.now() - deletedAt } : null), { timeoutMs: 90_000, intervalMs: 1000 });
    record({ step: 'worker directory removed', robot: idle, afterMs: goneAfter.ms });
    expect((await robotsList()).some((robot) => robot.name === idle.name), 'RoboTeam record removed').toBe(false);
    record({ step: 'idle robot gone', workerRows: workerRobots({ workspaceRoot: ctx.workspaceRoot, scratchDir: ctx.evidenceDir }).filter((row) => row.name === idle.name) });

    // 2a. Local-busy: a running WebChat turn. RoboTeam checks its local holders (live chat helper, CLI task, unfinished task) BEFORE asking the worker,
    // so the refusal is RoboTeam's own 409 and the worker is never asked: its robot row and robots/<id> directory stay untouched.
    const busy = await createRobot(`e2e-busy-${stamp()}`);
    created.push(busy.name);
    const project = ownProject(ctx, `e2e-delete-${stamp()}`);
    projectDir = project;
    createProjectFixture({ workspaceRoot: ctx.workspaceRoot, name: project });
    let turn = null;
    let chatPage = null;
    try {
      startPoller(ctx.containers);
      chatPage = await page.context().newPage();
      turn = chatTurn(chatPage, { robot: busy.name, project, prompt: 'This is an automated sandbox test on disposable synthetic files. Run exactly this single shell command, nothing else, and wait for it to finish: `sleep 70`   Then reply DONE.', timeoutMs: 8 * 60_000, check: guard });
      turn.catch(() => {});
      await waitFor('the sleep 70 command in the worker', async () => workerProcesses(ctx.containers, 'sleep 70').length > 0, { timeoutMs: 4 * 60_000, intervalMs: 1000, check: guard });
      const refused = await deleteRobotQuietly(page, busy.name);
      record({ step: 'local-busy delete refused', robot: busy, status: refused.status, payload: refused.payload });
      expect.soft(refused.status, `refused: ${JSON.stringify(refused.payload)}`).toBe(409);
      expect.soft(JSON.stringify(refused.payload), 'a local refusal, not the worker robot_busy message').not.toMatch(/running or unsettled work/);
      expect.soft((await robotsList()).some((robot) => robot.name === busy.name), 'RoboTeam record kept').toBe(true);
      expect.soft(workerRobotDirs(ctx.workspaceRoot), 'worker directory kept').toContain(busy.workerId);
      expect.soft(workerRobots({ workspaceRoot: ctx.workspaceRoot, scratchDir: ctx.evidenceDir }).find((row) => row.name === busy.name)?.lifecycle, 'the worker robot row stays ready: the worker was not asked').toBe('ready');
    } finally {
      await turn?.catch(() => {});
      await chatPage?.close().catch(() => {});
      stopPoller(ctx.containers);
    }
    // 3. Once the task ended and the chat helper exited (a few minutes), the same delete is accepted. Every reply is recorded; only 409 may precede the 200.
    const replies = [];
    const settled = await waitFor('the busy robot to be deletable', async () => {
      const reply = await deleteRobotQuietly(page, busy.name);
      replies.push({ at: new Date().toISOString(), status: reply.status, payload: reply.payload });
      return reply.status === 200 ? reply : (reply.status === 409 ? null : reply);
    }, { timeoutMs: 12 * 60_000, intervalMs: 20_000 });
    ctx.save('busy-delete-replies.json', replies);
    record({ step: 'delete after the task ended', status: settled.status, payload: settled.payload });
    expect(settled.status, `delete after the task ended: ${JSON.stringify(replies.at(-1))}`).toBe(200);
    expect(replies.slice(0, -1).every((reply) => reply.status === 409), `only local 409 replies may precede the 200: ${replies.map((reply) => reply.status)}`).toBe(true);
    await waitFor('the busy robot worker directory to be removed', async () => !workerRobotDirs(ctx.workspaceRoot).includes(busy.workerId), { timeoutMs: 90_000, intervalMs: 1000 });
    } finally {
      // Best-effort removal of every scratch robot this test created (best effort: a refusal while a chat helper lives is retried for a few minutes).
      const leftovers = [];
      try {
        const names = new Set((await robotsList()).map((robot) => robot.name));
        for (const name of created.filter((entry) => names.has(entry))) {
          const outcome = await waitFor(`scratch robot ${name} to be deleted`, async () => { const reply = await deleteRobotQuietly(page, name); return reply.status === 200 ? reply : (reply.status === 409 ? null : reply); }, { timeoutMs: 4 * 60_000, intervalMs: 15_000 }).catch((error) => ({ status: 'timeout', error: String(error.message) }));
          if (outcome.status !== 200) leftovers.push({ name, outcome });
        }
      } catch (error) { leftovers.push({ error: String(error?.message ?? error) }); }
      ctx.save('cleanup.json', leftovers);
    }
    await finishEvidence(ctx, page);
    await testInfo.attach('robot-delete', { body: JSON.stringify(outcome, null, 2), contentType: 'application/json' });
  });
});
