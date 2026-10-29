// Generates golden vectors for the Rust keeper by importing the frozen Node modules READ-ONLY and recording what they
// answer. Usage (from the repository's robo-work directory or anywhere):
//   node native/scripts/gen-node-vectors.mjs <robo-work-dir> <output-json>
// Nothing in the Node tree is written. The output is contract evidence for the wire formats, not Linux runtime proof.

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const [roboWork, output, viewsOutput] = process.argv.slice(2);
if (!roboWork || !output || !viewsOutput) throw new Error('usage: gen-node-vectors.mjs <robo-work-dir> <keeper-output-json> <views-output-json>');
const load = (relative) => import(pathToFileURL(path.join(roboWork, relative)).href);

const { encodeFrame, createFrameDecoder } = await load('server/execution/frameCodec.mjs');
const { COMMIT_BYTE } = await load('server/execution/gateProtocol.mjs');
const mount = await load('server/views/mountFrames.mjs');
const { createRootLeaseKeeper } = await load('server/views/rootLease.mjs');
const { VIEW_LIMIT_DEFAULTS } = await load('server/views/viewLimits.mjs');

const hex = (buffer) => Buffer.from(buffer).toString('hex');

// ---- frames ------------------------------------------------------------------------------------------------------
const encodeCases = [
    { id: 1, op: 'unmount_view', resource: 'abcdef0123456789' },
    { id: 2, ok: true, value: { state: 'live' } },
    { id: 3, ok: false, kind: 'refused', error: 'bad_frame' },
    { text: 'quote " backslash \\ controls \b\f\n\r\t \u0001 \u001f slash / del \u007f e-acute é line-sep   astral \u{1F600}' },
    { nested: { a: [1, 2, { b: null }], c: true, d: false }, big: 9007199254740991, neg: -5 }
].map((value) => ({ value, frameHex: hex(encodeFrame(value, { maxFrameBytes: 65536 })) }));

// Decoder scripts: each step is { hex, at } (bytes pushed at a time) or { poll: at } (the timer fires at that time).
function runDecoder({ maxFrameBytes, deadlineMs, steps }) {
    const events = [];
    let pending = null;
    let clock = 0;
    const timers = {
        setTimeout(fn, ms) { pending = { fn, at: clock + ms }; return pending; },
        clearTimeout(handle) { if (pending === handle) pending = null; }
    };
    const decoder = createFrameDecoder({
        maxFrameBytes, partialFrameDeadlineMs: deadlineMs, timers,
        onFrame: (value) => events.push({ frame: value }),
        onViolation: (code) => events.push({ violation: code })
    });
    for (const step of steps) {
        const at = step.at ?? step.poll;
        // Timers fire in order before input that arrives later.
        if (pending && at >= pending.at) { const due = pending; pending = null; clock = due.at; due.fn(); }
        clock = at;
        if (step.hex !== undefined) decoder.push(Buffer.from(step.hex, 'hex'));
    }
    return events;
}
const frameHex = (value) => hex(encodeFrame(value, { maxFrameBytes: 65536 }));
const decoderCases = [
    { name: 'two_frames_coalesced', maxFrameBytes: 64, deadlineMs: 100, steps: [{ hex: frameHex({ id: 1 }) + frameHex({ id: 2 }), at: 0 }] },
    { name: 'byte_split', maxFrameBytes: 64, deadlineMs: 100, steps: [...Buffer.from(frameHex({ id: 1, op: 'x' }), 'hex')].map((b, i) => ({ hex: b.toString(16).padStart(2, '0'), at: i })) },
    { name: 'oversize', maxFrameBytes: 8, deadlineMs: 100, steps: [{ hex: '00000009', at: 0 }, { hex: frameHex({ id: 1 }), at: 1 }] },
    { name: 'exact_bound', maxFrameBytes: 8, deadlineMs: 100, steps: [{ hex: frameHex({ id: 1 }), at: 0 }] },
    { name: 'empty', maxFrameBytes: 64, deadlineMs: 100, steps: [{ hex: '00000000', at: 0 }] },
    { name: 'array_payload', maxFrameBytes: 64, deadlineMs: 100, steps: [{ hex: '00000003' + hex(Buffer.from('[1]')), at: 0 }] },
    { name: 'not_json', maxFrameBytes: 64, deadlineMs: 100, steps: [{ hex: '00000001' + hex(Buffer.from('{')), at: 0 }] },
    { name: 'deadline_from_first_byte', maxFrameBytes: 64, deadlineMs: 100, steps: [{ hex: '00', at: 10 }, { hex: '00', at: 60 }, { hex: '0009', at: 109 }, { poll: 110 }, { hex: hex(Buffer.from('{"id":1}')) + '00', at: 111 }] },
    { name: 'deadline_reset_after_complete', maxFrameBytes: 64, deadlineMs: 100, steps: [{ hex: frameHex({ id: 1 }), at: 0 }, { hex: '00', at: 500 }, { poll: 599 }, { hex: '000008' + hex(Buffer.from('{"id":2}')), at: 599 }] }
].map((entry) => ({ ...entry, events: runDecoder(entry) }));

// ---- mount frames ------------------------------------------------------------------------------------------------
const context = { scope: 'execution', runtimeRoot: '/run/robo-work', reservationId: 'abcdef0123456789abcdef0123456789', grantCount: 2 };
const mountpoint = mount.viewMountpoint({ ...context, grantId: 'app' });
const good = {
    id: 5, op: 'mount_view', grantId: 'app', rootSlot: 8, expectedRootIdentity: { dev: '2049', ino: '1234567' }, access: 'write',
    mountpoint, propagation: 'private', allowOther: true, descriptorCap: 1024, rlimitNofile: 1100, rootLease: { epoch: 1, ttlMs: 3000 }
};
const variants = {
    good,
    read_access: { ...good, access: 'read' },
    slot_9: { ...good, rootSlot: 9 },
    slot_10: { ...good, rootSlot: 10 },
    slot_7: { ...good, rootSlot: 7 },
    source_path: { ...good, sourcePath: '/x' },
    extra_key: { ...good, extra: 1 },
    missing_key: (() => { const copy = { ...good }; delete copy.access; return copy; })(),
    wrong_op: { ...good, op: 'mount' },
    id_zero: { ...good, id: 0 },
    id_float: { ...good, id: 1.5 },
    id_huge: { ...good, id: 1000000001 },
    grant_upper: { ...good, grantId: 'App' },
    grant_dash_first: { ...good, grantId: '-app' },
    grant_long: { ...good, grantId: 'a'.repeat(33) },
    identity_number: { ...good, expectedRootIdentity: { dev: 2049, ino: '1' } },
    identity_extra: { ...good, expectedRootIdentity: { dev: '1', ino: '1', gen: '1' } },
    identity_21_digits: { ...good, expectedRootIdentity: { dev: '1', ino: '1'.repeat(21) } },
    access_rw: { ...good, access: 'rw' },
    shared: { ...good, propagation: 'shared' },
    allow_other_false: { ...good, allowOther: false },
    allow_other_string: { ...good, allowOther: 'true' },
    other_mountpoint: { ...good, mountpoint: '/run/robo-work/x/abcdef0123456789abcdef0123456789/views/other' },
    mountpoint_number: { ...good, mountpoint: 7 },
    cap_zero: { ...good, descriptorCap: 0 },
    cap_too_close: { ...good, descriptorCap: 1024, rlimitNofile: 1092 },
    cap_just_fits: { ...good, descriptorCap: 1024, rlimitNofile: 1093 },
    lease_epoch_2: { ...good, rootLease: { epoch: 2, ttlMs: 3000 } },
    lease_ttl_0: { ...good, rootLease: { epoch: 1, ttlMs: 0 } },
    lease_ttl_over: { ...good, rootLease: { epoch: 1, ttlMs: 3001 } },
    lease_extra: { ...good, rootLease: { epoch: 1, ttlMs: 3000, x: 1 } },
    not_object: [1, 2]
};
const mountCases = Object.entries(variants).map(([name, frame]) => ({ name, frame, verdict: mount.validateMountRequest(frame, context) }));
const badContexts = [
    { name: 'gui_scope', context: { ...context, scope: 'gui' }, frame: { ...good, mountpoint: mount.viewMountpoint({ ...context, scope: 'gui', grantId: 'app' }) } },
    { name: 'zero_grants', context: { ...context, grantCount: 0 }, frame: good },
    { name: 'runtime_root_trailing_slash', context: { ...context, runtimeRoot: '/run/robo-work/' }, frame: good },
    { name: 'reservation_short', context: { ...context, reservationId: 'abc' }, frame: good }
].map((entry) => ({ ...entry, verdict: mount.validateMountRequest(entry.frame, entry.context) }));

const unmountCases = [
    { id: 1, op: 'unmount_view', resource: 'abcdef0123456789' },
    { id: 1, op: 'unmount_view', resource: 'ABCDEF0123456789' },
    { id: 1, op: 'unmount_view', resource: 'short' },
    { id: 1, op: 'unmount_view', resource: 'abcdef0123456789', x: 1 },
    { id: 0, op: 'unmount_view', resource: 'abcdef0123456789' }
].map((frame) => ({ frame, verdict: mount.validateUnmountRequest(frame) }));

// validateMountSet (S5 r7 emits snake_case duplicate codes). Each case has at most one duplication.
const setMember = (index, extra = {}) => ({ ...good, id: 100 + index, grantId: `g${index}`, rootSlot: 8 + index,
    mountpoint: mount.viewMountpoint({ ...context, grantCount: 8, grantId: `g${index}` }), ...extra });
const mountSetCases = Object.entries({
    distinct: [setMember(0), setMember(1)],
    duplicate_id: [setMember(0), setMember(1, { id: 100 })],
    duplicate_grant: [setMember(0), setMember(1, { grantId: 'g0', mountpoint: setMember(5).mountpoint })],
    duplicate_slot: [setMember(0), setMember(1, { rootSlot: 8 })],
    duplicate_mountpoint: [setMember(0), setMember(1, { mountpoint: setMember(0).mountpoint })],
    too_many: Array.from({ length: 9 }, (_, index) => setMember(index))
}).map(([name, requests]) => ({ name, requests, verdict: mount.validateMountSet(requests) }));

const lease = (extra) => ({ id: 3, op: 'view_root_lease', grantId: 'app', epoch: 2, verdict: 'renew', ttlMs: 3000, ...extra });
const revoke = (extra) => ({ id: 3, op: 'view_root_lease', grantId: 'app', epoch: 2, verdict: 'revoke', reason: 'root_unbound', ...extra });
const leaseFrames = {
    renew: lease({}), renew_ttl_max: lease({ ttlMs: 3000 }), renew_ttl_over: lease({ ttlMs: 3001 }), renew_ttl_zero: lease({ ttlMs: 0 }),
    renew_ttl_float: lease({ ttlMs: 1.5 }), renew_epoch_1: lease({ epoch: 1 }), renew_epoch_unsafe: lease({ epoch: 9007199254740992 }),
    renew_extra: lease({ reason: 'x' }), renew_source: lease({ path: '/x' }), renew_bad_grant: lease({ grantId: 'A' }),
    revoke: revoke({}), revoke_numeric_reason: revoke({ reason: 7 }), revoke_bad_reason: revoke({ reason: 'Root' }),
    revoke_with_ttl: revoke({ ttlMs: 3 }), bad_verdict: lease({ verdict: 'extend' }), bad_op: lease({ op: 'lease' })
};
const leaseCases = Object.entries(leaseFrames).map(([name, frame]) => ({ name, frame, verdict: mount.validateRootLeaseFrame(frame) }));

const sampleReplies = [
    { name: 'mount_ok', request: good, reply: { id: 5, ok: true, value: { resource: 'r0123456789abcdef', mount: { mountId: 812, mountpoint, mountNamespaceInode: '4026532001' }, fileServer: { pid: 4242, startTime: '123456', pidNamespaceInode: '4026531836' } } } },
    { name: 'mount_refused', request: good, reply: { id: 5, ok: false, kind: 'refused', error: 'root_identity_mismatch' } },
    { name: 'mount_bad_mountpoint', request: good, reply: { id: 5, ok: true, value: { resource: 'r0123456789abcdef', mount: { mountId: 812, mountpoint: '/x', mountNamespaceInode: '1' }, fileServer: { pid: 1, startTime: '1', pidNamespaceInode: '1' } } } },
    { name: 'mount_error_object', request: good, reply: { id: 5, ok: false, kind: 'refused', error: { code: 'x', message: 'y' } } }
].map((entry) => ({ ...entry, verdict: mount.validateMountReply(entry.reply, entry.request) }));
const leaseReplies = [
    { reply: { id: 3, ok: true, value: { state: 'live' } } },
    { reply: { id: 3, ok: true, value: { state: 'dead' } } },
    { reply: { id: 3, ok: false, kind: 'refused', error: 'stale_epoch' } },
    { reply: { id: 4, ok: true, value: { state: 'live' } } }
].map((entry) => ({ ...entry, verdict: mount.validateRootLeaseReply(entry.reply, lease({})) }));

// ---- root lease keeper timelines -----------------------------------------------------------------------------------
function timeline(steps) {
    let now = 0;
    const keeper = createRootLeaseKeeper({ grantId: 'app', initial: { epoch: 1, ttlMs: 3000 }, now: () => now });
    return steps.map((step) => {
        now = step.at;
        if (step.apply) return { ...step, result: keeper.apply(step.apply), inspect: keeper.inspect() };
        if (step.poll) return { ...step, result: keeper.poll(), inspect: keeper.inspect() };
        if (step.serverExited) { keeper.serverExited(); return { ...step, inspect: keeper.inspect() }; }
        throw new Error('bad step');
    });
}
const leaseTimelines = {
    expiry: timeline([{ at: 2999, poll: true }, { at: 3000, poll: true }, { at: 4999, poll: true }, { at: 5000, poll: true }, { at: 6000, poll: true }]),
    renewals: timeline([{ at: 1000, apply: lease({ epoch: 2 }) }, { at: 1500, apply: lease({ epoch: 2 }) }, { at: 3999, poll: true }, { at: 4000, apply: lease({ epoch: 3 }) }, { at: 4001, poll: true }]),
    revoke_any_epoch: timeline([{ at: 10, apply: lease({ epoch: 7 }) }, { at: 20, apply: revoke({ epoch: 2 }) }, { at: 30, apply: lease({ epoch: 8 }) }, { at: 30, poll: true }, { at: 2029, poll: true }, { at: 2030, poll: true }]),
    exit_first: timeline([{ at: 0, apply: revoke({}) }, { at: 0, poll: true }, { at: 1, serverExited: true }, { at: 9000, poll: true }]),
    bad_frames: timeline([{ at: 1, apply: lease({ ttlMs: 3001 }) }, { at: 2, apply: lease({ grantId: 'other' }) }, { at: 3, apply: lease({ epoch: 1 }) }, { at: 4, apply: { op: 'view_root_lease' } }]),
    exited_live: timeline([{ at: 5, serverExited: true }, { at: 6, poll: true }])
};

const out = {
    schema: 'robo-work.native-golden/1',
    generatedBy: 'native/scripts/gen-node-vectors.mjs (read-only import of the frozen Node modules)',
    node: process.version,
    commitByte: COMMIT_BYTE,
    viewLimitDefaults: VIEW_LIMIT_DEFAULTS,
    encodeCases, decoderCases, mountContext: context, mountCases, badContexts, unmountCases, mountSetCases, leaseCases, sampleReplies, leaseReplies,
    leaseTimelines
};
fs.writeFileSync(output, `${JSON.stringify(out, null, 1)}\n`);
console.log(`wrote ${output}`);

// ---- views: the D2 marker and the FUSE settings specification, for the Rust constants ------------------------------
const { D2_DECISION } = await load('server/views/d2Decision.mjs');
const { FUSE_VIEW_SETTINGS, findSettingsViolations } = await load('server/views/fuseSettings.mjs');
const goodSample = {
    init: { capabilities: ['FUSE_ASYNC_READ', 'FUSE_BIG_WRITES', 'FUSE_MAX_PAGES'] },
    entryReplies: [{ entryValid: { secs: 0, nsecs: 0 } }],
    negativeLookupReplies: [{ kind: 'error', errno: 'ENOENT' }],
    openReplies: [{ openFlags: ['FOPEN_DIRECT_IO'] }],
    opendirReplies: [{ openFlags: [] }],
    readReplies: [{ delivery: 'copy' }],
    mountOptions: ['allow_other', 'ro'], grantAccess: 'read'
};
const sampleCases = {
    good: goodSample,
    writeback: { ...goodSample, init: { capabilities: ['FUSE_WRITEBACK_CACHE', 'FUSE_DIRECT_IO_ALLOW_MMAP', 'FUSE_NEW_THING'] } },
    entry_ttl: { ...goodSample, entryReplies: [{ entryValid: { secs: 1, nsecs: 0 } }] },
    negative_cached: { ...goodSample, negativeLookupReplies: [{ kind: 'entry', nodeId: 0, entryValid: { secs: 0, nsecs: 5 } }] },
    keep_cache: { ...goodSample, openReplies: [{ openFlags: ['FOPEN_KEEP_CACHE'] }] },
    splice: { ...goodSample, readReplies: [{ delivery: 'splice' }] },
    ro_missing: { ...goodSample, mountOptions: ['allow_other'] },
    readdirplus_no_evidence: { ...goodSample, init: { capabilities: ['FUSE_DO_READDIRPLUS'] } },
    empty: {}
};
const views = {
    schema: 'robo-work.native-views/1',
    d2: D2_DECISION,
    fuse: FUSE_VIEW_SETTINGS,
    samples: Object.fromEntries(Object.entries(sampleCases).map(([name, sample]) => [name, { sample, violations: findSettingsViolations(sample) }]))
};
fs.writeFileSync(viewsOutput, `${JSON.stringify(views, null, 1)}\n`);
console.log(`wrote ${viewsOutput}`);
