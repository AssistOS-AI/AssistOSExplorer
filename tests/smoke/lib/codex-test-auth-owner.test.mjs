import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  CodexAuthError, EXIT_CODES, EXIT_REASONS, assertArtifactDirectory, assertNoOtherRouteInflight, assertPrivateRoot, adoptQuarantine, createInflight,
  decideRunOutcome, ensurePrivateRoot, inflightPresent, lockStatus, readInflight, removeInflight, resolveAuthPaths, resultLine, retireStream,
  seedStream,
} from './codex-test-auth.mjs';

// Route A tests. Every credential here is fabricated. The file refuses to start under the account's own home and blocks
// every access to the account's real Codex directory, so a defect can never reach a real login (decision L).
const REAL_HOME = os.userInfo().homedir;
const realOf = (value) => { try { return fs.realpathSync(value); } catch { return path.resolve(value); } };
if (!process.env.HOME || path.resolve(process.env.HOME) === path.resolve(REAL_HOME) || realOf(process.env.HOME) === realOf(REAL_HOME)) {
  throw new Error('Refusing to start: run with HOME set to a temporary directory.');
}

// Both spellings of the guarded root are computed before any wrapper is installed.
const GUARDED_ROOTS = [path.join(REAL_HOME, '.codex'), path.join(realOf(REAL_HOME), '.codex')];
const blockedAccess = [];

function guardedPath(argument) {
  let raw = null;
  if (typeof argument === 'string') raw = argument;
  else if (Buffer.isBuffer(argument)) raw = argument.toString('utf8');
  else if (argument instanceof URL) { try { raw = fileURLToPath(argument); } catch { raw = null; } }
  if (raw === null || raw === '' || raw.includes('\0')) return false;
  const resolved = path.resolve(raw);
  return GUARDED_ROOTS.some((root) => resolved === root || resolved.startsWith(`${root}${path.sep}`));
}

function installGuard(target, names, { promise = false } = {}) {
  for (const name of names) {
    const original = target[name];
    if (typeof original !== 'function') continue;
    const wrapped = Object.assign(function guarded(...args) {
      if (args.some(guardedPath)) {
        blockedAccess.push(name);
        const error = new Error('blocked access to the real account .codex');
        if (promise) return Promise.reject(error);
        throw error;
      }
      return original.apply(this, args);
    }, original);
    target[name] = wrapped;
  }
}

installGuard(fs, ['openSync', 'readFileSync', 'readdirSync', 'lstatSync', 'statSync', 'existsSync', 'accessSync', 'realpathSync', 'opendirSync',
  'readlinkSync', 'createReadStream', 'copyFileSync', 'linkSync', 'renameSync', 'unlinkSync', 'rmSync', 'writeFileSync', 'mkdirSync', 'chmodSync',
  'open', 'readFile', 'stat', 'lstat', 'realpath', 'access', 'readdir']);
installGuard(fs.realpathSync, ['native']);
installGuard(fs.promises, ['open', 'readFile', 'readdir', 'lstat', 'stat', 'access', 'realpath', 'readlink'], { promise: true });

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
