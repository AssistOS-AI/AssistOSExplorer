import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { CodexAuthError, EXIT_CODES, c5Names, createInflight, inflightPresent, readInflight, resolveAuthPaths } from './codex-test-auth.mjs';
import { ACCESS_SKEW_MS } from './codex-test-auth-owner.mjs';
import { QUALIFIED_CODEX_CLIENTS } from './codex-client-qualification.mjs';
import { RuntimeProgramError } from './codex-test-auth-runtime.mjs';
import { createLiveSkillsFixture } from './copilot-live-skills.mjs';
import {
  C5_AFTER_NATIVE_USE_MS, C5_CLEANUP_FLAGS, C5_CLEANUP_MS, C5_CREDENTIAL_SETTLE_MS, C5_FINISH_MS, C5_GENERATION_CAP_MS, C5_INJECT_TO_TURN_MS, C5_MARGIN_MS,
  C5_PARENT_REMAINING_MS, C5_RUNNER_POSTFLIGHT_MS, C5_SPAWN_OVERHEAD_MS, C5_SUBMIT_FENCE_MS, C5_TEST_TIMEOUT_MS, C5_TURN_FENCE_MS, C5_WATCHDOG_MS,
  assertFirstTurnFits, assertSubmitFence, assertTurnFence, c5Window, classifyLiveSkillsTurnFailure, createLiveSkillsCredentialLifecycle, firstCleanupGap,
  fixtureFromMarker, planC5Recovery,
} from './copilot-live-skills-credential.mjs';

// The C5 credential lifecycle against fakes only: no Box, no browser and no real credential. Every token here is fabricated. The file
// refuses to start under the account's own home, so a defect can never reach a real login.
{
  const realHome = os.userInfo().homedir;
  const realOf = (value) => { try { return fs.realpathSync(value); } catch { return path.resolve(value); } };
  if (!process.env.HOME || path.resolve(process.env.HOME) === path.resolve(realHome) || realOf(process.env.HOME) === realOf(realHome)) {
    throw new Error('Refusing to start: run with HOME set to a temporary directory.');
  }
}

const MINUTE = 60_000;
const T0 = Date.parse('2026-10-26T12:00:00.000Z');
const RUN_ID = '0f2b6c1e-8a4d-4c3b-9e5f-7a1b2c3d4e5f';
const NAMES = c5Names(RUN_ID);
const ROBOT = { robotId: 'copilot-live-ab12', robotName: NAMES.robotName };
const GENERATION = 'a'.repeat(64);
const ENTRY = QUALIFIED_CODEX_CLIENTS.find((entry) => entry.version === '0.160.0' && entry.platform === 'linux-x64');
const ACCOUNT = 'acct-fake-c5-lifecycle-0001';
const b64 = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
const failure = (code, reason) => (error) => error instanceof CodexAuthError && error.code === code && error.reason === reason && error.exitCode === EXIT_CODES[code];

function ownerLogin(expMs) {
  const token = (kind) => `${b64({ alg: 'none', typ: 'JWT' })}.${b64({ exp: Math.floor(expMs / 1000), sub: `fake-${kind}`, 'https://api.openai.com/auth': { chatgpt_account_id: ACCOUNT } })}.fake-signature`;
  return Buffer.from(JSON.stringify({ auth_mode: 'chatgpt', OPENAI_API_KEY: null, last_refresh: new Date(T0 - 3_600_000).toISOString(),
    tokens: { id_token: token('id'), access_token: token('access'), refresh_token: 'rt-fake-c5-lifecycle-0123456789abcdef', account_id: ACCOUNT } }));
}

function fakeProc(base) {
  const proc = path.join(base, 'proc');
  fs.mkdirSync(path.join(proc, 'sys/kernel/random'), { recursive: true });
  fs.writeFileSync(path.join(proc, 'sys/kernel/random/boot_id'), 'boot-1\n');
  fs.mkdirSync(path.join(proc, String(process.pid)), { recursive: true });
  fs.writeFileSync(path.join(proc, String(process.pid), 'stat'), `${process.pid} (node) ${['S', ...Array(18).fill('0'), '4242', '0', '0'].join(' ')}\n`);
  return proc;
}

// One fake Box: every call it receives is appended to `calls`, in order, with the robot only by name.
function fakeRuntime({ robots = [], authPresent = false, generations = [GENERATION], injectError = null, removeError = null, waitCliExitError = null,
  discardResult = { removed: false, accessOnly: null } } = {}) {
  const calls = [];
  let copy = null;
  let identityReads = 0;
  const identity = (robot) => ({ ok: true, package: '@openai/codex', version: '0.160.0', generation: generations[Math.min(identityReads++, generations.length - 1)],
    cli: robot ? { count: 1, openaiBaseUrlSet: false, openaiApiKeySet: false } : null, codexConfigTomlPresent: robot ? false : null });
  const inventory = () => api.robots.map((entry) => ({ ...entry, codingAgents: ['codex'], codexAuthPresent: entry.name === NAMES.robotName ? authPresent : entry.codexAuthPresent ?? null }));
  const api = {
    calls,
    gate: 'c5',
    // The robots the in-container inventory reports; a test adds the run's robot when the owned setup would have created it.
    robots: [...robots],
    get copy() { return copy; },
    async registryRuntime() { calls.push('registryRuntime'); return { containerId: 'c'.repeat(64) }; },
    async robotInventory() { calls.push('robotInventory'); return inventory(); },
    async clientIdentity(robot) { calls.push(robot ? 'clientIdentity(robot)' : 'clientIdentity'); return identity(robot); },
    async nativeDigest() { calls.push('nativeDigest'); return { ok: true, generation: GENERATION, platform: 'linux-x64', sha256: ENTRY.nativeSha256, size: ENTRY.nativeSize }; },
    async inject(robot, bytes) {
      calls.push('inject');
      copy = Buffer.from(bytes);
      if (injectError) throw injectError;
    },
    async readForCopyBack() { calls.push('readForCopyBack'); if (!copy) throw new RuntimeProgramError('NOT_FOUND'); return { bytes: Buffer.from(copy) }; },
    async remove() { calls.push('remove'); if (removeError) throw removeError; copy = null; return { ok: true, removed: true }; },
    async discard() { calls.push('discard'); return discardResult; },
    async waitCliExit() { calls.push('waitCliExit'); if (waitCliExitError) throw waitCliExitError; },
  };
  return api;
}

// The owned fixture's cleanup and recovery, recording into the same call log.
function fakeOwned(runtime, { failAt = null, recoverError = null } = {}) {
  const steps = [['remove-links', 'links-removed'], ['unregister', 'source-unregistered'], ['robot-delete', 'robot-deleted'], ['remove-folders', 'folders-removed']];
  const owned = {
    state: { cleanup: 'pending' },
    async cleanup({ quiescent, onStep }) {
      assert.equal(quiescent, true);
      owned.state.cleanup = 'failed';
      for (const [call, step] of steps) {
        if (call === failAt) throw new Error(`${call} failed`);
        runtime.calls.push(call);
        onStep(step);
      }
      owned.state.cleanup = 'passed';
    },
    async recover() { runtime.calls.push('recover'); if (recoverError) throw recoverError; return { robotId: null }; },
  };
  return owned;
}

function setup(t, { exp = T0 + 240 * MINUTE, boxAgeMs = 2 * MINUTE, runtime = fakeRuntime(), readOwner } = {}) {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'c5-lifecycle-')));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const home = path.join(base, 'home');
  fs.mkdirSync(home, { mode: 0o700 });
  const root = path.join(base, 'state', 'assistos-codex-test-auth');
  const paths = resolveAuthPaths({ HOME: home, CODEX_TEST_AUTH_ROOT: root });
  const env = { HOME: home, CODEX_TEST_AUTH_ROOT: root, CODEX_TEST_AUTH_OWNER_AUTH: '/virtual/c5-owner/auth.json' };
  const clock = { now: T0 };
  const logs = [];
  const ownerReads = [];
  let runs = 0;
  const c = { base, paths, env, clock, logs, ownerReads, runtime, resultFile: null, workspaceRoot: path.join(base, 'workspace') };
  // Each lifecycle is its own run with its own artifact directory, as each parent run is.
  c.create = () => {
    c.resultFile = path.join(base, `artifacts-${runs += 1}`, 'codex-auth', 'result.json');
    return createLiveSkillsCredentialLifecycle({ env, paths, runtime, runId: RUN_ID, boxStartedAt: new Date(T0 - boxAgeMs).toISOString(),
      testStartedAt: T0, resultFile: c.resultFile, now: () => clock.now, log: (line) => logs.push(line), procRoot: fakeProc(base),
      readOwner: readOwner ?? (async (file) => { ownerReads.push(file); return { bytes: ownerLogin(exp) }; }) });
  };
  c.lifecycle = c.create();
  return c;
}

const fixture = (c) => ({ ...createLiveSkillsFixture(c.workspaceRoot, { runId: RUN_ID }), robotId: ROBOT.robotId });

async function upToInject(c, lifecycle = c.lifecycle) {
  await lifecycle.begin({ workspaceRoot: c.workspaceRoot });
  await lifecycle.derive();
  lifecycle.mark(fixture(c));
  c.runtime.robots.push({ id: ROBOT.robotId, name: NAMES.robotName });
  await lifecycle.qualify(ROBOT, { cliDeadline: c.clock.now + 180_000 });
  await lifecycle.inject(ROBOT);
}

async function sevenTurns(c, lifecycle = c.lifecycle, turnMs = 30_000) {
  for (let index = 0; index < 7; index += 1) {
    await lifecycle.beforeTurn(ROBOT, index);
    c.clock.now += 5_000;
    lifecycle.beforeSubmit();
    c.clock.now += turnMs;
    lifecycle.turnCompleted();
  }
}

const readResult = (c) => JSON.parse(fs.readFileSync(c.resultFile, 'utf8'));

// ---- the window arithmetic (G1) ------------------------------------------------------------------------------------------------------

test('the window components are the plan values and the watchdog and parent gate are derived from them', () => {
  assert.equal(C5_TEST_TIMEOUT_MS, 25 * MINUTE);
  assert.equal(C5_GENERATION_CAP_MS, 30 * MINUTE);
  assert.equal(C5_RUNNER_POSTFLIGHT_MS, 90_000);
  assert.equal(C5_CLEANUP_MS, 240_000);
  assert.equal(C5_FINISH_MS, 60_000);
  assert.equal(C5_CREDENTIAL_SETTLE_MS, 225_000);
  assert.equal(C5_MARGIN_MS, 60_000);
  assert.equal(C5_AFTER_NATIVE_USE_MS, 225_000 + 240_000 + 60_000 + 60_000);
  assert.equal(C5_TURN_FENCE_MS, 45_000 + 150_000 + 10_000);
  assert.equal(C5_SUBMIT_FENCE_MS, 150_000 + 10_000);
  assert.equal(C5_INJECT_TO_TURN_MS, 15_000);
  assert.equal(C5_SPAWN_OVERHEAD_MS, 5 * MINUTE);
  assert.equal(C5_WATCHDOG_MS, 5 * MINUTE + 25 * MINUTE + 240_000 + 60_000 + 225_000 + 60_000);
  assert.equal(C5_PARENT_REMAINING_MS + ACCESS_SKEW_MS, 33.75 * MINUTE, 'the parent pre-spawn requirement is 33.75 minutes');
});

test('E\' = min(G - P, D) - (C + T_cleanup + T_finish + M), for a binding generation cap and for a binding test timeout', () => {
  // G binds: a Box 6 minutes older than the test.
  const g = c5Window({ boxStartedAtMs: T0 - 6 * MINUTE, testStartedAtMs: T0 });
  assert.equal(g.generationDeadline, T0 + 24 * MINUTE);
  assert.equal(g.testDeadline, T0 + 25 * MINUTE);
  assert.equal(g.nativeUseDeadline, T0 + 24 * MINUTE - 90_000 - 585_000);
  assert.equal(g.credentialDeadline, g.nativeUseDeadline + 225_000);
  // From the Box start, setup and all seven turns must end by T_box + 18.75 minutes.
  assert.equal(g.nativeUseDeadline - (T0 - 6 * MINUTE), 18.75 * MINUTE);
  // D binds: a Box started with the test (G - P = T0 + 28.5 min is later than D = T0 + 25 min).
  const d = c5Window({ boxStartedAtMs: T0, testStartedAtMs: T0 });
  assert.equal(d.nativeUseDeadline, T0 + 25 * MINUTE - 585_000);
  // The finally block and the runner postflight fit after E': settle, cleanup, finish and the margin end by min(G - P, D).
  for (const w of [g, d]) {
    assert.ok(w.nativeUseDeadline + C5_CREDENTIAL_SETTLE_MS + C5_CLEANUP_MS + C5_FINISH_MS + C5_MARGIN_MS <= Math.min(w.generationDeadline - C5_RUNNER_POSTFLIGHT_MS, w.testDeadline));
  }
  assert.throws(() => c5Window({ boxStartedAtMs: Number.NaN, testStartedAtMs: T0 }), failure('RUNTIME_PREREQ_FAILED', 'generation-window'));
});

test('the turn fence refuses at E\' - 204 999 ms and passes at E\' - 205 000 ms; the submit and first-turn fences are exact too', () => {
  const nativeUseDeadline = T0 + 10 * MINUTE;
  assertTurnFence({ now: nativeUseDeadline - 205_000, nativeUseDeadline });
  assert.throws(() => assertTurnFence({ now: nativeUseDeadline - 204_999, nativeUseDeadline }), failure('RUNTIME_PREREQ_FAILED', 'generation-window'));
  assertSubmitFence({ now: nativeUseDeadline - 160_000, nativeUseDeadline });
  assert.throws(() => assertSubmitFence({ now: nativeUseDeadline - 159_999, nativeUseDeadline }), failure('RUNTIME_PREREQ_FAILED', 'generation-window'));
  assertFirstTurnFits({ now: nativeUseDeadline - 220_000, nativeUseDeadline });
  assert.throws(() => assertFirstTurnFits({ now: nativeUseDeadline - 219_999, nativeUseDeadline }), failure('RUNTIME_PREREQ_FAILED', 'generation-window'));
});

// ---- the normal path ---------------------------------------------------------------------------------------------------------------

test('a realistic run passes: Box 6 min older than the test, inject at T_test + 5 min, seven short turns, then the G2 removal order', async (t) => {
  const c = setup(t, { boxAgeMs: 6 * MINUTE, runtime: fakeRuntime({ robots: [] }) });
  await c.lifecycle.begin({ workspaceRoot: c.workspaceRoot });
  await c.lifecycle.derive();
  c.lifecycle.mark(fixture(c));
  assert.equal(inflightPresent(c.paths, { route: 'owner', gate: 'c5' }), true);
  // The owned setup created the robot; the inventory shows it without a credential.
  c.runtime.robots.push({ id: ROBOT.robotId, name: NAMES.robotName });
  c.clock.now = T0 + 5 * MINUTE;
  await c.lifecycle.qualify(ROBOT, { cliDeadline: c.clock.now + 180_000 });
  await c.lifecycle.inject(ROBOT);
  await sevenTurns(c);
  assert.ok(c.clock.now <= c.lifecycle.window.nativeUseDeadline, 'the seven turns end inside the window');
  const markerBefore = [];
  const owned = fakeOwned(c.runtime);
  const original = owned.cleanup;
  owned.cleanup = async (options) => { await original({ ...options, onStep: (step) => { options.onStep(step); if (step === 'folders-removed') markerBefore.push(inflightPresent(c.paths, { route: 'owner', gate: 'c5' })); } }); };
  assert.deepEqual(await c.lifecycle.settle(ROBOT), { cliExited: true, credentialSettled: true });
  await c.lifecycle.cleanup(owned);
  const result = await c.lifecycle.finish();
  const order = ['readForCopyBack', 'remove', 'waitCliExit', 'remove-links', 'unregister', 'robot-delete', 'remove-folders'].map((name) => c.runtime.calls.indexOf(name));
  assert.ok(order.every((index, at) => index >= 0 && (at === 0 || index > order[at - 1])), `removal order ${order} in ${c.runtime.calls}`);
  assert.deepEqual(markerBefore, [true], 'the marker is still present when the folders are removed');
  assert.equal(inflightPresent(c.paths, { route: 'owner', gate: 'c5' }), false, 'removeInflight comes last');
  assert.deepEqual([result.code, result.exitCode, result.turns.completed], ['OK', 0, 7]);
  assert.deepEqual(Object.keys(result.cleanup), C5_CLEANUP_FLAGS);
  assert.ok(Object.values(result.cleanup).every((flag) => flag === true));
  assert.equal(result.runtimeCopy.state, 'unchanged');
  assert.equal(result.runtimeCopy.accessOnly, true);
  assert.equal(result.codexClient.qualification.status, 'qualified');
  assert.equal(fs.lstatSync(c.resultFile).mode & 0o777, 0o600);
  // The stage lines, in order.
  assert.deepEqual(c.logs.map((line) => line.replace('[codex-auth] c5 stage ', '')),
    ['begin', 'derived', 'marked', 'qualified', 'injected', 'turn-1', 'turn-2', 'turn-3', 'turn-4', 'turn-5', 'turn-6', 'turn-7', 'settled', 'cleaned']);
  // (g) result.json never carries a token, the account id or the refresh token.
  const text = fs.readFileSync(c.resultFile, 'utf8');
  const tokens = JSON.parse(ownerLogin(T0 + 240 * MINUTE)).tokens;
  for (const value of [ACCOUNT, tokens.refresh_token, 'fake-signature', ...Object.values(tokens)]) assert.equal(text.includes(value), false, 'no credential value in result.json');
  // The lock is released.
  assert.equal(fs.existsSync(c.paths.lockPath), false);
});

test('(b) an inject of unknown outcome is still copy-checked and removed', async (t) => {
  const c = setup(t, { runtime: fakeRuntime({ injectError: new RuntimeProgramError('TIMEOUT') }) });
  await assert.rejects(upToInject(c), failure('RUNTIME_PREREQ_FAILED', 'binding'));
  assert.equal(c.lifecycle.state.session.state.injected, true);
  await c.lifecycle.settle(ROBOT);
  assert.ok(c.runtime.calls.includes('readForCopyBack') && c.runtime.calls.includes('remove'));
});

test('(c) a failed removal means no robot-delete, the marker is kept and the result is CLEANUP_INCOMPLETE', async (t) => {
  const c = setup(t, { runtime: fakeRuntime({ removeError: new RuntimeProgramError('REMOVE_MISMATCH') }) });
  await upToInject(c);
  await sevenTurns(c);
  assert.deepEqual(await c.lifecycle.settle(ROBOT), { cliExited: false, credentialSettled: false });
  const result = await c.lifecycle.finish();
  assert.equal(c.runtime.calls.includes('robot-delete'), false);
  assert.equal(c.runtime.calls.includes('waitCliExit'), false);
  assert.deepEqual([result.code, result.reason], ['CLEANUP_INCOMPLETE', 'credential-not-removed']);
  assert.equal(inflightPresent(c.paths, { route: 'owner', gate: 'c5' }), true);
});

test('G2: a CLI that does not exit leaves the credential removed, no robot-delete and CLEANUP_INCOMPLETE robot-not-deleted', async (t) => {
  const c = setup(t, { runtime: fakeRuntime({ waitCliExitError: new RuntimeProgramError('TIMEOUT') }) });
  await upToInject(c);
  await sevenTurns(c);
  assert.deepEqual(await c.lifecycle.settle(ROBOT), { cliExited: false, credentialSettled: true });
  assert.ok(c.runtime.calls.indexOf('remove') < c.runtime.calls.indexOf('waitCliExit'), 'remove has already run');
  const result = await c.lifecycle.finish();
  assert.equal(c.runtime.calls.includes('robot-delete'), false);
  assert.deepEqual([result.code, result.reason], ['CLEANUP_INCOMPLETE', 'robot-not-deleted']);
  assert.equal(result.cleanup.credentialRemoved, true);
  assert.equal(inflightPresent(c.paths, { route: 'owner', gate: 'c5' }), true);
});

// ---- G3: the inject gate ------------------------------------------------------------------------------------------------------------

test('G3: an inject without a qualification of the same robot never calls runtime.inject', async (t) => {
  const c = setup(t);
  await c.lifecycle.begin({ workspaceRoot: c.workspaceRoot });
  await c.lifecycle.derive();
  c.lifecycle.mark(fixture(c));
  c.runtime.robots.push({ id: ROBOT.robotId, name: NAMES.robotName });
  await assert.rejects(c.lifecycle.inject(ROBOT), failure('USAGE', 'bad-variable'));
  await c.lifecycle.qualify(ROBOT, { cliDeadline: c.clock.now + 180_000 });
  await assert.rejects(c.lifecycle.inject({ robotId: 'copilot-live-other', robotName: NAMES.robotName }), failure('USAGE', 'bad-variable'));
  assert.equal(c.runtime.calls.includes('inject'), false);
});

test('G3: a generation change between qualify and inject is refused before any write', async (t) => {
  // Reads: qualify's poll, then the inject's re-read sees another generation.
  const c = setup(t, { runtime: fakeRuntime({ generations: [GENERATION, 'b'.repeat(64)] }) });
  await c.lifecycle.begin({ workspaceRoot: c.workspaceRoot });
  await c.lifecycle.derive();
  c.lifecycle.mark(fixture(c));
  c.runtime.robots.push({ id: ROBOT.robotId, name: NAMES.robotName });
  await c.lifecycle.qualify(ROBOT, { cliDeadline: c.clock.now + 180_000 });
  await assert.rejects(c.lifecycle.inject(ROBOT), failure('IDENTITY_MISMATCH', 'binding-changed'));
  assert.equal(c.runtime.calls.includes('inject'), false);
  assert.equal(c.lifecycle.state.session.state.injected, false);
});

test('G1: the pre-inject check refuses when the first turn no longer fits, before any write', async (t) => {
  const c = setup(t, { boxAgeMs: 6 * MINUTE });
  await c.lifecycle.begin({ workspaceRoot: c.workspaceRoot });
  await c.lifecycle.derive();
  c.lifecycle.mark(fixture(c));
  c.runtime.robots.push({ id: ROBOT.robotId, name: NAMES.robotName });
  await c.lifecycle.qualify(ROBOT, { cliDeadline: c.clock.now + 180_000 });
  c.clock.now = c.lifecycle.window.nativeUseDeadline - 219_999;
  await assert.rejects(c.lifecycle.inject(ROBOT), failure('RUNTIME_PREREQ_FAILED', 'generation-window'));
  assert.equal(c.runtime.calls.includes('inject'), false);
});

// ---- the per-turn checks ---------------------------------------------------------------------------------------------------------------

test('(e) a generation change before turn 3 gives IDENTITY_MISMATCH binding-changed and no submission', async (t) => {
  // qualify, inject's re-read, turn 1, turn 2, then turn 3 sees another generation.
  const c = setup(t, { runtime: fakeRuntime({ generations: [GENERATION, GENERATION, GENERATION, GENERATION, 'b'.repeat(64)] }) });
  await upToInject(c);
  let submitted = 0;
  for (let index = 0; index < 2; index += 1) { await c.lifecycle.beforeTurn(ROBOT, index); submitted += 1; }
  await assert.rejects(c.lifecycle.beforeTurn(ROBOT, 2), failure('IDENTITY_MISMATCH', 'binding-changed'));
  assert.equal(submitted, 2);
  assert.equal(c.logs.includes('[codex-auth] c5 stage turn-3'), false);
});

test('C9 offline: on an old Box the fence refuses turn 7 before it is submitted, and the credential still settles', async (t) => {
  // A Box 640 s older than the test gives E' = T0 + 485 s (1800 - 640 - 90 - 585). Turns start every 50 s: turn 6 starts at 250 s
  // (250 + 205 <= 485) and turn 7 at 300 s (300 + 205 > 485), so exactly turn 7 is refused before its submission.
  const c = setup(t, { boxAgeMs: 640_000 });
  assert.equal(c.lifecycle.window.nativeUseDeadline, T0 + 485_000);
  await upToInject(c);
  let completed = 0;
  let refused = null;
  for (let index = 0; index < 7 && !refused; index += 1) {
    try { await c.lifecycle.beforeTurn(ROBOT, index); } catch (error) { refused = { index, error }; break; }
    c.clock.now += 50_000;
    c.lifecycle.turnCompleted();
    completed += 1;
  }
  assert.ok(refused, 'a turn is refused');
  assert.ok(failure('RUNTIME_PREREQ_FAILED', 'generation-window')(refused.error));
  assert.deepEqual([refused.index, completed], [6, 6]);
  assert.equal(c.logs.includes('[codex-auth] c5 stage turn-7'), false);
  c.lifecycle.recordFailure(refused.error);
  await c.lifecycle.settle(ROBOT);
  await c.lifecycle.cleanup(fakeOwned(c.runtime));
  const result = await c.lifecycle.finish();
  assert.deepEqual([result.code, result.reason], ['RUNTIME_PREREQ_FAILED', 'generation-window']);
  assert.ok(Object.values(result.cleanup).every(Boolean));
  assert.equal(result.turns.completed, completed);
});

test('G10: a failed or timed-out native completion is NATIVE_TURN_FAILED with authRejectionSuspected from the sanitized text', () => {
  const rejected = classifyLiveSkillsTurnFailure('unexpected status 401 Unauthorized', { timedOut: false });
  assert.ok(failure('NATIVE_TURN_FAILED', 'failed')(rejected));
  assert.equal(rejected.authRejectionSuspected, true);
  const slow = classifyLiveSkillsTurnFailure('still thinking', { timedOut: true });
  assert.ok(failure('NATIVE_TURN_FAILED', 'timeout')(slow));
  assert.equal(slow.authRejectionSuspected, false);
});

test('G10: a recorded native failure reaches result.json with its reason and authRejectionSuspected', async (t) => {
  const c = setup(t);
  await upToInject(c);
  c.lifecycle.recordFailure(classifyLiveSkillsTurnFailure('Please log in again', { timedOut: false }));
  await c.lifecycle.settle(ROBOT);
  await c.lifecycle.cleanup(fakeOwned(c.runtime));
  const result = await c.lifecycle.finish();
  assert.deepEqual([result.code, result.reason, result.authRejectionSuspected], ['NATIVE_TURN_FAILED', 'failed', true]);
});

// ---- G11: cleanup flags -------------------------------------------------------------------------------------------------------------

test('G11: OK is written only with every cleanup flag true; otherwise the first false flag decides the reason', async (t) => {
  for (const [failAt, reason] of [['remove-links', 'links-not-removed'], ['unregister', 'source-not-unregistered'], ['robot-delete', 'robot-not-deleted'], ['remove-folders', 'folder-not-deleted']]) {
    const c = setup(t);
    await upToInject(c);
    await sevenTurns(c);
    await c.lifecycle.settle(ROBOT);
    await c.lifecycle.cleanup(fakeOwned(c.runtime, { failAt }));
    const result = await c.lifecycle.finish();
    assert.deepEqual([result.code, result.reason], ['CLEANUP_INCOMPLETE', reason], failAt);
    assert.equal(inflightPresent(c.paths, { route: 'owner', gate: 'c5' }), true, 'the marker is kept');
  }
  assert.equal(firstCleanupGap(Object.fromEntries(C5_CLEANUP_FLAGS.map((flag) => [flag, true]))), null);
  assert.equal(firstCleanupGap({ credentialPersisted: true, credentialRemoved: true, linksRemoved: true, sourceUnregistered: true, robotDeleted: true }), 'folder-not-deleted');
});

test('G11: a run whose cleanup was skipped is never OK even without an explicit failure', async (t) => {
  const c = setup(t);
  await upToInject(c);
  await sevenTurns(c);
  await c.lifecycle.settle(ROBOT);
  const result = await c.lifecycle.finish();
  assert.deepEqual([result.code, result.reason], ['CLEANUP_INCOMPLETE', 'links-not-removed']);
});

// ---- gates before the marker ---------------------------------------------------------------------------------------------------------

test('G12: the worker derive gate refuses a near-expiry owner login before the marker, so nothing exists to clean', async (t) => {
  // On a fresh Box the worker needs exp >= E' + C + skew = T0 + 15.25 + 3.75 + 5 = T0 + 24 min. A login valid until T0 + 23 min passed
  // the parent's 33.75-minute pre-spawn gate if the parent checked it more than 9.75 minutes earlier (here: at T0 - 11 min).
  const exp = T0 + 23 * MINUTE;
  assert.ok(exp - (T0 - 11 * MINUTE) >= C5_PARENT_REMAINING_MS + ACCESS_SKEW_MS, 'the parent gate passes');
  const c = setup(t, { boxAgeMs: 0, exp });
  assert.equal(c.lifecycle.window.credentialDeadline + ACCESS_SKEW_MS, T0 + 24 * MINUTE);
  await c.lifecycle.begin({ workspaceRoot: c.workspaceRoot });
  await assert.rejects(c.lifecycle.derive(), failure('STREAM_UNSAFE', 'access-near-expiry'));
  c.lifecycle.recordFailure(new CodexAuthError('STREAM_UNSAFE', 'access-near-expiry'));
  const result = await c.lifecycle.finish();
  assert.deepEqual([result.code, result.reason], ['STREAM_UNSAFE', 'access-near-expiry']);
  assert.equal(inflightPresent(c.paths, { route: 'owner', gate: 'c5' }), false);
  assert.ok(Object.values(result.cleanup).every(Boolean));
  assert.equal(result.owner.gateAtDerive.result, 'refused');
});

test('a C2 marker makes the C5 begin refuse with inflight-other-gate; a held lock gives LOCK_HELD before the Box is touched', async (t) => {
  const c = setup(t);
  fs.mkdirSync(c.paths.root, { recursive: true, mode: 0o700 });
  createInflight(c.paths, { runId: 'c2-run', robotName: 'codex-auth-test-c2-run', folder: 'codex-auth-c2-run', route: 'owner' });
  await assert.rejects(c.lifecycle.begin({ workspaceRoot: c.workspaceRoot }), failure('STREAM_UNSAFE', 'inflight-other-gate'));
  await c.lifecycle.finish();
  fs.rmSync(c.paths.ownerInflightPath);
  const first = c.create();
  await first.begin({ workspaceRoot: c.workspaceRoot });
  const before = c.runtime.calls.length;
  const second = c.create();
  await assert.rejects(second.begin({ workspaceRoot: c.workspaceRoot }), failure('LOCK_HELD', 'live-owner'));
  assert.equal(c.runtime.calls.length, before, 'the second run never touched the Box');
  await first.finish();
});

// ---- G4: recovery, in a fresh process per crash point ---------------------------------------------------------------------------------

function crashedAt(t, { robot = null, authPresent = false, discardResult } = {}) {
  const runtime = fakeRuntime({ robots: robot ? [{ id: ROBOT.robotId, name: NAMES.robotName }] : [], authPresent, discardResult });
  const c = setup(t, { runtime, readOwner: async () => assert.fail('recovery never reads the owner login') });
  fs.mkdirSync(c.paths.root, { recursive: true, mode: 0o700 });
  createInflight(c.paths, { route: 'owner', gate: 'c5', runId: RUN_ID, ...NAMES });
  return c;
}

const ownedFor = (c, options) => (recovered) => {
  assert.equal(recovered.robotName, NAMES.robotName);
  return fakeOwned(c.runtime, options);
};

for (const [point, robot, authPresent, discardResult] of [
  ['after prepare', false, false, undefined],
  ['after robot create', true, false, { removed: false, accessOnly: null }],
  ['after register', true, false, { removed: false, accessOnly: null }],
  ['mid-turn after inject', true, true, { removed: true, accessOnly: true }],
  ['after robot-delete', false, false, undefined],
]) {
  test(`G4: a run that crashed ${point} is recovered by a fresh process from the marker and observed state only`, async (t) => {
    const c = crashedAt(t, { robot, authPresent, discardResult });
    const lifecycle = c.create();
    assert.deepEqual(await lifecycle.begin({ workspaceRoot: c.workspaceRoot }), { recoveryPending: true });
    // The exec-chain half ran before any browser step: discard (whatever the CLI does), then the CLI exit, only for a present robot.
    assert.equal(c.runtime.calls.includes('discard'), robot);
    assert.equal(c.runtime.calls.includes('waitCliExit'), robot);
    if (robot) assert.ok(c.runtime.calls.indexOf('discard') < c.runtime.calls.indexOf('waitCliExit'));
    assert.equal(c.runtime.calls.includes('recover'), false, 'the browser half waits for the authenticated page');
    await lifecycle.recover({ create: createLiveSkillsFixture, ownedFor: ownedFor(c) });
    assert.ok(c.runtime.calls.indexOf('recover') > c.runtime.calls.lastIndexOf('waitCliExit'));
    assert.equal(c.runtime.calls.includes('remove-links'), false, 'recovery never removes links one by one');
    assert.equal(readInflight(c.paths, { route: 'owner', gate: 'c5' }), null);
    assert.equal(lifecycle.result.recovered, true);
    // (f): recovery never reads the owner login (the reader of this case fails the test if it is called).
    assert.ok(c.logs.indexOf('[codex-auth] c5 stage recovered') > c.logs.indexOf('[codex-auth] c5 stage begin'));
    await lifecycle.finish();
    if (authPresent) assert.deepEqual(readResult(c).recoveredCopy, { removed: true, accessOnly: true });
  });
}

test('G13: after a recovery the same run reads the owner login, so the stages are begin, recovered, derived, and nothing is read before', async (t) => {
  const runtime = fakeRuntime({ robots: [{ id: ROBOT.robotId, name: NAMES.robotName }], authPresent: true, discardResult: { removed: true, accessOnly: true } });
  const c = setup(t, { runtime });
  fs.mkdirSync(c.paths.root, { recursive: true, mode: 0o700 });
  createInflight(c.paths, { route: 'owner', gate: 'c5', runId: RUN_ID, ...NAMES });
  const lifecycle = c.create();
  await lifecycle.begin({ workspaceRoot: c.workspaceRoot });
  await lifecycle.recover({ create: createLiveSkillsFixture, ownedFor: ownedFor(c) });
  assert.deepEqual(c.ownerReads, [], 'no owner read before the recovery completed');
  runtime.robots.length = 0;
  await lifecycle.derive();
  assert.equal(c.ownerReads.length, 1);
  const stages = c.logs.map((line) => line.replace('[codex-auth] c5 stage ', ''));
  assert.deepEqual(stages.slice(0, 3), ['begin', 'recovered', 'derived']);
  await lifecycle.finish();
});

test('G4: a copy that was not access-only is refused only after the robot and folders are gone', async (t) => {
  const c = crashedAt(t, { robot: true, authPresent: true, discardResult: { removed: true, accessOnly: false } });
  const lifecycle = c.create();
  await lifecycle.begin({ workspaceRoot: c.workspaceRoot });
  await assert.rejects(lifecycle.recover({ create: createLiveSkillsFixture, ownedFor: ownedFor(c) }), failure('COPYBACK_REFUSED', 'runtime-copy-changed'));
  assert.ok(c.runtime.calls.includes('recover'));
  assert.equal(readInflight(c.paths, { route: 'owner', gate: 'c5' }), null);
});

test('G4: a root without its ownership marker leaves the recovery incomplete and the marker in place (operator only)', async (t) => {
  const c = crashedAt(t);
  const lifecycle = c.create();
  await lifecycle.begin({ workspaceRoot: c.workspaceRoot });
  await assert.rejects(lifecycle.recover({ create: createLiveSkillsFixture, ownedFor: ownedFor(c, { recoverError: new Error('Fixture ownership marker differs.') }) }),
    failure('CLEANUP_INCOMPLETE', 'recovery-incomplete'));
  await assert.rejects(lifecycle.derive(), failure('CLEANUP_INCOMPLETE', 'recovery-incomplete'));
  const result = await lifecycle.finish();
  assert.deepEqual([result.code, result.reason], ['CLEANUP_INCOMPLETE', 'recovery-incomplete']);
  assert.notEqual(readInflight(c.paths, { route: 'owner', gate: 'c5' }), null);
});

test('G4: a stray copilot-live robot that the marker does not name is refused before any recovery step', async (t) => {
  const runtime = fakeRuntime({ robots: [{ id: 'stray-robot-0001', name: 'copilot-live-11111111-2222-4333-8444-555555555555' }] });
  const c = setup(t, { runtime });
  await assert.rejects(c.lifecycle.begin({ workspaceRoot: c.workspaceRoot }), failure('RUNTIME_PREREQ_FAILED', 'unowned-leftover-robot'));
  assert.equal(runtime.calls.includes('discard'), false);
});

test('the marker fixture and the recovery plan are derived from the run id and the inventory only', () => {
  const marker = { gate: 'c5', runId: RUN_ID, ...NAMES };
  const rebuilt = fixtureFromMarker(marker, '/work/box', { create: createLiveSkillsFixture });
  assert.deepEqual([rebuilt.robotName, rebuilt.folder, rebuilt.repositoryName, rebuilt.robotId], [NAMES.robotName, NAMES.folder, NAMES.repositoryName, null]);
  assert.deepEqual(planC5Recovery({ marker: null, robots: [] }), { pending: false, robot: null, discard: false, waitCliExit: false });
  assert.deepEqual(planC5Recovery({ marker, robots: [{ id: ROBOT.robotId, name: NAMES.robotName, codexAuthPresent: false }] }),
    { pending: true, robot: ROBOT, discard: true, waitCliExit: true });
  assert.throws(() => fixtureFromMarker({ ...marker, gate: 'c2' }, '/work/box', { create: createLiveSkillsFixture }), failure('USAGE', 'bad-variable'));
});
