import assert from 'node:assert/strict';
import test from 'node:test';
import { createVerifiedServiceContext } from '../server/workerState.mjs';
import {
    LIMITS, WORKSPACE, admitRequest, count, expectCode, locatorFor, makeTempDir, newId, openStore, rawDb, readyRobot, syntheticContext
} from './helpers/synthetic.mjs';

// S1x reference events, snapshots and relayed controls. Contexts are SYNTHETIC internal
// preconditions and the runtime is the explicitly synthetic adapter: state evidence only.

const EXTENDED = Object.freeze({ ...LIMITS, bindings: 8, controls: 16, tokenReplayEntries: 16 });
const ROBOTS = `workspace:${WORKSPACE}`;

function user(id, extra = {}) {
    return syntheticContext({ originKey: `user:${id}`, ownerId: `user:${id}`, scope: `scope-${id}`, robotOwnerId: ROBOTS, ...extra });
}

const ADAPTER = () => syntheticContext({ scope: 'scope-adapter' });

function setup(t, limits = EXTENDED) {
    const dir = makeTempDir(t);
    const store = openStore(dir, { limits });
    t.after(() => store.close());
    const robotId = readyRobot(store, syntheticContext({ robotOwnerId: ROBOTS, scope: 'scope-robots' }));
    return { dir, store, robotId };
}

function admitAs(store, robotId, context, overrides = {}) {
    return store.admit(context, admitRequest(robotId, overrides, context));
}

function events(store, context, referenceId, after = 0, limit = 100) {
    return store.listReferenceEvents(context, { referenceId, after, limit });
}

function states(store, context, referenceId) {
    return events(store, context, referenceId).events.map((event) => event.data);
}

function captureError(fn) {
    try {
        fn();
    } catch (error) {
        return { name: error.name, code: error.code, message: error.message, reason: error.reason };
    }
    return assert.fail('expected an error');
}

test('state events track queued, running, stopping and terminal; sequence equals the cursor and survives reopen', (t) => {
    const dir = makeTempDir(t);
    let store = openStore(dir, { limits: EXTENDED });
    const robotId = readyRobot(store, syntheticContext({ robotOwnerId: ROBOTS, scope: 'scope-robots' }));
    const alice = user('alice');
    const request = admitRequest(robotId, {}, alice);
    const admitted = store.admit(alice, request);
    const referenceId = admitted.reference.id;
    store.transitionAttempt({ executionId: admitted.executionId, attemptId: admitted.attemptId, expectedState: 'queued', nextState: 'running' });
    const { resourceId } = store.reserveResource({ kind: 'workdir', locator: locatorFor('workdir'), executionId: admitted.executionId, attemptId: admitted.attemptId });
    store.beginAttemptEnd(ADAPTER(), {
        executionId: admitted.executionId, attemptId: admitted.attemptId, expectedState: 'running',
        outcome: { classification: 'completed', outputText: 'done', data: { n: 1 } }
    });
    const stopping = store.observeReference(alice, { referenceId });
    assert.equal(stopping.state, 'stopping');
    assert.equal(stopping.cleanup, 'pending');
    assert.equal(stopping.result, null);
    assert.equal(stopping.endedReason, null);
    assert.equal(stopping.sequence, 3);
    assert.deepEqual(states(store, alice, referenceId), [{ state: 'queued' }, { state: 'running' }, { state: 'stopping', cleanup: 'pending' }]);
    store.releaseResource({ resourceId, generationId: store.generationId });
    store.close();
    store = openStore(dir, { limits: EXTENDED, create: false });
    t.after(() => store.close());
    const listed = events(store, alice, referenceId);
    assert.deepEqual(listed.events.map((event) => event.sequence), [1, 2, 3, 4]);
    assert.deepEqual(listed.events[3].data, { state: 'completed', cleanup: 'released' });
    assert.equal(listed.nextAfter, 4);
    for (const event of listed.events) {
        assert.equal(event.type, 'state');
        assert.match(event.at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    }
    const final = store.observeReference(alice, { referenceId });
    assert.equal(final.sequence, 4);
    assert.equal(final.endedReason, 'completed');
    assert.deepEqual(final.result, { status: 'completed', cleanup: 'released', outputText: 'done', data: { n: 1 } });
    assert.equal(final.originRequestId, request.originRequestId);
});

test('recovery appends interrupted events and publishes exactly once', (t) => {
    const { store, robotId } = setup(t);
    const alice = user('alice');
    const held = admitAs(store, robotId, alice);
    const bare = admitAs(store, robotId, alice);
    const { resourceId } = store.reserveResource({ kind: 'workdir', locator: locatorFor('workdir'), executionId: held.executionId, attemptId: held.attemptId });
    const prior = store.generationId;
    store.beginGenerationRecovery(prior);
    assert.deepEqual(states(store, alice, bare.reference.id), [{ state: 'queued' }, { state: 'stopping', cleanup: 'pending' }, { state: 'interrupted', cleanup: 'released' }]);
    assert.deepEqual(states(store, alice, held.reference.id), [{ state: 'queued' }, { state: 'stopping', cleanup: 'pending' }]);
    store.releaseResource({ resourceId, generationId: prior });
    assert.deepEqual(states(store, alice, held.reference.id), [{ state: 'queued' }, { state: 'stopping', cleanup: 'pending' }, { state: 'interrupted', cleanup: 'released' }]);
    store.completeGenerationRecovery(store.generationId);
    assert.equal(events(store, alice, held.reference.id).events.length, 3);
    assert.equal(store.observeReference(alice, { referenceId: held.reference.id }).endedReason, 'interrupted');
});

test('events paginate; after beyond the last sequence is refused; a retention gap reports snapshotSequence', (t) => {
    const { dir, store, robotId } = setup(t);
    const alice = user('alice');
    const admitted = admitAs(store, robotId, alice);
    const referenceId = admitted.reference.id;
    store.transitionAttempt({ executionId: admitted.executionId, attemptId: admitted.attemptId, expectedState: 'queued', nextState: 'running' });
    store.beginAttemptEnd(ADAPTER(), { executionId: admitted.executionId, attemptId: admitted.attemptId, expectedState: 'running', outcome: { classification: 'failed' } });
    const page1 = events(store, alice, referenceId, 0, 2);
    assert.deepEqual(page1.events.map((event) => event.sequence), [1, 2]);
    assert.equal(page1.nextAfter, 2);
    const page2 = events(store, alice, referenceId, page1.nextAfter, 2);
    assert.deepEqual(page2.events.map((event) => event.sequence), [3, 4]);
    const empty = events(store, alice, referenceId, 4, 2);
    assert.deepEqual(empty, { events: [], nextAfter: 4 });
    expectCode(assert, () => events(store, alice, referenceId, 5, 2), 'invalid_request');
    for (const [after, limit] of [[-1, 1], [0, 0], [0, 1001], [1.5, 1], [0, '1']]) {
        expectCode(assert, () => events(store, alice, referenceId, after, limit), 'invalid_request');
    }
    // White-box retention fixture: events before 3 are no longer retained.
    const db = rawDb(dir);
    try {
        db.prepare('UPDATE reference_cursor SET first_retained = 3 WHERE reference_id = ?').run(referenceId);
        assert.throws(() => db.prepare('UPDATE reference_cursor SET first_retained = 1 WHERE reference_id = ?').run(referenceId), /immutable/);
        assert.throws(() => db.prepare('DELETE FROM reference_event').run(), /immutable/);
    } finally {
        db.close();
    }
    assert.deepEqual(events(store, alice, referenceId, 0, 10), { gap: true, snapshotSequence: 4 });
    assert.deepEqual(events(store, alice, referenceId, 1, 10), { gap: true, snapshotSequence: 4 });
    assert.deepEqual(events(store, alice, referenceId, 2, 10).events.map((event) => event.sequence), [3, 4]);
});

test('observation: owner and administrator read, the origin row reads its binding only, others get a uniform not_found', (t) => {
    const { store, robotId } = setup(t);
    const alice = user('alice');
    const mine = admitAs(store, robotId, alice);
    store.registerBinding(syntheticContext({ originNamespace: 'coordinator:svc1', originKey: 'owner:user:alice', ownerId: 'user:alice', scope: 'scope-bind' }),
        { operationId: newId(), bindingId: 'flow1', kind: 'flow' });
    const background = syntheticContext({ originNamespace: 'coordinator:svc1', originKey: 'binding:flow1', ownerId: 'user:alice', scope: 'scope-bg', robotOwnerId: ROBOTS });
    const flowRef = admitAs(store, robotId, background);
    const admin = user('root', { administrator: true });
    const bob = user('bob');
    const coordinatorFlow1 = syntheticContext({ originNamespace: 'coordinator:svc1', originKey: 'binding:flow1', ownerId: 'coordinator:svc1', scope: 'scope-read-1' });
    const coordinatorFlow2 = syntheticContext({ originNamespace: 'coordinator:svc1', originKey: 'binding:flow2', ownerId: 'coordinator:svc1', scope: 'scope-read-2' });
    const otherCoordinator = syntheticContext({ originNamespace: 'coordinator:svc2', originKey: 'binding:flow1', ownerId: 'coordinator:svc2', scope: 'scope-read-3' });
    assert.equal(store.observeReference(alice, { referenceId: mine.reference.id }).state, 'queued');
    assert.equal(store.observeReference(admin, { referenceId: mine.reference.id }).state, 'queued');
    assert.equal(store.observeReference(alice, { referenceId: flowRef.reference.id }).state, 'queued');
    assert.equal(store.observeReference(coordinatorFlow1, { referenceId: flowRef.reference.id }).state, 'queued');
    assert.equal(events(store, coordinatorFlow1, flowRef.reference.id).events.length, 1);
    const unknown = captureError(() => store.observeReference(bob, { referenceId: 'A'.repeat(22) }));
    for (const [context, referenceId] of [[bob, mine.reference.id], [coordinatorFlow1, mine.reference.id], [coordinatorFlow2, flowRef.reference.id],
        [otherCoordinator, flowRef.reference.id], [bob, flowRef.reference.id]]) {
        assert.deepEqual(captureError(() => store.observeReference(context, { referenceId })), unknown);
        assert.deepEqual(captureError(() => events(store, context, referenceId)), unknown);
    }
    assert.equal(unknown.code, 'not_found');
    // Service contexts never observe, even when marked administrator.
    const service = createVerifiedServiceContext({ workspaceId: WORKSPACE, scope: 's', ownerId: 'user:alice', robotOwnerId: ROBOTS, operations: ['read'], administrator: true });
    expectCode(assert, () => store.observeReference(service, { referenceId: mine.reference.id }), 'forbidden');
    expectCode(assert, () => events(store, service, mine.reference.id), 'forbidden');
    expectCode(assert, () => store.observeReference(alice, { referenceId: 'short' }), 'invalid_request');
});

test('control authorization per op: admin stop accepted, admin message forbidden, non-owner not_found, origin row forbidden, owner message accepted', (t) => {
    const { dir, store, robotId } = setup(t);
    const alice = user('alice');
    store.registerBinding(syntheticContext({ originNamespace: 'coordinator:svc1', originKey: 'owner:user:alice', ownerId: 'user:alice', scope: 'scope-bind' }),
        { operationId: newId(), bindingId: 'flow1', kind: 'flow' });
    const background = syntheticContext({ originNamespace: 'coordinator:svc1', originKey: 'binding:flow1', ownerId: 'user:alice', scope: 'scope-bg', robotOwnerId: ROBOTS });
    const admitted = admitAs(store, robotId, background);
    const referenceId = admitted.reference.id;
    store.transitionAttempt({ executionId: admitted.executionId, attemptId: admitted.attemptId, expectedState: 'queued', nextState: 'running' });
    const admin = user('root', { administrator: true });
    const bob = user('bob');
    const originRow = syntheticContext({ originNamespace: 'coordinator:svc1', originKey: 'binding:flow1', ownerId: 'coordinator:svc1', scope: 'scope-read' });
    const message = (text) => ({ referenceId, operationId: newId(), op: 'message', payload: { message: text } });
    const stop = () => ({ referenceId, operationId: newId(), op: 'stop' });
    assert.deepEqual(store.controlReference(admin, { ...stop(), operationId: 'StopByAdmin00000000000' }),
        { operationId: 'StopByAdmin00000000000', op: 'stop', outcome: 'accepted', delivery: 'pending', state: 'running' });
    expectCode(assert, () => store.controlReference(admin, message('hello')), 'forbidden');
    expectCode(assert, () => store.controlReference(bob, stop()), 'not_found');
    expectCode(assert, () => store.controlReference(bob, message('hello')), 'not_found');
    // M-12 (C): the background row (coordinator plus the flow binding) may stop its own flow work, but a message stays owner-only. A
    // second stop returns the pending one without a new record.
    assert.deepEqual({ ...store.controlReference(originRow, stop()), operationId: null }, { operationId: null, op: 'stop', outcome: 'accepted', delivery: 'pending', state: 'running' });
    expectCode(assert, () => store.controlReference(originRow, message('hello')), 'forbidden');
    const sent = store.controlReference(alice, message('hello'));
    assert.deepEqual({ ...sent, operationId: null }, { operationId: null, op: 'message', outcome: 'accepted', delivery: 'pending', state: 'running' });
    // Only the two accepted controls were recorded; every refusal recorded nothing.
    assert.equal(count(dir, 'reference_control'), 2);
});

test('stop on a queued attempt cancels and publishes once; replay returns the record; a changed request conflicts', (t) => {
    const { dir, store, robotId } = setup(t);
    const alice = user('alice');
    const admitted = admitAs(store, robotId, alice);
    const referenceId = admitted.reference.id;
    const request = { referenceId, operationId: newId(), op: 'stop' };
    const first = store.controlReference(alice, request);
    assert.deepEqual({ ...first, operationId: null }, { operationId: null, op: 'stop', outcome: 'accepted', delivery: 'applied', state: 'cancelled' });
    assert.deepEqual(store.controlReference(alice, { ...request }), first);
    expectCode(assert, () => store.controlReference(alice, { ...request, attemptId: admitted.attemptId }), 'operation_conflict');
    expectCode(assert, () => store.controlReference(alice, { ...request, op: 'message', payload: { message: 'x' } }), 'operation_conflict');
    assert.equal(count(dir, 'reference_control'), 1);
    const snapshot = store.observeReference(alice, { referenceId });
    assert.equal(snapshot.state, 'cancelled');
    assert.equal(snapshot.endedReason, 'cancelled');
    assert.deepEqual(states(store, alice, referenceId).map((data) => data.state), ['queued', 'stopping', 'cancelled']);
    // A later stop on the terminal attempt is recorded as not applicable.
    const late = store.controlReference(alice, { referenceId, operationId: newId(), op: 'stop' });
    assert.equal(late.outcome, 'not_applicable');
    assert.equal(late.state, 'cancelled');
    assert.equal(states(store, alice, referenceId).length, 3);
});

test('attempt mismatch, message to a terminal attempt, capacity and a stale writer are refused; visibility precedes the attempt check', (t) => {
    const { dir, store, robotId } = setup(t, { ...EXTENDED, controls: 2 });
    const alice = user('alice');
    const live = admitAs(store, robotId, alice);
    store.transitionAttempt({ executionId: live.executionId, attemptId: live.attemptId, expectedState: 'queued', nextState: 'running' });
    const wrongAttempt = { referenceId: live.reference.id, operationId: newId(), op: 'stop', attemptId: newId() };
    expectCode(assert, () => store.controlReference(alice, wrongAttempt), 'operation_conflict');
    // A non-owner with a mismatched attempt learns nothing: not_found, not operation_conflict.
    expectCode(assert, () => store.controlReference(user('bob'), wrongAttempt), 'not_found');
    const done = admitAs(store, robotId, alice);
    store.beginAttemptEnd(ADAPTER(), { executionId: done.executionId, attemptId: done.attemptId, expectedState: 'queued', outcome: { classification: 'completed' } });
    expectCode(assert, () => store.controlReference(alice, { referenceId: done.reference.id, operationId: newId(), op: 'message', payload: { message: 'late' } }), 'operation_conflict');
    for (const payload of [undefined, {}, { message: '' }, { message: 'x', extra: 1 }, { message: 'x'.repeat(LIMITS.requestBytes + 1) }]) {
        expectCode(assert, () => store.controlReference(alice, { referenceId: live.reference.id, operationId: newId(), op: 'message', payload }), 'invalid_request');
    }
    for (const bad of [{ op: 'input' }, { op: 'stop', payload: { message: 'x' } }, { op: 'stop', operationId: 'short' }]) {
        expectCode(assert, () => store.controlReference(alice, { referenceId: live.reference.id, operationId: newId(), ...bad }), 'invalid_request');
    }
    assert.throws(() => store.controlReference(alice, { referenceId: live.reference.id, operationId: newId(), op: 'pause' }),
        (error) => error.name === 'WorkerStateError' && error.code === 'invalid_request', 'pause on an execution reference is invalid_request');
    assert.equal(count(dir, 'reference_control'), 0);
    store.controlReference(alice, { referenceId: live.reference.id, operationId: newId(), op: 'message', payload: { message: 'one' } });
    store.controlReference(alice, { referenceId: live.reference.id, operationId: newId(), op: 'message', payload: { message: 'two' } });
    expectCode(assert, () => store.controlReference(alice, { referenceId: live.reference.id, operationId: newId(), op: 'stop' }), 'capacity_exceeded');
    // A second handle bound to the old generation is a stale writer once recovery starts.
    const stale = openStore(dir, { limits: { ...EXTENDED, controls: 8 }, create: false });
    t.after(() => stale.close());
    store.beginGenerationRecovery(store.generationId);
    expectCode(assert, () => stale.controlReference(alice, { referenceId: live.reference.id, operationId: newId(), op: 'stop' }), 'stale_generation');
    const base = makeTempDir(t);
    const baseStore = openStore(base);
    t.after(() => baseStore.close());
    const baseRobot = readyRobot(baseStore, syntheticContext({ robotOwnerId: ROBOTS, scope: 'scope-robots' }));
    const queued = admitAs(baseStore, baseRobot, alice);
    expectCode(assert, () => baseStore.controlReference(alice, { referenceId: queued.reference.id, operationId: newId(), op: 'stop' }), 'capacity_exceeded');
    expectCode(assert, () => store.controlReference(createVerifiedServiceContext({ workspaceId: WORKSPACE, scope: 's', ownerId: 'user:alice', robotOwnerId: ROBOTS, operations: ['read'] }),
        { referenceId: live.reference.id, operationId: newId(), op: 'stop' }), 'forbidden');
});

test('message payload: stored exactly for the engine, retry returns the record, changed payload conflicts, oversize refused, never returned', (t) => {
    const { dir, store, robotId } = setup(t);
    const alice = user('alice');
    const admitted = admitAs(store, robotId, alice);
    const referenceId = admitted.reference.id;
    store.transitionAttempt({ executionId: admitted.executionId, attemptId: admitted.attemptId, expectedState: 'queued', nextState: 'running' });
    const secretText = 'owner-only message text \u00e9';
    const request = { referenceId, operationId: newId(), op: 'message', payload: { message: secretText } };
    const first = store.controlReference(alice, request);
    assert.deepEqual(Object.keys(first).sort(), ['delivery', 'op', 'operationId', 'outcome', 'state']);
    assert.equal(first.delivery, 'pending');
    assert.deepEqual(store.controlReference(alice, { ...request, payload: { message: secretText } }), first);
    expectCode(assert, () => store.controlReference(alice, { ...request, payload: { message: 'changed' } }), 'operation_conflict');
    // Bounded by requestBytes on the persisted canonical JSON {"text":...}: exactly the limit is accepted, one byte more refused.
    const overhead = Buffer.byteLength(JSON.stringify({ message: '' }));
    const exact = 'x'.repeat(LIMITS.requestBytes - overhead);
    store.controlReference(alice, { referenceId, operationId: newId(), op: 'message', payload: { message: exact } });
    expectCode(assert, () => store.controlReference(alice, { referenceId, operationId: newId(), op: 'message', payload: { message: `${exact}x` } }), 'invalid_request');
    const stop = store.controlReference(alice, { referenceId, operationId: newId(), op: 'stop' });
    assert.equal(stop.delivery, 'pending');
    const db = rawDb(dir);
    try {
        const rows = db.prepare('SELECT op, payload, operation_id FROM reference_control ORDER BY created_at, rowid').all();
        assert.equal(rows.length, 3);
        assert.equal(rows[0].payload, JSON.stringify({ message: secretText }));
        assert.equal(rows[1].payload, JSON.stringify({ message: exact }));
        assert.equal(rows[2].op, 'stop');
        assert.equal(rows[2].payload, null);
        assert.throws(() => db.prepare("UPDATE reference_control SET payload = '{\"text\":\"forged\"}' WHERE op = 'message'").run(), /immutable/);
        assert.throws(() => db.prepare("INSERT INTO reference_control (reference_id, actor_key, operation_id, op, payload, digest, response, delivery, created_at) VALUES (?, 'a', 'o', 'message', NULL, 'd', '{}', 'pending', 0)").run(referenceId));
    } finally {
        db.close();
    }
    // No read path returns the payload: not to the owner, an administrator or the origin row.
    const admin = user('root', { administrator: true });
    for (const context of [alice, admin]) {
        const observed = JSON.stringify([store.observeReference(context, { referenceId }), events(store, context, referenceId)]);
        assert.equal(observed.includes('owner-only message text'), false);
    }
    const adminStop = store.controlReference(admin, { referenceId, operationId: newId(), op: 'stop' });
    assert.equal(JSON.stringify(adminStop).includes('owner-only'), false);
    expectCode(assert, () => store.controlReference(user('bob'), { ...request }), 'not_found');
    expectCode(assert, () => store.controlReference(admin, { ...request }), 'forbidden');
});

test('F1: a background-binding context gets the origin-row basis only, whatever owner or administrator flag it carries', (t) => {
    const { store, robotId } = setup(t);
    const alice = user('alice');
    const mcp = admitAs(store, robotId, alice);
    store.registerBinding(syntheticContext({ originNamespace: 'coordinator:svc1', originKey: 'owner:user:alice', ownerId: 'user:alice', scope: 'scope-bind' }),
        { operationId: newId(), bindingId: 'flow1', kind: 'flow' });
    const admitter = syntheticContext({ originNamespace: 'coordinator:svc1', originKey: 'binding:flow1', ownerId: 'user:alice', scope: 'scope-bg', robotOwnerId: ROBOTS });
    const own = admitAs(store, robotId, admitter);
    const ownAttempt = { executionId: own.executionId, attemptId: own.attemptId };
    store.transitionAttempt({ ...ownAttempt, expectedState: 'queued', nextState: 'running' });
    // The exact background-admit context shape (real owner), and one also flagged administrator.
    for (const context of [admitter, syntheticContext({ originNamespace: 'coordinator:svc1', originKey: 'binding:flow1', ownerId: 'user:alice', scope: 'scope-bg', administrator: true })]) {
        expectCode(assert, () => store.observeReference(context, { referenceId: mcp.reference.id }), 'not_found');
        expectCode(assert, () => events(store, context, mcp.reference.id), 'not_found');
        expectCode(assert, () => store.controlReference(context, { referenceId: mcp.reference.id, operationId: newId(), op: 'stop' }), 'not_found');
        // Its own binding reference: readable through the origin row; it may be stopped (M-12 C) but never sent a message.
        assert.equal(store.observeReference(context, { referenceId: own.reference.id }).state, 'running');
        expectCode(assert, () => store.controlReference(context, { referenceId: own.reference.id, operationId: newId(), op: 'message', payload: { message: 'x' } }), 'forbidden');
    }
    // The background row's stop of its own flow work is recorded (one pending stop per attempt).
    assert.equal(store.controlReference(admitter, { referenceId: own.reference.id, operationId: newId(), op: 'stop' }).delivery, 'pending');
    // The owner through an owner row keeps full authority.
    assert.equal(store.controlReference(alice, { referenceId: own.reference.id, operationId: newId(), op: 'message', payload: { message: 'ok' } }).delivery, 'pending');
});

test('R1: repeated stops cannot exhaust the controls capacity; not_applicable is computed, not stored; another user cancel still succeeds', (t) => {
    const { dir, store, robotId } = setup(t, { ...EXTENDED, controls: 3 });
    const alice = user('alice');
    const running = admitAs(store, robotId, alice);
    store.transitionAttempt({ executionId: running.executionId, attemptId: running.attemptId, expectedState: 'queued', nextState: 'running' });
    const first = { referenceId: running.reference.id, operationId: newId(), op: 'stop' };
    const recorded = store.controlReference(alice, first);
    assert.deepEqual({ ...recorded, operationId: null }, { operationId: null, op: 'stop', outcome: 'accepted', delivery: 'pending', state: 'running' });
    for (let index = 0; index < 15; index += 1) {
        const again = store.controlReference(alice, { referenceId: running.reference.id, operationId: newId(), op: 'stop' });
        assert.deepEqual({ ...again, operationId: null }, { operationId: null, op: 'stop', outcome: 'accepted', delivery: 'pending', state: 'running' });
    }
    assert.equal(count(dir, 'reference_control'), 1);
    assert.deepEqual(store.controlReference(alice, { ...first }), recorded);
    // Stops of a terminal attempt are computed, not recorded.
    const done = admitAs(store, robotId, alice);
    store.beginAttemptEnd(ADAPTER(), { executionId: done.executionId, attemptId: done.attemptId, expectedState: 'queued', outcome: { classification: 'completed' } });
    for (let index = 0; index < 5; index += 1) {
        assert.equal(store.controlReference(alice, { referenceId: done.reference.id, operationId: newId(), op: 'stop' }).outcome, 'not_applicable');
    }
    assert.equal(count(dir, 'reference_control'), 1);
    // Another user's queued cancel is still accepted and applied.
    const bob = user('bob');
    const queued = admitAs(store, robotId, bob);
    const cancelled = store.controlReference(bob, { referenceId: queued.reference.id, operationId: newId(), op: 'stop' });
    assert.equal(cancelled.state, 'cancelled');
    assert.equal(cancelled.delivery, 'applied');
    assert.equal(count(dir, 'reference_control'), 2);
});

test('snapshot facts: originRequestId, sequence, previousReference for a continuation, termination_unverified', (t) => {
    const { store, robotId } = setup(t);
    const alice = user('alice');
    const request = admitRequest(robotId, {}, alice);
    const first = store.admit(alice, request);
    const firstView = store.observeReference(alice, { referenceId: first.reference.id });
    assert.equal(firstView.originRequestId, request.originRequestId);
    assert.equal(firstView.previousReference, null);
    assert.equal(firstView.sequence, 1);
    store.beginAttemptEnd(ADAPTER(), { executionId: first.executionId, attemptId: first.attemptId, expectedState: 'queued', outcome: { classification: 'paused' } });
    const continued = admitAs(store, robotId, alice, { kind: 'continuation', logical: { logicalId: first.logicalId } });
    const view = store.observeReference(alice, { referenceId: continued.reference.id });
    assert.deepEqual(view.previousReference, first.reference);
    assert.equal(view.logicalId, first.logicalId);
    // termination_unverified: a quarantined process tree.
    const tree = admitAs(store, robotId, alice);
    const { resourceId } = store.reserveResource({ kind: 'process-tree', locator: locatorFor('process-tree'), executionId: tree.executionId, attemptId: tree.attemptId, processBearing: true });
    store.beginAttemptEnd(ADAPTER(), { executionId: tree.executionId, attemptId: tree.attemptId, expectedState: 'queued', outcome: { classification: 'completed', outputText: 'out' } });
    store.quarantineResource({ resourceId, generationId: store.generationId });
    const unverified = store.observeReference(alice, { referenceId: tree.reference.id });
    assert.equal(unverified.endedReason, 'termination_unverified');
    assert.equal(unverified.result.reason, 'termination_unverified');
    assert.equal(unverified.result.classification, 'completed');
    assert.equal(unverified.result.status, 'failed');
});

test('listRobots returns the robots of the context robot owner, tombstones included', (t) => {
    const { store, robotId } = setup(t);
    const reader = createVerifiedServiceContext({ workspaceId: WORKSPACE, scope: 's', ownerId: 'coordinator:svc1', robotOwnerId: ROBOTS, operations: ['read'] });
    assert.deepEqual(store.listRobots(reader).map((robot) => robot.robotId), [robotId]);
    assert.equal(store.listRobots(reader)[0].ready, true);
    const other = createVerifiedServiceContext({ workspaceId: WORKSPACE, scope: 's', ownerId: 'coordinator:svc1', robotOwnerId: 'workspace:other', operations: ['read'] });
    assert.deepEqual(store.listRobots(other), []);
    expectCode(assert, () => store.listRobots(createVerifiedServiceContext({ workspaceId: WORKSPACE, scope: 's', ownerId: 'x', robotOwnerId: ROBOTS, operations: ['provision'] })), 'forbidden');
});
