// Generates the shared golden vectors of the keeper wire protocol v1 (keeper wire contract delta section 7, R1.5 M-4)
// from the PRODUCTION modules: keeperFrames.mjs, keeperLimits.mjs and procView.mjs (stat parsing). Every verdict,
// identity and byte string in the file is computed by those modules from fixed inputs, so the output is deterministic:
// it holds no Node version, host name, time or absolute path. The generating Node version and platform go to the
// uncompared sidecar keeper-wire.v1.provenance.json.
//
//   node robo-work/tests/execution/vectors/generate-keeper-wire-vectors.mjs           writes both files
//   node robo-work/tests/execution/vectors/generate-keeper-wire-vectors.mjs --check   regenerates in memory and
//        byte-compares keeper-wire.v1.json (or the file after --against <path>); exits 1 on any difference
//
// The native owner copies keeper-wire.v1.json byte-identically to native/crates/proto/tests/vectors/ and never edits it.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { ENDPOINT_LIMIT_DEFAULTS, resolveEndpointLimits } from '../../../server/execution/executionLimits.mjs';
import {
    KEEPER_OPS, KEEPER_PROTOCOL, KEEPER_PROTOCOL_VERSION, MOUNT_OPS, PRIORITY_OPS, acceptKeeperEvent, buildRequest, createKeeperAdmission,
    decodeCanonicalBase64, encodeKeeperFrame, isCanonicalSeq, keeperArgv, recordCommitReply, resourceHandle, toLedgerIdentity, validateKeeperReply,
    validateKeeperRequest, wireCode
} from '../../../server/execution/keeperFrames.mjs';
import {
    CLIENT_ONLY_LIMIT_NAMES, HELLO_LIMIT_NAMES, KEEPER_CHANNEL_LIMIT_NAMES, channelLimitsForKeeper, helloLimits, minimumOutboundBytes, ptyFrameCapBytes,
    resolveKeeperLimits
} from '../../../server/execution/keeperLimits.mjs';
import { parseStatLine } from '../../../server/execution/procView.mjs';
import { deriveLocator } from '../../../server/execution/resourceLocators.mjs';
import { resolveViewLimits } from '../../../server/views/viewLimits.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const VECTOR_FILE = path.join(HERE, 'keeper-wire.v1.json');
export const PROVENANCE_FILE = path.join(HERE, 'keeper-wire.v1.provenance.json');
const GENERATED_BY = 'robo-work/tests/execution/vectors/generate-keeper-wire-vectors.mjs';

// ---- fixed inputs -----------------------------------------------------------------------------------------------------

const id16 = (hex) => Buffer.from(hex, 'hex').toString('base64url');
const KEEPER_ID = id16('00112233445566778899aabbccddeeff');
const DASH_ID = id16('fa0102030405060708090a0b0c0d0e0f');
const UNDERSCORE_ID = id16('ffff0102030405060708090a0b0c0d0e');
const TREE_ID = id16('0f1e2d3c4b5a69788796a5b4c3d2e1f0');
const ENDPOINT_ID = id16('a0a1a2a3a4a5a6a7a8a9aaabacadaeaf');
const NETNS_ID = id16('b0b1b2b3b4b5b6b7b8b9babbbcbdbebf');
const PTY_ID = id16('c0c1c2c3c4c5c6c7c8c9cacbcccdcecf');
const RUNTIME_ID = id16('d0d1d2d3d4d5d6d7d8d9dadbdcdddedf');
const CGROUP_ID = id16('e0e1e2e3e4e5e6e7e8e9eaebecedeeef');
const LAYOUT = Object.freeze({ runtimeDir: '/run/robo-work/runtime', cgroupSubtree: '/sys/fs/cgroup/robo-work' });
const LOCATOR = Object.freeze({
    runtime: '11111111111111111111111111111111', cgroup: '22222222222222222222222222222222', netns: '33333333333333333333333333333333',
    pty: '44444444444444444444444444444444', endpoint: '55555555555555555555555555555555', tree: '66666666666666666666666666666666'
});
const MOUNT_HANDLE = `m${'7'.repeat(32)}`;
const GRANT_ID = 'proj';

const limits = resolveKeeperLimits();
const viewLimits = resolveViewLimits();
const endpointLimits = resolveEndpointLimits();
const handle = resourceHandle;
const locatorFor = (kind, locatorId, marker = null) => ({
    ...deriveLocator(kind, locatorId, LAYOUT), keeper: KEEPER_ID, ...(marker === null ? {} : { marker })
});
const LOC = {
    runtime: locatorFor('runtime-dir', LOCATOR.runtime),
    cgroup: locatorFor('cgroup', LOCATOR.cgroup),
    netns: locatorFor('netns', LOCATOR.netns),
    pty: locatorFor('pty', LOCATOR.pty),
    endpoint: locatorFor('endpoint', LOCATOR.endpoint, ENDPOINT_ID),
    tree: locatorFor('process-tree', LOCATOR.tree, TREE_ID)
};
const MOUNTPOINT = `${LAYOUT.runtimeDir}/x/${LOCATOR.runtime}/views/${GRANT_ID}`;
const REQUEST_CONTEXT = Object.freeze({
    keeperReservation: KEEPER_ID,
    runtimeRoot: LAYOUT.runtimeDir, cgroupSubtree: LAYOUT.cgroupSubtree, orchestrationRoot: '/opt/robo-work/orchestration',
    mount: { scope: 'execution', runtimeRoot: LAYOUT.runtimeDir, reservationId: LOCATOR.runtime, grantCount: 2, prior: [] }
});
const fullContext = (overrides = {}) => ({ limits, viewLimits, endpointLimits, ...REQUEST_CONTEXT, ...overrides });

function startRequest(overrides = {}) {
    return {
        processClass: 'run', executable: 'codex', args: ['exec', 'hello'], env: { IS_SANDBOX: '1' }, home: '/home/robot', cwd: '/projects/g',
        folders: [{ path: '/projects/g', access: 'read' }], exclusions: [], communication: { kind: 'streams', stdin: 'ignore' },
        lifecycle: { stopGraceMs: 2000 }, network: 'robot-egress', requirements: { privateProc: true }, ...overrides
    };
}

const mountView = (id, overrides = {}) => buildRequest('mount_view', id, {
    grantId: GRANT_ID, rootSlot: 8, expectedRootIdentity: { dev: '2049', ino: '131074' }, access: 'write', mountpoint: MOUNTPOINT,
    propagation: 'private', allowOther: true, descriptorCap: 1024, rlimitNofile: 4096, rootLease: { epoch: 1, ttlMs: viewLimits.rootLeaseTtlMs },
    ...overrides
});
const create = (id, kind, resourceId, marker, locator, spec) => buildRequest('create', id, { resource: handle(resourceId), kind, marker, locator, spec });
const pty64 = (bytes) => Buffer.alloc(bytes, 0x61).toString('base64');

// ---- requests ---------------------------------------------------------------------------------------------------------

function requestCases() {
    const w = startRequest();
    const cases = [
        ['commit_keeper', buildRequest('commit_keeper', 1)],
        ['ping', buildRequest('ping', 2)],
        ['ping with an extra key', { ...buildRequest('ping', 2), fd: 3 }],
        ['create runtime-dir', create(3, 'runtime-dir', RUNTIME_ID, null, LOC.runtime, {})],
        ['create runtime-dir outside the runtime root', create(3, 'runtime-dir', RUNTIME_ID, null, { ...LOC.runtime, path: `/tmp/x/${LOCATOR.runtime}` }, {})],
        ['create cgroup', create(4, 'cgroup', CGROUP_ID, null, LOC.cgroup, {})],
        ...[
            ['create cgroup outside the subtree', '/sys/fs/cgroup/other'],
            ['create cgroup string-prefix sibling (longer)', `${LAYOUT.cgroupSubtree}x`],
            ['create cgroup string-prefix sibling (shorter)', '/sys/fs/cgroup/robo-wor'],
            ['create cgroup nested under a child', `${LAYOUT.cgroupSubtree}/x-${LOCATOR.cgroup}`],
            ['create cgroup in the subtree parent', '/sys/fs/cgroup'],
            ['create cgroup with a dot-dot segment', `${LAYOUT.cgroupSubtree}/../robo-work`],
            ['create cgroup with a dot segment', `${LAYOUT.cgroupSubtree}/.`],
            ['create cgroup with an empty segment', `${LAYOUT.cgroupSubtree}/`]
        ].map(([name, parent]) => [name, create(4, 'cgroup', CGROUP_ID, null, { ...LOC.cgroup, path: `${parent}/x-${LOCATOR.cgroup}` }, {})]),
        ['create cgroup undelegated', create(4, 'cgroup', CGROUP_ID, null, LOC.cgroup, {}), { cgroupSubtree: null }],
        ['create cgroup undelegated outside any subtree', create(4, 'cgroup', CGROUP_ID, null, { ...LOC.cgroup, path: `/sys/fs/cgroup/other/x-${LOCATOR.cgroup}` }, {}), { cgroupSubtree: null }],
        ['create cgroup undelegated malformed', create(4, 'cgroup', CGROUP_ID, null, { ...LOC.cgroup, path: `${LAYOUT.cgroupSubtree}/../x-${LOCATOR.cgroup}` }, {}), { cgroupSubtree: null }],
        ['create cgroup bound to another keeper', create(4, 'cgroup', CGROUP_ID, null, { ...LOC.cgroup, keeper: TREE_ID }, {})],
        ['create netns', create(5, 'netns', NETNS_ID, null, LOC.netns, {})],
        ['create pty', create(6, 'pty', PTY_ID, null, LOC.pty, { cols: 80, rows: 24 })],
        ['create pty cols 0', create(6, 'pty', PTY_ID, null, LOC.pty, { cols: 0, rows: 24 })],
        ['create pty cols 65536', create(6, 'pty', PTY_ID, null, LOC.pty, { cols: 65536, rows: 24 })],
        ['create endpoint', create(7, 'endpoint', ENDPOINT_ID, ENDPOINT_ID, LOC.endpoint, {
            netns: handle(NETNS_ID), config: { limits: { maxProcesses: 8 }, streamDirectory: '/run/endpoint/streams', relays: [{ port: 7777, target: '/run/mcp.sock' }] }
        })],
        ['create workload', create(8, 'process-tree', TREE_ID, TREE_ID, LOC.tree, {
            role: 'workload', process: 1, request: w, streams: { stdout: '/run/endpoint/streams/a' }, netns: handle(NETNS_ID)
        })],
        ['create workload with astral env at maxEnvValueBytes', create(8, 'process-tree', TREE_ID, TREE_ID, LOC.tree, {
            role: 'workload', process: 1, request: startRequest({ env: { IS_SANDBOX: '\u{1F600}'.repeat(endpointLimits.maxEnvValueBytes / 4) } }),
            streams: { stdout: '/run/endpoint/streams/a' }, netns: handle(NETNS_ID)
        })],
        ['create workload with an env value one byte over', create(8, 'process-tree', TREE_ID, TREE_ID, LOC.tree, {
            role: 'workload', process: 1, request: startRequest({ env: { IS_SANDBOX: `${'\u{1F600}'.repeat(endpointLimits.maxEnvValueBytes / 4)}x` } }),
            streams: { stdout: '/run/endpoint/streams/a' }, netns: handle(NETNS_ID)
        })],
        ['create orchestration', create(9, 'process-tree', TREE_ID, TREE_ID, LOC.tree, {
            role: 'orchestration', script: '/opt/robo-work/orchestration/main.mjs', args: ['--x'], env: { HOME: '/home/robot' }, netns: null
        })],
        ['create orchestration script outside the root', create(9, 'process-tree', TREE_ID, TREE_ID, LOC.tree, {
            role: 'orchestration', script: '/tmp/main.mjs', args: [], env: {}, netns: null
        })],
        ['create terminal', create(10, 'process-tree', TREE_ID, TREE_ID, LOC.tree, { role: 'terminal', pty: handle(PTY_ID), argv: ['bash', '-l'], cwd: '/home/robot', netns: null })],
        ['create with a marker for a non-process kind', create(11, 'netns', NETNS_ID, NETNS_ID, LOC.netns, {})],
        ['create veth (not supported in v1)', create(12, 'veth', NETNS_ID, null, { host: 'rwaaaaaaaaaah', peer: 'rwaaaaaaaaaan', keeper: KEEPER_ID }, {})],
        ['create unknown kind', create(12, 'frob', NETNS_ID, null, LOC.netns, {})],
        ['create with a 31-hex handle', { ...create(13, 'netns', NETNS_ID, null, LOC.netns, {}), resource: 'a'.repeat(31) }],
        ['create with a 33-hex handle', { ...create(13, 'netns', NETNS_ID, null, LOC.netns, {}), resource: 'a'.repeat(33) }],
        ['create with an extra key handle', { ...create(13, 'netns', NETNS_ID, null, LOC.netns, {}), handle: 1 }],
        ['commit', buildRequest('commit', 14, { resource: handle(TREE_ID) })],
        ['commit of a mount handle', buildRequest('commit', 14, { resource: MOUNT_HANDLE })],
        ['abort_uncommitted', buildRequest('abort_uncommitted', 15, { resources: [handle(TREE_ID), MOUNT_HANDLE] })],
        ['abort_uncommitted empty', buildRequest('abort_uncommitted', 15, { resources: [] })],
        ['abort_uncommitted 65 handles', buildRequest('abort_uncommitted', 15, { resources: Array.from({ length: 65 }, (_, i) => i.toString(16).padStart(32, '0')) })],
        ['stop', buildRequest('stop', 16, { resource: handle(TREE_ID), graceMs: 2000 })],
        ['stop grace over the bound', buildRequest('stop', 16, { resource: handle(TREE_ID), graceMs: 3_600_001 })],
        ['tempdir', buildRequest('tempdir', 17)],
        ...['end_process_trees', 'end_endpoint', 'release_egress', 'release_views', 'remove_runtime', 'shutdown', 'inventory'].map((op, index) => [op, buildRequest(op, 18 + index)]),
        ['pty_input', buildRequest('pty_input', 30, { resource: handle(PTY_ID), seq: '1', data: pty64(3) })],
        ['pty_input of ptyChunkBytes', buildRequest('pty_input', 30, { resource: handle(PTY_ID), seq: '1', data: pty64(limits.ptyChunkBytes) })],
        ['pty_input of ptyChunkBytes + 1', buildRequest('pty_input', 30, { resource: handle(PTY_ID), seq: '1', data: pty64(limits.ptyChunkBytes + 1) })],
        ['pty_input of 0 bytes', buildRequest('pty_input', 30, { resource: handle(PTY_ID), seq: '1', data: '' })],
        ['pty_input seq 0', buildRequest('pty_input', 30, { resource: handle(PTY_ID), seq: '0', data: pty64(1) })],
        ['pty_input seq 01', buildRequest('pty_input', 30, { resource: handle(PTY_ID), seq: '01', data: pty64(1) })],
        ['pty_input seq 2^64', buildRequest('pty_input', 30, { resource: handle(PTY_ID), seq: '18446744073709551616', data: pty64(1) })],
        ['pty_input seq 2^64 - 1', buildRequest('pty_input', 30, { resource: handle(PTY_ID), seq: '18446744073709551615', data: pty64(1) })],
        ['pty_input unpadded base64', buildRequest('pty_input', 30, { resource: handle(PTY_ID), seq: '1', data: 'YQ' })],
        ['pty_resize', buildRequest('pty_resize', 31, { resource: handle(PTY_ID), cols: 65535, rows: 1 })],
        ['pty_resize rows 0', buildRequest('pty_resize', 31, { resource: handle(PTY_ID), cols: 80, rows: 0 })],
        ['pty_credit', buildRequest('pty_credit', 32, { resource: handle(PTY_ID), bytes: limits.ptyMaxCreditBytes })],
        ['pty_credit over the maximum', buildRequest('pty_credit', 32, { resource: handle(PTY_ID), bytes: limits.ptyMaxCreditBytes + 1 })],
        ['mount_view', mountView(33)],
        ['mount_view with a source path key', { ...mountView(33), source: '/etc' }],
        ['mount_view mountpoint not the locator', mountView(33, { mountpoint: `${LAYOUT.runtimeDir}/x/${LOCATOR.runtime}/views/other` })],
        ['mount_view root slot out of range', mountView(33, { rootSlot: 10 })],
        ['mount_view shared propagation', mountView(33, { propagation: 'shared' })],
        ['mount_view rootSlot as a string', mountView(33, { rootSlot: '8' })],
        ['mount_view duplicate grant (second of a set)', mountView(34, { rootSlot: 9 }), { mount: { ...REQUEST_CONTEXT.mount, prior: [mountView(33)] } }],
        ['mount_view duplicate root slot (second of a set)', mountView(34, { grantId: 'other', mountpoint: `${LAYOUT.runtimeDir}/x/${LOCATOR.runtime}/views/other` }), { mount: { ...REQUEST_CONTEXT.mount, prior: [mountView(33)] } }],
        ['unmount_view', buildRequest('unmount_view', 35, { resource: MOUNT_HANDLE })],
        ['unmount_view of a supervisor handle', buildRequest('unmount_view', 35, { resource: handle(TREE_ID) })],
        ['view_root_lease renew', buildRequest('view_root_lease', 36, { grantId: GRANT_ID, epoch: 2, verdict: 'renew', ttlMs: viewLimits.rootLeaseTtlMs })],
        ['view_root_lease renew ttl over the lease', buildRequest('view_root_lease', 36, { grantId: GRANT_ID, epoch: 2, verdict: 'renew', ttlMs: viewLimits.rootLeaseTtlMs + 1 })],
        ['view_root_lease revoke', buildRequest('view_root_lease', 36, { grantId: GRANT_ID, epoch: 3, verdict: 'revoke', reason: 'root_unbound' })],
        ['view_root_lease epoch 1', buildRequest('view_root_lease', 36, { grantId: GRANT_ID, epoch: 1, verdict: 'renew', ttlMs: 100 })],
        ['unknown op', buildRequest('frobnicate', 37)],
        ['id 0', buildRequest('ping', 0)],
        ['id 1000000000', buildRequest('ping', 1_000_000_000)],
        ['id 1000000001', buildRequest('ping', 1_000_000_001)],
        ['array payload', []]
    ];
    return cases.map(([name, frame, contextOverrides = {}]) => {
        const verdict = validateKeeperRequest(frame, fullContext(contextOverrides));
        const keeperVerdict = verdict.ok ? 'ok' : verdict.violation ? { violation: verdict.violation } : { refused: verdict.refused };
        const context = Object.keys(contextOverrides).length === 0 ? undefined : contextOverrides;
        return context === undefined ? { name, frame, keeperVerdict } : { name, frame, context, keeperVerdict };
    });
}

// ---- replies ----------------------------------------------------------------------------------------------------------

function replyCases() {
    const ok = (id, value) => ({ id, ok: true, value });
    const err = (id, kind, error) => ({ id, ok: false, kind, error });
    const procIdentity = { pid: 4242, startTime: '123456789', pidNs: '4026532001' };
    const cTree = create(8, 'process-tree', TREE_ID, TREE_ID, LOC.tree, { role: 'terminal', pty: handle(PTY_ID), argv: ['bash'], cwd: '/home/robot', netns: null });
    const cRuntime = create(3, 'runtime-dir', RUNTIME_ID, null, LOC.runtime, {});
    const cPty = create(6, 'pty', PTY_ID, null, LOC.pty, { cols: 80, rows: 24 });
    const cNetns = create(5, 'netns', NETNS_ID, null, LOC.netns, {});
    const cCgroup = create(4, 'cgroup', CGROUP_ID, null, LOC.cgroup, {});
    const mount = mountView(33);
    const mountValue = {
        resource: MOUNT_HANDLE, mount: { mountId: 512, mountpoint: MOUNTPOINT, mountNamespaceInode: '4026532100' },
        fileServer: { pid: 4300, startTime: '123456999', pidNamespaceInode: '4026532101' }
    };
    const cases = [
        ['create process-tree', cTree, ok(8, { resource: handle(TREE_ID), identity: procIdentity })],
        ['create process-tree startTime as a number', cTree, ok(8, { resource: handle(TREE_ID), identity: { ...procIdentity, startTime: 123456789 } })],
        ['create process-tree with an fd key in the identity', cTree, ok(8, { resource: handle(TREE_ID), identity: { ...procIdentity, fd: 5 } })],
        ['create process-tree for another handle', cTree, ok(8, { resource: handle(NETNS_ID), identity: procIdentity })],
        ['create with an fd key in the value', cTree, ok(8, { resource: handle(TREE_ID), identity: procIdentity, fd: 5 })],
        ['create runtime-dir', cRuntime, ok(3, { resource: handle(RUNTIME_ID), identity: { path: LOC.runtime.path, dev: '2049', ino: '777' } })],
        ['create runtime-dir for another path', cRuntime, ok(3, { resource: handle(RUNTIME_ID), identity: { path: `${LOC.runtime.path}x`, dev: '2049', ino: '777' } })],
        ['create pty', cPty, ok(6, { resource: handle(PTY_ID), identity: { pty: LOCATOR.pty, devptsDev: '136314880', index: 0 } })],
        ['create pty devptsDev as a number', cPty, ok(6, { resource: handle(PTY_ID), identity: { pty: LOCATOR.pty, devptsDev: 136314880, index: 0 } })],
        ['create netns', cNetns, ok(5, { resource: handle(NETNS_ID), identity: { netNs: '4026532200' } })],
        ['create cgroup', cCgroup, ok(4, { resource: handle(CGROUP_ID), identity: { path: LOC.cgroup.path, cgroupId: '9001' } })],
        ['create refused', cNetns, err(5, 'refused', 'duplicate_resource')],
        ['create failure', cNetns, err(5, 'failure', 'setup_failed')],
        ['create error code not snake case', cNetns, err(5, 'refused', 'duplicateResource')],
        ['commit executed (process-bearing)', buildRequest('commit', 14, { resource: handle(TREE_ID) }), ok(14, { state: 'executed' }), { kind: 'process-tree' }],
        ['commit committed for a process-bearing kind', buildRequest('commit', 14, { resource: handle(TREE_ID) }), ok(14, { state: 'committed' }), { kind: 'process-tree' }],
        ['commit committed (netns)', buildRequest('commit', 14, { resource: handle(NETNS_ID) }), ok(14, { state: 'committed' }), { kind: 'netns' }],
        ['commit with an fd key', buildRequest('commit', 14, { resource: handle(NETNS_ID) }), ok(14, { state: 'committed', fd: 3 }), { kind: 'netns' }],
        ['commit refused gate_closed', buildRequest('commit', 14, { resource: handle(TREE_ID) }), err(14, 'refused', 'gate_closed'), { kind: 'process-tree' }],
        ['commit_keeper ok', buildRequest('commit_keeper', 1), ok(1, {})],
        ['commit_keeper refused (no error allowed)', buildRequest('commit_keeper', 1), err(1, 'refused', 'nope')],
        ['ping ok', buildRequest('ping', 2), ok(2, {})],
        ['ping with a value key', buildRequest('ping', 2), ok(2, { handle: 1 })],
        ['ping failure (no error allowed)', buildRequest('ping', 2), err(2, 'failure', 'busy')],
        ['end_process_trees with a descriptor key', buildRequest('end_process_trees', 18), ok(18, { descriptor: 4 })],
        ['stop exited', buildRequest('stop', 16, { resource: handle(TREE_ID), graceMs: 0 }), ok(16, { state: 'exited' })],
        ['stop refused resource_not_committed (RV-1)', buildRequest('stop', 16, { resource: handle(TREE_ID), graceMs: 0 }), err(16, 'refused', 'resource_not_committed')],
        ['stop failure stop_timeout (R2.2)', buildRequest('stop', 16, { resource: handle(TREE_ID), graceMs: 0 }), err(16, 'failure', 'stop_timeout')],
        ['tempdir', buildRequest('tempdir', 17), ok(17, { path: '/tmp/ala-0123456789abcdef' })],
        ['tempdir another path', buildRequest('tempdir', 17), ok(17, { path: '/tmp/x' })],
        ['inventory', buildRequest('inventory', 24), ok(24, { resources: [{ resource: handle(TREE_ID), kind: 'process-tree', state: 'committed' }], descriptors: 9 })],
        ['pty_input ack', buildRequest('pty_input', 30, { resource: handle(PTY_ID), seq: '7', data: pty64(1) }), ok(30, { seq: '7' })],
        ['pty_input ack for another seq', buildRequest('pty_input', 30, { resource: handle(PTY_ID), seq: '7', data: pty64(1) }), ok(30, { seq: '8' })],
        ['pty_input refused pty_closed', buildRequest('pty_input', 30, { resource: handle(PTY_ID), seq: '7', data: pty64(1) }), err(30, 'refused', 'pty_closed')],
        ['pty_input failure pty_closed', buildRequest('pty_input', 30, { resource: handle(PTY_ID), seq: '7', data: pty64(1) }), err(30, 'failure', 'pty_closed')],
        ['mount_view', mount, ok(33, mountValue)],
        ['mount_view with a supervisor handle', mount, ok(33, { ...mountValue, resource: handle(TREE_ID) })],
        ['mount_view other mountpoint', mount, ok(33, { ...mountValue, mount: { ...mountValue.mount, mountpoint: '/x' } })],
        ['mount_view refused', mount, err(33, 'refused', 'duplicate_grant_id')],
        ['view_root_lease live', buildRequest('view_root_lease', 36, { grantId: GRANT_ID, epoch: 2, verdict: 'renew', ttlMs: 100 }), ok(36, { state: 'live' })],
        ['view_root_lease unknown state', buildRequest('view_root_lease', 36, { grantId: GRANT_ID, epoch: 2, verdict: 'renew', ttlMs: 100 }), ok(36, { state: 'gone' })],
        ['reply id mismatch', buildRequest('ping', 2), ok(3, {})],
        ['reply with an extra top-level key', buildRequest('ping', 2), { ...ok(2, {}), event: 'exit' }]
    ];
    return cases.map(([name, request, reply, context = {}]) => {
        const verdict = validateKeeperReply(reply, request, context);
        const clientVerdict = verdict.ok ? 'ok' : { violation: verdict.violation };
        return Object.keys(context).length === 0 ? { name, request, reply, clientVerdict } : { name, request, reply, context, clientVerdict };
    });
}

// ---- events -----------------------------------------------------------------------------------------------------------

function eventCases() {
    const hello = {
        event: 'hello', protocol: KEEPER_PROTOCOL, version: KEEPER_PROTOCOL_VERSION, pid: 4100, startTime: '5550001', marker: KEEPER_ID,
        limits: helloLimits(limits, viewLimits)
    };
    const ptyState = (nextSeq, credit, closed = false) => ({ handle: handle(PTY_ID), kind: 'pty', committed: true, exited: false, pty: { nextSeq, credit, closed } });
    const tree = (committed, exited = false, commitOutcome) => ({ handle: handle(TREE_ID), kind: 'process-tree', committed, exited, ...(commitOutcome ? { commitOutcome } : {}) });
    const out = (seq, bytes) => ({ event: 'pty_output', resource: handle(PTY_ID), seq, data: pty64(bytes) });
    const cases = [
        ['hello first', hello, { helloSeen: false, resources: [] }],
        ['hello twice', hello, { helloSeen: true, resources: [] }],
        ['hello with an extra key', { ...hello, fd: 3 }, { helloSeen: false, resources: [] }],
        ['exit before hello', { event: 'exit', resource: handle(TREE_ID), code: 0, signal: null }, { helloSeen: false, resources: [tree(true)] }],
        ['exit of a committed tree', { event: 'exit', resource: handle(TREE_ID), code: 0, signal: null }, { helloSeen: true, resources: [tree(true)] }],
        ['exit by signal', { event: 'exit', resource: handle(TREE_ID), code: null, signal: 'SIGKILL' }, { helloSeen: true, resources: [tree(true)] }],
        ['exit signal of 33 characters', { event: 'exit', resource: handle(TREE_ID), code: null, signal: 'S'.repeat(33) }, { helloSeen: true, resources: [tree(true)] }],
        ['exit of an uncommitted tree', { event: 'exit', resource: handle(TREE_ID), code: 0, signal: null }, { helloSeen: true, resources: [tree(false)] }],
        ['exit twice', { event: 'exit', resource: handle(TREE_ID), code: 0, signal: null }, { helloSeen: true, resources: [tree(true, true)] }],
        ['exit after a failure commit reply (commit_failed)', { event: 'exit', resource: handle(TREE_ID), code: 127, signal: null }, { helloSeen: true, resources: [tree(true, false, 'failure')] }],
        ['exit after a refused commit reply', { event: 'exit', resource: handle(TREE_ID), code: 0, signal: null }, { helloSeen: true, resources: [tree(false, false, 'refused')] }],
        ['exit of an unknown handle', { event: 'exit', resource: handle(NETNS_ID), code: 0, signal: null }, { helloSeen: true, resources: [tree(true)] }],
        ['pty_output within credit', out('1', 10), { helloSeen: true, resources: [ptyState('1', 10)] }],
        ['pty_output over credit', out('1', 11), { helloSeen: true, resources: [ptyState('1', 10)] }],
        ['pty_output with no credit', out('1', 1), { helloSeen: true, resources: [ptyState('1', 0)] }],
        ['pty_output sequence gap', out('3', 1), { helloSeen: true, resources: [ptyState('2', 10)] }],
        ['pty_output repeated sequence', out('1', 1), { helloSeen: true, resources: [ptyState('2', 10)] }],
        ['pty_output after pty_closed', out('1', 1), { helloSeen: true, resources: [ptyState('1', 10, true)] }],
        ['pty_output of ptyChunkBytes + 1', out('1', limits.ptyChunkBytes + 1), { helloSeen: true, resources: [ptyState('1', limits.ptyMaxCreditBytes)] }],
        ['pty_closed', { event: 'pty_closed', resource: handle(PTY_ID) }, { helloSeen: true, resources: [ptyState('1', 0)] }],
        ['pty_closed twice', { event: 'pty_closed', resource: handle(PTY_ID) }, { helloSeen: true, resources: [ptyState('1', 0, true)] }],
        ['unknown event', { event: 'frobnicate' }, { helloSeen: true, resources: [] }],
        ['lease state event (not in v1)', { event: 'lease', grantId: GRANT_ID, state: 'live' }, { helloSeen: true, resources: [] }]
    ];
    return cases.map(([name, frame, context]) => {
        const state = {
            helloSeen: context.helloSeen,
            resources: new Map(context.resources.map((entry) => [entry.handle, { ...entry, pty: entry.pty ? { ...entry.pty } : undefined }]))
        };
        const verdict = acceptKeeperEvent(frame, state, { limits });
        return { name, frame, context, clientVerdict: verdict.ok ? 'ok' : { violation: verdict.violation } };
    });
}

// ---- commit replies and events read together (review F-1) -------------------------------------------------------------

// Frames of ONE read, applied in order: a reply to a commit is recorded on the handle (recordCommitReply) before the next
// frame is judged (acceptKeeperEvent). Each step's verdict is recorded.
function commitSequenceCases() {
    const commit = buildRequest('commit', 14, { resource: handle(TREE_ID) });
    const exit = { event: 'exit', resource: handle(TREE_ID), code: 0, signal: null };
    const cases = [
        ['ok commit reply and exit in one read', [{ id: 14, ok: true, value: { state: 'executed' } }, exit]],
        ['failure commit reply and exit in one read', [{ id: 14, ok: false, kind: 'failure', error: 'exec_failed' }, exit]],
        ['refused commit reply and exit in one read', [{ id: 14, ok: false, kind: 'refused', error: 'gate_closed' }, exit]]
    ];
    return cases.map(([name, frames]) => {
        const resource = { kind: 'process-tree', committed: false, exited: false };
        const state = { helloSeen: true, resources: new Map([[handle(TREE_ID), resource]]) };
        const verdicts = frames.map((frame) => {
            if (Object.hasOwn(frame, 'id')) {
                const verdict = validateKeeperReply(frame, commit, { kind: 'process-tree' });
                if (verdict.ok) recordCommitReply(resource, frame);
                return verdict.ok ? 'ok' : { violation: verdict.violation };
            }
            const verdict = acceptKeeperEvent(frame, state, { limits });
            return verdict.ok ? 'ok' : { violation: verdict.violation };
        });
        return { name, request: commit, context: { helloSeen: true, resources: [{ handle: handle(TREE_ID), kind: 'process-tree', committed: false, exited: false }] }, frames, verdicts };
    });
}

// ---- stop replies and the exit that follows (R2.2) --------------------------------------------------------------------

// A `stop_timeout` failure is never evidence of termination: the resource stays as it was, and its one exit is still
// accepted afterwards (for executed and commit_failed processes alike); a second exit is a violation.
function stopSequenceCases() {
    const stop = buildRequest('stop', 16, { resource: handle(TREE_ID), graceMs: 2000 });
    const exit = { event: 'exit', resource: handle(TREE_ID), code: null, signal: 'SIGKILL' };
    const timeout = { id: 16, ok: false, kind: 'failure', error: 'stop_timeout' };
    const cases = [
        ['stop_timeout then exit, executed process', 'ok', [timeout, exit]],
        ['stop_timeout then exit, commit_failed process', 'failure', [timeout, exit]],
        ['stop_timeout then two exits', 'ok', [timeout, exit, exit]]
    ];
    return cases.map(([name, commitOutcome, frames]) => {
        const entry = { handle: handle(TREE_ID), kind: 'process-tree', committed: true, exited: false, commitOutcome };
        const state = { helloSeen: true, resources: new Map([[entry.handle, { ...entry }]]) };
        const verdicts = frames.map((frame) => {
            const verdict = Object.hasOwn(frame, 'id') ? validateKeeperReply(frame, stop, { kind: 'process-tree' }) : acceptKeeperEvent(frame, state, { limits });
            return verdict.ok ? 'ok' : { violation: verdict.violation };
        });
        return { name, request: stop, context: { helloSeen: true, resources: [entry] }, frames, verdicts };
    });
}

// ---- admission (keeper-side in-flight accounting, N-A) ----------------------------------------------------------------

function admissionCases() {
    const inputFrame = (id, bytes, resource = handle(PTY_ID)) => buildRequest('pty_input', id, { resource, seq: String(id), data: pty64(bytes) });
    const ordinary = (id) => buildRequest('inventory', id);
    const lease = (id, grantId = GRANT_ID) => buildRequest('view_root_lease', id, { grantId, epoch: 2, verdict: 'renew', ttlMs: viewLimits.rootLeaseTtlMs });
    const fourMounts = () => ['mount_view', 'unmount_view', 'mount_view', 'unmount_view'].map((op, index) => ({ frame: buildRequest(op, index + 1) }));
    const run = (name, steps) => {
        const admission = createKeeperAdmission(limits, viewLimits);
        const out = steps.map((step) => {
            if (step.settle !== undefined) { admission.settle(step.settle); return { settle: step.settle }; }
            const verdict = admission.admit(step.frame);
            return { frame: step.frame, verdict: verdict.ok ? 'ok' : { violation: verdict.violation } };
        });
        return { name, steps: out };
    };
    let id = 0;
    const next = () => { id += 1; return id; };
    const sixteenPlusEight = [];
    for (let i = 0; i < limits.maxInFlight; i += 1) sixteenPlusEight.push({ frame: ordinary(next()) });
    for (let i = 0; i < limits.ptyInputWindowFrames; i += 1) sixteenPlusEight.push({ frame: inputFrame(next(), 1) });
    id = 0;
    const ninthChunk = [];
    for (let i = 0; i < limits.ptyInputWindowFrames + 1; i += 1) ninthChunk.push({ frame: inputFrame(next(), 1) });
    id = 0;
    const seventeenth = [];
    for (let i = 0; i < limits.maxInFlight + 1; i += 1) seventeenth.push({ frame: ordinary(next()) });
    id = 0;
    const bytes = [];
    for (let i = 0; i < limits.ptyInputWindowBytes / limits.ptyChunkBytes; i += 1) bytes.push({ frame: inputFrame(next(), limits.ptyChunkBytes) });
    bytes.push({ frame: inputFrame(next(), 1) });
    id = 0;
    const settled = [];
    for (let i = 0; i < limits.ptyInputWindowFrames; i += 1) settled.push({ frame: inputFrame(next(), 1) });
    settled.push({ settle: 1 });
    settled.push({ frame: inputFrame(next(), 1) });
    return [
        run('16 ordinary requests and 8 pty_input chunks are admitted together', sixteenPlusEight),
        run('a 9th outstanding pty_input chunk is a violation', ninthChunk),
        run('a 17th outstanding ordinary request is a violation', seventeenth),
        run('pty_input bytes beyond ptyInputWindowBytes are a violation', bytes),
        run('a settled chunk frees its window slot', settled),
        run('a repeated id is a violation', [{ frame: ordinary(5) }, { frame: ordinary(5) }]),
        run('a 5th outstanding mount op is a violation (maxMountInFlight, R2.3)', [
            ...fourMounts(), { frame: ordinary(5) }, { frame: buildRequest('mount_view', 6) }
        ]),
        run('a settled mount op frees its slot (R2.3)', [
            ...[1, 2, 3, 4].map((id) => ({ frame: buildRequest('mount_view', id) })), { settle: 2 }, { frame: buildRequest('unmount_view', 5) }
        ]),
        run('a lower id is a violation', [{ frame: ordinary(5) }, { frame: ordinary(4) }]),
        run('leases do not count toward maxMountInFlight', [...fourMounts(), { frame: lease(5) }]),
        run('second outstanding lease for one grant', [{ frame: lease(1) }, { frame: lease(2) }]),
        run('a settled lease frees its grant', [{ frame: lease(1) }, { settle: 1 }, { frame: lease(2) }]),
        run('channel bound still applies to leases', [...fourMounts(), ...Array.from({ length: 11 }, (_, i) => ({ frame: ordinary(i + 5) })),
            { frame: lease(16, 'g1') }, { frame: lease(17, 'g2') }])
    ];
}

// ---- the rest ---------------------------------------------------------------------------------------------------------

function identityCases() {
    const wire = {
        keeper: { pid: 4100, startTime: '5550001' },
        endpoint: { pid: 4200, startTime: '5550002', pidNs: '4026532001' },
        'process-tree': { pid: 4201, startTime: '5550003', pidNs: '4026532002' },
        netns: { netNs: '4026532200' },
        'runtime-dir': { path: LOC.runtime.path, dev: '2049', ino: '777' },
        cgroup: { path: LOC.cgroup.path, cgroupId: '9001' },
        pty: { pty: LOCATOR.pty, devptsDev: '136314880', index: 0 },
        mount: {
            resource: MOUNT_HANDLE, mount: { mountId: 512, mountpoint: MOUNTPOINT, mountNamespaceInode: '4026532100' },
            fileServer: { pid: 4300, startTime: '123456999', pidNamespaceInode: '4026532101' }
        }
    };
    return Object.entries(wire).map(([kind, value]) => ({ kind, wire: value, committed: toLedgerIdentity(kind, value) }));
}

function markerCases() {
    return [KEEPER_ID, DASH_ID, UNDERSCORE_ID].map((resourceId) => {
        const argv = keeperArgv({ marker: resourceId, parentPid: 1, scope: 'execution', runtimeRoot: LAYOUT.runtimeDir, ala: false, grantRoots: 0, channelLimits: {}, viewLimits: {} });
        const at = argv.indexOf('--reservation');
        return { resourceId, wireResource: handle(resourceId), keeperArgvFragment: argv.slice(at, at + 2) };
    });
}

function argvCases() {
    return [
        { name: 'execution, no ALA, no grants, no HOME', options: { scope: 'execution', ala: false, grantRoots: 0 } },
        { name: 'execution, ALA, two grants, HOME', options: { scope: 'execution', ala: true, grantRoots: 2, homeIdentity: { dev: '2049', ino: '12' }, orchestrationRoot: '/opt/robo-work/orchestration' } },
        { name: 'terminal, HOME only', options: { scope: 'terminal', ala: false, grantRoots: 0, homeIdentity: { dev: '2049', ino: '12' } } }
    ].map(({ name, options }) => ({
        name, options,
        argv: keeperArgv({ marker: DASH_ID, parentPid: 4000, runtimeRoot: LAYOUT.runtimeDir, channelLimits: channelLimitsForKeeper(limits), viewLimits, ...options })
    }));
}

function procStatCases() {
    return [
        '4100 (keeper) S 4000 4100 4100 0 -1 4194560 100 0 0 0 1 2 0 0 20 0 1 0 5550001 1000 100 18446744073709551615',
        '4201 (x) R 1 (y) S 4100 4201 4201 0 -1 4194560 0 0 0 0 0 0 0 0 20 0 1 0 5550003 0 0 0',
        '4202 (a b) c) S 4100 4202 4202 0 -1 0 0 0 0 0 0 0 0 0 20 0 1 0 18446744073709551615 0 0 0',
        '4203 (short) S 4100 4203',
        'x (bad) S 1 1 1 0 -1 0 0 0 0 0 0 0 0 0 20 0 1 0 1 0 0 0'
    ].map((line) => {
        const parsed = parseStatLine(line);
        return parsed === null ? { line, parsed: null } : { line, pid: parsed.pid, ppid: parsed.ppid, startTime: parsed.startTime };
    });
}

function base64Cases() {
    // maxBytes 3: the bound is applied to the decoded length (the ptyChunkBytes bound itself is in the requests).
    return ['YQ==', 'YWI=', 'YWJj', 'YWJjZA==', 'YQ', 'YR==', 'YWJ=', '', '====', 'YW Jj', 'YWJj\n', 'YWJj====', '-_8='].map((text) => {
        const bytes = decodeCanonicalBase64(text, 3);
        return { text, maxBytes: 3, canonical: bytes !== null, bytes: bytes === null ? null : bytes.toString('hex') };
    });
}

function sequenceCases() {
    return ['1', '2', '0', '01', '-1', '+1', ' 1', '1.0', '18446744073709551615', '18446744073709551616', '99999999999999999999', '100000000000000000000']
        .map((text) => ({ text, canonical: isCanonicalSeq(text) }));
}

function wireCodeCases() {
    return ['duplicate_grantId', 'duplicate_rootSlot', 'duplicate_mountpoint', 'duplicate_id', 'duplicate_grant_id', 'duplicate_root_slot', 'bad_grant_id',
        'root_slot_out_of_range', 'bad_root_identity', 'bad_access', 'propagation_not_private', 'allow_other_required', 'bad_context',
        'mountpoint_too_long', 'mountpoint_not_locator', 'descriptor_cap_invalid', 'bad_root_lease', 'bad_ttl'].map((frozen) => ({ frozen, wire: wireCode(frozen) }));
}

function encodeCases() {
    const frames = [
        ['commit_keeper', buildRequest('commit_keeper', 1)],
        ['ping', buildRequest('ping', 2)],
        ['create netns', create(5, 'netns', NETNS_ID, null, LOC.netns, {})],
        ['pty_input', buildRequest('pty_input', 30, { resource: handle(PTY_ID), seq: '1', data: 'aGk=' })],
        ['ok reply', { id: 2, ok: true, value: {} }],
        ['refused reply', { id: 5, ok: false, kind: 'refused', error: 'duplicate_resource' }],
        ['pty_output event', { event: 'pty_output', resource: handle(PTY_ID), seq: '1', data: 'aGk=' }]
    ];
    return frames.map(([name, value]) => ({ name, value, frameHex: encodeKeeperFrame(value, limits).toString('hex') }));
}

export function buildVectors() {
    return {
        schema: 'robo-work.keeper-wire/1',
        protocol: KEEPER_PROTOCOL,
        version: KEEPER_PROTOCOL_VERSION,
        generatedBy: GENERATED_BY,
        limits: {
            keeper: { ...limits },
            view: { ...viewLimits },
            endpoint: { ...ENDPOINT_LIMIT_DEFAULTS },
            hello: helloLimits(limits, viewLimits),
            helloKeys: [...HELLO_LIMIT_NAMES, 'rootLeaseTtlMs'],
            channelLimitNames: [...KEEPER_CHANNEL_LIMIT_NAMES],
            clientOnly: [...CLIENT_ONLY_LIMIT_NAMES],
            derived: { ptyFrameCapBytes: ptyFrameCapBytes(limits), minimumOutboundBytes: minimumOutboundBytes(limits), ordinaryInFlight: limits.maxInFlight - limits.reservedInFlight }
        },
        ops: { all: [...KEEPER_OPS], priority: [...PRIORITY_OPS], mount: [...MOUNT_OPS] },
        requestContext: REQUEST_CONTEXT,
        encode: encodeCases(),
        requests: requestCases(),
        replies: replyCases(),
        events: eventCases(),
        commitSequences: commitSequenceCases(),
        stopSequences: stopSequenceCases(),
        admission: admissionCases(),
        identities: identityCases(),
        markers: markerCases(),
        argv: argvCases(),
        procStat: procStatCases(),
        base64: base64Cases(),
        sequences: sequenceCases(),
        wireCodes: wireCodeCases()
    };
}

export const renderVectors = () => `${JSON.stringify(buildVectors(), null, 2)}\n`;

function main(argv) {
    if (argv.includes('--check')) {
        const against = argv.includes('--against') ? argv[argv.indexOf('--against') + 1] : VECTOR_FILE;
        const expected = Buffer.from(renderVectors(), 'utf8');
        let actual;
        try { actual = fs.readFileSync(against); } catch (error) {
            process.stderr.write(`keeper wire vectors: cannot read ${against}: ${error.code}\n`);
            return 1;
        }
        if (Buffer.compare(expected, actual) !== 0) {
            let at = 0;
            while (at < Math.min(expected.length, actual.length) && expected[at] === actual[at]) at += 1;
            process.stderr.write(`keeper wire vectors: ${against} differs from the production schema at byte ${at} (expected ${expected.length} bytes, found ${actual.length})\n`);
            return 1;
        }
        process.stdout.write(`keeper wire vectors: ${path.basename(against)} matches (${expected.length} bytes)\n`);
        return 0;
    }
    fs.writeFileSync(VECTOR_FILE, renderVectors());
    fs.writeFileSync(PROVENANCE_FILE, `${JSON.stringify({ generatedBy: GENERATED_BY, node: process.version, platform: `${os.platform()}-${os.arch()}`, note: 'Not compared: keeper-wire.v1.json alone is byte-checked.' }, null, 2)}\n`);
    process.stdout.write(`keeper wire vectors written: ${VECTOR_FILE}\n`);
    return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = main(process.argv.slice(2));
