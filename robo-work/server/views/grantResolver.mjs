// The supervisor-side grant resolver (plan section 4.1; A35(2); review R4-7, R4-8).
//
// A trusted client names a role, an access mode and a workspace-relative path. The resolver never accepts a host path.
// It refuses controller state, key material, private storage and the other locations of the refusal set, and it
// returns an OPEN DESCRIPTOR for the grant root together with its identity. The descriptor, not the path, is what the
// sandbox launcher uses afterwards (`--bind-fd` / the preparation bind source), so the directory cannot be substituted after validation.
//
// Anchored resolution with Node
//   Node's fs has no openat. Two strategies, selected by platform and recorded in the result:
//   - 'linux-procfd'        each component is opened as `/proc/self/fd/<dirfd>/<name>` with O_NOFOLLOW | O_DIRECTORY,
//                           so every step is relative to the descriptor of the previous one. This is the standard
//                           emulation of openat; the binding is re-verified relative to the parent descriptor, and then
//                           also by the anchored full path (S5 Linux fix delta L-1, option B; see verifyBinding below).
//                           RUN on real Linux once (the R-A apparatus run, host /tmp under host Node, outside the Box):
//                           that run found the two defects fixed by the Linux fix delta (L-1, L-2). Not yet run inside the
//                           Box file system (overlay or virtiofs, G4/G6). On Darwin it is exercised only through an
//                           in-memory model (tests/views/grantResolver.test.mjs treeFs); the Linux-only file
//                           tests/views/grantResolver.linux-procfd.mjs runs it on a real Linux file system.
//                           `openat2` with RESOLVE_BENEATH is not reachable from Node; it is Linux-only G4 work.
//   - 'darwin-nofollow-any' `/dev/fd/<n>/<name>` does not traverse on Darwin (probed: ENOENT). Each prefix of the
//                           canonical path is opened with O_NOFOLLOW_ANY | O_DIRECTORY (a symlink anywhere in the path is
//                           ELOOP), and a bracket compares every held descriptor's identity with an lstat of its path
//                           before the descriptor is returned. LIMIT: a directory that is renamed away and back between
//                           the open and the bracket, or replaced between two prefixes by a different directory of the
//                           same identity, is not detected; there is a residual window of the path-based calls. This
//                           strategy is for development and tests. The production worker runs in the Linux Box, also
//                           on the Mac, where the Linux strategy applies.
//
// Identity (R4-8) is the pair of device and inode as decimal strings, from fstat with bigint. Mac virtiofs inode stability
// is unproven (G6): when the pair cannot be obtained the resolver refuses, and a later comparison that cannot be made
// refuses.
//
// Chain custody and binding verification (decision D-S5-6; S5 decisions delta sections 5.1 and 7.2)
//   A resolved grant keeps its whole walk chain: the workspace-root anchor, the descriptor of every component between it
//   and the grant root, and the grant root (segments.length + 1 descriptors). The chain stays in the supervisor, inside
//   this closure: the grant object exposes only the grant root (`handle`, `fd`), which is the one descriptor that is
//   handed to the sandbox launcher (`--bind-fd` / prep bind source). Node opens descriptors with O_CLOEXEC, so a spawned child
//   inherits only the slots it is given explicitly. `close()` releases the root and the chain.
//   `grant.verifyBinding()` re-resolves every recorded component top-down and without following links, and compares it
//   with its admission identity. It never reclassifies names: if every component still resolves to its admission
//   identity, the root sits at the admission path, whose names admission already classified; any move, including an
//   ordinary rename (risk K1), is 'unbound'. Linux, per component and in this order: (1) fstat of the held parent equals
//   its admission identity; (2) the edge check `lstat('/proc/self/fd/<held parent>/<name>')`, as in the bracket; (3) only
//   after (2) passed, `lstat` of the anchored full path of that component from the workspace root (S5 Linux fix delta
//   L-1, option B). Step (3) is a conjunct after (2), so a stale path lookup can only add a false 'unbound' (availability,
//   the K1 family), never a false 'bound'. It catches, within the same pass, a plain rename of an ancestor that was
//   already verified (the held descriptors follow such a move, so (1) and (2) alone cannot see it) and a rename of the
//   workspace root itself. It does NOT catch, within the pass, an already-verified ancestor that is renamed and whose old
//   name is replaced by a symlink to its new location: a path lstat follows symlinks in the middle of the path. That
//   variant, like any change that lands after the last check of an edge, is caught at the next renewal (residual,
//   bounded by the lease cadence). Step (3) also makes Linux verification depend on search permission and symlinks in the
//   ancestors of the workspace root (availability only, the K1 family). Darwin (development only): `lstat` of each
//   recorded prefix, top-down, so a symlinked component is found before a deeper path lookup could follow it; the
//   path-based LIMIT above applies. It opens no descriptor.
//   Result: { state: 'bound' } | { state: 'unbound', code, index } (sticky for the caller) | { state: 'unproven',
//   code: 'verify_failed', errno } (not sticky; the lease is not renewed). `index` is the 0-based segment; the last
//   segment is the grant root; it is null for 'grant_closed' and 'classification_changed'.

import fs from 'node:fs';
import path from 'node:path';

import { firstProtectedComponent, foldPathName, isValidComponentName } from './protectedNames.mjs';
import { resolveViewLimits } from './viewLimits.mjs';

// macOS 11+ <sys/fcntl.h>: the open fails with ELOOP if any path component is a symlink. Node does not export it.
export const O_NOFOLLOW_ANY = 0x20000000;
const DIRECTORY_FLAGS = fs.constants.O_RDONLY | fs.constants.O_DIRECTORY;

export const STRATEGIES = Object.freeze({ DARWIN: 'darwin-nofollow-any', LINUX: 'linux-procfd' });
export const ROLES = Object.freeze(['project', 'skill-source']);
export const ACCESS_MODES = Object.freeze(['read', 'write']);

const refuse = (code, message) => ({ ok: false, code, message });

const identityOf = (stat) => `${stat.dev}:${stat.ino}`;
const splitIdentity = (identity) => {
    const [dev, ino] = identity.split(':');
    return { dev, ino };
};

function parseRequest(request, limits) {
    if (request === null || typeof request !== 'object' || Array.isArray(request)
        || Object.keys(request).sort().join(',') !== 'access,relativePath,role') {
        return refuse('invalid_request', 'The request needs exactly a role, an access and a relativePath');
    }
    if (!ACCESS_MODES.includes(request.access) || !ROLES.includes(request.role)) return refuse('invalid_request', 'Unknown access or role');
    const { relativePath } = request;
    if (typeof relativePath !== 'string' || relativePath.includes('\0')) return refuse('invalid_path', 'The path is not a string');
    if (Buffer.byteLength(relativePath, 'utf8') > limits.maxGrantPathBytes) return refuse('path_too_long', 'The path is too long');
    if (relativePath.startsWith('/')) return refuse('absolute_path', 'Only workspace-relative paths are accepted');
    if (relativePath === '') return refuse('workspace_root_not_granted', 'The workspace root is not a grant');
    const segments = relativePath.split('/');
    if (segments.length > limits.maxGrantPathDepth) return refuse('path_too_deep', 'The path is too deep');
    for (const segment of segments) {
        if (segment === '.' || segment === '..') return refuse('traversal', 'Traversal components are refused');
        if (!isValidComponentName(segment, limits.maxComponentBytes)) return refuse('invalid_component', 'The path has an empty or invalid component');
    }
    return { ok: true, segments };
}

// The one place where a protected component is allowed in a grant's own path: an explicitly selected, read-only,
// skill-source grant of `<repo>` (or deeper) under the workspace's `.ploinky/repos`. `repos` is compared exactly, as
// Ploinky does, and everything below it is checked with the ordinary predicate, so a nested `.ploinky` or `.data` is refused.
function classifyRequestPath(segments, request) {
    const managed = segments.length >= 2 && foldPathName(segments[0]) === '.ploinky' && segments[1] === 'repos';
    if (managed) {
        if (request.access === 'write') return refuse('managed_source_writable', 'Managed agent sources under .ploinky/repos are never writable grants');
        if (request.role !== 'skill-source') return refuse('managed_source_not_project', 'A managed source is never the working project');
        if (segments.length < 3) return refuse('managed_source_root_not_grantable', 'A grant names a repository below .ploinky/repos, not the whole tree');
        const below = firstProtectedComponent(segments.slice(2));
        return below ? refuse('protected_component', `Protected component (${below.class}) in the path`) : { ok: true, managedSource: true };
    }
    const hit = firstProtectedComponent(segments);
    return hit ? refuse('protected_component', `Protected component (${hit.class}) in the path`) : { ok: true, managedSource: false };
}

// --- strategies ------------------------------------------------------------------------------------------------------

async function closeAll(handles) {
    for (const handle of handles) {
        try {
            await handle.close();
        } catch {
            // already closed
        }
    }
}

function mapOpenError(error) {
    switch (error?.code) {
        case 'ELOOP': return refuse('symlink_in_path', 'A symbolic link is not followed');
        case 'ENOENT': return refuse('not_found', 'The directory does not exist');
        case 'ENOTDIR': return refuse('not_a_directory', 'A component is not a directory');
        case 'EACCES': return refuse('access_denied', 'The directory cannot be opened');
        default: return refuse('open_failed', 'The directory could not be opened');
    }
}

async function statIdentity(handle) {
    const stat = await handle.stat({ bigint: true });
    if (!stat.isDirectory()) throw Object.assign(new Error('not a directory'), { code: 'ENOTDIR' });
    return identityOf(stat);
}

async function walkDarwin({ rootReal, segments, fsApi, hooks }) {
    const handles = [];
    const ids = [];
    const prefixes = [rootReal];
    try {
        handles.push(await fsApi.open(rootReal, DIRECTORY_FLAGS | O_NOFOLLOW_ANY));
        ids.push(await statIdentity(handles[0]));
        for (let index = 0; index < segments.length; index += 1) {
            const prefix = path.join(prefixes[index], segments[index]);
            prefixes.push(prefix);
            handles.push(await fsApi.open(prefix, DIRECTORY_FLAGS | O_NOFOLLOW_ANY));
            ids.push(await statIdentity(handles[index + 1]));
            await hooks.afterComponent?.(index, segments[index]);
        }
        await hooks.beforeVerify?.();
        // Bracket: every held descriptor must still be what its path names.
        for (let index = 0; index < prefixes.length; index += 1) {
            const stat = await fsApi.lstat(prefixes[index], { bigint: true }).catch(() => null);
            if (!stat || !stat.isDirectory() || identityOf(stat) !== ids[index]) {
                await closeAll(handles);
                return refuse('substitution_detected', 'A component changed while it was being resolved');
            }
        }
        return { ok: true, handles, ids };
    } catch (error) {
        await closeAll(handles);
        return mapOpenError(error);
    }
}

async function walkLinux({ rootReal, segments, fsApi, hooks }) {
    const handles = [];
    const ids = [];
    const prefixes = [rootReal];
    for (const segment of segments) prefixes.push(path.join(prefixes[prefixes.length - 1], segment));
    const substituted = async () => {
        await closeAll(handles);
        return refuse('substitution_detected', 'A component changed while it was being resolved');
    };
    try {
        handles.push(await fsApi.open(rootReal, DIRECTORY_FLAGS | fs.constants.O_NOFOLLOW));
        ids.push(await statIdentity(handles[0]));
        for (let index = 0; index < segments.length; index += 1) {
            const viaParent = `/proc/self/fd/${handles[index].fd}/${segments[index]}`;
            let opened;
            try {
                opened = await fsApi.open(viaParent, DIRECTORY_FLAGS | fs.constants.O_NOFOLLOW);
            } catch (error) {
                if (error?.code !== 'ENOTDIR') throw error;
                // Linux fix delta L-2: with O_DIRECTORY | O_NOFOLLOW, Linux reports a trailing symlink as ENOTDIR, not ELOOP.
                // The same entry is looked at with lstat: a link is refused as symlink_in_path, anything else (including an
                // lstat that fails) stays not_a_directory. The outer catch closes every descriptor either way.
                const stat = await fsApi.lstat(viaParent, { bigint: true }).catch(() => null);
                throw Object.assign(new Error('not a directory'), { code: stat?.isSymbolicLink() ? 'ELOOP' : 'ENOTDIR' });
            }
            handles.push(opened);
            ids.push(await statIdentity(handles[index + 1]));
            await hooks.afterComponent?.(index, segments[index]);
        }
        await hooks.beforeVerify?.();
        // Bracket: each name must still resolve, relative to its parent descriptor, to the held child; and then (Linux fix
        // delta L-1, option B) the anchored full path of that component must still name it, which catches an ancestor that
        // was renamed after its own bracket step. A conjunct after the edge check: it can only refuse.
        for (let index = 0; index < segments.length; index += 1) {
            await hooks.beforeBracketComponent?.(index);
            const stat = await fsApi.lstat(`/proc/self/fd/${handles[index].fd}/${segments[index]}`, { bigint: true }).catch(() => null);
            if (!stat || !stat.isDirectory() || identityOf(stat) !== ids[index + 1]) return substituted();
            const anchored = await fsApi.lstat(prefixes[index + 1], { bigint: true }).catch(() => null);
            if (!anchored || anchored.isSymbolicLink() || !anchored.isDirectory() || identityOf(anchored) !== ids[index + 1]) return substituted();
        }
        return { ok: true, handles, ids };
    } catch (error) {
        await closeAll(handles);
        return mapOpenError(error);
    }
}

export function defaultStrategy(platform = process.platform) {
    if (platform === 'darwin') return STRATEGIES.DARWIN;
    if (platform === 'linux') return STRATEGIES.LINUX;
    return null;
}

// --- identities of the locations that a grant must not reach or contain ------------------------------------------------

async function lstatIdentity(fsApi, target) {
    try {
        return identityOf(await fsApi.lstat(target, { bigint: true }));
    } catch {
        return null;
    }
}

// The canonical path of a location that may not exist: the realpath of its nearest existing ancestor plus the rest.
async function canonicalLocation(fsApi, location) {
    const rest = [];
    let current = path.resolve(location);
    for (;;) {
        try {
            const real = await fsApi.realpath(current);
            return rest.length === 0 ? real : path.join(real, ...rest.reverse());
        } catch {
            const parent = path.dirname(current);
            if (parent === current) return path.resolve(location);
            rest.push(path.basename(current));
            current = parent;
        }
    }
}

async function ancestorIdentities(fsApi, target) {
    const identities = new Set();
    for (let current = target; ; current = path.dirname(current)) {
        const identity = await lstatIdentity(fsApi, current);
        if (identity) identities.add(identity);
        if (path.dirname(current) === current) return identities;
    }
}

async function locationRefusal({ fsApi, location, grantPath, ids, finalId }) {
    const real = await canonicalLocation(fsApi, location.path);
    const ownId = await lstatIdentity(fsApi, real);
    // The grant is the location, or lies inside it.
    if ((ownId !== null && ids.includes(ownId)) || grantPath === real || grantPath.startsWith(`${real}/`)) {
        return refuse('inside_protected_location', `The grant lies inside ${location.label}`);
    }
    // The grant contains the location: refused unless the view would hide it by name.
    const ancestors = await ancestorIdentities(fsApi, path.dirname(real));
    const containsByIdentity = ancestors.has(finalId);
    const containsByPath = real.startsWith(`${grantPath}/`);
    if (containsByIdentity || containsByPath) {
        if (containsByPath && firstProtectedComponent(real.slice(grantPath.length + 1).split('/')) !== null) return null;
        return refuse('contains_protected_location', `The grant contains ${location.label}`);
    }
    return null;
}

// --- the resolver ----------------------------------------------------------------------------------------------------

// request:  { role: 'project' | 'skill-source', access: 'read' | 'write', relativePath }
// context:  { workspaceRoot, protectedLocations?: [{ label, path }], limits?, strategy?, fsApi? }
// hooks:    { afterComponent(index, name), beforeVerify(), beforeBracketComponent(index) } injection points for
//           deterministic race tests (beforeBracketComponent is used by the Linux strategy's bracket only).
// Returns { ok: false, code, message } or { ok: true, grant } where grant = { handle, fd, identity: { dev, ino },
// identityKey, componentIdentities, anchorIdentityKey, segments, access, role, managedSource, strategy, verifyBinding(),
// close() }. The caller closes the grant when done; every refusal closes everything the resolver opened.
export async function resolveGrant(request, context, hooks = {}) {
    const limits = resolveViewLimits(context.limits ?? {});
    const fsApi = context.fsApi ?? fs.promises;
    const parsed = parseRequest(request, limits);
    if (!parsed.ok) return parsed;
    const { segments } = parsed;
    const classified = classifyRequestPath(segments, request);
    if (!classified.ok) return classified;

    const strategy = context.strategy ?? defaultStrategy();
    if (strategy !== STRATEGIES.DARWIN && strategy !== STRATEGIES.LINUX) return refuse('unsupported_platform', 'No anchored resolution strategy for this platform');

    let rootReal;
    try {
        rootReal = await fsApi.realpath(context.workspaceRoot);
    } catch {
        return refuse('workspace_root_unavailable', 'The workspace root cannot be resolved');
    }
    const walked = await (strategy === STRATEGIES.DARWIN ? walkDarwin : walkLinux)({ rootReal, segments, fsApi, hooks });
    if (!walked.ok) return walked;
    const { handles, ids } = walked;
    const finalId = ids[ids.length - 1];
    const refuseAndClose = async (refusal) => {
        await closeAll(handles);
        return refusal;
    };

    // Identity-level refusals, whatever spelling the file system accepted.
    if (finalId === ids[0]) return refuseAndClose(refuse('workspace_root_not_granted', 'The workspace root is not a grant'));
    if ((await ancestorIdentities(fsApi, path.dirname(rootReal))).has(finalId)) {
        return refuseAndClose(refuse('ancestor_of_workspace_not_granted', 'An ancestor of the workspace is not a grant'));
    }
    const controllerIds = new Map();
    for (const name of ['.data', '.ploinky', '.ploinky-box']) {
        const identity = await lstatIdentity(fsApi, path.join(rootReal, name));
        if (identity) controllerIds.set(identity, name);
    }
    for (let index = 1; index < ids.length; index += 1) {
        const name = controllerIds.get(ids[index]);
        if (name === undefined) continue;
        // The only legitimate hit is the `.ploinky` of an accepted managed-source path, at its first component.
        if (classified.managedSource && index === 1 && name === '.ploinky') continue;
        return refuseAndClose(refuse('protected_alias', 'A component resolves to controller state under another spelling'));
    }

    const grantPath = path.join(rootReal, ...segments);
    for (const location of context.protectedLocations ?? []) {
        const refusal = await locationRefusal({ fsApi, location, grantPath, ids, finalId });
        if (refusal) return refuseAndClose(refusal);
    }

    // Keep the grant root AND the walk chain (D-S5-6): the chain is what verifyBinding re-resolves from. It never leaves
    // this closure.
    const chain = handles;
    const handle = chain[chain.length - 1];
    const recorded = Object.freeze([...segments]);
    const prefixes = [rootReal];
    for (const segment of recorded) prefixes.push(path.join(prefixes[prefixes.length - 1], segment));
    const last = recorded.length - 1;
    const guardRequest = Object.freeze({ access: request.access, role: request.role });
    const inFlight = new Set();
    let closed = false;
    let closing = null;

    const closedResult = () => Object.freeze({ state: 'unbound', code: 'grant_closed', index: null });
    const unboundAt = (code, index) => Object.freeze({ state: 'unbound', code, index });
    const missingAt = (index) => unboundAt(index === last ? 'root_unbound' : 'ancestor_unbound', index);
    const unproven = (error) => Object.freeze({ state: 'unproven', code: 'verify_failed', errno: typeof error?.code === 'string' ? error.code : 'EIO' });

    async function heldIdentity(held) {
        return identityOf(await held.stat({ bigint: true }));
    }

    // One lstat with the mapping of the decisions delta section 5.1: null when the entry is the recorded directory of
    // component `index`, otherwise the result to return.
    async function checkEntry(target, index) {
        let stat;
        try {
            stat = await fsApi.lstat(target, { bigint: true });
        } catch (error) {
            if (closed) return closedResult();
            if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return missingAt(index);
            if (error?.code === 'ELOOP') return unboundAt('symlink_in_path', index);
            return unproven(error);
        }
        if (closed) return closedResult();
        if (stat.isSymbolicLink()) return unboundAt('symlink_in_path', index);
        if (!stat.isDirectory()) return missingAt(index);
        if (identityOf(stat) !== ids[index + 1]) return unboundAt('identity_mismatch', index);
        return null;
    }

    async function verify(verifyHooks) {
        if (closed) return closedResult();
        // Defence in depth against a corrupted grant: the recorded segments must still classify as admitted.
        const guard = classifyRequestPath(recorded, guardRequest);
        if (!guard.ok || guard.managedSource !== classified.managedSource) return unboundAt('classification_changed', null);
        for (let index = 0; index < recorded.length; index += 1) {
            await verifyHooks.beforeComponent?.(index);
            if (closed) return closedResult();
            let parentId;
            try {
                parentId = await heldIdentity(chain[index]);
            } catch (error) {
                return closed ? closedResult() : unproven(error);
            }
            if (closed) return closedResult();
            if (parentId !== ids[index]) return unboundAt('identity_mismatch', index);
            if (strategy === STRATEGIES.LINUX) {
                // Step (2), the edge check, first: it sees a symlink that replaced a component before any path lookup
                // could follow it. Step (3), the anchored full path, only after (2) passed.
                const edge = await checkEntry(`/proc/self/fd/${chain[index].fd}/${recorded[index]}`, index);
                if (edge) return edge;
            }
            const anchored = await checkEntry(prefixes[index + 1], index);
            if (anchored) return anchored;
        }
        let rootId;
        try {
            rootId = await heldIdentity(handle);
        } catch (error) {
            return closed ? closedResult() : unproven(error);
        }
        if (closed) return closedResult();
        if (rootId !== ids[last + 1]) return unboundAt('identity_mismatch', last);
        return Object.freeze({ state: 'bound' });
    }

    // close() waits for running verifications before it releases the chain, so a descriptor number can never be reused
    // under a verification that is still running; a verification that sees the grant closing reports grant_closed.
    function verifyBinding(verifyHooks = {}) {
        const running = verify(verifyHooks ?? {}).catch((error) => (closed ? closedResult() : unproven(error)));
        inFlight.add(running);
        running.finally(() => inFlight.delete(running)).catch(() => { });
        return running;
    }

    return {
        ok: true,
        grant: Object.freeze({
            handle, fd: handle.fd, identity: Object.freeze(splitIdentity(finalId)), identityKey: finalId,
            componentIdentities: Object.freeze([...ids]), anchorIdentityKey: ids[0], segments: recorded,
            access: request.access, role: request.role, managedSource: classified.managedSource, strategy,
            verifyBinding,
            close() {
                if (closing) return closing;
                closed = true;
                closing = (async () => {
                    await Promise.allSettled([...inFlight]);
                    await closeAll(chain);
                })();
                return closing;
            }
        })
    };
}

// Whether an earlier-resolved grant still names the same directory: identity comparison for continuations (A35(3), R4-8).
// Fails closed: a missing or unobtainable identity is never equal.
export function sameGrantIdentity(left, right) {
    return Boolean(left && right && left.dev && left.ino && left.dev === right.dev && left.ino === right.ino);
}

// Kept for tests of the exemption without a file system.
export function classifyGrantRequestPath(segments, request) {
    const parsed = classifyRequestPath(segments, request);
    return parsed.ok ? { ok: true, managedSource: parsed.managedSource } : { ok: false, code: parsed.code };
}

