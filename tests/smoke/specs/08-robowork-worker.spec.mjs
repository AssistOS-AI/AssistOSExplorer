import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { test, expect } from '../lib/fixtures.mjs';
import { smokeConfig } from '../lib/config.mjs';
import { signIn } from '../lib/auth.mjs';
import { setComposer } from '../lib/webchat.mjs';
import { callAgentToolViaRouter } from '../lib/mcp.mjs';
import { ROBOTEAM_BASE_PATH, roboTeamApi } from '../lib/conversation-skills.mjs';
import {
  discoverContainers, nestedLogsMerged, startPoller, stopPoller, readPoll, bwrapMarkerProcesses, readLedger,
  createProjectFixture, sentinelHits,
} from '../lib/robowork-e2e.mjs';

// First RoboTeam AI task through the robo-work worker on a live deployment (RoboWork r10 e2e, step 1).
//
//   SMOKE_ROBOWORK=1            opt in (use `node scripts/run-robowork-e2e.mjs`, which also loads the administrator sign-in)
//   SMOKE_WORKSPACE_ROOT        host path of the deployed workspace (the Box mounts it at the same path)
//   SMOKE_ROBOWORK_ROBOT        robot name (default e2e-bot; created when absent, reused otherwise)
//   SMOKE_ROBOWORK_PROJECT      project folder under the workspace root (default e2e-proj; replaced at the start of every run)
//   SMOKE_ROBOWORK_BOX          Ploinky Box container (default: the single running box whose name contains the workspace directory name)
//   SMOKE_ROBOWORK_EVIDENCE     evidence directory (default: <artifact dir>/robowork)
//
// Step 1 builds the project (README.md, .env, master-key, x.secrets, .data/, .ploinky/ and a nested sub/ with .env, .data/, .ploinky/;
// the "secrets" are random sentinels) and creates the robot. Step 2 sends one WebChat turn to the robot, targeting the project.
// Step 3 proves the path: worker ledger rows, bwrap processes carrying a reservation marker that matches a ledger blocker of the
// same execution, worker and RoboTeam log lines. Step 4 checks the answer: the README marker is present and no sentinel appears
// in the answer, the events, or the logs. Evidence is collected in `finally`, so a failed run still leaves everything for diagnosis.
const enabled = process.env.SMOKE_ROBOWORK === '1';
const BOT = '#chatList > .wa-message.in:not(.wa-typing):not(.wa-task-item) .wa-message-bubble';
const robotName = process.env.SMOKE_ROBOWORK_ROBOT || 'e2e-bot';
const projectName = process.env.SMOKE_ROBOWORK_PROJECT || 'e2e-proj';
const TURN_TIMEOUT_MS = 5 * 60_000;
const PROMPT = 'List the files in the current project directory (include hidden files), print the full content of README.md, '
  + 'then run `cat .env` and report exactly what it printed (write EMPTY if it printed nothing, or quote the error).';

test.describe('RoboTeam AI task through the robo-work worker', () => {
  test.skip(!enabled, 'Opt in with SMOKE_ROBOWORK=1 (see scripts/run-robowork-e2e.mjs).');

  test('one WebChat task runs in the worker sandbox and reads the project but not its secrets', async ({ page }, testInfo) => {
    test.setTimeout(TURN_TIMEOUT_MS + 4 * 60_000);
    assert.ok(path.isAbsolute(smokeConfig.workspaceRoot), 'Set SMOKE_WORKSPACE_ROOT to the deployed workspace.');
    const workspaceRoot = smokeConfig.workspaceRoot;
    const evidenceDir = path.resolve(process.env.SMOKE_ROBOWORK_EVIDENCE || path.join(smokeConfig.artifactRoot, 'robowork'));
    fs.mkdirSync(evidenceDir, { recursive: true });
    const save = (name, value) => {
      const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
      fs.writeFileSync(path.join(evidenceDir, name), text);
      return text;
    };
    const containers = discoverContainers({ workspaceRoot });
    save('containers.json', containers);
    const startedAt = new Date(Date.now() - 2000).toISOString();
    const outcome = { robotName, projectName, startedAt, steps: {} };
    let fixture;
    let answer = '';
    let failure = null;
    let pollerStarted = false;

    try {
      // ---- step 1: project and robot
      fixture = createProjectFixture({ workspaceRoot, name: projectName });
      outcome.steps.fixture = { root: fixture.root, readmeMarker: fixture.mark.readme };

      await signIn(page, smokeConfig.primaryUser, ROBOTEAM_BASE_PATH);
      const listed = await roboTeamApi(page, { path: 'api/robots' });
      expect(listed.status, 'GET api/robots').toBe(200);
      let robot = listed.payload.robots.find((entry) => entry.name === robotName);
      if (!robot) {
        const created = await roboTeamApi(page, { method: 'POST', path: 'api/robots', body: { name: robotName, codingAgents: ['opencode'] } });
        save('robot-create.json', created);
        expect(created.status, `POST api/robots: ${JSON.stringify(created.payload).slice(0, 300)}`).toBe(201);
        // RoboTeam provisions the robot on the worker with this request's grant (decision M-13) and reports the result here.
        expect(created.payload.worker, 'the worker provisioning result').toMatchObject({ ready: true });
        robot = created.payload.robot;
      }
      outcome.steps.robot = { id: robot.id, name: robot.name };

      // The folder is visible to Explorer, including the hidden entries the task will be asked about.
      const listing = await callAgentToolViaRouter(page, { agent: 'explorer', tool: 'list_directory', args: { path: projectName } });
      save('explorer-listing.json', listing);
      expect(JSON.stringify(listing)).toContain('README.md');

      // ---- step 2: one WebChat turn targeting the project
      startPoller(containers);
      pollerStarted = true;
      const params = new URLSearchParams({ agent: smokeConfig.webchatAgent, robot: robotName, 'forward-envelope': '1', 'workspace-dir': projectName });
      await page.goto(`/webchat?${params}`, { waitUntil: 'load' });
      await expect(page.locator('#cmd')).toBeVisible();
      await page.waitForTimeout(4000);
      const before = await page.locator(BOT).count();
      outcome.sentAt = new Date().toISOString();
      await setComposer(page, PROMPT);
      await page.locator('#send').click();
      const deadline = Date.now() + TURN_TIMEOUT_MS;
      let texts = [];
      for (;;) {
        await page.waitForTimeout(2000);
        texts = await page.locator(BOT).allTextContents();
        const busy = await page.locator('#cancelBtn').isVisible().catch(() => false);
        if (!busy && texts.length > before) break;
        if (Date.now() > deadline) throw new Error(`The turn did not finish within ${TURN_TIMEOUT_MS / 1000} s.`);
      }
      answer = texts.slice(before).join('\n---\n');
      save('webchat-answer.txt', answer);
      save('webchat-full.txt', await page.locator('#chatList').innerText());
      await page.screenshot({ path: path.join(evidenceDir, 'webchat.png'), fullPage: true });
      outcome.steps.turn = { answerChars: answer.length };
    } catch (error) {
      failure = error;
    }

    // ---- step 3: evidence of the path (always collected)
    let ledger = null;
    let markers = [];
    let logsWorker = '';
    let logsRoboTeam = '';
    try {
      logsWorker = nestedLogsMerged(containers, containers.worker, startedAt);
      logsRoboTeam = nestedLogsMerged(containers, containers.roboTeam, startedAt);
      save('worker.log', logsWorker);
      save('roboteam.log', logsRoboTeam);
      ledger = readLedger({ workspaceRoot, scratchDir: evidenceDir, robotName });
      save('ledger.json', ledger);
      if (pollerStarted) {
        const poll = readPoll(containers);
        save('proc-poll.jsonl', poll.map((entry) => JSON.stringify(entry)).join('\n'));
        markers = bwrapMarkerProcesses(poll);
        save('bwrap-markers.json', markers);
      }
    } catch (error) {
      failure ??= error;
      save('evidence-error.txt', String(error?.stack ?? error));
    } finally {
      if (pollerStarted) stopPoller(containers);
    }

    const last = ledger?.executions?.at(-1) ?? null;
    outcome.execution = last && {
      executionId: last.execution_id, attemptId: last.attempt_id, robotId: last.robot_id, state: last.state,
      endClassification: last.end_classification, result: last.result, events: last.events.map((event) => `${event.sequence}:${event.type}:${event.data.slice(0, 120)}`),
      blockers: last.blockers.map((blocker) => ({ kind: blocker.kind, releaseState: blocker.release_state, marker: (() => { try { return JSON.parse(blocker.locator).marker ?? null; } catch { return null; } })() })),
    };
    outcome.bwrapMarkers = markers.map((entry) => ({ pid: entry.pid, marker: entry.marker }));
    save('outcome.json', outcome);
    await testInfo.attach('robowork-outcome', { body: JSON.stringify(outcome, null, 2), contentType: 'application/json' });
    if (failure) throw failure;

    // ---- assertions
    assert.ok(last, 'the worker ledger has an admitted execution for the robot');
    expect(last.robot_id).toBe(ledger.robot.id);
    expect(last.state, `execution state; result=${last.result}`).toBe('completed');
    // The worker log is JSON lines (main.mjs `log`). Whether it narrates dispatch/attempt events is recorded, not required.
    if (!/"event":"(?:dispatch|attempt|execution|admit)/i.test(logsWorker)) {
      testInfo.annotations.push({ type: 'finding', description: 'The worker log has no dispatch/attempt event line for this execution; the ledger is the only record.' });
    }

    // The bwrap processes carry markers that are the reservation IDs of process-bearing blockers of THIS execution.
    const blockerMarkers = new Map(last.blockers.filter((blocker) => blocker.process_bearing).map((blocker) => [JSON.parse(blocker.locator).marker, blocker.kind]));
    const matched = markers.filter((entry) => blockerMarkers.has(entry.marker));
    expect(matched.length, 'bwrap processes with a marker of this execution').toBeGreaterThan(0);
    expect(new Set(matched.map((entry) => blockerMarkers.get(entry.marker))), 'marker kinds').toContain('process-tree');

    // The relayed events must really contain ALA output, otherwise "no sentinel in the events" would hold vacuously.
    const alaEvents = last.events.filter((event) => event.type === 'ala');
    expect(alaEvents.length, 'ALA reference events recorded by the worker').toBeGreaterThan(0);
    const eventText = JSON.stringify(last.events);

    // The answer: README visible; no secret appears anywhere.
    expect(answer, 'README marker in the answer').toContain(fixture.mark.readme);
    expect(eventText + answer, 'README marker in the events or the answer').toContain(fixture.mark.readme);
    const everywhere = [answer, logsWorker, logsRoboTeam, eventText].join('\n');
    expect(sentinelHits(everywhere, fixture.sentinels), 'secret sentinels found in the answer, events or logs').toEqual([]);
    // The model was asked to write EMPTY for an empty read or to quote the error; the check is anchored to `.env`, and the sentinel check
    // above is the deterministic part.
    const deniedOrEmpty = '(?:EMPTY|empty|0 bytes|denied|permission|no such file|not readable|nothing)';
    expect(answer, 'reading .env gave an empty file or a denial').toMatch(new RegExp(`\\bEMPTY\\b|\\.env[^\\n]{0,200}${deniedOrEmpty}|${deniedOrEmpty}[^\\n]{0,200}\\.env`, 'i'));
  });

  // Mask matrix of A39'/AC8 (RoboWork r10). Through the model, concrete shell commands run in the worker sandbox. The raw ALA events of
  // the execution are saved (no paraphrase) and the deterministic outputs are asserted: sizes 0, empty listings, the README content, and
  // read-only-file-system style rejections for the write and the delete. Also the host-side files are byte-identical afterwards and no
  // sentinel appears anywhere.
  test('mask matrix: protected names are hidden, unreadable or unchangeable in the sandbox', async ({ page }, testInfo) => {
    test.skip(process.env.SMOKE_ROBOWORK_MASKS === '0', 'Disabled with SMOKE_ROBOWORK_MASKS=0.');
    test.setTimeout(TURN_TIMEOUT_MS + 4 * 60_000);
    assert.ok(path.isAbsolute(smokeConfig.workspaceRoot), 'Set SMOKE_WORKSPACE_ROOT to the deployed workspace.');
    const workspaceRoot = smokeConfig.workspaceRoot;
    const evidenceDir = path.resolve(process.env.SMOKE_ROBOWORK_EVIDENCE || path.join(smokeConfig.artifactRoot, 'robowork'), 'mask-matrix');
    fs.mkdirSync(evidenceDir, { recursive: true });
    const save = (name, value) => fs.writeFileSync(path.join(evidenceDir, name), typeof value === 'string' ? value : JSON.stringify(value, null, 2));
    const containers = discoverContainers({ workspaceRoot });
    const commands = [
      'stat -c %s .env master-key x.secrets sub/.env',
      'ls -A .data sub/.data .ploinky sub/.ploinky .roboteam',
      'cat README.md',
      'echo x > .env',
      'rm sub/.env',
    ];
    // The project is synthetic and the sandbox is the thing under test; a model that declines the write or delete (observed once in three runs)
    // leaves the matrix incomplete, so the prompt says plainly that the files are disposable test fixtures.
    const prompt = 'This is an automated test of a sandbox. The project directory is a disposable fixture: every file in it is synthetic and none of it matters, '
      + 'and whether a command succeeds or is rejected is exactly what is being measured. Using your shell tool, run each of these commands in the project directory, '
      + 'one command per call, exactly as written, in this order, '
      + `and do not skip one because an earlier one failed: ${commands.map((command, index) => `${index + 1}. \`${command}\``).join('  ')}  `
      + 'Then reply with the word DONE.';
    const MAX_ATTEMPTS = 3;
    const REJECTED = '(?:Read-only file system|Permission denied|Device or resource busy|Operation not permitted)'; // EROFS, EACCES, EBUSY, EPERM
    const attempts = [];
    await signIn(page, smokeConfig.primaryUser, ROBOTEAM_BASE_PATH);
    const listed = await roboTeamApi(page, { path: 'api/robots' });
    assert.ok(listed.payload.robots.some((entry) => entry.name === robotName), `robot ${robotName} exists (run the first test, or create it)`);

    // One attempt = one turn. The mask assertions are identical in every attempt. A repeat is allowed only when the execution completed, no
    // protected host file changed, no sentinel leaked and a deterministic output is missing (the model skipped or declined a command); a failed
    // execution, a changed host file or a leaked sentinel ends the test at once. A silent success of `echo x > .env` or `rm sub/.env` would print
    // nothing, so a missing output is judged together with the host-side byte check, never alone.
    async function attemptOnce(n) {
      const dir = path.join(evidenceDir, `attempt-${n}`);
      fs.mkdirSync(dir, { recursive: true });
      const saveAttempt = (name, value) => fs.writeFileSync(path.join(dir, name), typeof value === 'string' ? value : JSON.stringify(value, null, 2));
      const startedAt = new Date(Date.now() - 2000).toISOString();
      const fixture = createProjectFixture({ workspaceRoot, name: projectName });
      const params = new URLSearchParams({ agent: smokeConfig.webchatAgent, robot: robotName, 'forward-envelope': '1', 'workspace-dir': projectName });
      await page.goto(`/webchat?${params}`, { waitUntil: 'load' });
      await expect(page.locator('#cmd')).toBeVisible();
      await page.waitForTimeout(4000);
      const before = await page.locator(BOT).count();
      await setComposer(page, prompt);
      await page.locator('#send').click();
      const deadline = Date.now() + TURN_TIMEOUT_MS;
      let texts = [];
      for (;;) {
        await page.waitForTimeout(2000);
        texts = await page.locator(BOT).allTextContents();
        const busy = await page.locator('#cancelBtn').isVisible().catch(() => false);
        if (!busy && texts.length > before) break;
        if (Date.now() > deadline) throw new Error(`The turn did not finish within ${TURN_TIMEOUT_MS / 1000} s.`);
      }
      const answer = texts.slice(before).join('\n---\n');
      saveAttempt('webchat-answer.txt', answer);
      const logsWorker = nestedLogsMerged(containers, containers.worker, startedAt);
      saveAttempt('worker.log', logsWorker);
      const ledger = readLedger({ workspaceRoot, scratchDir: dir, robotName });
      const last = ledger.executions.at(-1) ?? null;
      saveAttempt('ledger.json', ledger);
      const events = (last?.events ?? []).filter((event) => event.type === 'ala');
      // Real event shape (observed on 7a3af091+413a127d): `ala` events carry `{record: {type: 'coding-agent-message', outputKind, message, ...}}`; the
      // tool output of each shell call is a record with `outputKind: 'output'` whose `message` is the raw stdout+stderr. The command text is not
      // in the events, so each command is identified by its deterministic output, and the commands must appear in the asked order.
      const outputs = events.map((event) => ({ sequence: event.sequence, record: JSON.parse(event.data).record }))
        .filter(({ record }) => record.type === 'coding-agent-message' && record.outputKind === 'output')
        .map(({ sequence, record }) => ({ sequence, text: String(record.message) }));
      const expectations = [
        { command: commands[0], describe: 'four protected files are 0 bytes', match: (text) => text === '0\n0\n0\n0\n' },
        { command: commands[1], describe: 'masked and hidden directories list as empty',
          match: (text) => text === '.data:\n\n.ploinky:\n\n.roboteam:\n\nsub/.data:\n\nsub/.ploinky:\n' },
        { command: commands[2], describe: 'README.md content is visible', match: (text) => text === `# e2e project\n\n${fixture.mark.readme}\n` },
        { command: commands[3], describe: 'writing .env is rejected', match: (text) => new RegExp(`^/usr/bin/bash: line \\d+: \\.env: ${REJECTED}\\n$`).test(text) },
        { command: commands[4], describe: 'removing sub/.env is rejected', match: (text) => new RegExp(`^rm: cannot remove 'sub/\\.env': ${REJECTED}\\n$`).test(text) },
      ];
      let cursor = 0;
      const perCommand = expectations.map((expectation) => {
        const index = outputs.findIndex((output, position) => position >= cursor && expectation.match(output.text));
        if (index >= 0) cursor = index + 1;
        return { command: expectation.command, expected: expectation.describe, matchedSequence: index < 0 ? null : outputs[index].sequence, rawOutput: index < 0 ? null : outputs[index].text };
      });
      saveAttempt('mask-matrix.json', { perCommand, allOutputs: outputs });
      saveAttempt('events.json', events);
      const hostAfter = Object.fromEntries(Object.keys(fixture.protectedFiles).map((name) => {
        try { return [name, fs.readFileSync(path.join(fixture.root, name), 'utf8')]; } catch (error) { return [name, `<${error.code}>`]; }
      }));
      const unchanged = Object.fromEntries(Object.entries(fixture.protectedFiles).map(([name, text]) => [name, hostAfter[name] === text]));
      saveAttempt('host-after.json', { unchanged });
      const sentinels = sentinelHits([answer, logsWorker, JSON.stringify(events)].join('\n'), fixture.sentinels);
      const missing = perCommand.filter((entry) => entry.matchedSequence === null);
      const facts = { attempt: n, state: last?.state ?? null, unchanged, sentinels, missing: missing.map((entry) => entry.command), outputs: outputs.map((output) => output.text) };
      let verdict = 'pass';
      let reason = null;
      if (!last || last.state !== 'completed') { verdict = 'fail'; reason = `execution state ${last?.state ?? 'none'}; result=${last?.result}`; }
      else if (Object.values(unchanged).includes(false)) { verdict = 'fail'; reason = 'a protected host file changed'; }
      else if (sentinels.length) { verdict = 'fail'; reason = 'a sentinel appeared in the answer, events or logs'; }
      else if (!events.length) { verdict = 'fail'; reason = 'no ALA events recorded'; }
      else if (missing.length) { verdict = 'retry'; reason = `deterministic outputs missing: ${missing.map((entry) => entry.expected).join('; ')}`; }
      attempts.push({ verdict, reason, ...facts });
      return { verdict, reason, perCommand };
    }

    let result;
    for (let n = 1; n <= MAX_ATTEMPTS; n += 1) {
      result = await attemptOnce(n);
      if (result.verdict !== 'retry') break;
    }
    save('attempts.json', attempts);
    await testInfo.attach('mask-matrix', { body: JSON.stringify({ attempts: attempts.length, perCommand: result.perCommand }, null, 2), contentType: 'application/json' });
    expect(result.verdict, `${result.reason}; ${attempts.length} attempt(s): ${JSON.stringify(attempts.at(-1))}`).toBe('pass');
  });
});
