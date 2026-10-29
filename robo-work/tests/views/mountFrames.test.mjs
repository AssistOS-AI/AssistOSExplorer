import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Duplex } from 'node:stream';
import test from 'node:test';

import { createFrameChannel, createFrameDecoder, encodeFrame } from '../../server/execution/frameCodec.mjs';
import { resolveGrant } from '../../server/views/grantResolver.mjs';
import {
    PROPAGATION, grantRootSlots, validateMountReply, validateMountRequest, validateMountSet, validateRootLeaseFrame, validateRootLeaseReply,
    validateUnmountRequest, viewMountpoint
} from '../../server/views/mountFrames.mjs';
import { createRootLeaseIssuer } from '../../server/views/rootLease.mjs';
import { resolveViewLimits } from '../../server/views/viewLimits.mjs';

const context = Object.freeze({ scope: 'execution', runtimeRoot: '/run/robo-work', reservationId: 'a1b2c3d4e5f60718', grantCount: 2 });
const limits = resolveViewLimits();

// The locator of a deliberately malformed grant id cannot be derived; the request then carries a placeholder.
function safeMountpoint(grantId) {
    try {
        return viewMountpoint({ ...context, grantId });
    } catch {
        return '/placeholder';
    }
}

function request(overrides = {}) {
    const grantId = overrides.grantId ?? 'project';
    return {
        id: 1, op: 'mount_view', grantId, rootSlot: limits.firstGrantRootSlot,
        expectedRootIdentity: { dev: '16777231', ino: '8589934592' }, access: 'write',
        mountpoint: safeMountpoint(grantId), propagation: 'private', allowOther: true,
        descriptorCap: 1024, rlimitNofile: 4096, rootLease: { epoch: 1, ttlMs: limits.rootLeaseTtlMs }, ...overrides
    };
}

test('a well-formed mount request is accepted', () => {
    assert.deepEqual(validateMountRequest(request(), context), { ok: true });
    assert.deepEqual(validateMountRequest(request({ id: 2, grantId: 'sibling', rootSlot: limits.firstGrantRootSlot + 1, access: 'read' }), context), { ok: true });
    const gui = { ...context, scope: 'gui' };
    assert.deepEqual(validateMountRequest(request({ mountpoint: viewMountpoint({ ...gui, grantId: 'project' }) }), gui), { ok: true });
});

const REFUSALS = [
    ['a source path under the usual name', { sourcePath: '/ws/project' }, 'source_path_not_allowed'],
    ['a host path', { hostPath: '/ws/project' }, 'source_path_not_allowed'],
    ['a path', { path: '/ws/project' }, 'source_path_not_allowed'],
    ['a root key', { root: '/' }, 'source_path_not_allowed'],
    ['an unknown extra key', { extra: 1 }, 'bad_frame'],
    ['another operation', { op: 'mount' }, 'bad_frame'],
    ['a zero id', { id: 0 }, 'bad_frame'],
    ['a string id', { id: '1' }, 'bad_frame'],
    ['an upper-case grant id', { grantId: 'Project' }, 'bad_grant_id'],
    ['a grant id with a slash', { grantId: 'a/b' }, 'bad_grant_id'],
    ['a grant id that is too long', { grantId: 'a'.repeat(33) }, 'bad_grant_id'],
    ['a slot below the first', { rootSlot: limits.firstGrantRootSlot - 1 }, 'root_slot_out_of_range'],
    ['a slot beyond the inherited grants', { rootSlot: limits.firstGrantRootSlot + 2 }, 'root_slot_out_of_range'],
    ['a fractional slot', { rootSlot: 8.5 }, 'root_slot_out_of_range'],
    ['a numeric identity', { expectedRootIdentity: { dev: 1, ino: 2 } }, 'bad_root_identity'],
    ['an identity with a third field', { expectedRootIdentity: { dev: '1', ino: '2', path: '/x' } }, 'bad_root_identity'],
    ['no identity', { expectedRootIdentity: null }, 'bad_root_identity'],
    ['an unknown access', { access: 'admin' }, 'bad_access'],
    ['shared propagation', { propagation: 'shared' }, 'propagation_not_private'],
    ['slave propagation', { propagation: 'slave' }, 'propagation_not_private'],
    ['no allow_other', { allowOther: false }, 'allow_other_required'],
    ['a mountpoint of the requester\'s choice', { mountpoint: '/etc' }, 'mountpoint_not_locator'],
    ['a mountpoint of another reservation', { mountpoint: '/run/robo-work/x/ffffffffffffffff/views/project' }, 'mountpoint_not_locator'],
    ['a cap equal to the rlimit', { descriptorCap: 4096 }, 'descriptor_cap_invalid'],
    ['a zero cap', { descriptorCap: 0 }, 'descriptor_cap_invalid'],
    ['a negative rlimit', { rlimitNofile: -1 }, 'descriptor_cap_invalid'],
    ['no root lease', { rootLease: null }, 'bad_root_lease'],
    ['a root lease of epoch 2', { rootLease: { epoch: 2, ttlMs: 3000 } }, 'bad_root_lease'],
    ['a root lease of zero lifetime', { rootLease: { epoch: 1, ttlMs: 0 } }, 'bad_root_lease'],
    ['a root lease longer than the maximum', { rootLease: { epoch: 1, ttlMs: 3001 } }, 'bad_root_lease'],
    ['a root lease with an extra key', { rootLease: { epoch: 1, ttlMs: 3000, anchorFd: 3 } }, 'bad_root_lease'],
    ['a chain descriptor next to the root', { anchorFd: 3 }, 'bad_frame'],
    ['the walk chain descriptors', { chainFds: [3, 4] }, 'bad_frame'],
    ['a backing path', { backingPath: '/ws' }, 'source_path_not_allowed']
];
for (const [label, overrides, code] of REFUSALS) {
    test(`mount request refused: ${label}`, () => {
        const verdict = validateMountRequest(request(overrides), context);
        assert.deepEqual(verdict, { ok: false, code });
    });
}

test('a request with a missing key is refused', () => {
    const frame = request();
    delete frame.propagation;
    assert.equal(validateMountRequest(frame, context).code, 'bad_frame');
    for (const frameLike of [null, [], 'x', 3]) assert.equal(validateMountRequest(frameLike, context).code, 'bad_frame');
});

test('propagation is the constant private', () => {
    assert.equal(PROPAGATION, 'private');
});

test('the mountpoint is a locator derived from the reservation, and malformed context is refused', () => {
    assert.equal(viewMountpoint({ ...context, grantId: 'p' }), '/run/robo-work/x/a1b2c3d4e5f60718/views/p');
    assert.equal(viewMountpoint({ ...context, scope: 'gui', grantId: 'p' }), '/run/robo-work/gui/a1b2c3d4e5f60718/p');
    for (const bad of [{ runtimeRoot: 'relative' }, { runtimeRoot: '/' }, { runtimeRoot: '/a/../b' }, { runtimeRoot: '/a/' }, { reservationId: 'SHORT' },
        { reservationId: '../../etc/xxxxxxxx' }, { grantId: '../x' }, { scope: 'other' }]) {
        assert.throws(() => viewMountpoint({ ...context, grantId: 'p', ...bad }), TypeError, JSON.stringify(bad));
    }
    assert.equal(validateMountRequest(request(), { ...context, reservationId: 'bad' }).code, 'bad_context');
    assert.equal(validateMountRequest(request(), { ...context, runtimeRoot: '/' + 'r'.repeat(600) }).code, 'mountpoint_too_long');
});

test('the requests of one keeper are bounded and distinct', () => {
    const one = request();
    const two = request({ id: 2, grantId: 'sibling', rootSlot: limits.firstGrantRootSlot + 1, mountpoint: viewMountpoint({ ...context, grantId: 'sibling' }) });
    assert.deepEqual(validateMountSet([one, two]), { ok: true });
    assert.equal(validateMountSet([]).code, 'bad_mount_set');
    assert.equal(validateMountSet([one, { ...two, id: 1 }]).code, 'duplicate_id');
    assert.equal(validateMountSet([one, { ...two, grantId: 'project' }]).code, 'duplicate_grant_id');
    assert.equal(validateMountSet([one, { ...two, rootSlot: one.rootSlot }]).code, 'duplicate_root_slot');
    assert.equal(validateMountSet([one, { ...two, mountpoint: one.mountpoint }]).code, 'duplicate_mountpoint');
    const many = Array.from({ length: limits.maxViewsPerKeeper + 1 }, (_, index) => ({ ...one, id: index + 1, grantId: `g${index}`, rootSlot: 8 + index, mountpoint: `/m/${index}` }));
    assert.equal(validateMountSet(many).code, 'bad_mount_set');
});

test('unmount requests carry only an opaque resource', () => {
    assert.deepEqual(validateUnmountRequest({ id: 3, op: 'unmount_view', resource: 'res0123456789abc' }), { ok: true });
    for (const frame of [{ id: 3, op: 'unmount_view' }, { id: 3, op: 'unmount_view', resource: '/mnt/view' }, { id: 3, op: 'unmount_view', resource: 'r', path: '/x' },
        { id: 3, op: 'unmount', resource: 'res0123456789abc' }]) {
        assert.equal(validateUnmountRequest(frame).ok, false, JSON.stringify(frame));
    }
});

const goodReply = (requestFrame = request()) => ({
    id: requestFrame.id, ok: true,
    value: {
        resource: 'res0123456789abc',
        mount: { mountId: 77, mountpoint: requestFrame.mountpoint, mountNamespaceInode: '4026532481' },
        fileServer: { pid: 4242, startTime: '123456789', pidNamespaceInode: '4026532490' }
    }
});

test('the keeper reply carries the committed identity tuples, and nothing else is accepted', () => {
    assert.deepEqual(validateMountReply(goodReply(), request()), { ok: true });
    assert.deepEqual(validateMountReply({ id: 1, ok: false, kind: 'refused', error: 'root_identity_mismatch' }, request()), { ok: true });
    const mutations = [
        (reply) => { reply.id = 9; },
        (reply) => { reply.value.mount.mountpoint = '/elsewhere'; },
        (reply) => { reply.value.mount.mountId = 0; },
        (reply) => { reply.value.mount.mountNamespaceInode = 'ns'; },
        (reply) => { delete reply.value.mount.mountNamespaceInode; },
        (reply) => { reply.value.fileServer.pid = 0; },
        (reply) => { reply.value.fileServer.pid = 5_000_000; },
        (reply) => { reply.value.fileServer.startTime = 5; },
        (reply) => { delete reply.value.fileServer; },
        (reply) => { reply.value.resource = '../x'; },
        (reply) => { reply.value.extra = 1; },
        (reply) => { reply.extra = 1; }
    ];
    for (const mutate of mutations) {
        const reply = goodReply();
        mutate(reply);
        assert.equal(validateMountReply(reply, request()).ok, false, mutate.toString());
    }
    for (const reply of [{ id: 1, ok: false, kind: 'other', error: 'x' }, { id: 1, ok: false, kind: 'failure', error: 'Not A Code' }, { id: 1, ok: false, kind: 'failure' }, null]) {
        assert.equal(validateMountReply(reply, request()).ok, false);
    }
});

// --- bounds on the real frame codec ------------------------------------------------------------------------------------

test('the largest valid mount request fits the frame bound, and an oversize frame is refused from its header', () => {
    const widest = request({
        id: 1_000_000_000, grantId: 'g'.repeat(limits.maxGrantIdBytes), expectedRootIdentity: { dev: '9'.repeat(20), ino: '9'.repeat(20) },
        descriptorCap: Number.MAX_SAFE_INTEGER - 1000, rlimitNofile: Number.MAX_SAFE_INTEGER
    });
    const wideContext = { ...context, runtimeRoot: `/${'r'.repeat(300)}`, reservationId: 'f'.repeat(64) };
    widest.mountpoint = viewMountpoint({ ...wideContext, grantId: widest.grantId });
    assert.deepEqual(validateMountRequest(widest, wideContext), { ok: true });
    const encoded = encodeFrame(widest, { maxFrameBytes: limits.maxMountFrameBytes });
    assert.ok(encoded.length - 4 <= limits.maxMountFrameBytes);
    assert.throws(() => encodeFrame({ ...widest, padding: 'x'.repeat(limits.maxMountFrameBytes) }, { maxFrameBytes: limits.maxMountFrameBytes }), RangeError);

    const violations = [];
    const decoder = createFrameDecoder({ maxFrameBytes: limits.maxMountFrameBytes, partialFrameDeadlineMs: 1000, onFrame: () => {}, onViolation: (code) => violations.push(code) });
    const header = Buffer.alloc(4);
    header.writeUInt32BE(limits.maxMountFrameBytes + 1, 0);
    decoder.push(header);
    assert.deepEqual(violations, ['oversize_frame']);
    assert.deepEqual({ frames: decoder.stats().frames, dead: decoder.stats().dead }, { frames: 0, dead: true });
});

test('a mount request travels through the frame codec and validates on the other side; more than the in-flight bound ends the channel', async () => {
    const a = new Duplex({ read() {}, write(chunk, encoding, callback) { b.push(chunk); callback(); } });
    const b = new Duplex({ read() {}, write(chunk, encoding, callback) { a.push(chunk); callback(); } });
    const received = [];
    const violations = [];
    const channel = createFrameChannel(b, {
        maxFrameBytes: limits.maxMountFrameBytes, maxInFlight: limits.maxMountInFlight, partialFrameDeadlineMs: 1000,
        onFrame: (frame) => { received.push(frame); channel.admit(frame.id); }, onViolation: (code) => violations.push(code)
    });
    for (let id = 1; id <= limits.maxMountInFlight + 1; id += 1) {
        a.write(encodeFrame(request({ id }), { maxFrameBytes: limits.maxMountFrameBytes }));
    }
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(received.length, limits.maxMountInFlight + 1);
    for (const frame of received.slice(0, limits.maxMountInFlight)) assert.deepEqual(validateMountRequest(frame, context), { ok: true });
    assert.deepEqual(violations, ['in_flight_overflow']);
    a.destroy();
});

// --- the descriptor route: inheritance at spawn ------------------------------------------------------------------------------

test('grant-root slots are consecutive from the first slot, bounded, and need distinct descriptors', () => {
    assert.deepEqual(grantRootSlots([21, 22]).map((entry) => entry.rootSlot), [8, 9]);
    assert.deepEqual(grantRootSlots([21], { firstGrantRootSlot: 10 }), [{ rootSlot: 10, fd: 21 }]);
    assert.throws(() => grantRootSlots([]), RangeError);
    assert.throws(() => grantRootSlots(Array.from({ length: 9 }, (_, index) => 20 + index)), RangeError);
    assert.throws(() => grantRootSlots([5, 5]), TypeError);
    assert.throws(() => grantRootSlots([-1]), TypeError);
    assert.throws(() => grantRootSlots(['3']), TypeError);
});

test('a grant root handed over by spawn-time inheritance is the same directory in the child, and survives a path swap', async (t) => {
    const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'rwv-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    fs.mkdirSync(path.join(root, 'proj'));
    fs.mkdirSync(path.join(root, 'sibling'));
    const first = await resolveGrant({ relativePath: 'proj', access: 'write', role: 'project' }, { workspaceRoot: root });
    const second = await resolveGrant({ relativePath: 'sibling', access: 'read', role: 'project' }, { workspaceRoot: root });
    assert.ok(first.ok && second.ok);
    const slots = grantRootSlots([first.grant.fd, second.grant.fd]);
    const stdio = ['ignore', 'pipe', 'inherit'];
    while (stdio.length < limits.firstGrantRootSlot) stdio.push('ignore');
    for (const { rootSlot, fd } of slots) stdio[rootSlot] = fd;
    // The path is swapped after validation and before the child looks: only the descriptor can be trusted.
    fs.renameSync(path.join(root, 'proj'), path.join(root, 'proj.moved'));
    fs.symlinkSync(path.join(root, 'sibling'), path.join(root, 'proj'));
    const script = `const fs = require('node:fs'); const out = [8, 9].map((fd) => { const s = fs.fstatSync(fd, { bigint: true }); return s.dev + ':' + s.ino; }); console.log(JSON.stringify(out));`;
    const child = spawn(process.execPath, ['-e', script], { stdio });
    let output = '';
    child.stdout.on('data', (chunk) => { output += chunk; });
    await new Promise((resolve, reject) => { child.on('error', reject); child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`child exited ${code}`)))); });
    assert.deepEqual(JSON.parse(output), [first.grant.identityKey, second.grant.identityKey]);
    await first.grant.close();
    await second.grant.close();
});

// --- the root lease frames (decision D-S5-6) -------------------------------------------------------------------------------

const lease = (overrides = {}) => ({ id: 5, op: 'view_root_lease', grantId: 'project', epoch: 2, verdict: 'renew', ttlMs: limits.rootLeaseTtlMs, ...overrides });
const revoke = (overrides = {}) => ({ id: 6, op: 'view_root_lease', grantId: 'project', epoch: 3, verdict: 'revoke', reason: 'root_unbound', ...overrides });

test('a mount request carries the epoch-1 root lease, at the boundaries of its lifetime', () => {
    assert.deepEqual(validateMountRequest(request({ rootLease: { epoch: 1, ttlMs: 1 } }), context), { ok: true });
    assert.deepEqual(validateMountRequest(request({ rootLease: { epoch: 1, ttlMs: limits.rootLeaseTtlMs } }), context), { ok: true });
    assert.equal(validateMountRequest(request({ rootLease: { epoch: 1, ttlMs: limits.rootLeaseTtlMs + 1 } }), context).code, 'bad_root_lease');
    const frame = request();
    delete frame.rootLease;
    assert.equal(validateMountRequest(frame, context).code, 'bad_frame', 'a mount request without a lease is not a mount request');
});

test('lease frames: renew and revoke shapes, epoch and lifetime boundaries, and malformed frames', () => {
    assert.deepEqual(validateRootLeaseFrame(lease()), { ok: true });
    assert.deepEqual(validateRootLeaseFrame(revoke()), { ok: true });
    assert.deepEqual(validateRootLeaseFrame(lease({ ttlMs: 1 })), { ok: true });
    assert.deepEqual(validateRootLeaseFrame(lease({ epoch: Number.MAX_SAFE_INTEGER })), { ok: true });
    assert.deepEqual(validateRootLeaseFrame(lease({ ttlMs: 0 })), { ok: false, code: 'bad_ttl' });
    assert.deepEqual(validateRootLeaseFrame(lease({ ttlMs: limits.rootLeaseTtlMs + 1 })), { ok: false, code: 'bad_ttl' });
    for (const frame of [
        lease({ epoch: Number.MAX_SAFE_INTEGER + 1 }), lease({ epoch: 1 }), lease({ epoch: 0 }), lease({ epoch: '2' }), lease({ ttlMs: 1.5 }),
        lease({ extra: 1 }), lease({ reason: 'x' }), revoke({ reason: 7 }), revoke({ reason: 'Not A Code' }), revoke({ ttlMs: 3000 }),
        lease({ verdict: 'extend' }), lease({ op: 'mount_view' }), lease({ id: 0 }), lease({ grantId: 'Project' }), lease({ grantId: 'g'.repeat(33) }),
        null, [], 'renew'
    ]) {
        assert.deepEqual(validateRootLeaseFrame(frame), { ok: false, code: 'bad_frame' }, JSON.stringify(frame));
    }
    for (const key of ['path', 'sourcePath', 'root']) {
        assert.deepEqual(validateRootLeaseFrame(lease({ [key]: '/ws/proj' })), { ok: false, code: 'source_path_not_allowed' }, key);
    }
});

test('lease replies: the keeper state or a refusal, and nothing else', () => {
    for (const state of ['live', 'revoking', 'killed']) assert.deepEqual(validateRootLeaseReply({ id: 5, ok: true, value: { state } }, lease()), { ok: true });
    assert.deepEqual(validateRootLeaseReply({ id: 5, ok: false, kind: 'refused', error: 'stale_epoch' }, lease()), { ok: true });
    for (const reply of [
        { id: 9, ok: true, value: { state: 'live' } }, { id: 5, ok: true, value: { state: 'dead' } }, { id: 5, ok: true, value: { state: 'live', ttl: 1 } },
        { id: 5, ok: true, value: {} }, { id: 5, ok: true }, { id: 5, ok: true, value: { state: 'live' }, extra: 1 },
        { id: 5, ok: false, kind: 'other', error: 'x' }, { id: 5, ok: false, kind: 'refused', error: 'Bad Code' }, null
    ]) {
        assert.deepEqual(validateRootLeaseReply(reply, lease()), { ok: false, code: 'bad_reply' }, JSON.stringify(reply));
    }
});

test('single-root confinement: the mount request built from a verified grant has the exact key set, and only the grant root gets a slot', async (t) => {
    const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'rwv-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    fs.mkdirSync(path.join(root, 'proj/sub'), { recursive: true });
    const { grant } = await resolveGrant({ relativePath: 'proj/sub', access: 'write', role: 'project' }, { workspaceRoot: root });
    const issuer = createRootLeaseIssuer({ grantId: 'project', verify: () => grant.verifyBinding() });
    const issued = await issuer.initial();
    assert.equal(issued.ok, true);
    const slots = grantRootSlots([grant.fd]);
    assert.deepEqual(slots, [{ rootSlot: limits.firstGrantRootSlot, fd: grant.fd }]);
    const frame = request({ expectedRootIdentity: { ...grant.identity }, rootSlot: slots[0].rootSlot, rootLease: issued.rootLease });
    assert.deepEqual(Object.keys(frame).sort(), ['access', 'allowOther', 'descriptorCap', 'expectedRootIdentity', 'grantId', 'id', 'mountpoint', 'op',
        'propagation', 'rlimitNofile', 'rootLease', 'rootSlot']);
    assert.deepEqual(validateMountRequest(frame, { ...context, grantCount: 1 }), { ok: true });

    // A child spawned with these slots holds the grant root at its slot and no descriptor of the anchor or of the walk
    // chain (Node opens them close-on-exec). Control: a descriptor of the anchor placed into a slot explicitly is seen.
    const inherited = async (extraFd) => {
        const stdio = ['ignore', 'pipe', 'inherit'];
        while (stdio.length < limits.firstGrantRootSlot) stdio.push('ignore');
        for (const { rootSlot, fd } of slots) stdio[rootSlot] = fd;
        if (extraFd !== undefined) stdio.push(extraFd);
        const script = `const fs = require('node:fs'); const out = []; for (const name of fs.readdirSync('/dev/fd')) { try { const s = fs.fstatSync(Number(name), { bigint: true }); out.push([Number(name), s.dev + ':' + s.ino]); } catch {} } console.log(JSON.stringify(out));`;
        const child = spawn(process.execPath, ['-e', script], { stdio });
        let output = '';
        child.stdout.on('data', (chunk) => { output += chunk; });
        await new Promise((resolve, reject) => { child.on('error', reject); child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`child exited ${code}`)))); });
        return JSON.parse(output);
    };
    const chainIds = grant.componentIdentities.slice(0, -1);
    const seen = await inherited();
    assert.deepEqual(seen.filter(([, id]) => id === grant.identityKey).map(([fd]) => fd), [limits.firstGrantRootSlot]);
    assert.deepEqual(seen.filter(([, id]) => chainIds.includes(id)), [], 'no anchor or chain descriptor is inherited');
    const anchorFd = fs.openSync(root, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY);
    try {
        const control = await inherited(anchorFd);
        assert.ok(control.some(([, id]) => id === grant.anchorIdentityKey), 'negative control: an explicitly passed anchor is detected');
    } finally {
        fs.closeSync(anchorFd);
    }
    await grant.close();
});

// --- S5 r7: the duplicate-mount refusal codes fit the reply grammar ---------------------------------------------------------

test('every duplicate-mount refusal of validateMountSet round-trips as a keeper refusal through validateMountReply', () => {
    const one = request();
    const two = request({ id: 2, grantId: 'sibling', rootSlot: limits.firstGrantRootSlot + 1, mountpoint: viewMountpoint({ ...context, grantId: 'sibling' }) });
    const duplicates = [
        [{ ...two, id: 1 }, 'duplicate_id'], [{ ...two, grantId: 'project' }, 'duplicate_grant_id'],
        [{ ...two, rootSlot: one.rootSlot }, 'duplicate_root_slot'], [{ ...two, mountpoint: one.mountpoint }, 'duplicate_mountpoint']
    ];
    for (const [second, expected] of duplicates) {
        const verdict = validateMountSet([one, second]);
        assert.equal(verdict.ok, false);
        // Round trip first: whatever code validateMountSet returns must be a refusal that validateMountReply accepts.
        const reply = { id: second.id, ok: false, kind: 'refused', error: verdict.code };
        assert.deepEqual(validateMountReply(reply, second), { ok: true }, `${verdict.code} is accepted as a refusal code`);
        assert.equal(verdict.code, expected);
    }
});

test('a mixed-case refusal code is still rejected as bad_reply: the reply grammar stays lowercase', () => {
    for (const error of ['duplicate_grantId', 'duplicate_rootSlot', 'Duplicate_id']) {
        assert.deepEqual(validateMountReply({ id: 1, ok: false, kind: 'refused', error }, request()), { ok: false, code: 'bad_reply' }, error);
    }
});
