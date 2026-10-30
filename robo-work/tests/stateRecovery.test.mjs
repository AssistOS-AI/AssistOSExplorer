import assert from 'node:assert/strict';
import test from 'node:test';
import { raceChildren } from './helpers/childRunner.mjs';
import {
    WORKSPACE, admitRequest, count, endAttempt, expectCode, makeTempDir, newId, openStore, rawDb, readyRobot, robotConfig,
    syntheticContext
} from './helpers/synthetic.mjs';

const CONTEXT_FIELDS = {
    workspaceId: WORKSPACE, scope: 'scope-synthetic-a', ownerId: 'owner-synthetic-a',
    operations: ['provision', 'configure', 'delete', 'admit', 'lookup', 'read', 'attest', 'adapter_complete'], originNamespace: 'mcp', originKey: 'user:synthetic-a'
};

test('reopen alone binds the persisted generation and replays nothing', (t) => {
    const dir = makeTempDir(t);
    let store = openStore(dir);
    const context = syntheticContext();
    const robotId = readyRobot(store, context);
    const request = admitRequest(robotId);
    const admitted = store.admit(context, request);
    const generation = store.generationId;
    store.close();
    store = openStore(dir, { create: false });
    assert.equal(store.generationId, generation);
    assert.equal(count(dir, 'generation'), 1);
    assert.equal(count(dir, 'admission'), 1);
    assert.equal(store.lookupOrigin(context, { originRequestId: request.originRequestId }).state, 'queued');
    assert.equal(store.admit(context, request).executionId, admitted.executionId);
    assert.equal(store.getRobot(context, { robotId }).ready, true);
    store.close();
});

test('two recovery starts expecting the same generation yield one rollover and one stale_generation', (t) => {
    const dir = makeTempDir(t);
    const first = openStore(dir);
    const second = openStore(dir, { create: false });
    const generation = first.generationId;
    assert.equal(second.generationId, generation);
    const rolled = first.beginGenerationRecovery(generation);
    assert.notEqual(rolled.generationId, generation);
    assert.equal(rolled.priorGenerationId, generation);
    assert.equal(first.generationId, rolled.generationId);
    expectCode(assert, () => second.beginGenerationRecovery(generation), 'stale_generation');
    assert.equal(second.generationId, generation, 'a stale handle never refreshes itself');
    expectCode(assert, () => second.beginGenerationRecovery(rolled.generationId), 'stale_generation');
    expectCode(assert, () => first.beginGenerationRecovery(generation), 'stale_generation');
    const db = rawDb(dir, { readOnly: true });
    assert.equal(db.prepare('SELECT COUNT(*) AS c FROM generation').get().c, 2);
    assert.equal(db.prepare("SELECT COUNT(*) AS c FROM generation WHERE state = 'active'").get().c, 1);
    db.close();
    first.close();
    second.close();
});

test('two processes racing recovery starts from one expected generation: one winner, one stale_generation', async (t) => {
    const dir = makeTempDir(t);
    const store = openStore(dir);
    const generation = store.generationId;
    store.close();
    const spec = { dir, method: 'beginGenerationRecovery', request: { expectedGeneration: generation } };
    const results = await raceChildren([spec, spec]);
    const outcomes = results.map((result) => (result.output?.ok ? 'ok' : result.output?.code)).toSorted();
    assert.deepEqual(outcomes, ['ok', 'stale_generation']);
    assert.equal(count(dir, 'generation'), 2);
    const db = rawDb(dir, { readOnly: true });
    assert.equal(db.prepare("SELECT COUNT(*) AS c FROM generation WHERE state = 'active'").get().c, 1);
    db.close();
});

test('a stale writer cannot mutate, complete, transition, release or complete recovery', (t) => {
    const dir = makeTempDir(t);
    const current = openStore(dir);
    const stale = openStore(dir, { create: false });
    const context = syntheticContext();
    const robotId = readyRobot(current, context);
    const admitted = current.admit(context, admitRequest(robotId));
    const provision = { operationId: newId(), name: 'p', configuration: robotConfig() };
    current.beginProvision(context, provision);
    const { resourceId } = current.reserveResource({ robotId, kind: 'workdir', locator: { dir: 'synthetic' } });
    const oldGeneration = current.generationId;
    const rolled = current.beginGenerationRecovery(oldGeneration);
    expectCode(assert, () => stale.completePreparation(context, { operationId: provision.operationId, outcome: 'succeeded' }), 'stale_generation');
    expectCode(assert, () => stale.beginProvision(context, { ...provision, operationId: newId() }), 'stale_generation');
    expectCode(assert, () => stale.admit(context, admitRequest(robotId)), 'stale_generation');
    expectCode(assert, () => stale.reserveResource({ robotId, kind: 'x', locator: { dir: 'synthetic' } }), 'stale_generation');
    expectCode(assert, () => stale.commitResource({ resourceId, identity: { a: 1 } }), 'stale_generation');
    expectCode(assert, () => stale.retainResource({ resourceId }), 'stale_generation');
    expectCode(assert, () => stale.beginAttemptEnd(context, { executionId: admitted.executionId, attemptId: admitted.attemptId, expectedState: 'queued', outcome: { classification: 'cancelled' } }), 'stale_generation');
    expectCode(assert, () => stale.clearQuarantine(syntheticContext({ administrator: true }), { operationId: newId(), resourceId, attestation: 'a'.repeat(64) }), 'stale_generation');
    expectCode(assert, () => stale.releaseResource({ resourceId, generationId: oldGeneration }), 'stale_generation');
    expectCode(assert, () => stale.transitionAttempt({ executionId: admitted.executionId, attemptId: admitted.attemptId, expectedState: 'queued', nextState: 'running' }), 'stale_generation');
    expectCode(assert, () => stale.completeGenerationRecovery(oldGeneration), 'stale_generation');
    expectCode(assert, () => stale.attestReadiness(context, { robotId }), 'stale_generation');
    expectCode(assert, () => stale.beginDelete(context, { operationId: newId(), robotId, expectedRevision: 1 }), 'stale_generation');
    // the attempt was settled by recovery; the current writer cannot advance it
    expectCode(assert, () => current.transitionAttempt({ executionId: admitted.executionId, attemptId: admitted.attemptId, expectedState: 'queued', nextState: 'running' }), 'stale_generation');
    assert.equal(count(dir, 'receipt'), 3);
    assert.equal(rolled.unsettledBlockers.length, 2);
    stale.close();
    current.close();
});

test('recovery is blocked by unreleased resources until current authority releases them; then attestation and fresh admission work', (t) => {
    const dir = makeTempDir(t);
    const store = openStore(dir);
    const context = syntheticContext();
    const robotId = readyRobot(store, context);
    const { resourceId } = store.reserveResource({ robotId, kind: 'workdir', locator: { dir: 'synthetic' } });
    const old = store.generationId;
    const rolled = store.beginGenerationRecovery(old);
    assert.deepEqual(rolled.unsettledBlockers.map((blocker) => [blocker.resourceId, blocker.kind, blocker.generationId]), [[resourceId, 'workdir', old]]);
    assert.deepEqual(store.listUnsettledResources().map((blocker) => blocker.current), [false]);
    // readiness and fresh runtime admissions fail while recovery is pending
    expectCode(assert, () => store.completeGenerationRecovery(rolled.generationId), 'recovery_pending');
    expectCode(assert, () => store.admit(context, admitRequest(robotId)), 'recovery_pending');
    expectCode(assert, () => store.attestReadiness(context, { robotId }), 'recovery_pending');
    expectCode(assert, () => store.beginProvision(context, { operationId: newId(), name: 'p', configuration: robotConfig() }), 'recovery_pending');
    expectCode(assert, () => store.configure(context, { operationId: newId(), robotId, expectedRevision: 1, configuration: robotConfig() }), 'recovery_pending');
    assert.equal(store.getRobot(context, { robotId }).ready, false);
    // mismatched and unknown resources are refused
    expectCode(assert, () => store.releaseResource({ resourceId, generationId: rolled.generationId }), 'not_found');
    expectCode(assert, () => store.releaseResource({ resourceId: newId(), generationId: old }), 'not_found');
    expectCode(assert, () => store.completeGenerationRecovery(rolled.generationId), 'recovery_pending');
    // current recovery authority records release of the old generation's resource
    assert.equal(store.releaseResource({ resourceId, generationId: old }).state, 'released');
    assert.equal(store.releaseResource({ resourceId, generationId: old }).state, 'released', 'idempotent');
    assert.deepEqual(store.completeGenerationRecovery(rolled.generationId), { generationId: rolled.generationId, recovered: true });
    // an attestation in the current generation is required before new work
    expectCode(assert, () => store.admit(context, admitRequest(robotId)), 'runtime_unavailable');
    store.attestReadiness(context, { robotId });
    const admitted = store.admit(context, admitRequest(robotId));
    assert.equal(admitted.status, 'admitted');
    store.close();
});

test('rollover preserves robots, receipts and origin mappings; an attempt without blockers publishes its interrupted result once', (t) => {
    const dir = makeTempDir(t);
    const store = openStore(dir);
    const context = syntheticContext();
    const robotId = readyRobot(store, context);
    const request = admitRequest(robotId);
    const admitted = store.admit(context, request);
    store.transitionAttempt({ executionId: admitted.executionId, attemptId: admitted.attemptId, expectedState: 'queued', nextState: 'running' });
    const before = { receipts: count(dir, 'receipt'), origins: count(dir, 'origin'), robots: count(dir, 'robot') };
    const rolled = store.beginGenerationRecovery(store.generationId);
    const looked = store.lookupOrigin(context, { originRequestId: request.originRequestId });
    assert.deepEqual([looked.state, looked.cleanup], ['interrupted', 'released']);
    assert.deepEqual(looked.result, { status: 'interrupted', cleanup: 'released', outputText: '', data: null });
    assert.deepEqual(store.completeGenerationRecovery(rolled.generationId), { generationId: rolled.generationId, recovered: true });
    assert.deepEqual({ receipts: count(dir, 'receipt'), origins: count(dir, 'origin'), robots: count(dir, 'robot') }, before);
    assert.equal(looked.reference.id, admitted.reference.id);
    assert.equal(store.admit(context, request).executionId, admitted.executionId, 'retry returns the recorded admission');
    assert.deepEqual(store.lookupOrigin(context, { originRequestId: request.originRequestId }).result, looked.result);
    store.close();
});

test('an interrupted attempt stays stopping with no result through an unreleased blocker and a delayed release, then publishes once', (t) => {
    const dir = makeTempDir(t);
    let store = openStore(dir);
    const context = syntheticContext();
    const robotId = readyRobot(store, context);
    const admitted = store.admit(context, admitRequest(robotId, {}, context));
    store.transitionAttempt({ executionId: admitted.executionId, attemptId: admitted.attemptId, expectedState: 'queued', nextState: 'running' });
    const blocker = store.reserveResource({ robotId, executionId: admitted.executionId, attemptId: admitted.attemptId, kind: 'workdir', locator: { dir: 'w' } }).resourceId;
    const old = store.generationId;
    const rolled = store.beginGenerationRecovery(old);
    const status = () => store.getReference(context, { referenceId: admitted.reference.id });
    assert.deepEqual([status().state, status().cleanup, status().result], ['stopping', 'pending', null]);
    expectCode(assert, () => store.completeGenerationRecovery(rolled.generationId), 'recovery_pending');
    store.close();
    store = openStore(dir, { create: false });
    assert.deepEqual([status().state, status().result], ['stopping', null], 'delayed release survives reopen');
    // the reopened handle is bound to the current generation; it settles the old generation's blocker
    assert.equal(store.releaseResource({ resourceId: blocker, generationId: old }).state, 'released');
    assert.deepEqual(status().result, { status: 'interrupted', cleanup: 'released', outputText: '', data: null });
    store.releaseResource({ resourceId: blocker, generationId: old });
    assert.deepEqual(status().result.status, 'interrupted');
    store.completeGenerationRecovery(rolled.generationId);
    store.close();
});

test('a failed release that becomes quarantined publishes the interrupted attempt once; a process tree gives termination_unverified', (t) => {
    const dir = makeTempDir(t);
    const store = openStore(dir);
    const context = syntheticContext();
    const robotId = readyRobot(store, context);
    const plain = store.admit(context, admitRequest(robotId, {}, context));
    const tree = store.admit(context, admitRequest(robotId, {}, context));
    const plainBlocker = store.reserveResource({ robotId, executionId: plain.executionId, attemptId: plain.attemptId, kind: 'mount', locator: { m: 1 } }).resourceId;
    const treeBlocker = store.reserveResource({ robotId, executionId: tree.executionId, attemptId: tree.attemptId, kind: 'process-tree', processBearing: true, locator: { ns: 1 } }).resourceId;
    const old = store.generationId;
    const rolled = store.beginGenerationRecovery(old);
    assert.deepEqual(rolled.unsettledBlockers.map((blocker) => [blocker.kind, blocker.processBearing, typeof blocker.locator]).toSorted(), [['mount', false, 'object'], ['process-tree', true, 'object']]);
    store.quarantineResource({ resourceId: plainBlocker, generationId: old });
    store.quarantineResource({ resourceId: treeBlocker, generationId: old });
    const read = (admitted) => store.getReference(context, { referenceId: admitted.reference.id }).result;
    assert.deepEqual(read(plain), { status: 'interrupted', cleanup: 'quarantined', outputText: '', data: null });
    assert.deepEqual(read(tree), { status: 'failed', reason: 'termination_unverified', classification: 'interrupted', cleanup: 'quarantined', outputText: '', data: null });
    store.quarantineResource({ resourceId: treeBlocker, generationId: old });
    assert.deepEqual(read(tree).reason, 'termination_unverified');
    store.close();
});

test('recovery leaves an attempt that was already stopping unchanged in classification and payload', (t) => {
    const dir = makeTempDir(t);
    const store = openStore(dir);
    const context = syntheticContext();
    const robotId = readyRobot(store, context);
    const admitted = store.admit(context, admitRequest(robotId, {}, context));
    store.transitionAttempt({ executionId: admitted.executionId, attemptId: admitted.attemptId, expectedState: 'queued', nextState: 'running' });
    const blocker = store.reserveResource({ robotId, executionId: admitted.executionId, attemptId: admitted.attemptId, kind: 'workdir', locator: { dir: 'w' } }).resourceId;
    endAttempt(store, context, admitted, 'completed', { expectedState: 'running', outputText: 'kept text', data: { keep: true } });
    const old = store.generationId;
    const rolled = store.beginGenerationRecovery(old);
    const db = rawDb(dir, { readOnly: true });
    const row = db.prepare('SELECT state, end_classification, end_payload FROM admission WHERE execution_id = ?').get(admitted.executionId);
    db.close();
    assert.deepEqual([row.state, row.end_classification, JSON.parse(row.end_payload)], ['stopping', 'completed', { outputText: 'kept text', data: { keep: true } }]);
    store.releaseResource({ resourceId: blocker, generationId: old });
    assert.deepEqual(store.getReference(context, { referenceId: admitted.reference.id }).result, { status: 'completed', cleanup: 'released', outputText: 'kept text', data: { keep: true } });
    store.completeGenerationRecovery(rolled.generationId);
    store.close();
});

test('recovery completes with one quarantined blocker: the owning robot refuses, an unaffected robot attests and admits', (t) => {
    const dir = makeTempDir(t);
    const store = openStore(dir);
    const context = syntheticContext();
    const owner = readyRobot(store, context);
    const bystander = readyRobot(store, context);
    const admitted = store.admit(context, admitRequest(owner, {}, context));
    const blocker = store.reserveResource({ robotId: owner, executionId: admitted.executionId, attemptId: admitted.attemptId, kind: 'mount', locator: { m: 1 } }).resourceId;
    const settled = store.reserveResource({ robotId: bystander, kind: 'view', locator: { v: 1 } }).resourceId;
    const old = store.generationId;
    const rolled = store.beginGenerationRecovery(old);
    // quarantine takes effect from the recording transaction, before recovery completes
    store.quarantineResource({ resourceId: blocker, generationId: old });
    store.releaseResource({ resourceId: settled, generationId: old });
    assert.equal(store.getRobot(context, { robotId: owner }).reason, 'resource_quarantined');
    assert.deepEqual(store.completeGenerationRecovery(rolled.generationId), { generationId: rolled.generationId, recovered: true });
    store.attestReadiness(context, { robotId: bystander });
    assert.equal(store.admit(context, admitRequest(bystander, {}, context)).status, 'admitted');
    expectCode(assert, () => store.attestReadiness(context, { robotId: owner }), 'resource_quarantined');
    expectCode(assert, () => store.admit(context, admitRequest(owner, {}, context)), 'resource_quarantined');
    expectCode(assert, () => store.configure(context, { operationId: newId(), robotId: owner, expectedRevision: 1, configuration: robotConfig({ x: 1 }) }), 'resource_quarantined');
    assert.equal(store.getWorkerStatus().degraded, false);
    // an unowned quarantine from a later recovery degrades only its kind
    const worker = store.reserveResource({ kind: 'gpu', locator: { d: 0 } }).resourceId;
    const second = store.beginGenerationRecovery(store.generationId);
    store.quarantineResource({ resourceId: worker, generationId: second.priorGenerationId });
    assert.deepEqual(store.getWorkerStatus().degradedKinds, ['gpu']);
    store.close();
});

test('interrupted provisioning becomes failed and nonready; a late completion is refused', (t) => {
    const dir = makeTempDir(t);
    const store = openStore(dir);
    const context = syntheticContext();
    const provision = { operationId: newId(), name: 'p', configuration: robotConfig() };
    const { robotId } = store.beginProvision(context, provision);
    const old = store.generationId;
    const rolled = store.beginGenerationRecovery(old);
    assert.deepEqual(rolled.unsettledBlockers.map((blocker) => blocker.kind), ['preparation']);
    const robot = store.getRobot(context, { robotId });
    assert.deepEqual([robot.lifecycle, robot.ready, robot.revision, robot.uncertain], ['failed', false, 0, true]);
    assert.equal(store.getOperationOutcome(context, { operationId: provision.operationId }).status, 'interrupted');
    expectCode(assert, () => store.completePreparation(context, { operationId: provision.operationId, outcome: 'succeeded' }), 'stale_generation');
    assert.equal(store.getRobot(context, { robotId }).revision, 0);
    // the old preparation blocker is released by the current recovery authority, never by completion
    store.releaseResource({ resourceId: rolled.unsettledBlockers[0].resourceId, generationId: old });
    store.completeGenerationRecovery(rolled.generationId);
    const repair = newId();
    store.configure(context, { operationId: repair, robotId, expectedRevision: 0, configuration: robotConfig() });
    store.completePreparation(context, { operationId: repair, outcome: 'succeeded' });
    assert.deepEqual([store.getRobot(context, { robotId }).ready, store.getRobot(context, { robotId }).revision], [true, 1]);
    store.close();
});

test('interrupted configuration keeps the previous effective configuration, nonready until explicit repair', (t) => {
    const dir = makeTempDir(t);
    const store = openStore(dir);
    const context = syntheticContext();
    const robotId = readyRobot(store, context, robotConfig({ mode: 'orig' }));
    const operationId = newId();
    store.configure(context, { operationId, robotId, expectedRevision: 1, configuration: robotConfig({ mode: 'new' }) });
    const old = store.generationId;
    const rolled = store.beginGenerationRecovery(old);
    store.releaseResource({ resourceId: rolled.unsettledBlockers[0].resourceId, generationId: old });
    store.completeGenerationRecovery(rolled.generationId);
    let robot = store.getRobot(context, { robotId });
    assert.deepEqual([robot.revision, robot.configuration.settings.mode, robot.ready, robot.uncertain], [1, 'orig', false, true]);
    expectCode(assert, () => store.attestReadiness(context, { robotId }), 'robot_busy');
    expectCode(assert, () => store.completePreparation(context, { operationId, outcome: 'succeeded' }), 'stale_generation');
    const repair = newId();
    store.configure(context, { operationId: repair, robotId, expectedRevision: 1, configuration: robotConfig({ mode: 'orig' }) });
    store.completePreparation(context, { operationId: repair, outcome: 'succeeded' });
    robot = store.getRobot(context, { robotId });
    assert.deepEqual([robot.revision, robot.ready], [2, true]);
    assert.equal(store.admit(context, admitRequest(robotId, { configRevision: 2 })).status, 'admitted');
    store.close();
});

test('an accepted deletion stays deleting through rollover and completes once its blockers are released', (t) => {
    const dir = makeTempDir(t);
    const store = openStore(dir);
    const context = syntheticContext();
    const robotId = readyRobot(store, context);
    const { resourceId } = store.reserveResource({ robotId, kind: 'workdir', locator: { dir: 'synthetic' } });
    const operationId = newId();
    store.beginDelete(context, { operationId, robotId, expectedRevision: 1 });
    const old = store.generationId;
    const rolled = store.beginGenerationRecovery(old);
    assert.equal(store.getRobot(context, { robotId }).lifecycle, 'deleting');
    expectCode(assert, () => store.completeDelete(context, { operationId }), 'robot_busy');
    store.releaseResource({ resourceId, generationId: old });
    store.completeGenerationRecovery(rolled.generationId);
    assert.equal(store.completeDelete(context, { operationId }).status, 'succeeded');
    assert.equal(store.getRobot(context, { robotId }).lifecycle, 'deleted');
    store.close();
});

test('preparation completion racing a rollover is settled exactly once; a delete is busy while the creation is pending and works after the rollover', (t) => {
    const dir = makeTempDir(t);
    const store = openStore(dir);
    const context = syntheticContext();
    const provision = { operationId: newId(), name: 'p', configuration: robotConfig() };
    const { robotId } = store.beginProvision(context, provision);
    expectCode(assert, () => store.beginDelete(context, { operationId: newId(), robotId, expectedRevision: 0 }), 'robot_busy');
    const old = store.generationId;
    const rolled = store.beginGenerationRecovery(old);
    // the preparation was interrupted by the rollover; completion cannot publish it
    expectCode(assert, () => store.completePreparation(context, { operationId: provision.operationId, outcome: 'succeeded' }), 'stale_generation');
    assert.equal(store.getRobot(context, { robotId }).revision, 0);
    const deleteOp = newId();
    store.beginDelete(context, { operationId: deleteOp, robotId, expectedRevision: 0 });
    expectCode(assert, () => store.completeDelete(context, { operationId: deleteOp }), 'robot_busy');
    store.releaseResource({ resourceId: rolled.unsettledBlockers[0].resourceId, generationId: old });
    assert.equal(store.completeDelete(context, { operationId: deleteOp }).status, 'succeeded');
    store.close();
});

test('a pending preparation blocker cannot be released directly', (t) => {
    const dir = makeTempDir(t);
    const store = openStore(dir);
    const context = syntheticContext();
    const provision = { operationId: newId(), name: 'p', configuration: robotConfig() };
    store.beginProvision(context, provision);
    const blocker = store.listUnsettledResources()[0];
    expectCode(assert, () => store.releaseResource({ resourceId: blocker.resourceId, generationId: blocker.generationId }), 'robot_busy');
    assert.equal(store.listUnsettledResources().length, 1);
    store.close();
});
