import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { findSecretLeaks } from './security.mjs';

// Host side of the Codex-authenticated Copilot gate. The tests own exactly one Codex login cache, the "stream",
// which is seeded once from a separate login, copied into a run-owned robot for one bounded turn, and copied back
// with a monotonic compare-and-swap. Credential bytes live only in memory, in the stream file and in a quarantine
// file. Nothing here reads process.env, spawns a process or opens the caller's own Codex login except `seedStream`,
// which brackets that login in memory to prove the separate login did not disturb it. Route A (lib/codex-test-auth-owner.mjs) is
// the other credential route. It reads that login read-only and builds an access-only credential in memory, and this module only
// carries the pieces both routes share: reasons, locations, the in-flight marker and the outcome of a run.

export const EXIT_CODES = Object.freeze({
  OK: 0,
  INTERNAL: 1,
  USAGE: 2,
  NOT_SEEDED: 10,
  ALREADY_SEEDED: 11,
  LOCK_HELD: 13,
  STREAM_UNSAFE: 14,
  RUNTIME_PREREQ_FAILED: 20,
  NATIVE_TURN_FAILED: 22,
  IDENTITY_MISMATCH: 23,
  COPYBACK_REFUSED: 24,
  CLEANUP_INCOMPLETE: 26,
  LEAK_DETECTED: 27,
});

// One source for the gate's timing: the Playwright test timeout, and the parent's watchdog, which must outlast it so that
// the spec's `finally` cleanup is never killed mid-way.
export const RUN_TIMEOUT_MS = 35 * 60_000;
export const RUN_WATCHDOG_MS = RUN_TIMEOUT_MS + 5 * 60_000;

const AUTH_INVALID = ['not-chatgpt', 'api-key', 'pat', 'bedrock', 'missing-field', 'future-last-refresh', 'oversize', 'token-unparseable', 'account-claim'];
const OWNER_UNSAFE = ['symlink', 'not-regular', 'uid', 'mode', 'hardlink', 'unstable'];

// Every failure carries one of these fixed reasons. Nothing derived from a payload, Podman, Codex or ALA is ever a reason.
export const EXIT_REASONS = Object.freeze({
  OK: Object.freeze([]),
  INTERNAL: Object.freeze(['exception', 'no-result-file']),
  USAGE: Object.freeze(['bad-subcommand', 'bad-variable', 'relative-path', 'artifact-dir-location', 'route-mismatch', 'owner-location']),
  NOT_SEEDED: Object.freeze(['no-stream', 'owner-login-missing']),
  ALREADY_SEEDED: Object.freeze(['stream-exists']),
  LOCK_HELD: Object.freeze(['live-owner', 'ambiguous-owner']),
  STREAM_UNSAFE: Object.freeze(['location', 'owner-or-mode', 'seed-source-missing', 'seed-source-symlink', 'seed-already-present',
    'seed-equals-live-cache', 'main-login-changed', 'quarantine-pending', 'quarantine-missing', 'inflight-present', 'scan-reference-missing',
    'access-near-expiry', 'inflight-other-route', 'derived-not-access-only',
    ...OWNER_UNSAFE.map((name) => `owner-unsafe:${name}`), ...AUTH_INVALID.map((name) => `auth-invalid:${name}`)]),
  RUNTIME_PREREQ_FAILED: Object.freeze(['binding', 'not-admin', 'selection-count', 'unowned-leftover-robot', 'version-pin',
    'cli-start-budget', 'codex-client-missing', 'target-exists', 'client-unqualified']),
  NATIVE_TURN_FAILED: Object.freeze(['failed', 'timeout']),
  IDENTITY_MISMATCH: Object.freeze(['backend', 'robot', 'provider-env', 'config-toml', 'binary', 'transcript-missing',
    'transcript-mismatch', 'binding-changed']),
  COPYBACK_REFUSED: Object.freeze(['invalid', 'other-account', 'stale-last-refresh', 'stream-changed', 'runtime-auth-missing',
    'runtime-copy-changed']),
  CLEANUP_INCOMPLETE: Object.freeze(['credential-not-persisted', 'credential-not-removed', 'robot-not-deleted',
    'folder-not-deleted', 'recovery-incomplete']),
  LEAK_DETECTED: Object.freeze(['artifact-contains-token']),
});

export class CodexAuthError extends Error {
  // `code` is a key of EXIT_CODES and `reason` one of its fixed reasons. The message never carries anything else.
  constructor(code, reason = null, extra = {}) {
    if (!Object.hasOwn(EXIT_CODES, code)) throw new TypeError('Unknown codex-test-auth exit code.');
    if (code !== 'OK' && !EXIT_REASONS[code].includes(reason)) throw new TypeError('Unknown codex-test-auth failure reason.');
    super(`codex-test-auth ${code}${reason ? ` ${reason}` : ''}`);
    this.name = 'CodexAuthError';
    this.code = code;
    this.reason = reason;
    this.exitCode = EXIT_CODES[code];
    Object.assign(this, extra);
  }
}

const fail = (code, reason, extra) => new CodexAuthError(code, reason, extra);

const STREAM_NAME = /^[a-z0-9][a-z0-9-]{2,40}$/;
const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const TOKEN = /^[0-9a-f]{32}$/;
const AUTH_LIMIT = 64 * 1024;
const FUTURE_SKEW_MS = 5 * 60 * 1000;
const NOFOLLOW = fs.constants.O_NOFOLLOW;
const READ_FLAGS = fs.constants.O_RDONLY | NOFOLLOW | fs.constants.O_NONBLOCK;
const CREATE_FLAGS = fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | NOFOLLOW;

export const isRunId = (value) => typeof value === 'string' && RUN_ID.test(value);
export const sha256Hex = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');

function currentUid() {
  return typeof process.getuid === 'function' ? process.getuid() : 0;
}

// Exported for the route-A location rules (lib/codex-test-auth-owner.mjs). Bodies are unchanged.
export function isInside(parent, child) {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

// The realpath of the nearest existing ancestor plus the remaining lexical tail, so a missing root can still be located.
export function locate(target) {
  let existing = path.resolve(target);
  const tail = [];
  for (;;) {
    try {
      return path.join(fs.realpathSync(existing), ...tail);
    } catch (error) {
      if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') throw error;
      const parent = path.dirname(existing);
      if (parent === existing) return path.resolve(target);
      tail.unshift(path.basename(existing));
      existing = parent;
    }
  }
}

function insideGitWorkTree(directory) {
  let current = directory;
  for (;;) {
    try {
      fs.lstatSync(path.join(current, '.git'));
      return true;
    } catch (error) {
      if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') throw error;
    }
    const parent = path.dirname(current);
    if (parent === current) return false;
    current = parent;
  }
}

export function resolveAuthPaths(env) {
  const own = (name) => (typeof env?.[name] === 'string' && env[name] !== '' ? env[name] : null);
  const absolute = (value) => {
    if (!path.isAbsolute(value) || value.includes('\0')) throw fail('USAGE', 'relative-path');
    return path.resolve(value);
  };
  let root;
  if (own('CODEX_TEST_AUTH_ROOT')) root = absolute(env.CODEX_TEST_AUTH_ROOT);
  else {
    const stateHome = own('XDG_STATE_HOME') ? absolute(env.XDG_STATE_HOME)
      : own('HOME') ? path.join(absolute(env.HOME), '.local', 'state') : null;
    if (!stateHome) throw fail('USAGE', 'bad-variable');
    root = path.join(stateHome, 'assistos-codex-test-auth');
  }
  const stream = own('CODEX_TEST_AUTH_STREAM') || 'apparatus-copilot';
  if (!STREAM_NAME.test(stream)) throw fail('USAGE', 'bad-variable');
  const streamDir = path.join(root, 'streams', stream);
  return Object.freeze({
    root, stream, streamsDir: path.join(root, 'streams'), streamDir, streamFile: path.join(streamDir, 'auth.json'),
    lockPath: path.join(root, 'run.lock'), inflightPath: path.join(root, 'inflight.json'), ownerInflightPath: path.join(root, 'inflight-owner.json'),
    seedDir: path.join(root, 'seed'), seedHome: path.join(root, 'seed', 'home'), seedCodexHome: path.join(root, 'seed', 'codex'),
    retiredDir: path.join(root, 'retired'),
    // Opened only by `seedStream` (route B) and by route A's owner module, never by another function of this library.
    liveCachePath: own('HOME') && path.isAbsolute(env.HOME) ? path.join(env.HOME, '.codex', 'auth.json') : null,
  });
}

function checkPrivateEntry(file, { directory, uid }) {
  let stat;
  try { stat = fs.lstatSync(file); } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw fail('STREAM_UNSAFE', 'owner-or-mode');
  }
  const kind = directory ? stat.isDirectory() : stat.isFile();
  if (!kind || stat.isSymbolicLink() || stat.uid !== uid || (stat.mode & 0o777) !== (directory ? 0o700 : 0o600)) {
    throw fail('STREAM_UNSAFE', 'owner-or-mode');
  }
  return true;
}

// Checks the location of ROOT and every existing private entry below it. Creates nothing: only `seed` creates ROOT.
export function assertPrivateRoot(paths, { forbiddenRoots = [], uid = currentUid() } = {}) {
  const located = locate(paths.root);
  if (insideGitWorkTree(fs.existsSync(located) ? located : path.dirname(located))) throw fail('STREAM_UNSAFE', 'location');
  for (const forbidden of forbiddenRoots) {
    if (typeof forbidden !== 'string' || forbidden === '') continue;
    const other = locate(forbidden);
    if (isInside(other, located) || isInside(located, other)) throw fail('STREAM_UNSAFE', 'location');
  }
  if (!checkPrivateEntry(paths.root, { directory: true, uid })) return { root: located, exists: false };
  for (const directory of [paths.streamsDir, paths.streamDir, paths.seedDir, paths.retiredDir]) {
    checkPrivateEntry(directory, { directory: true, uid });
  }
  checkPrivateEntry(paths.streamFile, { directory: false, uid });
  checkPrivateEntry(paths.inflightPath, { directory: false, uid });
  checkPrivateEntry(paths.ownerInflightPath, { directory: false, uid });
  for (const name of listStreamFiles(paths, /^quarantine-[A-Za-z0-9_-]+\.json$/)) {
    checkPrivateEntry(path.join(paths.streamDir, name), { directory: false, uid });
  }
  return { root: located, exists: true };
}

// `SMOKE_ARTIFACT_DIR` must be an existing absolute directory outside ROOT, every forbidden root and any git work tree,
// so a credential-bearing artifact can never land in source or in the stream.
export function assertArtifactDirectory(directory, { paths, forbiddenRoots = [] } = {}) {
  if (typeof directory !== 'string' || directory === '' || directory.includes('\0')) throw fail('USAGE', 'bad-variable');
  if (!path.isAbsolute(directory)) throw fail('USAGE', 'relative-path');
  let real;
  try {
    real = fs.realpathSync(directory);
    if (!fs.statSync(real).isDirectory()) throw fail('USAGE', 'artifact-dir-location');
  } catch (error) {
    if (error instanceof CodexAuthError) throw error;
    throw fail('USAGE', 'artifact-dir-location');
  }
  const root = locate(paths.root);
  const others = [root, ...forbiddenRoots.filter((entry) => typeof entry === 'string' && entry !== '').map(locate)];
  if (insideGitWorkTree(real) || others.some((other) => isInside(other, real) || isInside(real, other))) {
    throw fail('USAGE', 'artifact-dir-location');
  }
  return real;
}

function listStreamFiles(paths, pattern) {
  try {
    return fs.readdirSync(paths.streamDir).filter((name) => pattern.test(name)).sort();
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return [];
    throw error;
  }
}

function fsyncDirectory(directory) {
  const fd = fs.openSync(directory, fs.constants.O_RDONLY);
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}

// Creates a 0600 file that must not exist, with the mode set at creation. Returns nothing; EEXIST propagates.
function writeExclusive(file, bytes) {
  const fd = fs.openSync(file, CREATE_FLAGS, 0o600);
  try {
    let offset = 0;
    while (offset < bytes.length) offset += fs.writeSync(fd, bytes, offset, bytes.length - offset);
    fs.fsyncSync(fd);
    fs.fchmodSync(fd, 0o600);
  } finally { fs.closeSync(fd); }
}

// Reads a regular, single-link file through O_NOFOLLOW with a stable fstat. `private` additionally enforces owner and mode.
function readRegular(file, { limit = AUTH_LIMIT, uid = currentUid(), private: strict = true } = {}) {
  const fd = fs.openSync(file, READ_FLAGS);
  try {
    const before = fs.fstatSync(fd);
    if (!before.isFile() || before.nlink !== 1 || (strict && (before.uid !== uid || (before.mode & 0o777) !== 0o600))) {
      throw fail('STREAM_UNSAFE', 'owner-or-mode');
    }
    if (before.size > limit) throw fail('STREAM_UNSAFE', 'auth-invalid:oversize');
    const bytes = fs.readFileSync(fd);
    const after = fs.fstatSync(fd);
    if (bytes.length !== before.size || before.size !== after.size || before.mtimeMs !== after.mtimeMs) {
      throw fail('STREAM_UNSAFE', 'owner-or-mode');
    }
    return bytes;
  } finally { fs.closeSync(fd); }
}

const enoent = (error) => error?.code === 'ENOENT';

function exists(file) {
  try { fs.lstatSync(file); return true; } catch (error) {
    if (enoent(error) || error.code === 'ENOTDIR') return false;
    throw error;
  }
}

function decodeJwtExpiry(token) {
  try {
    const parts = String(token).split('.');
    if (parts.length < 2) return null;
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    return Number.isFinite(payload?.exp) ? payload.exp * 1000 : null;
  } catch { return null; }
}

function parseAuth(bytes) {
  let value;
  try { value = JSON.parse(Buffer.from(bytes).toString('utf8')); } catch { throw fail('STREAM_UNSAFE', 'auth-invalid:missing-field'); }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw fail('STREAM_UNSAFE', 'auth-invalid:missing-field');
  return value;
}

const nonEmpty = (value) => typeof value === 'string' && value !== '';
const ISO_8601 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

function lastRefreshMs(value) {
  if (!nonEmpty(value?.last_refresh) || !ISO_8601.test(value.last_refresh)) return null;
  const time = Date.parse(value.last_refresh);
  return Number.isFinite(time) ? time : null;
}

// Booleans, ages and the access-token validity only. camelCase keys, so raw credential key names never reach an artifact.
export function summarizeAuth(bytes, now = Date.now()) {
  const value = parseAuth(bytes);
  const tokens = value.tokens && typeof value.tokens === 'object' ? value.tokens : {};
  const refreshed = lastRefreshMs(value);
  const expiry = decodeJwtExpiry(tokens.access_token);
  const mode = typeof value.auth_mode === 'string' && /^[a-z][a-z_-]{0,19}$/.test(value.auth_mode) ? value.auth_mode : 'other';
  const hours = (milliseconds, places) => Number((milliseconds / 3_600_000).toFixed(places));
  return {
    authMode: mode,
    hasIdToken: nonEmpty(tokens.id_token),
    hasAccessToken: nonEmpty(tokens.access_token),
    hasRefreshToken: nonEmpty(tokens.refresh_token),
    hasAccountId: nonEmpty(tokens.account_id),
    hasLastRefresh: refreshed !== null,
    lastRefreshAgeHours: refreshed === null ? null : hours(+now - refreshed, 2),
    accessValidHours: expiry === null ? null : hours(expiry - +now, 3),
  };
}

// Checks the artifact itself, not the Codex version that wrote it. `liveCacheBytes` (seed only) may be one buffer or a list.
export function validateAuthArtifact(bytes, { now = Date.now(), liveCacheBytes = null } = {}) {
  if (!Buffer.isBuffer(bytes) && !(bytes instanceof Uint8Array)) throw fail('STREAM_UNSAFE', 'auth-invalid:missing-field');
  if (bytes.length > AUTH_LIMIT) throw fail('STREAM_UNSAFE', 'auth-invalid:oversize');
  const value = parseAuth(bytes);
  if (nonEmpty(value.OPENAI_API_KEY)) throw fail('STREAM_UNSAFE', 'auth-invalid:api-key');
  if (value.personal_access_token != null) throw fail('STREAM_UNSAFE', 'auth-invalid:pat');
  if (value.bedrock_api_key != null || value.bedrock_access_keys != null) throw fail('STREAM_UNSAFE', 'auth-invalid:bedrock');
  if (value.auth_mode !== 'chatgpt') throw fail('STREAM_UNSAFE', 'auth-invalid:not-chatgpt');
  const tokens = value.tokens;
  if (!tokens || typeof tokens !== 'object' || !['id_token', 'access_token', 'refresh_token', 'account_id'].every((name) => nonEmpty(tokens[name]))) {
    throw fail('STREAM_UNSAFE', 'auth-invalid:missing-field');
  }
  const refreshed = lastRefreshMs(value);
  if (refreshed === null) throw fail('STREAM_UNSAFE', 'auth-invalid:missing-field');
  if (refreshed > +now + FUTURE_SKEW_MS) throw fail('STREAM_UNSAFE', 'auth-invalid:future-last-refresh');
  const lives = liveCacheBytes === null ? [] : Array.isArray(liveCacheBytes) ? liveCacheBytes : [liveCacheBytes];
  for (const live of lives) {
    let other;
    try { other = parseAuth(live).tokens; } catch { continue; }
    if (['id_token', 'access_token', 'refresh_token'].some((name) => nonEmpty(other?.[name]) && other[name] === tokens[name])) {
      throw fail('STREAM_UNSAFE', 'seed-equals-live-cache');
    }
  }
  return summarizeAuth(bytes, now);
}

// ---- run lock -------------------------------------------------------------------------------------------------

function readProcessIdentity(procRoot, pid) {
  try {
    const stat = fs.readFileSync(path.join(procRoot, String(pid), 'stat'), 'utf8');
    // The command name may contain spaces and parentheses; the fixed fields start after the last ')'.
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    return { state: fields[0], start: fields[19] };
  } catch { return null; }
}

function readBootId(procRoot) {
  try { return fs.readFileSync(path.join(procRoot, 'sys/kernel/random/boot_id'), 'utf8').trim() || 'unknown'; } catch { return 'unknown'; }
}

function validOwner(owner) {
  return owner && typeof owner === 'object' && Number.isInteger(owner.pid) && owner.pid > 0 && nonEmpty(owner.start)
    && nonEmpty(owner.boot) && TOKEN.test(owner.token) && typeof owner.runId === 'string' && typeof owner.startedAt === 'string';
}

function ownerState(owner, procRoot) {
  if (!validOwner(owner)) return 'ambiguous';
  if (owner.boot !== readBootId(procRoot)) return 'dead';
  const current = readProcessIdentity(procRoot, owner.pid);
  if (!current) return 'dead';
  return current.start !== owner.start || ['Z', 'X'].includes(current.state) ? 'dead' : 'live';
}

function readLockOwner(lockPath) {
  let fd;
  try { fd = fs.openSync(lockPath, READ_FLAGS); } catch (error) {
    if (enoent(error)) return null;
    return { owner: null, ino: null };
  }
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size > 4096) return { owner: null, ino: stat.ino };
    try { return { owner: JSON.parse(fs.readFileSync(fd, 'utf8')), ino: stat.ino }; } catch { return { owner: null, ino: stat.ino }; }
  } finally { fs.closeSync(fd); }
}

// Read-only: `free`, `held` (live or ambiguous owner) or `stale` (a provably dead owner; does not block). A leftover recovery
// claim means a recoverer died mid-recovery: that needs reconciliation by an operator, so it reads as held.
export function lockStatus(paths, { procRoot = '/proc' } = {}) {
  const observed = readLockOwner(paths.lockPath);
  if (exists(`${paths.lockPath}.recovery`)) return { state: 'held', reason: 'ambiguous-owner' };
  if (observed === null) return { state: 'free', reason: null };
  const state = ownerState(observed.owner, procRoot);
  if (state === 'dead') return { state: 'stale', reason: null };
  return { state: 'held', reason: state === 'live' ? 'live-owner' : 'ambiguous-owner' };
}

export function inspectLock(paths, options) {
  return lockStatus(paths, options).state;
}

function unlinkIfSameInode(file, ino) {
  try {
    if (fs.lstatSync(file).ino === ino) fs.unlinkSync(file);
  } catch (error) { if (!enoent(error)) throw error; }
}

function sweepNextFiles(paths) {
  for (const name of listStreamFiles(paths, /^auth\.json\.next-[A-Za-z0-9_-]+$/)) {
    try { fs.unlinkSync(path.join(paths.streamDir, name)); } catch (error) { if (!enoent(error)) throw error; }
  }
}

// Takes the exclusive host lock with link(2). A dead owner is recovered through a claim link and an inode check; after a
// recovery, and while holding the lock, the dead owner's candidate file and leftover next-credential files are removed.
export function acquireRunLock(paths, { runId, procRoot = '/proc', now = Date.now() } = {}) {
  if (!isRunId(runId)) throw fail('USAGE', 'bad-variable');
  const token = crypto.randomBytes(16).toString('hex');
  const identity = readProcessIdentity(procRoot, process.pid);
  const owner = { pid: process.pid, start: identity?.start ?? 'unknown', boot: readBootId(procRoot), token, runId,
    startedAt: new Date(now).toISOString() };
  const candidate = path.join(paths.root, `.run-owner-${token}.json`);
  writeExclusive(candidate, Buffer.from(JSON.stringify(owner)));
  let recovered = false;
  try {
    for (let attempt = 0; attempt < 6; attempt += 1) {
      try {
        fs.linkSync(candidate, paths.lockPath);
        if (recovered) sweepNextFiles(paths);
        return {
          recovered,
          release() {
            const current = readLockOwner(paths.lockPath);
            if (current?.owner?.token === token) {
              try { fs.unlinkSync(paths.lockPath); } catch (error) { if (!enoent(error)) throw error; }
            }
            try { fs.unlinkSync(candidate); } catch (error) { if (!enoent(error)) throw error; }
          },
        };
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
      }
      const observed = readLockOwner(paths.lockPath);
      if (observed === null) continue;
      const state = ownerState(observed.owner, procRoot);
      if (state === 'live') throw fail('LOCK_HELD', 'live-owner');
      if (state === 'ambiguous') throw fail('LOCK_HELD', 'ambiguous-owner');
      // Dead owner: claim the exact inode that was inspected under one fixed claim name, so only one recoverer can act at a time.
      // An existing claim fails closed (a recoverer is active or died mid-recovery), like the RoboTeam registry lock.
      const claim = `${paths.lockPath}.recovery`;
      try { fs.linkSync(paths.lockPath, claim); } catch (error) {
        if (enoent(error)) continue;
        if (error.code === 'EEXIST') throw fail('LOCK_HELD', 'ambiguous-owner');
        throw error;
      }
      try {
        if (fs.lstatSync(claim).ino !== observed.ino) continue;
        unlinkIfSameInode(paths.lockPath, observed.ino);
        if (TOKEN.test(observed.owner.token)) unlinkIfSameInode(path.join(paths.root, `.run-owner-${observed.owner.token}.json`), observed.ino);
        recovered = true;
      } finally {
        try { fs.unlinkSync(claim); } catch (error) { if (!enoent(error)) throw error; }
      }
    }
    throw fail('LOCK_HELD', 'ambiguous-owner');
  } catch (error) {
    try { fs.unlinkSync(candidate); } catch (cleanup) { if (!enoent(cleanup)) throw cleanup; }
    throw error;
  }
}

// ---- stream ---------------------------------------------------------------------------------------------------

// Memory only. Throws NOT_SEEDED without a stream. The caller holds the lock when it intends to write.
export function loadStream(paths, { now = Date.now(), uid = currentUid() } = {}) {
  let bytes;
  try { bytes = readRegular(paths.streamFile, { uid }); } catch (error) {
    if (enoent(error) || error.code === 'ENOTDIR') throw fail('NOT_SEEDED', 'no-stream');
    if (error.code === 'ELOOP' || error.code === 'ENXIO') throw fail('STREAM_UNSAFE', 'owner-or-mode');
    throw error;
  }
  return { bytes, sha256: sha256Hex(bytes), summary: validateAuthArtifact(bytes, { now }) };
}

const INFLIGHT_ROUTES = ['stream', 'owner'];

function inflightFile(paths, route) {
  if (!INFLIGHT_ROUTES.includes(route)) throw fail('USAGE', 'bad-variable');
  return route === 'owner' ? paths.ownerInflightPath : paths.inflightPath;
}

export function inflightPresent(paths, { route = 'stream' } = {}) {
  try { fs.lstatSync(inflightFile(paths, route)); return true; } catch (error) {
    if (enoent(error)) return false;
    throw error;
  }
}

// The stream-only commands refuse while either route's marker exists.
const anyInflightPresent = (paths) => inflightPresent(paths) || inflightPresent(paths, { route: 'owner' });

export function listQuarantines(paths) {
  return listStreamFiles(paths, /^quarantine-[A-Za-z0-9_-]+\.json$/).map((name) => name.slice('quarantine-'.length, -'.json'.length));
}

// Everything `preflight` reports about the host side. Read-only.
export function inspectStream(paths, { now = Date.now(), procRoot = '/proc', uid = currentUid() } = {}) {
  const loaded = loadStream(paths, { now, uid });
  return { auth: loaded.summary, lock: inspectLock(paths, { procRoot }), inflight: inflightPresent(paths) ? 'present' : 'absent',
    quarantineCount: listQuarantines(paths).length };
}

function mkdirPrivate(directory) {
  fs.mkdirSync(directory, { mode: 0o700, recursive: true });
  fs.chmodSync(directory, 0o700);
}

// Route A: creates ROOT (0700) only when it is absent, after the location and mode checks, and nothing below it.
export function ensurePrivateRoot(paths, { forbiddenRoots = [], uid = currentUid() } = {}) {
  const checked = assertPrivateRoot(paths, { forbiddenRoots, uid });
  if (checked.exists) return { root: checked.root, created: false };
  mkdirPrivate(paths.root);
  return { root: assertPrivateRoot(paths, { forbiddenRoots, uid }).root, created: true };
}

function snapshotLiveCache(file) {
  if (!file) return null;
  let fd;
  try { fd = fs.openSync(file, READ_FLAGS); } catch (error) {
    if (enoent(error)) return null;
    throw fail('STREAM_UNSAFE', 'main-login-changed');
  }
  try {
    const stat = fs.fstatSync(fd);
    const bytes = stat.isFile() && stat.size <= 4 * 1024 * 1024 ? fs.readFileSync(fd) : Buffer.alloc(0);
    let account = null;
    let refreshed = null;
    try {
      const value = JSON.parse(bytes.toString('utf8'));
      account = nonEmpty(value?.tokens?.account_id) ? value.tokens.account_id : null;
      refreshed = lastRefreshMs(value);
    } catch { /* an unparsable cache is only compared by identity */ }
    return { bytes, ino: stat.ino, size: stat.size, mtimeMs: stat.mtimeMs, sha256: sha256Hex(bytes), account, refreshed };
  } finally { fs.closeSync(fd); }
}

function sameSnapshot(a, b) {
  if (a === null || b === null) return a === b;
  return a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs && a.sha256 === b.sha256;
}

// Never executed: the version is read from a `releases/<semver>-` path segment of the seed binary's realpath.
export function parseSeedClientVersion(realPath) {
  return /(?:^|\/)releases\/(\d+\.\d+\.\d+)-/.exec(String(realPath))?.[1] ?? 'unknown';
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

// One-time import of the separate login. The operator step is injected: it receives the exact login command and returns
// when the login command has exited. `ROOT/seed` is removed on every exit path once the lock is held.
export async function seedStream(paths, { waitForOperator, seedBin, now = Date.now(), procRoot = '/proc', uid = currentUid(),
  runId = 'seed' } = {}) {
  if (typeof waitForOperator !== 'function' || typeof seedBin !== 'string' || !path.isAbsolute(seedBin) || /[\0\n\r]/.test(seedBin)) {
    throw fail('USAGE', 'bad-variable');
  }
  assertPrivateRoot(paths, { uid });
  mkdirPrivate(paths.root);
  assertPrivateRoot(paths, { uid });
  const lock = acquireRunLock(paths, { runId, procRoot, now });
  try {
    if (exists(paths.streamFile)) throw fail('ALREADY_SEEDED', 'stream-exists');
    if (anyInflightPresent(paths)) throw fail('STREAM_UNSAFE', 'inflight-present');
    if (exists(path.join(paths.seedCodexHome, 'auth.json'))) throw fail('STREAM_UNSAFE', 'seed-already-present');
    const before = snapshotLiveCache(paths.liveCachePath);
    fs.rmSync(paths.seedDir, { recursive: true, force: true });
    mkdirPrivate(paths.seedHome);
    mkdirPrivate(paths.seedCodexHome);
    const command = `HOME=${shellQuote(paths.seedHome)} CODEX_HOME=${shellQuote(paths.seedCodexHome)} ${shellQuote(seedBin)} -c cli_auth_credentials_store=file login --device-auth`;
    await waitForOperator({ command });
    const source = path.join(paths.seedCodexHome, 'auth.json');
    let sourceStat;
    try { sourceStat = fs.lstatSync(source); } catch (error) {
      if (enoent(error)) throw fail('STREAM_UNSAFE', 'seed-source-missing');
      throw error;
    }
    if (sourceStat.isSymbolicLink() || fs.lstatSync(paths.seedCodexHome).isSymbolicLink()) throw fail('STREAM_UNSAFE', 'seed-source-symlink');
    let bytes;
    try { bytes = readRegular(source, { uid, private: false }); } catch (error) {
      if (error.code === 'ELOOP') throw fail('STREAM_UNSAFE', 'seed-source-symlink');
      throw error;
    }
    const after = snapshotLiveCache(paths.liveCachePath);
    const summary = validateAuthArtifact(bytes, { now, liveCacheBytes: [before?.bytes, after?.bytes].filter(Boolean) });
    let mainLoginUnchanged = true;
    if (!sameSnapshot(before, after)) {
      const advanced = before && after && before.account !== null && before.account === after.account
        && before.refreshed !== null && after.refreshed !== null && after.refreshed > before.refreshed;
      if (!advanced) throw fail('STREAM_UNSAFE', 'main-login-changed');
      mainLoginUnchanged = 'inconclusive';
    }
    mkdirPrivate(paths.streamsDir);
    mkdirPrivate(paths.streamDir);
    try { writeExclusive(paths.streamFile, bytes); } catch (error) {
      if (error.code === 'EEXIST') throw fail('ALREADY_SEEDED', 'stream-exists');
      throw error;
    }
    fsyncDirectory(paths.streamDir);
    let realBin = seedBin;
    try { realBin = fs.realpathSync(seedBin); } catch { /* the command is only printed, never executed */ }
    return { auth: summary, mainLoginUnchanged, seedClientPath: realBin, seedClientVersion: parseSeedClientVersion(realBin) };
  } finally {
    try { fs.rmSync(paths.seedDir, { recursive: true, force: true }); } finally { lock.release(); }
  }
}

function utcStamp(now) {
  return new Date(now).toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
}

// Renames the stream, with anything stored beside it, to retired/<stream>-<UTC>. The operator deletes retired streams.
export function retireStream(paths, { now = Date.now(), procRoot = '/proc', uid = currentUid(), runId = 'retire' } = {}) {
  assertPrivateRoot(paths, { uid });
  if (!exists(paths.root)) throw fail('NOT_SEEDED', 'no-stream');
  const lock = acquireRunLock(paths, { runId, procRoot, now });
  try {
    if (!exists(paths.streamFile)) throw fail('NOT_SEEDED', 'no-stream');
    if (anyInflightPresent(paths)) throw fail('STREAM_UNSAFE', 'inflight-present');
    mkdirPrivate(paths.retiredDir);
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const target = path.join(paths.retiredDir, `${paths.stream}-${utcStamp(now)}${attempt ? `-${attempt}` : ''}`);
      if (fs.existsSync(target)) continue;
      fs.renameSync(paths.streamDir, target);
      fsyncDirectory(paths.retiredDir);
      return { retiredTo: path.basename(target) };
    }
    throw fail('STREAM_UNSAFE', 'location');
  } finally { lock.release(); }
}

// Installs a validated quarantined artifact as the stream. An explicit operator decision: the monotonic rule is reported.
export function adoptQuarantine(paths, { runId, now = Date.now(), procRoot = '/proc', uid = currentUid() } = {}) {
  if (!isRunId(runId)) throw fail('USAGE', 'bad-variable');
  assertPrivateRoot(paths, { uid });
  if (!exists(paths.root)) throw fail('NOT_SEEDED', 'no-stream');
  const lock = acquireRunLock(paths, { runId: `adopt-${runId}`.slice(0, 64), procRoot, now });
  try {
    if (!exists(paths.streamFile)) throw fail('NOT_SEEDED', 'no-stream');
    if (anyInflightPresent(paths)) throw fail('STREAM_UNSAFE', 'inflight-present');
    const quarantine = path.join(paths.streamDir, `quarantine-${runId}.json`);
    let bytes;
    try { bytes = readRegular(quarantine, { uid }); } catch (error) {
      if (enoent(error)) throw fail('STREAM_UNSAFE', 'quarantine-missing');
      if (error.code === 'ELOOP') throw fail('STREAM_UNSAFE', 'owner-or-mode');
      throw error;
    }
    const summary = validateAuthArtifact(bytes, { now });
    let sameAccount = false;
    let lastRefreshAdvanced = false;
    try {
      const current = parseAuth(readRegular(paths.streamFile, { uid }));
      const next = parseAuth(bytes);
      sameAccount = current.tokens?.account_id === next.tokens?.account_id;
      lastRefreshAdvanced = sameAccount && lastRefreshMs(next) > lastRefreshMs(current);
    } catch { /* an unreadable current stream is replaced by the operator's decision */ }
    const next = path.join(paths.streamDir, `auth.json.next-${runId}`);
    try { fs.unlinkSync(next); } catch (error) { if (!enoent(error)) throw error; }
    writeExclusive(next, bytes);
    try {
      fs.renameSync(next, paths.streamFile);
    } catch (error) {
      try { fs.unlinkSync(next); } catch { /* the original error is the one that matters */ }
      throw error;
    }
    fs.unlinkSync(quarantine);
    fsyncDirectory(paths.streamDir);
    return { auth: summary, sameAccount, lastRefreshAdvanced };
  } finally { lock.release(); }
}

// Persists the runtime bytes of a refused copy-back. An identical existing quarantine of this run counts as persisted.
function writeQuarantine(paths, runId, bytes) {
  const file = path.join(paths.streamDir, `quarantine-${runId}.json`);
  try {
    writeExclusive(file, bytes);
    fsyncDirectory(paths.streamDir);
  } catch (error) {
    if (error.code !== 'EEXIST') throw fail('CLEANUP_INCOMPLETE', 'credential-not-persisted');
    let existing;
    try { existing = readRegular(file, { limit: 4 * 1024 * 1024 }); } catch { throw fail('CLEANUP_INCOMPLETE', 'credential-not-persisted'); }
    if (!existing.equals(bytes)) throw fail('CLEANUP_INCOMPLETE', 'credential-not-persisted');
  }
}

// Monotonic compare-and-swap of the possibly refreshed runtime bytes into the stream. The caller holds the lock.
// Identical bytes write nothing. Any refusal writes `quarantine-<runId>.json` and throws COPYBACK_REFUSED.
export function acceptCopyBack(paths, { loadedSha256, loadedBytes, runtimeBytes, runId, now = Date.now(), uid = currentUid() } = {}) {
  if (!isRunId(runId) || !Buffer.isBuffer(loadedBytes) || !Buffer.isBuffer(runtimeBytes) || !/^[0-9a-f]{64}$/.test(loadedSha256 || '')) {
    throw fail('USAGE', 'bad-variable');
  }
  if (runtimeBytes.equals(loadedBytes)) {
    return { replaced: false, refreshedDuringRun: false, lastRefreshAdvanced: false, sameAccount: true };
  }
  const refuse = (reason) => {
    writeQuarantine(paths, runId, runtimeBytes);
    return fail('COPYBACK_REFUSED', reason, { quarantined: true });
  };
  try { validateAuthArtifact(runtimeBytes, { now }); } catch { throw refuse('invalid'); }
  const loaded = parseAuth(loadedBytes);
  const runtime = parseAuth(runtimeBytes);
  if (runtime.tokens.account_id !== loaded.tokens?.account_id) throw refuse('other-account');
  const runtimeRefresh = lastRefreshMs(runtime);
  const loadedRefresh = lastRefreshMs(loaded);
  if (loadedRefresh !== null && runtimeRefresh < loadedRefresh) throw refuse('stale-last-refresh');
  const unchanged = () => {
    try { return sha256Hex(readRegular(paths.streamFile, { uid })) === loadedSha256; } catch { return false; }
  };
  if (!unchanged()) throw refuse('stream-changed');
  const next = path.join(paths.streamDir, `auth.json.next-${runId}`);
  try { fs.unlinkSync(next); } catch (error) { if (!enoent(error)) throw fail('CLEANUP_INCOMPLETE', 'credential-not-persisted'); }
  try {
    writeExclusive(next, runtimeBytes);
    // The stream must still be the bytes that were loaded, immediately before the atomic replace.
    if (!unchanged()) throw refuse('stream-changed');
    fs.renameSync(next, paths.streamFile);
    fsyncDirectory(paths.streamDir);
  } catch (error) {
    try { fs.unlinkSync(next); } catch { /* already renamed or never created */ }
    if (error instanceof CodexAuthError) throw error;
    throw fail('CLEANUP_INCOMPLETE', 'credential-not-persisted');
  }
  return { replaced: true, refreshedDuringRun: true, lastRefreshAdvanced: loadedRefresh === null || runtimeRefresh > loadedRefresh, sameAccount: true };
}

// ---- inflight marker -----------------------------------------------------------------------------------------

const ROBOT_NAME = /^codex-auth-test-[A-Za-z0-9_-]{1,64}$/;
const FOLDER_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export function createInflight(paths, { runId, robotName, folder, route = 'stream' }) {
  const file = inflightFile(paths, route);
  if (!isRunId(runId) || !ROBOT_NAME.test(robotName) || !FOLDER_NAME.test(folder)) throw fail('USAGE', 'bad-variable');
  // Route B only exists while a stream exists. Route A has no stream.
  if (route === 'stream' && !exists(paths.streamFile)) throw fail('NOT_SEEDED', 'no-stream');
  try {
    writeExclusive(file, Buffer.from(JSON.stringify({ runId, robotName, folder })));
    fsyncDirectory(paths.root);
  } catch (error) {
    if (error.code === 'EEXIST') throw fail('STREAM_UNSAFE', 'inflight-present');
    throw error;
  }
  return { runId, robotName, folder };
}

export function readInflight(paths, { uid = currentUid(), route = 'stream' } = {}) {
  const file = inflightFile(paths, route);
  let bytes;
  try { bytes = readRegular(file, { limit: 4096, uid }); } catch (error) {
    if (enoent(error)) return null;
    throw fail('STREAM_UNSAFE', 'inflight-present');
  }
  try {
    const marker = JSON.parse(bytes.toString('utf8'));
    if (!isRunId(marker.runId) || !ROBOT_NAME.test(marker.robotName) || !FOLDER_NAME.test(marker.folder)) throw new Error('invalid');
    return { runId: marker.runId, robotName: marker.robotName, folder: marker.folder };
  } catch { throw fail('STREAM_UNSAFE', 'inflight-present'); }
}

export function removeInflight(paths, { route = 'stream' } = {}) {
  const file = inflightFile(paths, route);
  try { fs.unlinkSync(file); fsyncDirectory(paths.root); } catch (error) { if (!enoent(error)) throw error; }
}

// Each route refuses the other route's marker before any recovery, so a route-A copy is never handled by route-B code.
export function assertNoOtherRouteInflight(paths, route) {
  const other = route === 'owner' ? 'stream' : route === 'stream' ? 'owner' : null;
  if (other === null) throw fail('USAGE', 'bad-variable');
  if (inflightPresent(paths, { route: other })) throw fail('STREAM_UNSAFE', 'inflight-other-route');
}

// A run refuses while an unresolved quarantine exists. The operator resolves it with `adopt` or `retire`.
export function assertNoQuarantine(paths) {
  if (listQuarantines(paths).length > 0) throw fail('STREAM_UNSAFE', 'quarantine-pending');
}

const TEST_ROBOT_PREFIX = 'codex-auth-test-';

// Recovery touches only the robot named by `inflight.json`. Any other test robot is the operator's to delete.
// `robots` is the in-RoboTeam inventory: `[{ id, name, codexAuthPresent }]`.
export function planRecovery({ inflight, robots }) {
  const test = robots.filter((robot) => typeof robot.name === 'string' && robot.name.startsWith(TEST_ROBOT_PREFIX));
  if (test.some((robot) => robot.name !== inflight?.robotName)) throw fail('RUNTIME_PREREQ_FAILED', 'unowned-leftover-robot');
  if (!inflight) return { action: 'none', robot: null };
  const robot = test.find((entry) => entry.name === inflight.robotName) || null;
  if (!robot) return { action: 'folder-only', robot: null };
  return { action: robot.codexAuthPresent ? 'copy-back-then-delete' : 'delete', robot };
}

// robot-delete accepts 200; a 404 only for the robot that `inflight.json` names (it is already gone).
export function robotDeleteAccepted(status, { robotName, markerRobotName = null }) {
  return status === 200 || (status === 404 && markerRobotName !== null && markerRobotName === robotName);
}

// ---- credential session -----------------------------------------------------------------------------------------

// The credential bytes of one run, with their moves. `runtime` is the Box runner (inject, readForCopyBack, remove). The
// stream is only written while the host lock is held. After a recovery has persisted a previous crashed run's runtime copy,
// the stream is reloaded, so the credential injected afterwards is always the current stream and never superseded bytes.
export function createCredentialSession({ paths, runtime, runId, now = Date.now, uid = currentUid() }) {
  const freshStream = () => ({ sameAccount: null, refreshedDuringRun: false, lastRefreshAdvanced: false, replaced: false, quarantined: false });
  const state = { lockHeld: false, loaded: null, runtimeBytes: null, persisted: false, removed: false, injected: false,
    injectConfirmed: false, stream: freshStream(), recoveryStream: null };
  const api = {
    state,
    holdLock(held) { state.lockHeld = held === true; },
    load() {
      state.loaded = loadStream(paths, { now: now(), uid });
      return state.loaded;
    },
    // Persist-or-quarantine the runtime copy, then remove it with the persisted hash. `target` is the robot holding the copy.
    async persistAndRemove(target, { confirmed }) {
      if (!state.persisted) {
        let copied;
        try { copied = await runtime.readForCopyBack(target, { timeoutMs: 30_000 }); } catch (error) {
          if (error?.code === 'NOT_FOUND') {
            // Nothing exists to persist or remove. The stream is unchanged and no quarantine is written.
            state.persisted = true;
            state.removed = true;
            if (confirmed) throw fail('COPYBACK_REFUSED', 'runtime-auth-missing');
            return;
          }
          throw fail('CLEANUP_INCOMPLETE', 'credential-not-persisted');
        }
        state.runtimeBytes = copied.bytes;
        if (!state.lockHeld || !state.loaded) throw fail('CLEANUP_INCOMPLETE', 'credential-not-persisted');
        try {
          const outcome = acceptCopyBack(paths, { loadedSha256: state.loaded.sha256, loadedBytes: state.loaded.bytes,
            runtimeBytes: state.runtimeBytes, runId, now: now(), uid });
          Object.assign(state.stream, { sameAccount: outcome.sameAccount, refreshedDuringRun: outcome.refreshedDuringRun,
            lastRefreshAdvanced: outcome.lastRefreshAdvanced, replaced: outcome.replaced });
          state.persisted = true;
        } catch (error) {
          if (!(error instanceof CodexAuthError)) throw fail('CLEANUP_INCOMPLETE', 'credential-not-persisted');
          if (error.quarantined) {
            state.persisted = true;
            state.stream.quarantined = true;
            state.stream.refreshedDuringRun = true;
            if (error.reason === 'other-account') state.stream.sameAccount = false;
            try { await runtime.remove(target, sha256Hex(state.runtimeBytes)); state.removed = true; } catch { throw fail('CLEANUP_INCOMPLETE', 'credential-not-removed'); }
          }
          throw error;
        }
      }
      if (!state.removed) {
        try { await runtime.remove(target, sha256Hex(state.runtimeBytes)); state.removed = true; } catch { throw fail('CLEANUP_INCOMPLETE', 'credential-not-removed'); }
      }
    },
    // Exec-chain half of recovering a previous crashed run: persist or quarantine its runtime copy, remove it, then reload
    // the stream. Returns the copy-back refusal, if any, which the caller raises after the robot and folder are gone.
    async recover(target) {
      let refusal = null;
      try { await api.persistAndRemove(target, { confirmed: true }); } catch (error) {
        if (error instanceof CodexAuthError && error.code === 'COPYBACK_REFUSED') refusal = error;
        else throw fail('CLEANUP_INCOMPLETE', 'recovery-incomplete');
      }
      // The recovered copy no longer counts for this run's own persist and remove.
      state.recoveryStream = state.stream;
      state.stream = freshStream();
      state.persisted = false;
      state.removed = false;
      state.runtimeBytes = null;
      api.load();
      return { refusal };
    },
    // Injects the loaded stream bytes. `injected` is set first, so a failure of unknown outcome still gets a copy-back.
    async inject(robot) {
      if (!state.loaded) throw fail('USAGE', 'bad-variable');
      state.injected = true;
      await runtime.inject(robot, state.loaded.bytes);
      state.injectConfirmed = true;
    },
  };
  return api;
}

// ---- leak scan and failure classification --------------------------------------------------------------------

function leakSecrets(tokenSets) {
  const secrets = [];
  for (const set of tokenSets) {
    const bytes = Buffer.isBuffer(set) ? set : Buffer.from(String(set));
    let tokens = {};
    try { tokens = JSON.parse(bytes.toString('utf8'))?.tokens || {}; } catch { /* only the whole-file forms apply */ }
    for (const [name, key] of [['idToken', 'id_token'], ['accessToken', 'access_token'], ['refreshToken', 'refresh_token'], ['accountId', 'account_id']]) {
      if (nonEmpty(tokens[key])) secrets.push({ name, value: tokens[key] });
    }
    secrets.push({ name: 'wholeFile', value: bytes.toString('utf8') });
    secrets.push({ name: 'wholeFileBase64', value: bytes.toString('base64') });
    secrets.push({ name: 'wholeFileBase64Url', value: bytes.toString('base64url') });
  }
  return secrets.filter((entry) => entry.value.length >= 8);
}

function* walk(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) yield* walk(full);
    else if (entry.isFile()) yield full;
  }
}

// Every credential a scan must look for: the current stream, pending quarantine files, and retired streams with theirs.
// Unreadable or oversize entries are skipped; an empty result is refused by `scanLeaks`.
export function collectScanReferences(paths, { uid = currentUid() } = {}) {
  const sets = [];
  const take = (file) => { try { sets.push(readRegular(file, { limit: 1024 * 1024, uid, private: false })); } catch { /* skipped */ } };
  take(paths.streamFile);
  for (const runId of listQuarantines(paths)) take(path.join(paths.streamDir, `quarantine-${runId}.json`));
  let retired = [];
  try { retired = fs.readdirSync(paths.retiredDir, { withFileTypes: true }).filter((entry) => entry.isDirectory()); } catch { retired = []; }
  for (const entry of retired) {
    const directory = path.join(paths.retiredDir, entry.name);
    take(path.join(directory, 'auth.json'));
    let names = [];
    try { names = fs.readdirSync(directory).filter((name) => /^quarantine-[A-Za-z0-9_-]+\.json$/.test(name)); } catch { names = []; }
    for (const name of names) take(path.join(directory, name));
  }
  return sets;
}

// Reports the relative file and a camelCase field name only. Never a value.
export function scanLeaks(directory, tokenSets) {
  const secrets = leakSecrets(tokenSets);
  // A scan with nothing to look for would pass vacuously, which must never read as clean.
  if (secrets.length === 0) throw fail('STREAM_UNSAFE', 'scan-reference-missing');
  const leaks = [];
  let filesScanned = 0;
  for (const file of walk(directory)) {
    const stat = fs.lstatSync(file);
    if (stat.size > 512 * 1024 * 1024) continue;
    filesScanned += 1;
    const text = fs.readFileSync(file).toString('utf8');
    for (const field of new Set(findSecretLeaks(text, secrets))) leaks.push({ file: path.relative(directory, file), field });
  }
  return { leaks, filesScanned };
}

const AUTH_REJECTION = /\b401\b|unauthori[sz]ed|not logged in|log ?in|refresh token|token (?:expired|revoked|was already used)/i;

export function classifyTurnFailure(sanitizedText) {
  return { authRejectionSuspected: AUTH_REJECTION.test(String(sanitizedText ?? '')) };
}

// ---- sanitized output ----------------------------------------------------------------------------------------

// The one stdout line of every subcommand. Fixed keys first; subcommand additions follow.
export function resultLine(fields) {
  const { command, result, code = 'OK', reason = null, stream = null, refreshedDuringRun = false,
    authRejectionSuspected = false, cleanup = 'n/a', artifactDirectory = null, ...extra } = fields;
  return JSON.stringify({ command, result, code, reason, exitCode: EXIT_CODES[code], stream, refreshedDuringRun,
    authRejectionSuspected, cleanup, artifactDirectory, ...extra });
}

export function describeFailure(error) {
  if (error instanceof CodexAuthError) return { code: error.code, reason: error.reason };
  return { code: 'INTERNAL', reason: 'exception' };
}

// The outcome of one `run`, for both routes. Pure. Precedence: a leak (27), an unproven leak-scan coverage (route A, 14), a missing
// result file, incomplete cleanup (26), the worker's first failure, a failing Playwright exit, then success.
export function decideRunOutcome({ leaks, coverageFailure = false, result, exitedCode }) {
  const leaked = Array.isArray(leaks) ? leaks.length > 0 : Number(leaks) > 0;
  const summary = { refreshedDuringRun: result?.stream?.refreshedDuringRun === true, authRejectionSuspected: result?.authRejectionSuspected === true,
    cleanup: result?.cleanup && Object.values(result.cleanup).every(Boolean) ? 'complete' : 'incomplete' };
  if (leaked) return { ...summary, result: 'failed', code: 'LEAK_DETECTED', reason: 'artifact-contains-token' };
  if (coverageFailure) return { ...summary, result: 'failed', code: 'STREAM_UNSAFE', reason: 'scan-reference-missing' };
  if (result === null || result === undefined) return { ...summary, cleanup: 'incomplete', result: 'failed', code: 'INTERNAL', reason: 'no-result-file' };
  if (result.code === 'CLEANUP_INCOMPLETE' || (result.code !== 'OK' && summary.cleanup === 'incomplete')) {
    return { ...summary, result: 'failed', code: 'CLEANUP_INCOMPLETE', reason: result.code === 'CLEANUP_INCOMPLETE' ? result.reason : 'recovery-incomplete' };
  }
  if (result.code !== 'OK') return { ...summary, result: 'failed', code: result.code, reason: result.reason ?? null };
  if (exitedCode !== 0) return { ...summary, result: 'failed', code: 'INTERNAL', reason: 'exception' };
  return { ...summary, result: 'passed', code: 'OK', reason: null };
}
