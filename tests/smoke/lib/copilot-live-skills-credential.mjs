import fs from 'node:fs';
import path from 'node:path';

import {
  CodexAuthError, acquireRunLock, assertNoOtherGateInflight, assertNoOtherRouteInflight, c5Names, classifyTurnFailure, createInflight,
  ensurePrivateRoot, planRecovery, readInflight, removeInflight,
} from './codex-test-auth.mjs';
import { createOwnerCredentialSession, resolveOwnerAuthPath } from './codex-test-auth-owner.mjs';
import { checkClientQualification } from './codex-client-qualification.mjs';
import { pollCodexClient } from './codex-test-auth-runtime.mjs';

// The C5 (spec 06) credential lifecycle on route A: one run-owned, Codex-only robot gets the owner-derived access-only credential for seven
// bounded native turns, and loses it again before the robot is deleted. It reuses the route-A pieces (lib/codex-test-auth*.mjs): the host
// lock, the gate's own marker, the owner session with its derive and inject gates, the in-container copy check and the recovery discard.
// It never imports lib/config.mjs and never writes a credential byte anywhere: the derived bytes live in memory and in the robot copy only.

// ---- timing (plan r2.1 G1) -------------------------------------------------------------------------------------------------------------

export const C5_TEST_TIMEOUT_MS = 25 * 60_000; // D: the Playwright test timeout
export const C5_GENERATION_CAP_MS = 30 * 60_000; // G: the 30-minute Box generation cap of the acceptance profile
export const C5_RUNNER_POSTFLIGHT_MS = 90_000; // P: the runner's post-run checks after the test
export const C5_CLEANUP_MS = 240_000; // T_cleanup: cancel, quiescence, popups and the owned cleanup
export const C5_FINISH_MS = 60_000; // T_finish: reader.finish and lifecycle.finish
export const C5_CREDENTIAL_SETTLE_MS = 180_000 + 30_000 + 15_000; // C: waitCliExit + BUSY-polled copy read + remove
export const C5_MARGIN_MS = 60_000; // M
export const C5_PRE_SUBMIT_MS = 45_000; // a turn's baseline, catalog and composer work before its submit click
export const C5_TURN_MS = 150_000; // one native completion (LIVE_SKILLS_TURN_TIMEOUT_MS)
export const C5_TURN_SLACK_MS = 10_000;
export const C5_INJECT_TO_TURN_MS = 15_000; // from the inject to the first turn's fence
export const C5_SPAWN_OVERHEAD_MS = 5 * 60_000; // the parent's --list check and the runner's preflight before the test starts
// Everything after the native-use deadline E' must still fit before the earlier of the generation cap (less the runner postflight) and
// the test timeout.
export const C5_AFTER_NATIVE_USE_MS = C5_CREDENTIAL_SETTLE_MS + C5_CLEANUP_MS + C5_FINISH_MS + C5_MARGIN_MS;
// The parent's watchdog outlasts the whole test, so the spec's `finally` cleanup is never killed mid-way.
export const C5_WATCHDOG_MS = C5_SPAWN_OVERHEAD_MS + C5_TEST_TIMEOUT_MS + C5_CLEANUP_MS + C5_FINISH_MS + C5_CREDENTIAL_SETTLE_MS + C5_MARGIN_MS;
// The parent does not know the Box start, so its pre-spawn owner gate requires the whole test plus the settle time (plus the skew). It is
// stricter than the worker gates, which remain authoritative at derive and inject.
export const C5_PARENT_REMAINING_MS = C5_TEST_TIMEOUT_MS + C5_CREDENTIAL_SETTLE_MS;
// A turn's fence, at its start: the pre-submit work, the completion and its slack all end by E'.
export const C5_TURN_FENCE_MS = C5_PRE_SUBMIT_MS + C5_TURN_MS + C5_TURN_SLACK_MS;
// The same fence again at the submit click, so a slow pre-submit phase cannot push a completion past E'.
export const C5_SUBMIT_FENCE_MS = C5_TURN_MS + C5_TURN_SLACK_MS;

const fail = (code, reason, extra) => new CodexAuthError(code, reason, extra);
const ISO = (ms) => new Date(ms).toISOString();

// The deadlines of one run. E' (the native-use deadline) = min(G - P, D) - (C + T_cleanup + T_finish + M); the credential deadline is E' + C.
export function c5Window({ boxStartedAtMs, testStartedAtMs }) {
  if (!Number.isFinite(boxStartedAtMs) || !Number.isFinite(testStartedAtMs)) throw fail('RUNTIME_PREREQ_FAILED', 'generation-window');
  const generationDeadline = boxStartedAtMs + C5_GENERATION_CAP_MS;
  const testDeadline = testStartedAtMs + C5_TEST_TIMEOUT_MS;
  const nativeUseDeadline = Math.min(generationDeadline - C5_RUNNER_POSTFLIGHT_MS, testDeadline) - C5_AFTER_NATIVE_USE_MS;
  return Object.freeze({ generationDeadline, testDeadline, nativeUseDeadline, credentialDeadline: nativeUseDeadline + C5_CREDENTIAL_SETTLE_MS });
}

const fence = (now, needed, deadline) => {
  if (!Number.isFinite(now) || !Number.isFinite(deadline) || now + needed > deadline) throw fail('RUNTIME_PREREQ_FAILED', 'generation-window');
};
// At the start of every turn: now + 45 s + 150 s + 10 s <= E'.
export function assertTurnFence({ now, nativeUseDeadline }) { fence(now, C5_TURN_FENCE_MS, nativeUseDeadline); }
// At every submit click: now + 150 s + 10 s <= E'.
export function assertSubmitFence({ now, nativeUseDeadline }) { fence(now, C5_SUBMIT_FENCE_MS, nativeUseDeadline); }
// Before the inject, only the first turn must fit; each later turn has its own fence, which also keeps the cleanup inside the window.
export function assertFirstTurnFits({ now, nativeUseDeadline }) { fence(now, C5_INJECT_TO_TURN_MS + C5_TURN_FENCE_MS, nativeUseDeadline); }

// G10: a native completion that failed or ran out of time, from the sanitized chat text. Only fixed words are ever reported.
export function classifyLiveSkillsTurnFailure(sanitizedText, { timedOut = false } = {}) {
  return fail('NATIVE_TURN_FAILED', timedOut ? 'timeout' : 'failed', { authRejectionSuspected: classifyTurnFailure(sanitizedText).authRejectionSuspected });
}

// The fixture of a crashed run, rebuilt from its marker only. `create` is lib/copilot-live-skills.mjs `createLiveSkillsFixture`.
export function fixtureFromMarker(marker, workspaceRoot, { create }) {
  if (marker?.gate !== 'c5') throw fail('USAGE', 'bad-variable');
  const names = c5Names(marker.runId);
  const fixture = create(workspaceRoot, { runId: marker.runId });
  if (fixture.robotName !== names.robotName || fixture.folder !== names.folder || fixture.repositoryName !== names.repositoryName) throw fail('STREAM_UNSAFE', 'inflight-present');
  return fixture;
}

// The exec-chain half of recovering a crashed C5 run, from observed state only: the marker and the in-container inventory. A present
// robot always gets the in-container discard (it is idempotent and never returns bytes), whatever its CLI does, and then the CLI exit.
export function planC5Recovery({ marker, robots }) {
  const plan = planRecovery({ gate: 'c5', inflight: marker, robots });
  if (!marker) return { pending: false, robot: null, discard: false, waitCliExit: false };
  const robot = plan.robot ? { robotId: plan.robot.id, robotName: plan.robot.name } : null;
  return { pending: true, robot, discard: robot !== null, waitCliExit: robot !== null };
}

export const C5_CLEANUP_FLAGS = Object.freeze(['credentialPersisted', 'credentialRemoved', 'linksRemoved', 'sourceUnregistered', 'robotDeleted', 'folderDeleted']);
const FLAG_REASON = Object.freeze({ credentialPersisted: 'credential-not-persisted', credentialRemoved: 'credential-not-removed', linksRemoved: 'links-not-removed',
  sourceUnregistered: 'source-not-unregistered', robotDeleted: 'robot-not-deleted', folderDeleted: 'folder-not-deleted' });
const STEP_FLAG = Object.freeze({ 'links-removed': 'linksRemoved', 'source-unregistered': 'sourceUnregistered', 'robot-deleted': 'robotDeleted', 'folders-removed': 'folderDeleted' });

// G11: the first cleanup flag that is not true, as its fixed reason, or null when every flag is true.
export function firstCleanupGap(cleanup) {
  const name = C5_CLEANUP_FLAGS.find((flag) => cleanup?.[flag] !== true);
  return name ? FLAG_REASON[name] : null;
}

const defaultLog = (line) => process.stderr.write(`${line}\n`);

// One C5 run. `boxStartedAt` is the verified Box State.StartedAt (reader.release.liveBox.box.startedAt). `resultFile` is
// <SMOKE_ARTIFACT_DIR>/codex-auth/result.json. `now` is the clock for every gate and fence.
export function createLiveSkillsCredentialLifecycle({ env, paths, runtime, runId, boxStartedAt, testStartedAt, resultFile, forbiddenRoots = [],
  now = Date.now, log = defaultLog, readOwner, procRoot = '/proc' } = {}) {
  if (runtime?.gate !== 'c5') throw fail('USAGE', 'bad-variable');
  const names = c5Names(runId);
  const window = c5Window({ boxStartedAtMs: Date.parse(boxStartedAt), testStartedAtMs: testStartedAt });
  const result = {
    runId, route: 'owner', gate: 'c5', startedAt: ISO(testStartedAt), finishedAt: null, code: 'OK', reason: null, exitCode: 0, primaryFailure: null,
    recovered: false, authRejectionSuspected: false, robot: { id: null, name: names.robotName, created: false, deleted: false },
    codexClient: { package: null, version: null, generation12: null, qualification: null, post: null },
    owner: { source: null, derived: false, accountClaim: null, gateAtDerive: null, gateAtInject: null }, runtimeCopy: null, recoveredCopy: null,
    window: { boxStartedAt: ISO(Date.parse(boxStartedAt)), nativeUseDeadline: ISO(window.nativeUseDeadline), credentialDeadline: ISO(window.credentialDeadline) },
    turns: { completed: 0 },
    // Each flag starts true because nothing exists yet, and is cleared when the thing it covers can exist.
    cleanup: Object.fromEntries(C5_CLEANUP_FLAGS.map((flag) => [flag, true])),
  };
  const state = { lock: null, session: null, marked: false, qualified: null, recovery: null, recoveryRefusal: null, cleanupFailure: null,
    primary: null, workspaceRoot: null, finished: false };
  const stage = (word) => log(`[codex-auth] c5 stage ${word}`);
  const sameRobot = (a, b) => a?.robotId === b?.robotId && a?.robotName === b?.robotName;
  const requireRobot = (robot) => {
    if (typeof robot?.robotId !== 'string' || robot.robotName !== names.robotName) throw fail('USAGE', 'bad-variable');
    return { robotId: robot.robotId, robotName: robot.robotName };
  };

  const api = {
    result,
    window,
    state,
    // Before sign-in, under the host lock: the location and lock checks, both other-marker refusals, the RoboTeam binding and the exec-chain
    // half of any recovery (discard, then CLI exit). The owner login is never read here.
    async begin({ workspaceRoot }) {
      stage('begin');
      state.workspaceRoot = workspaceRoot;
      ensurePrivateRoot(paths, { forbiddenRoots });
      state.lock = acquireRunLock(paths, { runId, procRoot });
      state.session = createOwnerCredentialSession({ runtime, runDeadline: window.credentialDeadline, now, readOwner,
        injectWindowMs: () => Math.max(0, window.credentialDeadline - now()) });
      state.session.holdLock(true);
      assertNoOtherRouteInflight(paths, 'owner');
      assertNoOtherGateInflight(paths, 'c5');
      try { await runtime.registryRuntime(workspaceRoot); } catch (error) { throw classifyAs(error, 'RUNTIME_PREREQ_FAILED', 'binding'); }
      const marker = readInflight(paths, { route: 'owner', gate: 'c5' });
      let robots;
      try { robots = await runtime.robotInventory(); } catch (error) { throw classifyAs(error, 'RUNTIME_PREREQ_FAILED', 'binding'); }
      const plan = planC5Recovery({ marker, robots });
      if (!plan.pending) return { recoveryPending: false };
      state.recovery = { marker, robot: plan.robot };
      if (plan.discard) {
        result.cleanup.credentialPersisted = false;
        result.cleanup.credentialRemoved = false;
        try { state.recoveryRefusal = (await state.session.recover(plan.robot)).refusal; } catch { throw fail('CLEANUP_INCOMPLETE', 'recovery-incomplete'); }
        result.recoveredCopy = state.session.state.recoveredCopy;
        result.cleanup.credentialPersisted = true;
        result.cleanup.credentialRemoved = true;
      }
      if (plan.waitCliExit) {
        try { await runtime.waitCliExit(plan.robot.robotName); } catch { throw fail('CLEANUP_INCOMPLETE', 'recovery-incomplete'); }
      }
      return { recoveryPending: true };
    },
    // After the authenticated page exists: the browser half of a pending recovery (unregister, robot-delete, the recovery-mode folder
    // removal), then the marker. `ownedFor(fixture)` builds lib/copilot-live-skills-fixture.mjs `createOwnedLiveSkillsFixture` for the
    // marker's fixture, and `create` is `createLiveSkillsFixture`. A refused discard (a copy that was not access-only) is raised only
    // after the robot and folders are gone.
    async recover({ ownedFor, create }) {
      if (!state.recovery) return { recovered: false };
      const fixture = fixtureFromMarker(state.recovery.marker, state.workspaceRoot, { create });
      try { await ownedFor(fixture).recover(); } catch { throw fail('CLEANUP_INCOMPLETE', 'recovery-incomplete'); }
      removeInflight(paths, { route: 'owner', gate: 'c5' });
      state.recovery = null;
      result.recovered = true;
      stage('recovered');
      if (state.recoveryRefusal) throw state.recoveryRefusal;
      return { recovered: true };
    },
    // The owner login, read once read-only, after any recovery, so an unusable login never blocks the recovery of a crashed run.
    async derive() {
      if (state.recovery) throw fail('CLEANUP_INCOMPLETE', 'recovery-incomplete');
      const resolved = resolveOwnerAuthPath(env, paths, { forbiddenRoots: [...forbiddenRoots, paths.root] });
      result.owner.source = resolved.source;
      await state.session.load({ ownerFile: resolved.file });
      stage('derived');
    },
    // The marker, written once before anything of the run exists. From here every owned resource can exist, so its flag is cleared.
    mark(fixture) {
      if (!state.session?.state.loaded || fixture?.robotName !== names.robotName) throw fail('USAGE', 'bad-variable');
      createInflight(paths, { route: 'owner', gate: 'c5', runId, robotName: names.robotName, folder: names.folder, repositoryName: names.repositoryName });
      state.marked = true;
      for (const flag of ['linksRemoved', 'sourceUnregistered', 'robotDeleted', 'folderDeleted']) result.cleanup[flag] = false;
      stage('marked');
    },
    // Spec 07 step 7 semantics, then the exact client build. The qualified identity is what the inject and every turn are held to.
    async qualify(robot, { cliDeadline }) {
      const target = requireRobot(robot);
      result.robot.id = target.robotId;
      result.robot.created = true;
      const waitMs = Math.max(30_000, cliDeadline - now());
      const client = await pollCodexClient(runtime, target, { timeoutMs: waitMs, now }).catch((error) => { throw classifyAs(error, 'RUNTIME_PREREQ_FAILED', 'codex-client-missing'); });
      Object.assign(result.codexClient, { package: client.package, version: client.version, generation12: client.generation.slice(0, 12) });
      const pin = env.CODEX_TEST_EXPECT_CODEX_VERSION;
      if (pin && pin !== client.version) throw fail('RUNTIME_PREREQ_FAILED', 'version-pin');
      if (client.cli.count === 0 || client.cli.openaiBaseUrlSet || client.cli.openaiApiKeySet) throw fail('IDENTITY_MISMATCH', 'provider-env');
      if (client.codexConfigTomlPresent) throw fail('IDENTITY_MISMATCH', 'config-toml');
      const entry = (await runtime.robotInventory()).find((candidate) => candidate.name === target.robotName);
      if (!entry || entry.id !== target.robotId || entry.codexAuthPresent !== false) throw fail('RUNTIME_PREREQ_FAILED', 'target-exists');
      const { report, failure } = await checkClientQualification({ runtime, identity: client });
      result.codexClient.qualification = report;
      if (failure) throw failure;
      state.qualified = { ...target, version: client.version, generation: client.generation };
      stage('qualified');
    },
    // G3: only after a recorded qualification of this exact robot, with the client re-read immediately before the write and compared to
    // the qualified build, and only when the first turn still fits the window. Every refusal happens before any byte is written.
    async inject(robot) {
      const target = requireRobot(robot);
      if (!state.marked || !state.qualified || !sameRobot(state.qualified, target)) throw fail('USAGE', 'bad-variable');
      assertFirstTurnFits({ now: now(), nativeUseDeadline: window.nativeUseDeadline });
      await api.assertClientUnchanged(target);
      result.cleanup.credentialPersisted = false;
      result.cleanup.credentialRemoved = false;
      try { await state.session.inject(target); } catch (error) {
        if (error instanceof CodexAuthError) throw error;
        throw fail('RUNTIME_PREREQ_FAILED', error?.code === 'TARGET_EXISTS' ? 'target-exists' : 'binding');
      }
      stage('injected');
    },
    async assertClientUnchanged(target) {
      let identity;
      try { identity = await runtime.clientIdentity(target); } catch { throw fail('IDENTITY_MISMATCH', 'binding-changed'); }
      if (identity?.version !== state.qualified.version || identity?.generation !== state.qualified.generation) throw fail('IDENTITY_MISMATCH', 'binding-changed');
    },
    // At the start of every turn: the window fence, then the Codex build must still be the qualified one.
    async beforeTurn(robot, index) {
      const target = requireRobot(robot);
      if (!state.session?.state.injectConfirmed || !sameRobot(state.qualified, target)) throw fail('USAGE', 'bad-variable');
      assertTurnFence({ now: now(), nativeUseDeadline: window.nativeUseDeadline });
      await api.assertClientUnchanged(target);
      stage(`turn-${index + 1}`);
    },
    // Immediately before a turn's submit click.
    beforeSubmit() { assertSubmitFence({ now: now(), nativeUseDeadline: window.nativeUseDeadline }); },
    turnCompleted() { result.turns.completed += 1; },
    // G2, normal path: the BUSY-polled copy check and removal by hash first, then the CLI exit. A CLI that does not exit leaves the robot
    // in place (robot-delete would refuse it, O21), so the owned cleanup is skipped and the marker is kept for a recovery.
    async settle(robot) {
      const session = state.session?.state;
      if (session?.injected && !(session.persisted && session.removed)) {
        try { await state.session.persistAndRemove(robot, { confirmed: session.injectConfirmed }); } catch (error) {
          if (error instanceof CodexAuthError && error.code === 'CLEANUP_INCOMPLETE') state.cleanupFailure ??= error;
          else api.recordFailure(classifyAs(error, 'COPYBACK_REFUSED', 'invalid'));
        }
      }
      result.cleanup.credentialPersisted = !session?.injected || session.persisted === true;
      result.cleanup.credentialRemoved = !session?.injected || session.removed === true;
      if (!result.cleanup.credentialPersisted || !result.cleanup.credentialRemoved) {
        state.cleanupFailure ??= fail('CLEANUP_INCOMPLETE', result.cleanup.credentialPersisted ? 'credential-not-removed' : 'credential-not-persisted');
        return { cliExited: false, credentialSettled: false };
      }
      try { await runtime.waitCliExit(robot.robotName); } catch {
        state.cleanupFailure ??= fail('CLEANUP_INCOMPLETE', 'robot-not-deleted');
        return { cliExited: false, credentialSettled: true };
      }
      stage('settled');
      return { cliExited: true, credentialSettled: true };
    },
    // The owned cleanup (remove-links, unregister, robot-delete, remove-folders), with one flag per completed step.
    async cleanup(owned) {
      try {
        await owned.cleanup({ quiescent: true, onStep: (step) => { if (Object.hasOwn(STEP_FLAG, step)) result.cleanup[STEP_FLAG[step]] = true; } });
        result.robot.deleted = result.cleanup.robotDeleted;
      } catch {
        state.cleanupFailure ??= fail('CLEANUP_INCOMPLETE', firstCleanupGap(result.cleanup) ?? 'folder-not-deleted');
      }
    },
    // The run's first failure. A failure that is not classified becomes INTERNAL exception.
    recordFailure(error) {
      if (!state.primary) {
        state.primary = classifyAs(error, 'INTERNAL', 'exception');
        if (error?.authRejectionSuspected === true) result.authRejectionSuspected = true;
      }
    },
    // The generation after the run, the marker only when every cleanup flag is true (G11), result.json (0600, exclusive), and the lock.
    async finish() {
      if (state.finished) return result;
      state.finished = true;
      try {
        if (state.qualified && state.cleanupFailure === null && result.cleanup.robotDeleted) {
          try {
            const after = await runtime.clientIdentity();
            result.codexClient.post = { version: after.version, generation12: after.generation.slice(0, 12) };
            if (after.generation !== state.qualified.generation || after.version !== state.qualified.version) api.recordFailure(fail('IDENTITY_MISMATCH', 'binding-changed'));
          } catch { api.recordFailure(fail('IDENTITY_MISMATCH', 'binding-changed')); }
        }
        if (state.recovery) state.cleanupFailure ??= fail('CLEANUP_INCOMPLETE', 'recovery-incomplete');
        const gap = firstCleanupGap(result.cleanup);
        if (gap && !state.cleanupFailure) state.cleanupFailure = fail('CLEANUP_INCOMPLETE', gap);
        if (state.marked && !state.cleanupFailure) {
          try { removeInflight(paths, { route: 'owner', gate: 'c5' }); } catch { state.cleanupFailure = fail('CLEANUP_INCOMPLETE', 'folder-not-deleted'); }
        }
        const final = state.cleanupFailure ?? state.primary ?? null;
        if (state.primary) result.primaryFailure = { code: state.primary.code, reason: state.primary.reason };
        if (final) Object.assign(result, { code: final.code, reason: final.reason, exitCode: final.exitCode });
        if (state.session) {
          const { derived, accountClaim, gates, runtimeCopy, recoveredCopy } = state.session.state;
          Object.assign(result.owner, { derived, accountClaim, gateAtDerive: gates.atDerive, gateAtInject: gates.atInject });
          result.runtimeCopy = runtimeCopy;
          result.recoveredCopy = recoveredCopy ?? result.recoveredCopy;
        }
        result.finishedAt = ISO(now());
        writeResult(resultFile, result);
        stage('cleaned');
        return result;
      } finally {
        state.session?.release();
        state.session?.holdLock(false);
        state.lock?.release();
      }
    },
  };
  return api;
}

function classifyAs(error, code, reason) {
  return error instanceof CodexAuthError ? error : new CodexAuthError(code, reason);
}

// result.json: one exclusive 0600 file in the run's own artifact directory, never a token, an account id or a digest of either.
function writeResult(file, result) {
  if (typeof file !== 'string' || !path.isAbsolute(file)) throw new CodexAuthError('USAGE', 'bad-variable');
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const fd = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
  try { fs.writeFileSync(fd, `${JSON.stringify(result, null, 2)}\n`); } finally { fs.closeSync(fd); }
}

