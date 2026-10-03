import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';

import { test, expect } from '../lib/fixtures.mjs';
import { smokeConfig, smokeArtifactPath } from '../lib/config.mjs';
import { assertBoxWorkspacePath } from '../lib/box-workspace.mjs';
import { createDirectory, deleteDirectoryIfPresent } from '../lib/copilot.mjs';
import { openExplorer } from '../lib/explorer.mjs';
import { callAgentToolViaRouter } from '../lib/mcp.mjs';
import { setComposer, waitForWebchatIdle } from '../lib/webchat.mjs';
import { ROBOTEAM_BASE_PATH, roboTeamApi } from '../lib/conversation-skills.mjs';
import {
  CodexAuthError, RUN_TIMEOUT_MS, acquireRunLock, assertNoQuarantine, assertPrivateRoot, classifyTurnFailure, createCredentialSession, createInflight, isRunId,
  planRecovery, readInflight, removeInflight, resolveAuthPaths, robotDeleteAccepted,
} from '../lib/codex-test-auth.mjs';
import { TEST_ROBOT_PREFIX, bindingUnchanged, createCodexRuntime, credentialPhase, pollCodexClient } from '../lib/codex-test-auth-runtime.mjs';

// One bounded native Codex turn in a run-owned, codex-only RoboTeam robot, authenticated by the owned login stream.
// Every credential move goes through lib/codex-test-auth*.mjs. This spec never traces, stores browser state, reads
// the caller's own Codex login, spawns Codex or runs a login. Opt in with SMOKE_COPILOT_CODEX=1 through
// `npm run test:copilot-codex`, which also owns the exit codes and the one-line summary.
const enabled = process.env.SMOKE_COPILOT_CODEX === '1';
const BOT_MESSAGE = '#chatList > .wa-message.in:not(.wa-typing):not(.wa-task-item) .wa-message-bubble';
const STARTUP_FAILURE = /\[input error\]|bwrap:|Agent process exited repeatedly|open \/proc\/\d+\/ns/i;
const COMPLETION_FAILURE = /\[input error\]|\[error\]|tier[_\s-]+exhausted|provider\s+(?:error|failure)|API\s+(?:error|failure)|startup\s+(?:error|failure)/i;
const ROBOT_ID = /^[a-z0-9][a-z0-9-]{2,63}$/;
const BUDGET = Object.freeze({ setup: 60_000, binding: 90_000, create: 30_000, folder: 45_000, cliStart: 180_000, identity: 30_000, inject: 15_000,
  turn: 150_000, verify: 15_000, copyBack: 45_000, remove: 15_000, teardown: 200_000, finish: 60_000, recovery: 360_000 });

async function assistantMessages(page) {
  return page.locator(BOT_MESSAGE).evaluateAll((messages) => messages.map((message, index) => ({
    id: message.dataset.messageId || `baseline-index-${index}`,
    text: (message.dataset.fullText || message.textContent || '').trim(),
  })));
}

function within(milliseconds, work) {
  let timer;
  return Promise.race([
    Promise.resolve().then(work),
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('phase budget exceeded')), milliseconds); }),
  ]).finally(() => clearTimeout(timer));
}

// Anything that is not already a classified failure becomes the given code and reason. Only fixed words are ever reported.
function classify(error, code, reason) {
  return error instanceof CodexAuthError ? error : new CodexAuthError(code, reason);
}

function freshResult(runId) {
  return {
    runId, startedAt: new Date().toISOString(), finishedAt: null, code: 'OK', reason: null, exitCode: 0, authRejectionSuspected: false,
    primaryFailure: null, recovered: false, binding: { before: null, after: null, unchanged: null },
    robot: { id: null, name: null, created: false, deleted: false },
    defaultRobot: { codingAgentsBefore: null, codingAgentsAfter: null, unchanged: null },
    codexClient: { package: null, version: null, generation12: null, pre: null, post: null },
    identity: null, turn: { durationMs: null, tokenObserved: false },
    stream: { sameAccount: null, refreshedDuringRun: false, lastRefreshAdvanced: false, replaced: false, quarantined: false,
      lastRefreshAgeHoursBefore: null, accessValidHoursBefore: null },
    // Flags start true because nothing exists yet; each is cleared when the thing it covers comes into existence.
    cleanup: { credentialPersisted: true, credentialRemoved: true, robotDeleted: true, folderDeleted: true },
  };
}

test.describe('Codex-authenticated Copilot native turn', () => {
  test.skip(!enabled, 'Opt in with SMOKE_COPILOT_CODEX=1 through npm run test:copilot-codex.');
  test('one bounded native Codex turn in a run-owned robot with an owned, serialized login stream', async ({ page }, testInfo) => {
    // The phase budgets add up to about 15.75 min and recovery can add 12 min; the finally path must always fit. The parent's
    // watchdog is derived from the same constant and outlasts it.
    test.setTimeout(RUN_TIMEOUT_MS);
    assert.equal(testInfo.retry, 0, 'Acceptance retries are forbidden.');
    assert.equal(testInfo.project.retries, 0, 'Configure zero retries for this gate.');
    assert.equal(testInfo.config.workers, 1, 'Run this gate with one worker.');
    const runId = smokeConfig.runId;
    assert.ok(isRunId(runId), 'SMOKE_RUN_ID must be at most 64 characters of letters, digits, underscore and hyphen.');
    const result = freshResult(runId);
    const robotName = `${TEST_ROBOT_PREFIX}${runId}`;
    const folder = `codex-auth-${runId}`;
    const folderPath = `/${folder}`;
    result.robot.name = robotName;

    let primary = null;
    let cleanupFailure = null;
    let lock = null;
    let session = null;
    let robot = null;
    let inflightCreated = false;
    let folderCreated = false;
    let dashboard = null;
    let chat = null;
    let recoveryPending = null;
    let recoveryRefusal = null;
    let recoveryCopyOpen = false;
    let cliDeadline = 0;
    let completionToken = null;
    let client = null;
    let paths = null;
    let runtime = null;
    let workspaceRoot = null;

    const note = (label, error) => {
      const reported = error instanceof CodexAuthError ? `${error.code} ${error.reason}` : error?.code && /^[A-Z_]{3,30}$/.test(error.code) ? error.code : 'unclassified';
      console.error(`[codex-auth] ${label}: ${reported}`);
    };
    const fail = (error, code, reason) => { primary ??= classify(error, code, reason); };

    async function dashboardPage() {
      if (!dashboard || dashboard.isClosed()) {
        dashboard = await page.context().newPage();
        await dashboard.goto(new URL(ROBOTEAM_BASE_PATH, smokeConfig.baseURL).href, { waitUntil: 'domcontentloaded' });
      }
      return dashboard;
    }

    async function deleteRobot(target, markerRobotName = null) {
      const response = await roboTeamApi(await dashboardPage(), { method: 'POST', path: 'api/control', body: { robotId: target.robotId, operation: 'robot-delete' } });
      assert.ok(robotDeleteAccepted(response.status, { robotName: target.robotName, markerRobotName }), 'robot-delete was not accepted');
      const remaining = (await runtime.robotInventory()).filter((entry) => entry.name === target.robotName);
      assert.equal(remaining.length, 0, 'The robot still exists after robot-delete.');
    }

    // The credential bytes, their moves and the stream's reload after a recovery live in the tested library session.
    const credential = () => session?.state ?? { injected: false, injectConfirmed: false, persisted: false, removed: false };
    const recordBefore = (summary) => {
      result.stream.lastRefreshAgeHoursBefore = summary.lastRefreshAgeHours;
      result.stream.accessValidHoursBefore = summary.accessValidHours;
    };

    function writeResult() {
      const fd = fs.openSync(smokeArtifactPath('codex-auth', 'result.json'),
        fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_TRUNC | fs.constants.O_NOFOLLOW, 0o600);
      try { fs.writeFileSync(fd, `${JSON.stringify(result, null, 2)}\n`); } finally { fs.closeSync(fd); }
    }

    try {
      // Step 2 (before the browser): the host lock, the stream in memory, and the exec-chain half of any recovery.
      try {
        const box = process.env.SMOKE_PLOINKY_BOX_CONTAINER;
        assert.ok(box && smokeConfig.workspaceRoot && smokeConfig.baseURL, 'Set the exact Box, base URL and workspace root.');
        workspaceRoot = assertBoxWorkspacePath(fs.realpathSync(smokeConfig.workspaceRoot));
        paths = resolveAuthPaths(process.env);
        runtime = createCodexRuntime({ box });
      } catch (error) { throw classify(error, 'RUNTIME_PREREQ_FAILED', 'binding'); }
      await credentialPhase(BUDGET.setup + BUDGET.recovery, async () => {
        assertPrivateRoot(paths, { forbiddenRoots: [smokeConfig.repoRoot, workspaceRoot, smokeConfig.artifactRoot] });
        lock = acquireRunLock(paths, { runId });
        session = createCredentialSession({ paths, runtime, runId });
        session.holdLock(true);
        recordBefore(session.load().summary);
        try { await runtime.registryRuntime(workspaceRoot); } catch (error) { throw classify(error, 'RUNTIME_PREREQ_FAILED', 'binding'); }
        const inflight = readInflight(paths);
        let inventory;
        try { inventory = await runtime.robotInventory(); } catch (error) { throw classify(error, 'RUNTIME_PREREQ_FAILED', 'binding'); }
        const plan = planRecovery({ inflight, robots: inventory });
        if (inflight) recoveryPending = { inflight, robot: plan.robot ? { robotId: plan.robot.id, robotName: plan.robot.name } : null };
        if (plan.action === 'copy-back-then-delete') {
          result.cleanup.credentialPersisted = false;
          result.cleanup.credentialRemoved = false;
          recoveryCopyOpen = true;
          try { recoveryRefusal = (await session.recover(recoveryPending.robot)).refusal; } catch (error) {
            throw classify(error, 'CLEANUP_INCOMPLETE', 'recovery-incomplete');
          }
          result.recovered = true;
          recoveryCopyOpen = false;
          result.cleanup.credentialPersisted = true;
          result.cleanup.credentialRemoved = true;
          // Recovery may have replaced the stream with a refreshed state. The session reloaded it, so what this run injects and
          // compares against is the current stream, and the "before" figures describe that stream.
          recordBefore(session.state.loaded.summary);
        }
        // With a recovery pending the refusal waits until the robot and folder are gone, so inflight.json never blocks adopt or retire.
        if (!recoveryPending) assertNoQuarantine(paths);
      });

      // Step 3: binding before, sign-in, the pinned workspace, the administrator check and the default robot.
      await within(BUDGET.binding, async () => {
        try { result.binding.before = await runtime.readBinding({ workspaceRoot, smokeRepository: smokeConfig.repoRoot }); } catch (error) {
          throw classify(error, 'RUNTIME_PREREQ_FAILED', 'binding');
        }
        await openExplorer(page);
        const roots = (await callAgentToolViaRouter(page, { agent: 'explorer', tool: 'list_allowed_directories', args: {} })).rawText || '';
        assert.ok(roots.split('\n').includes(workspaceRoot), 'Explorer is not serving the pinned Box workspace.');
        const robots = await roboTeamApi(await dashboardPage(), { path: 'api/robots' });
        assert.equal(robots.status, 200);
        if (robots.payload?.canAdmin !== true) throw new CodexAuthError('RUNTIME_PREREQ_FAILED', 'not-admin');
        const defaults = (robots.payload.robots || []).filter((entry) => entry?.name === 'default');
        assert.equal(defaults.length, 1);
        result.defaultRobot.codingAgentsBefore = defaults[0].codingAgents ?? null;
      }).catch((error) => { throw classify(error, 'RUNTIME_PREREQ_FAILED', 'binding'); });

      // The browser half of any recovery: only the robot and folder named by inflight.json, then the marker.
      if (recoveryPending) {
        await within(BUDGET.recovery, async () => {
          const { inflight, robot: stale } = recoveryPending;
          if (stale) {
            await runtime.waitCliExit(stale.robotName);
            await deleteRobot(stale, inflight.robotName);
          }
          await deleteDirectoryIfPresent(page, `/${inflight.folder}`);
          removeInflight(paths);
          result.recovered = true;
          recoveryPending = null;
        }).catch((error) => { throw classify(error, 'CLEANUP_INCOMPLETE', 'recovery-incomplete'); });
      }

      if (recoveryRefusal) throw recoveryRefusal;
      assertNoQuarantine(paths);

      // Step 4: the marker first, then the robot.
      await within(BUDGET.create, async () => {
        createInflight(paths, { runId, robotName, folder });
        inflightCreated = true;
        result.cleanup.robotDeleted = false;
        const created = await roboTeamApi(await dashboardPage(), { method: 'POST', path: 'api/robots', body: { name: robotName, codingAgents: ['codex'] } });
        assert.equal(created.status, 201);
        const id = created.payload?.robot?.id;
        assert.match(String(id), ROBOT_ID);
        assert.equal(created.payload.robot.name, robotName);
        assert.deepEqual(created.payload.robot.codingAgents, ['codex']);
        robot = { robotId: id, robotName };
        Object.assign(result.robot, { id, created: true });
      }).catch((error) => { throw classify(error, 'RUNTIME_PREREQ_FAILED', 'binding'); });

      // Step 5: the run folder.
      await within(BUDGET.folder, async () => {
        result.cleanup.folderDeleted = false;
        folderCreated = true;
        await createDirectory(page, folder, folderPath);
      }).catch((error) => { throw classify(error, 'RUNTIME_PREREQ_FAILED', 'binding'); });

      // Step 6: WebChat for the test robot. The first CLI start may install a newer Codex client.
      cliDeadline = Date.now() + BUDGET.cliStart;
      await within(BUDGET.cliStart, async () => {
        chat = await page.context().newPage();
        const query = new URLSearchParams({ agent: 'roboTeamAgent', robot: robotName, 'workspace-dir': folder, 'forward-envelope': '1' });
        await chat.goto(`/webchat?${query.toString()}`, { waitUntil: 'domcontentloaded' });
        await expect(chat.locator('#cmd')).toBeEditable({ timeout: BUDGET.cliStart });
        await expect(chat.locator('#send')).toBeVisible();
        await expect(chat.locator('#chatList')).not.toContainText(STARTUP_FAILURE);
        await waitForWebchatIdle(chat, BUDGET.cliStart);
      }).catch((error) => { throw classify(error, 'RUNTIME_PREREQ_FAILED', 'cli-start-budget'); });

      // Step 7: the Codex client the CLI will run, the provider names in its environment, and no native credential yet.
      // Ploinky reports the CLI ready before robot-cli has prepared its tool selection, so the read polls inside what is left of
      // the 180 s CLI-start budget (never less than the step's own budget) and fails closed when that runs out.
      const clientWaitMs = Math.max(BUDGET.identity, cliDeadline - Date.now());
      await within(clientWaitMs + BUDGET.identity, async () => {
        client = await pollCodexClient(runtime, robot, { timeoutMs: clientWaitMs }).catch((error) => { throw classify(error, 'RUNTIME_PREREQ_FAILED', 'codex-client-missing'); });
        Object.assign(result.codexClient, { package: client.package, version: client.version, generation12: client.generation.slice(0, 12),
          pre: { version: client.version, generation12: client.generation.slice(0, 12) } });
        const pin = process.env.CODEX_TEST_EXPECT_CODEX_VERSION;
        if (pin && pin !== client.version) throw new CodexAuthError('RUNTIME_PREREQ_FAILED', 'version-pin');
        // An empty process list cannot prove the environment, so it fails closed.
        if (client.cli.count === 0 || client.cli.openaiBaseUrlSet || client.cli.openaiApiKeySet) throw new CodexAuthError('IDENTITY_MISMATCH', 'provider-env');
        if (client.codexConfigTomlPresent) throw new CodexAuthError('IDENTITY_MISMATCH', 'config-toml');
        const entry = (await runtime.robotInventory()).find((candidate) => candidate.name === robotName);
        if (!entry || entry.codexAuthPresent !== false) throw new CodexAuthError('RUNTIME_PREREQ_FAILED', 'target-exists');
      });

      // Step 8: the credential goes in over stdin. From here a copy-back is always attempted.
      await credentialPhase(BUDGET.inject, async () => {
        result.cleanup.credentialPersisted = false;
        result.cleanup.credentialRemoved = false;
        try { await session.inject(robot); } catch (error) {
          throw new CodexAuthError('RUNTIME_PREREQ_FAILED', error?.code === 'TARGET_EXISTS' ? 'target-exists' : 'binding');
        }
      });

      // Step 9: one bounded native turn through the browser, no retry.
      await within(BUDGET.turn + 10_000, async () => {
        await waitForWebchatIdle(chat, BUDGET.cliStart);
        const baseline = await assistantMessages(chat);
        const baselineIds = new Set(baseline.map((message) => message.id));
        completionToken = `CODEX_AUTH_OK_${crypto.randomUUID()}`;
        await setComposer(chat, `Reply with exactly this token and no Markdown: ${completionToken}`);
        const started = Date.now();
        await chat.locator('#send').click();
        let lastText = '';
        let stable = 0;
        const deadline = started + BUDGET.turn;
        while (Date.now() < deadline && stable < 3) {
          const created = (await assistantMessages(chat)).filter((message, index) => !baselineIds.has(message.id) && index >= baseline.length && message.text);
          const candidate = created.at(-1)?.text || '';
          if (candidate && COMPLETION_FAILURE.test(candidate)) {
            result.authRejectionSuspected = classifyTurnFailure(candidate).authRejectionSuspected;
            throw new CodexAuthError('NATIVE_TURN_FAILED', 'failed');
          }
          if (!candidate || !candidate.includes(completionToken)) { lastText = candidate; stable = 0; } else if (candidate === lastText) stable += 1;
          else { lastText = candidate; stable = 1; }
          if (stable < 3) await chat.waitForTimeout(250);
        }
        result.turn.durationMs = Date.now() - started;
        if (stable < 3) {
          const visible = await chat.locator('#chatList').innerText({ timeout: 5000 }).catch(() => '');
          result.authRejectionSuspected = classifyTurnFailure(`${lastText} ${visible.slice(-4000)}`).authRejectionSuspected;
          throw new CodexAuthError('NATIVE_TURN_FAILED', 'timeout');
        }
        result.turn.tokenObserved = true;
        await waitForWebchatIdle(chat);
      }).catch((error) => { throw classify(error, 'NATIVE_TURN_FAILED', 'failed'); });

      // Step 10: identity from RoboTeam's session file and ALA's own transcript.
      await within(BUDGET.verify, async () => {
        let identity;
        try {
          identity = await runtime.turnIdentity({ workspaceRoot, folder, robotId: robot.robotId, completionToken });
        } catch (error) {
          throw new CodexAuthError('IDENTITY_MISMATCH', error?.code === 'TRANSCRIPT_MISSING' ? 'transcript-missing' : 'transcript-mismatch');
        }
        result.identity = { sessionCount: identity.sessionCount, turnCount: identity.turnCount, engine: identity.engine, ala: identity.ala,
          cli: client.cli, codexConfigTomlPresent: client.codexConfigTomlPresent };
        const { engine, ala } = identity;
        if (!engine || engine.type !== 'ala' || engine.backend !== 'codex') throw new CodexAuthError('IDENTITY_MISMATCH', 'backend');
        if (engine.robotId !== robot.robotId || engine.home !== `/data/robots/${robot.robotId}/home`) throw new CodexAuthError('IDENTITY_MISMATCH', 'robot');
        if (engine.cwd !== `${workspaceRoot}/${folder}`) throw new CodexAuthError('IDENTITY_MISMATCH', 'transcript-mismatch');
        if (ala.agent !== 'codex') throw new CodexAuthError('IDENTITY_MISMATCH', 'backend');
        if (!ala.hasThreadId || ala.lastTurnStatus !== 'completed' || !ala.finalContainsToken) throw new CodexAuthError('IDENTITY_MISMATCH', 'transcript-mismatch');
        if (client.package !== '@openai/codex' || !/^\d+\.\d+\.\d+/.test(client.version)) throw new CodexAuthError('IDENTITY_MISMATCH', 'binary');
      });
    } catch (error) {
      note('run', error);
      fail(error, 'INTERNAL', 'exception');
    } finally {
      // Steps 11 to 14 always run once a credential or a robot exists. The robot is deleted only after the runtime bytes are
      // persisted (stream replaced or quarantine written) and the runtime copy has been removed.
      try {
        if (!robot && inflightCreated && runtime) {
          const found = (await runtime.robotInventory().catch(() => [])).find((entry) => entry.name === robotName);
          if (found) { robot = { robotId: found.id, robotName }; result.robot.id = found.id; result.robot.created = true; }
        }
        const held = credential();
        if (held.injected && robot && !(held.persisted && held.removed)) {
          await credentialPhase(BUDGET.copyBack + BUDGET.remove, () => session.persistAndRemove(robot, { confirmed: held.injectConfirmed })).catch((error) => {
            note('persist', error);
            if (error instanceof CodexAuthError && error.code === 'CLEANUP_INCOMPLETE') cleanupFailure ??= error;
            else fail(error, 'COPYBACK_REFUSED', 'invalid');
          });
        }
        // A recovery whose copy is still unaccounted for keeps both flags false.
        result.cleanup.credentialPersisted = !recoveryCopyOpen && (!held.injected || held.persisted);
        result.cleanup.credentialRemoved = !recoveryCopyOpen && (!held.injected || held.removed);
      } catch (error) { note('persist-outer', error); cleanupFailure ??= new CodexAuthError('CLEANUP_INCOMPLETE', 'credential-not-persisted'); }

      const settled = credential();
      const credentialSettled = !settled.injected || (settled.persisted && settled.removed);
      if (robot && credentialSettled) {
        try {
          await within(BUDGET.teardown, async () => {
            if (chat && !chat.isClosed()) await chat.close();
            await runtime.waitCliExit(robotName);
            await deleteRobot(robot);
          });
          result.robot.deleted = true;
          result.cleanup.robotDeleted = true;
        } catch (error) { note('robot-delete', error); cleanupFailure ??= new CodexAuthError('CLEANUP_INCOMPLETE', 'robot-not-deleted'); }
      } else if (robot) {
        cleanupFailure ??= new CodexAuthError('CLEANUP_INCOMPLETE', 'credential-not-persisted');
      } else if (inflightCreated) {
        // No robot was ever created: nothing to delete.
        result.cleanup.robotDeleted = true;
      }

      if (folderCreated && result.cleanup.robotDeleted) {
        try {
          await within(BUDGET.finish, () => deleteDirectoryIfPresent(page, folderPath));
          result.cleanup.folderDeleted = true;
        } catch (error) { note('folder-delete', error); cleanupFailure ??= new CodexAuthError('CLEANUP_INCOMPLETE', 'folder-not-deleted'); }
      } else if (folderCreated) {
        cleanupFailure ??= new CodexAuthError('CLEANUP_INCOMPLETE', 'folder-not-deleted');
      }

      // Binding after, the default robot unchanged, then the marker.
      if (runtime && result.binding.before && result.cleanup.robotDeleted && result.cleanup.folderDeleted) {
        try {
          await within(BUDGET.finish, async () => {
            result.binding.after = await runtime.readBinding({ workspaceRoot, smokeRepository: smokeConfig.repoRoot });
            result.binding.unchanged = bindingUnchanged(result.binding.before, result.binding.after);
            result.codexClient.post = result.binding.after.codexClient ?? null;
            const robots = await roboTeamApi(await dashboardPage(), { path: 'api/robots' });
            const defaults = (robots.payload?.robots || []).filter((entry) => entry?.name === 'default');
            result.defaultRobot.codingAgentsAfter = defaults.length === 1 ? defaults[0].codingAgents ?? null : null;
            result.defaultRobot.unchanged = JSON.stringify(result.defaultRobot.codingAgentsBefore) === JSON.stringify(result.defaultRobot.codingAgentsAfter);
          });
          if (!result.binding.unchanged || !result.defaultRobot.unchanged) fail(null, 'IDENTITY_MISMATCH', 'binding-changed');
        } catch (error) { note('binding-after', error); fail(error, 'IDENTITY_MISMATCH', 'binding-changed'); }
      }
      if (paths && lock && inflightCreated && !cleanupFailure && result.cleanup.robotDeleted && result.cleanup.folderDeleted && credentialSettled) {
        try { removeInflight(paths); } catch (error) { note('marker', error); cleanupFailure ??= new CodexAuthError('CLEANUP_INCOMPLETE', 'folder-not-deleted'); }
      }
      if (recoveryPending && !cleanupFailure) cleanupFailure = new CodexAuthError('CLEANUP_INCOMPLETE', 'recovery-incomplete');
      if (chat && !chat.isClosed()) await chat.close().catch(() => {});
      if (dashboard && !dashboard.isClosed()) await dashboard.close().catch(() => {});

      // Step 15: precedence is cleanup (26), then the first failure in sequence order. The result is written before the lock goes.
      const final = cleanupFailure ?? primary;
      if (primary) result.primaryFailure = { code: primary.code, reason: primary.reason };
      if (final) { result.code = final.code; result.reason = final.reason; result.exitCode = final.exitCode; }
      result.finishedAt = new Date().toISOString();
      if (session) {
        Object.assign(result.stream, session.state.stream);
        if (session.state.recoveryStream) result.recoveredStream = session.state.recoveryStream;
      }
      try { writeResult(); } finally { session?.holdLock(false); lock?.release(); }
      assert.equal(result.code, 'OK', `codex-test-auth ${result.code} ${result.reason}`);
    }
  });
});
