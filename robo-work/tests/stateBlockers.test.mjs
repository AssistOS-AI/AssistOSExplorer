import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';
import { runtimeUnavailable } from '../server/workerState.mjs';
import {
    admitRequest, count, endAttempt, expectCode, locatorFor, makeTempDir, newId, openStore, rawDb, readyRobot,
    robotConfig, syntheticContext, syntheticRuntime
} from './helpers/synthetic.mjs';

const ADMIN = () => syntheticContext({ administrator: true });
const EVIDENCE = crypto.createHash('sha256').update('synthetic operator evidence').digest('hex');

// Admitted, running attempt on a ready robot (synthetic).
function running(store, context) {
    const robotId = readyRobot(store, context);
    const admitted = store.admit(context, admitRequest(robotId, {}, context));
    store.transitionAttempt({ executionId: admitted.executionId, attemptId: admitted.attemptId, expectedState: 'queued', nextState: 'running' });
    return { robotId, admitted };
}

function reserveFor(store, { robotId, admitted }, extra = {}) {
    return store.reserveResource({
        robotId, executionId: admitted.executionId, attemptId: admitted.attemptId, kind: 'workdir', locator: locatorFor('workdir'), ...extra
    });
}

function view(store, context, admitted) {
    return store.getReference(context, { referenceId: admitted.reference.id });
}

test('blocker transitions: reserve, commit once, release or quarantine, and nothing leaves a terminal state', (t) => {
    const dir = makeTempDir(t);
    const store = openStore(dir);
    const generationId = store.generationId;
    const settle = (id, outcome) => store.settleResource({ resourceId: id, generationId, outcome });
    // a reserved blocker is released by locator alone
    const alone = store.reserveResource({ kind: 'mount', locator: locatorFor('mount') }).resourceId;
    assert.equal(store.getResource({ resourceId: alone }).state, 'reserved');
    assert.equal(settle(alone, 'released').state, 'released');
    expectCode(assert, () => store.commitResource({ resourceId: alone, identity: { id: 1 } }), 'operation_conflict');
    expectCode(assert, () => settle(alone, 'quarantined'), 'operation_conflict');
    // commit writes the identity once
    const committed = store.reserveResource({ kind: 'mount', locator: locatorFor('mount') }).resourceId;
    store.commitResource({ resourceId: committed, identity: { mountId: 7, ns: 99 } });
    const row = store.getResource({ resourceId: committed });
    assert.deepEqual([row.state, row.identity], ['committed', { mountId: 7, ns: 99 }]);
    expectCode(assert, () => store.commitResource({ resourceId: committed, identity: { mountId: 8 } }), 'operation_conflict');
    expectCode(assert, () => store.commitResource({ resourceId: newId(), identity: { a: 1 } }), 'not_found');
    expectCode(assert, () => store.commitResource({ resourceId: committed, identity: {} }), 'invalid_request');
    assert.equal(settle(committed, 'quarantined').state, 'quarantined');
    assert.equal(settle(committed, 'quarantined').state, 'quarantined', 'idempotent');
    expectCode(assert, () => settle(committed, 'released'), 'operation_conflict');
    expectCode(assert, () => store.settleResource({ resourceId: committed, generationId, outcome: 'released_by_operator' }), 'invalid_request');
    expectCode(assert, () => store.settleResource({ resourceId: newId(), generationId, outcome: 'released' }), 'not_found');
    expectCode(assert, () => store.settleResource({ resourceId: committed, generationId: newId(), outcome: 'released' }), 'not_found');
    // a committed blocker can still be released
    const later = store.reserveResource({ kind: 'cgroup', locator: locatorFor('cgroup') }).resourceId;
    store.commitResource({ resourceId: later, identity: { cgroupId: 5 } });
    assert.equal(settle(later, 'released').state, 'released');
    store.close();
});

test('blocker transitions are enforced in the database as well', (t) => {
    const dir = makeTempDir(t);
    const store = openStore(dir);
    const generationId = store.generationId;
    const reserved = store.reserveResource({ kind: 'mount', locator: { dir: 'a' } }).resourceId;
    const committed = store.reserveResource({ kind: 'mount', locator: { dir: 'b' } }).resourceId;
    store.commitResource({ resourceId: committed, identity: { id: 1 } });
    const quarantined = store.reserveResource({ kind: 'mount', locator: { dir: 'c' } }).resourceId;
    store.quarantineResource({ resourceId: quarantined, generationId });
    const released = store.reserveResource({ kind: 'mount', locator: { dir: 'd' } }).resourceId;
    store.releaseResource({ resourceId: released, generationId });
    const db = rawDb(dir);
    const attempt = (sql, id) => assert.throws(() => db.prepare(sql).run(id), /immutable|constraint/i, sql);
    attempt("UPDATE resource_blocker SET locator = '{}' WHERE resource_id = ?", reserved);
    attempt("UPDATE resource_blocker SET locator = '{}' WHERE resource_id = ?", committed);
    attempt("UPDATE resource_blocker SET identity = '{\"x\":1}' WHERE resource_id = ?", reserved);
    attempt("UPDATE resource_blocker SET identity = '{\"x\":2}' WHERE resource_id = ?", committed);
    attempt("UPDATE resource_blocker SET release_state = 'committed' WHERE resource_id = ?", reserved);
    attempt("UPDATE resource_blocker SET release_state = 'reserved' WHERE resource_id = ?", committed);
    attempt("UPDATE resource_blocker SET release_state = 'released_by_operator' WHERE resource_id = ?", committed);
    attempt("UPDATE resource_blocker SET release_state = 'released_by_operator' WHERE resource_id = ?", reserved);
    attempt("UPDATE resource_blocker SET release_state = 'released' WHERE resource_id = ?", quarantined);
    attempt("UPDATE resource_blocker SET release_state = 'quarantined' WHERE resource_id = ?", released);
    attempt("UPDATE resource_blocker SET release_state = 'released_by_operator' WHERE resource_id = ?", released);
    attempt("UPDATE resource_blocker SET retained = 0, kind = 'other' WHERE resource_id = ?", reserved);
    attempt("UPDATE resource_blocker SET robot_id = NULL, attempt_id = 'x' WHERE resource_id = ?", reserved);
    attempt('DELETE FROM resource_blocker WHERE resource_id = ?', released);
    assert.throws(() => db.prepare("UPDATE resource_blocker SET release_state = 'bogus' WHERE resource_id = ?").run(reserved), /constraint|immutable/i);
    assert.throws(() => db.prepare("UPDATE resource_blocker SET release_state = 'committed' WHERE resource_id = ?").run(reserved), /immutable|constraint/i);
    db.close();
    store.close();
});

test('a process-bearing reservation records its marker in the immutable locator; a caller cannot forge one', (t) => {
    const dir = makeTempDir(t);
    const store = openStore(dir);
    const plain = store.reserveResource({ kind: 'runtime-dir', locator: { dir: 'x' } });
    assert.deepEqual(plain.locator, { dir: 'x' });
    const bearing = store.reserveResource({ kind: 'keeper', processBearing: true, locator: { cgroup: 'x-1' } });
    assert.deepEqual(bearing.locator, { cgroup: 'x-1', marker: bearing.resourceId });
    const stored = store.getResource({ resourceId: bearing.resourceId });
    assert.deepEqual([stored.processBearing, stored.locator.marker], [true, bearing.resourceId]);
    expectCode(assert, () => store.reserveResource({ kind: 'keeper', processBearing: true, locator: { marker: newId() } }), 'invalid_request');
    expectCode(assert, () => store.reserveResource({ kind: 'keeper', locator: { marker: 'x' } }), 'invalid_request');
    expectCode(assert, () => store.reserveResource({ kind: 'keeper', locator: 'dir' }), 'invalid_request');
    expectCode(assert, () => store.reserveResource({ kind: 'keeper' }), 'invalid_request');
    expectCode(assert, () => store.reserveResource({ kind: 'preparation', locator: locatorFor('x') }), 'invalid_request');
    expectCode(assert, () => store.reserveResource({ kind: 'Bad Kind', locator: locatorFor('x') }), 'invalid_request');
    expectCode(assert, () => store.reserveResource({ kind: 'keeper', locator: { big: 'x'.repeat(5000) } }), 'invalid_request');
    // reservation IDs are random and cannot be supplied
    expectCode(assert, () => store.reserveResource({ kind: 'mount', locator: locatorFor('x'), resourceId: newId() }), 'invalid_request');
    const ids = new Set();
    for (let i = 0; i < 20; i += 1) ids.add(store.reserveResource({ kind: 'mount', locator: locatorFor('x') }).resourceId);
    assert.equal(ids.size, 20);
    const db = rawDb(dir);
    assert.throws(() => db.prepare('INSERT INTO resource_blocker (resource_id, generation_id, kind, process_bearing, locator, locator_base, release_state, created_at) SELECT ?, generation_id, kind, process_bearing, locator, locator_base, release_state, created_at FROM resource_blocker LIMIT 1').run('AAAAAAAAAAAAAAAAAAAAAA'), /constraint/i);
    db.close();
    store.close();
});

test('an uncommitted process-bearing reservation is released when no marker-bearing /proc entry and no committed keeper identity remain', (t) => {
    const dir = makeTempDir(t);
    const store = openStore(dir);
    const generationId = store.generationId;
    // synthetic /proc: a list of command lines plus a set of live keeper identities
    const proc = { cmdlines: [], keepers: new Set() };
    const walk = (resourceId) => {
        const blocker = store.getResource({ resourceId });
        const markerPresent = proc.cmdlines.some((line) => line.includes(blocker.locator.marker));
        const keeperPresent = blocker.identity !== null && proc.keepers.has(JSON.stringify(blocker.identity));
        return store.settleResource({ resourceId, generationId, outcome: markerPresent || keeperPresent ? 'quarantined' : 'released' });
    };
    const survived = store.reserveResource({ kind: 'keeper', processBearing: true, locator: { cgroup: 'a' } }).resourceId;
    proc.cmdlines.push(`/usr/bin/bwrap --hostname ${survived} --args 3`);
    assert.equal(walk(survived).state, 'quarantined');
    const gone = store.reserveResource({ kind: 'keeper', processBearing: true, locator: { cgroup: 'b' } }).resourceId;
    assert.equal(store.getResource({ resourceId: gone }).identity, null);
    assert.equal(walk(gone).state, 'released');
    store.close();
});

test('a reservation for an attempt is refused after beginAttemptEnd, while robot and worker scoped reservations stay possible', (t) => {
    const dir = makeTempDir(t);
    const store = openStore(dir);
    const context = syntheticContext();
    const fixture = running(store, context);
    const blocker = reserveFor(store, fixture);
    endAttempt(store, context, fixture.admitted, 'completed', { expectedState: 'running' });
    expectCode(assert, () => reserveFor(store, fixture), 'operation_conflict');
    assert.equal(store.reserveResource({ robotId: fixture.robotId, kind: 'view', locator: locatorFor('view') }).resourceId.length, 22);
    assert.equal(store.reserveResource({ kind: 'cache', locator: locatorFor('cache') }).resourceId.length, 22);
    store.releaseResource({ resourceId: blocker.resourceId, generationId: store.generationId });
    expectCode(assert, () => reserveFor(store, fixture), 'operation_conflict');
    expectCode(assert, () => store.reserveResource({ executionId: fixture.admitted.executionId, kind: 'x', locator: locatorFor('x') }), 'invalid_request');
    expectCode(assert, () => store.reserveResource({ robotId: newId(), kind: 'x', locator: locatorFor('x') }), 'not_found');
    store.close();
});

test('a queued attempt with no blocker that is cancelled publishes exactly once from the beginAttemptEnd transaction', (t) => {
    const dir = makeTempDir(t);
    const store = openStore(dir);
    const context = syntheticContext();
    const robotId = readyRobot(store, context);
    const admitted = store.admit(context, admitRequest(robotId, {}, context));
    const ended = endAttempt(store, context, admitted, 'cancelled', { outputText: 'never ran', data: { why: 'user' } });
    assert.deepEqual([ended.state, ended.cleanup], ['cancelled', null]);
    const published = view(store, context, admitted);
    assert.deepEqual(published.result, { status: 'cancelled', cleanup: 'released', outputText: 'never ran', data: { why: 'user' } });
    assert.equal(typeof store.settleAttempt, 'undefined', 'settleAttempt has no public signature');
    expectCode(assert, () => endAttempt(store, context, admitted, 'failed'), 'operation_conflict');
    assert.deepEqual(view(store, context, admitted).result, published.result);
    // settling a blocker of an already settled attempt publishes nothing
    const db = rawDb(dir, { readOnly: true });
    assert.equal(db.prepare('SELECT COUNT(*) AS c FROM admission WHERE result IS NOT NULL').get().c, 1);
    db.close();
    store.close();
});

test('a stopping reference stays non-terminal until its last blocker settles, then publishes the persisted payload once, also after reopen', (t) => {
    const dir = makeTempDir(t);
    let store = openStore(dir);
    const context = syntheticContext();
    const fixture = running(store, context);
    const first = reserveFor(store, fixture).resourceId;
    const second = reserveFor(store, fixture, { kind: 'mount' }).resourceId;
    const generationId = store.generationId;
    const ended = endAttempt(store, context, fixture.admitted, 'completed', { expectedState: 'running', outputText: 'final text', data: { rows: [1, 2] } });
    assert.deepEqual([ended.state, ended.cleanup], ['stopping', 'pending']);
    let seen = view(store, context, fixture.admitted);
    assert.deepEqual([seen.state, seen.cleanup, seen.result], ['stopping', 'pending', null]);
    store.releaseResource({ resourceId: first, generationId });
    seen = view(store, context, fixture.admitted);
    assert.deepEqual([seen.state, seen.result], ['stopping', null]);
    expectCode(assert, () => endAttempt(store, context, fixture.admitted, 'failed', { expectedState: 'running' }), 'operation_conflict');
    store.close();
    store = openStore(dir, { create: false });
    seen = view(store, context, fixture.admitted);
    assert.deepEqual([seen.state, seen.result], ['stopping', null]);
    store.releaseResource({ resourceId: second, generationId });
    seen = view(store, context, fixture.admitted);
    assert.deepEqual(seen.result, { status: 'completed', cleanup: 'released', outputText: 'final text', data: { rows: [1, 2] } });
    assert.deepEqual(store.releaseResource({ resourceId: second, generationId }), { resourceId: second, state: 'released' });
    assert.deepEqual(view(store, context, fixture.admitted).result, seen.result);
    store.close();
});

test('a failed release that becomes quarantined publishes with cleanup quarantined', (t) => {
    const dir = makeTempDir(t);
    const store = openStore(dir);
    const context = syntheticContext();
    const fixture = running(store, context);
    const blocker = reserveFor(store, fixture).resourceId;
    endAttempt(store, context, fixture.admitted, 'failed', { expectedState: 'running', outputText: 'partial' });
    store.quarantineResource({ resourceId: blocker, generationId: store.generationId });
    const published = view(store, context, fixture.admitted);
    assert.deepEqual(published.result, { status: 'failed', cleanup: 'quarantined', outputText: 'partial', data: { n: 1 } });
    assert.equal(published.cleanup, 'quarantined');
    store.close();
});

test('a blocker settlement never settles an attempt that is not stopping', (t) => {
    const dir = makeTempDir(t);
    const store = openStore(dir);
    const context = syntheticContext();
    const fixture = running(store, context);
    const blocker = reserveFor(store, fixture).resourceId;
    store.releaseResource({ resourceId: blocker, generationId: store.generationId });
    const seen = view(store, context, fixture.admitted);
    assert.deepEqual([seen.state, seen.result], ['running', null]);
    store.close();
});

test('retained blockers transfer in the transaction and do not delay settlement; they keep blocking deletion', (t) => {
    const dir = makeTempDir(t);
    const store = openStore(dir);
    const context = syntheticContext();
    const fixture = running(store, context);
    const transient = reserveFor(store, fixture).resourceId;
    const gui = reserveFor(store, fixture, { kind: 'gui' }).resourceId;
    endAttempt(store, context, fixture.admitted, 'completed', { expectedState: 'running' });
    store.releaseResource({ resourceId: transient, generationId: store.generationId });
    assert.equal(view(store, context, fixture.admitted).state, 'stopping');
    assert.deepEqual(store.retainResource({ resourceId: gui }), { resourceId: gui, retained: true });
    assert.deepEqual([view(store, context, fixture.admitted).state, view(store, context, fixture.admitted).cleanup], ['completed', 'released']);
    expectCode(assert, () => store.beginDelete(context, { operationId: newId(), robotId: fixture.robotId, expectedRevision: 1 }), 'robot_busy');
    expectCode(assert, () => store.configure(context, { operationId: newId(), robotId: fixture.robotId, expectedRevision: 1, configuration: robotConfig({}, 'other') }), 'robot_busy');
    expectCode(assert, () => store.retainResource({ resourceId: newId() }), 'not_found');
    expectCode(assert, () => store.retainResource({ resourceId: transient }), 'operation_conflict');
    expectCode(assert, () => store.retainResource({ resourceId: store.reserveResource({ kind: 'cache', locator: locatorFor('x') }).resourceId }), 'invalid_request');
    store.releaseResource({ resourceId: gui, generationId: store.generationId });
    assert.equal(store.beginDelete(context, { operationId: newId(), robotId: fixture.robotId, expectedRevision: 1 }).status, 'accepted');
    store.close();
});

test('termination_unverified takes precedence for a quarantined process tree and retains classification, outputText and data', (t) => {
    const dir = makeTempDir(t);
    const store = openStore(dir);
    const context = syntheticContext();
    const robotId = readyRobot(store, context);
    const results = [];
    for (const classification of ['completed', 'cancelled']) {
        const admitted = store.admit(context, admitRequest(robotId, {}, context));
        const blocker = store.reserveResource({ robotId, executionId: admitted.executionId, attemptId: admitted.attemptId, kind: 'process-tree', processBearing: true, locator: locatorFor('pt') }).resourceId;
        endAttempt(store, context, admitted, classification, { outputText: `text ${classification}`, data: { c: classification } });
        assert.equal(view(store, context, admitted).result, null);
        store.quarantineResource({ resourceId: blocker, generationId: store.generationId });
        results.push(view(store, context, admitted).result);
        // the robot is nonready while the quarantine stands; clear it to continue
        const cleared = store.clearQuarantine(ADMIN(), { operationId: newId(), resourceId: blocker, attestation: EVIDENCE });
        assert.equal(cleared.state, 'released_by_operator');
        store.attestReadiness(context, { robotId });
    }
    assert.deepEqual(results[0], { status: 'failed', reason: 'termination_unverified', classification: 'completed', cleanup: 'quarantined', outputText: 'text completed', data: { c: 'completed' } });
    assert.deepEqual(results[1], { status: 'failed', reason: 'termination_unverified', classification: 'cancelled', cleanup: 'quarantined', outputText: 'text cancelled', data: { c: 'cancelled' } });
    // a non-process-tree quarantine keeps the recorded status
    const admitted = store.admit(context, admitRequest(robotId, {}, context));
    const mount = store.reserveResource({ robotId, executionId: admitted.executionId, attemptId: admitted.attemptId, kind: 'mount', locator: { m: 1 } }).resourceId;
    endAttempt(store, context, admitted, 'completed');
    store.quarantineResource({ resourceId: mount, generationId: store.generationId });
    assert.deepEqual([view(store, context, admitted).result.status, view(store, context, admitted).result.cleanup], ['completed', 'quarantined']);
    assert.equal(view(store, context, admitted).result.reason, undefined);
    store.close();
});

test('a quarantine recorded on a normal end path refuses the owning robot only, and clearQuarantine ends the effects', (t) => {
    const dir = makeTempDir(t);
    const runtime = syntheticRuntime();
    const store = openStore(dir, { runtime });
    const context = syntheticContext();
    const fixture = running(store, context);
    const other = readyRobot(store, context);
    const blocker = reserveFor(store, fixture, { kind: 'mount' }).resourceId;
    endAttempt(store, context, fixture.admitted, 'completed', { expectedState: 'running' });
    store.quarantineResource({ resourceId: blocker, generationId: store.generationId });
    expectCode(assert, () => store.admit(context, admitRequest(fixture.robotId, {}, context)), 'resource_quarantined');
    expectCode(assert, () => store.configure(context, { operationId: newId(), robotId: fixture.robotId, expectedRevision: 1, configuration: robotConfig({ a: 1 }) }), 'resource_quarantined');
    expectCode(assert, () => store.attestReadiness(context, { robotId: fixture.robotId }), 'resource_quarantined');
    const robot = store.getRobot(context, { robotId: fixture.robotId });
    assert.deepEqual([robot.ready, robot.reason], [false, 'resource_quarantined']);
    assert.equal(store.admit(context, admitRequest(other, {}, context)).status, 'admitted', 'another robot still admits');
    assert.equal(store.getWorkerStatus().degraded, false, 'an owned quarantine does not degrade the worker');
    // M-29: a robot with a quarantined blocker cannot be deleted (robot_busy) until the quarantine is cleared.
    expectCode(assert, () => store.beginDelete(context, { operationId: newId(), robotId: fixture.robotId, expectedRevision: 1 }), 'robot_busy');
    const clearOp = newId();
    const cleared = store.clearQuarantine(ADMIN(), { operationId: clearOp, resourceId: blocker, attestation: EVIDENCE });
    assert.deepEqual(cleared, { operationId: clearOp, type: 'clear_quarantine', resourceId: blocker, state: 'released_by_operator' });
    assert.equal(store.getResource({ resourceId: blocker }).state, 'released_by_operator');
    const deleteOp = newId();
    store.beginDelete(context, { operationId: deleteOp, robotId: fixture.robotId, expectedRevision: 1 });
    assert.equal(store.completeDelete(context, { operationId: deleteOp }).status, 'succeeded');
    assert.equal(store.getRobot(context, { robotId: fixture.robotId }).lifecycle, 'deleted');
    store.close();
});

test('clearQuarantine: audit, replay, retired IDs, fresh attestation, administrator and adapter preconditions', (t) => {
    const dir = makeTempDir(t);
    const runtime = syntheticRuntime();
    const store = openStore(dir, { runtime });
    const context = syntheticContext();
    const fixture = running(store, context);
    const blocker = store.reserveResource({ robotId: fixture.robotId, kind: 'keeper', processBearing: true, locator: { cg: 'k' } }).resourceId;
    const plain = store.reserveResource({ robotId: fixture.robotId, kind: 'mount', locator: { m: 1 } }).resourceId;
    store.commitResource({ resourceId: plain, identity: { mountId: 3 } });
    store.quarantineResource({ resourceId: blocker, generationId: store.generationId });
    store.quarantineResource({ resourceId: plain, generationId: store.generationId });
    const request = { operationId: newId(), resourceId: blocker, attestation: EVIDENCE };
    // forbidden for a non-administrator and for a context without the operation
    expectCode(assert, () => store.clearQuarantine(syntheticContext(), request), 'forbidden');
    expectCode(assert, () => store.clearQuarantine(syntheticContext({ administrator: true, operations: ['read'] }), request), 'forbidden');
    expectCode(assert, () => store.clearQuarantine({ ...ADMIN() }, request), 'forbidden');
    assert.equal(runtime.verifyCalls.length, 0);
    // shape, unknown, not quarantined
    expectCode(assert, () => store.clearQuarantine(ADMIN(), { ...request, attestation: 'not a digest' }), 'invalid_request');
    expectCode(assert, () => store.clearQuarantine(ADMIN(), { ...request, extra: 1 }), 'invalid_request');
    expectCode(assert, () => store.clearQuarantine(ADMIN(), { ...request, resourceId: newId() }), 'not_found');
    const live = store.reserveResource({ kind: 'cache', locator: locatorFor('x') }).resourceId;
    expectCode(assert, () => store.clearQuarantine(ADMIN(), { ...request, resourceId: live }), 'operation_conflict');
    // while the adapter reports presence
    runtime.absence = () => false;
    expectCode(assert, () => store.clearQuarantine(ADMIN(), request), 'resource_present');
    assert.equal(store.getResource({ resourceId: blocker }).state, 'quarantined');
    runtime.absence = () => null;
    expectCode(assert, () => store.clearQuarantine(ADMIN(), request), 'runtime_unavailable');
    runtime.absence = (info) => info.resourceId === blocker || info.resourceId === plain;
    runtime.verifyCalls.length = 0;
    const done = store.clearQuarantine(ADMIN(), request);
    assert.equal(done.state, 'released_by_operator');
    const info = runtime.verifyCalls[0];
    assert.deepEqual([info.resourceId, info.processBearing, info.committed, info.marker, info.locator.marker], [blocker, true, false, blocker, blocker]);
    // receipt replay first: the adapter is not consulted again
    assert.deepEqual(store.clearQuarantine(ADMIN(), request), done);
    assert.equal(runtime.verifyCalls.length, 1);
    expectCode(assert, () => store.clearQuarantine(ADMIN(), { ...request, attestation: crypto.createHash('sha256').update('x').digest('hex') }), 'operation_conflict');
    expectCode(assert, () => store.clearQuarantine(ADMIN(), { ...request, operationId: newId() }), 'operation_conflict');
    // audit record and retired ID
    const db = rawDb(dir);
    const audit = db.prepare('SELECT * FROM quarantine_audit WHERE resource_id = ?').get(blocker);
    assert.deepEqual([audit.operation_id, audit.actor, audit.evidence_digest, typeof audit.cleared_at], [request.operationId, 'owner-synthetic-a', EVIDENCE, 'number']);
    assert.throws(() => db.exec("UPDATE quarantine_audit SET actor = 'x'"), /immutable/);
    assert.throws(() => db.exec('DELETE FROM quarantine_audit'), /immutable/);
    db.close();
    // the cleared locator is retired as well
    expectCode(assert, () => store.reserveResource({ kind: 'keeper', processBearing: true, locator: { cg: 'k' } }), 'operation_conflict');
    expectCode(assert, () => store.reserveResource({ kind: 'mount', locator: { m: 1 } }), 'operation_conflict');
    // the committed blocker's identity is passed to the adapter
    store.clearQuarantine(ADMIN(), { operationId: newId(), resourceId: plain, attestation: EVIDENCE });
    assert.deepEqual([runtime.verifyCalls[1].committed, runtime.verifyCalls[1].identity], [true, { mountId: 3 }]);
    // the robot needs a fresh readiness attestation
    assert.equal(store.getRobot(context, { robotId: fixture.robotId }).ready, false);
    store.attestReadiness(context, { robotId: fixture.robotId });
    assert.equal(store.getRobot(context, { robotId: fixture.robotId }).ready, true);
    store.close();
});

test('clearQuarantine through the default runtime is refused, and an uncommitted process-bearing marker check decides presence', (t) => {
    const dir = makeTempDir(t);
    let store = openStore(dir);
    const blocker = store.reserveResource({ kind: 'keeper', processBearing: true, locator: { cg: 'k' } }).resourceId;
    store.quarantineResource({ resourceId: blocker, generationId: store.generationId });
    const request = { operationId: newId(), resourceId: blocker, attestation: EVIDENCE };
    store.close();
    store = openStore(dir, { create: false, runtime: runtimeUnavailable });
    expectCode(assert, () => store.clearQuarantine(ADMIN(), request), 'runtime_unavailable');
    store.close();
    // the same marker check as the transition table, over a synthetic /proc
    const proc = [`/usr/bin/bwrap --hostname ${blocker} --args 3`];
    const runtime = syntheticRuntime({ absence: (info) => !proc.some((line) => line.includes(info.marker)) });
    store = openStore(dir, { create: false, runtime });
    expectCode(assert, () => store.clearQuarantine(ADMIN(), request), 'resource_present');
    proc.length = 0;
    assert.equal(store.clearQuarantine(ADMIN(), request).state, 'released_by_operator');
    store.close();
});

test('clearQuarantine is a compare-and-set on still-quarantined and on the current generation', (t) => {
    const dir = makeTempDir(t);
    const runtime = syntheticRuntime();
    const store = openStore(dir, { runtime });
    const racer = openStore(dir, { create: false, runtime: syntheticRuntime() });
    const blocker = store.reserveResource({ kind: 'mount', locator: locatorFor('x') }).resourceId;
    store.quarantineResource({ resourceId: blocker, generationId: store.generationId });
    // another operation clears it while the adapter call is outside the transaction
    runtime.absence = () => {
        racer.clearQuarantine(ADMIN(), { operationId: newId(), resourceId: blocker, attestation: EVIDENCE });
        return true;
    };
    expectCode(assert, () => store.clearQuarantine(ADMIN(), { operationId: newId(), resourceId: blocker, attestation: EVIDENCE }), 'operation_conflict');
    assert.equal(count(dir, 'quarantine_audit'), 1);
    // a rollover during the adapter call fences the writer
    const second = store.reserveResource({ kind: 'mount', locator: locatorFor('x') }).resourceId;
    store.quarantineResource({ resourceId: second, generationId: store.generationId });
    runtime.absence = () => {
        racer.beginGenerationRecovery(racer.generationId);
        return true;
    };
    expectCode(assert, () => store.clearQuarantine(ADMIN(), { operationId: newId(), resourceId: second, attestation: EVIDENCE }), 'stale_generation');
    assert.equal(store.getResource({ resourceId: second }).state, 'quarantined');
    // an old writer is refused before the adapter is consulted
    runtime.verifyCalls.length = 0;
    expectCode(assert, () => store.clearQuarantine(ADMIN(), { operationId: newId(), resourceId: second, attestation: EVIDENCE }), 'stale_generation');
    assert.equal(runtime.verifyCalls.length, 0);
    store.close();
    racer.close();
});

test('a quarantined worker-scoped blocker marks the worker degraded and refuses only operations needing its kind', (t) => {
    const dir = makeTempDir(t);
    const runtime = syntheticRuntime({ required: { admit: ['gpu'], provision: ['gpu'], configure: ['cpu'] } });
    const store = openStore(dir, { runtime });
    const context = syntheticContext();
    const robotId = readyRobot(store, context);
    assert.deepEqual(store.getWorkerStatus().degraded, false);
    const gpu = store.reserveResource({ kind: 'gpu', locator: locatorFor('gpu') }).resourceId;
    store.quarantineResource({ resourceId: gpu, generationId: store.generationId });
    assert.deepEqual([store.getWorkerStatus().degraded, store.getWorkerStatus().degradedKinds], [true, ['gpu']]);
    expectCode(assert, () => store.admit(context, admitRequest(robotId, {}, context)), 'resource_quarantined');
    expectCode(assert, () => store.beginProvision(context, { operationId: newId(), name: 'n', configuration: robotConfig() }), 'resource_quarantined');
    // an operation that does not need the kind proceeds; the robot itself is not quarantined
    const operationId = newId();
    store.configure(context, { operationId, robotId, expectedRevision: 1, configuration: robotConfig({ a: 1 }) });
    store.completePreparation(context, { operationId, outcome: 'succeeded' });
    assert.equal(store.getRobot(context, { robotId }).ready, true);
    runtime.required = { admit: ['cpu'] };
    assert.equal(store.admit(context, admitRequest(robotId, { configRevision: 2 }, context)).status, 'admitted');
    runtime.required = { admit: ['gpu'] };
    store.clearQuarantine(ADMIN(), { operationId: newId(), resourceId: gpu, attestation: EVIDENCE });
    assert.deepEqual([store.getWorkerStatus().degraded, store.getWorkerStatus().degradedKinds], [false, []]);
    assert.equal(store.admit(context, admitRequest(robotId, { configRevision: 2 }, context)).status, 'admitted');
    store.close();
});

// ---- Step D fixes (F1-F6, D1, D2) --------------------------------------------------

import { raceChildren } from './helpers/childRunner.mjs';
import { canonicalJson } from '../server/stateProtocol.mjs';
import { mapError } from '../server/stateDatabase.mjs';
import { openStorage } from '../server/stateDatabase.mjs';
import { WORKSPACE, PROVIDER } from './helpers/synthetic.mjs';

const CONTEXT_FIELDS = {
    workspaceId: WORKSPACE, scope: 'scope-synthetic-a', ownerId: 'owner-synthetic-a',
    operations: ['provision', 'configure', 'delete', 'admit', 'lookup', 'read', 'attest', 'adapter_complete', 'administer'],
    originNamespace: 'mcp', originKey: 'user:synthetic-a', administrator: true
};

test('F1: a process-bearing or process-tree blocker can never be retained, at reserve or afterwards', (t) => {
    const dir = makeTempDir(t);
    const store = openStore(dir);
    const context = syntheticContext();
    const fixture = running(store, context);
    // reserve-time retention is refused for an attempt's blocker, for process-bearing and for process-tree
    for (const extra of [{ executionId: fixture.admitted.executionId, attemptId: fixture.admitted.attemptId }, { processBearing: true }, { kind: 'process-tree' }]) {
        expectCode(assert, () => store.reserveResource({ robotId: fixture.robotId, kind: 'gui', locator: locatorFor('gui'), retained: true, ...extra }), 'invalid_request');
    }
    // a later retain of such a blocker is refused (committed or not)
    const bearing = reserveFor(store, fixture, { kind: 'keeper', processBearing: true }).resourceId;
    const tree = reserveFor(store, fixture, { kind: 'process-tree' }).resourceId;
    store.commitResource({ resourceId: tree, identity: { pid: 1 } });
    expectCode(assert, () => store.retainResource({ resourceId: bearing }), 'invalid_request');
    expectCode(assert, () => store.retainResource({ resourceId: tree }), 'invalid_request');
    endAttempt(store, context, fixture.admitted, 'completed', { expectedState: 'running' });
    expectCode(assert, () => store.retainResource({ resourceId: tree }), 'invalid_request');
    assert.equal(view(store, context, fixture.admitted).result, null, 'nothing was published by a refused retain');
    store.quarantineResource({ resourceId: tree, generationId: store.generationId });
    store.releaseResource({ resourceId: bearing, generationId: store.generationId });
    assert.equal(view(store, context, fixture.admitted).result.reason, 'termination_unverified');
    store.close();
});

test('F1: the reviewer probe paths cannot publish an attempt around a process tree', (t) => {
    const dir = makeTempDir(t);
    const store = openStore(dir);
    const context = syntheticContext();
    // probe 1 (recovery route): the new generation retains the old generation's blocker
    const fixture = running(store, context);
    const tree = reserveFor(store, fixture, { kind: 'process-tree', processBearing: true }).resourceId;
    const plain = reserveFor(store, fixture, { kind: 'mount' }).resourceId;
    const old = store.generationId;
    store.beginGenerationRecovery(old);
    expectCode(assert, () => store.retainResource({ resourceId: tree }), 'stale_generation');
    expectCode(assert, () => store.retainResource({ resourceId: plain }), 'stale_generation');
    assert.deepEqual([view(store, context, fixture.admitted).state, view(store, context, fixture.admitted).result], ['stopping', null]);
    store.releaseResource({ resourceId: plain, generationId: old });
    store.quarantineResource({ resourceId: tree, generationId: old });
    assert.deepEqual(view(store, context, fixture.admitted).result,
        { status: 'failed', reason: 'termination_unverified', classification: 'interrupted', cleanup: 'quarantined', outputText: '', data: null });
    store.close();
    // probe 2 (reserve route): retained:true together with an attempt is refused at reserve
    const second = openStore(makeTempDir(t));
    const other = running(second, context);
    expectCode(assert, () => second.reserveResource({
        robotId: other.robotId, executionId: other.admitted.executionId, attemptId: other.admitted.attemptId,
        kind: 'process-tree', processBearing: true, retained: true, locator: locatorFor('pt')
    }), 'invalid_request');
    expectCode(assert, () => second.reserveResource({
        robotId: other.robotId, executionId: other.admitted.executionId, attemptId: other.admitted.attemptId,
        kind: 'gui', retained: true, locator: locatorFor('gui')
    }), 'invalid_request');
    const ended = endAttempt(second, context, other.admitted, 'completed', { expectedState: 'running' });
    assert.equal(ended.state, 'completed');
    second.close();
});

test('F2: a locator is never reserved again, whatever the earlier blocker state, and the cleared locator stays retired', (t) => {
    const dir = makeTempDir(t);
    const store = openStore(dir, { runtime: syntheticRuntime() });
    const generationId = store.generationId;
    const locator = { dir: 'L' };
    const first = store.reserveResource({ kind: 'mount', locator }).resourceId;
    expectCode(assert, () => store.reserveResource({ kind: 'mount', locator: { dir: 'L' } }), 'operation_conflict');
    store.quarantineResource({ resourceId: first, generationId });
    expectCode(assert, () => store.reserveResource({ kind: 'mount', locator }), 'operation_conflict');
    // key order does not matter; another kind is a different resource
    const two = store.reserveResource({ kind: 'mount', locator: { a: 1, b: 2 } }).resourceId;
    expectCode(assert, () => store.reserveResource({ kind: 'mount', locator: { b: 2, a: 1 } }), 'operation_conflict');
    assert.equal(store.reserveResource({ kind: 'cgroup', locator: { b: 2, a: 1 } }).resourceId.length, 22);
    store.releaseResource({ resourceId: two, generationId });
    expectCode(assert, () => store.reserveResource({ kind: 'mount', locator: { a: 1, b: 2 } }), 'operation_conflict');
    // a process-bearing reservation cannot dodge the check with its generated marker
    const bearing = store.reserveResource({ kind: 'keeper', processBearing: true, locator: { cg: 'k' } }).resourceId;
    expectCode(assert, () => store.reserveResource({ kind: 'keeper', processBearing: true, locator: { cg: 'k' } }), 'operation_conflict');
    store.quarantineResource({ resourceId: bearing, generationId });
    store.clearQuarantine(ADMIN(), { operationId: newId(), resourceId: bearing, attestation: EVIDENCE });
    expectCode(assert, () => store.reserveResource({ kind: 'keeper', processBearing: true, locator: { cg: 'k' } }), 'operation_conflict');
    const db = rawDb(dir);
    assert.throws(() => db.exec("UPDATE resource_blocker SET locator_base = '{}'"), /immutable/);
    db.close();
    store.close();
});

test('D1: retain is idempotent, including for a blocker retained at reservation and under concurrent retries', async (t) => {
    const dir = makeTempDir(t);
    const store = openStore(dir);
    const context = syntheticContext();
    const robotId = readyRobot(store, context);
    const first = store.reserveResource({ robotId, kind: 'scratch', locator: locatorFor('scratch') }).resourceId;
    const expected = { resourceId: first, retained: true };
    assert.deepEqual(store.retainResource({ resourceId: first }), expected);
    assert.deepEqual(store.retainResource({ resourceId: first }), expected);
    const born = store.reserveResource({ robotId, kind: 'gui', locator: locatorFor('gui'), retained: true }).resourceId;
    assert.deepEqual(store.retainResource({ resourceId: born }), { resourceId: born, retained: true });
    const generationId = store.generationId;
    store.releaseResource({ resourceId: born, generationId });
    expectCode(assert, () => store.retainResource({ resourceId: born }), 'operation_conflict');
    const target = store.reserveResource({ robotId, kind: 'scratch', locator: locatorFor('scratch') }).resourceId;
    store.close();
    const spec = { dir, method: 'retainResource', request: { resourceId: target } };
    const results = await raceChildren(Array.from({ length: 6 }, () => spec));
    for (const result of results) assert.deepEqual([result.code, result.output?.ok], [0, true], JSON.stringify(result.output));
    assert.equal(new Set(results.map((result) => JSON.stringify(result.output.result))).size, 1);
});

test('N1/O1: only UNIQUE and PRIMARY KEY violations are conflicts; trigger, CHECK, NOT NULL and FOREIGN KEY rejections are state_corrupt; extended busy codes are runtime_unavailable', (t) => {
    const sqlite = (errcode) => Object.assign(new Error('raw sqlite text with /private/path'), { code: 'ERR_SQLITE_ERROR', errcode });
    // O1: the primary code is the low byte
    for (const errcode of [5, 6, 261, 517, 773, 262, 518]) assert.equal(mapError(sqlite(errcode)).code, 'runtime_unavailable', String(errcode));
    for (const errcode of [1555, 2067]) assert.equal(mapError(sqlite(errcode)).code, 'operation_conflict', String(errcode));
    for (const errcode of [19, 275, 787, 1299, 1811, 1, 11, 26, 14]) assert.equal(mapError(sqlite(errcode)).code, 'state_corrupt', String(errcode));
    assert.equal(mapError(new Error('plain')).code, 'state_corrupt');
    assert.equal(mapError(sqlite(undefined)).code, 'state_corrupt');
    assert.equal(mapError(sqlite(517)).message.includes('/private'), false);
    const known = mapError(new Error('x'));
    assert.equal(mapError(known), known);
    // real transactions
    const dir = makeTempDir(t);
    const { state } = openStorage({ dataDir: dir, workspaceId: WORKSPACE, provider: PROVIDER, create: true, now: () => 1, faults: {} });
    const insert = "INSERT INTO receipt (scope, operation_id, op_type, robot_id, digest, response, created_at) VALUES ('s', 'o', 't', NULL, 'd', '{}', 1)";
    expectCode(assert, () => state.transaction('probe', (db) => { db.exec(insert); db.exec(insert); }), 'operation_conflict');
    expectCode(assert, () => state.transaction('probe', (db) => { db.exec(insert); db.exec("UPDATE receipt SET digest = 'x'"); }), 'state_corrupt');
    expectCode(assert, () => state.transaction('probe', (db) => db.exec("INSERT INTO admission (execution_id) VALUES ('x')")), 'state_corrupt');
    expectCode(assert, () => state.transaction('probe', (db) => db.exec("INSERT INTO resource_blocker (resource_id, generation_id, kind, process_bearing, locator, locator_base, release_state, created_at) VALUES ('r', 'no-such-generation', 'k', 0, '{}', '{}', 'reserved', 1)")), 'state_corrupt');
    expectCode(assert, () => state.transaction('probe', (db) => db.exec("INSERT INTO resource_blocker (resource_id, generation_id, kind, process_bearing, locator, locator_base, release_state, created_at) SELECT 'r', id, 'k', 0, '{}', '{}', 'bogus', 1 FROM generation")), 'state_corrupt');
    assert.equal(count(dir, 'receipt'), 0, 'every rejected transaction rolled back');
    state.close();
});

test('N1: a trigger-caught illegal transition on a tampered row is state_corrupt, not a benign race', (t) => {
    const dir = makeTempDir(t);
    const store = openStore(dir);
    const context = syntheticContext();
    const robotId = readyRobot(store, context);
    const admitted = store.admit(context, admitRequest(robotId, {}, context));
    store.close();
    // tamper with the row (the guard trigger is dropped and recreated around the raw write)
    const db = rawDb(dir);
    const trigger = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = 'admission_transition'").get().sql;
    db.exec('DROP TRIGGER admission_transition');
    db.prepare("UPDATE admission SET end_classification = 'completed', end_payload = '{}' WHERE execution_id = ?").run(admitted.executionId);
    db.exec(trigger);
    db.close();
    const reopened = openStore(dir, { create: false });
    // the library's own checks pass (the attempt is queued), the intact trigger rejects the update
    expectCode(assert, () => reopened.transitionAttempt({ executionId: admitted.executionId, attemptId: admitted.attemptId, expectedState: 'queued', nextState: 'running' }), 'state_corrupt');
    assert.equal(reopened.getReference(context, { referenceId: admitted.reference.id }).state, 'queued');
    reopened.close();
});

test('R2-1: a store written with an older layout is refused at open, not later', (t) => {
    // version 2 layout: no locator_base column and no unique locator index
    const old = makeTempDir(t);
    openStore(old).close();
    let db = rawDb(old);
    assert.equal(db.prepare("SELECT value FROM metadata WHERE key = 'schema_version'").get().value, '10');
    db.exec('DROP INDEX resource_blocker_locator');
    db.exec('DROP TRIGGER resource_blocker_guard');
    db.exec('ALTER TABLE resource_blocker DROP COLUMN locator_base');
    db.exec("UPDATE metadata SET value = '2' WHERE key = 'schema_version'");
    db.close();
    expectCode(assert, () => openStore(old, { create: false }), 'state_corrupt');
    // the current version number with the old layout is refused as well (column check)
    const lying = makeTempDir(t);
    openStore(lying).close();
    db = rawDb(lying);
    db.exec('DROP INDEX resource_blocker_locator');
    db.exec('DROP TRIGGER resource_blocker_guard');
    db.exec('ALTER TABLE resource_blocker DROP COLUMN locator_base');
    db.close();
    expectCode(assert, () => openStore(lying, { create: false }), 'state_corrupt');
    // a missing unique index alone is refused too
    const noIndex = makeTempDir(t);
    openStore(noIndex).close();
    db = rawDb(noIndex);
    db.exec('DROP INDEX resource_blocker_locator');
    db.close();
    expectCode(assert, () => openStore(noIndex, { create: false }), 'state_corrupt');
    // and so is a refused open of the old layout with create: true (never upgraded in place)
    expectCode(assert, () => openStore(old, { create: true }), 'state_corrupt');
    assert.equal(rawDb(old, { readOnly: true }).prepare("SELECT value FROM metadata WHERE key = 'schema_version'").get().value, '2');
});

test('N4: eight processes creating the same store at once all open it, over several rounds', async (t) => {
    for (let round = 0; round < 6; round += 1) {
        const dir = makeTempDir(t);
        const results = await raceChildren(Array.from({ length: 8 }, () => ({ dir, method: 'open', create: true })));
        for (const result of results) assert.deepEqual([result.code, result.output?.ok, result.output?.code], [0, true, undefined], JSON.stringify(result.output));
        assert.equal(new Set(results.map((result) => result.output.result.generationId)).size, 1);
        assert.equal(count(dir, 'generation'), 1);
    }
});

test('D2: a concurrent identical clearQuarantine replays the recorded receipt', (t) => {
    const dir = makeTempDir(t);
    const runtime = syntheticRuntime();
    const store = openStore(dir, { runtime });
    const racer = openStore(dir, { create: false, runtime: syntheticRuntime() });
    const blocker = store.reserveResource({ kind: 'mount', locator: locatorFor('mount') }).resourceId;
    store.quarantineResource({ resourceId: blocker, generationId: store.generationId });
    const request = { operationId: newId(), resourceId: blocker, attestation: EVIDENCE };
    let winner = null;
    // the identical request commits while this one is in its adapter call
    runtime.absence = () => {
        winner = racer.clearQuarantine(ADMIN(), request);
        return true;
    };
    const loser = store.clearQuarantine(ADMIN(), request);
    assert.deepEqual(loser, winner);
    assert.equal(count(dir, 'quarantine_audit'), 1);
    assert.equal(count(dir, 'receipt') >= 1, true);
    store.close();
    racer.close();
});

test('D2: concurrent identical clearQuarantine requests in several processes all get the same answer', async (t) => {
    for (let round = 0; round < 6; round += 1) {
        const dir = makeTempDir(t);
        const store = openStore(dir);
        const blocker = store.reserveResource({ kind: 'mount', locator: locatorFor('mount') }).resourceId;
        store.quarantineResource({ resourceId: blocker, generationId: store.generationId });
        store.close();
        const spec = { dir, method: 'clearQuarantine', context: CONTEXT_FIELDS, request: { operationId: newId(), resourceId: blocker, attestation: EVIDENCE } };
        const results = await raceChildren(Array.from({ length: 6 }, () => spec));
        for (const result of results) assert.deepEqual([result.code, result.output?.ok], [0, true], JSON.stringify(result.output));
        assert.equal(new Set(results.map((result) => JSON.stringify(result.output.result))).size, 1);
        assert.equal(count(dir, 'quarantine_audit'), 1);
    }
});

test('F4: malformed adapter results fail closed', (t) => {
    const dir = makeTempDir(t);
    const runtime = syntheticRuntime();
    const store = openStore(dir, { runtime });
    const context = syntheticContext();
    const robotId = readyRobot(store, context);
    for (const bad of ['yes', 1, {}, null, undefined, 'true']) {
        runtime.prepare = bad;
        expectCode(assert, () => store.beginProvision(context, { operationId: newId(), name: 'n', configuration: robotConfig() }), 'runtime_unavailable');
        expectCode(assert, () => store.configure(context, { operationId: newId(), robotId, expectedRevision: 1, configuration: robotConfig() }), 'runtime_unavailable');
    }
    runtime.prepare = true;
    for (const bad of ['gpu', undefined, null, [5], {}, 7]) {
        runtime.required = { admit: bad, provision: bad, configure: bad };
        runtime.requiredKinds = function requiredKinds(operation) { return this.required[operation]; };
        expectCode(assert, () => store.admit(context, admitRequest(robotId, {}, context)), 'runtime_unavailable');
        expectCode(assert, () => store.beginProvision(context, { operationId: newId(), name: 'n', configuration: robotConfig() }), 'runtime_unavailable');
        expectCode(assert, () => store.configure(context, { operationId: newId(), robotId, expectedRevision: 1, configuration: robotConfig() }), 'runtime_unavailable');
    }
    runtime.requiredKinds = function requiredKinds() { return []; };
    for (const bad of ['yes', 1, undefined, null]) {
        runtime.admit = bad;
        expectCode(assert, () => store.admit(context, admitRequest(robotId, {}, context)), 'runtime_unavailable');
        runtime.admit = true;
        runtime.attest = bad;
        expectCode(assert, () => store.attestReadiness(context, { robotId }), 'runtime_unavailable');
        runtime.attest = true;
    }
    assert.equal(count(dir, 'admission'), 0);
    assert.equal(count(dir, 'receipt'), 1);
    store.close();
});

test('F5: a throwing adapter is runtime_unavailable with no raw message, inside and outside transactions', (t) => {
    const dir = makeTempDir(t);
    const runtime = syntheticRuntime();
    const store = openStore(dir, { runtime });
    const context = syntheticContext();
    const robotId = readyRobot(store, context);
    const boom = () => { throw new Error('adapter secret detail /private/adapter/path'); };
    const refused = (fn) => assert.throws(fn, (error) => {
        assert.equal(error.name, 'WorkerStateError');
        assert.equal(error.code, 'runtime_unavailable');
        assert.equal(JSON.stringify([error.message, error.stack.split('\n')[0]]).includes('secret'), false);
        return true;
    });
    const real = { prepare: runtime.canPrepare, attest: runtime.attestRobot, admit: runtime.admissionReady, required: runtime.requiredKinds, verify: runtime.verifyAbsence };
    runtime.canPrepare = boom;
    refused(() => store.beginProvision(context, { operationId: newId(), name: 'n', configuration: robotConfig() }));
    refused(() => store.configure(context, { operationId: newId(), robotId, expectedRevision: 1, configuration: robotConfig() }));
    runtime.canPrepare = real.prepare;
    runtime.admissionReady = boom;
    refused(() => store.admit(context, admitRequest(robotId, {}, context)));
    runtime.admissionReady = real.admit;
    runtime.requiredKinds = boom;
    refused(() => store.admit(context, admitRequest(robotId, {}, context)));
    refused(() => store.beginProvision(context, { operationId: newId(), name: 'n', configuration: robotConfig() }));
    runtime.requiredKinds = real.required;
    runtime.attestRobot = boom;
    refused(() => store.attestReadiness(context, { robotId }));
    const operationId = newId();
    store.configure(context, { operationId, robotId, expectedRevision: 1, configuration: robotConfig({ a: 1 }) });
    refused(() => store.completePreparation(context, { operationId, outcome: 'succeeded' }));
    assert.equal(store.getOperationOutcome(context, { operationId }).status, 'pending', 'a throwing adapter changes nothing');
    runtime.attestRobot = real.attest;
    const blocker = store.reserveResource({ kind: 'mount', locator: locatorFor('mount') }).resourceId;
    store.quarantineResource({ resourceId: blocker, generationId: store.generationId });
    runtime.verifyAbsence = boom;
    refused(() => store.clearQuarantine(ADMIN(), { operationId: newId(), resourceId: blocker, attestation: EVIDENCE }));
    assert.equal(store.getResource({ resourceId: blocker }).state, 'quarantined');
    runtime.verifyAbsence = real.verify;
    assert.equal(store.clearQuarantine(ADMIN(), { operationId: newId(), resourceId: blocker, attestation: EVIDENCE }).state, 'released_by_operator');
    store.close();
});

test('F6: an uncommitted process-bearing reservation is released only when its marker and the keeper identity are both absent', (t) => {
    const dir = makeTempDir(t);
    const store = openStore(dir);
    const generationId = store.generationId;
    // The keeper is a separate, committed blocker; its identity is written before the keeper creates anything.
    const keeper = store.reserveResource({ kind: 'keeper', processBearing: true, locator: locatorFor('keeper') }).resourceId;
    const keeperIdentity = { pid: 4242, startTime: 99, pidNs: 7 };
    store.commitResource({ resourceId: keeper, identity: keeperIdentity });
    const proc = { cmdlines: [], live: [] };
    const walk = (resourceId) => {
        const child = store.getResource({ resourceId });
        assert.equal(child.state, 'reserved');
        assert.equal(child.identity, null);
        const markerPresent = proc.cmdlines.some((line) => line.includes(child.locator.marker));
        const keeperPresent = proc.live.some((identity) => canonicalJson(identity) === canonicalJson(store.getResource({ resourceId: keeper }).identity));
        return store.settleResource({ resourceId, generationId, outcome: markerPresent || keeperPresent ? 'quarantined' : 'released' });
    };
    const reserveChild = () => store.reserveResource({ kind: 'process-tree', processBearing: true, locator: locatorFor('child') }).resourceId;
    const byMarker = reserveChild();
    const byKeeper = reserveChild();
    const absent = reserveChild();
    proc.cmdlines.push(`rw-gate --reservation ${store.getResource({ resourceId: byMarker }).locator.marker} --stage 1`);
    assert.equal(walk(byMarker).state, 'quarantined', 'a surviving marker-bearing process');
    proc.cmdlines.length = 0;
    proc.live.push(keeperIdentity);
    assert.equal(walk(byKeeper).state, 'quarantined', 'the keeper identity is still live');
    proc.live.length = 0;
    assert.equal(walk(absent).state, 'released', 'no marker and no keeper');
    // a marker of another reservation does not count
    const other = reserveChild();
    proc.cmdlines.push(`rw-gate --reservation ${store.getResource({ resourceId: keeper }).locator.marker}`);
    assert.equal(walk(other).state, 'released');
    store.close();
});

test('F6: a settlement of a real blocker after publication leaves the published result bytes unchanged', (t) => {
    const dir = makeTempDir(t);
    const store = openStore(dir);
    const context = syntheticContext();
    const fixture = running(store, context);
    const transient = reserveFor(store, fixture).resourceId;
    const gui = reserveFor(store, fixture, { kind: 'gui' }).resourceId;
    endAttempt(store, context, fixture.admitted, 'completed', { expectedState: 'running', outputText: 'once', data: { v: 1 } });
    store.releaseResource({ resourceId: transient, generationId: store.generationId });
    store.retainResource({ resourceId: gui });
    const read = () => {
        const db = rawDb(dir, { readOnly: true });
        const row = db.prepare('SELECT state, result, updated_at FROM admission WHERE execution_id = ?').get(fixture.admitted.executionId);
        db.close();
        return JSON.stringify(row);
    };
    const published = read();
    assert.equal(JSON.parse(published).state, 'completed');
    // the retained blocker is a real, still unsettled blocker of the already settled attempt
    assert.equal(store.getResource({ resourceId: gui }).state, 'reserved');
    assert.equal(store.quarantineResource({ resourceId: gui, generationId: store.generationId }).state, 'quarantined');
    assert.equal(read(), published, 'publishing is write-once');
    assert.equal(view(store, context, fixture.admitted).result.cleanup, 'released');
    store.close();
});

test('M-49: listResourcesForAttempt returns every row of one attempt in any release state, and nothing of another attempt', (t) => {
    const dir = makeTempDir(t);
    const store = openStore(dir);
    const context = syntheticContext();
    const one = running(store, context);
    const other = running(store, context);
    const generationId = store.generationId;
    const kinds = ['workdir', 'mount', 'workdir'];
    const ids = kinds.map((kind) => reserveFor(store, one, { kind, locator: locatorFor(kind) }).resourceId);
    const foreign = reserveFor(store, other).resourceId;
    store.commitResource({ resourceId: ids[0], identity: { id: 1 } });
    store.settleResource({ resourceId: ids[1], generationId, outcome: 'released' });
    store.commitResource({ resourceId: ids[2], identity: { id: 2 } });
    store.settleResource({ resourceId: ids[2], generationId, outcome: 'quarantined' });
    const rows = store.listResourcesForAttempt({ attemptId: one.admitted.attemptId });
    assert.deepEqual(rows.map((row) => row.resourceId).sort(), [...ids].sort());
    assert.deepEqual(rows.map((row) => row.state).sort(), ['committed', 'quarantined', 'released']);
    assert.ok(!rows.some((row) => row.resourceId === foreign));
    assert.deepEqual(store.listUnsettledResources().filter((row) => row.attemptId === one.admitted.attemptId).map((row) => row.resourceId), [ids[0]], 'the unsettled listing alone would have lost two of them');
    assert.deepEqual(store.listResourcesForAttempt({ attemptId: newId() }), []);
    expectCode(assert, () => store.listResourcesForAttempt({}), 'invalid_request');
});
