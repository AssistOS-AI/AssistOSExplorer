import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import {
  CodexAuthError, EXIT_CODES, EXIT_REASONS, acceptCopyBack, acquireRunLock, adoptQuarantine, assertArtifactDirectory, assertNoQuarantine, assertPrivateRoot,
  classifyTurnFailure, createInflight, describeFailure, inspectLock, inspectStream, loadStream, lockStatus, planRecovery, readInflight,
  removeInflight, resolveAuthPaths, resultLine, retireStream, robotDeleteAccepted, scanLeaks, seedStream, sha256Hex, summarizeAuth,
  validateAuthArtifact,
} from './codex-test-auth.mjs';

// Synthetic, unsigned JWT-shaped tokens only. Nothing here is, or was copied from, a real credential.
const NOW = Date.parse('2026-10-03T12:00:00.000Z');
const HOUR = 3_600_000;
const b64 = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
const jwt = (seed, expMs = NOW + 240 * HOUR) => `${b64({ alg: 'none', typ: 'JWT' })}.${b64({ exp: Math.floor(expMs / 1000), sub: seed })}.`;

function auth({ seed = 'a', account = 'acct-fake-0001', refreshed = NOW - HOUR, expMs, mode = 'chatgpt', extra = {} } = {}) {
  return Buffer.from(JSON.stringify({
    auth_mode: mode, OPENAI_API_KEY: null,
    tokens: { id_token: jwt(`id-${seed}`, expMs), access_token: jwt(`access-${seed}`, expMs), refresh_token: `rt-fake-${seed}-0123456789abcdef`, account_id: account },
    last_refresh: new Date(refreshed).toISOString(), ...extra,
  }));
}

const failure = (code, reason) => (error) => error instanceof CodexAuthError && error.code === code && error.reason === reason
  && error.exitCode === EXIT_CODES[code];

function sandbox(t) {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cta-lib-')));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  return base;
}

function fakeProc(base, { boot = 'boot-1', pids = {} } = {}) {
  const proc = path.join(base, 'proc');
  fs.mkdirSync(path.join(proc, 'sys/kernel/random'), { recursive: true });
  fs.writeFileSync(path.join(proc, 'sys/kernel/random/boot_id'), `${boot}\n`);
  const set = (pid, { start, state = 'S', name = 'node (x) y' }) => {
    fs.mkdirSync(path.join(proc, String(pid)), { recursive: true });
    // Fields after the last ')' begin with the state (field 3); field 22 is the start time.
    fs.writeFileSync(path.join(proc, String(pid), 'stat'), `${pid} (${name}) ${[state, ...Array(18).fill('0'), start, '0', '0'].join(' ')}\n`);
  };
  set(process.pid, { start: '4242' });
  for (const [pid, value] of Object.entries(pids)) set(pid, value);
  return { dir: proc, set, boot };
}

function setup(t, { stream = null, envExtra = {} } = {}) {
  const base = sandbox(t);
  const home = path.join(base, 'home');
  fs.mkdirSync(home, { mode: 0o700 });
  const root = path.join(base, 'state', 'assistos-codex-test-auth');
  const paths = resolveAuthPaths({ HOME: home, CODEX_TEST_AUTH_ROOT: root, ...envExtra });
  const proc = fakeProc(base);
  if (stream) {
    for (const directory of [root, paths.streamsDir, paths.streamDir]) fs.mkdirSync(directory, { mode: 0o700, recursive: true });
    fs.writeFileSync(paths.streamFile, stream, { mode: 0o600 });
  }
  return { base, home, root, paths, proc };
}

function writeLive(home, bytes) {
  fs.mkdirSync(path.join(home, '.codex'), { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(home, '.codex', 'auth.json'), bytes, { mode: 0o600 });
}

function snapshot(root) {
  const rows = [];
  const visit = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const full = path.join(directory, entry.name);
      const stat = fs.lstatSync(full);
      rows.push([path.relative(root, full), stat.ino, stat.size, stat.mtimeMs, stat.mode].join(' '));
      if (entry.isDirectory()) visit(full);
    }
  };
  visit(root);
  return rows.sort();
}

const SEED_BIN = '/opt/fake/standalone/releases/0.159.3-x86_64-unknown-linux-musl/bin/codex';
const seedWith = (paths, proc, writer, extra = {}) => seedStream(paths, { seedBin: SEED_BIN, now: NOW, procRoot: proc.dir,
  waitForOperator: async (info) => { await writer(info); }, ...extra });
const placeSeed = (paths, bytes) => fs.writeFileSync(path.join(paths.seedCodexHome, 'auth.json'), bytes, { mode: 0o600 });

test('resolveAuthPaths defaults to the XDG state root and rejects relative roots', () => {
  const xdg = resolveAuthPaths({ HOME: '/home/u', XDG_STATE_HOME: '/state/x' });
  assert.equal(xdg.root, '/state/x/assistos-codex-test-auth');
  assert.equal(xdg.streamFile, '/state/x/assistos-codex-test-auth/streams/apparatus-copilot/auth.json');
  assert.equal(xdg.lockPath, '/state/x/assistos-codex-test-auth/run.lock');
  assert.equal(xdg.inflightPath, '/state/x/assistos-codex-test-auth/inflight.json');
  assert.equal(xdg.seedCodexHome, '/state/x/assistos-codex-test-auth/seed/codex');
  assert.equal(resolveAuthPaths({ HOME: '/home/u' }).root, '/home/u/.local/state/assistos-codex-test-auth');
  assert.equal(resolveAuthPaths({ HOME: '/home/u', XDG_STATE_HOME: '' }).root, '/home/u/.local/state/assistos-codex-test-auth');
  assert.equal(resolveAuthPaths({ HOME: '/h', CODEX_TEST_AUTH_ROOT: '/r', CODEX_TEST_AUTH_STREAM: 'abc' }).streamDir, '/r/streams/abc');
  assert.throws(() => resolveAuthPaths({ HOME: '/h', CODEX_TEST_AUTH_ROOT: 'relative/root' }), failure('USAGE', 'relative-path'));
  assert.throws(() => resolveAuthPaths({ HOME: '/h', XDG_STATE_HOME: 'state' }), failure('USAGE', 'relative-path'));
  assert.throws(() => resolveAuthPaths({}), failure('USAGE', 'bad-variable'));
  for (const stream of ['ab', 'Abc', '-abc', 'a'.repeat(42), 'a b c', '../x']) {
    assert.throws(() => resolveAuthPaths({ HOME: '/h', CODEX_TEST_AUTH_STREAM: stream }), failure('USAGE', 'bad-variable'));
  }
});

test('assertPrivateRoot rejects roots inside a git work tree, the workspace, the artifact directory or the smoke checkout', (t) => {
  const base = sandbox(t);
  const mk = (...parts) => { const directory = path.join(base, ...parts); fs.mkdirSync(directory, { recursive: true }); return directory; };
  const clean = mk('clean');
  const paths = (root) => resolveAuthPaths({ HOME: base, CODEX_TEST_AUTH_ROOT: root });
  assert.deepEqual(assertPrivateRoot(paths(path.join(clean, 'root')), { forbiddenRoots: [] }), { root: path.join(clean, 'root'), exists: false });
  const tree = mk('tree');
  fs.mkdirSync(path.join(tree, '.git'));
  assert.throws(() => assertPrivateRoot(paths(path.join(tree, 'deep', 'root'))), failure('STREAM_UNSAFE', 'location'));
  const workspace = mk('workspace');
  const artifacts = mk('artifacts');
  const checkout = mk('checkout', 'tests', 'smoke');
  for (const forbidden of [workspace, artifacts, path.join(base, 'checkout')]) {
    const inside = path.join(forbidden, 'root');
    assert.throws(() => assertPrivateRoot(paths(inside), { forbiddenRoots: [workspace, artifacts, path.join(base, 'checkout')] }),
      failure('STREAM_UNSAFE', 'location'), forbidden);
  }
  // The other direction: an artifact directory inside ROOT is rejected too.
  const outer = mk('outer');
  assert.throws(() => assertPrivateRoot(paths(outer), { forbiddenRoots: [path.join(outer, 'artifacts')] }), failure('STREAM_UNSAFE', 'location'));
  // A symlink into a forbidden tree is resolved before the comparison.
  fs.symlinkSync(workspace, path.join(base, 'link'));
  assert.throws(() => assertPrivateRoot(paths(path.join(base, 'link', 'root')), { forbiddenRoots: [workspace] }), failure('STREAM_UNSAFE', 'location'));
  assert.ok(checkout);
  assert.doesNotThrow(() => assertPrivateRoot(paths(path.join(clean, 'other')), { forbiddenRoots: [workspace, artifacts, path.join(base, 'checkout')] }));
});

test('stream directories must be 0700 and files 0600 and owned by the caller', (t) => {
  const { paths, root } = setup(t, { stream: auth() });
  const uid = process.getuid();
  assert.doesNotThrow(() => assertPrivateRoot(paths));
  assert.equal(loadStream(paths, { now: NOW }).summary.authMode, 'chatgpt');
  assert.throws(() => assertPrivateRoot(paths, { uid: uid + 1 }), failure('STREAM_UNSAFE', 'owner-or-mode'));
  for (const directory of [root, paths.streamsDir, paths.streamDir]) {
    fs.chmodSync(directory, 0o755);
    assert.throws(() => assertPrivateRoot(paths), failure('STREAM_UNSAFE', 'owner-or-mode'), directory);
    fs.chmodSync(directory, 0o700);
  }
  fs.chmodSync(paths.streamFile, 0o644);
  assert.throws(() => assertPrivateRoot(paths), failure('STREAM_UNSAFE', 'owner-or-mode'));
  assert.throws(() => loadStream(paths, { now: NOW }), failure('STREAM_UNSAFE', 'owner-or-mode'));
  fs.chmodSync(paths.streamFile, 0o600);
  fs.writeFileSync(path.join(paths.streamDir, 'quarantine-r1.json'), auth(), { mode: 0o644 });
  assert.throws(() => assertPrivateRoot(paths), failure('STREAM_UNSAFE', 'owner-or-mode'));
  fs.rmSync(path.join(paths.streamDir, 'quarantine-r1.json'));
  // A symlinked stream file, a hard-linked stream file and a symlinked root are all refused.
  const elsewhere = path.join(path.dirname(root), 'elsewhere.json');
  fs.writeFileSync(elsewhere, auth(), { mode: 0o600 });
  fs.rmSync(paths.streamFile);
  fs.symlinkSync(elsewhere, paths.streamFile);
  assert.throws(() => assertPrivateRoot(paths), failure('STREAM_UNSAFE', 'owner-or-mode'));
  assert.throws(() => loadStream(paths, { now: NOW }), failure('STREAM_UNSAFE', 'owner-or-mode'));
  fs.rmSync(paths.streamFile);
  fs.linkSync(elsewhere, paths.streamFile);
  assert.throws(() => loadStream(paths, { now: NOW }), failure('STREAM_UNSAFE', 'owner-or-mode'));
  fs.rmSync(paths.streamFile);
  assert.throws(() => loadStream(paths, { now: NOW }), failure('NOT_SEEDED', 'no-stream'));
  const linked = resolveAuthPaths({ HOME: '/h', CODEX_TEST_AUTH_ROOT: path.join(path.dirname(root), 'linked-root') });
  fs.symlinkSync(root, linked.root);
  assert.throws(() => assertPrivateRoot(linked), failure('STREAM_UNSAFE', 'owner-or-mode'));
});

test('acquireRunLock uses link(2), grants one owner and reports LOCK_HELD for a live owner', (t) => {
  const { paths, root, proc } = setup(t, { stream: auth() });
  const links = [];
  const original = fs.linkSync;
  fs.linkSync = (from, to) => { links.push([from, to]); return original(from, to); };
  t.after(() => { fs.linkSync = original; });
  const first = acquireRunLock(paths, { runId: 'run-one', procRoot: proc.dir, now: NOW });
  fs.linkSync = original;
  assert.equal(links.length, 1);
  assert.equal(links[0][1], paths.lockPath);
  assert.match(path.basename(links[0][0]), /^\.run-owner-[0-9a-f]{32}\.json$/);
  const owner = JSON.parse(fs.readFileSync(paths.lockPath, 'utf8'));
  assert.deepEqual(Object.keys(owner).sort(), ['boot', 'pid', 'runId', 'start', 'startedAt', 'token']);
  assert.equal(owner.pid, process.pid);
  assert.equal(owner.start, '4242');
  assert.equal(owner.boot, 'boot-1');
  assert.equal(fs.statSync(paths.lockPath).nlink, 2);
  assert.equal(fs.statSync(paths.lockPath).mode & 0o777, 0o600);
  assert.equal(inspectLock(paths, { procRoot: proc.dir }), 'held');
  assert.throws(() => acquireRunLock(paths, { runId: 'run-two', procRoot: proc.dir }), failure('LOCK_HELD', 'live-owner'));
  // The failed attempt leaves no candidate or claim file behind.
  assert.deepEqual(fs.readdirSync(root).filter((name) => name.startsWith('.run-')).length, 1);
  first.release();
  first.release();
  assert.equal(fs.existsSync(paths.lockPath), false);
  assert.deepEqual(fs.readdirSync(root).filter((name) => name.startsWith('.run-')), []);
  assert.equal(inspectLock(paths, { procRoot: proc.dir }), 'free');
  acquireRunLock(paths, { runId: 'run-three', procRoot: proc.dir }).release();
  assert.throws(() => acquireRunLock(paths, { runId: '../bad', procRoot: proc.dir }), failure('USAGE', 'bad-variable'));
});

test('acquireRunLock recovers only a provably dead owner and refuses an ambiguous owner', (t) => {
  const { paths, root, proc } = setup(t, { stream: auth() });
  const token = 'c'.repeat(32);
  const writeOwner = (owner, name = `.run-owner-${token}.json`) => {
    const candidate = path.join(root, name);
    fs.writeFileSync(candidate, JSON.stringify(owner), { mode: 0o600 });
    fs.linkSync(candidate, paths.lockPath);
    return candidate;
  };
  const drop = () => { for (const name of fs.readdirSync(root)) if (name.startsWith('.run-') || name === 'run.lock') fs.rmSync(path.join(root, name)); };
  const dead = { pid: 777777, start: '9', boot: 'boot-1', token, runId: 'old', startedAt: new Date(NOW).toISOString() };
  const deadCases = {
    'pid is gone': dead,
    'start time differs': { ...dead, pid: 555, start: '1' },
    'boot differs': { ...dead, pid: process.pid, start: '4242', boot: 'older-boot' },
    'zombie': { ...dead, pid: 556, start: '2' },
  };
  proc.set(555, { start: '2' });
  proc.set(556, { start: '2', state: 'Z' });
  for (const [label, owner] of Object.entries(deadCases)) {
    const candidate = writeOwner(owner);
    fs.writeFileSync(path.join(paths.streamDir, 'auth.json.next-oldrun'), 'x', { mode: 0o600 });
    fs.writeFileSync(path.join(paths.streamDir, 'quarantine-keep.json'), 'q', { mode: 0o600 });
    assert.equal(inspectLock(paths, { procRoot: proc.dir }), 'stale', label);
    const lock = acquireRunLock(paths, { runId: 'new-run', procRoot: proc.dir, now: NOW });
    assert.equal(lock.recovered, true, label);
    assert.equal(fs.existsSync(candidate), false, `${label}: the dead owner's candidate file is removed`);
    assert.deepEqual(fs.readdirSync(paths.streamDir).sort(), ['auth.json', 'quarantine-keep.json'], `${label}: next-credential files are swept, nothing else`);
    assert.equal(JSON.parse(fs.readFileSync(paths.lockPath, 'utf8')).runId, 'new-run');
    lock.release();
    fs.rmSync(path.join(paths.streamDir, 'quarantine-keep.json'));
    drop();
  }
  // A live owner is never recovered, and a held lock is not swept.
  const live = acquireRunLock(paths, { runId: 'live-run', procRoot: proc.dir });
  fs.writeFileSync(path.join(paths.streamDir, 'auth.json.next-keep'), 'x', { mode: 0o600 });
  assert.throws(() => acquireRunLock(paths, { runId: 'other', procRoot: proc.dir }), failure('LOCK_HELD', 'live-owner'));
  assert.equal(fs.existsSync(path.join(paths.streamDir, 'auth.json.next-keep')), true);
  live.release();
  fs.rmSync(path.join(paths.streamDir, 'auth.json.next-keep'));
  // Ambiguous owners (unparsable, wrong shape, symlinked lock) are refused and left in place.
  for (const content of ['not json', JSON.stringify({ pid: 'x' }), JSON.stringify({ ...dead, token: '../etc' })]) {
    const candidate = path.join(root, '.run-owner-ambiguous');
    fs.writeFileSync(candidate, content, { mode: 0o600 });
    fs.linkSync(candidate, paths.lockPath);
    assert.equal(inspectLock(paths, { procRoot: proc.dir }), 'held');
    assert.throws(() => acquireRunLock(paths, { runId: 'new-run', procRoot: proc.dir }), failure('LOCK_HELD', 'ambiguous-owner'), content);
    assert.equal(fs.readFileSync(paths.lockPath, 'utf8'), content);
    drop();
  }
  fs.symlinkSync(path.join(root, 'nowhere'), paths.lockPath);
  assert.throws(() => acquireRunLock(paths, { runId: 'new-run', procRoot: proc.dir }), failure('LOCK_HELD', 'ambiguous-owner'));
  drop();
  assert.deepEqual(fs.readdirSync(root).sort(), ['streams']);
});

test('seed imports only ROOT/seed/codex/auth.json, removes the seed area, refuses while a stream exists and succeeds again only after retire', async (t) => {
  const { paths, home, root, proc } = setup(t);
  writeLive(home, auth({ seed: 'live', account: 'acct-fake-live' }));
  const liveBefore = snapshot(path.join(home, '.codex'));
  const seen = [];
  const seed = auth({ seed: 'seeded' });
  const summary = await seedWith(paths, proc, ({ command }) => {
    seen.push(command);
    // Only seed/codex/auth.json is imported; a decoy elsewhere in the seed area is ignored and removed.
    fs.mkdirSync(path.join(paths.seedHome, '.codex'), { recursive: true });
    fs.writeFileSync(path.join(paths.seedHome, '.codex', 'auth.json'), auth({ seed: 'decoy' }));
    placeSeed(paths, seed);
  });
  assert.equal(seen.length, 1);
  assert.equal(seen[0], `HOME='${root}/seed/home' CODEX_HOME='${root}/seed/codex' '${SEED_BIN}' -c cli_auth_credentials_store=file login --device-auth`);
  assert.deepEqual(fs.readFileSync(paths.streamFile), seed);
  assert.equal(summary.mainLoginUnchanged, true);
  assert.equal(summary.auth.authMode, 'chatgpt');
  assert.equal(summary.seedClientVersion, '0.159.3');
  assert.equal(summary.seedClientPath, SEED_BIN);
  assert.equal(fs.existsSync(paths.seedDir), false);
  assert.deepEqual(fs.readdirSync(root).sort(), ['streams']);
  assert.equal(fs.statSync(root).mode & 0o777, 0o700);
  assert.equal(fs.statSync(paths.streamDir).mode & 0o777, 0o700);
  assert.equal(fs.statSync(paths.streamFile).mode & 0o777, 0o600);
  assert.deepEqual(snapshot(path.join(home, '.codex')), liveBefore, 'the main login is not touched');
  assert.equal(JSON.stringify(summary).includes('seeded'), false);
  assert.doesNotThrow(() => assertPrivateRoot(paths));
  // A second seed is refused before the operator step runs, and the stream is untouched.
  let asked = false;
  await assert.rejects(seedWith(paths, proc, () => { asked = true; }), failure('ALREADY_SEEDED', 'stream-exists'));
  assert.equal(asked, false);
  assert.deepEqual(fs.readFileSync(paths.streamFile), seed);
  assert.equal(fs.existsSync(paths.seedDir), false);
  // A leftover seed file is never imported; the refusal also clears it.
  const retired = retireStream(paths, { now: NOW, procRoot: proc.dir });
  assert.match(retired.retiredTo, /^apparatus-copilot-20261003T120000Z$/);
  fs.mkdirSync(paths.seedCodexHome, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(paths.seedCodexHome, 'auth.json'), auth({ seed: 'planted' }));
  await assert.rejects(seedWith(paths, proc, () => assert.fail('no operator step')), failure('STREAM_UNSAFE', 'seed-already-present'));
  assert.equal(fs.existsSync(paths.seedDir), false);
  assert.equal(fs.existsSync(paths.streamFile), false);
  const second = auth({ seed: 'second', account: 'acct-fake-0002' });
  await seedWith(paths, proc, () => placeSeed(paths, second));
  assert.deepEqual(fs.readFileSync(paths.streamFile), second);
  assert.equal(fs.existsSync(path.join(paths.retiredDir, retired.retiredTo, 'auth.json')), true);
  // The seed lock is released on every path, and a held lock is never disturbed by a refused seed.
  assert.equal(inspectLock(paths, { procRoot: proc.dir }), 'free');
  const other = setup(t);
  fs.mkdirSync(other.paths.root, { mode: 0o700, recursive: true });
  const holder = acquireRunLock(other.paths, { runId: 'holder', procRoot: other.proc.dir });
  fs.mkdirSync(other.paths.seedCodexHome, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(other.paths.seedCodexHome, 'progress.txt'), 'operator login in progress');
  await assert.rejects(seedWith(other.paths, other.proc, () => assert.fail('no operator step')), failure('LOCK_HELD', 'live-owner'));
  assert.equal(fs.readFileSync(path.join(other.paths.seedCodexHome, 'progress.txt'), 'utf8'), 'operator login in progress');
  holder.release();
  await assert.rejects(seedStream(paths, { seedBin: 'relative/codex', waitForOperator() {} }), failure('USAGE', 'bad-variable'));
  await assert.rejects(seedStream(paths, { waitForOperator() {} }), failure('USAGE', 'bad-variable'));
});

test('seed refuses API-key, PAT, Bedrock, non-chatgpt, missing-field, symlinked and live-cache-equal artifacts', async (t) => {
  const refusals = [
    ['api-key', auth({ extra: { OPENAI_API_KEY: 'sk-fake-not-a-key' } }), 'auth-invalid:api-key'],
    ['pat', auth({ extra: { personal_access_token: 'pat-fake' } }), 'auth-invalid:pat'],
    ['bedrock key', auth({ extra: { bedrock_api_key: { key: 'x' } } }), 'auth-invalid:bedrock'],
    ['bedrock access keys', auth({ extra: { bedrock_access_keys: { id: 'x' } } }), 'auth-invalid:bedrock'],
    ['apikey mode', auth({ mode: 'apikey' }), 'auth-invalid:not-chatgpt'],
    ['no mode', Buffer.from(JSON.stringify({ tokens: {}, last_refresh: new Date(NOW).toISOString() })), 'auth-invalid:not-chatgpt'],
    ['missing refresh token', Buffer.from(JSON.stringify({ auth_mode: 'chatgpt', tokens: { id_token: 'a', access_token: 'b', account_id: 'c' }, last_refresh: new Date(NOW).toISOString() })), 'auth-invalid:missing-field'],
    ['missing last_refresh', Buffer.from(JSON.stringify({ auth_mode: 'chatgpt', tokens: { id_token: 'a', access_token: 'b', refresh_token: 'r', account_id: 'c' } })), 'auth-invalid:missing-field'],
    ['not an ISO date', auth({ extra: { last_refresh: 'yesterday' } }), 'auth-invalid:missing-field'],
    ['empty file', Buffer.alloc(0), 'auth-invalid:missing-field'],
    ['truncated JSON', auth().subarray(0, 40), 'auth-invalid:missing-field'],
    ['array', Buffer.from('[]'), 'auth-invalid:missing-field'],
    ['oversize', Buffer.alloc(65_537, 0x20), 'auth-invalid:oversize'],
    ['future last_refresh by 5 min + 1 s', auth({ refreshed: NOW + 5 * 60_000 + 1000 }), 'auth-invalid:future-last-refresh'],
  ];
  for (const [label, bytes, reason] of refusals) {
    const { paths, home, proc } = setup(t);
    writeLive(home, auth({ seed: 'live', account: 'acct-fake-live' }));
    await assert.rejects(seedWith(paths, proc, () => placeSeed(paths, bytes)), failure('STREAM_UNSAFE', reason), label);
    assert.equal(fs.existsSync(paths.streamFile), false, `${label}: nothing is imported`);
    assert.equal(fs.existsSync(paths.seedDir), false, `${label}: the seed area is removed`);
    assert.equal(inspectLock(paths, { procRoot: proc.dir }), 'free', label);
  }
  // The boundary values that must be accepted.
  for (const bytes of [auth({ refreshed: NOW + 5 * 60_000 }), Buffer.concat([auth(), Buffer.alloc(0)])]) {
    const { paths, proc } = setup(t);
    await seedWith(paths, proc, () => placeSeed(paths, bytes));
    assert.deepEqual(fs.readFileSync(paths.streamFile), bytes);
  }
  // Symlinked source file and a symlinked seed/codex directory.
  {
    const { paths, base, proc } = setup(t);
    fs.writeFileSync(path.join(base, 'target.json'), auth(), { mode: 0o600 });
    await assert.rejects(seedWith(paths, proc, () => fs.symlinkSync(path.join(base, 'target.json'), path.join(paths.seedCodexHome, 'auth.json'))),
      failure('STREAM_UNSAFE', 'seed-source-symlink'));
    assert.equal(fs.existsSync(paths.streamFile), false);
    assert.equal(fs.existsSync(paths.seedDir), false);
  }
  {
    const { paths, base, proc } = setup(t);
    await assert.rejects(seedWith(paths, proc, () => {
      fs.rmSync(paths.seedCodexHome, { recursive: true });
      fs.mkdirSync(path.join(base, 'other-codex'));
      fs.writeFileSync(path.join(base, 'other-codex', 'auth.json'), auth(), { mode: 0o600 });
      fs.symlinkSync(path.join(base, 'other-codex'), paths.seedCodexHome);
    }), failure('STREAM_UNSAFE', 'seed-source-symlink'));
    assert.equal(fs.existsSync(paths.streamFile), false);
    assert.equal(fs.existsSync(paths.seedDir), false);
    assert.equal(fs.existsSync(path.join(base, 'other-codex', 'auth.json')), true, 'the symlink target is not deleted');
  }
  // No source file at all.
  {
    const { paths, proc } = setup(t);
    await assert.rejects(seedWith(paths, proc, () => {}), failure('STREAM_UNSAFE', 'seed-source-missing'));
    assert.equal(fs.existsSync(paths.seedDir), false);
  }
  // Tokens equal to the (fake) live cache: identical files and a single shared token.
  for (const shared of ['whole', 'refresh-only']) {
    const { paths, home, proc } = setup(t);
    const live = auth({ seed: 'live', account: 'acct-fake-live' });
    writeLive(home, live);
    const candidate = shared === 'whole' ? live
      : Buffer.from(JSON.stringify({ ...JSON.parse(auth({ seed: 'other' })), tokens: { ...JSON.parse(auth({ seed: 'other' })).tokens,
        refresh_token: JSON.parse(live).tokens.refresh_token } }));
    await assert.rejects(seedWith(paths, proc, () => placeSeed(paths, candidate)), failure('STREAM_UNSAFE', 'seed-equals-live-cache'), shared);
    assert.equal(fs.existsSync(paths.streamFile), false);
  }
});

test('seed reports mainLoginUnchanged true, inconclusive after a live refresh, and refuses when the main login changed otherwise', async (t) => {
  const live = auth({ seed: 'live', account: 'acct-fake-live', refreshed: NOW - 2 * HOUR });
  const scenarios = [
    ['unchanged', () => {}, true, null],
    ['no live cache at all', null, true, null],
    ['same account, newer last_refresh', (home) => writeLive(home, auth({ seed: 'live2', account: 'acct-fake-live', refreshed: NOW - HOUR })), 'inconclusive', null],
    ['same account, older last_refresh', (home) => writeLive(home, auth({ seed: 'live3', account: 'acct-fake-live', refreshed: NOW - 5 * HOUR })), null, 'main-login-changed'],
    ['other account', (home) => writeLive(home, auth({ seed: 'live4', account: 'acct-fake-other', refreshed: NOW - HOUR })), null, 'main-login-changed'],
    ['removed', (home) => fs.rmSync(path.join(home, '.codex', 'auth.json')), null, 'main-login-changed'],
    ['same bytes rewritten with a new mtime', (home) => { const file = path.join(home, '.codex', 'auth.json'); const bytes = fs.readFileSync(file); fs.rmSync(file); fs.writeFileSync(file, bytes, { mode: 0o600 }); fs.utimesSync(file, new Date('2020-01-01T00:00:00Z'), new Date('2020-01-01T00:00:00Z')); }, null, 'main-login-changed'],
  ];
  for (const [label, change, expected, refusal] of scenarios) {
    const { paths, home, proc } = setup(t);
    if (label !== 'no live cache at all') writeLive(home, live);
    const run = seedWith(paths, proc, () => { placeSeed(paths, auth({ seed: 'new', account: 'acct-fake-new' })); if (change) change(home); });
    if (refusal) {
      await assert.rejects(run, failure('STREAM_UNSAFE', refusal), label);
      assert.equal(fs.existsSync(paths.streamFile), false, `${label}: no import`);
    } else {
      assert.equal((await run).mainLoginUnchanged, expected, label);
      assert.equal(fs.existsSync(paths.streamFile), true, label);
    }
    assert.equal(fs.existsSync(paths.seedDir), false, label);
  }
});

test('summarizeAuth output never contains token or account values', () => {
  const bytes = auth({ seed: 'summary', account: 'acct-fake-private', refreshed: NOW - 30 * 60_000, expMs: NOW + 90 * 60_000 });
  const value = JSON.parse(bytes);
  const summary = summarizeAuth(bytes, NOW);
  assert.deepEqual(summary, { authMode: 'chatgpt', hasIdToken: true, hasAccessToken: true, hasRefreshToken: true, hasAccountId: true,
    hasLastRefresh: true, lastRefreshAgeHours: 0.5, accessValidHours: 1.5 });
  const text = JSON.stringify([summary, validateAuthArtifact(bytes, { now: NOW })]);
  for (const secret of [...Object.values(value.tokens), value.tokens.account_id, 'summary', 'acct-fake', 'rt-fake']) {
    assert.equal(text.includes(secret), false, secret);
  }
  assert.doesNotMatch(text, /refresh_token|access_token|id_token|account_id/);
  assert.equal(summarizeAuth(auth({ mode: 'surprising mode with spaces' }), NOW).authMode, 'other');
  assert.equal(summarizeAuth(Buffer.from(JSON.stringify({ auth_mode: 'chatgpt', tokens: { access_token: 'not-a-jwt' } })), NOW).accessValidHours, null);
  assert.equal(summarizeAuth(auth({ expMs: NOW - HOUR }), NOW).accessValidHours, -1);
  assert.throws(() => summarizeAuth(Buffer.from('nope'), NOW), failure('STREAM_UNSAFE', 'auth-invalid:missing-field'));
});

test('preflight and the run parent create or modify nothing under ROOT', (t) => {
  const { paths, root, proc } = setup(t, { stream: auth() });
  fs.writeFileSync(path.join(paths.streamDir, 'quarantine-old.json'), auth({ seed: 'q' }), { mode: 0o600 });
  const before = snapshot(root);
  for (let pass = 0; pass < 2; pass += 1) {
    assertPrivateRoot(paths, { forbiddenRoots: [path.join(root, '..', 'workspace')] });
    const state = inspectStream(paths, { now: NOW, procRoot: proc.dir });
    assert.deepEqual(state, { auth: state.auth, lock: 'free', inflight: 'absent', quarantineCount: 1 });
    loadStream(paths, { now: NOW });
    inspectLock(paths, { procRoot: proc.dir });
    assert.throws(() => assertNoQuarantine(paths), failure('STREAM_UNSAFE', 'quarantine-pending'));
  }
  assert.deepEqual(snapshot(root), before);
  // With a stale lock and an inflight marker the report still writes nothing.
  const token = 'd'.repeat(32);
  fs.writeFileSync(path.join(root, `.run-owner-${token}.json`), JSON.stringify({ pid: 888888, start: '1', boot: 'boot-1', token, runId: 'x', startedAt: 'y' }), { mode: 0o600 });
  fs.linkSync(path.join(root, `.run-owner-${token}.json`), paths.lockPath);
  createInflight(paths, { runId: 'run-x', robotName: 'codex-auth-test-run-x', folder: 'codex-auth-run-x' });
  const withState = snapshot(root);
  const state = inspectStream(paths, { now: NOW, procRoot: proc.dir });
  assert.equal(state.lock, 'stale');
  assert.equal(state.inflight, 'present');
  assert.deepEqual(snapshot(root), withState);
  // A missing or empty ROOT is reported as not seeded and is not created.
  const missing = resolveAuthPaths({ HOME: '/h', CODEX_TEST_AUTH_ROOT: path.join(root, '..', 'never-created') });
  assert.throws(() => inspectStream(missing, { now: NOW }), failure('NOT_SEEDED', 'no-stream'));
  assert.equal(fs.existsSync(missing.root), false);
  const empty = path.join(root, '..', 'empty-root');
  fs.mkdirSync(empty, { mode: 0o700 });
  assert.throws(() => inspectStream(resolveAuthPaths({ HOME: '/h', CODEX_TEST_AUTH_ROOT: empty }), { now: NOW }), failure('NOT_SEEDED', 'no-stream'));
  assert.deepEqual(fs.readdirSync(empty), []);
});

test('acceptCopyBack writes nothing for identical bytes and atomically replaces newer same-account bytes without a backup', (t) => {
  const loaded = auth({ seed: 'loaded', refreshed: NOW - 2 * HOUR });
  const { paths, root } = setup(t, { stream: loaded });
  const sha = sha256Hex(loaded);
  const before = snapshot(root);
  const none = acceptCopyBack(paths, { loadedSha256: sha, loadedBytes: loaded, runtimeBytes: Buffer.from(loaded), runId: 'run-a', now: NOW });
  assert.deepEqual(none, { replaced: false, refreshedDuringRun: false, lastRefreshAdvanced: false, sameAccount: true });
  assert.deepEqual(snapshot(root), before);
  const renames = [];
  const originalRename = fs.renameSync;
  fs.renameSync = (from, to) => { renames.push([path.basename(from), to]); return originalRename(from, to); };
  t.after(() => { fs.renameSync = originalRename; });
  const refreshed = auth({ seed: 'refreshed', refreshed: NOW - 60_000 });
  const done = acceptCopyBack(paths, { loadedSha256: sha, loadedBytes: loaded, runtimeBytes: refreshed, runId: 'run-b', now: NOW });
  fs.renameSync = originalRename;
  assert.deepEqual(done, { replaced: true, refreshedDuringRun: true, lastRefreshAdvanced: true, sameAccount: true });
  assert.deepEqual(renames, [['auth.json.next-run-b', paths.streamFile]]);
  assert.deepEqual(fs.readFileSync(paths.streamFile), refreshed);
  assert.deepEqual(fs.readdirSync(paths.streamDir), ['auth.json'], 'no backup and no leftover temporary file');
  assert.equal(fs.statSync(paths.streamFile).mode & 0o777, 0o600);
  // The same last_refresh with different tokens is accepted but not an advance.
  const sameStamp = auth({ seed: 'rotated', refreshed: NOW - 60_000 });
  const equal = acceptCopyBack(paths, { loadedSha256: sha256Hex(refreshed), loadedBytes: refreshed, runtimeBytes: sameStamp, runId: 'run-c', now: NOW });
  assert.deepEqual(equal, { replaced: true, refreshedDuringRun: true, lastRefreshAdvanced: false, sameAccount: true });
  assert.deepEqual(fs.readdirSync(paths.streamDir), ['auth.json']);
});

test('a refused copy-back (older last_refresh, other account, invalid JSON, changed stream hash) writes a 0600 quarantine file and later runs refuse with quarantine-pending', (t) => {
  const loaded = auth({ seed: 'loaded', refreshed: NOW - 2 * HOUR });
  const sha = sha256Hex(loaded);
  const cases = [
    ['stale-last-refresh', auth({ seed: 'old', refreshed: NOW - 3 * HOUR }), () => {}],
    ['other-account', auth({ seed: 'other', account: 'acct-fake-0002', refreshed: NOW - HOUR }), () => {}],
    ['invalid', Buffer.from('{"truncated":'), () => {}],
    ['invalid', auth({ seed: 'key', refreshed: NOW - HOUR, extra: { OPENAI_API_KEY: 'sk-fake-key' } }), () => {}],
    ['invalid', Buffer.alloc(0), () => {}],
    ['stream-changed', auth({ seed: 'new', refreshed: NOW - HOUR }), (paths) => fs.writeFileSync(paths.streamFile, auth({ seed: 'moved', refreshed: NOW - HOUR }))],
  ];
  for (const [reason, runtimeBytes, mutate] of cases) {
    const { paths, root } = setup(t, { stream: loaded });
    mutate(paths);
    const streamBefore = fs.readFileSync(paths.streamFile);
    assert.throws(() => acceptCopyBack(paths, { loadedSha256: sha, loadedBytes: loaded, runtimeBytes, runId: 'run-q', now: NOW }),
      (error) => failure('COPYBACK_REFUSED', reason)(error) && error.quarantined === true, reason);
    const quarantine = path.join(paths.streamDir, 'quarantine-run-q.json');
    assert.deepEqual(fs.readFileSync(quarantine), runtimeBytes, reason);
    assert.equal(fs.statSync(quarantine).mode & 0o777, 0o600);
    assert.deepEqual(fs.readFileSync(paths.streamFile), streamBefore, `${reason}: the stream is never overwritten`);
    assert.deepEqual(fs.readdirSync(paths.streamDir).sort(), ['auth.json', 'quarantine-run-q.json'], reason);
    assert.doesNotThrow(() => assertPrivateRoot(paths));
    assert.throws(() => assertNoQuarantine(paths), failure('STREAM_UNSAFE', 'quarantine-pending'));
    assert.equal(inspectStream(paths, { now: NOW, procRoot: '/nonexistent-proc' }).quarantineCount, 1);
    // The refusal is idempotent for an identical quarantine and fails closed for a different one.
    assert.throws(() => acceptCopyBack(paths, { loadedSha256: sha, loadedBytes: loaded, runtimeBytes, runId: 'run-q', now: NOW }),
      failure('COPYBACK_REFUSED', reason));
    assert.throws(() => acceptCopyBack(paths, { loadedSha256: sha, loadedBytes: loaded, runtimeBytes: Buffer.from('{"different":1}'), runId: 'run-q', now: NOW }),
      failure('CLEANUP_INCOMPLETE', 'credential-not-persisted'));
    assert.equal(fs.existsSync(root), true);
  }
});

test('retire renames the stream under the lock and adopt installs a validated quarantined artifact atomically', (t) => {
  const loaded = auth({ seed: 'loaded', refreshed: NOW - 2 * HOUR });
  const { paths, root, proc } = setup(t, { stream: loaded });
  const quarantined = auth({ seed: 'quarantined', refreshed: NOW - HOUR });
  fs.writeFileSync(path.join(paths.streamDir, 'quarantine-run-1.json'), quarantined, { mode: 0o600 });
  // retire waits for no one: a held lock and an inflight marker both refuse.
  const holder = acquireRunLock(paths, { runId: 'holder', procRoot: proc.dir });
  assert.throws(() => retireStream(paths, { now: NOW, procRoot: proc.dir }), failure('LOCK_HELD', 'live-owner'));
  assert.throws(() => adoptQuarantine(paths, { runId: 'run-1', now: NOW, procRoot: proc.dir }), failure('LOCK_HELD', 'live-owner'));
  holder.release();
  createInflight(paths, { runId: 'run-9', robotName: 'codex-auth-test-run-9', folder: 'codex-auth-run-9' });
  assert.throws(() => retireStream(paths, { now: NOW, procRoot: proc.dir }), failure('STREAM_UNSAFE', 'inflight-present'));
  assert.throws(() => adoptQuarantine(paths, { runId: 'run-1', now: NOW, procRoot: proc.dir }), failure('STREAM_UNSAFE', 'inflight-present'));
  removeInflight(paths);
  // adopt: validation first, then an atomic install that removes the quarantine file.
  assert.throws(() => adoptQuarantine(paths, { runId: 'nope', now: NOW, procRoot: proc.dir }), failure('STREAM_UNSAFE', 'quarantine-missing'));
  assert.throws(() => adoptQuarantine(paths, { runId: '../x', now: NOW, procRoot: proc.dir }), failure('USAGE', 'bad-variable'));
  fs.writeFileSync(path.join(paths.streamDir, 'quarantine-bad.json'), Buffer.from('{"nope":1}'), { mode: 0o600 });
  assert.throws(() => adoptQuarantine(paths, { runId: 'bad', now: NOW, procRoot: proc.dir }), failure('STREAM_UNSAFE', 'auth-invalid:not-chatgpt'));
  assert.deepEqual(fs.readFileSync(paths.streamFile), loaded, 'a refused adopt leaves the stream alone');
  fs.rmSync(path.join(paths.streamDir, 'quarantine-bad.json'));
  const renames = [];
  const originalRename = fs.renameSync;
  fs.renameSync = (from, to) => { renames.push([path.basename(from), to]); return originalRename(from, to); };
  t.after(() => { fs.renameSync = originalRename; });
  const adopted = adoptQuarantine(paths, { runId: 'run-1', now: NOW, procRoot: proc.dir });
  fs.renameSync = originalRename;
  assert.deepEqual(renames, [['auth.json.next-run-1', paths.streamFile]]);
  assert.equal(adopted.sameAccount, true);
  assert.equal(adopted.lastRefreshAdvanced, true);
  assert.equal(adopted.auth.authMode, 'chatgpt');
  assert.deepEqual(fs.readFileSync(paths.streamFile), quarantined);
  assert.deepEqual(fs.readdirSync(paths.streamDir), ['auth.json']);
  assert.doesNotThrow(() => assertNoQuarantine(paths));
  assert.equal(inspectLock(paths, { procRoot: proc.dir }), 'free');
  // retire moves the whole stream directory, including a pending quarantine, and a second retire reports no stream.
  fs.writeFileSync(path.join(paths.streamDir, 'quarantine-run-2.json'), loaded, { mode: 0o600 });
  const retired = retireStream(paths, { now: NOW, procRoot: proc.dir });
  assert.deepEqual(fs.readdirSync(path.join(paths.retiredDir, retired.retiredTo)).sort(), ['auth.json', 'quarantine-run-2.json']);
  assert.equal(fs.statSync(paths.retiredDir).mode & 0o777, 0o700);
  assert.equal(fs.existsSync(paths.streamDir), false);
  assert.throws(() => retireStream(paths, { now: NOW, procRoot: proc.dir }), failure('NOT_SEEDED', 'no-stream'));
  assert.throws(() => adoptQuarantine(paths, { runId: 'run-1', now: NOW, procRoot: proc.dir }), failure('NOT_SEEDED', 'no-stream'));
  assert.equal(fs.existsSync(root), true);
  // A retired stream is never an input again: the stream is absent for every reader.
  assert.throws(() => loadStream(paths, { now: NOW }), failure('NOT_SEEDED', 'no-stream'));
});

test('inflight.json is created with O_EXCL before robot creation and recovery handles only the named robot', (t) => {
  const { paths, root } = setup(t, { stream: auth() });
  const marker = { runId: 'run-1', robotName: 'codex-auth-test-run-1', folder: 'codex-auth-run-1' };
  const flags = [];
  const original = fs.openSync;
  fs.openSync = (file, flag, ...rest) => { if (file === paths.inflightPath) flags.push(flag); return original(file, flag, ...rest); };
  t.after(() => { fs.openSync = original; });
  createInflight(paths, marker);
  assert.equal(flags.length, 1);
  assert.ok(flags[0] & fs.constants.O_EXCL && flags[0] & fs.constants.O_CREAT && flags[0] & fs.constants.O_NOFOLLOW);
  assert.throws(() => createInflight(paths, { ...marker, runId: 'run-2' }), failure('STREAM_UNSAFE', 'inflight-present'));
  fs.openSync = original;
  assert.deepEqual(JSON.parse(fs.readFileSync(paths.inflightPath, 'utf8')), marker);
  assert.equal(fs.statSync(paths.inflightPath).mode & 0o777, 0o600);
  assert.deepEqual(readInflight(paths), marker);
  assert.doesNotThrow(() => assertPrivateRoot(paths));
  removeInflight(paths);
  removeInflight(paths);
  assert.equal(readInflight(paths), null);
  assert.throws(() => createInflight(paths, { ...marker, robotName: 'default' }), failure('USAGE', 'bad-variable'));
  assert.throws(() => createInflight(paths, { ...marker, folder: '../x' }), failure('USAGE', 'bad-variable'));
  // The marker only exists while a stream exists.
  fs.rmSync(paths.streamFile);
  assert.throws(() => createInflight(paths, marker), failure('NOT_SEEDED', 'no-stream'));
  assert.equal(fs.existsSync(paths.inflightPath), false);
  // A tampered marker is refused rather than followed.
  fs.writeFileSync(paths.inflightPath, JSON.stringify({ ...marker, robotName: 'default' }), { mode: 0o600 });
  assert.throws(() => readInflight(paths), failure('STREAM_UNSAFE', 'inflight-present'));
  fs.rmSync(paths.inflightPath);
  // Recovery plans.
  const robots = [
    { id: 'default-d3472e', name: 'default', codexAuthPresent: null },
    { id: 'codex-auth-test-run-1-ab12', name: 'codex-auth-test-run-1', codexAuthPresent: true },
  ];
  assert.deepEqual(planRecovery({ inflight: marker, robots }), { action: 'copy-back-then-delete', robot: robots[1] });
  assert.deepEqual(planRecovery({ inflight: marker, robots: [{ ...robots[1], codexAuthPresent: false }, robots[0]] }).action, 'delete');
  assert.deepEqual(planRecovery({ inflight: marker, robots: [robots[0]] }), { action: 'folder-only', robot: null });
  assert.deepEqual(planRecovery({ inflight: null, robots: [robots[0]] }), { action: 'none', robot: null });
  const other = { id: 'codex-auth-test-other-cd34', name: 'codex-auth-test-other', codexAuthPresent: false };
  assert.throws(() => planRecovery({ inflight: marker, robots: [...robots, other] }), failure('RUNTIME_PREREQ_FAILED', 'unowned-leftover-robot'));
  assert.throws(() => planRecovery({ inflight: null, robots: [other] }), failure('RUNTIME_PREREQ_FAILED', 'unowned-leftover-robot'));
  // robot-delete: 404 is accepted only for the robot the marker names.
  assert.equal(robotDeleteAccepted(200, { robotName: 'a' }), true);
  assert.equal(robotDeleteAccepted(404, { robotName: 'codex-auth-test-run-1', markerRobotName: 'codex-auth-test-run-1' }), true);
  assert.equal(robotDeleteAccepted(404, { robotName: 'codex-auth-test-run-1', markerRobotName: 'codex-auth-test-other' }), false);
  assert.equal(robotDeleteAccepted(404, { robotName: 'codex-auth-test-run-1' }), false);
  assert.equal(robotDeleteAccepted(500, { robotName: 'a', markerRobotName: 'a' }), false);
  assert.equal(fs.existsSync(root), true);
});

test('scanLeaks finds raw token values and the whole-file base64 and reports field names only', (t) => {
  const base = sandbox(t);
  const stream = auth({ seed: 'leaky', account: 'acct-fake-leaky-0001' });
  const value = JSON.parse(stream);
  const dir = path.join(base, 'artifacts');
  fs.mkdirSync(path.join(dir, 'nested', 'deeper'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'clean.log'), 'nothing to see: refresh_token is only a name here');
  fs.writeFileSync(path.join(dir, 'raw.log'), `before ${value.tokens.refresh_token} after`);
  fs.writeFileSync(path.join(dir, 'nested', 'deeper', 'access.json'), JSON.stringify({ header: value.tokens.access_token }));
  fs.writeFileSync(path.join(dir, 'nested', 'whole.b64'), stream.toString('base64'));
  fs.writeFileSync(path.join(dir, 'nested', 'whole.b64url'), stream.toString('base64url'));
  fs.writeFileSync(path.join(dir, 'nested', 'whole.txt'), stream.toString('utf8'));
  fs.writeFileSync(path.join(dir, 'account.txt'), `account ${value.tokens.account_id}`);
  fs.writeFileSync(path.join(dir, 'binary.bin'), Buffer.concat([Buffer.from([0, 255, 254]), Buffer.from(value.tokens.id_token), Buffer.from([0, 1])]));
  fs.symlinkSync(path.join(dir, 'raw.log'), path.join(dir, 'link.log'));
  const { leaks, filesScanned } = scanLeaks(dir, [stream]);
  const found = Object.fromEntries(leaks.reduce((map, { file, field }) => map.set(file, [...(map.get(file) || []), field]), new Map()));
  assert.equal(filesScanned, 8, 'symlinks are not followed');
  assert.equal(found['clean.log'], undefined, 'raw key names alone are not a leak');
  assert.deepEqual(found['raw.log'], ['refreshToken']);
  assert.deepEqual(found[path.join('nested', 'deeper', 'access.json')], ['accessToken']);
  assert.ok(found[path.join('nested', 'whole.b64')].includes('wholeFileBase64'));
  assert.ok(found[path.join('nested', 'whole.b64url')].includes('wholeFileBase64Url'));
  assert.ok(found[path.join('nested', 'whole.txt')].includes('wholeFile'));
  assert.deepEqual(found['account.txt'], ['accountId']);
  assert.deepEqual(found['binary.bin'], ['idToken']);
  assert.equal(found['link.log'], undefined);
  const report = JSON.stringify(leaks);
  for (const secret of [...Object.values(value.tokens), stream.toString('base64')]) assert.equal(report.includes(secret), false);
  for (const entry of leaks) assert.deepEqual(Object.keys(entry).sort(), ['field', 'file']);
  // A second token set (a post-run stream or a quarantine file) is covered too, and a clean tree reports nothing.
  const next = auth({ seed: 'later' });
  fs.writeFileSync(path.join(dir, 'later.log'), JSON.parse(next).tokens.refresh_token);
  assert.deepEqual(scanLeaks(dir, [stream, next]).leaks.filter((entry) => entry.file === 'later.log'), [{ file: 'later.log', field: 'refreshToken' }]);
  const cleanDir = path.join(base, 'clean');
  fs.mkdirSync(cleanDir);
  fs.writeFileSync(path.join(cleanDir, 'a.txt'), 'ok');
  assert.deepEqual(scanLeaks(cleanDir, [stream]), { leaks: [], filesScanned: 1 });
});

test('classifyTurnFailure flags 401, unauthorized, login and refresh-token texts as authRejectionSuspected', () => {
  const suspected = [
    'unexpected status 401 Unauthorized',
    'Your access token could not be refreshed because your refresh token was already used. Please log out and sign in again.',
    'Not logged in', 'please login first', 'Please log in again', 'Unauthorised', 'token expired', 'token revoked', 'The token was already used',
  ];
  for (const text of suspected) assert.deepEqual(classifyTurnFailure(text), { authRejectionSuspected: true }, text);
  for (const text of ['stream disconnected', 'model overloaded', 'HTTP 500 from backend', 'turn timed out', '', null, undefined, 'port 4010']) {
    assert.deepEqual(classifyTurnFailure(text), { authRejectionSuspected: false }, String(text));
  }
});

test('the exit-code table has exactly the 13 documented codes and every failure carries a reason', () => {
  assert.deepEqual(EXIT_CODES, { OK: 0, INTERNAL: 1, USAGE: 2, NOT_SEEDED: 10, ALREADY_SEEDED: 11, LOCK_HELD: 13, STREAM_UNSAFE: 14,
    RUNTIME_PREREQ_FAILED: 20, NATIVE_TURN_FAILED: 22, IDENTITY_MISMATCH: 23, COPYBACK_REFUSED: 24, CLEANUP_INCOMPLETE: 26, LEAK_DETECTED: 27 });
  assert.equal(Object.keys(EXIT_CODES).length, 13);
  assert.ok(Object.isFrozen(EXIT_CODES));
  assert.equal(new Set(Object.values(EXIT_CODES)).size, 13);
  assert.deepEqual(Object.keys(EXIT_REASONS), Object.keys(EXIT_CODES));
  for (const [code, reasons] of Object.entries(EXIT_REASONS)) {
    if (code === 'OK') { assert.deepEqual(reasons, []); continue; }
    assert.ok(reasons.length > 0, code);
    for (const reason of reasons) {
      const error = new CodexAuthError(code, reason);
      assert.equal(error.exitCode, EXIT_CODES[code]);
      assert.equal(error.message, `codex-test-auth ${code} ${reason}`);
      assert.deepEqual(describeFailure(error), { code, reason });
      const line = JSON.parse(resultLine({ command: 'run', result: 'failed', code, reason, stream: 'apparatus-copilot' }));
      assert.equal(line.exitCode, EXIT_CODES[code]);
      assert.equal(line.reason, reason);
    }
    assert.throws(() => new CodexAuthError(code, null), TypeError);
    assert.throws(() => new CodexAuthError(code, 'made-up reason'), TypeError);
  }
  assert.ok(EXIT_REASONS.STREAM_UNSAFE.includes('auth-invalid:oversize'));
  assert.throws(() => new CodexAuthError('NOPE', 'x'), TypeError);
  assert.deepEqual(describeFailure(new TypeError('secret detail')), { code: 'INTERNAL', reason: 'exception' });
  const line = JSON.parse(resultLine({ command: 'preflight', result: 'ready' }));
  assert.deepEqual(Object.keys(line), ['command', 'result', 'code', 'reason', 'exitCode', 'stream', 'refreshedDuringRun',
    'authRejectionSuspected', 'cleanup', 'artifactDirectory']);
  assert.equal(line.exitCode, 0);
  assert.equal(resultLine({ command: 'x', result: 'done' }).includes('\n'), false);
});

test('run and preflight never open a path under HOME/.codex', async (t) => {
  const { paths, home, root, proc } = setup(t, { stream: auth({ seed: 'run' }) });
  writeLive(home, auth({ seed: 'live', account: 'acct-fake-live' }));
  const live = path.join(home, '.codex');
  const touched = [];
  const restore = [];
  for (const name of ['openSync', 'readFileSync', 'readdirSync', 'lstatSync', 'statSync', 'existsSync', 'accessSync', 'realpathSync',
    'opendirSync', 'readlinkSync', 'createReadStream', 'copyFileSync', 'linkSync', 'renameSync', 'unlinkSync', 'rmSync']) {
    const original = fs[name];
    if (typeof original !== 'function') continue;
    fs[name] = Object.assign((...args) => {
      for (const argument of args) if (typeof argument === 'string' && (argument === live || argument.startsWith(`${live}${path.sep}`))) touched.push([name, argument]);
      return original(...args);
    }, original);
    restore.push(() => { fs[name] = original; });
  }
  t.after(() => restore.forEach((undo) => undo()));
  const stream = loadStream(paths, { now: NOW });
  assertPrivateRoot(paths, { forbiddenRoots: [path.join(home, 'workspace')] });
  inspectStream(paths, { now: NOW, procRoot: proc.dir });
  const lock = acquireRunLock(paths, { runId: 'run-live', procRoot: proc.dir, now: NOW });
  createInflight(paths, { runId: 'run-live', robotName: 'codex-auth-test-run-live', folder: 'codex-auth-run-live' });
  acceptCopyBack(paths, { loadedSha256: stream.sha256, loadedBytes: stream.bytes, runtimeBytes: auth({ seed: 'run2', refreshed: NOW }), runId: 'run-live', now: NOW });
  removeInflight(paths);
  lock.release();
  assert.ok(root);
  assert.deepEqual(touched, []);
  // Positive control: the instrumentation does see seed, the one operation that brackets the main login.
  const fresh = setup(t);
  writeLive(fresh.home, auth({ seed: 'fresh-live', account: 'acct-fake-fresh' }));
  const freshLive = path.join(fresh.home, '.codex', 'auth.json');
  const seen = [];
  const originalOpen = fs.openSync;
  fs.openSync = (file, ...rest) => { if (file === freshLive) seen.push(file); return originalOpen(file, ...rest); };
  t.after(() => { fs.openSync = originalOpen; });
  await seedWith(fresh.paths, fresh.proc, () => placeSeed(fresh.paths, auth({ seed: 'fresh-seed', account: 'acct-fake-seed' })));
  assert.ok(seen.length >= 2, 'seed reads the main login before and after the operator step');
});

test('assertArtifactDirectory accepts only an existing absolute directory outside ROOT, forbidden roots and git work trees', (t) => {
  const { base, paths, root } = setup(t, { stream: auth() });
  const mk = (...parts) => { const directory = path.join(base, ...parts); fs.mkdirSync(directory, { recursive: true }); return directory; };
  const artifacts = mk('evidence', 'run-1');
  const forbiddenRoots = [mk('checkout'), mk('workspace')];
  assert.equal(assertArtifactDirectory(artifacts, { paths, forbiddenRoots }), artifacts);
  assert.throws(() => assertArtifactDirectory(undefined, { paths }), failure('USAGE', 'bad-variable'));
  assert.throws(() => assertArtifactDirectory('', { paths }), failure('USAGE', 'bad-variable'));
  assert.throws(() => assertArtifactDirectory('evidence/run-1', { paths }), failure('USAGE', 'relative-path'));
  assert.throws(() => assertArtifactDirectory(path.join(base, 'missing'), { paths }), failure('USAGE', 'artifact-dir-location'));
  fs.writeFileSync(path.join(base, 'file.txt'), 'x');
  assert.throws(() => assertArtifactDirectory(path.join(base, 'file.txt'), { paths }), failure('USAGE', 'artifact-dir-location'));
  for (const inside of [root, paths.streamDir, mk('checkout', 'out'), mk('workspace', 'out')]) {
    assert.throws(() => assertArtifactDirectory(inside, { paths, forbiddenRoots }), failure('USAGE', 'artifact-dir-location'), inside);
  }
  // A directory that contains ROOT or a forbidden root is refused as well, and so is one inside a git work tree.
  assert.throws(() => assertArtifactDirectory(path.dirname(root), { paths }), failure('USAGE', 'artifact-dir-location'));
  fs.mkdirSync(path.join(mk('tree'), '.git'));
  assert.throws(() => assertArtifactDirectory(mk('tree', 'out'), { paths }), failure('USAGE', 'artifact-dir-location'));
  // A symlink into ROOT is resolved first.
  fs.symlinkSync(root, path.join(base, 'into-root'));
  assert.throws(() => assertArtifactDirectory(path.join(base, 'into-root'), { paths }), failure('USAGE', 'artifact-dir-location'));
});

test('lockStatus reports free, held with its reason, and stale without changing anything', (t) => {
  const { paths, root, proc } = setup(t, { stream: auth() });
  assert.deepEqual(lockStatus(paths, { procRoot: proc.dir }), { state: 'free', reason: null });
  const lock = acquireRunLock(paths, { runId: 'status-run', procRoot: proc.dir });
  assert.deepEqual(lockStatus(paths, { procRoot: proc.dir }), { state: 'held', reason: 'live-owner' });
  lock.release();
  const token = 'e'.repeat(32);
  const owner = { pid: 999999, start: '1', boot: 'boot-1', token, runId: 'dead', startedAt: 'x' };
  fs.writeFileSync(path.join(root, `.run-owner-${token}.json`), JSON.stringify(owner), { mode: 0o600 });
  fs.linkSync(path.join(root, `.run-owner-${token}.json`), paths.lockPath);
  const before = snapshot(root);
  assert.deepEqual(lockStatus(paths, { procRoot: proc.dir }), { state: 'stale', reason: null });
  assert.deepEqual(snapshot(root), before);
  fs.writeFileSync(paths.lockPath, 'garbage');
  assert.deepEqual(lockStatus(paths, { procRoot: proc.dir }), { state: 'held', reason: 'ambiguous-owner' });
});
