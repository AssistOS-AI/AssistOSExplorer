import { CodexAuthError } from './codex-test-auth.mjs';
import { DERIVED_SHAPE_ID } from './codex-test-auth-owner.mjs';

// Qualification of a Codex client build for route A. Route A stores Codex's in-memory access-only shape in the file store, which Codex
// does not document, so it relies on that only for exact builds that passed `scripts/codex-client-qualify.mjs` on the deployed
// platform. The allowlist is committed code: reviewable, tested, and empty until the first qualification run. There is no environment
// variable, file or argument override, and nothing here reads a file, spawns a process or uses the network.

export const QUALIFICATION_RECEIPT_SCHEMA = 'codex-client-qualification-v1';

// The checks of one qualification run: the eight safety and positive-control checks of the synthetic control, and one for the shape.
export const QUALIFICATION_CHECKS = Object.freeze([
  'externalLoadsAsChatgpt', 'externalTokenUsed', 'externalNeverRefreshes', 'externalNeverWritesAuth', 'externalFailsClosed',
  'noTokenCopiesOutsideAuthJson', 'recorderSeesManagedRefreshOn401', 'recorderSeesManagedProactiveRefresh', 'externalAuthIsAccessOnly',
]);

// Entries come only from a qualification receipt, through a reviewed commit. Shape:
//   Object.freeze({ package: '@openai/codex', version: '<semver>', platform: 'linux-x64', nativeRelativePath: '<path inside the generation>',
//     nativeSha256: '<64 hex>', nativeSize: <integer>, derivedShape: 'chatgptAuthTokens-v1',
//     receipt: Object.freeze({ file, sha256, harnessSha256, verdict: 'PASS', qualifiedAt: '<ISO UTC>', host: 'apparatus' }) })
// Qualified on the apparatus host by `scripts/codex-client-qualify.mjs` (verdict PASS, 9 of 9 checks) on the exact Linux tool-cache binary.
// The receipt is `apparatus_routeA_w1_20261003T183747Z/slotQ/qualify.jsonl`; `sha256` is the digest of that file.
export const QUALIFIED_CODEX_CLIENTS = Object.freeze([
  Object.freeze({
    package: '@openai/codex',
    version: '0.160.0',
    platform: 'linux-x64',
    nativeRelativePath: 'lib/node_modules/@openai/codex/node_modules/@openai/codex-linux-x64/vendor/x86_64-unknown-linux-musl/bin/codex',
    nativeSha256: '12eb3e81114588aca3b7998f4f19e8997b056aca08e57a7ca7c8a3ec8c652aad',
    nativeSize: 289101384,
    derivedShape: 'chatgptAuthTokens-v1',
    receipt: Object.freeze({
      file: 'apparatus_routeA_w1_20261003T183747Z/slotQ/qualify.jsonl',
      sha256: 'c7a8e35a7d3c25934cc7aa4e184fc372b4ca9651adaaf69f8cbacea43a677c62',
      harnessSha256: '465212750d521996a3669f8d6055626f18a2e596c88b6713c8c8f84f76879416',
      verdict: 'PASS',
      qualifiedAt: '2026-10-03T18:45:52.866Z',
      host: 'apparatus',
    }),
  }),
]);

const ENTRY_KEYS = ['package', 'version', 'platform', 'nativeRelativePath', 'nativeSha256', 'nativeSize', 'derivedShape', 'receipt'];
const RECEIPT_KEYS = ['file', 'sha256', 'harnessSha256', 'verdict', 'qualifiedAt', 'host'];
const SEMVER = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;
const SHA256 = /^[0-9a-f]{64}$/;
const SEGMENT = /^[A-Za-z0-9@_+-][A-Za-z0-9@._+-]{0,127}$/;
const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;
const text = (value) => typeof value === 'string' && value !== '';
const sameKeys = (value, names) => JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...names].sort());

// Throws TypeError for anything but a frozen, complete entry. It checks the format, not the build.
export function validateQualifiedClientEntry(entry) {
  const bad = (what) => { throw new TypeError(`Invalid qualified Codex client entry: ${what}.`); };
  if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) bad('not an object');
  if (!Object.isFrozen(entry)) bad('not frozen');
  if (!sameKeys(entry, ENTRY_KEYS)) bad('keys');
  if (!text(entry.package) || !SEMVER.test(entry.version) || !/^[a-z0-9]+-[a-z0-9_]+$/.test(entry.platform)) bad('identity');
  const relative = entry.nativeRelativePath;
  const segments = typeof relative === 'string' ? relative.split('/') : [];
  if (typeof relative !== 'string' || relative.length > 512 || segments.length > 16 || !segments.every((segment) => SEGMENT.test(segment))) bad('relative path');
  if (!SHA256.test(entry.nativeSha256) || !Number.isSafeInteger(entry.nativeSize) || entry.nativeSize <= 0) bad('digest');
  if (!text(entry.derivedShape)) bad('derived shape');
  const { receipt } = entry;
  if (receipt === null || typeof receipt !== 'object' || !Object.isFrozen(receipt) || !sameKeys(receipt, RECEIPT_KEYS)) bad('receipt');
  if (!text(receipt.file) || !SHA256.test(receipt.sha256) || !SHA256.test(receipt.harnessSha256) || receipt.verdict !== 'PASS'
    || !ISO_UTC.test(receipt.qualifiedAt) || receipt.host !== 'apparatus') bad('receipt values');
  return entry;
}

// The entries for one package and version. A different version never matches.
export function qualifiedEntriesFor({ packageName, version, entries = QUALIFIED_CODEX_CLIENTS }) {
  return entries.filter((entry) => entry.package === packageName && entry.version === version);
}

// The relative path to hash for each platform, for `runtime.nativeDigest`.
export function relativePathsFor(entries) {
  const paths = {};
  for (const entry of entries) {
    if (Object.hasOwn(paths, entry.platform)) throw new TypeError('Two qualified Codex client entries share a platform.');
    paths[entry.platform] = entry.nativeRelativePath;
  }
  return paths;
}

const unqualified = (status) => new CodexAuthError('RUNTIME_PREREQ_FAILED', 'client-unqualified', { qualification: status });

// `identity` is the client identity read in the RoboTeam container ({ package, version }); `digest` is `runtime.nativeDigest`'s
// answer ({ platform, sha256, size }). Checks in order: no entry for this version, platform, derived shape, then the digest.
export function assertClientQualified({ identity, digest, entries = QUALIFIED_CODEX_CLIENTS, shapeId = DERIVED_SHAPE_ID }) {
  const matching = qualifiedEntriesFor({ packageName: identity?.package, version: identity?.version, entries });
  if (matching.length === 0) throw unqualified('no-entry');
  const entry = digest && digest.sha256 !== null ? matching.find((candidate) => candidate.platform === digest.platform) : undefined;
  if (!entry) throw unqualified('platform-mismatch');
  if (entry.derivedShape !== shapeId) throw unqualified('shape-mismatch');
  if (digest.sha256 !== entry.nativeSha256 || digest.size !== entry.nativeSize) throw unqualified('digest-mismatch');
  return { status: 'qualified', entry };
}

// The runtime check for one client identity ({ package, version, generation }). Nothing is hashed without an entry for the version; then
// the container hashes the allowlisted file of its platform; then `assertClientQualified` decides. A qualification outcome never throws:
// it returns the `report` to record (one status word, the platform, a 12-character generation prefix, and the digests of the public client
// binary and of the receipt) and the `failure` to raise, or null.
export async function checkClientQualification({ runtime, identity, entries = QUALIFIED_CODEX_CLIENTS }) {
  const report = { status: null, platform: null, generation12: String(identity?.generation ?? '').slice(0, 12), nativeSha256: null, nativeSize: null,
    entryVersion: null, receiptSha256: null };
  const refuse = (failure) => { report.status = failure.qualification; return { report, failure }; };
  const matching = qualifiedEntriesFor({ packageName: identity?.package, version: identity?.version, entries });
  if (matching.length === 0) return refuse(unqualified('no-entry'));
  let digest;
  try { digest = await runtime.nativeDigest({ generation: identity.generation, relativePaths: relativePathsFor(matching) }); } catch (error) {
    if (error instanceof TypeError) throw error;
    return refuse(unqualified('digest-unreadable'));
  }
  Object.assign(report, { platform: digest?.platform ?? null, nativeSha256: digest?.sha256 ?? null, nativeSize: digest?.size ?? null });
  try {
    const { entry } = assertClientQualified({ identity, digest, entries });
    Object.assign(report, { status: 'qualified', entryVersion: entry.version, receiptSha256: entry.receipt.sha256 });
    return { report, failure: null };
  } catch (error) {
    if (!(error instanceof CodexAuthError)) throw error;
    return refuse(error);
  }
}

// Evaluates the four cases of a qualification run (E-401, E-window, M-401, M-window). The external cases must never refresh, in either
// phase (`login status` and `exec`), never write the file, use the bearer, fail closed and keep the derived shape. The managed cases are
// the positive controls: they prove that the recorder would see a refresh. A missing or malformed case makes its checks false.
export function evaluateQualification(caseSummaries) {
  const list = Array.isArray(caseSummaries) ? caseSummaries : [];
  const find = (name) => list.find((summary) => summary?.case === name) ?? null;
  const external = [find('E-401'), find('E-window')];
  const both = (test) => external.every((summary) => summary !== null && test(summary) === true);
  const first = external[0];
  const managedOn401 = find('M-401');
  const managedWindow = find('M-window');
  const checks = {
    externalLoadsAsChatgpt: first !== null && /Logged in using ChatGPT/.test(Array.isArray(first.loginStatus?.lines) ? first.loginStatus.lines.join(' ') : '')
      && first.loginStatus.code === 0,
    externalTokenUsed: both((summary) => summary.syntheticBearerSent === true),
    externalNeverRefreshes: both((summary) => summary.refreshRequestsTotal === 0),
    externalNeverWritesAuth: both((summary) => summary.authFileUnchanged === true),
    externalFailsClosed: both((summary) => Number.isInteger(summary.exec?.code) && summary.exec.code !== 0),
    noTokenCopiesOutsideAuthJson: list.length > 0 && list.every((summary) => summary?.otherFilesHoldingAccessToken === 0),
    recorderSeesManagedRefreshOn401: managedOn401 !== null && managedOn401.refreshRequests >= 1,
    recorderSeesManagedProactiveRefresh: managedWindow !== null && managedWindow.refreshRequests >= 1 && managedWindow.refreshBeforeFirstBackend === true,
    externalAuthIsAccessOnly: both((summary) => summary.authFileAccessOnly === true),
  };
  return { checks, verdict: QUALIFICATION_CHECKS.every((name) => checks[name] === true) ? 'PASS' : 'FAIL' };
}
