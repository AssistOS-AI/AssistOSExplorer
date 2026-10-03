import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { CodexAuthError, EXIT_CODES } from './codex-test-auth.mjs';
import { DERIVED_SHAPE_ID } from './codex-test-auth-owner.mjs';
import {
  QUALIFICATION_CHECKS, QUALIFICATION_RECEIPT_SCHEMA, QUALIFIED_CODEX_CLIENTS, assertClientQualified, checkClientQualification, evaluateQualification,
  qualifiedEntriesFor, relativePathsFor, validateQualifiedClientEntry,
} from './codex-client-qualification.mjs';

// Qualification tests. Every token is fabricated and every request stays on loopback. The file refuses to start under the account's own
// home, and every child process gets a literal environment with a throwaway HOME (decision L).
const REAL_HOME = os.userInfo().homedir;
const realOf = (value) => { try { return fs.realpathSync(value); } catch { return path.resolve(value); } };
if (!process.env.HOME || path.resolve(process.env.HOME) === path.resolve(REAL_HOME) || realOf(process.env.HOME) === realOf(REAL_HOME)) {
  throw new Error('Refusing to start: run with HOME set to a temporary directory.');
}

// The blocking guard of lib/codex-test-auth-owner.test.mjs, verbatim (a test below checks that it has not drifted). It is loaded into the
// harness and into every stub client it runs, so none of them can read the real account's .codex directory (decision L): a guarded
// access prints the marker to stderr and exits 97.
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
const GUARD_MARKER = 'BLOCKED-REAL-CODEX-ACCESS';
const CHILD_GUARD_SOURCE = `import fs from 'node:fs';\nimport os from 'node:os';\nimport path from 'node:path';\nimport { fileURLToPath } from 'node:url';\n`
  + `(${installRealHomeGuard.toString()})({ fs, os, path, fileURLToPath, onBlocked: () => { fs.writeSync(2, '${GUARD_MARKER}\\n'); process.exit(97); } });\n`;
const CHILD_NODE_OPTIONS = `--import=data:text/javascript,${encodeURIComponent(CHILD_GUARD_SOURCE)}`;
const STUB_GUARD = `(${installRealHomeGuard.toString()})({ fs: require('node:fs'), os: require('node:os'), path: require('node:path'),
  fileURLToPath: require('node:url').fileURLToPath, onBlocked: () => { require('node:fs').writeSync(2, '${GUARD_MARKER}\\n'); process.exit(97); } });`;

const HARNESS = fileURLToPath(new URL('../scripts/codex-client-qualify.mjs', import.meta.url));
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const failure = (code, reason, qualification) => (error) => error instanceof CodexAuthError && error.code === code && error.reason === reason
  && error.exitCode === EXIT_CODES[code] && (qualification === undefined || error.qualification === qualification);

function sandbox(t) {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cta-qual-')));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  return base;
}

const SHA_A = 'a'.repeat(64);
const SHA_B = 'b'.repeat(64);
const NATIVE = 'lib/node_modules/@openai/codex-linux-x64/vendor/x86_64-unknown-linux-musl/codex/codex';
const entry = (overrides = {}) => Object.freeze({
  package: '@openai/codex', version: '0.160.0', platform: 'linux-x64', nativeRelativePath: NATIVE, nativeSha256: SHA_A, nativeSize: 4096,
  derivedShape: DERIVED_SHAPE_ID,
  receipt: Object.freeze({ file: 'qualify.jsonl', sha256: SHA_B, harnessSha256: SHA_A, verdict: 'PASS', qualifiedAt: '2026-10-04T10:00:00.000Z', host: 'apparatus' }),
  ...overrides,
});
const IDENTITY = { package: '@openai/codex', version: '0.160.0' };
const DIGEST = { platform: 'linux-x64', sha256: SHA_A, size: 4096 };

test('the committed allowlist is frozen and well-formed, an empty allowlist refuses every client with no-entry, and a non-empty list never matches another version', () => {
  assert.ok(Object.isFrozen(QUALIFIED_CODEX_CLIENTS));
  for (const committed of QUALIFIED_CODEX_CLIENTS) assert.doesNotThrow(() => validateQualifiedClientEntry(committed));
  assert.equal(QUALIFICATION_RECEIPT_SCHEMA, 'codex-client-qualification-v1');
  // Entry validation: a well-formed frozen entry passes; every malformed one is a TypeError.
  assert.equal(validateQualifiedClientEntry(entry()).version, '0.160.0');
  const bad = [
    ['an unfrozen entry', { ...entry() }], ['an extra key', entry({ extra: 1 })], ['a bad version', entry({ version: '0.160' })],
    ['a bad platform', entry({ platform: 'Linux X64' })], ['a traversal path', entry({ nativeRelativePath: '../codex' })],
    ['an absolute path', entry({ nativeRelativePath: '/usr/bin/codex' })], ['an empty path', entry({ nativeRelativePath: '' })],
    ['a bad digest', entry({ nativeSha256: 'abc' })], ['an uppercase digest', entry({ nativeSha256: 'A'.repeat(64) })],
    ['a zero size', entry({ nativeSize: 0 })], ['a fractional size', entry({ nativeSize: 1.5 })], ['an empty shape', entry({ derivedShape: '' })],
    ['an unfrozen receipt', entry({ receipt: { file: 'q.jsonl', sha256: SHA_B, harnessSha256: SHA_A, verdict: 'PASS', qualifiedAt: '2026-10-04T10:00:00Z', host: 'apparatus' } })],
    ['a failing receipt', entry({ receipt: Object.freeze({ file: 'q.jsonl', sha256: SHA_B, harnessSha256: SHA_A, verdict: 'FAIL', qualifiedAt: '2026-10-04T10:00:00Z', host: 'apparatus' }) })],
    ['a Mac receipt', entry({ receipt: Object.freeze({ file: 'q.jsonl', sha256: SHA_B, harnessSha256: SHA_A, verdict: 'PASS', qualifiedAt: '2026-10-04T10:00:00Z', host: 'mac' }) })],
    ['a receipt without a harness digest', entry({ receipt: Object.freeze({ file: 'q.jsonl', sha256: SHA_B, verdict: 'PASS', qualifiedAt: '2026-10-04T10:00:00Z', host: 'apparatus' }) })],
    ['a bad receipt time', entry({ receipt: Object.freeze({ file: 'q.jsonl', sha256: SHA_B, harnessSha256: SHA_A, verdict: 'PASS', qualifiedAt: 'yesterday', host: 'apparatus' }) })],
    ['null', null], ['an array', []], ['a string', 'entry'],
  ];
  for (const [name, value] of bad) assert.throws(() => validateQualifiedClientEntry(value), TypeError, name);
  // An empty allowlist refuses every client: nothing is hashed or compared.
  for (const identity of [IDENTITY, { package: '@openai/codex', version: '9.9.9' }, { package: 'other', version: '0.160.0' }, {}, undefined]) {
    assert.throws(() => assertClientQualified({ identity, digest: DIGEST, entries: [] }), failure('RUNTIME_PREREQ_FAILED', 'client-unqualified', 'no-entry'));
  }
  // The committed list refuses a version that no build can have.
  assert.throws(() => assertClientQualified({ identity: { package: '@openai/codex', version: '0.0.0-never' }, digest: DIGEST }), failure('RUNTIME_PREREQ_FAILED', 'client-unqualified', 'no-entry'));
  // A non-empty list never matches another version, another package or an empty identity.
  const listed = [entry()];
  assert.deepEqual(qualifiedEntriesFor({ packageName: '@openai/codex', version: '0.160.0', entries: listed }), listed);
  assert.deepEqual(qualifiedEntriesFor({ packageName: '@openai/codex', version: '0.160.1', entries: listed }), []);
  assert.deepEqual(qualifiedEntriesFor({ packageName: '@openai/codex', version: '0.159.3', entries: listed }), []);
  assert.deepEqual(qualifiedEntriesFor({ packageName: 'other', version: '0.160.0', entries: listed }), []);
  assert.deepEqual(qualifiedEntriesFor({ packageName: undefined, version: undefined, entries: listed }), []);
  assert.throws(() => assertClientQualified({ identity: { ...IDENTITY, version: '0.160.1' }, digest: DIGEST, entries: listed }), failure('RUNTIME_PREREQ_FAILED', 'client-unqualified', 'no-entry'));
  assert.equal(assertClientQualified({ identity: IDENTITY, digest: DIGEST, entries: listed }).entry, listed[0]);
  // Relative paths per platform, for the container digest.
  assert.deepEqual(relativePathsFor([]), {});
  assert.deepEqual(relativePathsFor([entry(), entry({ platform: 'linux-arm64', nativeRelativePath: 'a/b' })]), { 'linux-x64': NATIVE, 'linux-arm64': 'a/b' });
  assert.throws(() => relativePathsFor([entry(), entry()]), TypeError);
});

test('assertClientQualified requires the same package, version, platform, native size and SHA-256 and the current derived-shape id', () => {
  const entries = [entry()];
  const qualified = assertClientQualified({ identity: IDENTITY, digest: DIGEST, entries });
  assert.deepEqual(Object.keys(qualified), ['status', 'entry']);
  assert.equal(qualified.status, 'qualified');
  assert.equal(qualified.entry, entries[0]);
  const refused = (input, status) => assert.throws(() => assertClientQualified({ entries, shapeId: DERIVED_SHAPE_ID, ...input }), failure('RUNTIME_PREREQ_FAILED', 'client-unqualified', status));
  // Package and version select the entry.
  refused({ identity: { ...IDENTITY, package: 'other' }, digest: DIGEST }, 'no-entry');
  refused({ identity: { ...IDENTITY, version: '0.160.1' }, digest: DIGEST }, 'no-entry');
  // Platform: another platform, or no digest for this platform (the container had no allowlisted path for it).
  refused({ identity: IDENTITY, digest: { ...DIGEST, platform: 'linux-arm64' } }, 'platform-mismatch');
  refused({ identity: IDENTITY, digest: { platform: 'linux-x64', sha256: null, size: null } }, 'platform-mismatch');
  refused({ identity: IDENTITY, digest: undefined }, 'platform-mismatch');
  // The derived shape: a changed shape id unqualifies every entry.
  refused({ identity: IDENTITY, digest: DIGEST, shapeId: 'chatgptAuthTokens-v2' }, 'shape-mismatch');
  assert.throws(() => assertClientQualified({ identity: IDENTITY, digest: DIGEST, entries: [entry({ derivedShape: 'chatgptAuthTokens-v0' })] }), failure('RUNTIME_PREREQ_FAILED', 'client-unqualified', 'shape-mismatch'));
  // The digest: the SHA-256 alone, and the size alone, are each enough to refuse.
  refused({ identity: IDENTITY, digest: { ...DIGEST, sha256: SHA_B } }, 'digest-mismatch');
  refused({ identity: IDENTITY, digest: { ...DIGEST, size: 4097 } }, 'digest-mismatch');
  refused({ identity: IDENTITY, digest: { ...DIGEST, sha256: SHA_B, size: 1 } }, 'digest-mismatch');
  // The checks run in order: platform, then shape, then digest.
  refused({ identity: IDENTITY, digest: { platform: 'linux-arm64', sha256: SHA_B, size: 1 }, shapeId: 'chatgptAuthTokens-v2' }, 'platform-mismatch');
  refused({ identity: IDENTITY, digest: { ...DIGEST, sha256: SHA_B, size: 1 }, shapeId: 'chatgptAuthTokens-v2' }, 'shape-mismatch');
  // With two platforms, the entry of the container's platform is the one compared.
  const both = [entry(), entry({ platform: 'linux-arm64', nativeSha256: SHA_B, nativeSize: 8192 })];
  assert.equal(assertClientQualified({ identity: IDENTITY, digest: { platform: 'linux-arm64', sha256: SHA_B, size: 8192 }, entries: both }).entry, both[1]);
  assert.throws(() => assertClientQualified({ identity: IDENTITY, digest: { platform: 'linux-arm64', sha256: SHA_A, size: 4096 }, entries: both }), failure('RUNTIME_PREREQ_FAILED', 'client-unqualified', 'digest-mismatch'));
});

test('checkClientQualification hashes only when an entry exists, reports one status word with the public digests, and never throws for a qualification outcome', async () => {
  const GENERATION = 'f'.repeat(64);
  const identity = { ...IDENTITY, generation: GENERATION };
  const asked = [];
  const runtimeFor = (answer) => ({ async nativeDigest(request) { asked.push(request); if (answer instanceof Error) throw answer; return answer; } });
  const listed = [entry()];
  // No entry: nothing is hashed.
  const none = await checkClientQualification({ runtime: runtimeFor(DIGEST), identity, entries: [] });
  assert.deepEqual(asked, []);
  assert.equal(none.report.status, 'no-entry');
  assert.equal(none.report.generation12, 'ffffffffffff');
  assert.equal(none.report.nativeSha256, null);
  assert.ok(failure('RUNTIME_PREREQ_FAILED', 'client-unqualified', 'no-entry')(none.failure));
  assert.equal((await checkClientQualification({ runtime: runtimeFor(DIGEST), identity: { ...identity, version: '0.160.1' }, entries: listed })).report.status, 'no-entry');
  assert.deepEqual(asked, []);
  // Qualified: the container is asked for exactly the allowlisted path of the entry, and the report carries only public values.
  const ok = await checkClientQualification({ runtime: runtimeFor(DIGEST), identity, entries: listed });
  assert.deepEqual(asked, [{ generation: GENERATION, relativePaths: { 'linux-x64': NATIVE } }]);
  assert.equal(ok.failure, null);
  assert.deepEqual(ok.report, { status: 'qualified', platform: 'linux-x64', generation12: 'ffffffffffff', nativeSha256: SHA_A, nativeSize: 4096, entryVersion: '0.160.0', receiptSha256: SHA_B });
  // Each refusal is a status word with a failure, and a runtime failure is digest-unreadable.
  const refusals = [
    [{ ...DIGEST, sha256: SHA_B }, 'digest-mismatch'], [{ ...DIGEST, size: 1 }, 'digest-mismatch'], [{ platform: 'linux-x64', sha256: null, size: null }, 'platform-mismatch'],
    [{ ...DIGEST, platform: 'linux-arm64' }, 'platform-mismatch'], [new Error('boom'), 'digest-unreadable'],
  ];
  for (const [answer, status] of refusals) {
    const outcome = await checkClientQualification({ runtime: runtimeFor(answer), identity, entries: listed });
    assert.equal(outcome.report.status, status, status);
    assert.ok(failure('RUNTIME_PREREQ_FAILED', 'client-unqualified', status)(outcome.failure), status);
    assert.equal(outcome.report.entryVersion, null);
    assert.equal(outcome.report.receiptSha256, null);
  }
  const mismatched = await checkClientQualification({ runtime: runtimeFor({ ...DIGEST, sha256: SHA_B }), identity, entries: listed });
  assert.equal(mismatched.report.nativeSha256, SHA_B, 'the digest of the public binary is reported with the refusal');
  // A malformed allowlist (two entries for one platform) is a programming error and is not reported as an outcome.
  await assert.rejects(checkClientQualification({ runtime: runtimeFor(DIGEST), identity, entries: [entry(), entry()] }), TypeError);
  // The shape id of an old entry unqualifies it.
  const stale = await checkClientQualification({ runtime: runtimeFor(DIGEST), identity, entries: [entry({ derivedShape: 'chatgptAuthTokens-v0' })] });
  assert.equal(stale.report.status, 'shape-mismatch');
});

// Summaries of the four cases as the harness records them, all good.
function goodCases() {
  const external = (name, expInMinutes) => ({ case: name, mode: 'external', expInMinutes, loginStatus: { code: 0, lines: ['Logged in using ChatGPT'], mockRequests: 0, refreshRequests: 0 },
    exec: { code: 1, signal: null, stderrTail: [] }, syntheticBearerSent: true, refreshRequests: 0, refreshRequestsTotal: 0, refreshBeforeFirstBackend: false,
    authFileUnchanged: true, authFileAccessOnly: true, otherFilesHoldingAccessToken: 0 });
  const managed = (name, expInMinutes, proactive) => ({ case: name, mode: 'managed', expInMinutes, loginStatus: { code: 0, lines: ['Logged in using ChatGPT'], mockRequests: 0, refreshRequests: 0 },
    exec: { code: 1, signal: null, stderrTail: [] }, syntheticBearerSent: true, refreshRequests: 4, refreshRequestsTotal: 4, refreshBeforeFirstBackend: proactive,
    authFileUnchanged: true, authFileAccessOnly: null, otherFilesHoldingAccessToken: 0 });
  return [external('E-401', 120), external('E-window', 2), managed('M-401', 120, false), managed('M-window', 2, true)];
}

test('evaluateQualification passes only when every external-mode safety check and both managed positive controls hold', () => {
  assert.equal(QUALIFICATION_CHECKS.length, 9);
  assert.ok(Object.isFrozen(QUALIFICATION_CHECKS));
  const good = evaluateQualification(goodCases());
  assert.equal(good.verdict, 'PASS');
  assert.deepEqual(Object.keys(good.checks), [...QUALIFICATION_CHECKS]);
  assert.ok(Object.values(good.checks).every((value) => value === true));
  // Each check, set to false in turn, gives FAIL, and only that check is false.
  const breakers = {
    externalLoadsAsChatgpt: (cases) => { cases[0].loginStatus.lines = ['Not logged in']; },
    externalTokenUsed: (cases) => { cases[1].syntheticBearerSent = false; },
    externalNeverRefreshes: (cases) => { cases[0].refreshRequestsTotal = 1; },
    externalNeverWritesAuth: (cases) => { cases[1].authFileUnchanged = false; },
    externalFailsClosed: (cases) => { cases[0].exec.code = 0; },
    noTokenCopiesOutsideAuthJson: (cases) => { cases[2].otherFilesHoldingAccessToken = 1; },
    recorderSeesManagedRefreshOn401: (cases) => { cases[2].refreshRequests = 0; },
    recorderSeesManagedProactiveRefresh: (cases) => { cases[3].refreshBeforeFirstBackend = false; },
    externalAuthIsAccessOnly: (cases) => { cases[0].authFileAccessOnly = false; },
  };
  assert.deepEqual(Object.keys(breakers), [...QUALIFICATION_CHECKS]);
  for (const [name, breakIt] of Object.entries(breakers)) {
    const cases = goodCases();
    breakIt(cases);
    const outcome = evaluateQualification(cases);
    assert.equal(outcome.verdict, 'FAIL', name);
    assert.equal(outcome.checks[name], false, name);
    assert.deepEqual(Object.entries(outcome.checks).filter(([, value]) => value === false).map(([key]) => key), [name], name);
  }
  // A refresh in either phase counts, a killed or hung binary is not a failure to start, and a missing field is a failure.
  const statusPhase = goodCases();
  statusPhase[0].refreshRequestsTotal = 1;
  statusPhase[0].refreshRequests = 0;
  assert.equal(evaluateQualification(statusPhase).checks.externalNeverRefreshes, false);
  const killed = goodCases();
  killed[1].exec.code = null;
  assert.equal(evaluateQualification(killed).checks.externalFailsClosed, false);
  const noTotal = goodCases();
  delete noTotal[0].refreshRequestsTotal;
  assert.equal(evaluateQualification(noTotal).checks.externalNeverRefreshes, false);
  // Missing cases and malformed input fail closed.
  for (const index of [0, 1, 2, 3]) {
    const cases = goodCases();
    cases.splice(index, 1);
    assert.equal(evaluateQualification(cases).verdict, 'FAIL', `case ${index} missing`);
  }
  for (const junk of [[], null, undefined, 'x', [null], [{}]]) assert.equal(evaluateQualification(junk).verdict, 'FAIL');
});

// The stub client is a Node script behind an absolute shebang. It prints what the harness needs to see and behaves like the variant says.
function stubSource(variant, marker) {
  return `
${STUB_GUARD}
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const VARIANT = ${JSON.stringify(variant)};
const MARKER = ${JSON.stringify(marker)};
const args = process.argv.slice(2);
if (MARKER !== '') fs.appendFileSync(MARKER, args.join(' ') + '\\n');
if (args.includes('--version')) { process.stdout.write('codex-cli 0.0.0-stub\\n'); process.exit(0); }
const authFile = path.join(process.env.CODEX_HOME, 'auth.json');
const auth = JSON.parse(fs.readFileSync(authFile, 'utf8'));
const external = auth.auth_mode === 'chatgptAuthTokens';
const request = (method, url, headers, body) => new Promise((resolve) => {
  const target = new URL(url);
  const req = http.request({ host: target.hostname, port: target.port, path: target.pathname + target.search, method, headers }, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
  req.on('error', () => resolve(0));
  req.end(body);
});
const refresh = () => request('POST', process.env.CODEX_REFRESH_TOKEN_URL_OVERRIDE, { 'content-type': 'application/json' },
  JSON.stringify({ grant_type: 'refresh_token', refresh_token: auth.tokens.refresh_token }));
const expiresAt = () => { try { return JSON.parse(Buffer.from(auth.tokens.access_token.split('.')[1], 'base64url').toString('utf8')).exp * 1000; } catch { return 0; } };
const baseUrl = () => args.find((arg) => arg.startsWith('openai_base_url=')).slice('openai_base_url='.length).replace(/^"|"$/g, '');
(async () => {
  if (args.includes('login') && args.includes('status')) {
    process.stderr.write('Logged in using ChatGPT\\n');
    if (VARIANT === 'statusrefresh' && external) await refresh();
    process.exit(0);
  }
  // exec: a managed login refreshes proactively inside five minutes of expiry, then on a 401. An external one never does.
  if (!external && expiresAt() <= Date.now() + 5 * 60_000) await refresh();
  const headers = VARIANT === 'nobearer' ? {} : { authorization: 'Bearer ' + auth.tokens.access_token };
  const status = await request('GET', baseUrl() + '/models', headers, '');
  if (!external && status === 401) await refresh();
  if (external && VARIANT === 'refresh') await refresh();
  if (external && VARIANT === 'rewrite') {
    const text = fs.readFileSync(authFile, 'utf8');
    const at = text.indexOf('"last_refresh":"') + '"last_refresh":"'.length + 3;
    fs.writeFileSync(authFile, text.slice(0, at) + String((Number(text[at]) + 1) % 10) + text.slice(at + 1));
  }
  process.stderr.write('STUB-AUTH:' + auth.auth_mode + ',' + (auth.tokens.refresh_token ? 'set' : 'empty') + '\\n');
  process.stderr.write('STUB-ENV:' + Object.keys(process.env).sort().join(',') + '\\n');
  process.exit(1);
})();
`;
}

function writeStub(directory, variant, { marker = '' } = {}) {
  const file = path.join(directory, `codex-${variant}`);
  fs.writeFileSync(file, `#!${process.execPath}\n${stubSource(variant, marker)}`, { mode: 0o755 });
  fs.chmodSync(file, 0o755);
  return file;
}

// The harness is started with a literal environment: a throwaway HOME, and two canary variables that must never reach the binary.
function runHarness(t, binary, extraArguments = []) {
  const base = sandbox(t);
  const home = path.join(base, 'home');
  const tmp = path.join(base, 'tmp');
  fs.mkdirSync(home);
  fs.mkdirSync(tmp);
  const result = spawnSync(process.execPath, [HARNESS, binary, ...extraArguments], {
    env: { PATH: '/usr/bin:/bin', HOME: home, TMPDIR: tmp, SMOKE_CANARY: '1', CODEX_TEST_AUTH_SOURCE: 'stream', NODE_OPTIONS: CHILD_NODE_OPTIONS }, encoding: 'utf8', timeout: 150_000,
  });
  assert.equal(result.status === 97 || result.stderr.includes(GUARD_MARKER) || result.stdout.includes(GUARD_MARKER), false, 'the harness or a stub reached the real account .codex');
  const lines = result.stdout.split('\n').filter(Boolean).map((line) => JSON.parse(line));
  return { ...result, lines, cases: lines.slice(0, -1), receipt: lines.at(-1) };
}

const EXPECTED_ENVIRONMENT = ['ALL_PROXY', 'CODEX_HOME', 'CODEX_REFRESH_TOKEN_URL_OVERRIDE', 'CODEX_REVOKE_TOKEN_URL_OVERRIDE', 'HOME', 'HTTPS_PROXY',
  'HTTP_PROXY', 'LANG', 'NO_PROXY', 'PATH', 'TMPDIR', 'all_proxy', 'http_proxy', 'https_proxy', 'no_proxy'].sort();

const tailValue = (summary, prefix) => summary.exec.stderrTail.find((line) => line.startsWith(prefix))?.slice(prefix.length);

test('the qualification harness fails stub clients that rewrite the access-only file, refresh it during exec or login status, or ignore it, and passes a well-behaved stub, using a scrubbed environment and the derived bytes', (t) => {
  const dir = sandbox(t);
  const noFailures = (receipt) => Object.entries(receipt.checks).filter(([, value]) => value !== true).map(([name]) => name);
  // A well-behaved stub passes all nine checks and prints a complete receipt.
  const well = writeStub(dir, 'well');
  const ok = runHarness(t, well, ['--expect-sha256', sha(fs.readFileSync(well)), '--expect-version', '0.0.0-stub', '--relative-path', NATIVE, '--label', 'stub-well']);
  assert.equal(ok.status, 0, ok.stderr);
  assert.equal(ok.cases.length, 4);
  assert.deepEqual(ok.cases.map((summary) => summary.case), ['E-401', 'E-window', 'M-401', 'M-window']);
  assert.equal(ok.receipt.verdict, 'PASS');
  assert.equal(ok.receipt.reason, null);
  assert.deepEqual(Object.keys(ok.receipt.checks), [...QUALIFICATION_CHECKS]);
  assert.deepEqual(noFailures(ok.receipt), []);
  assert.deepEqual(ok.receipt.cases, ['E-401', 'E-window', 'M-401', 'M-window']);
  assert.deepEqual({ schema: ok.receipt.schema, label: ok.receipt.label, binarySha256: ok.receipt.binarySha256, binarySize: ok.receipt.binarySize, version: ok.receipt.version,
    platform: ok.receipt.platform, relativePath: ok.receipt.relativePath, derivedShape: ok.receipt.derivedShape, nodeVersion: ok.receipt.nodeVersion },
  { schema: 'codex-client-qualification-v1', label: 'stub-well', binarySha256: sha(fs.readFileSync(well)), binarySize: fs.statSync(well).size, version: '0.0.0-stub',
    platform: `${process.platform}-${process.arch}`, relativePath: NATIVE, derivedShape: DERIVED_SHAPE_ID, nodeVersion: process.version });
  for (const field of ['harnessSha256', 'ownerModuleSha256', 'qualificationModuleSha256']) assert.match(ok.receipt[field], /^[0-9a-f]{64}$/);
  assert.equal(ok.receipt.harnessSha256, sha(fs.readFileSync(HARNESS)));
  assert.match(ok.receipt.startedAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.match(ok.receipt.finishedAt, /^\d{4}-\d{2}-\d{2}T/);
  // The external files are the derived shape without a refresh token, the managed files are managed logins, and the scrubbed environment
  // carries none of the parent's variables.
  const byCase = Object.fromEntries(ok.cases.map((summary) => [summary.case, summary]));
  for (const name of ['E-401', 'E-window']) {
    assert.equal(tailValue(byCase[name], 'STUB-AUTH:'), 'chatgptAuthTokens,empty', name);
    assert.equal(byCase[name].authFileAccessOnly, true);
    assert.equal(byCase[name].refreshRequestsTotal, 0);
    assert.equal(byCase[name].loginStatus.refreshRequests, 0);
    assert.equal(byCase[name].authFileMode, '600');
  }
  for (const name of ['M-401', 'M-window']) {
    assert.equal(tailValue(byCase[name], 'STUB-AUTH:'), 'chatgpt,set', name);
    assert.equal(byCase[name].authFileAccessOnly, null);
    assert.ok(byCase[name].refreshRequests >= 1, `${name}: the recorder sees the managed refresh`);
  }
  assert.equal(byCase['M-window'].refreshBeforeFirstBackend, true);
  assert.equal(byCase['M-401'].refreshBeforeFirstBackend, false);
  for (const summary of ok.cases) {
    const names = tailValue(summary, 'STUB-ENV:').split(',').filter((name) => name !== '__CF_USER_TEXT_ENCODING').sort();
    assert.deepEqual(names, EXPECTED_ENVIRONMENT, summary.case);
    assert.equal(names.includes('SMOKE_CANARY') || names.includes('CODEX_TEST_AUTH_SOURCE'), false);
  }
  // The output never carries a token, a refresh token or a JWT.
  assert.equal(/rt-synthetic|eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/.test(ok.stdout), false);
  // Each misbehaving stub fails exactly its own check.
  const variants = [['rewrite', 'externalNeverWritesAuth'], ['refresh', 'externalNeverRefreshes'], ['statusrefresh', 'externalNeverRefreshes'], ['nobearer', 'externalTokenUsed']];
  for (const [variant, check] of variants) {
    const run = runHarness(t, writeStub(dir, variant), ['--label', `stub-${variant}`]);
    assert.equal(run.status, 1, variant);
    assert.equal(run.receipt.verdict, 'FAIL', variant);
    assert.equal(run.receipt.reason, 'checks-failed', variant);
    assert.deepEqual(noFailures(run.receipt), [check], variant);
    if (variant === 'statusrefresh') {
      const external = run.cases.filter((summary) => summary.mode === 'external');
      assert.ok(external.every((summary) => summary.loginStatus.refreshRequests >= 1 && summary.refreshRequests === 0 && summary.refreshRequestsTotal >= 1),
        'the refresh happens during login status only, and still counts');
    }
    if (variant === 'rewrite') {
      const external = run.cases.filter((summary) => summary.mode === 'external');
      assert.ok(external.every((summary) => summary.authFileUnchanged === false && summary.authFileAccessOnly === true), 'the rewrite keeps the length and the shape');
    }
  }
});

test('the harness refuses a binary that is not the expected one before running it, and rejects bad usage with exit 2', (t) => {
  const dir = sandbox(t);
  // The guard in this file is the one of the owner test file, and it stops a harness child and a stub client before any real access.
  assert.equal(fs.readFileSync(new URL('./codex-test-auth-owner.test.mjs', import.meta.url), 'utf8').includes(installRealHomeGuard.toString()), true, 'the guard drifted');
  const realLogin = path.join(REAL_HOME, '.codex', 'auth.json');
  const probed = spawnSync(process.execPath, ['-e', `require('node:fs').existsSync(${JSON.stringify(realLogin)})`], { env: { PATH: '/usr/bin:/bin', HOME: dir, NODE_OPTIONS: CHILD_NODE_OPTIONS }, encoding: 'utf8', timeout: 30_000 });
  assert.deepEqual([probed.status, probed.stderr.includes(GUARD_MARKER)], [97, true]);
  const probeStub = path.join(dir, 'probe-stub');
  fs.writeFileSync(probeStub, `#!${process.execPath}\n${STUB_GUARD}\nrequire('node:fs').existsSync(${JSON.stringify(realLogin)});\n`, { mode: 0o755 });
  const stubProbe = spawnSync(probeStub, [], { env: { PATH: '/usr/bin:/bin', HOME: dir }, encoding: 'utf8', timeout: 30_000 });
  assert.deepEqual([stubProbe.status, stubProbe.stderr.includes(GUARD_MARKER)], [97, true]);
  const marker = path.join(dir, 'ran.log');
  const stub = writeStub(dir, 'well', { marker });
  // A digest mismatch: the binary is never executed.
  const mismatch = runHarness(t, stub, ['--expect-sha256', 'c'.repeat(64)]);
  assert.equal(mismatch.status, 1);
  assert.deepEqual(mismatch.cases, []);
  assert.deepEqual([mismatch.receipt.verdict, mismatch.receipt.reason, mismatch.receipt.version], ['FAIL', 'binary-mismatch', null]);
  assert.equal(fs.existsSync(marker), false, 'the binary was not executed');
  // A version mismatch: only the version query runs.
  const version = runHarness(t, stub, ['--expect-version', '9.9.9']);
  assert.equal(version.status, 1);
  assert.deepEqual(version.cases, []);
  assert.deepEqual([version.receipt.verdict, version.receipt.reason, version.receipt.version], ['FAIL', 'version-mismatch', '0.0.0-stub']);
  assert.equal(fs.readFileSync(marker, 'utf8'), '--version\n');
  // A binary that prints no version fails closed.
  const silent = path.join(dir, 'silent');
  fs.writeFileSync(silent, `#!${process.execPath}\nprocess.exit(0);\n`, { mode: 0o755 });
  const unreadable = runHarness(t, silent);
  assert.equal(unreadable.status, 1);
  assert.deepEqual([unreadable.receipt.verdict, unreadable.receipt.reason], ['FAIL', 'version-unreadable']);
  // Usage errors: exit 2 and nothing on stdout.
  const usage = [[['relative/binary']], [[stub, '--bogus', 'x']], [['/no/such/binary/codex']], [[stub, '--label']], [[stub, '--expect-sha256', 'abc']],
    [[stub, '--expect-version', 'one']], [[stub, '--label', 'has space']], [[dir]], [[stub, '--relative-path', '']]];
  for (const [argv] of usage) {
    const result = spawnSync(process.execPath, [HARNESS, ...argv], { env: { PATH: '/usr/bin:/bin', HOME: dir, NODE_OPTIONS: CHILD_NODE_OPTIONS }, encoding: 'utf8', timeout: 30_000 });
    assert.equal(result.status, 2, argv.join(' '));
    assert.equal(result.stdout, '');
  }
  // Static constraints of the harness text: one argv literal for the status query, no environment passthrough, loopback URLs only.
  const source = fs.readFileSync(HARNESS, 'utf8');
  const quoted = source.split('\n').filter((line) => line.includes("'login'"));
  assert.equal(quoted.length, 1);
  assert.equal(quoted[0].includes("'login', 'status'"), true);
  assert.equal(/\.\.\.process\.env|env: process\.env/.test(source), false);
  assert.equal(/https?:\/\/(?!127\.0\.0\.1)/.test(source), false);
});
