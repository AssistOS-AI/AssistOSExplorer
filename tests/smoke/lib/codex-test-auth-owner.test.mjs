import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  CodexAuthError, EXIT_CODES, EXIT_REASONS, RUN_TIMEOUT_MS, assertArtifactDirectory, assertNoOtherRouteInflight, assertPrivateRoot, adoptQuarantine,
  createInflight, decideRunOutcome, ensurePrivateRoot, inflightPresent, lockStatus, readInflight, removeInflight, resolveAuthPaths, resultLine,
  loadStream, retireStream, scanLeaks, seedStream, sha256Hex,
} from './codex-test-auth.mjs';
import {
  ACCESS_SKEW_MS, CREDENTIAL_SOURCES, DERIVED_SHAPE_ID, STREAM_ONLY_COMMANDS, assertAccessValidity, assertOwnerScanCoverage, createOwnerCredentialSession,
  deriveAccessOnlyAuth, deriveAccessOnlyBytes, extractOwnerCredential, isAccessOnly, newTokenValues, ownerDirectoryFor, ownerScanReferences,
  parseAccessTokenClaims, planOwnerRun, readOwnerAuth, requiredValidityMs, resolveCredentialSource, resolveOwnerAuthPath, summarizeOwner,
} from './codex-test-auth-owner.mjs';

// Route A tests. Every credential here is fabricated. The file refuses to start under the account's own home and blocks
// every access to the account's real Codex directory, so a defect can never reach a real login (decision L).
const REAL_HOME = os.userInfo().homedir;
const realOf = (value) => { try { return fs.realpathSync(value); } catch { return path.resolve(value); } };
if (!process.env.HOME || path.resolve(process.env.HOME) === path.resolve(REAL_HOME) || realOf(process.env.HOME) === realOf(REAL_HOME)) {
  throw new Error('Refusing to start: run with HOME set to a temporary directory.');
}

// The blocking guard. It is self-contained, so its source text is also loaded into every child Node process that a test spawns
// (decision L): `onBlocked` is told the name of the guarded function, and the guard then throws. Both spellings of the guarded root
// are computed before any wrapper is installed.
function installRealHomeGuard({ fs, os, path, fileURLToPath, onBlocked }) {
  const realOf = (value) => { try { return fs.realpathSync(value); } catch { return path.resolve(value); } };
  const home = os.userInfo().homedir;
  const roots = [path.join(home, '.codex'), path.join(realOf(home), '.codex')];
  const guardedPath = (argument) => {
    let raw = null;
    if (typeof argument === 'string') raw = argument;
    else if (Buffer.isBuffer(argument)) raw = argument.toString('utf8');
    else if (argument instanceof URL) { try { raw = fileURLToPath(argument); } catch { raw = null; } }
    if (raw === null || raw === '' || raw.includes('\0')) return false;
    const resolved = path.resolve(raw);
    return roots.some((root) => resolved === root || resolved.startsWith(`${root}${path.sep}`));
  };
  const install = (target, names, promise) => {
    for (const name of names) {
      const original = target[name];
      if (typeof original !== 'function') continue;
      target[name] = Object.assign(function guarded(...args) {
        if (args.some(guardedPath)) {
          onBlocked(name);
          const error = new Error('blocked access to the real account .codex');
          if (promise) return Promise.reject(error);
          throw error;
        }
        return original.apply(this, args);
      }, original);
    }
  };
  install(fs, ['openSync', 'readFileSync', 'readdirSync', 'lstatSync', 'statSync', 'existsSync', 'accessSync', 'realpathSync', 'opendirSync',
    'readlinkSync', 'createReadStream', 'copyFileSync', 'linkSync', 'renameSync', 'unlinkSync', 'rmSync', 'writeFileSync', 'mkdirSync', 'chmodSync',
    'open', 'readFile', 'stat', 'lstat', 'realpath', 'access', 'readdir'], false);
  install(fs.realpathSync, ['native'], false);
  install(fs.promises, ['open', 'readFile', 'readdir', 'lstat', 'stat', 'access', 'realpath', 'readlink'], true);
}

const blockedAccess = [];
installRealHomeGuard({ fs, os, path, fileURLToPath, onBlocked: (name) => { blockedAccess.push(name); } });

// The same guard, as a module that every spawned child process loads first. A guarded access prints the marker to stderr and exits 97.
const GUARD_MARKER = 'BLOCKED-REAL-CODEX-ACCESS';
const CHILD_GUARD_SOURCE = `import fs from 'node:fs';\nimport os from 'node:os';\nimport path from 'node:path';\nimport { fileURLToPath } from 'node:url';\n`
  + `(${installRealHomeGuard.toString()})({ fs, os, path, fileURLToPath, onBlocked: () => { fs.writeSync(2, '${GUARD_MARKER}\\n'); process.exit(97); } });\n`;
const CHILD_NODE_OPTIONS = `--import=data:text/javascript,${encodeURIComponent(CHILD_GUARD_SOURCE)}`;

const NOW = Date.parse('2026-10-03T12:00:00.000Z');
const HOUR = 3_600_000;
const b64 = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');

function streamLogin({ seed = 'a' } = {}) {
  const token = (kind) => `${b64({ alg: 'none', typ: 'JWT' })}.${b64({ exp: Math.floor((NOW + 240 * HOUR) / 1000), sub: `${kind}-${seed}` })}.c2ln`;
  return Buffer.from(JSON.stringify({
    auth_mode: 'chatgpt', OPENAI_API_KEY: null,
    tokens: { id_token: token('id'), access_token: token('access'), refresh_token: `rt-fake-${seed}-0123456789abcdef`, account_id: 'acct-fake-0001' },
    last_refresh: new Date(NOW - HOUR).toISOString(),
  }));
}

const failure = (code, reason) => (error) => error instanceof CodexAuthError && error.code === code && error.reason === reason
  && error.exitCode === EXIT_CODES[code];

function sandbox(t) {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cta-own-')));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  return base;
}

// A fake HOME with a private ROOT inside the sandbox. `stream` seeds a route-B stream; `root` false leaves ROOT absent.
function setup(t, { stream = null, root: createRoot = true, envExtra = {} } = {}) {
  const base = sandbox(t);
  const home = path.join(base, 'home');
  fs.mkdirSync(home, { mode: 0o700 });
  const root = path.join(base, 'state', 'assistos-codex-test-auth');
  const paths = resolveAuthPaths({ HOME: home, CODEX_TEST_AUTH_ROOT: root, ...envExtra });
  if (createRoot || stream) fs.mkdirSync(root, { mode: 0o700, recursive: true });
  if (stream) {
    for (const directory of [paths.streamsDir, paths.streamDir]) fs.mkdirSync(directory, { mode: 0o700, recursive: true });
    fs.writeFileSync(paths.streamFile, stream, { mode: 0o600 });
  }
  return { base, home, root, paths };
}

const MARKER = Object.freeze({ runId: 'run-1', robotName: 'codex-auth-test-run-1', folder: 'codex-auth-run-1' });

// ---- route A fixtures -----------------------------------------------------------------------------------------------
// Unsigned JWT-shaped tokens with a non-empty signature segment and the account claim Codex reads. Nothing here is a real credential.
const CLAIM_KEY = 'https://api.openai.com/auth';
const MINUTE = 60_000;
const ROBOT = Object.freeze({ robotId: 'codex-auth-test-r1-ab12', robotName: 'codex-auth-test-r1' });

function accessToken(seed, { expMs = NOW + 240 * HOUR, account = 'acct-fake-0001', claim } = {}) {
  const payload = { exp: Math.floor(expMs / 1000), sub: seed };
  const claimed = claim === undefined ? account : claim;
  if (claimed !== null) payload[CLAIM_KEY] = { chatgpt_account_id: claimed };
  return `${b64({ alg: 'none', typ: 'JWT' })}.${b64(payload)}.c2lnbmF0dXJl`;
}

// A fabricated managed login. `claim: null` leaves the account claim out.
function ownerLogin({ seed = 'own', account = 'acct-fake-0001', claim, expMs, refreshed = NOW - HOUR, lastRefresh, tokens = {}, extra = {} } = {}) {
  return Buffer.from(JSON.stringify({
    auth_mode: 'chatgpt', OPENAI_API_KEY: null,
    tokens: { id_token: accessToken(`id-${seed}`, { expMs, account, claim }), access_token: accessToken(`access-${seed}`, { expMs, account, claim }),
      refresh_token: `rt-fake-${seed}-0123456789abcdef`, account_id: account, ...tokens },
    last_refresh: lastRefresh ?? new Date(refreshed).toISOString(), ...extra,
  }));
}

const parsed = (bytes) => JSON.parse(Buffer.from(bytes).toString('utf8'));
const edited = (bytes, change) => { const value = parsed(bytes); change(value); return Buffer.from(JSON.stringify(value)); };
const noSleep = async () => {};

// A fake HOME holding ~/.codex/auth.json (when `bytes` is given) inside the sandbox.
function ownerHome(t, bytes = null, { mode = 0o600 } = {}) {
  const base = sandbox(t);
  const home = path.join(base, 'home');
  const dir = path.join(home, '.codex');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, 'auth.json');
  if (bytes) { fs.writeFileSync(file, bytes); fs.chmodSync(file, mode); }
  return { base, home, dir, file };
}

// Records every call of the named fs functions. The recorder wraps whatever is installed now and is restored after the test.
function spyFs(t, names) {
  const calls = [];
  for (const name of names) {
    const original = fs[name];
    if (typeof original !== 'function') continue;
    fs[name] = Object.assign(function spied(...args) { calls.push({ name, args }); return original.apply(this, args); }, original);
    t.after(() => { fs[name] = original; });
  }
  return calls;
}

const WRITE_FUNCTIONS = ['writeFileSync', 'appendFileSync', 'mkdirSync', 'chmodSync', 'renameSync', 'unlinkSync', 'rmSync', 'copyFileSync', 'linkSync',
  'symlinkSync', 'truncateSync', 'utimesSync', 'rmdirSync'];

function fakeRuntime({ copy = null, readError = null, removeError = null, discard = null, injectError = null } = {}) {
  const calls = [];
  return {
    calls,
    async inject(robot, bytes) { calls.push(['inject', robot, Buffer.from(bytes)]); if (injectError) throw injectError; },
    async readForCopyBack(robot, options) {
      calls.push(['readForCopyBack', robot, options]);
      if (readError) throw readError;
      return { bytes: Buffer.from(typeof copy === 'function' ? copy() : copy) };
    },
    async remove(robot, sha) { calls.push(['remove', robot, sha]); if (removeError) throw removeError; return { ok: true, removed: true }; },
    async discard(robot, options) { calls.push(['discard', robot, options]); return typeof discard === 'function' ? discard() : discard; },
  };
}

function ownerSession(runtime, ownerBytes, { clock = { now: NOW }, deadline = NOW + RUN_TIMEOUT_MS, injectWindowMs = 175_000, readOwner } = {}) {
  const session = createOwnerCredentialSession({ runtime, runDeadline: deadline, injectWindowMs, now: () => clock.now, uid: process.getuid(),
    readOwner: readOwner ?? (async () => ({ bytes: Buffer.from(ownerBytes) })) });
  session.holdLock(true);
  return session;
}

const FILE = '/virtual/owner/auth.json';
const CLI = fileURLToPath(new URL('../scripts/codex-test-auth.mjs', import.meta.url));
const SMOKE_DIR = path.dirname(path.dirname(CLI));

const codeError = (code) => Object.assign(new Error(code), { code });

test('the route-A marker lives in inflight-owner.json, needs no stream, and each route refuses the other route\'s marker', async (t) => {
  const { paths, root } = setup(t);
  assert.equal(paths.ownerInflightPath, path.join(root, 'inflight-owner.json'));
  const flags = [];
  const original = fs.openSync;
  fs.openSync = Object.assign((file, flag, ...rest) => { if (file === paths.ownerInflightPath) flags.push(flag); return original(file, flag, ...rest); }, original);
  t.after(() => { fs.openSync = original; });
  // No stream exists, and the owner marker needs none.
  assert.deepEqual(createInflight(paths, { ...MARKER, route: 'owner' }), MARKER);
  fs.openSync = original;
  assert.equal(flags.length, 1);
  assert.ok(flags[0] & fs.constants.O_EXCL && flags[0] & fs.constants.O_CREAT && flags[0] & fs.constants.O_NOFOLLOW);
  assert.equal(fs.statSync(paths.ownerInflightPath).mode & 0o777, 0o600);
  assert.deepEqual(JSON.parse(fs.readFileSync(paths.ownerInflightPath, 'utf8')), MARKER);
  assert.equal(fs.existsSync(paths.inflightPath), false, 'route A never writes inflight.json');
  assert.throws(() => createInflight(paths, { ...MARKER, runId: 'run-2', route: 'owner' }), failure('STREAM_UNSAFE', 'inflight-present'));
  assert.throws(() => createInflight(paths, { ...MARKER, robotName: 'default', route: 'owner' }), failure('USAGE', 'bad-variable'));
  assert.throws(() => createInflight(paths, { ...MARKER, route: 'both' }), failure('USAGE', 'bad-variable'));
  // Each route reads only its own file.
  assert.deepEqual(readInflight(paths, { route: 'owner' }), MARKER);
  assert.equal(readInflight(paths), null);
  assert.equal(inflightPresent(paths, { route: 'owner' }), true);
  assert.equal(inflightPresent(paths), false);
  assert.throws(() => readInflight(paths, { route: 'both' }), failure('USAGE', 'bad-variable'));
  assert.doesNotThrow(() => assertPrivateRoot(paths));
  // The other route's marker is refused in both directions, before any recovery.
  assert.throws(() => assertNoOtherRouteInflight(paths, 'stream'), failure('STREAM_UNSAFE', 'inflight-other-route'));
  assert.doesNotThrow(() => assertNoOtherRouteInflight(paths, 'owner'));
  assert.throws(() => assertNoOtherRouteInflight(paths, 'both'), failure('USAGE', 'bad-variable'));
  // A tampered or loosened marker is refused rather than followed.
  fs.chmodSync(paths.ownerInflightPath, 0o644);
  assert.throws(() => assertPrivateRoot(paths), failure('STREAM_UNSAFE', 'owner-or-mode'));
  fs.chmodSync(paths.ownerInflightPath, 0o600);
  fs.writeFileSync(paths.ownerInflightPath, JSON.stringify({ ...MARKER, robotName: 'default' }), { mode: 0o600 });
  assert.throws(() => readInflight(paths, { route: 'owner' }), failure('STREAM_UNSAFE', 'inflight-present'));
  fs.writeFileSync(paths.ownerInflightPath, JSON.stringify(MARKER), { mode: 0o600 });
  // seed, retire and adopt refuse while the owner marker exists.
  const waiting = async () => { throw new Error('the operator step must not be reached'); };
  await assert.rejects(seedStream(paths, { seedBin: '/opt/fake/bin/codex', waitForOperator: waiting, now: NOW }), failure('STREAM_UNSAFE', 'inflight-present'));
  const withStream = setup(t, { stream: streamLogin() });
  createInflight(withStream.paths, { ...MARKER, route: 'owner' });
  assert.throws(() => retireStream(withStream.paths), failure('STREAM_UNSAFE', 'inflight-present'));
  assert.throws(() => adoptQuarantine(withStream.paths, { runId: 'run-9' }), failure('STREAM_UNSAFE', 'inflight-present'));
  assert.equal(fs.existsSync(withStream.paths.streamFile), true);
  // The route-B marker is unchanged by route A: it needs a stream, lives in inflight.json and is refused by route A.
  removeInflight(withStream.paths, { route: 'owner' });
  removeInflight(withStream.paths, { route: 'owner' });
  assert.equal(inflightPresent(withStream.paths, { route: 'owner' }), false);
  assert.deepEqual(createInflight(withStream.paths, MARKER), MARKER);
  assert.equal(inflightPresent(withStream.paths), true);
  assert.deepEqual(readInflight(withStream.paths), MARKER);
  assert.throws(() => assertNoOtherRouteInflight(withStream.paths, 'owner'), failure('STREAM_UNSAFE', 'inflight-other-route'));
  assert.doesNotThrow(() => assertNoOtherRouteInflight(withStream.paths, 'stream'));
  removeInflight(withStream.paths);
  assert.equal(inflightPresent(withStream.paths), false);
  assert.throws(() => removeInflight(withStream.paths, { route: 'both' }), failure('USAGE', 'bad-variable'));
});

test('ensurePrivateRoot creates only ROOT with mode 0700, refuses a ROOT or artifact directory that overlaps the owner directory, and preflight-side checks never create it', (t) => {
  const base = sandbox(t);
  const home = path.join(base, 'home');
  const ownerDir = path.join(home, '.codex');
  fs.mkdirSync(ownerDir, { recursive: true, mode: 0o700 });
  const root = path.join(base, 'state', 'assistos-codex-test-auth');
  const paths = resolveAuthPaths({ HOME: home, CODEX_TEST_AUTH_ROOT: root });
  // The preflight-side checks create nothing, not even a parent of ROOT.
  assert.deepEqual(assertPrivateRoot(paths, { forbiddenRoots: [ownerDir] }), { root, exists: false });
  assert.equal(lockStatus(paths).state, 'free');
  assert.equal(inflightPresent(paths, { route: 'owner' }), false);
  assert.equal(inflightPresent(paths), false);
  assert.equal(fs.existsSync(path.join(base, 'state')), false);
  // ensurePrivateRoot creates exactly ROOT, 0700 and empty.
  assert.deepEqual(ensurePrivateRoot(paths, { forbiddenRoots: [ownerDir] }), { root, created: true });
  assert.equal(fs.statSync(root).mode & 0o777, 0o700);
  assert.deepEqual(fs.readdirSync(root), []);
  assert.deepEqual(ensurePrivateRoot(paths, { forbiddenRoots: [ownerDir] }), { root, created: false });
  assert.deepEqual(fs.readdirSync(root), []);
  // A ROOT inside a git work tree is refused and never created.
  const tree = path.join(base, 'tree');
  fs.mkdirSync(path.join(tree, '.git'), { recursive: true });
  const inTree = resolveAuthPaths({ HOME: home, CODEX_TEST_AUTH_ROOT: path.join(tree, 'deep', 'root') });
  assert.throws(() => ensurePrivateRoot(inTree), failure('STREAM_UNSAFE', 'location'));
  assert.equal(fs.existsSync(path.join(tree, 'deep')), false);
  // A ROOT inside the owner directory, and a ROOT that contains it, are refused and never created.
  const insideOwner = resolveAuthPaths({ HOME: home, CODEX_TEST_AUTH_ROOT: path.join(ownerDir, 'state', 'root') });
  assert.throws(() => ensurePrivateRoot(insideOwner, { forbiddenRoots: [ownerDir] }), failure('STREAM_UNSAFE', 'location'));
  assert.equal(fs.existsSync(path.join(ownerDir, 'state')), false);
  const aroundOwner = resolveAuthPaths({ HOME: home, CODEX_TEST_AUTH_ROOT: path.join(base, 'home') });
  assert.throws(() => ensurePrivateRoot(aroundOwner, { forbiddenRoots: [ownerDir] }), failure('STREAM_UNSAFE', 'location'));
  // Positive control: without the owner directory as a forbidden root, the same ROOT would be accepted, so the wiring is what refuses it.
  assert.doesNotThrow(() => assertPrivateRoot(insideOwner, { forbiddenRoots: [] }));
  // An artifact directory inside the owner directory, or around it, gives artifact-dir-location.
  const artifactsInside = path.join(ownerDir, 'artifacts');
  fs.mkdirSync(artifactsInside);
  assert.throws(() => assertArtifactDirectory(artifactsInside, { paths, forbiddenRoots: [ownerDir] }), failure('USAGE', 'artifact-dir-location'));
  assert.throws(() => assertArtifactDirectory(home, { paths, forbiddenRoots: [ownerDir] }), failure('USAGE', 'artifact-dir-location'));
  assert.equal(assertArtifactDirectory(artifactsInside, { paths, forbiddenRoots: [] }), artifactsInside);
  const elsewhere = path.join(base, 'artifacts');
  fs.mkdirSync(elsewhere);
  assert.equal(assertArtifactDirectory(elsewhere, { paths, forbiddenRoots: [ownerDir] }), elsewhere);
});

test('decideRunOutcome keeps the precedence 27, then scan-reference-missing, then 26, then the first failure, for both routes', () => {
  const complete = { credentialPersisted: true, credentialRemoved: true, robotDeleted: true, folderDeleted: true };
  const incomplete = { ...complete, robotDeleted: false };
  const leak = [{ file: 'a.log', field: 'accessToken' }];
  const rows = [
    // [name, input, expected code, expected reason, expected result, expected cleanup]
    ['a leak wins over everything', { leaks: leak, coverageFailure: true, result: { code: 'CLEANUP_INCOMPLETE', reason: 'credential-not-removed', cleanup: incomplete }, exitedCode: 1 },
      'LEAK_DETECTED', 'artifact-contains-token', 'failed', 'incomplete'],
    ['a coverage failure wins over a clean result', { leaks: [], coverageFailure: true, result: { code: 'OK', cleanup: complete }, exitedCode: 0 },
      'STREAM_UNSAFE', 'scan-reference-missing', 'failed', 'complete'],
    ['a coverage failure wins over incomplete cleanup (26)', { leaks: [], coverageFailure: true, result: { code: 'CLEANUP_INCOMPLETE', reason: 'robot-not-deleted', cleanup: incomplete }, exitedCode: 1 },
      'STREAM_UNSAFE', 'scan-reference-missing', 'failed', 'incomplete'],
    ['a coverage failure wins over a missing result file', { leaks: [], coverageFailure: true, result: null, exitedCode: 1 },
      'STREAM_UNSAFE', 'scan-reference-missing', 'failed', 'incomplete'],
    ['no result file', { leaks: [], result: null, exitedCode: 1 }, 'INTERNAL', 'no-result-file', 'failed', 'incomplete'],
    ['the worker reports 26', { leaks: [], result: { code: 'CLEANUP_INCOMPLETE', reason: 'credential-not-removed', cleanup: complete }, exitedCode: 1 },
      'CLEANUP_INCOMPLETE', 'credential-not-removed', 'failed', 'complete'],
    ['a failure with incomplete cleanup becomes 26 recovery-incomplete', { leaks: [], result: { code: 'NATIVE_TURN_FAILED', reason: 'failed', cleanup: incomplete }, exitedCode: 1 },
      'CLEANUP_INCOMPLETE', 'recovery-incomplete', 'failed', 'incomplete'],
    ['the first failure with complete cleanup', { leaks: [], result: { code: 'NATIVE_TURN_FAILED', reason: 'timeout', cleanup: complete }, exitedCode: 1 },
      'NATIVE_TURN_FAILED', 'timeout', 'failed', 'complete'],
    ['a worker failure without a reason', { leaks: [], result: { code: 'IDENTITY_MISMATCH', cleanup: complete }, exitedCode: 1 },
      'IDENTITY_MISMATCH', null, 'failed', 'complete'],
    ['a clean result with a failing Playwright exit', { leaks: [], result: { code: 'OK', cleanup: complete }, exitedCode: 1 },
      'INTERNAL', 'exception', 'failed', 'complete'],
    ['a pass', { leaks: [], result: { code: 'OK', cleanup: complete }, exitedCode: 0 }, 'OK', null, 'passed', 'complete'],
    // Route A recovery with an unusable owner login: the worker's owner reason is the exit code, 10.
    ['route A recovery with the owner login missing', { leaks: [], coverageFailure: false, result: { code: 'NOT_SEEDED', reason: 'owner-login-missing', cleanup: complete }, exitedCode: 1 },
      'NOT_SEEDED', 'owner-login-missing', 'failed', 'complete'],
  ];
  for (const [name, input, code, reason, result, cleanup] of rows) {
    const outcome = decideRunOutcome(input);
    assert.deepEqual([outcome.code, outcome.reason, outcome.result, outcome.cleanup], [code, reason, result, cleanup], name);
  }
  assert.equal(JSON.parse(resultLine({ command: 'run', result: 'failed', ...decideRunOutcome({ leaks: [], result: { code: 'NOT_SEEDED', reason: 'owner-login-missing', cleanup: complete }, exitedCode: 1 }) })).exitCode, 10);
  // The summary fields come from the worker result.
  const summary = decideRunOutcome({ leaks: [], result: { code: 'NATIVE_TURN_FAILED', reason: 'failed', authRejectionSuspected: true, stream: { refreshedDuringRun: true }, cleanup: complete }, exitedCode: 1 });
  assert.equal(summary.authRejectionSuspected, true);
  assert.equal(summary.refreshedDuringRun, true);
  const none = decideRunOutcome({ leaks: [], result: null, exitedCode: 1 });
  assert.equal(none.authRejectionSuspected, false);
  assert.equal(none.refreshedDuringRun, false);
});

test('the route-A reasons exist under their documented exit codes', () => {
  const table = {
    USAGE: ['route-mismatch', 'owner-location'],
    NOT_SEEDED: ['owner-login-missing'],
    STREAM_UNSAFE: ['owner-unsafe:symlink', 'owner-unsafe:not-regular', 'owner-unsafe:uid', 'owner-unsafe:mode', 'owner-unsafe:hardlink',
      'owner-unsafe:unstable', 'auth-invalid:token-unparseable', 'auth-invalid:account-claim', 'access-near-expiry', 'inflight-other-route',
      'derived-not-access-only'],
    RUNTIME_PREREQ_FAILED: ['client-unqualified'],
    COPYBACK_REFUSED: ['runtime-copy-changed'],
  };
  for (const [code, reasons] of Object.entries(table)) {
    for (const reason of reasons) {
      assert.ok(EXIT_REASONS[code].includes(reason), `${code} ${reason}`);
      const error = new CodexAuthError(code, reason);
      assert.equal(error.exitCode, EXIT_CODES[code]);
      assert.equal(error.message, `codex-test-auth ${code} ${reason}`);
    }
  }
  // No route-A reason is filed under a second code, and the table keeps its 13 codes.
  const claimed = Object.values(table).flat();
  for (const reason of claimed) {
    assert.deepEqual(Object.entries(EXIT_REASONS).filter(([, reasons]) => reasons.includes(reason)).map(([code]) => code).length, 1, reason);
  }
  assert.equal(Object.keys(EXIT_CODES).length, 13);
  assert.throws(() => new CodexAuthError('RUNTIME_PREREQ_FAILED', 'access-near-expiry'), TypeError);
});

test('route selection defaults preflight, run and scan-leaks to owner, keeps stream explicit, and refuses stream-only subcommands under owner', () => {
  assert.deepEqual([...CREDENTIAL_SOURCES], ['owner', 'stream']);
  assert.deepEqual([...STREAM_ONLY_COMMANDS], ['seed', 'retire', 'adopt']);
  assert.ok(Object.isFrozen(CREDENTIAL_SOURCES) && Object.isFrozen(STREAM_ONLY_COMMANDS));
  for (const command of ['preflight', 'run', 'scan-leaks']) {
    assert.equal(resolveCredentialSource({}, { command }), 'owner', command);
    assert.equal(resolveCredentialSource({ CODEX_TEST_AUTH_SOURCE: '' }, { command }), 'owner', command);
    assert.equal(resolveCredentialSource({ CODEX_TEST_AUTH_SOURCE: 'owner' }, { command }), 'owner', command);
    assert.equal(resolveCredentialSource({ CODEX_TEST_AUTH_SOURCE: 'stream' }, { command }), 'stream', command);
    for (const value of ['OWNER', 'Stream', 'both', ' owner', 'owner ', 'none', 7, true]) {
      assert.throws(() => resolveCredentialSource({ CODEX_TEST_AUTH_SOURCE: value }, { command }), failure('USAGE', 'bad-variable'), `${command} ${String(value)}`);
    }
  }
  for (const command of STREAM_ONLY_COMMANDS) {
    assert.equal(resolveCredentialSource({}, { command }), 'stream', command);
    assert.equal(resolveCredentialSource({ CODEX_TEST_AUTH_SOURCE: '' }, { command }), 'stream', command);
    assert.equal(resolveCredentialSource({ CODEX_TEST_AUTH_SOURCE: 'stream' }, { command }), 'stream', command);
    assert.throws(() => resolveCredentialSource({ CODEX_TEST_AUTH_SOURCE: 'owner' }, { command }), failure('USAGE', 'route-mismatch'), command);
    for (const value of ['OWNER', 'both', ' owner']) {
      assert.throws(() => resolveCredentialSource({ CODEX_TEST_AUTH_SOURCE: value }, { command }), failure('USAGE', 'bad-variable'), `${command} ${value}`);
    }
  }
  // An absent environment object resolves like an empty one.
  assert.equal(resolveCredentialSource(undefined, { command: 'run' }), 'owner');
});

test('resolveOwnerAuthPath uses HOME/.codex/auth.json from the given environment, accepts an absolute override, locates a missing directory without failing, and rejects relative, NUL and overlapping paths in both directions', (t) => {
  const { base, home, dir, file } = ownerHome(t, ownerLogin());
  const paths = resolveAuthPaths({ HOME: home, CODEX_TEST_AUTH_ROOT: path.join(base, 'state', 'root') });
  // The default comes from the environment that is passed in, never from the account's own home.
  assert.notEqual(home, REAL_HOME);
  assert.deepEqual(resolveOwnerAuthPath({ HOME: home }, paths), { file, source: 'default' });
  assert.equal(ownerDirectoryFor({ HOME: home }, paths), dir);
  // An absolute override wins.
  const other = path.join(base, 'elsewhere', 'login.json');
  fs.mkdirSync(path.dirname(other));
  assert.deepEqual(resolveOwnerAuthPath({ HOME: home, CODEX_TEST_AUTH_OWNER_AUTH: other }, paths), { file: other, source: 'override' });
  assert.equal(ownerDirectoryFor({ CODEX_TEST_AUTH_OWNER_AUTH: other }, paths), path.dirname(other));
  assert.deepEqual(resolveOwnerAuthPath({ HOME: home, CODEX_TEST_AUTH_OWNER_AUTH: '' }, paths), { file, source: 'default' });
  // A HOME whose directory is missing is located without failing: the open reports the missing login.
  const missingHome = path.join(base, 'does-not-exist', 'home');
  assert.deepEqual(resolveOwnerAuthPath({ HOME: missingHome }, paths), { file: path.join(missingHome, '.codex', 'auth.json'), source: 'default' });
  assert.equal(ownerDirectoryFor({ HOME: missingHome }, paths), path.join(missingHome, '.codex'));
  // A symlinked HOME is located through its target.
  const linked = path.join(base, 'linked-home');
  fs.symlinkSync(home, linked);
  assert.equal(ownerDirectoryFor({ HOME: linked }, paths), dir);
  // Unusable environments.
  assert.throws(() => resolveOwnerAuthPath({}, paths), failure('USAGE', 'bad-variable'));
  assert.throws(() => resolveOwnerAuthPath({ HOME: '' }, paths), failure('USAGE', 'bad-variable'));
  assert.throws(() => resolveOwnerAuthPath({ HOME: 'rel/home' }, paths), failure('USAGE', 'relative-path'));
  assert.throws(() => resolveOwnerAuthPath({ CODEX_TEST_AUTH_OWNER_AUTH: 'rel/auth.json' }, paths), failure('USAGE', 'relative-path'));
  for (const bad of ['/a\u0000b', '/a\nb', '/a\rb']) {
    assert.throws(() => resolveOwnerAuthPath({ HOME: home, CODEX_TEST_AUTH_OWNER_AUTH: bad }, paths), failure('USAGE', 'bad-variable'));
    assert.equal(ownerDirectoryFor({ HOME: home, CODEX_TEST_AUTH_OWNER_AUTH: bad }, paths), null);
  }
  assert.equal(ownerDirectoryFor({}, paths), null);
  assert.equal(ownerDirectoryFor({ HOME: 'rel/home' }, paths), null);
  // Overlap with a forbidden root is refused in both directions: the owner directory inside a root, and a root inside the owner directory.
  const artifacts = path.join(base, 'artifacts');
  fs.mkdirSync(path.join(artifacts, 'nested'), { recursive: true });
  const insideRoot = path.join(artifacts, 'nested', 'auth.json');
  assert.throws(() => resolveOwnerAuthPath({ CODEX_TEST_AUTH_OWNER_AUTH: insideRoot }, paths, { forbiddenRoots: [artifacts] }), failure('USAGE', 'owner-location'));
  const workspace = path.join(dir, 'workspace');
  fs.mkdirSync(workspace);
  assert.throws(() => resolveOwnerAuthPath({ HOME: home }, paths, { forbiddenRoots: [workspace] }), failure('USAGE', 'owner-location'));
  assert.throws(() => resolveOwnerAuthPath({ HOME: home }, paths, { forbiddenRoots: [home] }), failure('USAGE', 'owner-location'));
  // ROOT is always forbidden, in both directions.
  const rootInside = resolveAuthPaths({ HOME: home, CODEX_TEST_AUTH_ROOT: path.join(dir, 'state', 'root') });
  assert.throws(() => resolveOwnerAuthPath({ HOME: home }, rootInside), failure('USAGE', 'owner-location'));
  const rootAround = resolveAuthPaths({ HOME: home, CODEX_TEST_AUTH_ROOT: home });
  assert.throws(() => resolveOwnerAuthPath({ HOME: home }, rootAround), failure('USAGE', 'owner-location'));
  // Positive control: unrelated roots are accepted.
  assert.deepEqual(resolveOwnerAuthPath({ HOME: home }, paths, { forbiddenRoots: [artifacts, '', null] }), { file, source: 'default' });
});

test('readOwnerAuth reads a private regular file through O_NOFOLLOW and refuses a symlink, a hard link, a FIFO, a directory, another uid, group or world bits and an oversize file', async (t) => {
  const bytes = ownerLogin();
  const { base, dir, file } = ownerHome(t, bytes);
  const opened = spyFs(t, ['openSync']);
  const read = await readOwnerAuth(file, { sleep: noSleep });
  assert.deepEqual(Object.keys(read), ['bytes']);
  assert.deepEqual(read.bytes, bytes);
  const own = opened.filter((call) => call.args[0] === file);
  assert.equal(own.length, 1);
  const flags = own[0].args[1];
  assert.equal(typeof flags, 'number');
  assert.ok(flags & fs.constants.O_NOFOLLOW, 'the open must not follow a symlink');
  assert.ok(flags & fs.constants.O_NONBLOCK, 'the open must not block on a FIFO');
  assert.equal(flags & (fs.constants.O_WRONLY | fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_TRUNC | fs.constants.O_APPEND), 0, 'the open is read-only');
  // 0400 is accepted as well as 0600.
  fs.chmodSync(file, 0o400);
  assert.deepEqual((await readOwnerAuth(file, { sleep: noSleep })).bytes, bytes);
  fs.chmodSync(file, 0o600);
  const refused = async (target, reason, options = {}) => assert.rejects(readOwnerAuth(target, { sleep: noSleep, ...options }), failure('STREAM_UNSAFE', reason), reason);
  // A symlink, even to a valid private file.
  const link = path.join(dir, 'link.json');
  fs.symlinkSync(file, link);
  await refused(link, 'owner-unsafe:symlink');
  // A hard link: the link count is 2 for both names.
  const hard = path.join(dir, 'hard.json');
  fs.linkSync(file, hard);
  await refused(file, 'owner-unsafe:hardlink');
  await refused(hard, 'owner-unsafe:hardlink');
  fs.rmSync(hard);
  // A FIFO and a directory are not regular files.
  const fifo = path.join(dir, 'fifo.json');
  execFileSync('mkfifo', [fifo], { env: { PATH: '/usr/bin:/bin' } });
  await refused(fifo, 'owner-unsafe:not-regular');
  const folder = path.join(dir, 'folder.json');
  fs.mkdirSync(folder);
  await refused(folder, 'owner-unsafe:not-regular');
  // Another uid, then group and world bits.
  await refused(file, 'owner-unsafe:uid', { uid: process.getuid() + 1 });
  for (const mode of [0o640, 0o604, 0o660, 0o666, 0o620]) {
    fs.chmodSync(file, mode);
    await refused(file, 'owner-unsafe:mode');
  }
  fs.chmodSync(file, 0o600);
  // Size: exactly 64 KiB is read, one byte more is refused.
  const padded = (size) => { const value = Buffer.alloc(size, 0x20); Buffer.from('{}').copy(value); return value; };
  const big = path.join(base, 'big.json');
  fs.writeFileSync(big, padded(64 * 1024), { mode: 0o600 });
  assert.equal((await readOwnerAuth(big, { sleep: noSleep })).bytes.length, 64 * 1024);
  fs.writeFileSync(big, padded(64 * 1024 + 1), { mode: 0o600 });
  await refused(big, 'auth-invalid:oversize');
  // Open errors that are not file states map to fixed reasons, anything else propagates unchanged.
  const failing = (code) => ({ openSync() { throw codeError(code); } });
  await refused(file, 'owner-unsafe:symlink', { fsApi: failing('EMLINK') });
  await refused(file, 'owner-unsafe:symlink', { fsApi: failing('ELOOP') });
  await refused(file, 'owner-unsafe:not-regular', { fsApi: failing('ENXIO') });
  await refused(file, 'owner-unsafe:uid', { fsApi: failing('EACCES') });
  await refused(file, 'owner-unsafe:uid', { fsApi: failing('EPERM') });
  await assert.rejects(readOwnerAuth(file, { sleep: noSleep, fsApi: failing('EIO') }), (error) => error?.code === 'EIO' && !(error instanceof CodexAuthError));
});

test('readOwnerAuth reports owner-login-missing for an absent file, retries an in-place rewrite, and fails unstable for a file that stays empty or keeps changing', async (t) => {
  const { base, home, dir, file } = ownerHome(t);
  const missing = failure('NOT_SEEDED', 'owner-login-missing');
  await assert.rejects(readOwnerAuth(file, { sleep: noSleep }), missing);
  await assert.rejects(readOwnerAuth(path.join(base, 'no-such-directory', 'auth.json'), { sleep: noSleep }), missing);
  await assert.rejects(readOwnerAuth(path.join(file, 'below-a-file'), { sleep: noSleep }), missing);
  assert.ok(home && dir);
  const bytes = ownerLogin();
  fs.writeFileSync(file, bytes, { mode: 0o600 });
  const counted = (overrides = {}) => {
    const log = { opens: 0, sleeps: [] };
    const bigStat = (fd, change = {}) => {
      const real = fs.fstatSync(fd, { bigint: true });
      return { isFile: () => real.isFile(), uid: real.uid, mode: real.mode, nlink: real.nlink, size: real.size, ino: real.ino, mtimeNs: real.mtimeNs, ...change };
    };
    const fsApi = { openSync(...args) { log.opens += 1; return fs.openSync(...args); }, fstatSync: (fd, options) => overrides.fstat?.(fd, bigStat, log) ?? bigStat(fd),
      readFileSync: (fd) => overrides.read?.(fd, log) ?? fs.readFileSync(fd), closeSync: (fd) => fs.closeSync(fd) };
    return { log, fsApi, sleep: async (milliseconds) => { log.sleeps.push(milliseconds); } };
  };
  // An empty file on the first attempt (Codex truncates, then writes) and the real bytes on the second succeeds after two opens.
  const rewrite = counted({ fstat: (fd, bigStat, log) => (log.opens === 1 ? bigStat(fd, { size: 0n }) : bigStat(fd)) });
  assert.deepEqual((await readOwnerAuth(file, { fsApi: rewrite.fsApi, sleep: rewrite.sleep, retryDelayMs: 7 })).bytes, bytes);
  assert.equal(rewrite.log.opens, 2);
  assert.deepEqual(rewrite.log.sleeps, [7]);
  // A partial JSON body on the first attempt is retried as well.
  const partial = counted({ read: (fd, log) => (log.opens === 1 ? Buffer.from(bytes.subarray(0, 20)) : fs.readFileSync(fd)),
    fstat: (fd, bigStat, log) => (log.opens === 1 ? bigStat(fd, { size: 20n }) : bigStat(fd)) });
  assert.deepEqual((await readOwnerAuth(file, { fsApi: partial.fsApi, sleep: partial.sleep })).bytes, bytes);
  assert.equal(partial.log.opens, 2);
  // A file that stays empty fails unstable after exactly three attempts.
  const empty = path.join(dir, 'empty.json');
  fs.writeFileSync(empty, '', { mode: 0o600 });
  const emptyRun = counted();
  await assert.rejects(readOwnerAuth(empty, { fsApi: emptyRun.fsApi, sleep: emptyRun.sleep }), failure('STREAM_UNSAFE', 'owner-unsafe:unstable'));
  assert.equal(emptyRun.log.opens, 3);
  assert.equal(emptyRun.log.sleeps.length, 2);
  // A file whose metadata keeps changing fails unstable after exactly three attempts.
  let tick = 0n;
  const changing = counted({ fstat: (fd, bigStat) => { tick += 1n; return bigStat(fd, { mtimeNs: tick }); } });
  await assert.rejects(readOwnerAuth(file, { fsApi: changing.fsApi, sleep: changing.sleep }), failure('STREAM_UNSAFE', 'owner-unsafe:unstable'));
  assert.equal(changing.log.opens, 3);
  // A stable, non-empty file that is not JSON is a content failure after three attempts, not an unstable one.
  const text = path.join(dir, 'text.json');
  fs.writeFileSync(text, 'this is not json', { mode: 0o600 });
  const textRun = counted();
  await assert.rejects(readOwnerAuth(text, { fsApi: textRun.fsApi, sleep: textRun.sleep }), failure('STREAM_UNSAFE', 'auth-invalid:missing-field'));
  assert.equal(textRun.log.opens, 3);
  // One attempt only when asked.
  const once = counted();
  await assert.rejects(readOwnerAuth(empty, { fsApi: once.fsApi, sleep: once.sleep, attempts: 1 }), failure('STREAM_UNSAFE', 'owner-unsafe:unstable'));
  assert.equal(once.log.opens, 1);
});

test('extractOwnerCredential accepts only a managed chatgpt login and refuses api-key, PAT, Bedrock, chatgptAuthTokens, a missing auth_mode, missing fields and a mismatched or absent account claim', (t) => {
  void t;
  const extract = (bytes) => extractOwnerCredential(bytes, { now: NOW });
  const good = ownerLogin({ lastRefresh: '2026-09-24T12:00:00.123456789Z' });
  const credential = extract(good);
  assert.deepEqual(Object.keys(credential), ['accessToken', 'accountId', 'lastRefresh', 'expMs']);
  assert.equal(credential.accessToken, parsed(good).tokens.access_token);
  assert.equal(credential.accountId, 'acct-fake-0001');
  // A last_refresh with nine fractional digits is accepted and kept verbatim.
  assert.equal(credential.lastRefresh, '2026-09-24T12:00:00.123456789Z');
  assert.equal(credential.expMs, Math.floor((NOW + 240 * HOUR) / 1000) * 1000);
  assert.equal(JSON.stringify(credential).includes('rt-fake'), false, 'the refresh token is never extracted');
  const refusals = [
    ['an API key', ownerLogin({ extra: { OPENAI_API_KEY: 'sk-fake-0000000000' } }), 'auth-invalid:api-key'],
    ['a PAT', ownerLogin({ extra: { personal_access_token: 'pat-fake-0000' } }), 'auth-invalid:pat'],
    ['Bedrock', ownerLogin({ extra: { bedrock_api_key: 'bk-fake-0000' } }), 'auth-invalid:bedrock'],
    ['auth_mode apikey', ownerLogin({ extra: { auth_mode: 'apikey' } }), 'auth-invalid:not-chatgpt'],
    ['auth_mode chatgptAuthTokens', ownerLogin({ extra: { auth_mode: 'chatgptAuthTokens' } }), 'auth-invalid:not-chatgpt'],
    ['no auth_mode', edited(good, (value) => { delete value.auth_mode; }), 'auth-invalid:not-chatgpt'],
    ['no refresh token', edited(good, (value) => { value.tokens.refresh_token = ''; }), 'auth-invalid:missing-field'],
    ['no id token', edited(good, (value) => { delete value.tokens.id_token; }), 'auth-invalid:missing-field'],
    ['no tokens', edited(good, (value) => { delete value.tokens; }), 'auth-invalid:missing-field'],
    ['no last_refresh', edited(good, (value) => { delete value.last_refresh; }), 'auth-invalid:missing-field'],
    ['a future last_refresh', ownerLogin({ refreshed: NOW + HOUR }), 'auth-invalid:future-last-refresh'],
    ['an account id with a space', ownerLogin({ account: 'acct fake', claim: 'acct fake' }), 'auth-invalid:missing-field'],
    ['an account id of 257 characters', ownerLogin({ account: 'a'.repeat(257) }), 'auth-invalid:missing-field'],
    ['a non-ASCII account id', ownerLogin({ account: 'acct-fäke', claim: 'acct-fäke' }), 'auth-invalid:missing-field'],
    ['an unparseable access token', edited(good, (value) => { value.tokens.access_token = 'not-a-jwt'; }), 'auth-invalid:token-unparseable'],
    ['an absent account claim', ownerLogin({ claim: null }), 'auth-invalid:account-claim'],
    ['a different account claim', ownerLogin({ claim: 'acct-fake-9999' }), 'auth-invalid:account-claim'],
  ];
  for (const [name, bytes, reason] of refusals) assert.throws(() => extract(bytes), failure('STREAM_UNSAFE', reason), name);
  // The refusal says which kind of claim problem it was, as one fixed word.
  assert.throws(() => extract(ownerLogin({ claim: null })), (error) => error.accountClaim === 'absent');
  assert.throws(() => extract(ownerLogin({ claim: 'acct-fake-9999' })), (error) => error.accountClaim === 'mismatch');
  // A 64 KiB limit and a non-JSON body are refused by the shared validation.
  assert.throws(() => extract(Buffer.alloc(64 * 1024 + 1, 0x20)), failure('STREAM_UNSAFE', 'auth-invalid:oversize'));
  assert.throws(() => extract(Buffer.from('nope')), failure('STREAM_UNSAFE', 'auth-invalid:missing-field'));
  assert.equal(extract(ownerLogin({ account: 'a'.repeat(256) })).accountId.length, 256);
});

test('parseAccessTokenClaims requires three non-empty base64url segments, a JSON object payload and a positive safe-integer exp', () => {
  const header = b64({ alg: 'none' });
  const withPayload = (value, signature = 'c2ln') => `${header}.${b64(value)}.${signature}`;
  const valid = withPayload({ exp: 1_790_000_000, [CLAIM_KEY]: { chatgpt_account_id: 'acct-fake-0001' } });
  assert.deepEqual(parseAccessTokenClaims(valid), { expMs: 1_790_000_000_000, accountClaim: 'acct-fake-0001' });
  assert.deepEqual(parseAccessTokenClaims(withPayload({ exp: 5 })), { expMs: 5000, accountClaim: null });
  assert.deepEqual(parseAccessTokenClaims(withPayload({ exp: 5, [CLAIM_KEY]: { chatgpt_account_id: 7 } })), { expMs: 5000, accountClaim: null });
  const payload = b64({ exp: 1_790_000_000 });
  const bad = [
    'a.b', 'a', '', `${header}.${payload}`, `${header}.${payload}.c2ln.extra`, 'a..c', `${header}..c2ln`, `${header}.${payload}.`, `.${payload}.c2ln`,
    `${header}.${payload}=.c2ln`, `${header}.${Buffer.from(JSON.stringify({ exp: 12 })).toString('base64')}.c2ln`,
    `${header}.${Buffer.from(JSON.stringify({ exp: 1_790_000_000, pad: '>>>' })).toString('base64')}.c2ln`, `${header}.${payload}+.c2ln`,
    `${header}.${Buffer.from('not json').toString('base64url')}.c2ln`, withPayload([1, 2, 3]), withPayload('exp'), withPayload(null),
    withPayload({ exp: '1' }), withPayload({ exp: 1.5 }), withPayload({ exp: -1 }), withPayload({ exp: 0 }), withPayload({}), withPayload({ exp: 2 ** 53 }),
    withPayload({ exp: null }), withPayload({ exp: [1] }), null, undefined, 5, {},
  ];
  for (const token of bad) assert.throws(() => parseAccessTokenClaims(token), failure('STREAM_UNSAFE', 'auth-invalid:token-unparseable'), String(token).slice(0, 40));
  // The error never carries the token.
  try { parseAccessTokenClaims(`${header}.${payload}`); assert.fail('unreachable'); } catch (error) {
    assert.equal(JSON.stringify({ ...error, message: error.message }).includes(payload), false);
  }
});

test('deriveAccessOnlyAuth writes exactly the chatgptAuthTokens shape and never carries the owner refresh token, id token or any other owner field', () => {
  const owner = ownerLogin({ lastRefresh: '2026-09-24T12:00:00.123456789Z',
    extra: { agent_identity: { record: 'agent-fake-record' }, unknown_future_field: 'unknown-fake-value', tokens_extra: ['x'] } });
  const value = parsed(owner);
  const { derived, expMs } = deriveAccessOnlyAuth(owner, { now: NOW });
  const golden = `{"auth_mode":"chatgptAuthTokens","OPENAI_API_KEY":null,"tokens":{"id_token":"${value.tokens.access_token}","access_token":"${value.tokens.access_token}",`
    + `"refresh_token":"","account_id":"acct-fake-0001"},"last_refresh":"2026-09-24T12:00:00.123456789Z"}`;
  assert.equal(derived.toString('utf8'), golden);
  assert.equal(expMs, Math.floor((NOW + 240 * HOUR) / 1000) * 1000);
  const text = derived.toString('utf8');
  assert.deepEqual(Object.keys(parsed(derived)), ['auth_mode', 'OPENAI_API_KEY', 'tokens', 'last_refresh']);
  assert.deepEqual(Object.keys(parsed(derived).tokens), ['id_token', 'access_token', 'refresh_token', 'account_id']);
  assert.equal(text.includes(value.tokens.refresh_token), false);
  assert.equal(text.includes(value.tokens.id_token), false);
  for (const foreign of ['agent_identity', 'agent-fake-record', 'unknown_future_field', 'unknown-fake-value', 'tokens_extra']) assert.equal(text.includes(foreign), false, foreign);
  assert.equal(isAccessOnly(derived), true);
  assert.equal(DERIVED_SHAPE_ID, 'chatgptAuthTokens-v1');
  // The byte builder is a pure function of its three values.
  assert.deepEqual(deriveAccessOnlyBytes({ accessToken: 'a.b.c', accountId: 'acct', lastRefresh: '2026-10-03T12:00:00Z' }),
    Buffer.from('{"auth_mode":"chatgptAuthTokens","OPENAI_API_KEY":null,"tokens":{"id_token":"a.b.c","access_token":"a.b.c","refresh_token":"","account_id":"acct"},"last_refresh":"2026-10-03T12:00:00Z"}'));
  // The self-check is conservative: an owner whose id token equals its access token would put the id token into the derived bytes.
  const same = edited(owner, (login) => { login.tokens.id_token = login.tokens.access_token; });
  assert.throws(() => deriveAccessOnlyAuth(same, { now: NOW }), failure('STREAM_UNSAFE', 'derived-not-access-only'));
  // The derivation refuses what the extraction refuses.
  assert.throws(() => deriveAccessOnlyAuth(ownerLogin({ claim: null }), { now: NOW }), failure('STREAM_UNSAFE', 'auth-invalid:account-claim'));
});

test('the expiry gate passes at exactly the required validity, refuses one second less, records its outcome, and reports floored and ceiled minutes', async () => {
  assert.equal(ACCESS_SKEW_MS, 5 * MINUTE);
  assert.equal(requiredValidityMs(RUN_TIMEOUT_MS), 2_400_000);
  assert.equal(requiredValidityMs(0), ACCESS_SKEW_MS);
  for (const bad of [-1, Number.NaN, Infinity, '1', null, undefined]) assert.throws(() => requiredValidityMs(bad), failure('USAGE', 'bad-variable'), String(bad));
  const gate = (expMs, remainingRunMs = RUN_TIMEOUT_MS) => assertAccessValidity({ expMs, now: NOW, remainingRunMs });
  assert.deepEqual(gate(NOW + 40 * MINUTE), { accessValidMinutes: 40, requiredValidMinutes: 40 });
  assert.deepEqual(gate(NOW + 40 * MINUTE + 1000), { accessValidMinutes: 40, requiredValidMinutes: 40 });
  assert.throws(() => gate(NOW + 40 * MINUTE - 1000), (error) => failure('STREAM_UNSAFE', 'access-near-expiry')(error) && error.accessValidMinutes === 39 && error.requiredValidMinutes === 40);
  assert.throws(() => gate(NOW - 90 * MINUTE), (error) => failure('STREAM_UNSAFE', 'access-near-expiry')(error) && error.accessValidMinutes === -90);
  assert.throws(() => gate(Number.NaN), failure('STREAM_UNSAFE', 'access-near-expiry'));
  // The inject window of 175 s needs 475 s.
  assert.equal(requiredValidityMs(175_000), 475_000);
  assert.deepEqual(gate(NOW + 475_000, 175_000), { accessValidMinutes: 7, requiredValidMinutes: 8 });
  assert.throws(() => gate(NOW + 474_999, 175_000), failure('STREAM_UNSAFE', 'access-near-expiry'));
  // The session records each gate before it throws.
  const edge = (expMs) => ownerLogin({ expMs });
  const passing = ownerSession(fakeRuntime(), edge(NOW + 40 * MINUTE));
  await passing.load({ ownerFile: FILE });
  assert.deepEqual(passing.state.gates.atDerive, { result: 'pass', accessValidMinutes: 40, requiredValidMinutes: 40 });
  const refusing = ownerSession(fakeRuntime(), edge(NOW + 40 * MINUTE - 1000));
  await assert.rejects(refusing.load({ ownerFile: FILE }), failure('STREAM_UNSAFE', 'access-near-expiry'));
  assert.deepEqual(refusing.state.gates.atDerive, { result: 'refused', accessValidMinutes: 39, requiredValidMinutes: 40 });
  assert.equal(refusing.state.derived, true, 'the derived bytes existed when the gate refused');
  // A rest of the test time below the full run needs less: the worker gate uses what is left.
  const later = ownerSession(fakeRuntime(), edge(NOW + 20 * MINUTE), { clock: { now: NOW }, deadline: NOW + 15 * MINUTE });
  await later.load({ ownerFile: FILE });
  assert.deepEqual(later.state.gates.atDerive, { result: 'pass', accessValidMinutes: 20, requiredValidMinutes: 20 });
});

test('owner summaries and gate errors contain no token, account or digest values', () => {
  const owner = ownerLogin({ lastRefresh: '2026-09-24T12:00:00.123456789Z' });
  const value = parsed(owner);
  const secrets = [value.tokens.access_token, value.tokens.id_token, value.tokens.refresh_token, value.tokens.account_id, value.last_refresh];
  const summary = summarizeOwner(owner, { now: NOW, remainingRunMs: RUN_TIMEOUT_MS, source: 'default' });
  assert.deepEqual(Object.keys(summary), ['source', 'readable', 'authMode', 'hasIdToken', 'hasAccessToken', 'hasRefreshToken', 'hasAccountId', 'hasLastRefresh',
    'lastRefreshAgeHours', 'accessToken', 'accountClaim', 'accessValidMinutes', 'requiredValidMinutes']);
  assert.deepEqual({ ...summary, lastRefreshAgeHours: undefined }, { source: 'default', readable: true, authMode: 'chatgpt', hasIdToken: true, hasAccessToken: true,
    hasRefreshToken: true, hasAccountId: true, hasLastRefresh: true, lastRefreshAgeHours: undefined, accessToken: 'ok', accountClaim: 'match',
    accessValidMinutes: 240 * 60, requiredValidMinutes: 40 });
  const texts = [JSON.stringify(summary)];
  for (const body of [Buffer.from('not json'), ownerLogin({ claim: null }), ownerLogin({ claim: 'acct-fake-9999' }), edited(owner, (login) => { login.tokens.access_token = 'opaque'; }),
    edited(owner, (login) => { login.auth_mode = 'chatgptAuthTokens'; }), Buffer.alloc(0)]) {
    const other = summarizeOwner(body, { now: NOW, remainingRunMs: RUN_TIMEOUT_MS, source: 'override' });
    texts.push(JSON.stringify(other));
    assert.equal(other.readable, true);
  }
  assert.equal(summarizeOwner(Buffer.from('not json'), { now: NOW, remainingRunMs: RUN_TIMEOUT_MS, source: 'default' }).accessToken, 'unparseable');
  assert.equal(summarizeOwner(ownerLogin({ claim: null }), { now: NOW, remainingRunMs: RUN_TIMEOUT_MS, source: 'default' }).accountClaim, 'absent');
  assert.equal(summarizeOwner(ownerLogin({ claim: 'acct-fake-9999' }), { now: NOW, remainingRunMs: RUN_TIMEOUT_MS, source: 'default' }).accountClaim, 'mismatch');
  // Every error of the route is a fixed word with at most two minute counts.
  const errors = [
    () => assertAccessValidity({ expMs: NOW, now: NOW, remainingRunMs: RUN_TIMEOUT_MS }),
    () => extractOwnerCredential(ownerLogin({ claim: 'acct-fake-9999' }), { now: NOW }),
    () => extractOwnerCredential(ownerLogin({ claim: null }), { now: NOW }),
    () => parseAccessTokenClaims(value.tokens.access_token.split('.').slice(0, 2).join('.')),
    () => deriveAccessOnlyAuth(edited(owner, (login) => { login.tokens.id_token = login.tokens.access_token; }), { now: NOW }),
  ];
  for (const attempt of errors) {
    try { attempt(); assert.fail('unreachable'); } catch (error) {
      assert.ok(error instanceof CodexAuthError);
      texts.push(JSON.stringify({ ...error, message: error.message, stack: error.stack }));
    }
  }
  for (const text of texts) {
    for (const secret of secrets) assert.equal(text.includes(secret), false, `a value leaked: ${secret.slice(0, 12)}`);
    assert.equal(/[0-9a-f]{64}/.test(text), false, 'no digest');
  }
});

test('route A opens nothing under the owner directory except auth.json, only read-only, and writes nothing there', async (t) => {
  const bytes = ownerLogin();
  const { base, home, dir, file } = ownerHome(t, bytes);
  fs.writeFileSync(path.join(dir, 'config.toml'), 'model = "fake"\n', { mode: 0o600 });
  const snapshotOf = () => fs.readdirSync(dir).sort().map((name) => { const stat = fs.lstatSync(path.join(dir, name)); return [name, stat.ino, stat.size, stat.mtimeMs, stat.mode, fs.readFileSync(path.join(dir, name), 'utf8')].join(' '); });
  const before = snapshotOf();
  const everything = spyFs(t, ['openSync', 'readFileSync', 'readdirSync', 'lstatSync', 'statSync', 'existsSync', 'accessSync', 'realpathSync', 'opendirSync',
    'readlinkSync', 'createReadStream', ...WRITE_FUNCTIONS]);
  const paths = resolveAuthPaths({ HOME: home, CODEX_TEST_AUTH_ROOT: path.join(base, 'state', 'root') });
  const env = { HOME: home };
  const { file: resolved, source } = resolveOwnerAuthPath(env, paths, { forbiddenRoots: [path.join(base, 'artifacts')] });
  assert.equal(resolved, file);
  assert.equal(ownerDirectoryFor(env, paths), dir);
  const { bytes: read } = await readOwnerAuth(resolved, { sleep: noSleep });
  extractOwnerCredential(read, { now: NOW });
  const { derived, expMs } = deriveAccessOnlyAuth(read, { now: NOW });
  assertAccessValidity({ expMs, now: NOW, remainingRunMs: RUN_TIMEOUT_MS });
  summarizeOwner(read, { now: NOW, remainingRunMs: RUN_TIMEOUT_MS, source });
  ownerScanReferences(read, { now: NOW });
  assertOwnerScanCoverage({ preBytes: read, postBytes: Buffer.from(read), result: null });
  // The session, with a fake runtime and the real read.
  const runtime = fakeRuntime({ copy: derived });
  const session = createOwnerCredentialSession({ runtime, runDeadline: NOW + RUN_TIMEOUT_MS, injectWindowMs: 175_000, now: () => NOW });
  session.holdLock(true);
  await session.load({ ownerFile: resolved });
  await session.inject(ROBOT);
  await session.persistAndRemove(ROBOT, { confirmed: true });
  await ownerSession(fakeRuntime({ discard: { removed: true, accessOnly: true } }), bytes).recover(ROBOT);
  session.release();
  // Only the read-only open of auth.json, and the realpath lookups that locate the directory, touch the owner directory.
  const inside = (argument) => typeof argument === 'string' && (argument === dir || argument.startsWith(`${dir}${path.sep}`));
  const touching = everything.filter((call) => call.args.some(inside));
  const writeBits = fs.constants.O_WRONLY | fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_TRUNC | fs.constants.O_APPEND | fs.constants.O_EXCL;
  for (const call of touching) {
    if (call.name === 'realpathSync') continue;
    assert.equal(call.name, 'openSync', `unexpected ${call.name} on the owner directory`);
    assert.equal(call.args[0], file);
    assert.equal(typeof call.args[1], 'number');
    assert.equal(call.args[1] & writeBits, 0, 'the open must be read-only');
  }
  // Positive control: the spy does see the open and the lookups.
  assert.ok(touching.some((call) => call.name === 'openSync' && call.args[0] === file));
  assert.ok(touching.some((call) => call.name === 'realpathSync'));
  assert.deepEqual(everything.filter((call) => WRITE_FUNCTIONS.includes(call.name)).map((call) => call.name), [], 'route A writes no file at all');
  assert.deepEqual(snapshotOf(), before);
});

test('the owner session gates before injecting, injects the derived bytes, verifies an unchanged access-only robot copy and removes it by its hash', async () => {
  const owner = ownerLogin({ expMs: NOW + 2 * HOUR });
  const { derived } = deriveAccessOnlyAuth(owner, { now: NOW });
  const clock = { now: NOW };
  const runtime = fakeRuntime({ copy: derived });
  const held = Buffer.from(owner);
  const session = ownerSession(runtime, owner, { clock, readOwner: async () => ({ bytes: held }) });
  assert.deepEqual(Object.keys(session.state).sort(), ['accountClaim', 'derived', 'gates', 'injectConfirmed', 'injected', 'loaded', 'lockHeld', 'persisted',
    'recoveredCopy', 'removed', 'runtimeBytes', 'runtimeCopy']);
  // The session refuses every move without the host lock, and the inject without a passing load.
  const unlocked = createOwnerCredentialSession({ runtime, runDeadline: NOW + RUN_TIMEOUT_MS, injectWindowMs: 175_000, now: () => NOW });
  await assert.rejects(unlocked.load({ ownerFile: FILE }), failure('USAGE', 'bad-variable'));
  await assert.rejects(unlocked.inject(ROBOT), failure('USAGE', 'bad-variable'));
  await assert.rejects(unlocked.persistAndRemove(ROBOT, { confirmed: true }), failure('USAGE', 'bad-variable'));
  await assert.rejects(unlocked.recover(ROBOT), failure('USAGE', 'bad-variable'));
  await assert.rejects(session.inject(ROBOT), failure('USAGE', 'bad-variable'));
  await assert.rejects(session.load({ ownerFile: 'relative/auth.json' }), failure('USAGE', 'bad-variable'));
  assert.deepEqual(runtime.calls, []);
  // Load: the derived bytes exist, the gate passed and the owner bytes were wiped.
  await session.load({ ownerFile: FILE });
  assert.equal(session.state.derived, true);
  assert.equal(session.state.accountClaim, 'match');
  assert.deepEqual(session.state.gates.atDerive, { result: 'pass', accessValidMinutes: 120, requiredValidMinutes: 40 });
  assert.equal(held.every((byte) => byte === 0), true, 'the owner bytes are zero-filled after the derivation');
  assert.deepEqual(session.state.loaded.derived, derived);
  assert.equal(session.state.injected, false);
  // Inject: the derived bytes go to the runtime, and the flags follow the call.
  await session.inject(ROBOT);
  assert.deepEqual(runtime.calls.map((call) => call[0]), ['inject']);
  assert.deepEqual(runtime.calls[0][2], derived);
  assert.equal(session.state.injected, true);
  assert.equal(session.state.injectConfirmed, true);
  assert.deepEqual(session.state.gates.atInject, { result: 'pass', accessValidMinutes: 120, requiredValidMinutes: 8 });
  // Verify and remove: the removal carries the hash of the bytes that were read.
  await session.persistAndRemove(ROBOT, { confirmed: true });
  assert.deepEqual(runtime.calls.map((call) => call[0]), ['inject', 'readForCopyBack', 'remove']);
  assert.equal(runtime.calls[2][2], sha256Hex(derived));
  assert.equal(session.state.persisted, true);
  assert.equal(session.state.removed, true);
  assert.deepEqual(session.state.runtimeCopy, { state: 'unchanged', accessOnly: true, newTokenValues: false, removed: true });
  assert.equal(session.state.recoveredCopy, null);
  session.release();
  assert.equal(session.state.loaded.derived.every((byte) => byte === 0), true, 'release zero-fills the derived bytes');
  assert.equal(session.state.runtimeBytes.every((byte) => byte === 0), true, 'release zero-fills the copy that was read');
  // The credential is injected only while the access token still covers the inject window: expired at inject time, nothing is sent.
  const expiring = fakeRuntime({ copy: derived });
  const clock2 = { now: NOW };
  const late = ownerSession(expiring, ownerLogin({ expMs: NOW + 45 * MINUTE }), { clock: clock2 });
  await late.load({ ownerFile: FILE });
  clock2.now = NOW + 45 * MINUTE - 474_000;
  await assert.rejects(late.inject(ROBOT), failure('STREAM_UNSAFE', 'access-near-expiry'));
  assert.deepEqual(expiring.calls, [], 'the runtime was never asked to inject');
  assert.equal(late.state.injected, false);
  assert.equal(late.state.injectConfirmed, false);
  assert.deepEqual(late.state.gates.atInject, { result: 'refused', accessValidMinutes: 7, requiredValidMinutes: 8 });
  clock2.now = NOW + 45 * MINUTE - 475_000;
  await late.inject(ROBOT);
  assert.equal(late.state.injected, true);
  assert.equal(late.state.gates.atInject.result, 'pass');
  // A load that the gate refused cannot be injected.
  const refused = ownerSession(fakeRuntime(), ownerLogin({ expMs: NOW + 10 * MINUTE }));
  await assert.rejects(refused.load({ ownerFile: FILE }), failure('STREAM_UNSAFE', 'access-near-expiry'));
  await assert.rejects(refused.inject(ROBOT), failure('USAGE', 'bad-variable'));
  // A failed derivation records the claim problem and the owner bytes are wiped anyway.
  const wrong = Buffer.from(ownerLogin({ claim: 'acct-fake-9999' }));
  const claimed = ownerSession(fakeRuntime(), wrong, { readOwner: async () => ({ bytes: wrong }) });
  await assert.rejects(claimed.load({ ownerFile: FILE }), failure('STREAM_UNSAFE', 'auth-invalid:account-claim'));
  assert.equal(claimed.state.accountClaim, 'mismatch');
  assert.equal(claimed.state.derived, false);
  assert.equal(wrong.every((byte) => byte === 0), true);
  const claimless = ownerSession(fakeRuntime(), ownerLogin({ claim: null }));
  await assert.rejects(claimless.load({ ownerFile: FILE }), failure('STREAM_UNSAFE', 'auth-invalid:account-claim'));
  assert.equal(claimless.state.accountClaim, 'absent');
  const missingLogin = ownerSession(fakeRuntime(), null, { readOwner: async () => { throw new CodexAuthError('NOT_SEEDED', 'owner-login-missing'); } });
  await assert.rejects(missingLogin.load({ ownerFile: FILE }), failure('NOT_SEEDED', 'owner-login-missing'));
  assert.equal(missingLogin.state.accountClaim, null);
  assert.equal(missingLogin.state.derived, false);
});

test('a changed, unparsable or missing robot copy fails with runtime-copy-changed or runtime-auth-missing, is removed by the hash of what was read, never throws while classifying, and nothing is written anywhere', async (t) => {
  const owner = ownerLogin({ expMs: NOW + 2 * HOUR });
  const { derived } = deriveAccessOnlyAuth(owner, { now: NOW });
  const writes = spyFs(t, WRITE_FUNCTIONS);
  const text = derived.toString('utf8');
  const sameLength = Buffer.from(text.replace('"account_id":"acct-fake-0001"', '"account_id":"acct-fake-0002"'));
  assert.equal(sameLength.length, derived.length);
  assert.notDeepEqual(sameLength, derived);
  const withRefresh = edited(derived, (value) => { value.tokens.refresh_token = 'rt-fake-injected-0123456789'; });
  const cases = [
    ['a same-length rewrite', sameLength, { state: 'changed', accessOnly: true, newTokenValues: true }],
    ['a pretty-printed rewrite', Buffer.from(JSON.stringify(parsed(derived), null, 2)), { state: 'changed', accessOnly: true, newTokenValues: false }],
    ['a copy with a refresh token', withRefresh, { state: 'changed', accessOnly: false, newTokenValues: true }],
    ['a copy that is not JSON', Buffer.from('not json at all'), { state: 'changed', accessOnly: false, newTokenValues: null }],
    ['an empty copy', Buffer.alloc(0), { state: 'changed', accessOnly: false, newTokenValues: null }],
  ];
  for (const [name, copy, expected] of cases) {
    const runtime = fakeRuntime({ copy });
    const session = ownerSession(runtime, owner);
    await session.load({ ownerFile: FILE });
    await session.inject(ROBOT);
    await assert.rejects(session.persistAndRemove(ROBOT, { confirmed: true }), failure('COPYBACK_REFUSED', 'runtime-copy-changed'), name);
    // The copy is removed before the refusal is raised, by the hash of what was read.
    assert.deepEqual(runtime.calls.map((call) => call[0]), ['inject', 'readForCopyBack', 'remove'], name);
    assert.equal(runtime.calls[2][2], sha256Hex(copy), name);
    assert.deepEqual(session.state.runtimeCopy, { ...expected, removed: true }, name);
    assert.equal(session.state.persisted && session.state.removed, true, name);
  }
  // Classification never throws, whatever the bytes are.
  for (const junk of [Buffer.from('not json'), Buffer.from('null'), Buffer.from('[]'), Buffer.from('{"tokens":5}'), Buffer.alloc(0), Buffer.from([0xff, 0xfe, 0x00])]) {
    assert.doesNotThrow(() => { isAccessOnly(junk); newTokenValues(junk, derived); newTokenValues(derived, junk); });
  }
  assert.equal(newTokenValues(Buffer.from('not json'), derived), null);
  assert.equal(newTokenValues(Buffer.from('{"tokens":5}'), derived), null);
  assert.equal(newTokenValues(derived, derived), false);
  assert.equal(newTokenValues(derived, Buffer.from('not json')), true);
  // isAccessOnly: the derived shape only.
  assert.equal(isAccessOnly(derived), true);
  const shapes = [
    ['a refresh token', withRefresh], ['an id token that differs', edited(derived, (v) => { v.tokens.id_token = 'other.jwt.token'; })],
    ['an extra top-level key', edited(derived, (v) => { v.agent_identity = {}; })], ['an extra token key', edited(derived, (v) => { v.tokens.extra = 'x'; })],
    ['the managed auth_mode', edited(derived, (v) => { v.auth_mode = 'chatgpt'; })], ['an API key', edited(derived, (v) => { v.OPENAI_API_KEY = 'sk-fake'; })],
    ['no last_refresh', edited(derived, (v) => { delete v.last_refresh; })], ['a bad last_refresh', edited(derived, (v) => { v.last_refresh = 'yesterday'; })],
    ['no account id', edited(derived, (v) => { v.tokens.account_id = ''; })], ['no tokens', edited(derived, (v) => { delete v.tokens; })],
    ['a missing token key', edited(derived, (v) => { delete v.tokens.refresh_token; })], ['an array', Buffer.from('[]')], ['not JSON', Buffer.from('nope')],
    ['an empty buffer', Buffer.alloc(0)],
  ];
  for (const [name, bytes] of shapes) assert.equal(isAccessOnly(bytes), false, name);
  assert.equal(isAccessOnly('a string'), false);
  assert.equal(isAccessOnly(null), false);
  // The copy is missing: confirmed gives runtime-auth-missing, unconfirmed gives nothing. Nothing is removed in either case.
  for (const confirmed of [true, false]) {
    const runtime = fakeRuntime({ readError: codeError('NOT_FOUND') });
    const session = ownerSession(runtime, owner);
    await session.load({ ownerFile: FILE });
    await session.inject(ROBOT);
    if (confirmed) await assert.rejects(session.persistAndRemove(ROBOT, { confirmed }), failure('COPYBACK_REFUSED', 'runtime-auth-missing'));
    else await session.persistAndRemove(ROBOT, { confirmed });
    assert.deepEqual(runtime.calls.map((call) => call[0]), ['inject', 'readForCopyBack']);
    assert.deepEqual(session.state.runtimeCopy, { state: 'missing', accessOnly: null, newTokenValues: null, removed: false });
    assert.equal(session.state.persisted && session.state.removed, true);
  }
  // A read failure is 26 credential-not-removed and leaves the copy unaccounted for.
  const unreadable = fakeRuntime({ readError: codeError('BUSY') });
  const stuck = ownerSession(unreadable, owner);
  await stuck.load({ ownerFile: FILE });
  await stuck.inject(ROBOT);
  await assert.rejects(stuck.persistAndRemove(ROBOT, { confirmed: true }), failure('CLEANUP_INCOMPLETE', 'credential-not-removed'));
  assert.equal(stuck.state.persisted, false);
  assert.equal(stuck.state.removed, false);
  // A removal failure keeps the copy classified and unremoved, and a retry removes it with the same hash.
  const flaky = fakeRuntime({ copy: derived, removeError: codeError('REMOVE_MISMATCH') });
  const retry = ownerSession(flaky, owner);
  await retry.load({ ownerFile: FILE });
  await retry.inject(ROBOT);
  await assert.rejects(retry.persistAndRemove(ROBOT, { confirmed: true }), failure('CLEANUP_INCOMPLETE', 'credential-not-removed'));
  assert.equal(retry.state.persisted, true);
  assert.equal(retry.state.removed, false);
  flaky.remove = async (robot, sha) => { flaky.calls.push(['remove', robot, sha]); return { ok: true, removed: true }; };
  await retry.persistAndRemove(ROBOT, { confirmed: true });
  assert.equal(retry.state.removed, true);
  assert.deepEqual(flaky.calls.filter((call) => call[0] === 'readForCopyBack').length, 1, 'the copy is read once');
  assert.deepEqual(flaky.calls.filter((call) => call[0] === 'remove').map((call) => call[2]), [sha256Hex(derived), sha256Hex(derived)]);
  assert.deepEqual(writes.map((call) => call.name), [], 'nothing is written anywhere');
});

test('recovery of a route-A marker discards the leftover copy inside the container, never brings its bytes to the host, never persists it and never reads the owner login', async (t) => {
  const writes = spyFs(t, WRITE_FUNCTIONS);
  const forbidden = () => { throw new Error('this call must not happen during a route-A recovery'); };
  const make = (discard) => {
    const runtime = fakeRuntime({ discard });
    runtime.readForCopyBack = forbidden;
    runtime.remove = forbidden;
    runtime.inject = forbidden;
    return { runtime, session: createOwnerCredentialSession({ runtime, runDeadline: NOW + RUN_TIMEOUT_MS, injectWindowMs: 175_000, now: () => NOW, readOwner: forbidden }) };
  };
  const wait = (session) => { session.holdLock(true); return session; };
  // An access-only leftover is removed and gives no refusal.
  const clean = make({ removed: true, accessOnly: true });
  assert.deepEqual(await wait(clean.session).recover(ROBOT), { refusal: null });
  assert.deepEqual(clean.session.state.recoveredCopy, { removed: true, accessOnly: true });
  assert.deepEqual(clean.runtime.calls.map((call) => call[0]), ['discard']);
  assert.deepEqual(clean.runtime.calls[0][1], ROBOT);
  // The owner login was never read: nothing was derived and no gate was evaluated.
  assert.equal(clean.session.state.derived, false);
  assert.equal(clean.session.state.loaded, null);
  assert.deepEqual(clean.session.state.gates, { atDerive: null, atInject: null });
  // The leftover of this run's own copy accounting is untouched.
  assert.equal(clean.session.state.persisted, false);
  assert.equal(clean.session.state.removed, false);
  assert.equal(clean.session.state.runtimeBytes, null);
  // A leftover that was not access-only is removed and refused with 24, for the caller to raise after the robot is gone.
  const odd = make({ removed: true, accessOnly: false });
  const { refusal } = await wait(odd.session).recover(ROBOT);
  assert.ok(refusal instanceof CodexAuthError);
  assert.equal(refusal.code, 'COPYBACK_REFUSED');
  assert.equal(refusal.reason, 'runtime-copy-changed');
  assert.equal(refusal.exitCode, 24);
  assert.deepEqual(odd.session.state.recoveredCopy, { removed: true, accessOnly: false });
  // No leftover copy gives no refusal.
  const none = make({ removed: false, accessOnly: null });
  assert.deepEqual(await wait(none.session).recover(ROBOT), { refusal: null });
  assert.deepEqual(none.session.state.recoveredCopy, { removed: false, accessOnly: null });
  // A runtime failure is 26 recovery-incomplete.
  const broken = make(null);
  broken.runtime.discard = async () => { throw codeError('BUSY'); };
  await assert.rejects(wait(broken.session).recover(ROBOT), failure('CLEANUP_INCOMPLETE', 'recovery-incomplete'));
  assert.deepEqual(writes.map((call) => call.name), []);
});

test('coverage is proven only for byte-identical pre- and post-run owner reads, n/a only for a result that never derived, and unproven otherwise, while the references still cover both reads', (t) => {
  const first = ownerLogin({ seed: 'first' });
  const second = ownerLogin({ seed: 'second' });
  const never = { owner: { derived: false } };
  const derivedResult = { owner: { derived: true } };
  const unproven = failure('STREAM_UNSAFE', 'scan-reference-missing');
  assert.equal(assertOwnerScanCoverage({ preBytes: first, postBytes: Buffer.from(first), result: derivedResult }), 'proven');
  assert.equal(assertOwnerScanCoverage({ preBytes: first, postBytes: Buffer.from(first), result: null }), 'proven');
  assert.equal(assertOwnerScanCoverage({ preBytes: first, postBytes: Buffer.from(first), result: never }), 'proven');
  assert.throws(() => assertOwnerScanCoverage({ preBytes: first, postBytes: second, result: derivedResult }), unproven);
  // One differing byte is enough.
  const flipped = Buffer.from(first);
  flipped[flipped.length - 3] ^= 0x01;
  assert.throws(() => assertOwnerScanCoverage({ preBytes: first, postBytes: flipped, result: derivedResult }), unproven);
  assert.throws(() => assertOwnerScanCoverage({ preBytes: first, postBytes: null, result: derivedResult }), unproven);
  assert.throws(() => assertOwnerScanCoverage({ preBytes: null, postBytes: first, result: derivedResult }), unproven);
  assert.throws(() => assertOwnerScanCoverage({ preBytes: first, postBytes: second, result: null }), unproven);
  assert.throws(() => assertOwnerScanCoverage({ preBytes: null, postBytes: null, result: null }), unproven);
  assert.throws(() => assertOwnerScanCoverage({ preBytes: first, postBytes: second, result: {} }), unproven);
  assert.throws(() => assertOwnerScanCoverage({ preBytes: first, postBytes: second, result: { owner: {} } }), unproven);
  assert.throws(() => assertOwnerScanCoverage({ preBytes: first, postBytes: second, result: { owner: { derived: null } } }), unproven);
  // n/a only when the result shows that the worker never derived a credential.
  assert.equal(assertOwnerScanCoverage({ preBytes: first, postBytes: second, result: never }), 'n/a');
  assert.equal(assertOwnerScanCoverage({ preBytes: null, postBytes: null, result: never }), 'n/a');
  // The references cover both reads, with the owner bytes and the credential derived from each.
  const references = [...ownerScanReferences(first, { now: NOW }), ...ownerScanReferences(second, { now: NOW })];
  assert.equal(references.length, 4);
  assert.deepEqual(references[0], first);
  assert.deepEqual(references[1], deriveAccessOnlyAuth(first, { now: NOW }).derived);
  assert.deepEqual(references[3], deriveAccessOnlyAuth(second, { now: NOW }).derived);
  assert.deepEqual(ownerScanReferences(ownerLogin({ claim: null }), { now: NOW }).length, 1, 'the derived entry is skipped when the extraction refuses');
  for (const junk of [null, undefined, 'text', Buffer.from('not json'), Buffer.alloc(0)]) assert.doesNotThrow(() => ownerScanReferences(junk));
  assert.deepEqual(ownerScanReferences('text'), []);
  // A derived whole-file copy planted in an artifact is found, with the field name only, and so is one from the second read.
  const dir = sandbox(t);
  fs.writeFileSync(path.join(dir, 'a.log'), `noise ${deriveAccessOnlyAuth(first, { now: NOW }).derived.toString('base64')} noise`);
  fs.writeFileSync(path.join(dir, 'b.log'), `noise ${parsed(second).tokens.access_token} noise`);
  const { leaks } = scanLeaks(dir, references);
  const found = leaks.map((leak) => `${leak.file}:${leak.field}`);
  assert.ok(found.includes('a.log:wholeFileBase64'));
  assert.ok(found.includes('b.log:accessToken'));
  assert.deepEqual([...new Set(leaks.map((leak) => leak.file))].sort(), ['a.log', 'b.log']);
  assert.equal(JSON.stringify(leaks).includes(parsed(second).tokens.access_token), false);
  // Without any reference the scan refuses, so the caller must skip it explicitly for an n/a coverage.
  assert.throws(() => scanLeaks(dir, []), unproven);
});

test('a pending route-A marker makes the run spawn the worker for recovery when the owner gate fails, and the worker\'s owner reason becomes the exit code', () => {
  const failureOf = (reason) => ({ code: 'STREAM_UNSAFE', reason });
  assert.deepEqual(planOwnerRun({ pendingRecovery: false, ownerGateFailure: null }), { spawn: true, spawnedForRecovery: false, earlyFailure: null });
  assert.deepEqual(planOwnerRun({ pendingRecovery: true, ownerGateFailure: null }), { spawn: true, spawnedForRecovery: false, earlyFailure: null });
  const gate = failureOf('access-near-expiry');
  assert.deepEqual(planOwnerRun({ pendingRecovery: true, ownerGateFailure: gate }), { spawn: true, spawnedForRecovery: true, earlyFailure: null });
  assert.deepEqual(planOwnerRun({ pendingRecovery: false, ownerGateFailure: gate }), { spawn: false, spawnedForRecovery: false, earlyFailure: gate });
  const missing = { code: 'NOT_SEEDED', reason: 'owner-login-missing' };
  assert.deepEqual(planOwnerRun({ pendingRecovery: false, ownerGateFailure: missing }).earlyFailure, missing);
  // The recovery run's coverage is n/a, and the worker's owner reason is the exit code of the run.
  assert.equal(assertOwnerScanCoverage({ preBytes: null, postBytes: null, result: { owner: { derived: false } } }), 'n/a');
  const complete = { credentialPersisted: true, credentialRemoved: true, robotDeleted: true, folderDeleted: true };
  const outcome = decideRunOutcome({ leaks: [], coverageFailure: false, result: { code: 'NOT_SEEDED', reason: 'owner-login-missing', owner: { derived: false }, cleanup: complete }, exitedCode: 1 });
  assert.deepEqual([outcome.result, outcome.code, outcome.reason, outcome.cleanup], ['failed', 'NOT_SEEDED', 'owner-login-missing', 'complete']);
  assert.equal(EXIT_CODES[outcome.code], 10);
  // Cleanup that did not complete turns the same worker result into 26.
  const stuck = decideRunOutcome({ leaks: [], result: { code: 'NOT_SEEDED', reason: 'owner-login-missing', cleanup: { ...complete, robotDeleted: false } }, exitedCode: 1 });
  assert.deepEqual([stuck.code, stuck.reason], ['CLEANUP_INCOMPLETE', 'recovery-incomplete']);
});

test('the CLI defaults to the owner route without falling back to a valid stream, reports owner-login-missing without creating ROOT, refuses seed under owner, a near-expiry owner and a ROOT inside the owner directory, without calling podman', (t) => {
  const base = sandbox(t);
  const home = path.join(base, 'home');
  const ownerDir = path.join(home, '.codex');
  const ownerFile = path.join(ownerDir, 'auth.json');
  const root = path.join(base, 'state', 'assistos-codex-test-auth');
  const stubs = path.join(base, 'stubs');
  fs.mkdirSync(home, { mode: 0o700 });
  fs.mkdirSync(stubs);
  fs.writeFileSync(path.join(stubs, 'podman'), `#!/bin/sh\ntouch ${base}/podman-called\nexit 99\n`, { mode: 0o755 });
  fs.chmodSync(path.join(stubs, 'podman'), 0o755);
  const artifacts = path.join(base, 'artifacts');
  fs.mkdirSync(artifacts);
  // A literal child environment: a fake HOME, the podman stub first on PATH, and the variables the runtime facts would need.
  const baseEnv = { PATH: `${stubs}:/usr/bin:/bin`, HOME: home, CODEX_TEST_AUTH_ROOT: root, SMOKE_PLOINKY_BOX_CONTAINER: 'ploinky-box-fake-0123456789ab',
    SMOKE_WORKSPACE_ROOT: path.join(base, 'workspace') };
  // Every child, and every process it starts, loads the blocking guard first (NODE_OPTIONS is inherited).
  const cli = (subcommand, extra = {}, rest = []) => {
    const result = spawnSync(process.execPath, [CLI, subcommand, ...rest], { env: { ...baseEnv, NODE_OPTIONS: CHILD_NODE_OPTIONS, ...extra }, encoding: 'utf8', cwd: SMOKE_DIR, timeout: 60_000 });
    assert.equal(result.stderr.includes(GUARD_MARKER), false, 'a CLI child reached the real account .codex');
    assert.notEqual(result.status, 97);
    const lines = result.stdout.split('\n').filter(Boolean);
    assert.equal(lines.length, 1, `exactly one stdout line: ${result.stderr}`);
    return { status: result.status, line: JSON.parse(lines[0]), text: lines[0], stderr: result.stderr };
  };
  const expectFailure = (outcome, { code, reason, route, status }) => {
    assert.deepEqual([outcome.line.code, outcome.line.reason, outcome.line.route, outcome.status], [code, reason, route, status ?? EXIT_CODES[code]], outcome.text);
  };
  const noPodman = () => assert.equal(fs.existsSync(path.join(base, 'podman-called')), false, 'podman must never be called');
  // Writes a fabricated owner login that expires in `minutes` and returns exactly the bytes that were written.
  const putOwner = (minutes) => {
    const bytes = ownerLogin({ expMs: Date.now() + minutes * MINUTE, refreshed: Date.now() - HOUR });
    fs.mkdirSync(ownerDir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(ownerFile, bytes);
    fs.chmodSync(ownerFile, 0o600);
    return bytes;
  };
  const ownerState = () => [fs.readFileSync(ownerFile), fs.statSync(ownerFile).ino, fs.statSync(ownerFile).mtimeMs];
  // Positive control: a child that touches the real account's .codex is stopped by the guard, with the marker and exit 97, before any access.
  for (const probe of [`require('node:fs').existsSync(${JSON.stringify(path.join(REAL_HOME, '.codex', 'auth.json'))})`,
    `require('node:fs').readFileSync(${JSON.stringify(path.join(REAL_HOME, '.codex', 'auth.json'))})`,
    `require('node:fs').promises.stat(${JSON.stringify(path.join(REAL_HOME, '.codex'))}).then(() => process.exit(0), () => process.exit(0))`]) {
    const probed = spawnSync(process.execPath, ['-e', probe], { env: { PATH: '/usr/bin:/bin', HOME: home, NODE_OPTIONS: CHILD_NODE_OPTIONS }, encoding: 'utf8', timeout: 30_000 });
    assert.equal(probed.status, 97, probe.slice(0, 60));
    assert.equal(probed.stderr.includes(GUARD_MARKER), true);
  }
  // Owner missing: exit 10 with the owner reason, no ROOT and not even its parent is created.
  const missing = cli('preflight');
  expectFailure(missing, { code: 'NOT_SEEDED', reason: 'owner-login-missing', route: 'owner' });
  assert.equal(missing.line.result, 'not-ready');
  assert.equal(missing.line.stream, null);
  assert.equal(missing.line.owner.readable, false);
  assert.equal(missing.line.owner.source, 'default');
  assert.equal(fs.existsSync(path.join(base, 'state')), false);
  // The same through run: no ROOT, no Playwright, and a missing login is the early failure.
  const missingRun = cli('run', { SMOKE_ARTIFACT_DIR: artifacts, SMOKE_RUN_ID: 'a18-missing' });
  expectFailure(missingRun, { code: 'NOT_SEEDED', reason: 'owner-login-missing', route: 'owner' });
  assert.deepEqual([missingRun.line.ownerGate, missingRun.line.spawnedForRecovery], ['owner-login-missing', false]);
  assert.equal(fs.existsSync(path.join(artifacts, 'codex-auth')), false);
  assert.equal(fs.existsSync(path.join(base, 'state')), false);
  // The other routes and the variable: an explicit stream is the old behaviour, and bad values are refused.
  expectFailure(cli('preflight', { CODEX_TEST_AUTH_SOURCE: 'stream' }), { code: 'NOT_SEEDED', reason: 'no-stream', route: 'stream' });
  expectFailure(cli('preflight', { CODEX_TEST_AUTH_SOURCE: 'owner' }), { code: 'NOT_SEEDED', reason: 'owner-login-missing', route: 'owner' });
  for (const value of ['Owner', 'both', ' owner']) expectFailure(cli('preflight', { CODEX_TEST_AUTH_SOURCE: value }), { code: 'USAGE', reason: 'bad-variable', route: null });
  expectFailure(cli('seed', { CODEX_TEST_AUTH_SOURCE: 'owner' }), { code: 'USAGE', reason: 'route-mismatch', route: null });
  expectFailure(cli('retire', { CODEX_TEST_AUTH_SOURCE: 'owner' }), { code: 'USAGE', reason: 'route-mismatch', route: null });
  expectFailure(cli('adopt', { CODEX_TEST_AUTH_SOURCE: 'owner' }, ['run-1']), { code: 'USAGE', reason: 'route-mismatch', route: null });
  expectFailure(cli('seed'), { code: 'USAGE', reason: 'bad-variable', route: 'stream' });
  expectFailure(cli('bogus'), { code: 'USAGE', reason: 'bad-subcommand', route: null });
  assert.equal(fs.existsSync(path.join(base, 'state')), false);
  // A valid fabricated stream is accepted by the library, and a missing owner login still fails on the owner route, leaving it untouched.
  const paths = resolveAuthPaths({ HOME: home, CODEX_TEST_AUTH_ROOT: root });
  for (const directory of [root, paths.streamsDir, paths.streamDir]) fs.mkdirSync(directory, { mode: 0o700, recursive: true });
  fs.writeFileSync(paths.streamFile, streamLogin(), { mode: 0o600 });
  assert.doesNotThrow(() => loadStream(paths, { now: NOW }));
  const streamBefore = [fs.readFileSync(paths.streamFile), fs.statSync(paths.streamFile).ino, fs.statSync(paths.streamFile).mtimeMs];
  const fallback = cli('preflight');
  expectFailure(fallback, { code: 'NOT_SEEDED', reason: 'owner-login-missing', route: 'owner' });
  assert.equal(fallback.line.rootExists, true);
  assert.equal(fallback.line.inflight, 'absent');
  assert.equal(fallback.line.otherRouteInflight, false);
  expectFailure(cli('run', { SMOKE_ARTIFACT_DIR: artifacts, SMOKE_RUN_ID: 'a18-stream' }), { code: 'NOT_SEEDED', reason: 'owner-login-missing', route: 'owner' });
  assert.deepEqual([fs.readFileSync(paths.streamFile), fs.statSync(paths.streamFile).ino, fs.statSync(paths.streamFile).mtimeMs], streamBefore);
  // An owner login 39 minutes from expiry is refused with the gate's words, from both commands, and the stream is still not used.
  const nearOwner = putOwner(39);
  const ownerBefore = ownerState();
  const near = cli('preflight');
  expectFailure(near, { code: 'STREAM_UNSAFE', reason: 'access-near-expiry', route: 'owner' });
  assert.equal(near.line.owner.readable, true);
  assert.equal(near.line.owner.requiredValidMinutes, 40);
  assert.ok([38, 39].includes(near.line.owner.accessValidMinutes), String(near.line.owner.accessValidMinutes));
  assert.equal(near.line.owner.accountClaim, 'match');
  const nearRun = cli('run', { SMOKE_ARTIFACT_DIR: artifacts, SMOKE_RUN_ID: 'a18-near' });
  expectFailure(nearRun, { code: 'STREAM_UNSAFE', reason: 'access-near-expiry', route: 'owner' });
  assert.deepEqual([nearRun.line.ownerGate, nearRun.line.spawnedForRecovery], ['access-near-expiry', false]);
  assert.equal(fs.existsSync(path.join(artifacts, 'codex-auth')), false, 'Playwright was never started');
  // No output carries a token, the account id or a digest.
  const secrets = Object.values(parsed(nearOwner).tokens).concat(['acct-fake-0001']);
  for (const outcome of [missing, missingRun, fallback, near, nearRun]) {
    for (const secret of secrets) assert.equal(outcome.text.includes(secret), false);
    assert.equal(/[0-9a-f]{64}/.test(outcome.text), false);
  }
  // A pending route-A marker is reported before the owner gate, and a route-B marker or a route-A marker is refused by the other route.
  createInflight(paths, { ...MARKER, route: 'owner' });
  const pending = cli('preflight');
  expectFailure(pending, { code: 'STREAM_UNSAFE', reason: 'access-near-expiry', route: 'owner' });
  assert.equal(pending.line.inflight, 'present');
  assert.equal(pending.line.otherRouteInflight, false);
  expectFailure(cli('preflight', { CODEX_TEST_AUTH_SOURCE: 'stream' }), { code: 'STREAM_UNSAFE', reason: 'inflight-other-route', route: 'stream' });
  expectFailure(cli('run', { CODEX_TEST_AUTH_SOURCE: 'stream', SMOKE_ARTIFACT_DIR: artifacts, SMOKE_RUN_ID: 'a18-other' }), { code: 'STREAM_UNSAFE', reason: 'inflight-other-route', route: 'stream' });
  removeInflight(paths, { route: 'owner' });
  createInflight(paths, MARKER);
  const crossed = cli('preflight');
  expectFailure(crossed, { code: 'STREAM_UNSAFE', reason: 'inflight-other-route', route: 'owner' });
  assert.deepEqual([crossed.line.inflight, crossed.line.otherRouteInflight], ['absent', true]);
  expectFailure(cli('run', { SMOKE_ARTIFACT_DIR: artifacts, SMOKE_RUN_ID: 'a18-crossed' }), { code: 'STREAM_UNSAFE', reason: 'inflight-other-route', route: 'owner' });
  removeInflight(paths);
  assert.deepEqual(ownerState(), ownerBefore, 'the owner login was not written by any command');
  // A ROOT inside the owner directory is refused as a location, and so is an artifact directory there. Nothing is created inside.
  const goodOwner = putOwner(240 * 60);
  const insideRoot = path.join(ownerDir, 'state', 'root');
  expectFailure(cli('preflight', { CODEX_TEST_AUTH_ROOT: insideRoot }), { code: 'STREAM_UNSAFE', reason: 'location', route: 'owner' });
  expectFailure(cli('run', { CODEX_TEST_AUTH_ROOT: insideRoot, SMOKE_ARTIFACT_DIR: artifacts, SMOKE_RUN_ID: 'a18-root' }), { code: 'STREAM_UNSAFE', reason: 'location', route: 'owner' });
  fs.mkdirSync(path.join(ownerDir, 'artifacts'));
  expectFailure(cli('run', { SMOKE_ARTIFACT_DIR: path.join(ownerDir, 'artifacts'), SMOKE_RUN_ID: 'a18-art' }), { code: 'USAGE', reason: 'artifact-dir-location', route: 'owner' });
  assert.equal(fs.existsSync(path.join(ownerDir, 'state')), false);
  assert.deepEqual(fs.readdirSync(path.join(ownerDir, 'artifacts')), []);
  // An owner override inside ROOT is refused as a location of ROOT, which is checked first. One inside the workspace root is an owner location.
  fs.mkdirSync(path.join(root, 'elsewhere'), { mode: 0o700 });
  fs.writeFileSync(path.join(root, 'elsewhere', 'auth.json'), goodOwner, { mode: 0o600 });
  expectFailure(cli('preflight', { CODEX_TEST_AUTH_OWNER_AUTH: path.join(root, 'elsewhere', 'auth.json') }), { code: 'STREAM_UNSAFE', reason: 'location', route: 'owner' });
  fs.mkdirSync(path.join(base, 'workspace', 'login'), { recursive: true });
  fs.writeFileSync(path.join(base, 'workspace', 'login', 'auth.json'), goodOwner, { mode: 0o600 });
  expectFailure(cli('preflight', { CODEX_TEST_AUTH_OWNER_AUTH: path.join(base, 'workspace', 'login', 'auth.json') }), { code: 'USAGE', reason: 'owner-location', route: 'owner' });
  // scan-leaks on the owner route: the owner's derived credential is found, a clean directory is clean, and no reference at all is refused.
  const derived = deriveAccessOnlyAuth(fs.readFileSync(ownerFile), { now: Date.now() }).derived;
  const scratch = path.join(base, 'scratch');
  fs.mkdirSync(scratch);
  fs.writeFileSync(path.join(scratch, 'out.log'), `noise ${derived.toString('base64')} noise`);
  const leaked = cli('scan-leaks', {}, [scratch]);
  expectFailure(leaked, { code: 'LEAK_DETECTED', reason: 'artifact-contains-token', route: 'owner' });
  assert.equal(leaked.line.ownerReferences, 'loaded');
  assert.ok(leaked.line.leaks >= 1);
  assert.equal(leaked.text.includes(derived.toString('base64')), false);
  // Every owner token is among the references, not only the derived credential: the refresh token and the id token are found too, and
  // a run of zero bytes is not a leak (a wiped reference would match it).
  const ownerTokens = parsed(goodOwner).tokens;
  const planted = (name, content) => { const directory = path.join(base, `planted-${name}`); fs.mkdirSync(directory); fs.writeFileSync(path.join(directory, 'out.log'), content); return directory; };
  for (const [name, value, field] of [['refresh', ownerTokens.refresh_token, 'refreshToken'], ['id', ownerTokens.id_token, 'idToken'], ['access', ownerTokens.access_token, 'accessToken']]) {
    const found = cli('scan-leaks', {}, [planted(name, `noise ${value} noise`)]);
    expectFailure(found, { code: 'LEAK_DETECTED', reason: 'artifact-contains-token', route: 'owner' });
    assert.ok(found.line.findings.some((finding) => finding.field === field), `${name}: ${found.text}`);
    assert.equal(found.text.includes(value), false);
  }
  const zeros = cli('scan-leaks', {}, [planted('zeros', Buffer.alloc(4096))]);
  assert.deepEqual([zeros.status, zeros.line.code, zeros.line.leaks, zeros.line.ownerReferences], [0, 'OK', 0, 'loaded']);
  const clean = path.join(base, 'clean');
  fs.mkdirSync(clean);
  fs.writeFileSync(path.join(clean, 'out.log'), 'nothing to see');
  const cleanRun = cli('scan-leaks', {}, [clean]);
  assert.deepEqual([cleanRun.status, cleanRun.line.code, cleanRun.line.leaks, cleanRun.line.ownerReferences, cleanRun.line.route], [0, 'OK', 0, 'loaded', 'owner']);
  fs.rmSync(ownerFile);
  fs.rmSync(root, { recursive: true });
  const nothing = cli('scan-leaks', {}, [clean]);
  expectFailure(nothing, { code: 'STREAM_UNSAFE', reason: 'scan-reference-missing', route: 'owner' });
  assert.equal(nothing.line.ownerReferences, 'unavailable');
  // Podman was never called by any command.
  noPodman();
});

test('the spec wires route A in the documented order: recovery before the owner read, qualification before injection, the route on every marker call, no quarantine check and a post-turn generation check', () => {
  const spec = fs.readFileSync(new URL('../specs/07-copilot-codex-native.spec.mjs', import.meta.url), 'utf8');
  const at = (needle, from = 0) => { const index = spec.indexOf(needle, from); assert.notEqual(index, -1, `the spec must contain: ${needle}`); return index; };
  // The route is resolved once, with the same function as the parent, before the result is created.
  assert.equal(spec.split("resolveCredentialSource(process.env, { command: 'run' })").length, 2);
  assert.ok(at("resolveCredentialSource(process.env, { command: 'run' })") < at('const result = freshResult(runId, route)'));
  // Every marker call carries the route, so route A can never touch the route-B marker.
  for (const name of ['createInflight', 'readInflight', 'removeInflight']) {
    const calls = [...spec.matchAll(new RegExp(`\\b${name}\\(([^;]*?)\\)(?:;|\\))`, 'g'))].map((match) => match[1]).filter((argument) => argument.startsWith('paths'));
    assert.ok(calls.length >= 1, name);
    for (const argument of calls) assert.match(argument, /\broute\b/, `${name}(${argument})`);
  }
  // ROOT is created only by ensurePrivateRoot, under route A, with the owner directory forbidden.
  assert.equal(spec.split('ensurePrivateRoot(paths').length, 2);
  assert.match(spec, /ensurePrivateRoot\(paths, \{ forbiddenRoots: \[[^\]]*ownerDirectoryFor\(process\.env, paths\)\]/);
  // No quarantine check under route A, and no stream reload at recovery.
  for (const match of spec.matchAll(/assertNoQuarantine\(paths\)/g)) {
    const line = spec.slice(spec.lastIndexOf('\n', match.index) + 1, spec.indexOf('\n', match.index));
    assert.match(line, /route === 'stream'/, line);
  }
  assert.match(spec, /if \(route === 'stream'\) recordBefore\(session\.state\.loaded\.summary\)/);
  // Order: browser recovery (marker removal), then the recovery refusal, then the owner read, then the new marker, then qualification, then injection.
  const recovery = at('removeInflight(paths, { route })');
  const refusal = at('if (recoveryRefusal) throw recoveryRefusal;');
  const load = at('await session.load({ ownerFile: resolved.file })');
  const marker = at('createInflight(paths, { runId, robotName, folder, route })');
  const qualify = at('checkClientQualification({ runtime, identity: client })');
  const inject = at('await session.inject(robot)');
  assert.ok(recovery < refusal && refusal < load && load < marker && marker < qualify && qualify < inject, 'the steps are out of order');
  // The owner read happens inside its own budget and never before the recovery block of step 2, which has no owner read.
  assert.ok(at('BUDGET.derive') < load);
  const recoverCall = at('session.recover(recoveryPending.robot)');
  assert.ok(recoverCall < load);
  assert.equal(spec.slice(0, recoverCall).includes('session.load('), true, 'route B still loads its stream before the recovery');
  assert.match(spec.slice(0, recoverCall), /else recordBefore\(session\.load\(\)\.summary\)/);
  assert.equal(spec.split('session.load(').length, 3, 'one load per route');
  // The inject gate keeps its own reason, and the budgets and slack come from named constants.
  assert.match(spec, /if \(route === 'owner' && error instanceof CodexAuthError\) throw error;/);
  assert.match(spec, /derive: 15_000, qualify: 60_000/);
  assert.match(spec, /const TURN_SLACK_MS = 10_000;/);
  assert.match(spec, /injectWindowMs: BUDGET\.inject \+ BUDGET\.turn \+ TURN_SLACK_MS/);
  assert.match(spec, /within\(BUDGET\.turn \+ TURN_SLACK_MS,/);
  assert.match(spec, /runDeadline: testStartedAt \+ RUN_TIMEOUT_MS/);
  assert.equal(/BUDGET\.turn \+ 10_000/.test(spec), false, 'no literal turn slack');
  // The post-turn generation check fails with binding-changed, and the route-A fields reach result.json.
  assert.match(spec, /route === 'owner' && qualified\?\.status === 'qualified' && result\.codexClient\.post\?\.generation12 !== qualified\.generation12/);
  assert.match(spec, /if \(session && route === 'owner'\) \{/);
  assert.match(spec, /gateAtDerive: gates\.atDerive, gateAtInject: gates\.atInject/);
  assert.match(spec, /result\.runtimeCopy = runtimeCopy;\s*result\.recoveredCopy = recoveredCopy;/);
  assert.match(spec, /if \(session && route === 'stream'\) \{\s*Object\.assign\(result\.stream, session\.state\.stream\);/);
  assert.match(spec, /if \(route === 'owner'\) session\?\.release\(\);/);
  // No credential reaches argv, the environment or a stream-style file from this spec: it only reads the owner login through the owner module.
  assert.equal(/auth\.json|\.codex\b/.test(spec.replace(/\/\/[^\n]*/g, '')), false, 'the spec never names the login file');
});

test('no test in this file touched the real account\'s .codex directory', () => {
  assert.deepEqual(blockedAccess, []);
  // Positive control: the guard does block an access to the guarded directory.
  assert.throws(() => fs.existsSync(path.join(REAL_HOME, '.codex')), /blocked access to the real account \.codex/);
  assert.equal(blockedAccess.length, 1);
  blockedAccess.length = 0;
});
