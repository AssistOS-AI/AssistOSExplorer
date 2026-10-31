import assert from 'node:assert/strict';
import test from 'node:test';

import { createVerifiedServiceContext } from '../../server/stateProtocol.mjs';
import {
    LIMITS, WORKSPACE, count, expectCode, makeTempDir, newId, openStore, rawDb, readyRobot, robotConfig, syntheticContext, syntheticRuntime
} from '../helpers/synthetic.mjs';

// M-8 U1 (store part): admitTerminal, the terminal caps, the three ends of a terminal attempt (normal end, generation recovery, blocker
// settlement) and the M-54 configure/delete refusal that names the open terminals.

const LIMITS_X = Object.freeze({ ...LIMITS, requestBytes: 65536, resultBytes: 4096, admissions: 64, receipts: 256, bindings: 8, controls: 16, tokenReplayEntries: 64 });
const ROBOTS = `workspace:${WORKSPACE}`;
const lifecycle = createVerifiedServiceContext({ workspaceId: WORKSPACE, scope: 'scope-lifecycle', ownerId: 'user:root', robotOwnerId: ROBOTS, operations: ['provision', 'configure', 'delete', 'read', 'adapter_complete'], administrator: true });
const adapter = createVerifiedServiceContext({ workspaceId: WORKSPACE, scope: 'worker:terminals', ownerId: 'worker:terminals', robotOwnerId: 'worker:terminals', operations: ['adapter_complete'] });
const caps = { maxPerRobot: 4, maxTotal: 16 };

function setup(t, options = {}) {
    const dir = makeTempDir(t);
    const runtime = syntheticRuntime();
    const store = openStore(dir, { limits: LIMITS_X, runtime, ...options });
    t.after(() => store.close());
    const robotId = readyRobot(store, syntheticContext({ robotOwnerId: ROBOTS, scope: 'scope-robots' }));
    return { dir, store, robotId, runtime };
}

const admit = (store, robotId, extra = {}) => store.admitTerminal({ robotId, ownerId: 'user:root', ...caps, ...extra });
const row = (dir, executionId) => {
    const db = rawDb(dir, { readOnly: true });
    try { return db.prepare('SELECT kind, logical_kind, state, owner_id, result FROM admission WHERE execution_id = ?').get(executionId); } finally { db.close(); }
};

test('admitTerminal records a queued terminal admission and its internal reference, no origin and no receipt', (t) => {
    const { dir, store, robotId } = setup(t);
    const before = { origin: count(dir, 'origin'), receipt: count(dir, 'receipt') };
    const admitted = admit(store, robotId);
    assert.equal(admitted.robotId, robotId);
    assert.deepEqual({ ...row(dir, admitted.executionId), result: null }, { kind: 'terminal', logical_kind: 'terminal', state: 'queued', owner_id: 'user:root', result: null });
    const db = rawDb(dir, { readOnly: true });
    t.after(() => db.close());
    assert.equal(db.prepare('SELECT kind FROM reference WHERE execution_id = ?').get(admitted.executionId).kind, 'terminal');
    assert.deepEqual({ origin: count(dir, 'origin'), receipt: count(dir, 'receipt') }, before);
    // Each terminal is its own logical work.
    const second = admit(store, robotId);
    const logical = db.prepare('SELECT COUNT(DISTINCT logical_id) AS n FROM admission WHERE kind = ?').get('terminal').n;
    assert.equal(logical, 2);
    assert.equal(store.countOpenTerminals({ robotId }), 2);
    assert.equal(store.countOpenTerminals(), 2);
    assert.ok(second.executionId !== admitted.executionId);
    // Never offered to the dispatcher.
    assert.deepEqual(store.listQueuedAdmissions(), []);
});

test('admitTerminal refusals: unknown robot not_found, unready robot runtime_unavailable, bad owner and caps invalid_request; nothing is written', (t) => {
    const { dir, store, robotId, runtime } = setup(t);
    expectCode(assert, () => admit(store, newId()), 'not_found');
    for (const extra of [{ ownerId: 'agent:x/y' }, { ownerId: 'user:' }, { maxPerRobot: 0 }, { maxTotal: 1.5 }]) expectCode(assert, () => admit(store, robotId, extra), 'invalid_request');
    expectCode(assert, () => store.admitTerminal({ robotId, ownerId: 'user:root', ...caps, extra: 1 }), 'invalid_request');
    runtime.admit = false;
    expectCode(assert, () => admit(store, robotId), 'runtime_unavailable');
    runtime.admit = true;
    // A robot that is not attested in the current generation is not ready.
    store.beginGenerationRecovery(store.generationId);
    store.completeGenerationRecovery(store.generationId);
    expectCode(assert, () => admit(store, robotId), 'runtime_unavailable');
    assert.equal(count(dir, 'admission'), 0);
});

test('caps: 4 per robot and the worker total, counted over queued, running and stopping terminals; AI admissions are not counted', (t) => {
    const { store, robotId } = setup(t);
    const other = readyRobot(store, syntheticContext({ robotOwnerId: ROBOTS, scope: 'scope-robots-2' }));
    const first = [0, 1, 2, 3].map(() => admit(store, robotId));
    expectCode(assert, () => admit(store, robotId), 'capacity_exceeded');
    // A stopping terminal still holds its place (a blocker keeps it stopping).
    store.transitionAttempt({ executionId: first[0].executionId, attemptId: first[0].attemptId, expectedState: 'queued', nextState: 'running' });
    store.reserveResource({ kind: 'process-tree', locator: { id: newId() }, executionId: first[0].executionId, attemptId: first[0].attemptId, processBearing: true });
    store.beginAttemptEnd(adapter, { executionId: first[0].executionId, attemptId: first[0].attemptId, expectedState: 'running', outcome: { classification: 'cancelled', outputText: '', data: { cause: 'shutdown' } } });
    expectCode(assert, () => admit(store, robotId), 'capacity_exceeded');
    // The worker total binds across robots.
    admit(store, other, { maxTotal: 5 });
    expectCode(assert, () => admit(store, other, { maxTotal: 5 }), 'capacity_exceeded');
    // An ended terminal frees its place.
    store.beginAttemptEnd(adapter, { executionId: first[1].executionId, attemptId: first[1].attemptId, expectedState: 'queued', outcome: { classification: 'cancelled', outputText: '', data: { cause: 'shutdown' } } });
    assert.ok(admit(store, robotId).executionId);
});

test('B-1 ends: normally (beginAttemptEnd), by blocker settlement, and by generation recovery; the result holds no terminal bytes', (t) => {
    const { dir, store, robotId } = setup(t);
    // Normal end without blockers: settles at once.
    const normal = admit(store, robotId);
    store.transitionAttempt({ executionId: normal.executionId, attemptId: normal.attemptId, expectedState: 'queued', nextState: 'running' });
    const ended = store.beginAttemptEnd(adapter, { executionId: normal.executionId, attemptId: normal.attemptId, expectedState: 'running', outcome: { classification: 'completed', outputText: '', data: { cause: 'exit', exitCode: 0 } } });
    assert.equal(ended.state, 'completed');
    assert.deepEqual(JSON.parse(row(dir, normal.executionId).result), { status: 'completed', cleanup: 'released', outputText: '', data: { cause: 'exit', exitCode: 0 } });
    // Blocker settlement: stopping until its last blocker is released.
    const held = admit(store, robotId);
    store.transitionAttempt({ executionId: held.executionId, attemptId: held.attemptId, expectedState: 'queued', nextState: 'running' });
    const { resourceId } = store.reserveResource({ kind: 'process-tree', locator: { id: newId() }, executionId: held.executionId, attemptId: held.attemptId, processBearing: true });
    assert.equal(store.beginAttemptEnd(adapter, { executionId: held.executionId, attemptId: held.attemptId, expectedState: 'running', outcome: { classification: 'cancelled', outputText: '', data: { cause: 'shutdown' } } }).state, 'stopping');
    assert.equal(store.countOpenTerminals({ robotId }), 1);
    store.releaseResource({ resourceId, generationId: store.generationId });
    assert.equal(row(dir, held.executionId).state, 'cancelled');
    // A quarantined process tree: termination unverified, the robot is nonready (no further terminal, no AI admission).
    const quarantined = admit(store, robotId);
    store.transitionAttempt({ executionId: quarantined.executionId, attemptId: quarantined.attemptId, expectedState: 'queued', nextState: 'running' });
    const tree = store.reserveResource({ kind: 'process-tree', locator: { id: newId() }, executionId: quarantined.executionId, attemptId: quarantined.attemptId, processBearing: true });
    store.beginAttemptEnd(adapter, { executionId: quarantined.executionId, attemptId: quarantined.attemptId, expectedState: 'running', outcome: { classification: 'interrupted', outputText: '', data: { cause: 'lease-expiry' } } });
    store.quarantineResource({ resourceId: tree.resourceId, generationId: store.generationId });
    assert.equal(JSON.parse(row(dir, quarantined.executionId).result).reason, 'termination_unverified');
    expectCode(assert, () => admit(store, robotId), 'resource_quarantined');
    // Generation recovery: a running terminal of the prior generation is interrupted.
    const { store: fresh, robotId: robot2, dir: dir2 } = setup(t);
    const running = admit(fresh, robot2);
    fresh.transitionAttempt({ executionId: running.executionId, attemptId: running.attemptId, expectedState: 'queued', nextState: 'running' });
    fresh.beginGenerationRecovery(fresh.generationId);
    assert.equal(row(dir2, running.executionId).state, 'interrupted');
    assert.equal(fresh.countOpenTerminals(), 0);
});

test('M-54: configure and delete refuse terminals_open with the count while a terminal is open, and proceed once it ended', (t) => {
    const { store, robotId } = setup(t);
    const open = [admit(store, robotId), admit(store, robotId)];
    const refusal = (fn) => {
        try { fn(); } catch (error) { return { code: error.code, terminals: error.terminals }; }
        return null;
    };
    const configure = () => store.configure(lifecycle, { operationId: newId(), robotId, expectedRevision: 1, configuration: robotConfig({ x: 1 }) });
    const remove = () => store.beginDelete(lifecycle, { operationId: newId(), robotId, expectedRevision: 1 });
    assert.deepEqual(refusal(configure), { code: 'terminals_open', terminals: 2 });
    assert.deepEqual(refusal(remove), { code: 'terminals_open', terminals: 2 });
    for (const admitted of open) {
        store.beginAttemptEnd(adapter, { executionId: admitted.executionId, attemptId: admitted.attemptId, expectedState: 'queued', outcome: { classification: 'cancelled', outputText: '', data: { cause: 'shutdown' } } });
    }
    assert.equal(configure().status, 'accepted');
});
