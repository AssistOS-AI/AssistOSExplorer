import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { createFrameDecoder, encodeFrame } from '../../server/execution/frameCodec.mjs';
import { resolveEndpointLimits } from '../../server/execution/executionLimits.mjs';
import {
    KEEPER_OPS, PRIORITY_OPS, acceptKeeperEvent, buildRequest, createKeeperAdmission, decodeCanonicalBase64, isCanonicalSeq, keeperArgv,
    recordCommitReply, resourceHandle, toLedgerIdentity, validateKeeperEvent, validateKeeperReply, validateKeeperRequest, wireCode
} from '../../server/execution/keeperFrames.mjs';
import {
    CLIENT_ONLY_LIMIT_NAMES, HELLO_LIMIT_NAMES, KEEPER_CHANNEL_LIMIT_NAMES, KEEPER_LIMIT_DEFAULTS, channelLimitsForKeeper, helloLimits,
    minimumOutboundBytes, ptyFrameCapBytes, resolveKeeperLimits
} from '../../server/execution/keeperLimits.mjs';
import { deriveLocator } from '../../server/execution/resourceLocators.mjs';
import { resolveViewLimits } from '../../server/views/viewLimits.mjs';
import { VALID_START } from './helpers/endpointRig.mjs';

// Schema, bounds, identity mapping and vector drift of the keeper wire protocol v1 (keeper wire contract delta sections
// 2 to 4 and 7, R1). Unit evidence only; the Rust keeper is held to the same verdicts through the shared vectors.

const limits = resolveKeeperLimits();
const viewLimits = resolveViewLimits();
const endpointLimits = resolveEndpointLimits();
const LAYOUT = { runtimeDir: '/run/robo-work/runtime', cgroupSubtree: '/sys/fs/cgroup/robo-work' };
const id16 = (hex) => Buffer.from(hex, 'hex').toString('base64url');
const KEEPER = id16('00112233445566778899aabbccddeeff');
const TREE = id16('0f1e2d3c4b5a69788796a5b4c3d2e1f0');
const PTY = id16('c0c1c2c3c4c5c6c7c8c9cacbcccdcecf');
const NETNS = id16('b0b1b2b3b4b5b6b7b8b9babbbcbdbebf');
const DASH = id16('fa0102030405060708090a0b0c0d0e0f');
const context = (overrides = {}) => ({
    limits, viewLimits, endpointLimits, keeperReservation: KEEPER, runtimeRoot: LAYOUT.runtimeDir, cgroupSubtree: LAYOUT.cgroupSubtree,
    mount: { scope: 'execution', runtimeRoot: LAYOUT.runtimeDir, reservationId: '1'.repeat(32), grantCount: 1, prior: [] }, ...overrides
});
const locator = (kind, marker = null) => ({ ...deriveLocator(kind, '9'.repeat(32), LAYOUT), keeper: KEEPER, ...(marker ? { marker } : {}) });
const VIOLATION = (code) => ({ ok: false, violation: code });
const OK = { ok: true };

test('cgroup locator confinement verdicts', () => {
    const root = LAYOUT.cgroupSubtree;
    const frame = (parent, overrides = {}) => buildRequest('create', 1, {
        resource: resourceHandle(NETNS), kind: 'cgroup', marker: null,
        locator: { keeper: KEEPER, path: `${parent}/x-${'9'.repeat(32)}` }, spec: {}, ...overrides
    });
    assert.deepEqual(validateKeeperRequest(frame(root), context()), OK);
    for (const parent of ['/sys/fs/cgroup/other', `${root}x`, '/sys/fs/cgroup/robo-wor', `${root}/x-${'9'.repeat(32)}`,
        '/sys/fs/cgroup', `${root}/../robo-work`, `${root}/.`, `${root}/`]) {
        assert.deepEqual(validateKeeperRequest(frame(parent), context()), VIOLATION('bad_frame'), parent);
    }
    for (const cgroupSubtree of [null, undefined]) {
        for (const parent of [root, '/sys/fs/cgroup/other']) {
            assert.deepEqual(validateKeeperRequest(frame(parent), context({ cgroupSubtree })), { ok: false, refused: 'cgroup_not_delegated' });
        }
        assert.deepEqual(validateKeeperRequest(frame(`${root}/..`), context({ cgroupSubtree })), VIOLATION('bad_frame'));
        assert.deepEqual(validateKeeperRequest(frame(root, { spec: { extra: true } }), context({ cgroupSubtree })), VIOLATION('bad_frame'));
    }
});

test('undelegated cgroup create is refused', () => {
    const frame = buildRequest('create', 1, { resource: resourceHandle(NETNS), kind: 'cgroup', marker: null, locator: locator('cgroup'), spec: {} });
    assert.deepEqual(validateKeeperRequest(frame, context({ cgroupSubtree: null })), { ok: false, refused: 'cgroup_not_delegated' });
});

test('all six locators bind to the selected keeper reservation', () => {
    const specs = {
        'runtime-dir': {}, cgroup: {}, netns: {}, pty: { cols: 80, rows: 24 },
        endpoint: { netns: resourceHandle(NETNS), config: { limits: {}, streamDirectory: '/run/streams', relays: [] } },
        'process-tree': { role: 'orchestration', script: '/opt/o/main.mjs', args: [], env: {}, netns: null }
    };
    for (const [kind, spec] of Object.entries(specs)) {
        const marker = ['endpoint', 'process-tree'].includes(kind) ? TREE : null;
        const frame = buildRequest('create', 1, { resource: resourceHandle(TREE), kind, marker, locator: locator(kind, marker), spec });
        assert.deepEqual(validateKeeperRequest(frame, context()), OK, `${kind} matching keeper`);
        assert.deepEqual(validateKeeperRequest({ ...frame, locator: { ...frame.locator, keeper: DASH } }, context()), VIOLATION('bad_frame'), `${kind} foreign keeper`);
        assert.deepEqual(validateKeeperRequest(frame, context({ keeperReservation: undefined })), VIOLATION('bad_frame'), `${kind} no keeper context`);
    }
});

test('lease admission: independent mount slots, per-grant settlement and global channel cap', () => {
    const lease = (id, grantId = 'proj') => buildRequest('view_root_lease', id, { grantId });
    const admission = createKeeperAdmission(limits, viewLimits);
    for (let id = 1; id <= 4; id += 1) assert.deepEqual(admission.admit(buildRequest(id % 2 ? 'mount_view' : 'unmount_view', id)), OK);
    assert.deepEqual(admission.admit(lease(5)), OK, 'lease bypasses four held mounts');
    assert.deepEqual(admission.admit(lease(6)), VIOLATION('lease_in_flight_overflow'));
    admission.settle(5);
    assert.deepEqual(admission.admit(lease(7)), OK, 'settled grant can renew again');
    assert.deepEqual(admission.admit(buildRequest('mount_view', 8)), VIOLATION('mount_in_flight_overflow'));
    for (let id = 9; id <= 19; id += 1) assert.deepEqual(admission.admit(buildRequest('inventory', id)), OK);
    assert.deepEqual(admission.admit(lease(20, 'other')), VIOLATION('in_flight_overflow'));
    assert.deepEqual(admission.admit(lease(21)), VIOLATION('in_flight_overflow'), 'channel check precedes per-grant check');
});

test('cgroup argv bounds preserve room for leaf locators and accept colon paths', () => {
    const args = { marker: KEEPER, parentPid: 1, scope: 'execution', runtimeRoot: '/run/rt', ala: false, grantRoots: 0, channelLimits: {}, viewLimits: {} };
    const base = keeperArgv(args);
    assert.deepEqual(keeperArgv({ ...args, cgroupSubtree: null }), base);
    const bound = { dev: '1', ino: '2', path: '/a:b' };
    assert.deepEqual(keeperArgv({ ...args, cgroupSubtree: bound }), [...base, '--cgroup-subtree', '1:2:/a:b']);
    assert.doesNotThrow(() => keeperArgv({ ...args, cgroupSubtree: { ...bound, path: `/${'a'.repeat(988)}` } }));
    for (const size of [990, 1024, 1025]) assert.throws(() => keeperArgv({ ...args, cgroupSubtree: { ...bound, path: `/${'a'.repeat(size - 1)}` } }), /cgroup subtree/u);
    for (const bad of [{ dev: '18446744073709551616' }, { ino: '18446744073709551616' }, { path: '/a/' }]) {
        assert.throws(() => keeperArgv({ ...args, cgroupSubtree: { ...bound, ...bad } }), /cgroup subtree/u);
    }
});

// ---- limits ----------------------------------------------------------------------------------------------------------

test('keeper limits: provisional defaults resolve, and every relationship of section 2, R1.2 and R1.6 is enforced', () => {
    assert.equal(limits.maxFrameBytes, 655360);
    assert.equal(limits.maxInFlight, 16);
    assert.equal(limits.reservedInFlight, 2);
    assert.equal(limits.ptyInputWindowFrames, 8);
    assert.equal(limits.ptyInputWindowBytes, 65536);
    assert.equal(limits.maxOutboundBytes, 1048576);
    assert.equal(minimumOutboundBytes(limits), 456024, 'the R1.6 arithmetic at the defaults');
    assert.equal(ptyFrameCapBytes(limits), 4 * Math.ceil(16384 / 3) + 512);
    for (const overrides of [
        { maxFrameBytes: 512 * 1024 }, // cannot hold an admitted start request
        { reservedInFlight: 16 },
        { ptyMaxCreditBytes: 1000 },
        { ptyInputWindowBytes: 1000 },
        { ptyInputQueueBytes: 32768 },
        { maxOutboundBytes: 456023 }
    ]) assert.throws(() => resolveKeeperLimits(overrides), /Inconsistent keeper limits/u, JSON.stringify(overrides));
    assert.throws(() => resolveKeeperLimits({ unknownLimit: 1 }), /Unknown limit/u);
    assert.throws(() => resolveKeeperLimits({ pingIntervalMs: 0 }), /positive integer/u);
    assert.throws(() => resolveKeeperLimits({}, { viewLimits: { maxMountFrameBytes: 700000 } }), /maxMountFrameBytes/u);
    assert.equal(resolveKeeperLimits({ maxOutboundBytes: 456024 }).maxOutboundBytes, 456024);
    // RK-1: the keeper receives the 19 contract names and echoes the keeper-side set; pingIntervalMs is client-only.
    assert.deepEqual(KEEPER_CHANNEL_LIMIT_NAMES, ['maxFrameBytes', 'partialFrameDeadlineMs', 'maxInFlight', 'reservedInFlight', 'maxQueuedRequests',
        'helloDeadlineMs', 'requestDeadlineMs', 'createDeadlineMs', 'stopExtraMs', 'keeperExitWaitMs', 'ptyChunkBytes', 'ptyMaxCreditBytes',
        'ptyInputWindowFrames', 'ptyInputWindowBytes', 'ptyInputQueueBytes', 'ptyInputStallMs', 'maxOutboundBytes', 'maxPtysPerKeeper', 'stderrRingBytes']);
    assert.deepEqual(CLIENT_ONLY_LIMIT_NAMES, ['pingIntervalMs']);
    assert.deepEqual([...KEEPER_CHANNEL_LIMIT_NAMES, ...CLIENT_ONLY_LIMIT_NAMES].sort(), Object.keys(KEEPER_LIMIT_DEFAULTS).sort());
    assert.deepEqual(Object.keys(channelLimitsForKeeper(limits)), KEEPER_CHANNEL_LIMIT_NAMES);
    const hello = helloLimits(limits, viewLimits);
    assert.deepEqual(Object.keys(hello), ['maxFrameBytes', 'maxInFlight', 'reservedInFlight', 'partialFrameDeadlineMs', 'ptyChunkBytes', 'ptyMaxCreditBytes',
        'ptyInputWindowFrames', 'ptyInputWindowBytes', 'maxOutboundBytes', 'maxPtysPerKeeper', 'rootLeaseTtlMs']);
    assert.deepEqual(Object.keys(hello).slice(0, -1), HELLO_LIMIT_NAMES);
    assert.equal(Object.hasOwn(hello, 'pingIntervalMs'), false);
});

// ---- events (NC-1a) ----------------------------------------------------------------------------------------------------

test('an unknown event is a violation', () => {
    const verdict = validateKeeperEvent({ event: 'frobnicate' }, { limits });
    assert.deepEqual(verdict, { ok: false, violation: 'unknown_event' });
    assert.deepEqual(validateKeeperEvent({ event: 'lease', state: 'live' }, { limits }), VIOLATION('unknown_event'), 'lease state is not an event in v1');
});

test('events in context: hello first and once, exit once after commit, PTY output in sequence and within credit', () => {
    const handle = resourceHandle(PTY);
    const tree = resourceHandle(TREE);
    const state = { helloSeen: false, resources: new Map([[tree, { kind: 'process-tree', committed: false, exited: false }], [handle, { kind: 'pty', committed: true, pty: { nextSeq: '1', credit: 5, closed: false } }]]) };
    const hello = { event: 'hello', protocol: 'robo-work-keeper', version: 1, pid: 10, startTime: '99', marker: KEEPER, limits: helloLimits(limits, viewLimits) };
    assert.deepEqual(acceptKeeperEvent({ event: 'pty_closed', resource: handle }, state, { limits }), VIOLATION('hello_not_first'));
    assert.deepEqual(acceptKeeperEvent(hello, state, { limits }), OK);
    assert.deepEqual(acceptKeeperEvent(hello, state, { limits }), VIOLATION('duplicate_hello'));
    const exit = { event: 'exit', resource: tree, code: 0, signal: null };
    assert.deepEqual(acceptKeeperEvent(exit, state, { limits }), VIOLATION('unsolicited_exit'), 'no exit before the commit reply');
    state.resources.get(tree).committed = true;
    assert.deepEqual(acceptKeeperEvent(exit, state, { limits }), OK);
    assert.deepEqual(acceptKeeperEvent(exit, state, { limits }), VIOLATION('duplicate_exit'));
    assert.deepEqual(acceptKeeperEvent({ ...exit, resource: resourceHandle(NETNS) }, state, { limits }), VIOLATION('unknown_resource'));
    const out = (seq, text) => ({ event: 'pty_output', resource: handle, seq, data: Buffer.from(text).toString('base64') });
    assert.deepEqual(acceptKeeperEvent(out('2', 'a'), state, { limits }), VIOLATION('sequence_gap'));
    assert.deepEqual(acceptKeeperEvent(out('1', 'abc'), state, { limits }), OK);
    assert.deepEqual(acceptKeeperEvent(out('2', 'abc'), state, { limits }), VIOLATION('credit_overrun'), 'only 2 bytes of credit remain');
    assert.deepEqual(acceptKeeperEvent(out('2', 'ab'), state, { limits }), OK);
    assert.deepEqual(acceptKeeperEvent({ event: 'pty_closed', resource: handle }, state, { limits }), OK);
    assert.deepEqual(acceptKeeperEvent(out('3', ''), state, { limits }), VIOLATION('bad_event'));
    assert.deepEqual(acceptKeeperEvent({ event: 'pty_closed', resource: handle }, state, { limits }), VIOLATION('pty_closed'));
    assert.deepEqual(validateKeeperEvent({ ...hello, fd: 3 }, { limits }), VIOLATION('bad_event'));
    assert.deepEqual(validateKeeperEvent({ ...exit, signal: 'S'.repeat(33) }, { limits }), VIOLATION('bad_event'));
});

test('exit after a commit reply (review F-1, F-2): accepted after ok or failure, refused after refused or no reply', () => {
    const tree = resourceHandle(TREE);
    const exit = { event: 'exit', resource: tree, code: 1, signal: null };
    const fresh = () => ({ helloSeen: true, resources: new Map([[tree, { kind: 'process-tree', committed: false, exited: false }]]) });
    for (const [label, reply, expected] of [
        ['ok', { id: 1, ok: true, value: { state: 'executed' } }, OK],
        ['failure exec_failed', { id: 1, ok: false, kind: 'failure', error: 'exec_failed' }, OK],
        ['failure stream_connect_failed', { id: 1, ok: false, kind: 'failure', error: 'stream_connect_failed' }, OK],
        ['refused gate_closed', { id: 1, ok: false, kind: 'refused', error: 'gate_closed' }, VIOLATION('unsolicited_exit')]
    ]) {
        const state = fresh();
        recordCommitReply(state.resources.get(tree), reply);
        assert.equal(state.resources.get(tree).committed, reply.ok === true || reply.kind === 'failure', `${label}: R2.1 commit_failed is committed`);
        assert.deepEqual(acceptKeeperEvent(exit, state, { limits }), expected, label);
        if (expected.ok) assert.deepEqual(acceptKeeperEvent(exit, state, { limits }), VIOLATION('duplicate_exit'), `${label}: only once`);
    }
    assert.deepEqual(acceptKeeperEvent(exit, fresh(), { limits }), VIOLATION('unsolicited_exit'), 'no reply yet');
    // A refused repeat of a commit does not overwrite the first outcome.
    const state = fresh();
    recordCommitReply(state.resources.get(tree), { id: 1, ok: true, value: { state: 'executed' } });
    recordCommitReply(state.resources.get(tree), { id: 2, ok: false, kind: 'refused', error: 'already_committed' });
    assert.equal(state.resources.get(tree).commitOutcome, 'ok');
    // R2.2: a stop_timeout reply is a well-formed failure; the exit that follows it is still accepted once.
    const stop = buildRequest('stop', 3, { resource: tree, graceMs: 100 });
    assert.deepEqual(validateKeeperReply({ id: 3, ok: false, kind: 'failure', error: 'stop_timeout' }, stop), OK);
    assert.deepEqual(acceptKeeperEvent(exit, state, { limits }), OK);
});

// ---- replies (NC-3a) ---------------------------------------------------------------------------------------------------

test('a reply value with an `fd` key is a violation', () => {
    const create = buildRequest('create', 7, { resource: resourceHandle(NETNS), kind: 'netns', marker: null, locator: locator('netns'), spec: {} });
    const verdict = validateKeeperReply({ id: 7, ok: true, value: { resource: resourceHandle(NETNS), identity: { netNs: '4026532200' }, fd: 5 } }, create);
    assert.deepEqual(verdict, { ok: false, violation: 'bad_reply' });
    // Every other value shape, and every descriptor-naming key (AC-9).
    const cases = [
        [buildRequest('end_process_trees', 8), { fd: 4 }],
        [buildRequest('ping', 9), { handle: 1 }],
        [buildRequest('commit_keeper', 10), { descriptor: 3 }],
        [buildRequest('commit', 11, { resource: resourceHandle(NETNS) }), { state: 'committed', fd: 3 }, { kind: 'netns' }],
        [buildRequest('stop', 12, { resource: resourceHandle(TREE), graceMs: 0 }), { state: 'exited', handle: 'x' }],
        [buildRequest('tempdir', 13), { path: '/tmp/ala-0123456789abcdef', fd: 9 }],
        [buildRequest('pty_input', 14, { resource: resourceHandle(PTY), seq: '1', data: 'YQ==' }), { seq: '1', descriptor: 1 }],
        [create, { resource: resourceHandle(NETNS), identity: { netNs: '4026532200', fd: 3 } }]
    ];
    for (const [request, value, ctx] of cases) {
        assert.deepEqual(validateKeeperReply({ id: request.id, ok: true, value }, request, ctx ?? {}), VIOLATION('bad_reply'), `${request.op} ${JSON.stringify(value)}`);
    }
});

test('replies: exact shapes per op, string identities, error replies only where the op allows them', () => {
    const tree = buildRequest('create', 3, { resource: resourceHandle(TREE), kind: 'process-tree', marker: TREE, locator: locator('process-tree', TREE),
        spec: { role: 'terminal', pty: resourceHandle(PTY), argv: ['bash'], cwd: '/home/robot', netns: null } });
    const identity = { pid: 4242, startTime: '123', pidNs: '4026532001' };
    assert.deepEqual(validateKeeperReply({ id: 3, ok: true, value: { resource: resourceHandle(TREE), identity } }, tree), OK);
    assert.deepEqual(validateKeeperReply({ id: 3, ok: true, value: { resource: resourceHandle(TREE), identity: { ...identity, startTime: 123 } } }, tree), VIOLATION('bad_reply'));
    assert.deepEqual(validateKeeperReply({ id: 3, ok: true, value: { resource: resourceHandle(TREE), identity: { ...identity, pidNs: 4026532001 } } }, tree), VIOLATION('bad_reply'));
    assert.deepEqual(validateKeeperReply({ id: 4, ok: true, value: { resource: resourceHandle(TREE), identity } }, tree), VIOLATION('bad_reply'), 'id mismatch');
    assert.deepEqual(validateKeeperReply({ id: 3, ok: false, kind: 'refused', error: 'duplicate_resource' }, tree), OK);
    assert.deepEqual(validateKeeperReply({ id: 3, ok: false, kind: 'failure', error: 'setup_failed' }, tree), OK);
    assert.deepEqual(validateKeeperReply({ id: 3, ok: false, kind: 'refused', error: 'Bad' }, tree), VIOLATION('bad_reply'));
    assert.deepEqual(validateKeeperReply({ id: 3, ok: false, kind: 'refused', error: { code: 'x', message: 'y' } }, tree), VIOLATION('bad_reply'), 'not the endpoint error shape');
    for (const op of ['commit_keeper', 'ping', 'end_process_trees', 'remove_runtime', 'shutdown', 'inventory']) {
        assert.deepEqual(validateKeeperReply({ id: 1, ok: false, kind: 'refused', error: 'no' }, buildRequest(op, 1)), VIOLATION('bad_reply'), op);
    }
    const commit = buildRequest('commit', 5, { resource: resourceHandle(TREE) });
    assert.deepEqual(validateKeeperReply({ id: 5, ok: true, value: { state: 'executed' } }, commit, { kind: 'process-tree' }), OK);
    assert.deepEqual(validateKeeperReply({ id: 5, ok: true, value: { state: 'committed' } }, commit, { kind: 'process-tree' }), VIOLATION('bad_reply'));
    assert.deepEqual(validateKeeperReply({ id: 5, ok: true, value: { state: 'committed' } }, commit, { kind: 'pty' }), OK);
    const input = buildRequest('pty_input', 6, { resource: resourceHandle(PTY), seq: '9', data: 'YQ==' });
    assert.deepEqual(validateKeeperReply({ id: 6, ok: true, value: { seq: '9' } }, input), OK);
    assert.deepEqual(validateKeeperReply({ id: 6, ok: true, value: { seq: '10' } }, input), VIOLATION('bad_reply'));
});

// ---- requests (AC-9 and the boundary probes) ---------------------------------------------------------------------------

test('requests: every op has an exact key set, an unknown op is a violation, and descriptor-naming keys are refused', () => {
    assert.deepEqual(validateKeeperRequest(buildRequest('frobnicate', 1), context()), VIOLATION('unknown_op'));
    assert.ok(KEEPER_OPS.includes('ping') && PRIORITY_OPS.includes('ping'), 'ping is a v1 op and may use a reserved slot (N-B)');
    assert.ok(!PRIORITY_OPS.includes('pty_input') && !PRIORITY_OPS.includes('create'));
    const valid = {
        commit_keeper: buildRequest('commit_keeper', 1),
        ping: buildRequest('ping', 1),
        tempdir: buildRequest('tempdir', 1),
        commit: buildRequest('commit', 1, { resource: resourceHandle(TREE) }),
        stop: buildRequest('stop', 1, { resource: resourceHandle(TREE), graceMs: 0 }),
        abort_uncommitted: buildRequest('abort_uncommitted', 1, { resources: [resourceHandle(TREE)] }),
        pty_input: buildRequest('pty_input', 1, { resource: resourceHandle(PTY), seq: '1', data: 'YQ==' }),
        pty_resize: buildRequest('pty_resize', 1, { resource: resourceHandle(PTY), cols: 1, rows: 65535 }),
        pty_credit: buildRequest('pty_credit', 1, { resource: resourceHandle(PTY), bytes: 1 }),
        create: buildRequest('create', 1, { resource: resourceHandle(NETNS), kind: 'netns', marker: null, locator: locator('netns'), spec: {} })
    };
    for (const op of ['end_process_trees', 'end_endpoint', 'release_egress', 'release_views', 'remove_runtime', 'shutdown', 'inventory']) valid[op] = buildRequest(op, 1);
    for (const [op, frame] of Object.entries(valid)) {
        assert.deepEqual(validateKeeperRequest(frame, context()), OK, op);
        for (const key of ['fd', 'handle', 'descriptor', 'slot']) {
            assert.deepEqual(validateKeeperRequest({ ...frame, [key]: 3 }, context()), VIOLATION('bad_frame'), `${op} + ${key}`);
        }
    }
    assert.deepEqual(validateKeeperRequest({ ...valid.create, spec: { fd: 3 } }, context()), VIOLATION('bad_frame'), 'a nested spec key');
    assert.deepEqual(validateKeeperRequest({ ...valid.create, locator: { ...locator('netns'), fd: 3 } }, context()), VIOLATION('bad_frame'), 'a nested locator key');
});

test('boundary probes: ids, handles, markers, pty sizes, sequence numbers and an astral environment value', () => {
    assert.deepEqual(validateKeeperRequest(buildRequest('ping', 1_000_000_000), context()), OK);
    assert.deepEqual(validateKeeperRequest(buildRequest('ping', 1_000_000_001), context()), VIOLATION('bad_frame'));
    assert.deepEqual(validateKeeperRequest(buildRequest('ping', 0), context()), VIOLATION('bad_frame'));
    for (const resource of ['a'.repeat(31), 'a'.repeat(33), 'A'.repeat(32), `m${'a'.repeat(31)}`]) {
        assert.deepEqual(validateKeeperRequest(buildRequest('commit', 1, { resource }), context()), VIOLATION('bad_frame'), resource);
    }
    // A resource id that starts with '-' maps to a plain hex handle and stays a separate argv element.
    assert.equal(DASH[0], '-');
    assert.equal(resourceHandle(DASH), 'fa0102030405060708090a0b0c0d0e0f');
    const argv = keeperArgv({ marker: DASH, parentPid: 1, scope: 'execution', runtimeRoot: LAYOUT.runtimeDir, ala: false, grantRoots: 0, channelLimits: channelLimitsForKeeper(limits), viewLimits });
    assert.equal(argv[argv.indexOf('--reservation') + 1], DASH);
    assert.ok(!argv.some((value) => value.startsWith('--reservation=')));
    assert.throws(() => resourceHandle('AAAAAAAAAAAAAAAAAAAAAB'), /canonical/u, 'a non-canonical 22-character id');
    const pty = (cols, rows) => buildRequest('create', 1, { resource: resourceHandle(PTY), kind: 'pty', marker: null, locator: locator('pty'), spec: { cols, rows } });
    assert.deepEqual(validateKeeperRequest(pty(1, 65535), context()), OK);
    assert.deepEqual(validateKeeperRequest(pty(0, 24), context()), VIOLATION('bad_frame'));
    assert.deepEqual(validateKeeperRequest(pty(65536, 24), context()), VIOLATION('bad_frame'));
    const input = (bytes, seq = '1') => buildRequest('pty_input', 1, { resource: resourceHandle(PTY), seq, data: Buffer.alloc(bytes, 0x61).toString('base64') });
    assert.deepEqual(validateKeeperRequest(input(limits.ptyChunkBytes), context()), OK);
    assert.deepEqual(validateKeeperRequest(input(limits.ptyChunkBytes + 1), context()), VIOLATION('bad_frame'));
    assert.deepEqual(validateKeeperRequest(input(0), context()), VIOLATION('bad_frame'));
    for (const seq of ['0', '01', '18446744073709551616', '-1', '1.0']) assert.deepEqual(validateKeeperRequest(input(1, seq), context()), VIOLATION('bad_frame'), seq);
    assert.equal(isCanonicalSeq('18446744073709551615'), true);
    assert.equal(decodeCanonicalBase64('YQ', 4), null, 'unpadded');
    assert.equal(decodeCanonicalBase64('YR==', 4), null, 'non-canonical trailing bits');
    // A workload environment value of exactly maxEnvValueBytes in astral characters fits; one byte more does not.
    const workload = (value) => buildRequest('create', 1, { resource: resourceHandle(TREE), kind: 'process-tree', marker: TREE, locator: locator('process-tree', TREE),
        spec: { role: 'workload', process: 1, request: { ...VALID_START, env: { IS_SANDBOX: value } }, streams: { stdout: '/run/s/a' }, netns: resourceHandle(NETNS) } });
    const astral = '\u{1F600}'.repeat(endpointLimits.maxEnvValueBytes / 4);
    assert.equal(Buffer.byteLength(astral), endpointLimits.maxEnvValueBytes);
    assert.deepEqual(validateKeeperRequest(workload(astral), context()), OK);
    assert.deepEqual(validateKeeperRequest(workload(`${astral}x`), context()), VIOLATION('bad_frame'));
});

test('frame bounds: a frame of exactly maxFrameBytes decodes, one byte more and a zero length are violations', () => {
    const decode = (bytes) => {
        const seen = { frames: [], violations: [] };
        const decoder = createFrameDecoder({ maxFrameBytes: limits.maxFrameBytes, partialFrameDeadlineMs: 1000, onFrame: (f) => seen.frames.push(f), onViolation: (c) => seen.violations.push(c) });
        decoder.push(bytes);
        decoder.close();
        return seen;
    };
    const padded = (payloadBytes) => {
        const skeleton = Buffer.byteLength(JSON.stringify({ id: 1, op: 'ping', pad: '' }));
        return { id: 1, op: 'ping', pad: 'x'.repeat(payloadBytes - skeleton) };
    };
    assert.deepEqual(decode(encodeFrame(padded(limits.maxFrameBytes), { maxFrameBytes: limits.maxFrameBytes })).frames.length, 1);
    const over = Buffer.alloc(4);
    over.writeUInt32BE(limits.maxFrameBytes + 1, 0);
    assert.deepEqual(decode(over).violations, ['oversize_frame']);
    assert.deepEqual(decode(Buffer.alloc(4)).violations, ['empty_frame']);
    assert.throws(() => encodeFrame(padded(limits.maxFrameBytes + 1), { maxFrameBytes: limits.maxFrameBytes }), RangeError);
});

test('mount frames are validated in two stages: an extra key is a violation, frozen codes are refusals in snake case (R1.5 M-1)', () => {
    const mountpoint = `${LAYOUT.runtimeDir}/x/${'1'.repeat(32)}/views/proj`;
    const mount = buildRequest('mount_view', 1, {
        grantId: 'proj', rootSlot: 8, expectedRootIdentity: { dev: '1', ino: '2' }, access: 'write', mountpoint, propagation: 'private', allowOther: true,
        descriptorCap: 1024, rlimitNofile: 4096, rootLease: { epoch: 1, ttlMs: 1000 }
    });
    assert.deepEqual(validateKeeperRequest(mount, context()), OK);
    assert.deepEqual(validateKeeperRequest({ ...mount, source: '/etc' }, context()), VIOLATION('bad_frame'), 'never source_path_not_allowed on the wire');
    assert.deepEqual(validateKeeperRequest({ ...mount, rootSlot: '8' }, context()), VIOLATION('bad_frame'), 'stage 1 types');
    assert.deepEqual(validateKeeperRequest({ ...mount, propagation: 'shared' }, context()), { ok: false, refused: 'propagation_not_private' });
    assert.deepEqual(validateKeeperRequest({ ...mount, rootSlot: 9 }, context()), { ok: false, refused: 'root_slot_out_of_range' });
    const second = { ...mount, id: 2 };
    assert.deepEqual(validateKeeperRequest(second, context({ mount: { ...context().mount, grantCount: 2, prior: [mount] } })), { ok: false, refused: 'duplicate_grant_id' });
    assert.equal(wireCode('duplicate_grantId'), 'duplicate_grant_id');
    assert.equal(wireCode('duplicate_rootSlot'), 'duplicate_root_slot');
    assert.equal(wireCode('duplicate_grant_id'), 'duplicate_grant_id', 'idempotent for codes that are already snake case');
    const lease = buildRequest('view_root_lease', 3, { grantId: 'proj', epoch: 2, verdict: 'renew', ttlMs: viewLimits.rootLeaseTtlMs + 1 });
    assert.deepEqual(validateKeeperRequest(lease, context()), { ok: false, refused: 'bad_ttl' });
    assert.deepEqual(validateKeeperRequest({ ...lease, ttlMs: 10, extra: 1 }, context()), VIOLATION('bad_frame'));
    assert.deepEqual(validateKeeperRequest(buildRequest('unmount_view', 4, { resource: resourceHandle(TREE) }), context()), VIOLATION('bad_frame'), 'a supervisor handle cannot be unmounted');
});

test('a create of a kind v1 does not create is refused, and a malformed kind is a violation', () => {
    const create = (kind) => buildRequest('create', 1, { resource: resourceHandle(NETNS), kind, marker: null, locator: locator('netns'), spec: {} });
    for (const kind of ['veth', 'nft-table', 'gui-view', 'gui-container', 'keeper', 'mount']) assert.deepEqual(validateKeeperRequest(create(kind), context()), { ok: false, refused: 'kind_not_supported' }, kind);
    assert.deepEqual(validateKeeperRequest(create('frob'), context()), VIOLATION('bad_frame'));
    assert.deepEqual(validateKeeperRequest({ ...create('netns'), marker: NETNS }, context()), VIOLATION('bad_frame'), 'a non-process kind carries no marker');
    const runtime = buildRequest('create', 1, { resource: resourceHandle(NETNS), kind: 'runtime-dir', marker: null, locator: { ...locator('runtime-dir'), path: `/elsewhere/x/${'9'.repeat(32)}` }, spec: {} });
    assert.deepEqual(validateKeeperRequest(runtime, context()), VIOLATION('bad_frame'), 'outside --runtime-root');
});

// ---- identities ------------------------------------------------------------------------------------------------------

test('toLedgerIdentity keeps start times and inodes as decimal strings and pids and mount IDs as integers', () => {
    assert.deepEqual(toLedgerIdentity('keeper', { pid: 7, startTime: '11' }), { pid: 7, startTime: '11' });
    assert.deepEqual(toLedgerIdentity('process-tree', { pid: 8, startTime: '12', pidNs: '13' }), { pid: 8, startTime: '12', pidNs: '13' });
    assert.deepEqual(toLedgerIdentity('netns', { netNs: '14' }), { netNs: '14' });
    assert.deepEqual(toLedgerIdentity('pty', { pty: 'a'.repeat(32), devptsDev: '15', index: 0 }), { pty: 'a'.repeat(32), devptsDev: '15', index: 0 });
    const mount = toLedgerIdentity('mount', {
        resource: `m${'b'.repeat(32)}`, mount: { mountId: 600, mountpoint: '/v', mountNamespaceInode: '16' }, fileServer: { pid: 9, startTime: '17', pidNamespaceInode: '18' }
    });
    assert.deepEqual(mount, { resource: `m${'b'.repeat(32)}`, mountId: 600, mountpoint: '/v', mntNs: '16', fileServer: { pid: 9, startTime: '17', pidNs: '18' } });
    assert.equal(typeof mount.mountId, 'number');
    assert.throws(() => toLedgerIdentity('process-tree', { pid: 8, startTime: 12, pidNs: '13' }), TypeError);
    assert.throws(() => toLedgerIdentity('keeper', { pid: 8, startTime: '12', pidNs: '13' }), TypeError, 'no pidNs for the keeper');
    assert.throws(() => toLedgerIdentity('veth', { index: 1 }), TypeError);
});

// ---- keeper-side admission (N-A) --------------------------------------------------------------------------------------

test('keeper admission: 16 ordinary requests plus 8 pty_input chunks never overflow; a 9th chunk, a 17th request or window bytes beyond the bound do', () => {
    const input = (id, bytes = 1) => buildRequest('pty_input', id, { resource: resourceHandle(PTY), seq: String(id), data: Buffer.alloc(bytes, 1).toString('base64') });
    const admission = createKeeperAdmission(limits);
    let id = 0;
    for (let index = 0; index < 16; index += 1) assert.deepEqual(admission.admit(buildRequest('inventory', ++id)), OK);
    for (let index = 0; index < 8; index += 1) assert.deepEqual(admission.admit(input(++id)), OK);
    assert.deepEqual(admission.admit(input(++id)), VIOLATION('pty_input_window'));
    const second = createKeeperAdmission(limits);
    for (let index = 1; index <= 16; index += 1) second.admit(buildRequest('inventory', index));
    assert.deepEqual(second.admit(buildRequest('inventory', 17)), VIOLATION('in_flight_overflow'));
    second.settle(1);
    assert.deepEqual(second.admit(buildRequest('inventory', 18)), OK, 'a settled request frees its slot');
    const bytes = createKeeperAdmission(limits);
    for (let index = 1; index <= 4; index += 1) assert.deepEqual(bytes.admit(input(index, limits.ptyChunkBytes)), OK);
    assert.deepEqual(bytes.admit(input(5, 1)), VIOLATION('pty_input_window'), '65536 raw bytes outstanding');
    // R2.3: mount ops are bounded among themselves by maxMountInFlight (4), on top of the channel bound.
    const mounts = createKeeperAdmission(limits, viewLimits);
    for (let index = 1; index <= 4; index += 1) assert.deepEqual(mounts.admit(buildRequest('mount_view', index)), OK);
    assert.deepEqual(mounts.admit(buildRequest('inventory', 5)), OK, 'a non-mount op is not bounded by it');
    assert.deepEqual(mounts.admit(buildRequest('unmount_view', 6)), VIOLATION('mount_in_flight_overflow'));
    const mounts2 = createKeeperAdmission(limits, viewLimits);
    for (let index = 1; index <= 4; index += 1) mounts2.admit(buildRequest('mount_view', index));
    mounts2.settle(2);
    assert.deepEqual(mounts2.admit(buildRequest('unmount_view', 5)), OK, 'a settled mount op frees its slot');
    const ids = createKeeperAdmission(limits);
    ids.admit(buildRequest('ping', 5));
    assert.deepEqual(ids.admit(buildRequest('ping', 5)), VIOLATION('duplicate_id'));
});

// ---- vectors (AC-3, M-4) ----------------------------------------------------------------------------------------------

const generator = fileURLToPath(new URL('./vectors/generate-keeper-wire-vectors.mjs', import.meta.url));
const vectorFile = fileURLToPath(new URL('./vectors/keeper-wire.v1.json', import.meta.url));

test('the shared vectors match the production schema byte for byte, and a one-byte edit fails the check', (t) => {
    const ok = spawnSync(process.execPath, [generator, '--check'], { encoding: 'utf8' });
    assert.equal(ok.status, 0, ok.stderr);
    const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'rwv-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const copy = path.join(dir, 'edited.json');
    const bytes = fs.readFileSync(vectorFile);
    const at = bytes.indexOf(Buffer.from('"robo-work-keeper"')) + 1;
    bytes[at] = bytes[at] === 0x72 ? 0x52 : 0x72;
    fs.writeFileSync(copy, bytes);
    const edited = spawnSync(process.execPath, [generator, '--check', '--against', copy], { encoding: 'utf8' });
    assert.notEqual(edited.status, 0);
    assert.match(edited.stderr, /differs from the production schema/u);
});

test('the shared vectors are deterministic: no Node version, no absolute path, and a repository-relative generatedBy', () => {
    const text = fs.readFileSync(vectorFile, 'utf8');
    const vectors = JSON.parse(text);
    assert.equal(vectors.schema, 'robo-work.keeper-wire/1');
    assert.equal(vectors.generatedBy, 'robo-work/tests/execution/vectors/generate-keeper-wire-vectors.mjs');
    assert.equal(Object.hasOwn(vectors, 'node'), false);
    assert.ok(!text.includes(process.version), 'no Node version');
    const checkout = path.resolve(path.dirname(vectorFile), '../../../..');
    assert.ok(!text.includes(checkout) && !text.includes(fs.realpathSync(checkout)), 'no path of this checkout');
    assert.ok(vectors.requests.some((entry) => entry.frame?.op === 'ping'), 'ping is in the vectors (N-B schema addition)');
    assert.ok(vectors.admission.length >= 5, 'in-flight accounting is in the vectors (N-A)');
    assert.deepEqual(vectors.limits.helloKeys, [...HELLO_LIMIT_NAMES, 'rootLeaseTtlMs'], 'the exact hello.limits key set is pinned (RK-1)');
    assert.deepEqual(vectors.limits.channelLimitNames, KEEPER_CHANNEL_LIMIT_NAMES);
    assert.deepEqual(vectors.limits.clientOnly, ['pingIntervalMs']);
    assert.ok(vectors.argv.every((entry) => !entry.argv.some((value) => value.startsWith('pingIntervalMs='))));
    assert.deepEqual(vectors.stopSequences.map((entry) => entry.verdicts), [['ok', 'ok'], ['ok', 'ok'], ['ok', 'ok', { violation: 'duplicate_exit' }]], 'R2.2 cases');
    assert.ok(vectors.admission.some((entry) => entry.steps.some((step) => step.verdict?.violation === 'mount_in_flight_overflow')), 'R2.3 case');
    for (const section of ['encode', 'requests', 'replies', 'events', 'commitSequences', 'stopSequences', 'identities', 'markers', 'procStat', 'base64', 'sequences']) assert.ok(vectors[section].length > 0, section);
    assert.deepEqual(vectors.commitSequences.map((entry) => entry.verdicts), [['ok', 'ok'], ['ok', 'ok'], ['ok', { violation: 'unsolicited_exit' }]], 'review F-1/F-2 cases');
    assert.ok(vectors.markers.some((entry) => entry.resourceId.startsWith('-')) && vectors.markers.some((entry) => entry.resourceId.includes('_')));
});
