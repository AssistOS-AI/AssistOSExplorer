import fs from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import path from 'node:path';

// Explorer's user-facing file tools never reach controller state (`.ploinky`),
// agent private data (`.data`) or key material (`master-key`, `*.secrets`, and
// `.env`, which Ploinky reads for PLOINKY_MASTER_KEY and provider keys). The
// rules mirror the Ploinky Router's `/workspace-files` guard
// (`ploinky/cli/server/utils/protectedWorkspacePaths.js`); a parity test keeps
// the two in step. Repository checkouts under the workspace's `.ploinky/repos`
// stay readable but are read-only here: Ploinky runs agents from them, so a
// write there would run code inside the agents whose data these rules protect.
// Explorer's own `.data/explorer` store is reached only through
// `private-data-boundary.mjs`, never through these tools.
const CONTROLLER_ROOT = '.ploinky';
const REPOSITORIES_DIRECTORY = 'repos';
const AGENT_DATA_ROOT = '.data';
const PROTECTED_FILE_NAMES = new Set(['master-key', '.env']);
const SECRETS_SUFFIX = '.secrets';
// macOS 11+ <sys/fcntl.h>: the open fails with ELOOP if any path component is a symlink.
const O_NOFOLLOW_ANY = 0x20000000;

export const PROTECTED_PATH_ERROR_CODE = 'EXPLORER_PROTECTED_PATH';
// The open reached a different file than the one that was classified.
export const BOUND_OPEN_REFUSAL = 'Access denied: protected path';
export const WORKSPACE_ROOT_REFUSAL = 'Access denied: a workspace root cannot be deleted, moved or copied';
export const MANAGED_SOURCE_REFUSAL = 'Access denied: managed agent sources under .ploinky/repos are read-only';
export const PROTECTED_DESCENDANT_REFUSAL = 'Access denied: the folder contains protected entries';

export function protectedPathError(message) {
  const error = new Error(message);
  error.code = PROTECTED_PATH_ERROR_CODE;
  error.statusCode = 403;
  return error;
}

// The workspace may sit on a filesystem that matches names regardless of case
// or Unicode form (APFS, also through the Box's virtiofs mount), where
// `.PLOINKY`, `.ploinKy` (Kelvin sign) and `maſter-key` (long s) open the
// protected entry. Names are compared in that folded form, and trailing dots
// and spaces are dropped for filesystems that ignore them.
export function foldWorkspaceName(name) {
  return String(name).normalize('NFKC').toLowerCase().replace(/[. ]+$/, '');
}

export function isProtectedWorkspaceSegments(segments) {
  for (let index = 0; index < segments.length; index += 1) {
    const name = foldWorkspaceName(segments[index]);
    if (PROTECTED_FILE_NAMES.has(name) || name.endsWith(SECRETS_SUFFIX) || name === AGENT_DATA_ROOT) return true;
    if (name === CONTROLLER_ROOT && !(index === 0 && segments[1] === REPOSITORIES_DIRECTORY)) return true;
  }
  return false;
}

// The workspace-root `.ploinky` directory itself is protected, but listings
// project it as a folder that contains only `repos`, so the managed sources
// stay reachable by browsing. No other operation reaches it.
export function isControllerRootSegments(segments) {
  return segments.length === 1 && foldWorkspaceName(segments[0]) === CONTROLLER_ROOT;
}

// `.ploinky/repos` and everything below it: the agent sources Ploinky runs.
export function isManagedSourceSegments(segments) {
  return segments.length >= 2 && foldWorkspaceName(segments[0]) === CONTROLLER_ROOT && segments[1] === REPOSITORIES_DIRECTORY;
}

function isWithin(root, target) {
  const relative = path.relative(root, target);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

// Workspace-relative segments of `targetPath` for every allowed root that
// contains it. A path is classified against each of them, so a root nested in
// another cannot lift the outer root's rules.
export function workspaceSegmentsFor(roots, targetPath) {
  const target = path.resolve(targetPath);
  const result = [];
  for (const root of roots) {
    const resolvedRoot = path.resolve(root);
    if (!isWithin(resolvedRoot, target)) continue;
    const relative = path.relative(resolvedRoot, target);
    result.push(relative ? relative.split(path.sep) : []);
  }
  return result;
}

// 'protected', 'controller' (the projected workspace-root `.ploinky`),
// 'managed' (readable, never written: `.ploinky/repos` and below) or
// 'allowed', from the path alone and before any filesystem access, so a
// protected entry that does not exist is refused exactly like one that does.
// A path outside every root is 'protected'.
export function classifyWorkspacePath(roots, targetPath) {
  const segmentLists = workspaceSegmentsFor(roots, targetPath);
  if (segmentLists.length === 0) return 'protected';
  let controller = false;
  let managed = false;
  for (const segments of segmentLists) {
    if (isControllerRootSegments(segments)) {
      controller = true;
      continue;
    }
    if (isProtectedWorkspaceSegments(segments)) return 'protected';
    if (isManagedSourceSegments(segments)) managed = true;
  }
  if (controller) return 'controller';
  return managed ? 'managed' : 'allowed';
}

// Kinds that a user-facing read may reach, and the one a write may reach.
export const isReadableKind = (kind) => kind === 'allowed' || kind === 'managed';
export const isWritableKind = (kind) => kind === 'allowed';

async function fileIdentity(target) {
  try {
    const stat = await fs.stat(target, { bigint: true });
    return `${stat.dev}:${stat.ino}`;
  } catch {
    return null;
  }
}

// A top-level entry that the filesystem resolves to the root's own `.ploinky`
// or `.data` directory is that directory, whatever folding rules produced the
// match: 'data', 'controller' or ''.
async function aliasedProtectedRoot(root, segments) {
  if (segments.length === 0 || !foldWorkspaceName(segments[0]).startsWith('.')) return '';
  const entry = await fileIdentity(path.join(root, segments[0]));
  if (!entry) return '';
  if (entry === await fileIdentity(path.join(root, AGENT_DATA_ROOT))) return 'data';
  return entry === await fileIdentity(path.join(root, CONTROLLER_ROOT)) ? 'controller' : '';
}

async function realpathOrNull(target) {
  try {
    return await fs.realpath(target);
  } catch {
    return null;
  }
}

// A path that cannot be resolved because one of its existing entries is a
// dangling or looping symlink. Where such a link leads cannot be classified,
// and a write through it would create its target.
export async function crossesUnresolvedLink(targetPath) {
  let current = path.resolve(targetPath);
  while (!await realpathOrNull(current)) {
    try {
      if ((await fs.lstat(current)).isSymbolicLink()) return true;
    } catch { /* missing entry: keep walking up */ }
    const parent = path.dirname(current);
    if (parent === current) return false;
    current = parent;
  }
  return false;
}

// Classifies a canonical (symlink-resolved) target: its segments, and the
// file identity of a top-level entry, under every allowed root that contains
// it. Roots must themselves be canonical.
export async function classifyCanonicalWorkspaceTarget(roots, canonicalPath) {
  const kind = classifyWorkspacePath(roots, canonicalPath);
  if (kind === 'protected') return kind;
  const target = path.resolve(canonicalPath);
  for (const root of roots) {
    const resolvedRoot = path.resolve(root);
    if (!isWithin(resolvedRoot, target)) continue;
    const relative = path.relative(resolvedRoot, target);
    if (!relative) continue;
    const segments = relative.split(path.sep);
    const aliased = await aliasedProtectedRoot(resolvedRoot, segments);
    if (aliased === 'data') return 'protected';
    if (aliased === 'controller') {
      // A `repos` path below an alias of `.ploinky` is a managed source; the
      // projected `.ploinky` itself stays the controller root; anything else
      // reaching it is refused.
      if (segments[1] === REPOSITORIES_DIRECTORY) return kind === 'allowed' ? 'managed' : kind;
      if (!(kind === 'controller' && isControllerRootSegments(segments))) return 'protected';
    }
  }
  return kind;
}

// Whether a directory entry belongs in a user-facing listing or walk. A
// symlink entry is classified by its canonical target and omitted unless that
// target is an ordinary allowed path: a protected, unresolvable or outside
// target is refused, and so is the projected `.ploinky` root, whose children
// a walk through the link would otherwise classify by the link's own name.
export async function isVisibleWorkspaceEntry(roots, directoryPath, entry) {
  const entryPath = path.join(directoryPath, entry.name);
  if (classifyWorkspacePath(roots, entryPath) === 'protected') return false;
  if (!entry.isSymbolicLink?.()) return true;
  const canonical = await realpathOrNull(entryPath);
  if (!canonical) return false;
  return isReadableKind(await classifyCanonicalWorkspaceTarget(roots, canonical));
}

// The first protected path in the subtree at `rootPath`, or ''. Links are not
// followed: deleting, moving or copying a link touches the link, not its
// target. Used before an operation that would delete, relocate or duplicate
// every entry below the target; the target itself was already classified for
// that operation, so managed sources below a readable copy source pass.
export async function findProtectedDescendant(roots, rootPath) {
  const pending = [path.resolve(rootPath)];
  while (pending.length > 0) {
    const current = pending.pop();
    let entries;
    try {
      entries = await fs.readdir(current, { withFileTypes: true });
    } catch (error) {
      if (error?.code === 'ENOTDIR' || error?.code === 'ENOENT') continue;
      throw error;
    }
    for (const entry of entries) {
      const entryPath = path.join(current, entry.name);
      if (!isReadableKind(classifyWorkspacePath(roots, entryPath))) return entryPath;
      if (entry.isDirectory()) pending.push(entryPath);
    }
  }
  return '';
}

// Opens a classified canonical file so that a symlink swapped in after
// classification cannot redirect the open. A path check repeated after the
// open is another lookup an attacker can race, so the check binds to the
// opened descriptor: macOS refuses a symlink in any component of the canonical
// path, and on Linux the descriptor's own path must be the classified path.
// Resolves to null when the open reached anything else, including on a
// platform that offers neither check.
export async function openClassifiedWorkspaceFile(filePath) {
  if (process.platform === 'darwin') {
    try {
      return await fs.open(filePath, fsConstants.O_RDONLY | O_NOFOLLOW_ANY);
    } catch (error) {
      if (error?.code === 'ELOOP') return null;
      throw error;
    }
  }
  const handle = await fs.open(filePath, 'r');
  const opened = await fs.readlink(`/proc/self/fd/${handle.fd}`).catch(() => null);
  if (opened === filePath) return handle;
  await handle.close().catch(() => {});
  return null;
}

// Runs `read(handle)` on a descriptor-bound open of `filePath`, refusing the
// read when the open reached a different file than the classified one.
export async function withClassifiedWorkspaceFile(filePath, read) {
  const handle = await openClassifiedWorkspaceFile(filePath);
  if (!handle) throw protectedPathError(BOUND_OPEN_REFUSAL);
  try {
    return await read(handle);
  } finally {
    await handle.close().catch(() => {});
  }
}
