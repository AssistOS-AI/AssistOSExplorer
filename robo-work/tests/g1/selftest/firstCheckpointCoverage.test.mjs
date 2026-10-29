import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { canonicalJson, sha256, buildRecord } from '../lib/record.mjs';
import * as checkpoint from '../probes/firstCheckpoint.mjs';
import { PROBES, STAGE_REQUIRED } from '../probes/index.mjs';
import { runProbe, writeIdentity } from '../harness.mjs';

// All observations and descriptor references below are manufactured MODEL facts. No /proc, native helper, process,
// namespace or signal is used. Passing these assertions demonstrates rejection logic, never kernel qualification.
const digest = (value) => sha256(canonicalJson(value));
const clone = (value) => structuredClone(value);
const zero = '0000000000000000';
const caps = { CapInh: zero, CapPrm: zero, CapEff: zero, CapBnd: zero, CapAmb: zero };
const stdio = [0, 1, 2].map((fd) => ({ fd, kind: 'stream', origin: 'inherited', authority: 'stdio' }));

function capture({ childFacts = {}, anchorFacts = {}, monitorDescriptors = [], descendant = null, role = 'workload' } = {}) {
    const keeper = { pid: 100, startTime: '1', ppid: 1, pidNs: '10', exe: { dev: '1', ino: '90' } };
    const anchor = { pid: 200, startTime: '2', ppid: 100, pidNs: '30', exe: { dev: '1', ino: '91' }, role: 'monitor' };
    const child = { pid: 201, startTime: '3', ppid: 200, pidNs: '30', exe: { dev: '1', ino: '92' }, role };
    const expectedExe = { ...child.exe, sha256: 'e'.repeat(64) };
    const policy = {
        uidMap: [[1000, 0, 1]], gidMap: [[1000, 0, 1]],
        mounts: { [role]: [{ target: '/', sourceType: 'image-root', readOnly: true }, { target: '/tmp', sourceType: 'tmpfs', readOnly: false }] },
        forbiddenPaths: { [role]: ['/worker-store', '/other-home'] },
        descriptorAllowances: { [role]: clone(stdio), monitor: [], keeper: [{ fd: 3, kind: 'controller-channel', origin: 'inherited', authority: 'keeper-wire' }] },
        runtimeDescriptorKinds: ['eventpoll', 'eventfd', 'timerfd'],
        executables: { [role]: child.exe, monitor: anchor.exe, keeper: keeper.exe },
    };
    const expected = {
        observerArtifactSha256: 'a'.repeat(64), bwrapSha256: 'b'.repeat(64), runtimePolicySha256: digest(policy),
        imageSha256: 'c'.repeat(64), nodeSha256: 'd'.repeat(64), runId: '012345abcdef',
        role, anchor: { pid: anchor.pid, startTime: anchor.startTime, pidNs: anchor.pidNs }, keeper, expectedExe, policy,
    };
    const measurements = {
        targetingVersion: checkpoint.TARGETING_VERSION, observerContract: checkpoint.OBSERVER_CONTRACT,
        observerArtifactSha256: expected.observerArtifactSha256, runId: expected.runId, bindingId: 'model-held-child',
        topology: { bwrapSha256: expected.bwrapSha256, anchor: clone(expected.anchor), membersBeforeUnpark: [clone(anchor), clone(child)], expectedShape: 'anchor-and-one-direct-exec-child', matched: true },
        execBinding: { method: 'independent-proc-direct-child/1', role, pid: child.pid, startTime: child.startTime,
            ppid: child.ppid, pidNs: child.pidNs, expectedExe: clone(expectedExe), observedExe: clone(child.exe),
            pidfdHeld: true, procDirectoryHeld: true, validatedBeforeUnpark: true },
        snapshots: [], observerRecords: [],
    };
    const append = (op, values) => {
        const sequence = measurements.observerRecords.length + 1;
        measurements.observerRecords.push({ sequence, op, observerArtifactSha256: expected.observerArtifactSha256,
            runId: expected.runId, bindingId: measurements.bindingId,
            inputPins: Object.fromEntries(['bwrapSha256', 'runtimePolicySha256', 'imageSha256', 'nodeSha256'].map((name) => [name, expected[name]])),
            ...clone(values) });
        return sequence;
    };
    const childCheck = { binding: child, alive: true, pidfdRef: 'held-pidfd', procDirectoryRef: 'held-proc' };
    measurements.bindingEvidence = {
        anchorCheck: append('anchor-check', { subject: anchor, alive: true }),
        members: append('namespace-enumeration', { members: measurements.topology.membersBeforeUnpark }),
        expectedExe: append('expected-exe-open', { identity: expectedExe, ref: 'held-elf', fd: 52, fileType: 'regular' }),
        pidfd: append('pidfd-open', { subject: child, fd: 50, ref: 'held-pidfd' }),
        procDirectory: append('proc-directory-open', { subject: child, fd: 51, ref: 'held-proc', directory: { dev: '2', ino: '201' } }),
        revalidation: append('binding-check', childCheck),
        persisted: append('binding-persisted', { bindingSha256: digest(measurements.execBinding) }),
    };
    append('unpark', {});
    function snapshot(target, subject, facts) {
        const before = append('snapshot-check', { ...childCheck, target, subject });
        const read = append('snapshot-read', { target, subject, factsSha256: digest(facts) });
        const after = append('snapshot-check', { ...childCheck, target, subject });
        measurements.snapshots.push({ target, pid: subject.pid, startTime: subject.startTime,
            bindingValidBefore: true, bindingValidAfter: true, facts: clone(facts), evidence: { before, read, after } });
    }
    const clean = { status: { ...caps, NoNewPrivs: 1, Seccomp: 2 }, uidMap: clone(policy.uidMap), gidMap: clone(policy.gidMap),
        mounts: clone(policy.mounts[role]), pathAttempts: policy.forbiddenPaths[role].map((path) => ({ path, rc: -1, errno: 'ENOENT' })),
        descriptors: [...clone(stdio), { fd: 32, kind: 'eventfd', origin: 'runtime', authority: null }] };
    snapshot('exec-child', child, { ...clone(clean), ...childFacts });
    snapshot('anchor', anchor, { ...clone(clean), identity: expected.anchor, ...anchorFacts });
    const members = [anchor, child, ...(descendant ? [descendant] : [])];
    const before = append('namespace-inventory', { members });
    snapshot('keeper', keeper, { status: { ...caps, CapBnd: '0000000000000001' }, uidMap: [[0, 0, 1]], gidMap: [[0, 0, 1]],
        descriptors: policy.descriptorAllowances.keeper, limits: { nofile: { soft: 256, hard: 256 } }, cgroupSubtree: null });
    snapshot('namespace-member', anchor, { descriptors: monitorDescriptors });
    snapshot('namespace-member', child, { descriptors: clean.descriptors });
    if (descendant) snapshot('namespace-member', descendant, { descriptors: [] });
    const after = append('namespace-inventory', { members });
    measurements.custodyInventory = { before, after, members: clone(members) };
    return { measurements, expected, child, anchor, append };
}

const grade = (data, assertion, api = checkpoint) => api.gradeTargetEvidence({ ...data, assertion });
const confined = ['identityCapabilities', 'noNewPrivs', 'seccompStatus', 'filesystemView', 'inheritedDescriptors'];

test('A1 required probe set and all deferred rows are explicit and immutable', () => {
    assert.deepEqual([...checkpoint.S1_REQUIRED], ['G1-01', 'G1-02', 'G1-03', 'G1-04', 'G1-05', 'G1-06', 'G1-07',
        'G1-08', 'G1-09', 'G1-10', 'G1-11', 'G1-13', 'G1-14', 'G1-15', 'G1-16', 'G1-17', 'G1-27']);
    assert.equal(Object.keys(checkpoint.S1_MATRIX).length, 29);
    assert.equal(Object.isFrozen(checkpoint.S1_MATRIX['G1-03'].deferred), true);
    assert.equal(checkpoint.S1_MATRIX['G1-15'].required.filter((id) => /^(supervisor|keeper|endpoint)\./.test(id)).length, 12);
    for (const id of Object.keys(checkpoint.S1_MATRIX)) {
        const coverage = checkpoint.pendingCoverage(id);
        assert.equal(checkpoint.checkCoverage(id, coverage).ok, true, id);
        assert.equal(checkpoint.checkCoverage(id, coverage).qualifying, false);
        assert.ok(coverage.every((entry) => entry.status === 'NOT-RUN'));
    }
});

test('missing required/deferred coverage, duplicate entries and supplied PASS are refused', () => {
    for (const probeId of ['G1-03', 'G1-27']) {
        const coverage = checkpoint.pendingCoverage(probeId);
        assert.equal(checkpoint.checkCoverage(probeId, coverage.slice(1)).ok, false);
        assert.equal(checkpoint.checkCoverage(probeId, coverage.filter((entry) => entry.scope !== 'deferred')).ok, false);
        assert.equal(checkpoint.checkCoverage(probeId, [...coverage, coverage[0]]).ok, false);
        assert.equal(checkpoint.checkCoverage(probeId, coverage.map((entry) => ({ ...entry, status: 'PASS' }))).ok, false);
    }
});

test('deferred terminal and file-server targets remain NOT-RUN without borrowing another binding', () => {
    assert.deepEqual(checkpoint.pendingCoverage('G1-27').filter((entry) => entry.scope === 'deferred').map(({ id, deferredTo, status }) =>
        ({ id, deferredTo, status })), [{ id: 'terminal.tool-immutability', deferredTo: 'S2', status: 'NOT-RUN' }]);
    assert.deepEqual(checkpoint.pendingCoverage('G1-03').filter((entry) => entry.scope === 'deferred').map(({ id, deferredTo, status }) =>
        ({ id, deferredTo, status })), [{ id: 'file-server.userns-denial', deferredTo: 'S4', status: 'NOT-RUN' }]);
    const data = capture();
    for (const role of ['terminal', 'file-server']) assert.equal(grade({ ...data, expected: { ...data.expected, role } }, 'noNewPrivs').verdict, 'FAIL');
});

test('held model evidence targets the child, keeper, anchor and every namespace member separately', () => {
    const data = capture();
    for (const assertion of [...confined, 'keeperMeasurements', 'publicIdentity', 'descriptorCustody']) {
        assert.equal(grade(data, assertion).verdict, 'PASS', assertion);
        assert.equal(grade(data, assertion).qualifying, false, 'model evidence is never qualification');
    }
    assert.deepEqual(checkpoint.TARGET_TABLE.descriptorCustody, ['keeper', 'namespace-member']);
    assert.deepEqual(checkpoint.TARGET_TABLE.terminationAbsence, ['anchor', 'namespace-member']);
    assert.equal(grade(data, 'terminationAbsence').verdict, 'FAIL', 'termination collector is not implemented');
});

function assertChildConfinement(api) {
    const badCases = [
        ['identityCapabilities', { status: { ...caps, CapBnd: '0000000000000001', NoNewPrivs: 1, Seccomp: 2 } }],
        ['noNewPrivs', { status: { ...caps, NoNewPrivs: 0, Seccomp: 2 } }],
        ['seccompStatus', { status: { ...caps, NoNewPrivs: 1, Seccomp: 0 } }],
        ['filesystemView', { mounts: [{ target: '/worker-store', sourceType: 'host-directory', readOnly: false }] }],
    ];
    for (const [assertion, childFacts] of badCases) {
        const data = capture({ childFacts });
        assert.equal(grade(data, assertion, api).verdict, 'FAIL', `${assertion}: favorable anchor cannot substitute for child`);
    }
}

test('anchor PASS and child FAIL fails capabilities, NNP, seccomp and forbidden mount checks', () => assertChildConfinement(checkpoint));

test('fixture PID and argv decoys do not select the target or substitute for ELF identity', () => {
    const data = capture({ childFacts: { status: { ...caps, NoNewPrivs: 0, Seccomp: 2 } } });
    data.measurements.fixturePid = data.anchor.pid;
    data.measurements.argv = ['/expected/favorable/program'];
    data.measurements.privateKeeperExecChild = data.anchor;
    assert.equal(grade(data, 'noNewPrivs').verdict, 'FAIL');
    const wrongExe = capture();
    wrongExe.measurements.execBinding.observedExe.ino = '999';
    wrongExe.measurements.argv = ['/expected/node'];
    assert.equal(grade(wrongExe, 'noNewPrivs').verdict, 'FAIL');
});

test('multiple direct children or an extra quiet namespace member fail binding', () => {
    for (const parent of [200, 201]) {
        const data = capture();
        data.measurements.topology.membersBeforeUnpark.push({ ...data.child, pid: 202, startTime: '4', ppid: parent });
        assert.equal(grade(data, 'noNewPrivs').verdict, 'FAIL');
    }
});

test('PID reuse, vanished binding and changed held references invalidate snapshots', () => {
    for (const mutation of [
        (record) => { record.binding.startTime = '999'; },
        (record) => { record.alive = false; },
        (record) => { record.pidfdRef = 'replacement-pidfd'; },
        (record) => { record.binding.pidNs = '999'; },
    ]) {
        const data = capture();
        const snapshot = data.measurements.snapshots.find((entry) => entry.target === 'exec-child');
        mutation(data.measurements.observerRecords[snapshot.evidence.after - 1]);
        assert.equal(grade(data, 'noNewPrivs').verdict, 'FAIL');
    }
});

function replaceSnapshot(data) {
    const snapshot = data.measurements.snapshots.find((entry) => entry.target === 'exec-child');
    const replacement = { ...data.child, pid: 301, startTime: '100' };
    snapshot.pid = replacement.pid;
    snapshot.startTime = replacement.startTime;
    for (const sequence of Object.values(snapshot.evidence)) {
        const record = data.measurements.observerRecords[sequence - 1];
        record.subject = clone(replacement);
        if (record.binding) record.binding = clone(replacement);
    }
    return replacement;
}

test('loss followed by a matching replacement cannot rebind the original target', () => {
    const data = capture();
    replaceSnapshot(data);
    assert.equal(grade(data, 'noNewPrivs').verdict, 'FAIL');
    data.append('rebind', { child: { ...data.child, pid: 301 } });
    assert.equal(grade(data, 'noNewPrivs').verdict, 'FAIL');
});

test('missing pidfd/proc-directory custody blocks, while unsupported true flags fail', () => {
    for (const name of ['pidfdHeld', 'procDirectoryHeld']) {
        const data = capture();
        data.measurements.execBinding[name] = false;
        assert.equal(grade(data, 'noNewPrivs').verdict, 'BLOCKED');
    }
    for (const name of ['pidfd', 'procDirectory', 'revalidation', 'persisted']) {
        const data = capture();
        delete data.measurements.bindingEvidence[name];
        assert.equal(grade(data, 'noNewPrivs').verdict, 'FAIL');
    }
    const data = capture();
    data.measurements.observerRecords = [];
    assert.equal(grade(data, 'noNewPrivs').verdict, 'FAIL', 'all A2 booleans remain true but prove nothing');
});

test('facts digest, observer/image/policy pins and before/after record provenance are required', () => {
    const mutations = [
        (data) => { data.measurements.observerArtifactSha256 = 'f'.repeat(64); },
        (data) => { data.measurements.topology.bwrapSha256 = 'f'.repeat(64); },
        (data) => { data.expected.policy.uidMap = [[0, 0, 1]]; },
        (data) => { data.measurements.snapshots[0].facts.status.NoNewPrivs = 0; },
        (data) => { data.measurements.observerRecords.at(-1).runId = 'ffffffffffff'; },
        (data) => { data.measurements.observerRecords[0].inputPins.imageSha256 = 'f'.repeat(64); },
        (data) => { data.measurements.snapshots[0].evidence.after = data.measurements.snapshots[0].evidence.before; },
    ];
    for (const mutate of mutations) { const data = capture(); mutate(data); assert.equal(grade(data, 'noNewPrivs').verdict, 'FAIL'); }
    for (const pin of ['observerArtifactSha256', 'imageSha256', 'nodeSha256', 'runtimePolicySha256']) {
        const data = capture();
        delete data.expected[pin];
        assert.equal(grade(data, 'noNewPrivs').verdict, 'BLOCKED');
    }
});

test('clean child descriptors cannot hide monitor authority or unknown descendants', () => {
    const leaked = capture({ monitorDescriptors: [{ fd: 9, kind: 'directory', origin: 'inherited', authority: 'worker-store' }] });
    assert.equal(grade(leaked, 'inheritedDescriptors').verdict, 'PASS');
    assert.equal(grade(leaked, 'descriptorCustody').verdict, 'FAIL');
    const descendant = capture({ descendant: { pid: 202, startTime: '4', ppid: 201, pidNs: '30', exe: { dev: '1', ino: '93' }, role: 'unknown' } });
    assert.equal(grade(descendant, 'descriptorCustody').verdict, 'FAIL');
    const incomplete = capture();
    incomplete.measurements.snapshots = incomplete.measurements.snapshots.filter((entry) => entry.target !== 'namespace-member' || entry.pid !== 200);
    assert.equal(grade(incomplete, 'descriptorCustody').verdict, 'FAIL');
    const omitted = capture();
    omitted.measurements.snapshots.push({ ...clone(omitted.measurements.snapshots.find((entry) => entry.target === 'namespace-member')), pid: 202 });
    assert.equal(grade(omitted, 'descriptorCustody').verdict, 'FAIL', 'an observed member cannot be omitted from the inventory');
});

test('negative controls need acquired targets and opposite measured facts, not failure flags', () => {
    const data = capture();
    const control = capture({ childFacts: { status: { ...caps, NoNewPrivs: 0, Seccomp: 2 } } });
    const negativeControl = { command: 'synthetic unfiltered fixture', measurements: control.measurements, expected: control.expected };
    assert.equal(checkpoint.gradeTargetPair({ ...data, assertion: 'noNewPrivs', negativeControl }).verdict, 'PASS');
    for (const missing of [undefined, { command: 'synthetic', observed: false }, { ...negativeControl, command: '' },
        { command: 'synthetic', measurements: data.measurements, expected: data.expected }]) {
        assert.equal(checkpoint.gradeTargetPair({ ...data, assertion: 'noNewPrivs', negativeControl: missing }).verdict, 'FAIL');
    }
    control.measurements.execBinding.pidfdHeld = false;
    assert.equal(checkpoint.gradeTargetPair({ ...data, assertion: 'noNewPrivs', negativeControl }).verdict, 'FAIL', 'a broken instrument is not an effective control');
});

test('custody negative control needs a measured leak, not just an invalid inventory', () => {
    const data = capture();
    const control = capture({ monitorDescriptors: [{ fd: 9, kind: 'directory', origin: 'inherited', authority: 'worker-store' }] });
    const negativeControl = { command: 'synthetic monitor descriptor leak', measurements: control.measurements, expected: control.expected };
    assert.equal(checkpoint.gradeTargetPair({ ...data, assertion: 'descriptorCustody', negativeControl }).verdict, 'PASS');
    control.measurements.custodyInventory.members.pop();
    assert.equal(checkpoint.gradeTargetPair({ ...data, assertion: 'descriptorCustody', negativeControl }).verdict, 'FAIL');
});

function gradePair(positive, control, assertion) {
    return checkpoint.gradeTargetPair({ ...positive, assertion, negativeControl: {
        command: `synthetic ${assertion} control`, measurements: control.measurements, expected: control.expected,
    } });
}

function changeFacts(data, target, subjectPid, changes) {
    const snapshot = data.measurements.snapshots.find((entry) => entry.target === target && entry.pid === subjectPid);
    Object.assign(snapshot.facts, changes);
    data.measurements.observerRecords[snapshot.evidence.read - 1].factsSha256 = digest(snapshot.facts);
}

test('F1: missing and malformed status/map observations never count as opposite controls', () => {
    const positive = capture();
    const cases = [
        ['noNewPrivs', { status: {} }], ['seccompStatus', { status: {} }], ['identityCapabilities', { status: {} }],
        ['identityCapabilities', { status: { ...caps, CapBnd: 'not-a-capability-mask' } }],
        ['identityCapabilities', { uidMap: null }], ['identityCapabilities', { gidMap: [] }],
    ];
    for (const value of [undefined, null, '0', false, {}, -1, 3]) {
        cases.push(['noNewPrivs', { status: { NoNewPrivs: value } }], ['seccompStatus', { status: { Seccomp: value } }]);
    }
    for (const [assertion, childFacts] of cases) {
        const result = gradePair(positive, capture({ childFacts }), assertion);
        assert.equal(result.verdict, 'FAIL', assertion);
        assert.match(result.notes.join(' '), /evidence invalid/, 'invalid observations must be distinguished from measured opposite facts');
    }
});

test('F1: incomplete descriptor and mount/path inventories cannot satisfy controls', () => {
    const positive = capture();
    const cases = [
        ['inheritedDescriptors', { descriptors: null }], ['inheritedDescriptors', { descriptors: {} }],
        ['inheritedDescriptors', { descriptors: [{ fd: 9 }] }], ['inheritedDescriptors', { descriptors: [...stdio, stdio[0]] }],
        ['filesystemView', { mounts: null }], ['filesystemView', { mounts: [] }],
        ['filesystemView', { mounts: [{ target: '/', sourceType: 'image-root' }] }],
        ['filesystemView', { pathAttempts: null }], ['filesystemView', { pathAttempts: [] }],
        ['filesystemView', { pathAttempts: [{ path: '/worker-store', rc: -1 }, { path: '/other-home', rc: -1, errno: 'ENOENT' }] }],
    ];
    for (const [assertion, childFacts] of cases) {
        const result = gradePair(positive, capture({ childFacts }), assertion);
        assert.equal(result.verdict, 'FAIL', assertion);
        assert.match(result.notes.join(' '), /evidence invalid/);
    }
    const keeper = capture();
    changeFacts(keeper, 'keeper', 100, { limits: { nofile: {} } });
    assert.equal(gradePair(positive, keeper, 'keeperMeasurements').verdict, 'FAIL');
    const anchor = capture();
    changeFacts(anchor, 'anchor', 200, { identity: {} });
    assert.equal(gradePair(positive, anchor, 'publicIdentity').verdict, 'FAIL');
    const partialCustody = capture({ monitorDescriptors: [{ fd: 9, kind: 'directory', origin: 'inherited', authority: 'worker-store' }] });
    changeFacts(partialCustody, 'namespace-member', 201, { descriptors: null });
    assert.equal(gradePair(positive, partialCustody, 'descriptorCustody').verdict, 'FAIL', 'an early determinate leak cannot hide a later incomplete inventory');
});

test('F1 named controls: complete measured opposite status, descriptors and mounts still qualify as model controls', () => {
    const positive = capture();
    const cases = [
        ['noNewPrivs', { status: { ...caps, NoNewPrivs: 0, Seccomp: 2 } }],
        ['seccompStatus', { status: { ...caps, NoNewPrivs: 1, Seccomp: 0 } }],
        ['identityCapabilities', { status: { ...caps, CapBnd: '0000000000000001', NoNewPrivs: 1, Seccomp: 2 } }],
        ['inheritedDescriptors', { descriptors: [...stdio, { fd: 9, kind: 'directory', origin: 'inherited', authority: 'worker-store' }] }],
        ['filesystemView', { mounts: [{ target: '/worker-store', sourceType: 'host-directory', readOnly: false }] }],
    ];
    for (const [assertion, childFacts] of cases) {
        const result = gradePair(positive, capture({ childFacts }), assertion);
        assert.equal(result.verdict, 'PASS', assertion);
        assert.equal(result.qualifying, false);
    }
});

function insertObserverRecord(data, at, record) {
    const measurements = data.measurements;
    measurements.observerRecords.splice(at - 1, 0, clone(record));
    measurements.observerRecords.forEach((entry, index) => { entry.sequence = index + 1; });
    for (const references of [measurements.bindingEvidence, ...measurements.snapshots.map((entry) => entry.evidence)]) {
        for (const key of Object.keys(references)) if (references[key] >= at) references[key] += 1;
    }
    for (const key of ['before', 'after']) if (measurements.custodyInventory[key] >= at) measurements.custodyInventory[key] += 1;
}

test('F2: an unreferenced prior liveness, identity or held-reference loss stays terminal', () => {
    for (const mutate of [
        (record) => { record.alive = false; },
        (record) => { record.binding.startTime = '999'; },
        (record) => { record.binding.pidNs = '999'; },
        (record) => { record.pidfdRef = 'reopened-reference'; },
        (record) => { record.procDirectoryRef = 'reopened-proc'; },
    ]) {
        const data = capture();
        const snapshot = data.measurements.snapshots.find((entry) => entry.target === 'exec-child');
        const record = clone(data.measurements.observerRecords[snapshot.evidence.before - 1]);
        mutate(record);
        insertObserverRecord(data, snapshot.evidence.before, record);
        assert.equal(grade(data, 'noNewPrivs').verdict, 'FAIL');
        assert.equal(grade(data, 'descriptorCustody').verdict, 'FAIL', 'later good checks cannot restore lost binding');
    }
});

test('F2: unreferenced selected-child reads and namespace absence cannot be skipped', () => {
    const early = capture();
    const earlySample = early.measurements.snapshots.find((entry) => entry.target === 'exec-child');
    const earlyLoss = clone(early.measurements.observerRecords[earlySample.evidence.before - 1]);
    earlyLoss.alive = false;
    insertObserverRecord(early, early.measurements.bindingEvidence.revalidation, earlyLoss);
    assert.equal(grade(early, 'noNewPrivs').verdict, 'FAIL', 'later acquisition revalidation cannot erase an earlier observed loss');
    const read = capture();
    const sample = read.measurements.snapshots.find((entry) => entry.target === 'exec-child');
    const changedRead = clone(read.measurements.observerRecords[sample.evidence.read - 1]);
    changedRead.subject.startTime = '999';
    insertObserverRecord(read, sample.evidence.before, changedRead);
    assert.equal(grade(read, 'noNewPrivs').verdict, 'FAIL');
    const absent = capture();
    const childSample = absent.measurements.snapshots.find((entry) => entry.target === 'exec-child');
    const inventory = clone(absent.measurements.observerRecords[absent.measurements.custodyInventory.before - 1]);
    inventory.members = inventory.members.filter((member) => member.pid !== absent.child.pid);
    insertObserverRecord(absent, childSample.evidence.before, inventory);
    assert.equal(grade(absent, 'noNewPrivs').verdict, 'FAIL');
});

test('F2 named controls: post-observation death preserves earlier facts; unrelated member subjects do not replace the binding', () => {
    const late = capture();
    const sample = late.measurements.snapshots.find((entry) => entry.target === 'exec-child');
    const lost = clone(late.measurements.observerRecords[sample.evidence.after - 1]);
    lost.alive = false;
    insertObserverRecord(late, sample.evidence.after + 1, lost);
    assert.equal(grade(late, 'noNewPrivs').verdict, 'PASS', 'completed observation remains valid before a later death');
    assert.equal(grade(late, 'descriptorCustody').verdict, 'FAIL', 'later observations remain fenced');
    const member = capture();
    const childSample = member.measurements.snapshots.find((entry) => entry.target === 'exec-child');
    const other = clone(member.measurements.observerRecords[childSample.evidence.before - 1]);
    other.target = 'namespace-member';
    other.subject = clone(member.anchor);
    insertObserverRecord(member, childSample.evidence.before, other);
    assert.equal(grade(member, 'noNewPrivs').verdict, 'PASS', 'monitor subject is distinct from the still-valid selected binding');
});

test('registered collectors block with absent inputs and with fabricated complete runtime inputs', async () => {
    const complete = { targetingVersion: checkpoint.TARGETING_VERSION, ...Object.fromEntries(
        ['observerArtifactSha256', 'runtimePolicySha256', 'imageSha256', 'nodeSha256', 'nativeSha256'].map((name) => [name, 'a'.repeat(64)])) };
    for (const id of checkpoint.S1_REQUIRED) {
        const probe = checkpoint.createFirstCheckpointProbe(id);
        for (const captureInputs of [undefined, complete]) {
            const result = await probe.collect({ captureInputs, stdinJson: { observed: true, expectedMet: true } });
            const record = buildRecord({ probeId: id, stage: 'S1', candidateIdentitySha256: 'c'.repeat(64), command: 'synthetic',
                startedAt: 'synthetic', expected: probe.expected, ...result }, probe.grade);
            assert.equal(record.verdict, 'BLOCKED');
            assert.equal(checkpoint.checkCoverage(id, record.measurements.subcheckCoverage).ok, true);
        }
        assert.equal(probe.grade({ expectedMet: true }, { observed: true }).expectedMet, false);
    }
});

test('registry preserves S0; the harness writes blocked S1 records with all deferred coverage', async (t) => {
    assert.deepEqual(STAGE_REQUIRED.S0, ['T0-01', 'T0-02', 'T0-03', 'T0-04']);
    assert.deepEqual(STAGE_REQUIRED.S1, checkpoint.S1_REQUIRED);
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'g1-coverage-model-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    writeIdentity({ run: '012345abcdef', stage: 'S1', out: directory, inputs: { synthetic: true } });
    for (const id of STAGE_REQUIRED.S1) {
        assert.equal(PROBES[id].id, id);
        const result = await runProbe({ probeId: id, run: '012345abcdef', stage: 'S1', out: directory, stdinJson: { verdict: 'PASS' } });
        assert.equal(result.record.verdict, 'BLOCKED');
        assert.equal(checkpoint.checkCoverage(id, result.record.measurements.subcheckCoverage).ok, true);
    }
});

async function mutatedSource(replacements) {
    const url = new URL('../probes/firstCheckpoint.mjs', import.meta.url);
    let source = fs.readFileSync(url, 'utf8');
    for (const [before, after] of replacements) {
        assert.equal(source.split(before).length, 2, 'mutant must change exactly one source site');
        source = source.replace(before, after);
    }
    source = source.replace("'../lib/record.mjs'", JSON.stringify(new URL('../lib/record.mjs', import.meta.url).href));
    return import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
}

test('source mutant substituting anchor facts is killed by the child counterprobes', async () => {
    const mutant = await mutatedSource([["const target = TARGET_TABLE[assertion]?.[0];", "const target = TARGET_TABLE[assertion]?.[0] === 'exec-child' ? 'anchor' : TARGET_TABLE[assertion]?.[0];"]]);
    assert.throws(() => assertChildConfinement(mutant), assert.AssertionError);
});

test('source mutant dropping deferred entries is killed by explicit coverage assertions', async () => {
    const mutant = await mutatedSource([["...definition.deferred.map(({ id, stage }) => ({ id, scope: 'deferred', deferredTo: stage, status: 'NOT-RUN', reason: `Deferred to ${stage} by A1` }))", '...[]']]);
    assert.throws(() => {
        assert.ok(mutant.pendingCoverage('G1-03').some((entry) => entry.id === 'file-server.userns-denial'));
        assert.ok(mutant.pendingCoverage('G1-27').some((entry) => entry.id === 'terminal.tool-immutability'));
    }, assert.AssertionError);
});

test('source mutant rediscovering a child after binding loss is killed by the replacement counterprobe', async () => {
    const mutant = await mutatedSource([
        ["const subject = target === 'exec-child' ? validated.child : target === 'anchor' ? validated.anchor : expected.keeper;",
            "const subject = target === 'exec-child' ? validated.read(validated.measurements.snapshots.find((entry) => entry.target === target).evidence.read, 'snapshot-read').subject : target === 'anchor' ? validated.anchor : expected.keeper;"],
        ['sameChild(record.binding, child) && record.alive === true', 'sameChild(record.binding, record.subject ?? child) && record.alive === true'],
        ['validated.checkChild(after);\n    validated.validateThrough(after.sequence);', 'validated.checkChild(after);'],
    ]);
    const data = capture();
    replaceSnapshot(data);
    assert.equal(grade(data, 'noNewPrivs').verdict, 'FAIL');
    assert.throws(() => assert.equal(grade(data, 'noNewPrivs', mutant).verdict, 'FAIL'), assert.AssertionError);
});
