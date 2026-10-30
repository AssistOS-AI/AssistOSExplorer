import assert from 'node:assert/strict';
import test from 'node:test';
import { runtimeUnavailable } from '../server/workerState.mjs';
import {
    LIMITS, admitRequest, count, endAttempt, expectCode, makeTempDir, newId, openStore, rawDb, readyRobot, robotConfig,
    syntheticContext, syntheticRuntime
} from './helpers/synthetic.mjs';

function provisionRequest(overrides = {}) {
    return { operationId: newId(), name: 'Synthetic robot', configuration: robotConfig(), ...overrides };
}

test('default runtime refuses preparation: no robot, receipt, blocker or completion is recorded', (t) => {
    const dir = makeTempDir(t);
    const store = openStore(dir, { runtime: runtimeUnavailable });
    const context = syntheticContext();
    expectCode(assert, () => store.beginProvision(context, provisionRequest()), 'runtime_unavailable');
    for (const table of ['robot', 'receipt', 'completion', 'preparation', 'resource_blocker']) assert.equal(count(dir, table), 0, table);
    store.close();
});

test('unauthorized and malformed lifecycle calls change nothing', (t) => {
    const dir = makeTempDir(t);
    const store = openStore(dir);
    expectCode(assert, () => store.beginProvision(syntheticContext({ operations: ['read'] }), provisionRequest()), 'forbidden');
    expectCode(assert, () => store.beginProvision(syntheticContext(), provisionRequest({ owner: 'x' })), 'invalid_request');
    expectCode(assert, () => store.beginProvision(syntheticContext(), provisionRequest({ name: ' ' })), 'invalid_request');
    expectCode(assert, () => store.beginProvision(syntheticContext(), provisionRequest({ operationId: 'short' })), 'invalid_request');
    expectCode(assert, () => store.beginProvision(syntheticContext(), { operationId: newId() }), 'invalid_request');
    expectCode(assert, () => store.beginProvision({ workspaceId: 'ws-synthetic' }, provisionRequest()), 'forbidden');
    assert.equal(count(dir, 'receipt'), 0);
    store.close();
});

test('provision records one provisioning robot, receipt and preparation blocker; retry survives close and reopen', (t) => {
    const dir = makeTempDir(t);
    let store = openStore(dir);
    const context = syntheticContext();
    const request = provisionRequest();
    const first = store.beginProvision(context, request);
    assert.equal(first.status, 'accepted');
    assert.deepEqual(store.beginProvision(context, request), first);
    for (const table of ['robot', 'receipt', 'completion', 'preparation', 'resource_blocker']) assert.equal(count(dir, table), 1, table);
    const robot = store.getRobot(context, { robotId: first.robotId });
    assert.equal(robot.lifecycle, 'provisioning');
    assert.equal(robot.ready, false);
    assert.equal(robot.revision, 0);
    assert.deepEqual(store.getOperationOutcome(context, { operationId: request.operationId }).status, 'pending');
    store.close();
    store = openStore(dir, { create: false });
    assert.deepEqual(store.beginProvision(context, request), first);
    assert.equal(count(dir, 'robot'), 1);
    assert.equal(count(dir, 'receipt'), 1);
    store.close();
});

test('adapter completion publishes revision 1 once; the acceptance receipt never changes', (t) => {
    const dir = makeTempDir(t);
    const runtime = syntheticRuntime();
    const store = openStore(dir, { runtime });
    const context = syntheticContext();
    const request = provisionRequest();
    const accepted = store.beginProvision(context, request);
    const done = store.completePreparation(context, { operationId: request.operationId, outcome: 'succeeded' });
    assert.equal(done.status, 'succeeded');
    assert.equal(runtime.attestCalls.length, 1);
    const robot = store.getRobot(context, { robotId: accepted.robotId });
    assert.deepEqual([robot.lifecycle, robot.revision, robot.ready], ['ready', 1, true]);
    assert.deepEqual(store.getOperationOutcome(context, { operationId: request.operationId }), done);
    assert.deepEqual(store.beginProvision(context, request), accepted, 'receipt unchanged after completion');
    assert.deepEqual(store.completePreparation(context, { operationId: request.operationId, outcome: 'succeeded' }), done);
    assert.equal(runtime.attestCalls.length, 1, 'repeat completion does not re-attest');
    expectCode(assert, () => store.completePreparation(context, { operationId: request.operationId, outcome: 'failed' }), 'operation_conflict');
    assert.equal(rawDb(dir, { readOnly: true }).prepare("SELECT release_state FROM resource_blocker").get().release_state, 'released');
    assert.equal(count(dir, 'preparation'), 0);
    store.close();
});

test('the default runtime cannot publish readiness: completion is refused and state is unchanged', (t) => {
    const dir = makeTempDir(t);
    let store = openStore(dir);
    const context = syntheticContext();
    const request = provisionRequest();
    const accepted = store.beginProvision(context, request);
    store.close();
    store = openStore(dir, { create: false, runtime: runtimeUnavailable });
    expectCode(assert, () => store.completePreparation(context, { operationId: request.operationId, outcome: 'succeeded' }), 'runtime_unavailable');
    const robot = store.getRobot(context, { robotId: accepted.robotId });
    assert.deepEqual([robot.lifecycle, robot.revision, robot.ready, robot.preparing], ['provisioning', 0, false, true]);
    assert.equal(store.getOperationOutcome(context, { operationId: request.operationId }).status, 'pending');
    expectCode(assert, () => store.attestReadiness(context, { robotId: accepted.robotId }), 'robot_busy');
    store.close();
});

test('cross-operation, payload and owner conflicts are refused; scopes are independent', (t) => {
    const dir = makeTempDir(t);
    const store = openStore(dir);
    const context = syntheticContext();
    const request = provisionRequest();
    const accepted = store.beginProvision(context, request);
    expectCode(assert, () => store.beginProvision(context, { ...request, name: 'Different' }), 'operation_conflict');
    expectCode(assert, () => store.beginProvision(context, { ...request, configuration: robotConfig({ a: 1 }) }), 'operation_conflict');
    expectCode(assert, () => store.beginProvision(syntheticContext({ ownerId: 'owner-synthetic-b' }), request), 'operation_conflict');
    // the same operation ID cannot be reused for another operation type or robot
    expectCode(assert, () => store.beginDelete(context, { operationId: request.operationId, robotId: accepted.robotId, expectedRevision: 0 }), 'operation_conflict');
    expectCode(assert, () => store.configure(context, { operationId: request.operationId, robotId: accepted.robotId, expectedRevision: 0, configuration: robotConfig() }), 'operation_conflict');
    assert.equal(count(dir, 'receipt'), 1);
    // a different verified scope has its own receipt namespace
    const other = syntheticContext({ scope: 'scope-synthetic-b', ownerId: 'owner-synthetic-b' });
    const second = store.beginProvision(other, request);
    assert.notEqual(second.robotId, accepted.robotId);
    assert.equal(count(dir, 'receipt'), 2);
    store.close();
});

test('configure validates revision, honours the preparation gate and publishes only after matching completion', (t) => {
    const dir = makeTempDir(t);
    const store = openStore(dir);
    const context = syntheticContext();
    const robotId = readyRobot(store, context);
    expectCode(assert, () => store.configure(context, { operationId: newId(), robotId, expectedRevision: 0, configuration: robotConfig() }), 'revision_conflict');
    const operationId = newId();
    const request = { operationId, robotId, expectedRevision: 1, configuration: robotConfig({ mode: 'fast' }) };
    const accepted = store.configure(context, request);
    assert.deepEqual(store.configure(context, request), accepted);
    let robot = store.getRobot(context, { robotId });
    assert.deepEqual([robot.revision, robot.configuration.settings, robot.ready, robot.preparing], [1, {}, false, true]);
    // configure/configure and configure/admit interleavings while preparation is pending
    expectCode(assert, () => store.configure(context, { ...request, operationId: newId() }), 'robot_busy');
    expectCode(assert, () => store.admit(context, admitRequest(robotId)), 'robot_busy');
    assert.equal(count(dir, 'admission'), 0);
    store.completePreparation(context, { operationId, outcome: 'succeeded' });
    robot = store.getRobot(context, { robotId });
    assert.deepEqual([robot.revision, robot.configuration.settings.mode, robot.ready], [2, 'fast', true]);
    assert.deepEqual(store.configure(context, request), accepted, 'retry after completion returns the original receipt');
    assert.equal(store.getOperationOutcome(context, { operationId }).status, 'succeeded');
    store.close();
});

test('failed configuration keeps the effective configuration and withholds readiness', (t) => {
    const dir = makeTempDir(t);
    const store = openStore(dir);
    const context = syntheticContext();
    const robotId = readyRobot(store, context, robotConfig({ mode: 'orig' }));
    // known no effects: a fresh attestation restores readiness
    let operationId = newId();
    store.configure(context, { operationId, robotId, expectedRevision: 1, configuration: robotConfig({ mode: 'new' }) });
    store.completePreparation(context, { operationId, outcome: 'failed', effects: 'none' });
    let robot = store.getRobot(context, { robotId });
    assert.deepEqual([robot.revision, robot.configuration.settings.mode, robot.ready, robot.uncertain], [1, 'orig', false, false]);
    assert.equal(store.getOperationOutcome(context, { operationId }).status, 'failed');
    store.attestReadiness(context, { robotId });
    assert.equal(store.getRobot(context, { robotId }).ready, true);
    // unknown partial effects: a bare attestation cannot clear them, an explicit repair can
    operationId = newId();
    store.configure(context, { operationId, robotId, expectedRevision: 1, configuration: robotConfig({ mode: 'new' }) });
    store.completePreparation(context, { operationId, outcome: 'failed' });
    robot = store.getRobot(context, { robotId });
    assert.deepEqual([robot.ready, robot.uncertain, robot.configuration.settings.mode], [false, true, 'orig']);
    expectCode(assert, () => store.attestReadiness(context, { robotId }), 'robot_busy');
    expectCode(assert, () => store.admit(context, admitRequest(robotId)), 'runtime_unavailable');
    const repair = newId();
    store.configure(context, { operationId: repair, robotId, expectedRevision: 1, configuration: robotConfig({ mode: 'repaired' }) });
    store.completePreparation(context, { operationId: repair, outcome: 'succeeded' });
    robot = store.getRobot(context, { robotId });
    assert.deepEqual([robot.revision, robot.ready, robot.uncertain, robot.configuration.settings.mode], [2, true, false, 'repaired']);
    store.close();
});

test('failed provisioning is nonready and can only be repaired by an explicit configure', (t) => {
    const dir = makeTempDir(t);
    const store = openStore(dir);
    const context = syntheticContext();
    const operationId = newId();
    const { robotId } = store.beginProvision(context, provisionRequest({ operationId }));
    store.completePreparation(context, { operationId, outcome: 'failed' });
    let robot = store.getRobot(context, { robotId });
    assert.deepEqual([robot.lifecycle, robot.revision, robot.ready, robot.configuration], ['failed', 0, false, null]);
    expectCode(assert, () => store.admit(context, admitRequest(robotId, { configRevision: 1 })), 'runtime_unavailable');
    const repair = newId();
    store.configure(context, { operationId: repair, robotId, expectedRevision: 0, configuration: robotConfig() });
    store.completePreparation(context, { operationId: repair, outcome: 'succeeded' });
    robot = store.getRobot(context, { robotId });
    assert.deepEqual([robot.lifecycle, robot.revision, robot.ready], ['ready', 1, true]);
    store.close();
});

test('backend changes require no active or queued work and no retained resources', (t) => {
    const dir = makeTempDir(t);
    const store = openStore(dir);
    const context = syntheticContext();
    const robotId = readyRobot(store, context);
    const admitted = store.admit(context, admitRequest(robotId));
    // settings-only change is allowed with active work; admitted specification is a snapshot
    const settingsOp = newId();
    store.configure(context, { operationId: settingsOp, robotId, expectedRevision: 1, configuration: robotConfig({ mode: 'x' }) });
    store.completePreparation(context, { operationId: settingsOp, outcome: 'succeeded' });
    expectCode(assert, () => store.configure(context, { operationId: newId(), robotId, expectedRevision: 2, configuration: robotConfig({}, 'other') }), 'robot_busy');
    const snapshot = rawDb(dir, { readOnly: true }).prepare('SELECT config_revision, configuration FROM admission WHERE execution_id = ?').get(admitted.executionId);
    assert.equal(snapshot.config_revision, 1);
    assert.equal(snapshot.configuration, JSON.stringify(robotConfig()));
    endAttempt(store, context, admitted);
    const { resourceId } = store.reserveResource({ robotId, kind: 'retained-tree', retained: true, locator: { dir: 'synthetic' } });
    expectCode(assert, () => store.configure(context, { operationId: newId(), robotId, expectedRevision: 2, configuration: robotConfig({}, 'other') }), 'robot_busy');
    store.releaseResource({ resourceId, generationId: store.generationId });
    const backendOp = newId();
    store.configure(context, { operationId: backendOp, robotId, expectedRevision: 2, configuration: robotConfig({}, 'other') });
    store.completePreparation(context, { operationId: backendOp, outcome: 'succeeded' });
    assert.equal(store.getRobot(context, { robotId }).configuration.backend, 'other');
    store.close();
});

test('deletion refuses active work and retained resources without changing readiness', (t) => {
    const dir = makeTempDir(t);
    const store = openStore(dir);
    const context = syntheticContext();
    const robotId = readyRobot(store, context);
    const admitted = store.admit(context, admitRequest(robotId));
    expectCode(assert, () => store.beginDelete(context, { operationId: newId(), robotId, expectedRevision: 1 }), 'robot_busy');
    assert.equal(store.getRobot(context, { robotId }).ready, true);
    store.transitionAttempt({ executionId: admitted.executionId, attemptId: admitted.attemptId, expectedState: 'queued', nextState: 'running' });
    expectCode(assert, () => store.beginDelete(context, { operationId: newId(), robotId, expectedRevision: 1 }), 'robot_busy');
    endAttempt(store, context, admitted, 'completed', { expectedState: 'running' });
    const { resourceId } = store.reserveResource({ robotId, kind: 'retained-tree', retained: true, locator: { dir: 'synthetic' } });
    expectCode(assert, () => store.beginDelete(context, { operationId: newId(), robotId, expectedRevision: 1 }), 'robot_busy');
    assert.equal(store.getRobot(context, { robotId }).ready, true);
    expectCode(assert, () => store.beginDelete(context, { operationId: newId(), robotId, expectedRevision: 9 }), 'revision_conflict');
    store.releaseResource({ resourceId, generationId: store.generationId });
    assert.equal(store.beginDelete(context, { operationId: newId(), robotId, expectedRevision: 1 }).status, 'accepted');
    store.close();
});

test('deletion closes admission, blocks configure, needs released blockers and records a tombstone', (t) => {
    const dir = makeTempDir(t);
    let store = openStore(dir);
    const context = syntheticContext();
    const robotId = readyRobot(store, context);
    const { resourceId } = store.reserveResource({ robotId, kind: 'workdir', locator: { dir: 'synthetic' } });
    const operationId = newId();
    const request = { operationId, robotId, expectedRevision: 1 };
    const accepted = store.beginDelete(context, request);
    assert.deepEqual(store.getRobot(context, { robotId }).lifecycle, 'deleting');
    expectCode(assert, () => store.admit(context, admitRequest(robotId)), 'robot_busy');
    expectCode(assert, () => store.configure(context, { operationId: newId(), robotId, expectedRevision: 1, configuration: robotConfig() }), 'robot_busy');
    expectCode(assert, () => store.beginDelete(context, { ...request, operationId: newId() }), 'robot_busy');
    expectCode(assert, () => store.reserveResource({ robotId, kind: 'workdir', locator: { dir: 'synthetic' } }), 'robot_busy');
    expectCode(assert, () => store.completeDelete(context, { operationId }), 'robot_busy');
    assert.equal(store.getOperationOutcome(context, { operationId }).status, 'pending');
    store.releaseResource({ resourceId, generationId: store.generationId });
    const done = store.completeDelete(context, { operationId });
    assert.equal(done.status, 'succeeded');
    assert.equal(store.getRobot(context, { robotId }).lifecycle, 'deleted');
    store.close();
    store = openStore(dir, { create: false });
    // a retry of the completed deletion returns its original outcome, even after reopen
    assert.deepEqual(store.beginDelete(context, request), accepted);
    assert.deepEqual(store.completeDelete(context, { operationId }), done);
    // M-29: deleting an already-deleted robot under a new operation ID succeeds, with its own completed operation.
    const again = newId();
    assert.deepEqual(store.beginDelete(context, { ...request, operationId: again }), { operationId: again, type: 'delete', robotId, baseRevision: 1, status: 'accepted' });
    assert.equal(store.getOperationOutcome(context, { operationId: again }).status, 'succeeded');
    expectCode(assert, () => store.configure(context, { operationId: newId(), robotId, expectedRevision: 1, configuration: robotConfig() }), 'not_found');
    assert.equal(count(dir, 'robot'), 1, 'tombstone persists');
    assert.throws(() => rawDb(dir).exec('DELETE FROM robot'), /immutable/);
    assert.throws(() => rawDb(dir).exec("UPDATE robot SET lifecycle = 'ready'"), /immutable/);
    store.close();
});

test('M-29: a delete is refused robot_busy while the robot is being created, and works once it is ready', (t) => {
    const dir = makeTempDir(t);
    const store = openStore(dir);
    const context = syntheticContext();
    const provision = provisionRequest();
    const { robotId } = store.beginProvision(context, provision);
    const deleteOp = newId();
    expectCode(assert, () => store.beginDelete(context, { operationId: deleteOp, robotId, expectedRevision: 0 }), 'robot_busy');
    assert.equal(store.completePreparation(context, { operationId: provision.operationId, outcome: 'succeeded' }).status, 'succeeded');
    assert.deepEqual(store.beginDelete(context, { operationId: deleteOp, robotId, expectedRevision: 1 }).status, 'accepted');
    // A different operation while deleting is busy; the same operation after a lost reply returns the same receipt.
    expectCode(assert, () => store.beginDelete(context, { operationId: newId(), robotId, expectedRevision: 1 }), 'robot_busy');
    assert.equal(store.beginDelete(context, { operationId: deleteOp, robotId, expectedRevision: 1 }).operationId, deleteOp);
    assert.equal(store.completeDelete(context, { operationId: deleteOp }).status, 'succeeded');
    assert.equal(store.getRobot(context, { robotId }).lifecycle, 'deleted');
    store.close();
});

test('owner preconditions: another owner sees not_found for configure, delete, read and completion state', (t) => {
    const dir = makeTempDir(t);
    const store = openStore(dir);
    const context = syntheticContext();
    const robotId = readyRobot(store, context);
    const other = syntheticContext({ scope: 'scope-synthetic-b', ownerId: 'owner-synthetic-b' });
    expectCode(assert, () => store.configure(other, { operationId: newId(), robotId, expectedRevision: 1, configuration: robotConfig() }), 'not_found');
    expectCode(assert, () => store.beginDelete(other, { operationId: newId(), robotId, expectedRevision: 1 }), 'not_found');
    expectCode(assert, () => store.getRobot(other, { robotId }), 'not_found');
    expectCode(assert, () => store.attestReadiness(other, { robotId }), 'not_found');
    expectCode(assert, () => store.getOperationOutcome(other, { operationId: newId() }), 'not_found');
    assert.equal(count(dir, 'receipt'), 1);
    store.close();
});

test('completion of an unknown operation is not_found and the wrong completion kind is refused', (t) => {
    const dir = makeTempDir(t);
    const store = openStore(dir);
    const context = syntheticContext();
    expectCode(assert, () => store.completePreparation(context, { operationId: newId(), outcome: 'succeeded' }), 'not_found');
    expectCode(assert, () => store.completeDelete(context, { operationId: newId() }), 'not_found');
    const provision = provisionRequest();
    store.beginProvision(context, provision);
    expectCode(assert, () => store.completeDelete(context, { operationId: provision.operationId }), 'not_found');
    expectCode(assert, () => store.completePreparation(context, { operationId: provision.operationId, outcome: 'maybe' }), 'invalid_request');
    expectCode(assert, () => store.completePreparation(context, { operationId: provision.operationId, outcome: 'succeeded', effects: 'none' }), 'invalid_request');
    expectCode(assert, () => store.completePreparation(syntheticContext({ operations: ['read'] }), { operationId: provision.operationId, outcome: 'succeeded' }), 'forbidden');
    expectCode(assert, () => store.completePreparation(syntheticContext({ scope: 'scope-synthetic-b' }), { operationId: provision.operationId, outcome: 'succeeded' }), 'not_found');
    store.close();
});

test('capacity exhaustion is explicit and never prunes receipts or tombstones', (t) => {
    const dir = makeTempDir(t);
    const store = openStore(dir, { limits: { ...LIMITS, robots: 2, receipts: 3 } });
    const context = syntheticContext();
    const first = provisionRequest();
    store.beginProvision(context, first);
    store.beginProvision(context, provisionRequest());
    expectCode(assert, () => store.beginProvision(context, provisionRequest()), 'capacity_exceeded');
    assert.equal(count(dir, 'robot'), 2);
    assert.equal(count(dir, 'receipt'), 2);
    // delete a robot: the tombstone still occupies capacity
    const done = newId();
    store.completePreparation(context, { operationId: first.operationId, outcome: 'failed' });
    const { robotId } = store.beginProvision(context, first);
    store.beginDelete(context, { operationId: done, robotId, expectedRevision: 0 });
    store.completeDelete(context, { operationId: done });
    expectCode(assert, () => store.beginProvision(context, provisionRequest()), 'capacity_exceeded');
    // receipts at capacity: replay still works, a fresh operation does not
    assert.equal(count(dir, 'receipt'), 3);
    // M-29: a delete of the tombstone succeeds under a new operation, which still needs receipt capacity.
    expectCode(assert, () => store.beginDelete(context, { operationId: newId(), robotId, expectedRevision: 0 }), 'capacity_exceeded');
    assert.equal(store.beginProvision(context, first).robotId, robotId);
    store.close();
});

test('lifecycle receipts, completions and robots reject mutation at the database level', (t) => {
    const dir = makeTempDir(t);
    const store = openStore(dir);
    const context = syntheticContext();
    const operationId = newId();
    store.beginProvision(context, provisionRequest({ operationId }));
    store.completePreparation(context, { operationId, outcome: 'succeeded' });
    const db = rawDb(dir);
    assert.throws(() => db.exec("UPDATE receipt SET digest = 'x'"), /immutable/);
    assert.throws(() => db.exec('DELETE FROM receipt'), /immutable/);
    assert.throws(() => db.exec("UPDATE completion SET status = 'failed'"), /immutable/);
    assert.throws(() => db.exec("UPDATE robot SET owner_id = 'x'"), /immutable/);
    assert.throws(() => db.exec("UPDATE resource_blocker SET kind = 'x'"), /immutable/);
    db.close();
    store.close();
});
