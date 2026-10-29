// Node-side schema and validation of the keeper's filtered-view mount frames (plan sections 5.4 and 5.5; review R4-7).
//
// Route of the grant-root descriptor. The supervisor performs the anchored walk (grantResolver.mjs) and holds the
// resulting descriptor. Grants are immutable for an execution (plan section 4.1), so the roots are known when the keeper
// is spawned: the supervisor passes each one as an extra descriptor of the keeper's `child_process` stdio, at a fixed slot
// (`firstGrantRootSlot + index`). The keeper's frame channel "carries no descriptors", and a frame carries NO source path:
// a path in the frame would make the keeper re-resolve by path and reopen the substitution window of plan section 4.1.
// A mount request names the inherited slot and the identity it expects there; the keeper refuses on a mismatch.
//
// Frames are JSON objects inside the length-prefixed frames of execution/frameCodec.mjs:
//   supervisor -> keeper   { id, op: 'mount_view', grantId, rootSlot, expectedRootIdentity: { dev, ino }, access,
//                            mountpoint, propagation: 'private', allowOther: true, descriptorCap, rlimitNofile,
//                            rootLease: { epoch: 1, ttlMs } }
//   supervisor -> keeper   { id, op: 'unmount_view', resource }
//   supervisor -> keeper   { id, op: 'view_root_lease', grantId, epoch, verdict: 'renew', ttlMs }
//                          { id, op: 'view_root_lease', grantId, epoch, verdict: 'revoke', reason }
//   keeper -> supervisor   { id, ok: true, value: { resource, mount: { mountId, mountpoint, mountNamespaceInode },
//                            fileServer: { pid, startTime, pidNamespaceInode } } }
//                          { id, ok: true, value: { state: 'live' | 'revoking' | 'killed' } }   (reply to a lease frame)
//                          { id, ok: false, kind: 'refused' | 'failure', error }
// The root lease (decision D-S5-6, rootLease.mjs) starts with the mount: a view is mounted only with a lease that the
// supervisor issued after a bound verification of the grant root's binding chain. The chain descriptors themselves never
// travel: only the grant root is inherited by the keeper.
// The reply carries the identity tuples that plan section 5.5 commits before a handle is published: mount ID,
// mountpoint and mount-namespace inode for the mount; PID, start time and PID-namespace inode for the file server.
//
// The mount runs in the execution's own mount namespace with private propagation. `propagation` must equal 'private'
// and `allowOther` must be true: neither is a free option, so a request cannot ask for shared propagation, and the view
// is always reachable by the mapped IDs of other processes. The mountpoint is not free either: it must equal the
// locator derived from the reservation (viewMountpoint). Its layout under the runtime directory is PROVISIONAL and is
// fixed by the S4 owner of the keeper.

import { descriptorCapProblem } from './descriptorLedger.mjs';
import { resolveViewLimits } from './viewLimits.mjs';

export const PROPAGATION = 'private';

const GRANT_ID = /^[a-z0-9][a-z0-9-]*$/u;
const RESERVATION_ID = /^[a-z0-9]{8,64}$/u;
const RESOURCE_ID = /^[a-z0-9]{8,64}$/u;
const DIGITS = /^[0-9]{1,20}$/u;
const ERROR_CODE = /^[a-z][a-z0-9_]{0,63}$/u;
const SOURCE_PATH_KEYS = new Set(['source', 'sourcePath', 'path', 'hostPath', 'backingPath', 'root', 'rootPath', 'target', 'dir', 'directory']);
const MOUNT_KEYS = 'access,allowOther,descriptorCap,expectedRootIdentity,grantId,id,mountpoint,op,propagation,rlimitNofile,rootLease,rootSlot';
const UNMOUNT_KEYS = 'id,op,resource';
const LEASE_RENEW_KEYS = 'epoch,grantId,id,op,ttlMs,verdict';
const LEASE_REVOKE_KEYS = 'epoch,grantId,id,op,reason,verdict';
const LEASE_STATES = Object.freeze(['live', 'revoking', 'killed']);
const MAX_PID = 4_194_304;

const isDigits = (value) => typeof value === 'string' && DIGITS.test(value);
const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const isCount = (value, minimum, maximum) => Number.isSafeInteger(value) && value >= minimum && value <= maximum;
const keysOf = (object) => Object.keys(object).sort().join(',');
const isLeaseTtl = (value, limits) => Number.isSafeInteger(value) && value >= 1 && value <= limits.rootLeaseTtlMs;
const bad = (code) => ({ ok: false, code });
const ok = () => ({ ok: true });

// Where a view is mounted. `scope` is 'execution' (the views of an execution or terminal, mounted inside its mount
// namespace) or 'gui' (a retained GUI resource, mounted at its locator in the agent container's mount namespace).
export function viewMountpoint({ scope, runtimeRoot, reservationId, grantId }) {
    if (typeof runtimeRoot !== 'string' || !runtimeRoot.startsWith('/') || runtimeRoot.length < 2 || runtimeRoot.endsWith('/')
        || runtimeRoot.split('/').some((part, index) => index > 0 && (part === '' || part === '.' || part === '..'))) {
        throw new TypeError('The runtime root must be a normalized absolute path other than /');
    }
    if (!RESERVATION_ID.test(reservationId)) throw new TypeError('The reservation id is malformed');
    if (!GRANT_ID.test(grantId)) throw new TypeError('The grant id is malformed');
    if (scope === 'execution') return `${runtimeRoot}/x/${reservationId}/views/${grantId}`;
    if (scope === 'gui') return `${runtimeRoot}/gui/${reservationId}/${grantId}`;
    throw new TypeError('The scope must be execution or gui');
}

// The extra stdio entries of the keeper spawn that carry the grant roots. `grantFds` are descriptors the supervisor
// holds (FileHandle.fd of the resolver). Returns [{ rootSlot, fd }] for the caller to place into the stdio array.
export function grantRootSlots(grantFds, limitOverrides = {}) {
    const limits = resolveViewLimits(limitOverrides);
    if (!Array.isArray(grantFds) || grantFds.length === 0 || grantFds.length > limits.maxViewsPerKeeper) {
        throw new RangeError('A keeper carries between one and maxViewsPerKeeper grant roots');
    }
    if (new Set(grantFds).size !== grantFds.length) throw new TypeError('Each grant root needs its own descriptor');
    return grantFds.map((fd, index) => {
        if (!Number.isSafeInteger(fd) || fd < 0) throw new TypeError('A grant root descriptor must be a non-negative integer');
        return Object.freeze({ rootSlot: limits.firstGrantRootSlot + index, fd });
    });
}

// Validates one mount request. context: { scope, runtimeRoot, reservationId, grantCount } where grantCount is the number
// of grant-root slots the keeper was spawned with. Returns { ok: true } or { ok: false, code }.
export function validateMountRequest(frame, context, limitOverrides = {}) {
    const limits = resolveViewLimits(limitOverrides);
    if (!isPlainObject(frame)) return bad('bad_frame');
    if (Object.keys(frame).some((key) => SOURCE_PATH_KEYS.has(key))) return bad('source_path_not_allowed');
    if (keysOf(frame) !== MOUNT_KEYS || frame.op !== 'mount_view' || !isCount(frame.id, 1, 1_000_000_000)) return bad('bad_frame');
    if (typeof frame.grantId !== 'string' || Buffer.byteLength(frame.grantId, 'utf8') > limits.maxGrantIdBytes || !GRANT_ID.test(frame.grantId)) {
        return bad('bad_grant_id');
    }
    const slots = isCount(context.grantCount, 1, limits.maxViewsPerKeeper) ? context.grantCount : 0;
    if (!isCount(frame.rootSlot, limits.firstGrantRootSlot, limits.firstGrantRootSlot + slots - 1)) return bad('root_slot_out_of_range');
    const identity = frame.expectedRootIdentity;
    if (!isPlainObject(identity) || keysOf(identity) !== 'dev,ino' || !isDigits(identity.dev) || !isDigits(identity.ino)) {
        return bad('bad_root_identity');
    }
    if (frame.access !== 'read' && frame.access !== 'write') return bad('bad_access');
    if (frame.propagation !== PROPAGATION) return bad('propagation_not_private');
    if (frame.allowOther !== true) return bad('allow_other_required');
    let expectedMountpoint;
    try {
        expectedMountpoint = viewMountpoint({ ...context, grantId: frame.grantId });
    } catch {
        return bad('bad_context');
    }
    if (Buffer.byteLength(expectedMountpoint, 'utf8') > limits.maxMountpointBytes) return bad('mountpoint_too_long');
    if (frame.mountpoint !== expectedMountpoint) return bad('mountpoint_not_locator');
    if (!isCount(frame.descriptorCap, 1, Number.MAX_SAFE_INTEGER) || !isCount(frame.rlimitNofile, 1, Number.MAX_SAFE_INTEGER)
        || descriptorCapProblem({ cap: frame.descriptorCap, rlimitNofile: frame.rlimitNofile }, limits) !== null) {
        return bad('descriptor_cap_invalid');
    }
    const lease = frame.rootLease;
    if (!isPlainObject(lease) || keysOf(lease) !== 'epoch,ttlMs' || lease.epoch !== 1 || !isLeaseTtl(lease.ttlMs, limits)) return bad('bad_root_lease');
    return ok();
}

export function validateUnmountRequest(frame) {
    if (!isPlainObject(frame) || keysOf(frame) !== UNMOUNT_KEYS || frame.op !== 'unmount_view'
        || !isCount(frame.id, 1, 1_000_000_000) || typeof frame.resource !== 'string' || !RESOURCE_ID.test(frame.resource)) {
        return bad('bad_frame');
    }
    return ok();
}

// The requests of one keeper together: bounded, and no two share an id, grant, slot or mountpoint.
const DUPLICATE_CODES = Object.freeze([
    ['id', 'duplicate_id'], ['grantId', 'duplicate_grant_id'], ['rootSlot', 'duplicate_root_slot'], ['mountpoint', 'duplicate_mountpoint']
]);
export function validateMountSet(requests, limitOverrides = {}) {
    const limits = resolveViewLimits(limitOverrides);
    if (!Array.isArray(requests) || requests.length === 0 || requests.length > limits.maxViewsPerKeeper) return bad('bad_mount_set');
    // Each refusal code matches the reply grammar ERROR_CODE (lowercase snake case), so a refusal that the keeper forwards
    // in a mount reply validates (validateMountReply).
    for (const [field, code] of DUPLICATE_CODES) {
        if (new Set(requests.map((request) => request[field])).size !== requests.length) return bad(code);
    }
    return ok();
}

// Validates the keeper's reply to a mount request on the supervisor side. A refusal reply is accepted if it is shaped
// like one; a success reply must carry the identity tuples for the mount that was asked for.
export function validateMountReply(reply, request) {
    if (!isPlainObject(reply) || reply.id !== request.id) return bad('bad_reply');
    if (reply.ok === false) {
        return keysOf(reply) === 'error,id,kind,ok' && (reply.kind === 'refused' || reply.kind === 'failure')
            && typeof reply.error === 'string' && ERROR_CODE.test(reply.error) ? ok() : bad('bad_reply');
    }
    if (reply.ok !== true || keysOf(reply) !== 'id,ok,value' || !isPlainObject(reply.value) || keysOf(reply.value) !== 'fileServer,mount,resource') {
        return bad('bad_reply');
    }
    const { resource, mount, fileServer } = reply.value;
    if (typeof resource !== 'string' || !RESOURCE_ID.test(resource)) return bad('bad_reply');
    if (!isPlainObject(mount) || keysOf(mount) !== 'mountId,mountNamespaceInode,mountpoint' || !isCount(mount.mountId, 1, 2 ** 31)
        || mount.mountpoint !== request.mountpoint || !isDigits(mount.mountNamespaceInode)) {
        return bad('bad_mount_tuple');
    }
    if (!isPlainObject(fileServer) || keysOf(fileServer) !== 'pid,pidNamespaceInode,startTime' || !isCount(fileServer.pid, 1, MAX_PID)
        || !isDigits(fileServer.startTime) || !isDigits(fileServer.pidNamespaceInode)) {
        return bad('bad_process_tuple');
    }
    return ok();
}

// --- the root lease (decision D-S5-6; rootLease.mjs) -------------------------------------------------------------------


// Validates one lease frame, supervisor -> keeper:
//   { id, op: 'view_root_lease', grantId, epoch, verdict: 'renew', ttlMs }
//   { id, op: 'view_root_lease', grantId, epoch, verdict: 'revoke', reason }
// epoch is a safe integer of at least 2 (epoch 1 is the lease carried by mount_view). A frame carries no path and no
// descriptor. Returns { ok: true } or { ok: false, code } with code 'source_path_not_allowed', 'bad_frame' or 'bad_ttl'.
export function validateRootLeaseFrame(frame, limitOverrides = {}) {
    const limits = resolveViewLimits(limitOverrides);
    if (!isPlainObject(frame)) return bad('bad_frame');
    if (Object.keys(frame).some((key) => SOURCE_PATH_KEYS.has(key))) return bad('source_path_not_allowed');
    if (frame.op !== 'view_root_lease' || !isCount(frame.id, 1, 1_000_000_000)) return bad('bad_frame');
    if (typeof frame.grantId !== 'string' || Buffer.byteLength(frame.grantId, 'utf8') > limits.maxGrantIdBytes || !GRANT_ID.test(frame.grantId)) {
        return bad('bad_frame');
    }
    if (!Number.isSafeInteger(frame.epoch) || frame.epoch < 2) return bad('bad_frame');
    if (frame.verdict === 'renew') {
        if (keysOf(frame) !== LEASE_RENEW_KEYS || !Number.isSafeInteger(frame.ttlMs)) return bad('bad_frame');
        return isLeaseTtl(frame.ttlMs, limits) ? ok() : bad('bad_ttl');
    }
    if (frame.verdict === 'revoke') {
        return keysOf(frame) === LEASE_REVOKE_KEYS && typeof frame.reason === 'string' && ERROR_CODE.test(frame.reason) ? ok() : bad('bad_frame');
    }
    return bad('bad_frame');
}

// Validates the keeper's reply to a lease frame on the supervisor side: the keeper's lease state, or a refusal.
export function validateRootLeaseReply(reply, request) {
    if (!isPlainObject(reply) || !isPlainObject(request) || reply.id !== request.id) return bad('bad_reply');
    if (reply.ok === false) {
        return keysOf(reply) === 'error,id,kind,ok' && (reply.kind === 'refused' || reply.kind === 'failure')
            && typeof reply.error === 'string' && ERROR_CODE.test(reply.error) ? ok() : bad('bad_reply');
    }
    if (reply.ok !== true || keysOf(reply) !== 'id,ok,value' || !isPlainObject(reply.value) || keysOf(reply.value) !== 'state'
        || !LEASE_STATES.includes(reply.value.state)) {
        return bad('bad_reply');
    }
    return ok();
}

