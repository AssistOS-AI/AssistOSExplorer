import assert from 'node:assert/strict';
import test from 'node:test';

import { buildRecord } from '../lib/record.mjs';
import { GRADERS, PROBES, STAGE_REQUIRED } from '../probes/index.mjs';
import { analyse } from '../probes/t0-04-udp-listener.mjs';
import { chain } from '../probes/t0-02-one-stage.mjs';
import { tcpTable, udp6Table, udpTable } from './synthProc.mjs';

// SYNTHETIC observations only: the pure graders of the Stage 0 probes T0-01 to T0-04.

const IDENTITY = 'c'.repeat(64);
const ZERO = '0000000000000000';
const zeroCaps = { CapInh: ZERO, CapPrm: ZERO, CapEff: ZERO, CapBnd: ZERO, CapAmb: ZERO };

function record(probeId, observed, control) {
    return buildRecord({
        probeId, stage: 'S0', candidateIdentitySha256: IDENTITY, command: 'probe', startedAt: '2026-10-28T00:00:00Z', expected: 'x',
        observed, negativeControl: control === undefined ? null : { command: 'control', expected: 'y', observed: control },
    }, GRADERS[probeId]);
}

const surveyObserved = {
    kernel: '7.0.0-42-generic', uidMap: [[0, 1000, 1]], gidMap: [[0, 1000, 1]], caps: zeroCaps, noNewPrivs: 0, seccomp: 2, tools: {},
    bwrapVersion: { rc: 0, error: null }, bwrapHelp: { rc: 0 }, fsTypes: { '/tmp': { fsType: 'fuse.fuse-overlayfs' }, '/run': { fsType: 'tmpfs' }, '/dev/shm': { fsType: 'tmpfs' } },
    bwrapChildLabel: { rc: 0 }, maxUserNamespaces: { ok: true, value: '125023' }, limits: { 'Max open files': {} },
    cgroup: { controllers: { ok: true }, procsWritable: { ok: false }, subtreeControlWritable: { ok: false } }, nodeSqlite: { available: true },
    clock: { agent: [1, 2, 3], host: [1, 2, 3], box: [1, 2, 3] },
};
const surveyControl = { '/tmp': { listen: 'ok', connect: 'EACCES' }, '/dev/shm': { listen: 'ok', connect: 'ok' }, runtimeRoot: '/dev/shm' };

test('the Stage 0 required set is exactly T0-01 to T0-04, each with a grader and a collector', () => {
    assert.deepEqual([...STAGE_REQUIRED.S0], ['T0-01', 'T0-02', 'T0-03', 'T0-04']);
    for (const id of STAGE_REQUIRED.S0) {
        assert.equal(typeof PROBES[id].collect, 'function');
        assert.equal(typeof PROBES[id].grade, 'function');
        assert.equal(PROBES[id].id, id);
    }
});

test('T0-01: values recorded and /tmp EACCES vs tmpfs success pass; a /tmp that works or a missing value fails', () => {
    assert.equal(record('T0-01', surveyObserved, surveyControl).verdict, 'PASS');
    assert.equal(record('T0-01', surveyObserved, { ...surveyControl, '/tmp': { listen: 'ok', connect: 'ok' } }).verdict, 'FAIL');
    assert.equal(record('T0-01', surveyObserved, { ...surveyControl, runtimeRoot: null }).verdict, 'FAIL');
    assert.equal(record('T0-01', { ...surveyObserved, clock: { agent: [1, 2, 3], host: null, box: [1, 2, 3] } }, surveyControl).verdict, 'FAIL');
    assert.equal(record('T0-01', { ...surveyObserved, caps: { ...zeroCaps, CapAmb: undefined } }, surveyControl).verdict, 'FAIL');
});

test('T0-02: zero caps + NNP 1, or an explicit failure, with a control showing a non-zero bounding set', () => {
    const control = { control: { rc: 0, caps: { ...zeroCaps, CapBnd: '000001ffffffffff' } } };
    assert.equal(record('T0-02', { main: { rc: 0, caps: zeroCaps, noNewPrivs: 1 } }, control).verdict, 'PASS');
    assert.equal(record('T0-02', { main: { rc: 1, stderr: 'bwrap: setting up uid map: Permission denied' } }, control).verdict, 'PASS');
    assert.equal(record('T0-02', { main: { rc: 0, caps: { ...zeroCaps, CapBnd: '01' }, noNewPrivs: 1 } }, control).verdict, 'FAIL');
    assert.equal(record('T0-02', { main: { rc: 0, caps: zeroCaps, noNewPrivs: 0 } }, control).verdict, 'FAIL');
    assert.equal(record('T0-02', { main: { rc: 1, stderr: '' } }, control).verdict, 'FAIL', 'a silent failure is not explicit');
    assert.equal(record('T0-02', { main: { rc: 0, caps: zeroCaps, noNewPrivs: 1 } }, { control: { rc: 0, caps: zeroCaps } }).verdict, 'FAIL');
    assert.equal(record('T0-02', { main: { rc: 1, stderr: 'x' } }, { control: { rc: 1, caps: null } }).verdict, 'FAIL', 'a control that cannot start cannot tell the two apart');
    const [, args] = chain({ unshare: 'unshare', bwrap: 'bwrap', capDrop: false, disableUserns: true });
    assert.equal(args.includes('ALL'), false);
    assert.equal(args.includes('--disable-userns'), true);
});

test('T0-03: determinate controls and failing invalid-target calls pass; an instrument that cannot report failure fails', () => {
    const call = (rc, errno) => ({ rc, errno });
    const observed = {
        unshareMapRoot: { rc: 0 },
        syscalls: { valid: { pidfd_open: call(3, 0), pidfd_getfd: call(-1, 38), process_vm_readv: call(6, 0), keyctl: call(-1, 38) } },
        reach: { gateway8080: { ok: true }, gateway8081: { ok: false, errno: 'ECONNREFUSED' }, boxSentinel: { ok: true } },
        procSys: { readOnly: true }, ipForwardWritable: { ok: false, errno: 'EROFS' },
    };
    const control = { invalidCalls: { pidfd_getfd_bad_fd: call(-1, 9), process_vm_readv_bad_pid: call(-1, 3), keyctl_bad_op: call(-1, 95) }, closedPort: { ok: false, errno: 'ECONNREFUSED' } };
    assert.equal(record('T0-03', observed, control).verdict, 'PASS');
    assert.equal(record('T0-03', observed, { ...control, closedPort: { ok: true, errno: null } }).verdict, 'FAIL');
    assert.equal(record('T0-03', observed, { ...control, invalidCalls: { ...control.invalidCalls, keyctl_bad_op: call(0, 0) } }).verdict, 'FAIL');
    assert.equal(record('T0-03', { ...observed, syscalls: { valid: {} } }, control).verdict, 'FAIL');
    assert.equal(record('T0-03', { ...observed, reach: { ...observed.reach, boxSentinel: { ok: false, errno: 'NO_SENTINEL' } } }, control).verdict, 'FAIL');
});

function capture({ udp = [['127.0.0.1', 17972]], udp6 = [] } = {}) {
    return { tables: { udp: udpTable(udp), udp6: udp6Table(udp6), tcp: tcpTable([['0.0.0.0', 8080, '0A']]), tcp6: tcpTable([]).replace('local_address rem_address', 'local_address rem_address') }, capturedAt: 't', boxId: 'b' };
}

function t004(cap) {
    const { observed, control, unreadable } = analyse(cap);
    return buildRecord({
        probeId: 'T0-04', stage: 'S0', candidateIdentitySha256: IDENTITY, command: 'probe', startedAt: 't', expected: 'x',
        observed, negativeControl: { command: 'sentinel', expected: 'y', observed: control }, unreadable,
    }, GRADERS['T0-04']);
}

test('T0-04: 17971 absent with the 17972 sentinel present passes; 17971 bound, sentinel missing or a missing table fails', () => {
    assert.equal(t004(capture()).verdict, 'PASS');
    assert.equal(t004(capture({ udp: [['127.0.0.1', 17972], ['0.0.0.0', 17971]] })).verdict, 'FAIL');
    assert.equal(t004(capture({ udp6: [17971] })).verdict, 'FAIL', 'an IPv6 wildcard bind on 17971 counts');
    assert.equal(t004(capture({ udp: [] })).verdict, 'FAIL', 'without the sentinel the probe cannot show it would see a listener');
    assert.equal(t004(capture({ udp: [['10.0.0.5', 17972]] })).verdict, 'FAIL', 'the sentinel must be the loopback one');
    const broken = capture();
    delete broken.tables.udp6;
    assert.equal(t004(broken).verdict, 'FAIL');
});

test('mutation for every Stage 0 probe: removing the observed negative control turns a PASS into FAIL', () => {
    const passing = {
        'T0-01': [surveyObserved, surveyControl],
        'T0-02': [{ main: { rc: 0, caps: zeroCaps, noNewPrivs: 1 } }, { control: { rc: 0, caps: { ...zeroCaps, CapBnd: 'ff' } } }],
        'T0-04': [analyse(capture()).observed, analyse(capture()).control],
    };
    for (const [id, [observed, control]] of Object.entries(passing)) {
        assert.equal(record(id, observed, control).verdict, 'PASS', id);
        assert.equal(record(id, observed, undefined).verdict, 'FAIL', `${id} without a negative control`);
        assert.equal(record(id, observed, null).verdict, 'FAIL', `${id} with a null negative control`);
    }
});
