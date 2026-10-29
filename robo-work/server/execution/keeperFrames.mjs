// The supervisor <-> keeper wire protocol, version 1 (keeper wire contract delta sections 2 to 4 and R1). The same
// schema is applied on both sides, and the shared golden vectors (tests/execution/vectors/keeper-wire.v1.json) are
// generated from this module so that the Rust keeper is held to the same bytes and verdicts.
//
// Frames are JSON objects inside the length-prefixed frames of frameCodec.mjs. The channel carries no descriptors, and no
// key names a descriptor or slot except the frozen mount frames' `rootSlot`.
//
//   supervisor -> keeper   requests  { id, op, ... }          id: safe integer 1..1e9, strictly increasing per channel
//   keeper -> supervisor   replies   { id, ok: true, value }   value: an object with the op's exact key set
//                                    { id, ok: false, kind: 'refused' | 'failure', error }
//   keeper -> supervisor   events    { event, ... }            hello, exit, pty_output, pty_closed
//
// Verdicts: { ok: true }, { ok: false, violation } (a structural breach that ends that keeper) or, for requests only,
// { ok: false, refused } (well formed but not permitted: the keeper answers a refusal and nothing changes). A refusal
// that depends on keeper state (unknown handle, state conflict) is the keeper's own; the validators here decide what the
// frame alone decides, plus the frozen mount validators' codes, which go on the wire in snake case (wireCode, R1.5 M-1).

import { encodeFrame } from './frameCodec.mjs';
import { validateStartRequest, virtualPathProblem } from './providerSchema.mjs';
import { RESOURCE_KINDS } from './resourceLocators.mjs';
import { ptyFrameCapBytes } from './keeperLimits.mjs';
import { resolveViewLimits } from '../views/viewLimits.mjs';
import {
    validateMountReply, validateMountRequest, validateMountSet, validateRootLeaseFrame, validateRootLeaseReply, validateUnmountRequest
} from '../views/mountFrames.mjs';

export const KEEPER_PROTOCOL = 'robo-work-keeper';
export const KEEPER_PROTOCOL_VERSION = 1;

const HANDLE = /^[0-9a-f]{32}$/u;
const MOUNT_HANDLE = /^m[0-9a-f]{32}$/u;
const LOCATOR_ID = /^[0-9a-f]{32}$/u;
const DIGITS = /^[0-9]{1,20}$/u;
const ERROR_CODE = /^[a-z][a-z0-9_]{0,63}$/u;
const BASE64URL = /^[A-Za-z0-9_-]{22}$/u;
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u;
const SEQ = /^[1-9][0-9]{0,19}$/u;
const SEQ_MAX = 18_446_744_073_709_551_615n;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/u;
const INVENTORY_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;
const TEMPDIR = /^\/tmp\/ala-[0-9a-f]{16}$/u;
const STREAM_NAMES = Object.freeze(['stderr', 'stdin', 'stdout']);
const MAX_PID = 4_194_304;
const MAX_ID = 1_000_000_000;
const MAX_GRACE_MS = 3_600_000;
const MAX_ABORT_HANDLES = 64;
const MAX_INVENTORY_RESOURCES = 256;
const MAX_RELAYS = 16;
const MAX_ORCHESTRATION_ARGS = 256;
const MAX_TERMINAL_ARGS = 256;

export const CREATE_KINDS = Object.freeze(['runtime-dir', 'netns', 'endpoint', 'process-tree', 'pty', 'cgroup']);
export const PROCESS_BEARING_CREATE_KINDS = Object.freeze(['endpoint', 'process-tree']);
export const PROCESS_TREE_ROLES = Object.freeze(['orchestration', 'workload', 'terminal']);

// Exact request key sets, sorted (keysOf).
const REQUEST_KEYS = Object.freeze({
    commit_keeper: 'id,op',
    ping: 'id,op',
    create: 'id,kind,locator,marker,op,resource,spec',
    commit: 'id,op,resource',
    abort_uncommitted: 'id,op,resources',
    stop: 'graceMs,id,op,resource',
    tempdir: 'id,op',
    end_process_trees: 'id,op',
    end_endpoint: 'id,op',
    release_egress: 'id,op',
    release_views: 'id,op',
    remove_runtime: 'id,op',
    shutdown: 'id,op',
    inventory: 'id,op',
    pty_input: 'data,id,op,resource,seq',
    pty_resize: 'cols,id,op,resource,rows',
    pty_credit: 'bytes,id,op,resource',
    mount_view: 'access,allowOther,descriptorCap,expectedRootIdentity,grantId,id,mountpoint,op,propagation,rlimitNofile,rootLease,rootSlot',
    unmount_view: 'id,op,resource',
    view_root_lease: null
});
export const KEEPER_OPS = Object.freeze(Object.keys(REQUEST_KEYS));
// Ops that may use the reserved in-flight slots (section 2, N-B). Everything else except pty_input is ordinary.
export const PRIORITY_OPS = Object.freeze(['view_root_lease', 'ping', 'shutdown', 'abort_uncommitted', 'end_process_trees',
    'end_endpoint', 'release_egress', 'release_views', 'remove_runtime']);
// Only mount mutations share maxMountInFlight; lease renewals retain the channel and per-grant bounds.
export const MOUNT_OPS = Object.freeze(['mount_view', 'unmount_view']);
// Ops whose only answer is ok: an error reply to them is a violation.
const NO_ERROR_OPS = new Set(['commit_keeper', 'ping', 'end_process_trees', 'end_endpoint', 'release_egress', 'release_views',
    'remove_runtime', 'shutdown', 'inventory']);
// Ops whose ok value is the empty object.
const EMPTY_VALUE_OPS = new Set(['commit_keeper', 'ping', 'abort_uncommitted', 'end_process_trees', 'end_endpoint', 'release_egress',
    'release_views', 'remove_runtime', 'shutdown', 'pty_resize', 'pty_credit', 'unmount_view']);
const MOUNT_TYPES = Object.freeze({
    grantId: 'string', rootSlot: 'integer', expectedRootIdentity: 'object', access: 'string', mountpoint: 'string',
    propagation: 'string', allowOther: 'boolean', descriptorCap: 'integer', rlimitNofile: 'integer', rootLease: 'object'
});
const LEASE_RENEW_KEYS = 'epoch,grantId,id,op,ttlMs,verdict';
const LEASE_REVOKE_KEYS = 'epoch,grantId,id,op,reason,verdict';
const EVENT_KEYS = Object.freeze({
    hello: 'event,limits,marker,pid,protocol,startTime,version',
    exit: 'code,event,resource,signal',
    pty_output: 'data,event,resource,seq',
    pty_closed: 'event,resource'
});

const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const isCount = (value, minimum, maximum) => Number.isSafeInteger(value) && value >= minimum && value <= maximum;
const keysOf = (object) => Object.keys(object).sort().join(',');
const isDigits = (value) => typeof value === 'string' && DIGITS.test(value);
const isPath = (value, maxBytes = 1024) => typeof value === 'string' && value !== '/' && virtualPathProblem(value, maxBytes) === null;
const encodedBytes = (frame) => Buffer.byteLength(JSON.stringify(frame), 'utf8');
// The key-set rule of every reply value and wire identity: exactly these keys, no more and no fewer.
const replyKeys = (object, keys) => keysOf(object) === keys;

const OK = Object.freeze({ ok: true });
const violation = (code) => Object.freeze({ ok: false, violation: code });
const refused = (code) => Object.freeze({ ok: false, refused: code });

// --- identifiers and codecs ---------------------------------------------------------------------------------------------

// The S1 resource id rule (stateProtocol.isOriginId): 22 base64url characters that encode exactly 16 bytes.
export function isOriginId(value) {
    if (typeof value !== 'string' || !BASE64URL.test(value)) return false;
    const bytes = Buffer.from(value, 'base64url');
    return bytes.length === 16 && bytes.toString('base64url') === value;
}

// The supervisor-assigned wire handle of an S1 resource: its 16 bytes as 32 lowercase hex characters (a bijection).
export function resourceHandle(resourceId) {
    if (!isOriginId(resourceId)) throw new TypeError('A resource handle needs a canonical S1 resource id');
    return Buffer.from(resourceId, 'base64url').toString('hex');
}
export const isSupervisorHandle = (value) => typeof value === 'string' && HANDLE.test(value);
export const isMountHandle = (value) => typeof value === 'string' && MOUNT_HANDLE.test(value);

// A sequence number is a canonical unsigned decimal string from "1" to 2^64 - 1.
export const isCanonicalSeq = (value) => typeof value === 'string' && SEQ.test(value) && BigInt(value) <= SEQ_MAX;
export const nextSeq = (value) => String(BigInt(value) + 1n);

// Canonical padded base64 of 1..maxBytes bytes, or null.
export function decodeCanonicalBase64(value, maxBytes) {
    if (typeof value !== 'string' || value.length === 0 || value.length % 4 !== 0 || !BASE64.test(value)) return null;
    const bytes = Buffer.from(value, 'base64');
    if (bytes.length === 0 || bytes.length > maxBytes || bytes.toString('base64') !== value) return null;
    return bytes;
}
export const encodeBase64 = (bytes) => Buffer.from(bytes).toString('base64');

// A frozen mount validator code in wire form: lowercase snake case (duplicate_grantId -> duplicate_grant_id). Codes that
// are already snake case are unchanged, so this holds for S5 r6 and for S5 revisions that emit snake case themselves.
export const wireCode = (code) => code.replace(/[A-Z]/gu, (letter) => `_${letter.toLowerCase()}`);

// A request frame in the fixed key order the supervisor writes: id, op, then the op's fields as given.
export function buildRequest(op, id, fields = {}) {
    return { id, op, ...fields };
}
export const encodeKeeperFrame = (frame, limits) => encodeFrame(frame, { maxFrameBytes: limits.maxFrameBytes });

// --- keeper argv --------------------------------------------------------------------------------------------------------

// Every value is its own element. `--reservation` is followed by the marker unchanged, even when it starts with '-'.
// channelLimits and viewLimits are resolved sets; every entry is passed (and echoed in hello.limits).
export function keeperArgv({
    marker, parentPid, scope, runtimeRoot, ala, grantRoots, homeIdentity = null, orchestrationRoot = null, cgroupSubtree = null, channelLimits, viewLimits
}) {
    if (!isOriginId(marker)) throw new TypeError('The keeper marker must be the S1 resource id');
    if (!isCount(parentPid, 1, MAX_PID)) throw new TypeError('The parent pid is not valid');
    if (!['execution', 'terminal', 'gui'].includes(scope)) throw new TypeError('The scope must be execution, terminal or gui');
    if (!isPath(runtimeRoot)) throw new TypeError('The runtime root must be a normalized absolute path');
    if (!isCount(grantRoots, 0, 64)) throw new TypeError('The grant-root count is not valid');
    const argv = ['serve', '--protocol', String(KEEPER_PROTOCOL_VERSION), '--reservation', marker, '--parent-pid', String(parentPid),
        '--scope', scope, '--runtime-root', runtimeRoot, '--ala', ala ? '1' : '0', '--grant-roots', String(grantRoots)];
    if (homeIdentity !== null) {
        if (!isPlainObject(homeIdentity) || !isDigits(homeIdentity.dev) || !isDigits(homeIdentity.ino)) throw new TypeError('The HOME identity is not valid');
        argv.push('--home-identity', `${homeIdentity.dev}:${homeIdentity.ino}`);
    }
    if (orchestrationRoot !== null) {
        if (!isPath(orchestrationRoot)) throw new TypeError('The orchestration root must be a normalized absolute path');
        argv.push('--orchestration-root', orchestrationRoot);
    }
    if (cgroupSubtree !== null) {
        if (!isPlainObject(cgroupSubtree) || !isPath(cgroupSubtree.path, 989)
            || ![cgroupSubtree.dev, cgroupSubtree.ino].every((value) => isDigits(value) && BigInt(value) <= SEQ_MAX)) {
            throw new TypeError('The cgroup subtree identity is not valid');
        }
        argv.push('--cgroup-subtree', `${cgroupSubtree.dev}:${cgroupSubtree.ino}:${cgroupSubtree.path}`);
    }
    for (const [name, value] of Object.entries(channelLimits)) argv.push('--channel-limit', `${name}=${value}`);
    for (const [name, value] of Object.entries(viewLimits)) argv.push('--view-limit', `${name}=${value}`);
    return argv;
}

// --- requests (keeper side; the supervisor validates its own frames with the same function before writing) -------------

// context: { limits, viewLimits, endpointLimits, keeperReservation, runtimeRoot?, cgroupSubtree?, orchestrationRoot?,
// Missing or null cgroupSubtree is undelegated, never a skipped confinement check.
//            mount?: { scope, runtimeRoot, reservationId, grantCount, prior: [mount_view frames already admitted] } }
export function validateKeeperRequest(frame, context) {
    const { limits } = context;
    if (!isPlainObject(frame) || !isCount(frame.id, 1, MAX_ID)) return violation('bad_frame');
    if (typeof frame.op !== 'string') return violation('bad_frame');
    switch (frame.op) {
        case 'commit_keeper':
        case 'ping':
        case 'tempdir':
        case 'end_process_trees':
        case 'end_endpoint':
        case 'release_egress':
        case 'release_views':
        case 'remove_runtime':
        case 'shutdown':
        case 'inventory':
            return keysOf(frame) === REQUEST_KEYS[frame.op] ? OK : violation('bad_frame');
        case 'create':
            return validateCreate(frame, context);
        case 'commit':
            return keysOf(frame) === REQUEST_KEYS.commit && (isSupervisorHandle(frame.resource) || isMountHandle(frame.resource)) ? OK : violation('bad_frame');
        case 'abort_uncommitted':
            return keysOf(frame) === REQUEST_KEYS.abort_uncommitted && Array.isArray(frame.resources)
                && frame.resources.length >= 1 && frame.resources.length <= MAX_ABORT_HANDLES
                && frame.resources.every((handle) => isSupervisorHandle(handle) || isMountHandle(handle))
                && new Set(frame.resources).size === frame.resources.length ? OK : violation('bad_frame');
        case 'stop':
            return keysOf(frame) === REQUEST_KEYS.stop && isSupervisorHandle(frame.resource) && isCount(frame.graceMs, 0, MAX_GRACE_MS) ? OK : violation('bad_frame');
        case 'pty_input':
            if (keysOf(frame) !== REQUEST_KEYS.pty_input || !isSupervisorHandle(frame.resource) || !isCanonicalSeq(frame.seq)
                || decodeCanonicalBase64(frame.data, limits.ptyChunkBytes) === null) return violation('bad_frame');
            return encodedBytes(frame) <= ptyFrameCapBytes(limits) ? OK : violation('oversize_frame');
        case 'pty_resize':
            return keysOf(frame) === REQUEST_KEYS.pty_resize && isSupervisorHandle(frame.resource)
                && isCount(frame.cols, 1, 65535) && isCount(frame.rows, 1, 65535) ? OK : violation('bad_frame');
        case 'pty_credit':
            return keysOf(frame) === REQUEST_KEYS.pty_credit && isSupervisorHandle(frame.resource)
                && isCount(frame.bytes, 1, limits.ptyMaxCreditBytes) ? OK : violation('bad_frame');
        case 'mount_view':
            return validateMountView(frame, context);
        case 'unmount_view':
            // Stage 1: exact keys, a keeper-assigned handle. Stage 2: the frozen validator.
            if (keysOf(frame) !== REQUEST_KEYS.unmount_view || !isMountHandle(frame.resource)) return violation('bad_frame');
            if (encodedBytes(frame) > context.viewLimits.maxMountFrameBytes) return violation('oversize_frame');
            return validateUnmountRequest(frame).ok ? OK : violation('bad_frame');
        case 'view_root_lease':
            return validateLease(frame, context);
        default:
            return violation('unknown_op');
    }
}

function validateMountView(frame, context) {
    // Stage 1: exact key set and JSON types. Any other key (every source-path key included) is a violation, so the frozen
    // `source_path_not_allowed` never reaches the wire.
    if (keysOf(frame) !== REQUEST_KEYS.mount_view) return violation('bad_frame');
    for (const [key, type] of Object.entries(MOUNT_TYPES)) {
        const value = frame[key];
        const typed = type === 'integer' ? Number.isSafeInteger(value) : type === 'object' ? isPlainObject(value) : typeof value === type;
        if (!typed) return violation('bad_frame');
    }
    const identity = frame.expectedRootIdentity;
    if (keysOf(identity) !== 'dev,ino' || typeof identity.dev !== 'string' || typeof identity.ino !== 'string') return violation('bad_frame');
    const lease = frame.rootLease;
    if (keysOf(lease) !== 'epoch,ttlMs' || !Number.isSafeInteger(lease.epoch) || !Number.isSafeInteger(lease.ttlMs)) return violation('bad_frame');
    if (encodedBytes(frame) > context.viewLimits.maxMountFrameBytes) return violation('oversize_frame');
    // Stage 2: the frozen validator. Its bad_frame is a violation; every other code is a refusal, in wire form.
    const mount = context.mount ?? {};
    const verdict = validateMountRequest(frame, mount, context.viewLimits);
    if (!verdict.ok) return verdict.code === 'bad_frame' ? violation('bad_frame') : refused(wireCode(verdict.code));
    const set = validateMountSet([...(mount.prior ?? []), frame], context.viewLimits);
    if (!set.ok) return set.code === 'bad_frame' ? violation('bad_frame') : refused(wireCode(set.code));
    return OK;
}

function validateLease(frame, context) {
    const verdictKeys = frame.verdict === 'renew' ? LEASE_RENEW_KEYS : frame.verdict === 'revoke' ? LEASE_REVOKE_KEYS : null;
    if (verdictKeys === null || keysOf(frame) !== verdictKeys || typeof frame.grantId !== 'string' || !Number.isSafeInteger(frame.epoch)
        || (frame.verdict === 'renew' ? !Number.isSafeInteger(frame.ttlMs) : typeof frame.reason !== 'string')) {
        return violation('bad_frame');
    }
    if (encodedBytes(frame) > context.viewLimits.maxMountFrameBytes) return violation('oversize_frame');
    const verdict = validateRootLeaseFrame(frame, context.viewLimits);
    if (!verdict.ok) return verdict.code === 'bad_ttl' ? refused('bad_ttl') : violation('bad_frame');
    return OK;
}

// The locator key set the ledger records for each create kind (resourceLocators.deriveLocator plus `keeper`, plus the
// S1 `marker` of a process-bearing reservation).
function locatorProblem(kind, locator, marker, context) {
    if (!isPlainObject(locator) || !isOriginId(locator.keeper) || locator.keeper !== context.keeperReservation) return true;
    switch (kind) {
        case 'runtime-dir': {
            if (keysOf(locator) !== 'keeper,path' || !isPath(locator.path)) return true;
            const match = /^(.*)\/x\/([0-9a-f]{32})$/u.exec(locator.path);
            return match === null || (context.runtimeRoot !== undefined && match[1] !== context.runtimeRoot);
        }
        case 'cgroup': {
            if (keysOf(locator) !== 'keeper,path' || !isPath(locator.path)) return true;
            const match = /^(.*)\/x-([0-9a-f]{32})$/u.exec(locator.path);
            return match === null || (typeof context.cgroupSubtree === 'string' && match[1] !== context.cgroupSubtree);
        }
        case 'netns': return keysOf(locator) !== 'keeper,netns' || !LOCATOR_ID.test(locator.netns);
        case 'pty': return keysOf(locator) !== 'keeper,pty' || !LOCATOR_ID.test(locator.pty);
        case 'endpoint':
        case 'process-tree':
            return keysOf(locator) !== 'id,keeper,marker,role' || locator.role !== kind || !LOCATOR_ID.test(locator.id) || locator.marker !== marker;
        default: return true;
    }
}

function stringList(value, maxCount, maxBytes) {
    return Array.isArray(value) && value.length <= maxCount && value.every((item) => typeof item === 'string' && Buffer.byteLength(item, 'utf8') <= maxBytes);
}

function specProblem(kind, spec, context) {
    if (!isPlainObject(spec)) return true;
    const endpoint = context.endpointLimits;
    switch (kind) {
        case 'runtime-dir':
        case 'netns':
        case 'cgroup':
            return keysOf(spec) !== '';
        case 'pty':
            return keysOf(spec) !== 'cols,rows' || !isCount(spec.cols, 1, 65535) || !isCount(spec.rows, 1, 65535);
        case 'endpoint': {
            if (keysOf(spec) !== 'config,netns' || !isSupervisorHandle(spec.netns) || !isPlainObject(spec.config)) return true;
            const { config } = spec;
            if (keysOf(config) !== 'limits,relays,streamDirectory' || !isPath(config.streamDirectory, endpoint.maxPathBytes)) return true;
            if (!isPlainObject(config.limits) || Object.entries(config.limits).some(([name, value]) => !Object.hasOwn(endpoint, name) || !isCount(value, 1, Number.MAX_SAFE_INTEGER))) return true;
            return !Array.isArray(config.relays) || config.relays.length > MAX_RELAYS || config.relays.some((relay) => !isPlainObject(relay)
                || keysOf(relay) !== 'port,target' || !isCount(relay.port, 1, 65535) || !isPath(relay.target, endpoint.maxPathBytes));
        }
        case 'process-tree':
            switch (spec.role) {
                case 'orchestration':
                    if (keysOf(spec) !== 'args,env,netns,role,script' || spec.netns !== null || !isPath(spec.script, endpoint.maxPathBytes)) return true;
                    if (context.orchestrationRoot !== undefined && !spec.script.startsWith(`${context.orchestrationRoot}/`)) return true;
                    if (!stringList(spec.args, MAX_ORCHESTRATION_ARGS, endpoint.maxArgBytes)) return true;
                    return !isPlainObject(spec.env) || Object.keys(spec.env).length > endpoint.maxEnvEntries
                        || Object.entries(spec.env).some(([name, value]) => !ENV_NAME.test(name) || typeof value !== 'string' || Buffer.byteLength(value, 'utf8') > endpoint.maxEnvValueBytes);
                case 'workload': {
                    if (keysOf(spec) !== 'netns,process,request,role,streams' || !isSupervisorHandle(spec.netns) || !isCount(spec.process, 1, 1_000_000)) return true;
                    if (!isPlainObject(spec.streams)) return true;
                    const names = Object.keys(spec.streams);
                    if (names.length === 0 || names.some((name) => !STREAM_NAMES.includes(name) || virtualPathProblem(spec.streams[name], endpoint.maxPathBytes))) return true;
                    return !validateStartRequest(spec.request, endpoint).ok;
                }
                case 'terminal':
                    if (keysOf(spec) !== 'argv,cwd,netns,pty,role' || !isSupervisorHandle(spec.pty) || !isPath(spec.cwd, endpoint.maxPathBytes)) return true;
                    if (spec.netns !== null && !isSupervisorHandle(spec.netns)) return true;
                    return !stringList(spec.argv, MAX_TERMINAL_ARGS, endpoint.maxArgBytes) || spec.argv.length === 0 || !INVENTORY_NAME.test(spec.argv[0]);
                default:
                    return true;
            }
        default:
            return true;
    }
}

function validateCreate(frame, context) {
    if (keysOf(frame) !== REQUEST_KEYS.create || !isSupervisorHandle(frame.resource) || typeof frame.kind !== 'string') return violation('bad_frame');
    if (!RESOURCE_KINDS.includes(frame.kind)) return violation('bad_frame');
    // A kind the ledger knows that v1 does not create (egress, GUI, and the keeper and view kinds, which have their own
    // routes) is refused: nothing is created.
    if (!CREATE_KINDS.includes(frame.kind)) return refused('kind_not_supported');
    const processBearing = PROCESS_BEARING_CREATE_KINDS.includes(frame.kind);
    if (processBearing ? !isOriginId(frame.marker) : frame.marker !== null) return violation('bad_frame');
    if (locatorProblem(frame.kind, frame.locator, frame.marker, context)) return violation('bad_frame');
    if (specProblem(frame.kind, frame.spec, context)) return violation('bad_frame');
    if (frame.kind === 'cgroup' && typeof context.cgroupSubtree !== 'string') return refused('cgroup_not_delegated');
    return OK;
}

// --- keeper-side admission (in-flight accounting, R1.2; N-A) ------------------------------------------------------------

// The keeper's count of what is outstanding. Ids rise strictly. Every request except pty_input counts toward maxInFlight,
// and the mount ops also toward maxMountInFlight (R2.3); pty_input counts only toward its pty's window (frames and raw
// bytes). settle(id) runs when the reply has been written. A conforming supervisor never exceeds any bound, so every
// breach is a violation. Check order: duplicate id, pty window, channel, per-grant lease, mount.
export function createKeeperAdmission(limits, viewLimits = resolveViewLimits()) {
    let lastId = 0;
    const inFlight = new Set();
    const mountInFlight = new Set();
    const leaseOf = new Map();
    const leaseGrants = new Set();
    const ptyWindows = new Map();
    const ptyOf = new Map();
    return {
        admit(frame) {
            if (frame.id <= lastId) return violation('duplicate_id');
            lastId = frame.id;
            if (frame.op === 'pty_input') {
                const bytes = Buffer.from(frame.data, 'base64').length;
                const window = ptyWindows.get(frame.resource) ?? { frames: 0, bytes: 0 };
                if (window.frames + 1 > limits.ptyInputWindowFrames || window.bytes + bytes > limits.ptyInputWindowBytes) return violation('pty_input_window');
                window.frames += 1;
                window.bytes += bytes;
                ptyWindows.set(frame.resource, window);
                ptyOf.set(frame.id, { resource: frame.resource, bytes });
                return OK;
            }
            if (inFlight.size >= limits.maxInFlight) return violation('in_flight_overflow');
            const lease = frame.op === 'view_root_lease';
            if (lease && leaseGrants.has(frame.grantId)) return violation('lease_in_flight_overflow');
            const mount = MOUNT_OPS.includes(frame.op);
            if (mount && mountInFlight.size >= viewLimits.maxMountInFlight) return violation('mount_in_flight_overflow');
            inFlight.add(frame.id);
            if (mount) mountInFlight.add(frame.id);
            if (lease) { leaseOf.set(frame.id, frame.grantId); leaseGrants.add(frame.grantId); }
            return OK;
        },
        settle(id) {
            const pty = ptyOf.get(id);
            if (pty) {
                ptyOf.delete(id);
                const window = ptyWindows.get(pty.resource);
                window.frames -= 1;
                window.bytes -= pty.bytes;
                return;
            }
            inFlight.delete(id);
            mountInFlight.delete(id);
            if (leaseOf.has(id)) { leaseGrants.delete(leaseOf.get(id)); leaseOf.delete(id); }
        },
        stats: () => ({ lastId, inFlight: inFlight.size, mountInFlight: mountInFlight.size, ptyInput: Object.fromEntries([...ptyWindows].map(([handle, window]) => [handle, { ...window }])) })
    };
}

// --- replies (supervisor side) ------------------------------------------------------------------------------------------

function wireIdentityProblem(kind, identity, locator) {
    if (!isPlainObject(identity)) return true;
    switch (kind) {
        case 'endpoint':
        case 'process-tree':
            return !replyKeys(identity, 'pid,pidNs,startTime') || !isCount(identity.pid, 1, MAX_PID) || !isDigits(identity.startTime) || !isDigits(identity.pidNs);
        case 'netns': return !replyKeys(identity, 'netNs') || !isDigits(identity.netNs);
        case 'runtime-dir':
            return !replyKeys(identity, 'dev,ino,path') || identity.path !== locator?.path || !isDigits(identity.dev) || !isDigits(identity.ino);
        case 'cgroup': return !replyKeys(identity, 'cgroupId,path') || identity.path !== locator?.path || !isDigits(identity.cgroupId);
        case 'pty':
            return !replyKeys(identity, 'devptsDev,index,pty') || identity.pty !== locator?.pty || !isDigits(identity.devptsDev) || !isCount(identity.index, 0, 2 ** 31 - 1);
        default: return true;
    }
}

// context: { kind, locator } of the handle a create, commit or stop names; { limits } for pty_input.
export function validateKeeperReply(reply, request, context = {}) {
    if (!isPlainObject(reply) || !isPlainObject(request) || reply.id !== request.id) return violation('bad_reply');
    if (reply.ok === false) {
        if (NO_ERROR_OPS.has(request.op)) return violation('bad_reply');
        return keysOf(reply) === 'error,id,kind,ok' && (reply.kind === 'refused' || reply.kind === 'failure')
            && typeof reply.error === 'string' && ERROR_CODE.test(reply.error) ? OK : violation('bad_reply');
    }
    if (reply.ok !== true || keysOf(reply) !== 'id,ok,value' || !isPlainObject(reply.value)) return violation('bad_reply');
    const { value } = reply;
    if (EMPTY_VALUE_OPS.has(request.op)) return replyKeys(value, '') ? OK : violation('bad_reply');
    switch (request.op) {
        case 'create':
            return replyKeys(value, 'identity,resource') && value.resource === request.resource
                && !wireIdentityProblem(request.kind, value.identity, request.locator) ? OK : violation('bad_reply');
        case 'commit': {
            const expected = PROCESS_BEARING_CREATE_KINDS.includes(context.kind) ? 'executed' : 'committed';
            return replyKeys(value, 'state') && value.state === expected ? OK : violation('bad_reply');
        }
        case 'stop': return replyKeys(value, 'state') && value.state === 'exited' ? OK : violation('bad_reply');
        case 'tempdir': return replyKeys(value, 'path') && typeof value.path === 'string' && TEMPDIR.test(value.path) ? OK : violation('bad_reply');
        case 'pty_input': return replyKeys(value, 'seq') && value.seq === request.seq ? OK : violation('bad_reply');
        case 'inventory':
            return replyKeys(value, 'descriptors,resources') && isCount(value.descriptors, 0, 1_000_000) && Array.isArray(value.resources)
                && value.resources.length <= MAX_INVENTORY_RESOURCES && value.resources.every((entry) => isPlainObject(entry)
                    && replyKeys(entry, 'kind,resource,state') && (isSupervisorHandle(entry.resource) || isMountHandle(entry.resource))
                    && RESOURCE_KINDS.includes(entry.kind) && typeof entry.state === 'string' && ERROR_CODE.test(entry.state)) ? OK : violation('bad_reply');
        case 'mount_view':
            // The frozen validator checks the exact tuples; the handle must also be a keeper-assigned one.
            return validateMountReply(reply, request).ok && isMountHandle(value.resource) ? OK : violation('bad_reply');
        case 'view_root_lease':
            return validateRootLeaseReply(reply, request).ok ? OK : violation('bad_reply');
        default:
            return violation('bad_reply');
    }
}

// --- events (supervisor side) -------------------------------------------------------------------------------------------

// Structural check of one event. context: { limits }.
export function validateKeeperEvent(frame, context) {
    if (!isPlainObject(frame) || typeof frame.event !== 'string') return violation('bad_event');
    switch (frame.event) {
        case 'hello':
            return keysOf(frame) === EVENT_KEYS.hello && typeof frame.protocol === 'string' && Number.isSafeInteger(frame.version)
                && isCount(frame.pid, 1, MAX_PID) && isDigits(frame.startTime) && isOriginId(frame.marker) && isPlainObject(frame.limits)
                && Object.values(frame.limits).every((value) => isCount(value, 1, Number.MAX_SAFE_INTEGER)) ? OK : violation('bad_event');
        case 'exit':
            return keysOf(frame) === EVENT_KEYS.exit && isSupervisorHandle(frame.resource) && (frame.code === null || Number.isSafeInteger(frame.code))
                && (frame.signal === null || (typeof frame.signal === 'string' && frame.signal.length >= 1 && frame.signal.length <= 32)) ? OK : violation('bad_event');
        case 'pty_output':
            if (keysOf(frame) !== EVENT_KEYS.pty_output || !isSupervisorHandle(frame.resource) || !isCanonicalSeq(frame.seq)
                || decodeCanonicalBase64(frame.data, context.limits.ptyChunkBytes) === null) return violation('bad_event');
            return encodedBytes(frame) <= ptyFrameCapBytes(context.limits) ? OK : violation('oversize_frame');
        case 'pty_closed':
            return keysOf(frame) === EVENT_KEYS.pty_closed && isSupervisorHandle(frame.resource) ? OK : violation('bad_event');
        default:
            return violation('unknown_event');
    }
}

// Records a validated reply to a `commit` request on the handle's channel state, synchronously, in the same turn as
// the reply is read: an event that follows the reply in the same read is judged against it (R2.1). commitOutcome is
// 'ok' (executed or committed), 'failure' (commit_failed: exec_failed, stream_connect_failed) or 'refused'. Both 'ok'
// and 'failure' mark the resource committed (a second commit or an abort is refused already_committed); a later
// refusal of a repeated commit does not overwrite the first outcome.
export function recordCommitReply(resource, reply) {
    if (resource.commitOutcome === 'ok' || resource.commitOutcome === 'failure') return;
    resource.commitOutcome = reply.ok === true ? 'ok' : reply.kind;
    if (reply.ok === true || reply.kind === 'failure') resource.committed = true;
}

// The event in the context of what the channel has seen. state: { helloSeen, resources: Map handle -> { kind,
// committed, commitOutcome, exited, pty: { nextSeq, credit, closed } | undefined } }. On ok the state is updated; on a
// violation it is not. A hello is only valid first. An exit is valid once for a process-bearing resource after its
// commit reply was `ok` or `failure` (section 4: an exit follows exec_failed and stream_connect_failed), never after a
// `refused` reply or before any reply. PTY output only in sequence, within the credit granted and before pty_closed.
export function acceptKeeperEvent(frame, state, context) {
    const structural = validateKeeperEvent(frame, context);
    if (!structural.ok) return structural;
    if (frame.event === 'hello') {
        if (state.helloSeen) return violation('duplicate_hello');
        state.helloSeen = true;
        return OK;
    }
    if (!state.helloSeen) return violation('hello_not_first');
    const resource = state.resources.get(frame.resource);
    if (!resource) return violation('unknown_resource');
    if (frame.event === 'exit') {
        const replied = resource.committed === true || resource.commitOutcome === 'ok' || resource.commitOutcome === 'failure';
        if (!PROCESS_BEARING_CREATE_KINDS.includes(resource.kind) || !replied) return violation('unsolicited_exit');
        if (resource.exited) return violation('duplicate_exit');
        resource.exited = true;
        return OK;
    }
    const pty = resource.pty;
    if (resource.kind !== 'pty' || !pty) return violation('unknown_resource');
    if (pty.closed) return violation('pty_closed');
    if (frame.event === 'pty_closed') {
        pty.closed = true;
        return OK;
    }
    if (frame.seq !== pty.nextSeq) return violation('sequence_gap');
    const bytes = Buffer.from(frame.data, 'base64').length;
    if (bytes > pty.credit) return violation('credit_overrun');
    pty.credit -= bytes;
    pty.nextSeq = nextSeq(pty.nextSeq);
    return OK;
}

// --- identities ---------------------------------------------------------------------------------------------------------

// Every committed start time passes through here unchanged: a canonical decimal string, the type procView reads.
const ledgerStartTime = (value) => value;

// The only producer of committed S1 identities from wire values (section 3 identity mapping). Start times, inodes and
// device numbers stay canonical decimal strings; pids and mount IDs stay integers, so the frozen walker's strict
// comparisons agree with procView. Throws on anything else.
export function toLedgerIdentity(kind, wire) {
    if (kind === 'keeper') {
        if (!isPlainObject(wire) || keysOf(wire) !== 'pid,startTime' || !isCount(wire.pid, 1, MAX_PID) || !isDigits(wire.startTime)) throw new TypeError('bad keeper identity');
        return { pid: wire.pid, startTime: ledgerStartTime(wire.startTime) };
    }
    if (kind === 'mount') {
        if (!isPlainObject(wire) || keysOf(wire) !== 'fileServer,mount,resource' || !isMountHandle(wire.resource)) throw new TypeError('bad mount identity');
        const { mount, fileServer } = wire;
        if (!isPlainObject(mount) || keysOf(mount) !== 'mountId,mountNamespaceInode,mountpoint' || !isCount(mount.mountId, 1, 2 ** 31)
            || typeof mount.mountpoint !== 'string' || !isDigits(mount.mountNamespaceInode)) throw new TypeError('bad mount tuple');
        if (!isPlainObject(fileServer) || keysOf(fileServer) !== 'pid,pidNamespaceInode,startTime' || !isCount(fileServer.pid, 1, MAX_PID)
            || !isDigits(fileServer.startTime) || !isDigits(fileServer.pidNamespaceInode)) throw new TypeError('bad file server tuple');
        return {
            resource: wire.resource,
            mountId: mount.mountId,
            mountpoint: mount.mountpoint,
            mntNs: mount.mountNamespaceInode,
            fileServer: { pid: fileServer.pid, startTime: ledgerStartTime(fileServer.startTime), pidNs: fileServer.pidNamespaceInode }
        };
    }
    if (wireIdentityProblem(kind, wire, { path: wire?.path, pty: wire?.pty })) throw new TypeError(`bad ${kind} identity`);
    switch (kind) {
        case 'endpoint':
        case 'process-tree':
            return { pid: wire.pid, startTime: ledgerStartTime(wire.startTime), pidNs: wire.pidNs };
        case 'netns': return { netNs: wire.netNs };
        case 'runtime-dir': return { path: wire.path, dev: wire.dev, ino: wire.ino };
        case 'cgroup': return { path: wire.path, cgroupId: wire.cgroupId };
        case 'pty': return { pty: wire.pty, devptsDev: wire.devptsDev, index: wire.index };
        default: throw new TypeError(`no identity mapping for ${kind}`);
    }
}
