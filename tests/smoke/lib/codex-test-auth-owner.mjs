import fs from 'node:fs';
import path from 'node:path';

import { CodexAuthError, isInside, locate, sha256Hex, summarizeAuth, validateAuthArtifact } from './codex-test-auth.mjs';

// Route A of the Codex-authenticated Copilot gate: the machine owner's existing Codex login is read, read-only, and an
// access-only credential is derived from three of its fields (the access token, the account id and last_refresh). The derived
// credential has no refresh token, so the owner keeps sole refresh ownership. Nothing here writes a file, spawns a process or
// touches the network: the only filesystem calls are the read-only open, stat, read and close of the one owner file, and
// `locate()` from the base library. Credential bytes live in memory only. The derived shape is undocumented use of Codex's
// file store, so it is relied on only for client builds that passed qualification (lib/codex-client-qualification.mjs).

export const CREDENTIAL_SOURCES = Object.freeze(['owner', 'stream']);
export const STREAM_ONLY_COMMANDS = Object.freeze(['seed', 'retire', 'adopt']);
// The claim Codex reads the account id from, inside the access token.
export const ACCOUNT_CLAIM_KEY = 'https://api.openai.com/auth';
// Names the exact derived shape. Any change to the shape must change this id, which unqualifies every allowlist entry.
export const DERIVED_SHAPE_ID = 'chatgptAuthTokens-v1';
// Codex's own near-expiry window. It also covers clock skew between the host and the token authority.
export const ACCESS_SKEW_MS = 5 * 60_000;

const fail = (code, reason, extra) => new CodexAuthError(code, reason, extra);

const OWNER_LIMIT = 64 * 1024;
const ACCOUNT_ID = /^[\x21-\x7e]{1,256}$/;
const BASE64URL = /^[A-Za-z0-9_-]+$/;
const ISO_8601 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
const READ_FLAGS = fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK;
const TOKEN_FIELDS = ['id_token', 'access_token', 'refresh_token', 'account_id'];

const currentUid = () => (typeof process.getuid === 'function' ? process.getuid() : 0);
const defaultSleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const nonEmpty = (value) => typeof value === 'string' && value !== '';
const plainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

// ---- route selection ------------------------------------------------------------------------------------------

// `preflight`, `run` and `scan-leaks` default to the owner route. The stream-only commands default to the stream and refuse
// an explicit owner. Any other value is refused, case-sensitively. There is no automatic fallback between the routes.
export function resolveCredentialSource(env, { command } = {}) {
  const raw = env?.CODEX_TEST_AUTH_SOURCE;
  const streamOnly = STREAM_ONLY_COMMANDS.includes(command);
  if (raw === undefined || raw === '') return streamOnly ? 'stream' : 'owner';
  if (typeof raw !== 'string' || !CREDENTIAL_SOURCES.includes(raw)) throw fail('USAGE', 'bad-variable');
  if (raw === 'owner' && streamOnly) throw fail('USAGE', 'route-mismatch');
  return raw;
}

// ---- the owner file: path and location ------------------------------------------------------------------------

// Derived only from the environment object that is passed in.
function ownerFileFrom(env) {
  const override = nonEmpty(env?.CODEX_TEST_AUTH_OWNER_AUTH) ? env.CODEX_TEST_AUTH_OWNER_AUTH : null;
  if (override !== null) {
    if (/[\0\r\n]/.test(override)) throw fail('USAGE', 'bad-variable');
    if (!path.isAbsolute(override)) throw fail('USAGE', 'relative-path');
    return { file: path.resolve(override), source: 'override' };
  }
  const home = nonEmpty(env?.HOME) ? env.HOME : null;
  if (home === null || /[\0\r\n]/.test(home)) throw fail('USAGE', 'bad-variable');
  if (!path.isAbsolute(home)) throw fail('USAGE', 'relative-path');
  return { file: path.join(path.resolve(home), '.codex', 'auth.json'), source: 'default' };
}

// A missing directory is not an error here: `locate()` keeps the lexical tail and the open reports a missing login.
function locateOwnerDirectory(file) {
  try { return locate(path.dirname(file)); } catch (error) {
    if (error?.code === 'EACCES' || error?.code === 'EPERM') throw fail('STREAM_UNSAFE', 'owner-unsafe:uid');
    if (error?.code === 'ELOOP') throw fail('STREAM_UNSAFE', 'owner-unsafe:symlink');
    throw error;
  }
}

// The located owner directory of the environment's owner file, or null when the path cannot be resolved. Never throws.
export function ownerDirectoryFor(env) {
  try { return locateOwnerDirectory(ownerFileFrom(env).file); } catch { return null; }
}

// The owner file must not overlap ROOT or any forbidden root (the artifact, workspace, smoke and repository roots), in either direction.
export function resolveOwnerAuthPath(env, paths, { forbiddenRoots = [] } = {}) {
  const { file, source } = ownerFileFrom(env);
  const directory = locateOwnerDirectory(file);
  for (const root of [paths?.root, ...forbiddenRoots]) {
    if (!nonEmpty(root)) continue;
    const other = locate(root);
    if (isInside(other, directory) || isInside(directory, other)) throw fail('USAGE', 'owner-location');
  }
  return { file, source };
}

// ---- the owner file: the read-only read -----------------------------------------------------------------------

const statKey = (stat) => [stat.ino, stat.size, stat.mtimeNs].map(String).join(':');

// One attempt. Returns { bytes } or { retry }. Every other failure throws.
function readOnce(file, { uid, fsApi }) {
  let fd;
  try { fd = fsApi.openSync(file, READ_FLAGS); } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') throw fail('NOT_SEEDED', 'owner-login-missing');
    if (error?.code === 'ELOOP' || error?.code === 'EMLINK') throw fail('STREAM_UNSAFE', 'owner-unsafe:symlink');
    if (error?.code === 'ENXIO') throw fail('STREAM_UNSAFE', 'owner-unsafe:not-regular');
    if (error?.code === 'EACCES' || error?.code === 'EPERM') throw fail('STREAM_UNSAFE', 'owner-unsafe:uid');
    throw error;
  }
  try {
    const before = fsApi.fstatSync(fd, { bigint: true });
    if (!before.isFile()) throw fail('STREAM_UNSAFE', 'owner-unsafe:not-regular');
    if (Number(before.uid) !== uid) throw fail('STREAM_UNSAFE', 'owner-unsafe:uid');
    if ((Number(before.mode) & 0o077) !== 0) throw fail('STREAM_UNSAFE', 'owner-unsafe:mode');
    if (Number(before.nlink) !== 1) throw fail('STREAM_UNSAFE', 'owner-unsafe:hardlink');
    if (Number(before.size) > OWNER_LIMIT) throw fail('STREAM_UNSAFE', 'auth-invalid:oversize');
    // Codex rewrites the file in place (truncate, then write), so a reader can see an empty or partial file.
    if (Number(before.size) === 0) return { retry: 'unstable' };
    const bytes = fsApi.readFileSync(fd);
    const after = fsApi.fstatSync(fd, { bigint: true });
    if (statKey(before) !== statKey(after) || bytes.length !== Number(before.size)) { bytes.fill(0); return { retry: 'unstable' }; }
    try { JSON.parse(bytes.toString('utf8')); } catch { bytes.fill(0); return { retry: 'not-json' }; }
    return { bytes };
  } finally { fsApi.closeSync(fd); }
}

// Reads the owner file through O_NOFOLLOW with the checks of decision B. Nothing is written or returned except the bytes.
export async function readOwnerAuth(file, { uid = currentUid(), attempts = 3, retryDelayMs = 250, fsApi = fs, sleep = defaultSleep } = {}) {
  const total = Math.max(1, Number.isInteger(attempts) ? attempts : 3);
  let last = 'unstable';
  for (let attempt = 1; attempt <= total; attempt += 1) {
    const outcome = readOnce(file, { uid, fsApi });
    if (outcome.bytes) return { bytes: outcome.bytes };
    last = outcome.retry;
    if (attempt < total) await sleep(retryDelayMs);
  }
  throw last === 'not-json' ? fail('STREAM_UNSAFE', 'auth-invalid:missing-field') : fail('STREAM_UNSAFE', 'owner-unsafe:unstable');
}

// ---- the owner credential --------------------------------------------------------------------------------------

export function requiredValidityMs(remainingRunMs) {
  if (typeof remainingRunMs !== 'number' || !Number.isFinite(remainingRunMs) || remainingRunMs < 0) throw fail('USAGE', 'bad-variable');
  return remainingRunMs + ACCESS_SKEW_MS;
}

// Decodes like Codex: three non-empty parts, a URL-safe payload without padding, no signature check.
export function parseAccessTokenClaims(token) {
  const unparseable = () => fail('STREAM_UNSAFE', 'auth-invalid:token-unparseable');
  if (typeof token !== 'string') throw unparseable();
  const parts = token.split('.');
  if (parts.length !== 3 || parts.some((part) => part === '') || !BASE64URL.test(parts[1])) throw unparseable();
  let payload;
  try { payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')); } catch { throw unparseable(); }
  if (!plainObject(payload) || !Number.isSafeInteger(payload.exp) || payload.exp <= 0) throw unparseable();
  const claim = payload[ACCOUNT_CLAIM_KEY]?.chatgpt_account_id;
  return { expMs: payload.exp * 1000, accountClaim: nonEmpty(claim) ? claim : null };
}

// Accepts only a managed ChatGPT login. Returns the three values route A uses, in memory.
export function extractOwnerCredential(bytes, { now = Date.now() } = {}) {
  validateAuthArtifact(bytes, { now });
  const value = JSON.parse(Buffer.from(bytes).toString('utf8'));
  const { tokens } = value;
  const claims = parseAccessTokenClaims(tokens.access_token);
  const accountId = tokens.account_id;
  if (!ACCOUNT_ID.test(accountId)) throw fail('STREAM_UNSAFE', 'auth-invalid:missing-field');
  if (claims.accountClaim === null) throw fail('STREAM_UNSAFE', 'auth-invalid:account-claim', { accountClaim: 'absent' });
  if (claims.accountClaim !== accountId) throw fail('STREAM_UNSAFE', 'auth-invalid:account-claim', { accountClaim: 'mismatch' });
  return { accessToken: tokens.access_token, accountId, lastRefresh: value.last_refresh, expMs: claims.expMs };
}

// The shape Codex builds for host-supplied tokens, from exactly three values. The object is a literal, never a copy of the owner's.
export function deriveAccessOnlyBytes({ accessToken, accountId, lastRefresh }) {
  return Buffer.from(JSON.stringify({
    auth_mode: 'chatgptAuthTokens',
    OPENAI_API_KEY: null,
    tokens: { id_token: accessToken, access_token: accessToken, refresh_token: '', account_id: accountId },
    last_refresh: lastRefresh,
  }));
}

const sameKeys = (value, expected) => JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...expected].sort());

// True only for the derived shape. Never throws: anything that is not such a JSON object gives false.
export function isAccessOnly(bytes) {
  try {
    if (!Buffer.isBuffer(bytes) && !(bytes instanceof Uint8Array)) return false;
    const value = JSON.parse(Buffer.from(bytes).toString('utf8'));
    if (!plainObject(value) || !sameKeys(value, ['auth_mode', 'OPENAI_API_KEY', 'tokens', 'last_refresh'])) return false;
    if (value.auth_mode !== 'chatgptAuthTokens' || value.OPENAI_API_KEY !== null) return false;
    const { tokens } = value;
    if (!plainObject(tokens) || !sameKeys(tokens, TOKEN_FIELDS)) return false;
    return tokens.refresh_token === '' && tokens.id_token === tokens.access_token && nonEmpty(tokens.access_token) && nonEmpty(tokens.account_id)
      && nonEmpty(value.last_refresh) && ISO_8601.test(value.last_refresh);
  } catch { return false; }
}

// Whether a robot copy holds a token value that is not in the derived bytes: true or false, or null when the copy has no token
// object to compare. Never throws and never returns or logs a value.
export function newTokenValues(copyBytes, derivedBytes) {
  try {
    const copy = JSON.parse(Buffer.from(copyBytes).toString('utf8'));
    if (!plainObject(copy) || !plainObject(copy.tokens)) return null;
    let known = [];
    try {
      const derived = JSON.parse(Buffer.from(derivedBytes).toString('utf8'));
      known = TOKEN_FIELDS.map((name) => derived?.tokens?.[name]).filter(nonEmpty);
    } catch { known = []; }
    return TOKEN_FIELDS.some((name) => nonEmpty(copy.tokens[name]) && !known.includes(copy.tokens[name]));
  } catch { return null; }
}

// Derives the credential and proves it carries neither the owner's refresh token nor its id token.
export function deriveAccessOnlyAuth(ownerBytes, { now = Date.now() } = {}) {
  const credential = extractOwnerCredential(ownerBytes, { now });
  const derived = deriveAccessOnlyBytes(credential);
  const owner = JSON.parse(Buffer.from(ownerBytes).toString('utf8'));
  const text = derived.toString('utf8');
  const foreign = [owner.tokens.refresh_token, owner.tokens.id_token].filter(nonEmpty);
  if (!isAccessOnly(derived) || foreign.some((secret) => text.includes(secret))) throw fail('STREAM_UNSAFE', 'derived-not-access-only');
  return { derived, expMs: credential.expMs };
}

// The access token must outlive the remaining run time plus the skew. Evaluated on unrounded milliseconds. Minutes are for reports:
// floored for the validity (never overstated) and ceiled for the requirement (never understated).
export function assertAccessValidity({ expMs, now = Date.now(), remainingRunMs }) {
  const required = requiredValidityMs(remainingRunMs);
  const remaining = expMs - now;
  const minutes = { accessValidMinutes: Math.floor(remaining / 60_000), requiredValidMinutes: Math.ceil(required / 60_000) };
  if (!Number.isFinite(remaining) || remaining < required) throw fail('STREAM_UNSAFE', 'access-near-expiry', minutes);
  return minutes;
}

// Booleans, one-word states and minutes only. Never a token, the account id, a digest or a file metadata value.
export function summarizeOwner(bytes, { now = Date.now(), remainingRunMs, source } = {}) {
  const summary = { source, readable: true, authMode: 'other', hasIdToken: false, hasAccessToken: false, hasRefreshToken: false, hasAccountId: false,
    hasLastRefresh: false, lastRefreshAgeHours: null, accessToken: 'unparseable', accountClaim: null, accessValidMinutes: null, requiredValidMinutes: null };
  let tokens = null;
  try {
    const base = summarizeAuth(bytes, now);
    for (const name of ['authMode', 'hasIdToken', 'hasAccessToken', 'hasRefreshToken', 'hasAccountId', 'hasLastRefresh', 'lastRefreshAgeHours']) summary[name] = base[name];
    tokens = JSON.parse(Buffer.from(bytes).toString('utf8')).tokens;
  } catch { /* an unreadable body is reported as defaults */ }
  try { summary.requiredValidMinutes = Math.ceil(requiredValidityMs(remainingRunMs) / 60_000); } catch { /* reported as null */ }
  try {
    const claims = parseAccessTokenClaims(tokens?.access_token);
    summary.accessToken = 'ok';
    summary.accessValidMinutes = Math.floor((claims.expMs - now) / 60_000);
    summary.accountClaim = claims.accountClaim === null ? 'absent' : claims.accountClaim === tokens.account_id ? 'match' : 'mismatch';
  } catch { /* an unparseable token keeps its defaults */ }
  return summary;
}

// ---- leak scan references and coverage -------------------------------------------------------------------------

// The owner file itself and the credential derived from it, without the validity gate. Never throws.
export function ownerScanReferences(ownerBytes, { now = Date.now() } = {}) {
  if (!Buffer.isBuffer(ownerBytes)) return [];
  const references = [ownerBytes];
  try { references.push(deriveAccessOnlyBytes(extractOwnerCredential(ownerBytes, { now }))); } catch { /* the derived entry is skipped */ }
  return references;
}

// 'proven' only for byte-identical reads before and after the run (so every credential the worker read is among the references);
// 'n/a' only when the result shows the worker never derived one; otherwise the scan cannot be trusted and the run fails closed.
export function assertOwnerScanCoverage({ preBytes, postBytes, result }) {
  if (Buffer.isBuffer(preBytes) && Buffer.isBuffer(postBytes) && preBytes.equals(postBytes)) return 'proven';
  if (result !== null && result !== undefined && result.owner?.derived === false) return 'n/a';
  throw fail('STREAM_UNSAFE', 'scan-reference-missing');
}

// A pending route-A marker is recovered even when the owner login is unusable, so the worker is spawned for recovery then.
export function planOwnerRun({ pendingRecovery, ownerGateFailure }) {
  if (!ownerGateFailure) return { spawn: true, spawnedForRecovery: false, earlyFailure: null };
  if (pendingRecovery) return { spawn: true, spawnedForRecovery: true, earlyFailure: null };
  return { spawn: false, spawnedForRecovery: false, earlyFailure: ownerGateFailure };
}

// ---- the credential session -------------------------------------------------------------------------------------

// The credential bytes of one run, with their moves. `runtime` is the Box runner (inject, readForCopyBack, remove, discard). Nothing
// is written: the derived bytes stay in memory, in the robot copy and nowhere else. The session needs the host lock to be held.
export function createOwnerCredentialSession({ runtime, runDeadline, injectWindowMs, now = Date.now, uid = currentUid(), readOwner = readOwnerAuth }) {
  const state = { lockHeld: false, loaded: null, runtimeBytes: null, persisted: false, removed: false, injected: false, injectConfirmed: false,
    derived: false, accountClaim: null, gates: { atDerive: null, atInject: null }, runtimeCopy: null, recoveredCopy: null };
  const needLock = () => { if (!state.lockHeld) throw fail('USAGE', 'bad-variable'); };
  // Evaluates and records one expiry gate, before throwing on a refusal.
  const gate = (name, request) => {
    try {
      const checked = assertAccessValidity(request);
      state.gates[name] = { result: 'pass', ...checked };
      return checked;
    } catch (error) {
      if (error instanceof CodexAuthError && error.reason === 'access-near-expiry') {
        state.gates[name] = { result: 'refused', accessValidMinutes: error.accessValidMinutes, requiredValidMinutes: error.requiredValidMinutes };
      }
      throw error;
    }
  };
  const api = {
    state,
    holdLock(held) { state.lockHeld = held === true; },
    // Reads the owner file once (read-only), derives the credential, then applies the gate with the rest of the test time.
    async load({ ownerFile } = {}) {
      needLock();
      if (typeof ownerFile !== 'string' || !path.isAbsolute(ownerFile)) throw fail('USAGE', 'bad-variable');
      let ownerBytes = null;
      try {
        ownerBytes = (await readOwner(ownerFile, { uid })).bytes;
        let outcome;
        try { outcome = deriveAccessOnlyAuth(ownerBytes, { now: now() }); } catch (error) {
          state.accountClaim = error?.reason === 'auth-invalid:account-claim' ? error.accountClaim ?? null : null;
          throw error;
        }
        state.accountClaim = 'match';
        state.derived = true;
        state.loaded = { derived: outcome.derived, expMs: outcome.expMs };
        return { expMs: outcome.expMs, gate: gate('atDerive', { expMs: outcome.expMs, now: now(), remainingRunMs: Math.max(0, runDeadline - now()) }) };
      } finally { ownerBytes?.fill(0); }
    },
    // The inject gate runs first and is recorded. `injected` is set only after it, so a refusal never reaches the robot, and a
    // failure of unknown outcome after it still gets a copy check.
    async inject(robot) {
      needLock();
      if (!state.loaded || state.gates.atDerive?.result !== 'pass') throw fail('USAGE', 'bad-variable');
      gate('atInject', { expMs: state.loaded.expMs, now: now(), remainingRunMs: injectWindowMs });
      state.injected = true;
      await runtime.inject(robot, state.loaded.derived);
      state.injectConfirmed = true;
    },
    // Reads the robot copy, classifies it, removes it by the hash of what was read, and only then reports a changed copy.
    async persistAndRemove(target, { confirmed } = {}) {
      needLock();
      if (!state.persisted) {
        let copied;
        try { copied = await runtime.readForCopyBack(target, { timeoutMs: 30_000 }); } catch (error) {
          if (error?.code === 'NOT_FOUND') {
            // Nothing exists to classify or remove.
            state.persisted = true;
            state.removed = true;
            state.runtimeCopy = { state: 'missing', accessOnly: null, newTokenValues: null, removed: false };
            if (confirmed) throw fail('COPYBACK_REFUSED', 'runtime-auth-missing');
            return;
          }
          throw fail('CLEANUP_INCOMPLETE', 'credential-not-removed');
        }
        state.runtimeBytes = copied.bytes;
        const derived = state.loaded?.derived ?? Buffer.alloc(0);
        state.runtimeCopy = { state: state.runtimeBytes.equals(derived) ? 'unchanged' : 'changed', accessOnly: isAccessOnly(state.runtimeBytes),
          newTokenValues: newTokenValues(state.runtimeBytes, derived), removed: false };
        state.persisted = true;
      }
      if (!state.removed) {
        try { await runtime.remove(target, sha256Hex(state.runtimeBytes)); } catch { throw fail('CLEANUP_INCOMPLETE', 'credential-not-removed'); }
        state.removed = true;
        state.runtimeCopy.removed = true;
      }
      if (state.runtimeCopy.state !== 'unchanged' || state.runtimeCopy.accessOnly !== true) throw fail('COPYBACK_REFUSED', 'runtime-copy-changed');
    },
    // Exec-chain half of recovering a crashed run: the leftover copy is discarded inside the container, so its bytes never reach
    // a host process and are never persisted. The owner login is never read. A copy that was not access-only gives a refusal,
    // which the caller raises after the robot and folder are gone.
    async recover(target) {
      needLock();
      let outcome;
      try { outcome = await runtime.discard(target, { timeoutMs: 30_000 }); } catch { throw fail('CLEANUP_INCOMPLETE', 'recovery-incomplete'); }
      const accessOnly = typeof outcome?.accessOnly === 'boolean' ? outcome.accessOnly : null;
      state.recoveredCopy = { removed: outcome?.removed === true, accessOnly };
      return { refusal: accessOnly === false ? fail('COPYBACK_REFUSED', 'runtime-copy-changed') : null };
    },
    // Best effort: strings produced by JSON.parse cannot be wiped.
    release() {
      state.loaded?.derived?.fill(0);
      state.runtimeBytes?.fill(0);
    },
  };
  return api;
}
