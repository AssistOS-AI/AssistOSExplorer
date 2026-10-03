#!/usr/bin/env node

// Qualification harness for route A of the Codex-authenticated Copilot gate. It runs one copied Codex binary against a loopback mock
// with fabricated tokens and checks how the binary treats the access-only auth file that route A derives, next to a normal managed
// login as the positive control. It never reads a real Codex home (every home is a throwaway directory), never contacts a provider
// (every request goes to 127.0.0.1) and is never a gate or a fallback. The external auth file is produced by the production code
// (deriveAccessOnlyBytes over extractOwnerCredential), so what is qualified is exactly what route A writes.
//   node scripts/codex-client-qualify.mjs <absolute binary> [--expect-sha256 <64 hex>] [--expect-version <semver>]
//     [--relative-path <path inside the generation>] [--label <name>]
// Prints one sanitized JSON line per case, then one receipt line. Exit 0 only for a PASS verdict, 1 for FAIL, 2 for usage errors.

import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { ACCOUNT_CLAIM_KEY, DERIVED_SHAPE_ID, deriveAccessOnlyBytes, extractOwnerCredential, isAccessOnly } from '../lib/codex-test-auth-owner.mjs';
import { QUALIFICATION_RECEIPT_SCHEMA, evaluateQualification } from '../lib/codex-client-qualification.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const ACCOUNT = '00000000-0000-4000-8000-00000000c0de';
const LOOPBACK_PROXY = 'http://127.0.0.1:9';
const SEMVER = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;

function usage() {
  process.stderr.write('usage: node scripts/codex-client-qualify.mjs <absolute binary> [--expect-sha256 <64 hex>] [--expect-version <semver>] [--relative-path <path>] [--label <name>]\n');
  process.exit(2);
}

function parseArguments(argv) {
  const [binary, ...rest] = argv;
  if (typeof binary !== 'string' || !path.isAbsolute(binary) || /[\0\r\n]/.test(binary) || rest.length % 2 !== 0) usage();
  const options = { binary, expectSha256: null, expectVersion: null, relativePath: null, label: 'unlabelled' };
  for (let index = 0; index < rest.length; index += 2) {
    const [flag, value] = [rest[index], rest[index + 1]];
    if (flag === '--expect-sha256' && /^[0-9a-f]{64}$/.test(value)) options.expectSha256 = value;
    else if (flag === '--expect-version' && SEMVER.test(value)) options.expectVersion = value;
    else if (flag === '--relative-path' && value !== '' && !/[\0\r\n]/.test(value)) options.relativePath = value;
    else if (flag === '--label' && /^[A-Za-z0-9._-]{1,40}$/.test(value)) options.label = value;
    else usage();
  }
  let stat;
  try { stat = fs.statSync(binary); } catch { usage(); }
  if (!stat.isFile()) usage();
  return options;
}

const sha256 = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');

function hashFile(file) {
  const hash = crypto.createHash('sha256');
  const fd = fs.openSync(file, fs.constants.O_RDONLY);
  const buffer = Buffer.alloc(1024 * 1024);
  let size = 0;
  try {
    for (;;) {
      const count = fs.readSync(fd, buffer, 0, buffer.length, null);
      if (count === 0) break;
      hash.update(buffer.subarray(0, count));
      size += count;
    }
  } finally { fs.closeSync(fd); }
  return { sha256: hash.digest('hex'), size };
}

const b64 = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');

// A fabricated access token. The URLs inside its claims are derived from the account claim key, so this file holds no URL literal
// other than loopback ones.
function syntheticJwt(expSeconds, nonce) {
  const now = Math.floor(Date.now() / 1000);
  return [b64({ alg: 'RS256', typ: 'JWT', kid: 'synthetic' }), b64({
    iss: ACCOUNT_CLAIM_KEY.replace('api.openai.com/auth', 'auth.openai.com'), aud: [ACCOUNT_CLAIM_KEY.replace('/auth', '/v1')], sub: 'synthetic-user', iat: now,
    exp: now + expSeconds, jti: nonce,
    [ACCOUNT_CLAIM_KEY]: { chatgpt_account_id: ACCOUNT, chatgpt_plan_type: 'plus', chatgpt_user_id: 'user-synthetic', user_id: 'user-synthetic' },
    [ACCOUNT_CLAIM_KEY.replace('/auth', '/profile')]: { email: 'synthetic@example.invalid', email_verified: true },
  }), Buffer.from('synthetic-signature').toString('base64url')].join('.');
}

// A loopback mock. Every answer is a 401, so a backend request never succeeds. Token endpoint requests are recorded as refreshes.
function startMock(token) {
  const log = [];
  const record = (req, extra = {}) => {
    const auth = req.headers.authorization || '';
    log.push({ seq: log.length, method: req.method, path: (req.url || '').split('?')[0], upgrade: Boolean(req.headers.upgrade),
      bearerPresent: auth.startsWith('Bearer '), bearerIsSynthetic: auth === `Bearer ${token}`, ...extra });
  };
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { if (body.length < 65536) body += chunk; });
    req.on('end', () => {
      if ((req.url || '').split('?')[0].endsWith('/oauth/token')) {
        let grant = null;
        let refreshTokenEmpty = null;
        try { const parsed = JSON.parse(body); grant = parsed.grant_type ?? null; refreshTokenEmpty = !parsed.refresh_token; } catch {
          const form = new URLSearchParams(body);
          grant = form.get('grant_type');
          refreshTokenEmpty = !form.get('refresh_token');
        }
        record(req, { refresh: true, grant, refreshTokenEmpty });
        res.writeHead(401, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ error: { code: 'refresh_token_invalidated', message: 'synthetic refresh rejection' } }));
      }
      record(req);
      res.writeHead(401, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ error: { message: 'synthetic unauthorized', type: 'invalid_request_error', code: 'token_expired' } }));
    });
  });
  server.on('upgrade', (req, socket) => { record(req); socket.end('HTTP/1.1 401 Unauthorized\r\ncontent-length: 0\r\nconnection: close\r\n\r\n'); });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, log, port: server.address().port })));
}

function run(command, args, env, timeoutMs) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (chunk) => { if (out.length < 200_000) out += chunk; });
    child.stderr.on('data', (chunk) => { if (err.length < 200_000) err += chunk; });
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.on('error', () => { clearTimeout(timer); resolve({ code: null, signal: null, out, err }); });
    child.on('close', (code, signal) => { clearTimeout(timer); resolve({ code, signal, out, err }); });
  });
}

function walk(directory) {
  const files = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...walk(full)); else if (entry.isFile()) files.push(full);
  }
  return files;
}

const sanitize = (value, secrets) => secrets.reduce((acc, secret) => (secret ? acc.split(secret).join('<synthetic>') : acc), value)
  .split('\n').map((line) => line.trim()).filter(Boolean);

// The environment is a literal object. Nothing of this process's environment reaches the binary, and every proxy points at a dead port.
function scrubbedEnvironment({ home, codexHome, tmp, base = null }) {
  return {
    PATH: '/usr/bin:/bin', HOME: home, CODEX_HOME: codexHome, TMPDIR: tmp, LANG: 'C.UTF-8',
    ...(base ? { CODEX_REFRESH_TOKEN_URL_OVERRIDE: `${base}/oauth/token`, CODEX_REVOKE_TOKEN_URL_OVERRIDE: `${base}/oauth/revoke` } : {}),
    HTTPS_PROXY: LOOPBACK_PROXY, HTTP_PROXY: LOOPBACK_PROXY, ALL_PROXY: LOOPBACK_PROXY, NO_PROXY: '127.0.0.1,localhost',
    https_proxy: LOOPBACK_PROXY, http_proxy: LOOPBACK_PROXY, all_proxy: LOOPBACK_PROXY, no_proxy: '127.0.0.1,localhost',
  };
}

function makeCaseDirectories() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-qualify-'));
  const directories = { root, home: path.join(root, 'home'), codexHome: path.join(root, 'codex'), work: path.join(root, 'work'), tmp: path.join(root, 'tmp') };
  for (const name of ['home', 'codexHome', 'work', 'tmp']) fs.mkdirSync(directories[name], { mode: 0o700 });
  return directories;
}

// A fabricated managed login whose last_refresh is nine days old with nine fractional digits, so that an 8-day refresh rule applied to
// the derived file would show up as a refresh request.
function fabricatedOwnerLogin(access, refresh) {
  const refreshed = new Date(Date.now() - 9 * 86_400_000).toISOString().replace(/Z$/, '456789Z');
  return Buffer.from(JSON.stringify({
    auth_mode: 'chatgpt', OPENAI_API_KEY: null,
    tokens: { id_token: syntheticJwt(3600, crypto.randomUUID()), access_token: access, refresh_token: refresh, account_id: ACCOUNT },
    last_refresh: refreshed,
  }));
}

async function oneCase(binary, { name, mode, expSeconds }) {
  const dirs = makeCaseDirectories();
  try {
    const access = syntheticJwt(expSeconds, crypto.randomUUID());
    const refresh = `rt-synthetic-${crypto.randomUUID()}`;
    const owner = fabricatedOwnerLogin(access, refresh);
    const document = mode === 'external'
      ? deriveAccessOnlyBytes(extractOwnerCredential(owner, { now: Date.now() }))
      : Buffer.from(JSON.stringify({ ...JSON.parse(owner.toString('utf8')), last_refresh: new Date().toISOString() }));
    const authFile = path.join(dirs.codexHome, 'auth.json');
    fs.writeFileSync(authFile, document, { mode: 0o600 });
    const before = fs.readFileSync(authFile);
    const { server, log, port } = await startMock(access);
    const base = `http://127.0.0.1:${port}`;
    const env = scrubbedEnvironment({ ...dirs, base });
    const overrides = ['-c', 'cli_auth_credentials_store="file"', '-c', `openai_base_url="${base}/backend-api/codex"`,
      '-c', `chatgpt_base_url="${base}/backend-api/"`, '-c', 'analytics.enabled=false'];
    const status = await run(binary, [...overrides, 'login', 'status'], env, 30_000);
    const statusLogLength = log.length;
    const exec = await run(binary, [...overrides, 'exec', '--skip-git-repo-check', '--sandbox', 'read-only', '-C', dirs.work, 'Reply with OK.'], env, 120_000);
    await new Promise((resolve) => server.close(resolve));
    const after = fs.existsSync(authFile) ? fs.readFileSync(authFile) : null;
    const leakFiles = walk(dirs.codexHome).filter((file) => file !== authFile && fs.readFileSync(file).includes(access));
    const statusLog = log.slice(0, statusLogLength);
    const execLog = log.slice(statusLogLength);
    const statusRefreshes = statusLog.filter((entry) => entry.refresh);
    const refreshes = execLog.filter((entry) => entry.refresh);
    const backend = execLog.filter((entry) => !entry.refresh);
    const firstBackend = backend.length ? backend[0].seq : null;
    return {
      case: name, mode, expInMinutes: Math.round(expSeconds / 60),
      loginStatus: { code: status.code, lines: sanitize(status.err + status.out, [access, refresh]).slice(-2), mockRequests: statusLogLength, refreshRequests: statusRefreshes.length },
      exec: { code: exec.code, signal: exec.signal, stderrTail: sanitize(exec.err, [access, refresh]).slice(-4) },
      backendRequests: backend.length, backendPaths: [...new Set(backend.map((entry) => `${entry.method} ${entry.path}${entry.upgrade ? ' (upgrade)' : ''}`))],
      syntheticBearerSent: backend.some((entry) => entry.bearerIsSynthetic),
      refreshRequests: refreshes.length, refreshRequestsTotal: statusRefreshes.length + refreshes.length,
      refreshBeforeFirstBackend: refreshes.some((entry) => firstBackend === null || entry.seq < firstBackend),
      refreshTokenEmptyInRequests: [...statusRefreshes, ...refreshes].map((entry) => entry.refreshTokenEmpty),
      authFileUnchanged: Boolean(after) && sha256(before) === sha256(after), authFilePresent: Boolean(after),
      authFileMode: after ? (fs.statSync(authFile).mode & 0o777).toString(8) : null,
      authFileAccessOnly: mode === 'external' ? isAccessOnly(before) && after !== null && isAccessOnly(after) : null,
      otherFilesHoldingAccessToken: leakFiles.length,
    };
  } finally { fs.rmSync(dirs.root, { recursive: true, force: true }); }
}

const CASES = [
  { name: 'E-401', mode: 'external', expSeconds: 2 * 3600 },
  { name: 'E-window', mode: 'external', expSeconds: 120 },
  { name: 'M-401', mode: 'managed', expSeconds: 2 * 3600 },
  { name: 'M-window', mode: 'managed', expSeconds: 120 },
];

async function readVersion(binary) {
  const dirs = makeCaseDirectories();
  try {
    const result = await run(binary, ['--version'], scrubbedEnvironment(dirs), 30_000);
    return /codex-cli (\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)/.exec(`${result.out}\n${result.err}`)?.[1] ?? null;
  } finally { fs.rmSync(dirs.root, { recursive: true, force: true }); }
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const startedAt = new Date().toISOString();
  const file = hashFile(options.binary);
  const receipt = { schema: QUALIFICATION_RECEIPT_SCHEMA, label: options.label, binarySha256: file.sha256, binarySize: file.size, version: null,
    platform: `${process.platform}-${process.arch}`, relativePath: options.relativePath, derivedShape: DERIVED_SHAPE_ID,
    harnessSha256: sha256(fs.readFileSync(fileURLToPath(import.meta.url))),
    ownerModuleSha256: sha256(fs.readFileSync(path.join(here, '..', 'lib', 'codex-test-auth-owner.mjs'))),
    qualificationModuleSha256: sha256(fs.readFileSync(path.join(here, '..', 'lib', 'codex-client-qualification.mjs'))),
    nodeVersion: process.version, startedAt, finishedAt: null, cases: [], checks: {}, verdict: 'FAIL', reason: null };
  const finish = (verdict, reason) => {
    receipt.verdict = verdict;
    receipt.reason = reason;
    receipt.finishedAt = new Date().toISOString();
    process.stdout.write(`${JSON.stringify(receipt)}\n`);
    process.exitCode = verdict === 'PASS' ? 0 : 1;
  };
  // The binary is not executed at all when its bytes are not the expected ones.
  if (options.expectSha256 !== null && options.expectSha256 !== file.sha256) return finish('FAIL', 'binary-mismatch');
  receipt.version = await readVersion(options.binary);
  if (receipt.version === null) return finish('FAIL', 'version-unreadable');
  if (options.expectVersion !== null && options.expectVersion !== receipt.version) return finish('FAIL', 'version-mismatch');
  const summaries = [];
  for (const spec of CASES) {
    const summary = await oneCase(options.binary, spec);
    summaries.push(summary);
    process.stdout.write(`${JSON.stringify({ label: options.label, ...summary })}\n`);
  }
  const { checks, verdict } = evaluateQualification(summaries);
  receipt.cases = summaries.map((summary) => summary.case);
  receipt.checks = checks;
  return finish(verdict, verdict === 'PASS' ? null : 'checks-failed');
}

await main();
