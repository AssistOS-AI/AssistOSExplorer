import assert from 'node:assert/strict';
import test from 'node:test';
import { createVerifiedCoordinatorContext, runtimeUnavailable } from '../server/workerState.mjs';
import { OPERATIONS, deriveOperationId, validateLimits } from '../server/stateProtocol.mjs';
import { projectSnapshot } from '../server/taskReferenceAdapter.mjs';
import { raceChildren } from './helpers/childRunner.mjs';
import {
    S6_LIMITS, WORKSPACE, admitRequest, count, expectCode, makeTempDir, newId, newOriginId, openStore, rawDb, readyRobot, syntheticContext
} from './helpers/synthetic.mjs';

// S6 source-only subset, Part D: worker-side coordinator obligations, observation references,
// accept and reject decisions, the reconciliation list, the outbox and fences. Contexts are
// SYNTHETIC internal preconditions and the runtime is the explicitly synthetic adapter: state
// evidence only, never protected execution, runtime readiness or routed authorization. The
// store clock is synthetic (base 1,000,000 ms), so the real clock is far past every
// deadline here.

const ROBOTS = `workspace:${WORKSPACE}`;
const COORDINATOR = 'agent:RoboRepo/roboTeamAgent';
const OTHER_COORDINATOR = 'agent:RoboRepo/mailer';
const BASE_NOW = 1_000_000;
const WINDOW = S6_LIMITS.obligationAcceptMs;
const ADAPTER = () => syntheticContext({ scope: 'scope-adapter' });

function flowId() {
    return `flow_${[...crypto.getRandomValues(new Uint8Array(12))].map((byte) => byte.toString(16).padStart(2, '0')).join('')}`;
}

function genId() {
    return `gen_${[...crypto.getRandomValues(new Uint8Array(12))].map((byte) => byte.toString(16).padStart(2, '0')).join('')}`;
}

function ownerFields(user, svc = COORDINATOR) {
    return {
        workspaceId: WORKSPACE, scope: `scope-${svc}-${user}`, ownerId: `user:${user}`, operations: [...OPERATIONS],
        originNamespace: `coordinator:${svc}`, originKey: `owner:user:${user}`, robotOwnerId: ROBOTS
    };
}

function ownerRow(user, svc = COORDINATOR, extra = {}) {
    const { workspaceId, ...fields } = ownerFields(user, svc);
    void workspaceId;
    return syntheticContext({ ...fields, ...extra });
}

function mcpRow(user, coordinator) {
    const extra = coordinator === undefined ? {} : { coordinator };
    return syntheticContext({ originNamespace: 'mcp', originKey: `user:${user}`, ownerId: `user:${user}`, scope: `scope-mcp-${user}`, robotOwnerId: ROBOTS, ...extra });
}

function bindingRow(id, ownerId, svc = COORDINATOR) {
    return syntheticContext({ originNamespace: `coordinator:${svc}`, originKey: `binding:${id}`, ownerId, scope: `scope-${svc}-binding-${id}`, robotOwnerId: ROBOTS });
}

function coordinatorFields(svc = COORDINATOR) {
    return { workspaceId: WORKSPACE, scope: `scope-obligations-${svc}`, coordinator: svc, operations: ['decide', 'reconcile'] };
}

function coordinator(svc = COORDINATOR) {
    return createVerifiedCoordinatorContext(coordinatorFields(svc));
}

function setup(t, options = {}) {
    const dir = makeTempDir(t);
    const clock = { now: BASE_NOW };
    const store = openStore(dir, { limits: S6_LIMITS, now: () => clock.now, ...options });
    t.after(() => store.close());
    const robotId = readyRobot(store, syntheticContext({ robotOwnerId: ROBOTS, scope: 'scope-robots' }));
    return { dir, store, clock, robotId };
}

function obligationRequest(context, obligationKind, extra = {}) {
    const originRequestId = extra.originRequestId ?? newOriginId();
    return {
        operationId: deriveOperationId(context, originRequestId), originRequestId, obligationKind, request: { flow: 'synthetic', project: null }, ...extra
    };
}

function obligate(store, context, obligationKind = 'flow-launch', extra = {}) {
    return store.admitObligation(context, obligationRequest(context, obligationKind, extra));
}

function accept(store, obligationId, domainRecordId, svc = COORDINATOR, operationId = newId()) {
    return store.acceptObligation(coordinator(svc), { operationId, obligationId, domainRecordId });
}

function reject(store, obligationId, reason = 'not_wanted', svc = COORDINATOR, operationId = newId()) {
    return store.rejectObligation(coordinator(svc), { operationId, obligationId, reason });
}

function control(store, context, referenceId, op, extra = {}) {
    return store.controlReference(context, { referenceId, operationId: newId(), op, ...extra });
}

function outbox(store, obligationId, revision, fenceRevision, kind, data = {}, svc = COORDINATOR) {
    return store.applyOutbox(coordinator(svc), { obligationId, revision, fenceRevision, kind, data });
}

function observe(store, context, referenceId) {
    return store.observeReference(context, { referenceId });
}

function row(dir, sql, ...args) {
    const db = rawDb(dir, { readOnly: true });
    try {
        return db.prepare(sql).get(...args);
    } finally {
        db.close();
    }
}

function rows(dir, sql, ...args) {
    const db = rawDb(dir, { readOnly: true });
    try {
        return db.prepare(sql).all(...args);
    } finally {
        db.close();
    }
}

function obligationRow(dir, obligationId) {
    return row(dir, 'SELECT * FROM obligation WHERE obligation_id = ?', obligationId);
}

function bindingRowOf(dir, bindingId, svc = COORDINATOR) {
    return row(dir, 'SELECT * FROM binding WHERE coordinator = ? AND binding_id = ?', svc, bindingId);
}

function tableCounts(dir) {
    return Object.fromEntries(['receipt', 'obligation', 'reference', 'origin', 'binding', 'reference_event', 'outbox_revision', 'reference_control']
        .map((table) => [table, count(dir, table)]));
}

// Launch a flow for `user` and accept it: {admitted, flow, accepted}.
function launch(store, user = 'alice', svc = COORDINATOR) {
    const admitted = obligate(store, ownerRow(user, svc), 'flow-launch');
    const flow = flowId();
    const accepted = accept(store, admitted.obligationId, flow, svc);
    return { admitted, flow, accepted };
}

function admitUnder(store, robotId, bindingId, ownerId = 'user:alice', svc = COORDINATOR) {
    const context = bindingRow(bindingId, ownerId, svc);
    return store.admit(context, admitRequest(robotId, {}, context));
}

function start(store, admitted) {
    return store.transitionAttempt({ executionId: admitted.executionId, attemptId: admitted.attemptId, expectedState: 'queued', nextState: 'running' });
}

function admissionState(dir, executionId) {
    return row(dir, 'SELECT state FROM admission WHERE execution_id = ?', executionId).state;
}

// Runs a call that the requirement says succeeds; a refusal fails as an assertion naming it.
function succeeds(fn, message) {
    let value;
    let refusal = null;
    try {
        value = fn();
    } catch (error) {
        refusal = `${error.name}/${error.code}/${error.reason ?? ''}`;
    }
    assert.equal(refusal, null, message);
    return value;
}

function expectReason(fn, code, reason) {
    assert.throws(fn, (error) => {
        assert.equal(error.name, 'WorkerStateError');
        assert.equal(error.code, code);
        assert.equal(error.reason, reason);
        return true;
    });
}

// ---- Answer 3 named cases (as amended by §15 and §16 N-6) ---------------------------------

test('accept at acceptBy - 1 / acceptBy / acceptBy + 1 with injected now: accepted / refused expired / refused expired; exactly one terminal row each', (t) => {
    const { dir, store, clock } = setup(t);
    for (const [offset, decision, state] of [[-1, 'accepted', 'accepted'], [0, 'refused', 'expired'], [1, 'refused', 'expired']]) {
        clock.now = BASE_NOW;
        const admitted = obligate(store, ownerRow('alice'));
        assert.equal(admitted.acceptBy, BASE_NOW + WINDOW);
        clock.now = admitted.acceptBy + offset;
        const flow = flowId();
        const reply = accept(store, admitted.obligationId, flow);
        assert.equal(reply.decision, decision, `offset ${offset}`);
        assert.equal(reply.state, state);
        if (decision === 'refused') assert.equal(reply.reason, 'expired');
        const stored = obligationRow(dir, admitted.obligationId);
        assert.deepEqual([stored.state, stored.decided_at], [state, admitted.acceptBy + offset], 'one committed decision');
        assert.equal(count(dir, 'binding') > 0 && bindingRowOf(dir, flow) !== undefined, decision === 'accepted', 'a binding exists only when accepted');
        const terminalEvents = rows(dir, 'SELECT data FROM reference_event WHERE reference_id = ? AND sequence > 1', admitted.reference.id);
        assert.equal(terminalEvents.length, 1, 'exactly one decision event');
    }
});

test('two processes race accept against sweep at the boundary: exactly one of accepted or expired', async (t) => {
    const dir = makeTempDir(t);
    const seedClock = { now: BASE_NOW };
    const seeded = openStore(dir, { limits: S6_LIMITS, now: () => seedClock.now });
    readyRobot(seeded, syntheticContext({ robotOwnerId: ROBOTS, scope: 'scope-robots' }));
    // Deadlines spaced apart, so each round's sweep can reach only its own obligation (earlier
    // ones are decided by then).
    const obligations = [0, 1, 2, 3].map((index) => {
        seedClock.now = BASE_NOW + index * 2 * WINDOW;
        return obligate(seeded, ownerRow('alice'));
    });
    seeded.close();
    const outcomes = new Set();
    for (const admitted of obligations) {
        const flow = flowId();
        const results = await raceChildren([
            { dir, method: 'acceptObligation', limits: S6_LIMITS, now: admitted.acceptBy - 1, coordinatorContext: coordinatorFields(),
                request: { operationId: newId(), obligationId: admitted.obligationId, domainRecordId: flow } },
            { dir, method: 'sweepObligations', limits: S6_LIMITS, now: admitted.acceptBy, request: undefined }
        ]);
        const [acceptOut, sweepOut] = results.map((result) => result.output);
        assert.equal(acceptOut.ok, true, JSON.stringify(acceptOut));
        assert.equal(sweepOut.ok, true, JSON.stringify(sweepOut));
        const stored = obligationRow(dir, admitted.obligationId);
        if (acceptOut.result.decision === 'accepted') {
            assert.equal(stored.state, 'accepted');
            assert.equal(sweepOut.result.expired, 0, 'the sweep found nothing to expire');
            assert.ok(bindingRowOf(dir, flow));
        } else {
            assert.deepEqual([acceptOut.result.decision, acceptOut.result.reason, stored.state], ['refused', 'expired', 'expired']);
            assert.equal(sweepOut.result.expired, 1, 'the sweep committed the expiry');
            assert.equal(bindingRowOf(dir, flow), undefined);
        }
        outcomes.add(stored.state);
    }
    assert.ok([...outcomes].every((state) => state === 'accepted' || state === 'expired'));
    t.diagnostic(`accept-vs-sweep outcomes: ${[...outcomes].join(',')}`);
});

test('retried accept returns the same decision; accept after reject is refused; accept by another coordinator is not_found', (t) => {
    const { dir, store } = setup(t);
    const admitted = obligate(store, ownerRow('alice'));
    const flow = flowId();
    const operationId = newId();
    const first = accept(store, admitted.obligationId, flow, COORDINATOR, operationId);
    assert.equal(first.decision, 'accepted');
    assert.deepEqual(accept(store, admitted.obligationId, flow, COORDINATOR, operationId), first, 'same bytes for the same operation');
    const again = accept(store, admitted.obligationId, flow);
    assert.deepEqual([again.decision, again.bindingId, again.fenceRevision], ['accepted', flow, 0], 'the recorded decision for a new operation');
    expectCode(assert, () => accept(store, admitted.obligationId, flowId(), COORDINATOR, operationId), 'operation_conflict');
    assert.equal(count(dir, 'binding'), 1);
    const rejected = obligate(store, ownerRow('alice'));
    assert.equal(reject(store, rejected.obligationId).decision, 'rejected');
    const late = accept(store, rejected.obligationId, flowId());
    assert.deepEqual([late.decision, late.reason, late.state], ['refused', 'rejected', 'rejected']);
    const foreign = obligate(store, ownerRow('alice'));
    expectCode(assert, () => accept(store, foreign.obligationId, flowId(), OTHER_COORDINATOR), 'not_found');
    expectCode(assert, () => reject(store, foreign.obligationId, 'x', OTHER_COORDINATOR), 'not_found');
    expectCode(assert, () => accept(store, newId(), flowId()), 'not_found');
    assert.equal(obligationRow(dir, foreign.obligationId).state, 'pending');
});

test('pause on a pending obligation and pause on a generation are operation_conflict', (t) => {
    const { dir, store } = setup(t);
    const alice = ownerRow('alice');
    const pending = obligate(store, alice);
    expectCode(assert, () => control(store, alice, pending.reference.id, 'pause'), 'operation_conflict');
    const generation = obligate(store, alice, 'generation');
    const ticket = genId();
    assert.equal(accept(store, generation.obligationId, ticket).decision, 'accepted');
    expectCode(assert, () => control(store, alice, generation.reference.id, 'pause'), 'operation_conflict');
    assert.equal(bindingRowOf(dir, ticket).state, 'active');
    assert.deepEqual([obligationRow(dir, pending.obligationId).state, obligationRow(dir, generation.obligationId).state], ['pending', 'accepted']);
    // A generation is cancelled by stop.
    assert.equal(control(store, alice, generation.reference.id, 'stop').bindingState, 'cancelled');
});

test('accepted, then cancel fence: root binding cancelled; descendant admission not_found; queued descendant cancelled; terminal outbox gives fenced', (t) => {
    const { dir, store, robotId } = setup(t);
    const alice = ownerRow('alice');
    const { admitted, flow } = launch(store);
    assert.equal(outbox(store, admitted.obligationId, 1, 0, 'bound').applied, true);
    const queued = admitUnder(store, robotId, flow);
    const running = admitUnder(store, robotId, flow);
    start(store, running);
    const child = flowId();
    store.registerBinding(bindingRow(flow, 'user:alice'), { operationId: newId(), bindingId: child, kind: 'flow', parentBindingId: flow });
    const childQueued = admitUnder(store, robotId, child);
    const fence = control(store, alice, admitted.reference.id, 'stop');
    assert.deepEqual([fence.outcome, fence.state, fence.bindingState, fence.fenceRevision], ['accepted', 'cancelled', 'cancelled', 1]);
    assert.deepEqual([bindingRowOf(dir, flow).state, bindingRowOf(dir, flow).fence_revision], ['cancelled', 1]);
    expectCode(assert, () => admitUnder(store, robotId, flow), 'not_found');
    expectCode(assert, () => admitUnder(store, robotId, child), 'not_found');
    assert.equal(admissionState(dir, queued.executionId), 'cancelled');
    assert.equal(admissionState(dir, childQueued.executionId), 'cancelled', 'the fence cascades through derived bindings');
    assert.equal(admissionState(dir, running.executionId), 'running');
    const stops = rows(dir, "SELECT * FROM reference_control WHERE source = 'fence'");
    assert.equal(stops.length, 1, 'one pending fence stop for the running descendant');
    assert.deepEqual([stops[0].op, stops[0].delivery], ['stop', 'pending']);
    const terminal = outbox(store, admitted.obligationId, 2, 0, 'terminal', { status: 'completed', outputText: 'late' });
    assert.deepEqual(terminal, { obligationId: admitted.obligationId, revision: 2, applied: false, fenced: 'cancelled', fenceRevision: 1 });
    assert.equal(obligationRow(dir, admitted.obligationId).result, JSON.stringify({ status: 'cancelled', outputText: '' }));
    assert.equal(observe(store, alice, admitted.reference.id).state, 'cancelled');
});

test('outbox revision replay, gap and changed digest: recorded ack / operation_conflict / operation_conflict; applied once', (t) => {
    const { dir, store } = setup(t);
    const { admitted } = launch(store);
    const bound = outbox(store, admitted.obligationId, 1, 0, 'bound', { capturedInputsDigest: 'abc' });
    assert.deepEqual(bound, { obligationId: admitted.obligationId, revision: 1, applied: true, state: 'accepted', fenceRevision: 0 });
    assert.deepEqual(succeeds(() => outbox(store, admitted.obligationId, 1, 0, 'bound', { capturedInputsDigest: 'abc' }), 'the same revision returns its recorded acknowledgement'),
        bound, 'recorded acknowledgement');
    expectCode(assert, () => outbox(store, admitted.obligationId, 1, 0, 'bound', { capturedInputsDigest: 'xyz' }), 'operation_conflict');
    expectCode(assert, () => outbox(store, admitted.obligationId, 3, 0, 'progress', {}), 'operation_conflict');
    const progress = outbox(store, admitted.obligationId, 2, 0, 'progress', { step: 1 });
    assert.equal(progress.applied, true);
    assert.deepEqual(succeeds(() => outbox(store, admitted.obligationId, 2, 0, 'progress', { step: 1 }), 'the same revision returns its recorded acknowledgement'), progress);
    expectCode(assert, () => outbox(store, admitted.obligationId, 2, 0, 'progress', { step: 2 }), 'operation_conflict');
    assert.equal(count(dir, 'outbox_revision'), 2, 'each revision applied once');
    assert.deepEqual([obligationRow(dir, admitted.obligationId).last_revision, obligationRow(dir, admitted.obligationId).bound], [2, 1]);
    // Revision 1 is always `bound`, and only revision 1.
    expectCode(assert, () => outbox(store, admitted.obligationId, 3, 0, 'bound', {}), 'invalid_request');
    const fresh = launch(store);
    expectCode(assert, () => outbox(store, fresh.admitted.obligationId, 1, 0, 'progress', {}), 'invalid_request');
});

test('store close, reopen and generation recovery with pending and accepted obligations: same references, original acceptBy, states unchanged; descendant attempt interrupted, not replayed', (t) => {
    const dir = makeTempDir(t);
    const clock = { now: BASE_NOW };
    let store = openStore(dir, { limits: S6_LIMITS, now: () => clock.now });
    const robots = syntheticContext({ robotOwnerId: ROBOTS, scope: 'scope-robots' });
    const robotId = readyRobot(store, robots);
    const alice = ownerRow('alice');
    const pending = obligate(store, alice);
    const { admitted: accepted, flow } = launch(store);
    const descendant = admitUnder(store, robotId, flow);
    start(store, descendant);
    const before = [observe(store, alice, pending.reference.id), observe(store, alice, accepted.reference.id)];
    store.close();
    clock.now = BASE_NOW + 100;
    store = openStore(dir, { limits: S6_LIMITS, now: () => clock.now, create: false });
    t.after(() => store.close());
    const generation = store.beginGenerationRecovery(store.generationId);
    store.completeGenerationRecovery(generation.generationId);
    const after = [observe(store, alice, pending.reference.id), observe(store, alice, accepted.reference.id)];
    assert.deepEqual(after.map((facts) => [facts.reference, facts.state, facts.obligation]), before.map((facts) => [facts.reference, facts.state, facts.obligation]));
    assert.equal(after[0].obligation.acceptBy, pending.acceptBy, 'original deadline');
    assert.equal(admissionState(dir, descendant.executionId), 'interrupted', 'the descendant attempt is interrupted, not replayed');
    assert.equal(count(dir, 'admission'), 1);
    // The pending obligation is still acceptable before its deadline: one binding, one first descendant.
    const pendingFlow = flowId();
    assert.equal(accept(store, pending.obligationId, pendingFlow).decision, 'accepted');
    store.attestReadiness(robots, { robotId });
    succeeds(() => admitUnder(store, robotId, pendingFlow), 'the first descendant is admitted after recovery');
    assert.deepEqual([count(dir, 'binding'), count(dir, 'admission')], [2, 2]);
});

test('lookup after a lost obligation reply: pending-coordinator from the receipt', (t) => {
    const { dir, store } = setup(t);
    const alice = ownerRow('alice');
    const request = obligationRequest(alice, 'flow-launch');
    const admitted = store.admitObligation(alice, request);
    const looked = store.lookupOrigin(alice, { originRequestId: request.originRequestId });
    assert.deepEqual([looked.admissionState, looked.referenceKind, looked.reference], ['pending-coordinator', 'observation', admitted.reference]);
    const before = tableCounts(dir);
    assert.deepEqual(store.admitObligation(alice, { ...request }), admitted, 'the same origin returns the recorded admission');
    assert.deepEqual(tableCounts(dir), before);
    expectCode(assert, () => store.admitObligation(alice, { ...request, request: { other: true } }), 'operation_conflict');
    // The recorded state, never live state: still pending-coordinator after accept.
    accept(store, admitted.obligationId, flowId());
    assert.equal(store.lookupOrigin(alice, { originRequestId: request.originRequestId }).admissionState, 'pending-coordinator');
    expectCode(assert, () => store.lookupOrigin(ownerRow('bob'), { originRequestId: request.originRequestId }), 'not_found');
});

test('default runtime obligation admission: refused, zero rows', (t) => {
    const dir = makeTempDir(t);
    const seeded = openStore(dir, { limits: S6_LIMITS, now: () => BASE_NOW });
    readyRobot(seeded, syntheticContext({ robotOwnerId: ROBOTS, scope: 'scope-robots' }));
    seeded.close();
    const before = tableCounts(dir);
    const store = openStore(dir, { limits: S6_LIMITS, now: () => BASE_NOW, create: false, runtime: runtimeUnavailable });
    t.after(() => store.close());
    for (const kind of ['flow-launch', 'generation']) expectCode(assert, () => obligate(store, ownerRow('alice'), kind), 'runtime_unavailable');
    // Readiness is checked before any continuation precondition.
    expectCode(assert, () => obligate(store, ownerRow('alice'), 'flow-continuation', { continuationOf: { bindingId: flowId() } }), 'runtime_unavailable');
    expectCode(assert, () => obligate(store, mcpRow('alice', COORDINATOR)), 'runtime_unavailable');
    assert.deepEqual(tableCounts(dir), before);
    assert.equal(count(dir, 'obligation'), 0);
});

// ---- §15 F-3 flow continuation -----------------------------------------------------------

test('F-3: launch, accept, pause, continuation admitted, accept, background-row admission under the flow ID; the first reference stays paused; fenceRevision 0, 1, 2', (t) => {
    const { dir, store, robotId } = setup(t);
    const alice = ownerRow('alice');
    const { admitted, flow, accepted } = launch(store);
    assert.equal(accepted.fenceRevision, 0);
    const paused = control(store, alice, admitted.reference.id, 'pause');
    assert.deepEqual([paused.state, paused.bindingState, paused.fenceRevision], ['paused', 'paused', 1]);
    // The recorded decision of an accepted, later paused obligation stays `accepted`.
    const recorded = succeeds(() => accept(store, admitted.obligationId, flow), 'accept of an accepted, later paused obligation returns a recorded decision');
    assert.deepEqual([recorded.decision, recorded.state, recorded.bindingId, recorded.fenceRevision], ['accepted', 'paused', flow, 1]);
    assert.deepEqual([reject(store, admitted.obligationId).decision, reject(store, admitted.obligationId).reason], ['refused', 'accepted']);
    const pausedView = observe(store, alice, admitted.reference.id);
    expectCode(assert, () => admitUnder(store, robotId, flow), 'not_found');
    const continuation = obligate(store, alice, 'flow-continuation', { continuationOf: { bindingId: flow } });
    assert.equal(obligationRow(dir, continuation.obligationId).expected_fence_revision, 1);
    assert.equal(observe(store, alice, continuation.reference.id).logicalId, null, 'logical.id is null while pending');
    const reactivated = accept(store, continuation.obligationId, flow);
    assert.deepEqual([reactivated.decision, reactivated.bindingId, reactivated.fenceRevision], ['accepted', flow, 2]);
    assert.deepEqual([bindingRowOf(dir, flow).state, bindingRowOf(dir, flow).fence_revision], ['active', 2]);
    const phase = succeeds(() => admitUnder(store, robotId, flow), 'descendant admission resumes under the same flow ID');
    assert.equal(observe(store, bindingRow(flow, 'user:alice'), phase.reference.id).bindingId, flow);
    const stillPaused = observe(store, alice, admitted.reference.id);
    assert.deepEqual([stillPaused.state, stillPaused.result], [pausedView.state, pausedView.result], 'the paused result is immutable');
    assert.deepEqual(stillPaused.obligation.fenceRevision, 2);
    assert.deepEqual(observe(store, alice, continuation.reference.id).logicalId, flow);
    assert.notEqual(continuation.reference.id, admitted.reference.id, 'the continuation has its own observation reference');
});

test('F-3/N-1: pause, continuation admitted, cancel through stop on the paused interval reference, accept: rejected / fence_changed, binding cancelled, descendant admission not_found', (t) => {
    const { dir, store, robotId } = setup(t);
    const alice = ownerRow('alice');
    const { admitted, flow } = launch(store);
    control(store, alice, admitted.reference.id, 'pause');
    const continuation = obligate(store, alice, 'flow-continuation', { continuationOf: { bindingId: flow } });
    const cancel = control(store, alice, admitted.reference.id, 'stop');
    assert.deepEqual([cancel.outcome, cancel.state, cancel.bindingState, cancel.fenceRevision], ['accepted', 'paused', 'cancelled', 2]);
    const operationId = newId();
    const refused = succeeds(() => accept(store, continuation.obligationId, flow, COORDINATOR, operationId), 'accept returns a recorded decision');
    assert.deepEqual([refused.decision, refused.reason, refused.state], ['refused', 'fence_changed', 'rejected']);
    assert.deepEqual(accept(store, continuation.obligationId, flow, COORDINATOR, operationId), refused, 'a retried accept returns the same bytes');
    assert.deepEqual([bindingRowOf(dir, flow).state, bindingRowOf(dir, flow).fence_revision], ['cancelled', 2], 'the binding is untouched by the refusal');
    expectCode(assert, () => admitUnder(store, robotId, flow), 'not_found');
    const view = observe(store, alice, continuation.reference.id);
    assert.deepEqual([view.state, view.obligation.state, view.result.reason], ['failed', 'rejected', 'coordinator_rejected']);
    assert.equal(observe(store, alice, admitted.reference.id).state, 'paused');
});

test('F-3: continuation of an active, a cancelled and another owner binding: binding_not_paused / binding_cancelled / not_found, zero rows', (t) => {
    const { dir, store } = setup(t);
    const alice = ownerRow('alice');
    const active = launch(store);
    const cancelled = launch(store);
    control(store, alice, cancelled.admitted.reference.id, 'stop');
    const bobs = launch(store, 'bob');
    control(store, ownerRow('bob'), bobs.admitted.reference.id, 'pause');
    const direct = flowId();
    store.registerBinding(alice, { operationId: newId(), bindingId: direct, kind: 'flow' });
    const before = tableCounts(dir);
    const continuation = (bindingId, context = alice) => obligate(store, context, 'flow-continuation', { continuationOf: { bindingId } });
    expectReason(() => continuation(active.flow), 'operation_conflict', 'binding_not_paused');
    expectReason(() => continuation(cancelled.flow), 'operation_conflict', 'binding_cancelled');
    expectCode(assert, () => continuation(bobs.flow), 'not_found');
    expectCode(assert, () => continuation(direct), 'not_found');
    expectCode(assert, () => continuation(flowId()), 'not_found');
    expectCode(assert, () => continuation(bobs.flow, ownerRow('bob', OTHER_COORDINATOR)), 'not_found');
    assert.deepEqual(tableCounts(dir), before);
    expectCode(assert, () => obligate(store, alice, 'flow-launch', { continuationOf: { bindingId: active.flow } }), 'invalid_request');
    expectCode(assert, () => obligate(store, alice, 'flow-continuation'), 'invalid_request');
    expectCode(assert, () => obligate(store, alice, 'flow-continuation', { continuationOf: { bindingId: `gen_${'0'.repeat(24)}` } }), 'invalid_request');
});

test('F-3: two processes admit continuations of one paused binding: exactly one succeeds', async (t) => {
    const dir = makeTempDir(t);
    const seeded = openStore(dir, { limits: S6_LIMITS, now: () => BASE_NOW });
    readyRobot(seeded, syntheticContext({ robotOwnerId: ROBOTS, scope: 'scope-robots' }));
    const { admitted, flow } = launch(seeded);
    control(seeded, ownerRow('alice'), admitted.reference.id, 'pause');
    seeded.close();
    const fields = ownerFields('alice');
    const specs = [newOriginId(), newOriginId()].map((originRequestId) => ({
        dir, method: 'admitObligation', limits: S6_LIMITS, now: BASE_NOW + 1, context: fields,
        request: {
            operationId: deriveOperationId(fields, originRequestId), originRequestId, obligationKind: 'flow-continuation',
            request: { flow: 'synthetic' }, continuationOf: { bindingId: flow }
        }
    }));
    const outputs = (await raceChildren(specs)).map((result) => result.output);
    assert.equal(outputs.filter((output) => output.ok).length, 1, JSON.stringify(outputs));
    const loser = outputs.find((output) => !output.ok);
    assert.equal(loser.code, 'operation_conflict', 'the loser is refused because a continuation is open');
    assert.equal(count(dir, 'obligation'), 2);
});

test('F-3: an outbox progress after a pause, carrying the pre-fence fenceRevision, is fenced', (t) => {
    const { dir, store } = setup(t);
    const { admitted } = launch(store);
    outbox(store, admitted.obligationId, 1, 0, 'bound');
    control(store, ownerRow('alice'), admitted.reference.id, 'pause');
    const reply = outbox(store, admitted.obligationId, 2, 0, 'progress', { step: 1 });
    assert.deepEqual(reply, { obligationId: admitted.obligationId, revision: 2, applied: false, fenced: 'paused', fenceRevision: 1 });
    // Every kind is fenced, whatever revision it reports.
    assert.equal(succeeds(() => outbox(store, admitted.obligationId, 2, 1, 'terminal', { status: 'completed', outputText: 'x' }), 'a fenced interval answers fenced').fenced, 'paused');
    assert.equal(count(dir, 'outbox_revision'), 1);
    // A revision applied before the fence is still the recorded acknowledgement.
    assert.equal(outbox(store, admitted.obligationId, 1, 0, 'bound').applied, true);
});

test('F-3: a flow-launch accept whose domainRecordId is an existing direct root is operation_conflict; the obligation stays pending', (t) => {
    const { dir, store } = setup(t);
    const alice = ownerRow('alice');
    const direct = flowId();
    store.registerBinding(alice, { operationId: newId(), bindingId: direct, kind: 'flow' });
    const admitted = obligate(store, alice);
    const before = tableCounts(dir);
    expectCode(assert, () => accept(store, admitted.obligationId, direct), 'operation_conflict');
    assert.deepEqual(tableCounts(dir), before, 'no state change and no receipt');
    assert.equal(obligationRow(dir, admitted.obligationId).state, 'pending');
    // A launch accepted under one ID cannot be accepted again under another.
    const flow = flowId();
    assert.equal(accept(store, admitted.obligationId, flow).decision, 'accepted');
    const second = obligate(store, alice);
    expectCode(assert, () => accept(store, second.obligationId, flow), 'operation_conflict');
    // The same flow ID under another coordinator is that coordinator's own namespace.
    const theirs = obligate(store, ownerRow('alice', OTHER_COORDINATOR));
    assert.equal(accept(store, theirs.obligationId, flow, OTHER_COORDINATOR).decision, 'accepted');
});

test('N-1: stop on a paused-interval reference after a later continuation was accepted is not_applicable; the binding stays active', (t) => {
    const { dir, store } = setup(t);
    const alice = ownerRow('alice');
    const { admitted, flow } = launch(store);
    control(store, alice, admitted.reference.id, 'pause');
    const continuation = obligate(store, alice, 'flow-continuation', { continuationOf: { bindingId: flow } });
    accept(store, continuation.obligationId, flow);
    const reply = control(store, alice, admitted.reference.id, 'stop');
    assert.deepEqual([reply.outcome, reply.state, reply.bindingState, reply.fenceRevision], ['not_applicable', 'paused', 'active', 2]);
    assert.deepEqual([bindingRowOf(dir, flow).state, bindingRowOf(dir, flow).fence_revision], ['active', 2]);
    // Pausing the later interval again, then stop on the first: still not_applicable.
    control(store, alice, continuation.reference.id, 'pause');
    assert.equal(control(store, alice, admitted.reference.id, 'stop').outcome, 'not_applicable');
    assert.equal(bindingRowOf(dir, flow).state, 'paused');
    assert.equal(control(store, alice, admitted.reference.id, 'pause').outcome, 'not_applicable', 'pause on a paused interval');
});

// ---- §15 F-4 and W1 review R2 --------------------------------------------------------------

test('F-4: gen_ bindings come only from accepted obligations: registerBinding refuses kind generation and a gen_ ID claimed as flow', (t) => {
    const { dir, store, robotId } = setup(t);
    const alice = ownerRow('alice');
    expectCode(assert, () => store.registerBinding(alice, { operationId: newId(), bindingId: `gen_${'0'.repeat(24)}`, kind: 'generation' }), 'invalid_request');
    expectCode(assert, () => store.registerBinding(alice, { operationId: newId(), bindingId: `gen_${'0'.repeat(24)}`, kind: 'flow' }), 'invalid_request');
    const { flow } = launch(store);
    expectCode(assert, () => store.registerBinding(bindingRow(flow, 'user:alice'), { operationId: newId(), bindingId: `gen_${'1'.repeat(24)}`, kind: 'flow', parentBindingId: flow }), 'invalid_request');
    assert.equal(count(dir, 'binding'), 1);
    const generation = obligate(store, alice, 'generation');
    const ticket = genId();
    expectCode(assert, () => accept(store, generation.obligationId, flowId()), 'invalid_request');
    assert.equal(accept(store, generation.obligationId, ticket).decision, 'accepted');
    const stored = bindingRowOf(dir, ticket);
    assert.deepEqual([stored.kind, stored.evidence, stored.owner_id, stored.depth], ['generation', 'obligation', 'user:alice', 0]);
    assert.equal(admitUnder(store, robotId, ticket).logicalKind, 'flow');
});

// ---- §16 N-6 recorded decisions ------------------------------------------------------------

test('N-6: reject at acceptBy is refused expired; reject after accept is refused accepted with no change; accept after a sweep committed expiry is refused expired', (t) => {
    const { dir, store, clock } = setup(t);
    const atDeadline = obligate(store, ownerRow('alice'));
    clock.now = atDeadline.acceptBy;
    const late = reject(store, atDeadline.obligationId);
    assert.deepEqual([late.decision, late.reason, late.state], ['refused', 'expired', 'expired']);
    assert.equal(obligationRow(dir, atDeadline.obligationId).state, 'expired');
    clock.now = BASE_NOW;
    const { admitted } = launch(store);
    const before = obligationRow(dir, admitted.obligationId);
    const afterAccept = reject(store, admitted.obligationId);
    assert.deepEqual([afterAccept.decision, afterAccept.reason], ['refused', 'accepted']);
    assert.deepEqual(obligationRow(dir, admitted.obligationId), before);
    const swept = obligate(store, ownerRow('alice'));
    clock.now = swept.acceptBy;
    assert.equal(store.sweepObligations().expired, 1);
    const refused = accept(store, swept.obligationId, flowId());
    assert.deepEqual([refused.decision, refused.reason], ['refused', 'expired']);
    // A rejected obligation keeps its rejection; a reject reason spelled like the fence reason does not alias it.
    clock.now = BASE_NOW;
    const fenceSpelled = obligate(store, ownerRow('alice'));
    assert.equal(reject(store, fenceSpelled.obligationId, 'fence_changed').decision, 'rejected');
    assert.deepEqual([accept(store, fenceSpelled.obligationId, flowId()).reason, reject(store, fenceSpelled.obligationId).decision], ['rejected', 'rejected']);
    expectCode(assert, () => reject(store, fenceSpelled.obligationId, 'Bad Reason'), 'invalid_request');
});

// ---- M-5 stop at the deadline ------------------------------------------------------------

test('M-5: stop on a pending obligation at acceptBy or later commits expired and is not_applicable; at acceptBy - 1 it cancels', (t) => {
    const { dir, store, clock } = setup(t);
    const alice = ownerRow('alice');
    for (const offset of [0, 1]) {
        clock.now = BASE_NOW;
        const admitted = obligate(store, alice);
        clock.now = admitted.acceptBy + offset;
        const reply = control(store, alice, admitted.reference.id, 'stop');
        assert.deepEqual([reply.outcome, reply.state], ['not_applicable', 'failed']);
        assert.equal(obligationRow(dir, admitted.obligationId).state, 'expired', 'the stop committed the expiry');
    }
    clock.now = BASE_NOW;
    const early = obligate(store, alice);
    clock.now = early.acceptBy - 1;
    const reply = control(store, alice, early.reference.id, 'stop');
    assert.deepEqual([reply.outcome, reply.state, reply.fenceRevision], ['accepted', 'cancelled', null]);
    assert.equal(obligationRow(dir, early.obligationId).state, 'cancelled');
    const refused = accept(store, early.obligationId, flowId());
    assert.deepEqual([refused.decision, refused.reason], ['refused', 'cancelled']);
    assert.equal(count(dir, 'binding'), 0);
});

test('M-5: two processes race stop against accept at acceptBy - 1: exactly one exit from pending', async (t) => {
    const dir = makeTempDir(t);
    const seeded = openStore(dir, { limits: S6_LIMITS, now: () => BASE_NOW });
    readyRobot(seeded, syntheticContext({ robotOwnerId: ROBOTS, scope: 'scope-robots' }));
    const obligations = [0, 1, 2, 3].map(() => obligate(seeded, ownerRow('alice')));
    seeded.close();
    const orders = [];
    for (const admitted of obligations) {
        const flow = flowId();
        const now = admitted.acceptBy - 1;
        const [acceptOut, stopOut] = (await raceChildren([
            { dir, method: 'acceptObligation', limits: S6_LIMITS, now, coordinatorContext: coordinatorFields(),
                request: { operationId: newId(), obligationId: admitted.obligationId, domainRecordId: flow } },
            { dir, method: 'controlReference', limits: S6_LIMITS, now, context: ownerFields('alice'),
                request: { referenceId: admitted.reference.id, operationId: newId(), op: 'stop' } }
        ])).map((result) => result.output);
        assert.equal(acceptOut.ok, true, JSON.stringify(acceptOut));
        assert.equal(stopOut.ok, true, JSON.stringify(stopOut));
        const stored = obligationRow(dir, admitted.obligationId);
        assert.equal(stored.state, 'cancelled');
        if (acceptOut.result.decision === 'accepted') {
            // accept first, then the stop is a cancellation fence.
            assert.equal(stored.domain_record_id, flow);
            assert.deepEqual([stopOut.result.outcome, stopOut.result.bindingState], ['accepted', 'cancelled']);
            assert.equal(bindingRowOf(dir, flow).state, 'cancelled');
        } else {
            assert.deepEqual([acceptOut.result.reason, stored.domain_record_id], ['cancelled', null]);
            assert.equal(bindingRowOf(dir, flow), undefined);
        }
        orders.push(acceptOut.result.decision === 'accepted' ? 'accept-first' : 'stop-first');
    }
    t.diagnostic(`stop-vs-accept orders: ${orders.join(',')}`);
});

// ---- M-6 fence stops and the controls capacity ----------------------------------------------

test('M-6: fence stops are exempt from the controls capacity: pause and cancel apply with the cap full', (t) => {
    const { dir, store, robotId } = setup(t, { limits: { ...S6_LIMITS, controls: 1 } });
    const alice = ownerRow('alice');
    const { admitted, flow } = launch(store);
    const running = [admitUnder(store, robotId, flow), admitUnder(store, robotId, flow)];
    running.forEach((admitted) => start(store, admitted));
    // Fill the relayed-control capacity with an unrelated message.
    const task = store.admit(alice, admitRequest(robotId, {}, alice));
    start(store, task);
    store.controlReference(alice, { referenceId: task.reference.id, operationId: newId(), op: 'message', payload: { message: 'hi' } });
    expectCode(assert, () => store.controlReference(alice, { referenceId: task.reference.id, operationId: newId(), op: 'message', payload: { message: 'more' } }), 'capacity_exceeded');
    const pause = succeeds(() => control(store, alice, admitted.reference.id, 'pause'), 'a pause is never refused for capacity');
    assert.equal(pause.outcome, 'accepted');
    assert.equal(count(dir, "reference_control WHERE source = 'fence'"), 2, 'one pending fence stop per running descendant');
    const cancel = succeeds(() => control(store, alice, admitted.reference.id, 'stop'), 'a cancellation is never refused for capacity');
    assert.deepEqual([cancel.outcome, cancel.bindingState], ['accepted', 'cancelled']);
    assert.equal(count(dir, "reference_control WHERE source = 'fence'"), 2, 'a further fence adds no duplicate pending stop');
});

test('M-6: fence-written stops do not consume relayed-control capacity', (t) => {
    const { store, robotId } = setup(t, { limits: { ...S6_LIMITS, controls: 2 } });
    const alice = ownerRow('alice');
    const { admitted, flow } = launch(store);
    [admitUnder(store, robotId, flow), admitUnder(store, robotId, flow), admitUnder(store, robotId, flow)].forEach((entry) => start(store, entry));
    // The pause records one relayed control row and three fence stops.
    control(store, alice, admitted.reference.id, 'pause');
    const task = store.admit(alice, admitRequest(robotId, {}, alice));
    start(store, task);
    succeeds(() => store.controlReference(alice, { referenceId: task.reference.id, operationId: newId(), op: 'message', payload: { message: 'hi' } }),
        'a relayed control still fits: fence stops are not counted');
    expectCode(assert, () => store.controlReference(alice, { referenceId: task.reference.id, operationId: newId(), op: 'message', payload: { message: 'more' } }), 'capacity_exceeded');
});

// ---- §15 F-6 / §16 N-7 / §17 D6 generation reads --------------------------------------------

test('N-7/D6: generation obligation admitted by coordinator P1: V through P1 reads and lists events, stop forbidden; V through P2, /task-refs and an agent are not_found; a flow observation is not shared', (t) => {
    const { store } = setup(t);
    const alice = ownerRow('alice');
    const generationRequest = obligationRequest(alice, 'generation');
    const generation = store.admitObligation(alice, generationRequest);
    accept(store, generation.obligationId, genId());
    const flowObservation = obligate(store, alice, 'flow-launch');
    const victorP1 = ownerRow('victor');
    const reference = generation.reference.id;
    // D6-1 (worker half): read and events through the admitting coordinator.
    assert.equal(succeeds(() => observe(store, victorP1, reference), 'V reads through P1').obligation.obligationKind, 'generation');
    assert.ok(succeeds(() => store.listReferenceEvents(victorP1, { referenceId: reference, after: 0, limit: 10 }), 'V lists events through P1').events.length >= 2);
    // D6-5: control by a visible non-owner through the admitting coordinator.
    expectCode(assert, () => control(store, victorP1, reference, 'stop'), 'forbidden');
    // D6-3: another declared coordinator's user context.
    expectCode(assert, () => observe(store, ownerRow('victor', OTHER_COORDINATOR), reference), 'not_found');
    // D6-4: a direct non-owner /task-refs read and control.
    expectCode(assert, () => observe(store, mcpRow('victor'), reference), 'not_found');
    expectCode(assert, () => control(store, mcpRow('victor'), reference, 'stop'), 'not_found');
    expectCode(assert, () => observe(store, syntheticContext({ originKey: 'agent:RoboRepo/otherAgent', ownerId: 'agent:RoboRepo/otherAgent', scope: 'scope-agent' }), reference), 'not_found');
    expectCode(assert, () => observe(store, victorP1, flowObservation.reference.id), 'not_found');
    // Lookup stays origin-scoped.
    expectCode(assert, () => store.lookupOrigin(victorP1, { originRequestId: generationRequest.originRequestId }), 'not_found');
    // The owner and an administrator keep control.
    assert.equal(observe(store, mcpRow('alice'), reference).state, 'accepted', 'owner equality across rows');
    assert.equal(control(store, ownerRow('admin', COORDINATOR, { administrator: true }), reference, 'stop').outcome, 'accepted');
});

// ---- Further Part D cases --------------------------------------------------------------------

test('obligation admission rows: coordinator-API and MCP rows admit and record the admitting coordinator; the background row is forbidden', (t) => {
    const { dir, store } = setup(t);
    const viaOwner = obligate(store, ownerRow('alice'));
    const viaMcp = obligate(store, mcpRow('alice', OTHER_COORDINATOR), 'generation');
    assert.deepEqual([obligationRow(dir, viaOwner.obligationId).coordinator, obligationRow(dir, viaOwner.obligationId).owner_id], [COORDINATOR, 'user:alice']);
    assert.deepEqual([obligationRow(dir, viaMcp.obligationId).coordinator, obligationRow(dir, viaMcp.obligationId).owner_id], [OTHER_COORDINATOR, 'user:alice']);
    // The MCP-admitted obligation is decided only by its admitting coordinator.
    expectCode(assert, () => accept(store, viaMcp.obligationId, genId()), 'not_found');
    assert.equal(accept(store, viaMcp.obligationId, genId(), OTHER_COORDINATOR).decision, 'accepted');
    const { flow } = launch(store);
    const before = tableCounts(dir);
    expectCode(assert, () => obligate(store, bindingRow(flow, 'user:alice')), 'forbidden');
    expectCode(assert, () => obligate(store, mcpRow('alice')), 'forbidden');
    expectCode(assert, () => obligate(store, ownerRow('alice', COORDINATOR, { coordinator: OTHER_COORDINATOR })), 'forbidden');
    expectCode(assert, () => store.admitObligation(coordinator(), obligationRequest(ownerRow('alice'), 'flow-launch')), 'forbidden');
    // The request is opaque but bounded and free of authority keys.
    expectCode(assert, () => obligate(store, ownerRow('alice'), 'flow-launch', { request: { project: { path: '/x' } } }), 'invalid_request');
    expectCode(assert, () => obligate(store, ownerRow('alice'), 'flow-launch', { request: { big: 'x'.repeat(S6_LIMITS.requestBytes) } }), 'invalid_request');
    expectCode(assert, () => obligate(store, ownerRow('alice'), 'other'), 'invalid_request');
    assert.deepEqual(tableCounts(dir), before);
    assert.equal(succeeds(() => obligate(store, ownerRow('alice'), 'flow-launch', { request: { project: { selection: 'home', relativePath: 'a/b' } } }),
        'a project is written {selection, relativePath}').admissionState, 'pending-coordinator');
});

test('observation snapshot: pending-coordinator, read-time expiry without a commit, accepted, terminal from the outbox; no attempt', (t) => {
    const { dir, store, clock } = setup(t);
    const alice = ownerRow('alice');
    const admitted = obligate(store, alice);
    const pending = projectSnapshot(observe(store, alice, admitted.reference.id));
    assert.deepEqual(Object.keys(pending), ['taskRef', 'originRequestId', 'kind', 'state', 'obligation', 'logical', 'sequence']);
    assert.deepEqual([pending.kind, pending.state, pending.logical], ['observation', 'pending-coordinator', { kind: 'flow', id: null }]);
    assert.deepEqual(pending.obligation, { obligationKind: 'flow-launch', state: 'pending', acceptBy: admitted.acceptBy, fenceRevision: null });
    clock.now = admitted.acceptBy;
    const expiredRead = projectSnapshot(observe(store, alice, admitted.reference.id));
    assert.deepEqual([expiredRead.state, expiredRead.obligation.state, expiredRead.result], ['failed', 'expired', { status: 'failed', outputText: '', reason: 'acceptance_expired' }]);
    assert.equal(obligationRow(dir, admitted.obligationId).state, 'pending', 'a read never commits the expiry');
    clock.now = BASE_NOW;
    const flow = flowId();
    accept(store, admitted.obligationId, flow);
    const accepted = projectSnapshot(observe(store, alice, admitted.reference.id));
    assert.deepEqual([accepted.state, accepted.logical, accepted.obligation.fenceRevision], ['accepted', { kind: 'flow', id: flow }, 0]);
    outbox(store, admitted.obligationId, 1, 0, 'bound');
    outbox(store, admitted.obligationId, 2, 0, 'terminal', { status: 'completed', outputText: 'done', data: { n: 1 } });
    const terminal = projectSnapshot(observe(store, alice, admitted.reference.id));
    assert.deepEqual([terminal.state, terminal.result, terminal.obligation.state], ['completed', { status: 'completed', outputText: 'done', data: { n: 1 } }, 'accepted']);
    assert.equal(terminal.attempt, undefined);
    const events = store.listReferenceEvents(alice, { referenceId: admitted.reference.id, after: 0, limit: 10 }).events.map((event) => event.data.state);
    assert.deepEqual(events, ['pending-coordinator', 'accepted', 'completed']);
    // After the terminal revision nothing further applies, and both controls are not applicable.
    expectCode(assert, () => outbox(store, admitted.obligationId, 3, 0, 'progress', {}), 'operation_conflict');
    assert.equal(control(store, alice, admitted.reference.id, 'stop').outcome, 'not_applicable');
    assert.equal(control(store, alice, admitted.reference.id, 'pause').outcome, 'not_applicable');
});

test('list: accepted and unbound obligations in acceptance order with a cursor; other coordinators, bound and pending excluded; unknown or malformed cursor invalid_request', (t) => {
    const { store, clock } = setup(t);
    const alice = ownerRow('alice');
    const accepted = [];
    for (let index = 0; index < 5; index += 1) {
        clock.now = BASE_NOW + index;
        accepted.push(launch(store));
    }
    obligate(store, alice);
    launch(store, 'alice', OTHER_COORDINATOR);
    outbox(store, accepted[1].admitted.obligationId, 1, 0, 'bound');
    const list = (after, limit) => store.listObligations(coordinator(), { state: 'accepted', unbound: true, after, limit });
    const first = list('', 2);
    assert.deepEqual(first.obligations.map((item) => item.obligationId), [accepted[0], accepted[2]].map((entry) => entry.admitted.obligationId));
    assert.equal(first.nextAfter, accepted[2].admitted.obligationId);
    const item = first.obligations[0];
    assert.deepEqual(Object.keys(item).sort(), ['acceptBy', 'domainRecordId', 'fenceRevision', 'obligationId', 'obligationKind', 'originRequestId', 'owner', 'request', 'state', 'taskRef']);
    assert.deepEqual([item.owner, item.state, item.domainRecordId, item.fenceRevision, item.request], ['user:alice', 'accepted', accepted[0].flow, 0, { flow: 'synthetic', project: null }]);
    const second = list(first.nextAfter, 2);
    assert.deepEqual(second.obligations.map((entry) => entry.obligationId), [accepted[3], accepted[4]].map((entry) => entry.admitted.obligationId));
    assert.equal(second.nextAfter, null);
    assert.deepEqual(list(accepted[1].admitted.obligationId, 10).obligations.length, 3, 'a now-bound obligation is still a valid position');
    for (const bad of [newId(), 'not-a-cursor', 7]) expectCode(assert, () => list(bad, 2), 'invalid_request');
    expectCode(assert, () => store.listObligations(coordinator(OTHER_COORDINATOR), { state: 'accepted', unbound: true, after: accepted[0].admitted.obligationId, limit: 2 }), 'invalid_request');
    for (const body of [{ state: 'pending', unbound: true, after: '', limit: 1 }, { state: 'accepted', unbound: false, after: '', limit: 1 },
        { state: 'accepted', unbound: true, after: '', limit: 0 }, { state: 'accepted', unbound: true, after: '', limit: 1001 }]) {
        expectCode(assert, () => store.listObligations(coordinator(), body), 'invalid_request');
    }
    // A continuation lists its continued binding.
    control(store, alice, accepted[0].admitted.reference.id, 'pause');
    const continuation = obligate(store, alice, 'flow-continuation', { continuationOf: { bindingId: accepted[0].flow } });
    clock.now = BASE_NOW + 100;
    accept(store, continuation.obligationId, accepted[0].flow);
    const last = list('', 1000).obligations.at(-1);
    assert.deepEqual([last.obligationId, last.continuationOf, last.fenceRevision], [continuation.obligationId, { bindingId: accepted[0].flow }, 2]);
});

test('a fault before commit in accept or in a fence leaves no partial binding or fence', (t) => {
    let armed = null;
    const { dir, store } = setup(t, { faults: { beforeCommit: (label) => { if (label === armed) throw new Error('synthetic fault'); } } });
    const alice = ownerRow('alice');
    const admitted = obligate(store, alice);
    const flow = flowId();
    armed = 'acceptObligation';
    expectCode(assert, () => accept(store, admitted.obligationId, flow), 'state_corrupt');
    assert.deepEqual([count(dir, 'binding'), obligationRow(dir, admitted.obligationId).state], [0, 'pending']);
    armed = null;
    accept(store, admitted.obligationId, flow);
    armed = 'controlReference';
    expectCode(assert, () => control(store, alice, admitted.reference.id, 'pause'), 'state_corrupt');
    assert.deepEqual([bindingRowOf(dir, flow).state, bindingRowOf(dir, flow).fence_revision, obligationRow(dir, admitted.obligationId).state], ['active', 0, 'accepted']);
    armed = null;
    assert.equal(control(store, alice, admitted.reference.id, 'pause').bindingState, 'paused');
});

test('unknown, foreign and malformed: accept, reject and outbox on an unknown obligation are not_found; malformed bodies invalid_request; controls on observation references refuse message, attemptId and payload after visibility', (t) => {
    const { store } = setup(t);
    const alice = ownerRow('alice');
    expectCode(assert, () => outbox(store, newId(), 1, 0, 'bound'), 'not_found');
    expectCode(assert, () => reject(store, newId()), 'not_found');
    const pending = obligate(store, alice);
    expectCode(assert, () => outbox(store, pending.obligationId, 1, 0, 'bound'), 'operation_conflict');
    for (const bad of [
        () => store.acceptObligation(coordinator(), { operationId: newId(), obligationId: 'short', domainRecordId: flowId() }),
        () => store.acceptObligation(coordinator(), { operationId: newId(), obligationId: pending.obligationId, domainRecordId: 7 }),
        () => store.acceptObligation(coordinator(), { operationId: newId(), obligationId: pending.obligationId, domainRecordId: flowId(), extra: 1 }),
        () => accept(store, pending.obligationId, 'flow_xyz'),
        () => accept(store, pending.obligationId, genId()),
        () => outbox(store, pending.obligationId, 1, -1, 'bound'),
        () => outbox(store, pending.obligationId, 0, 0, 'bound'),
        () => outbox(store, pending.obligationId, 2, 0, 'other'),
        () => outbox(store, pending.obligationId, 2, 0, 'terminal', { status: 'other', outputText: '' }),
        () => outbox(store, pending.obligationId, 2, 0, 'progress', { token: 'x' }),
        () => outbox(store, pending.obligationId, 1, 0, 'bound', { extra: 1 })
    ]) {
        expectCode(assert, bad, 'invalid_request');
    }
    expectCode(assert, () => store.acceptObligation(alice, { operationId: newId(), obligationId: pending.obligationId, domainRecordId: flowId() }), 'forbidden');
    for (const extra of [{ op: 'message', payload: { message: 'x' } }, { op: 'stop', attemptId: newId() }]) {
        expectCode(assert, () => store.controlReference(ownerRow('bob'), { referenceId: pending.reference.id, operationId: newId(), ...extra }), 'not_found');
        expectCode(assert, () => store.controlReference(alice, { referenceId: pending.reference.id, operationId: newId(), ...extra }), 'invalid_request');
    }
    // A recorded fence control replays its bytes.
    const operationId = newId();
    const first = store.controlReference(alice, { referenceId: pending.reference.id, operationId, op: 'stop' });
    assert.deepEqual(store.controlReference(alice, { referenceId: pending.reference.id, operationId, op: 'stop' }), first);
    expectCode(assert, () => store.controlReference(alice, { referenceId: pending.reference.id, operationId, op: 'pause' }), 'operation_conflict');
});

test('S6 limits are accepted only as a complete set on top of the S1x set; an obligation needs them (capacity_exceeded without)', (t) => {
    assert.deepEqual({ ...validateLimits(S6_LIMITS) }, { ...S6_LIMITS });
    const { obligations, outboxRevisions, obligationAcceptMs, ...extended } = S6_LIMITS;
    void outboxRevisions; void obligationAcceptMs;
    expectCode(assert, () => validateLimits({ ...extended, obligations }), 'invalid_request');
    expectCode(assert, () => validateLimits({ ...S6_LIMITS, obligationAcceptMs: 0 }), 'invalid_request');
    const { bindings, ...missingExtension } = S6_LIMITS;
    void bindings;
    expectCode(assert, () => validateLimits({ ...missingExtension, other: 1 }), 'invalid_request');
    const { store } = setup(t, { limits: extended });
    expectCode(assert, () => obligate(store, ownerRow('alice')), 'capacity_exceeded');
    const { store: full } = setup(t, { limits: { ...S6_LIMITS, obligations: 1 } });
    obligate(full, ownerRow('alice'));
    expectCode(assert, () => obligate(full, ownerRow('alice')), 'capacity_exceeded');
});

// ---- W2 r2 review fixes (code-review-s6w2-1df9fdc7: F1, F2, F3) --------------------------------

test('F1: open continuations are unique per coordinator: B continues its own paused flow while A has a pending continuation of the same flow ID, and after A accepts without outbox revision 1', (t) => {
    const { dir, store } = setup(t);
    const alice = ownerRow('alice');
    const aliceViaB = ownerRow('alice', OTHER_COORDINATOR);
    // Coordinators A and B each launch, accept and pause their own binding with one shared flow ID.
    const shared = (flow) => {
        const a = obligate(store, alice);
        assert.equal(accept(store, a.obligationId, flow).decision, 'accepted');
        control(store, alice, a.reference.id, 'pause');
        const b = obligate(store, aliceViaB);
        assert.equal(accept(store, b.obligationId, flow, OTHER_COORDINATOR).decision, 'accepted');
        control(store, aliceViaB, b.reference.id, 'pause');
    };
    const flowX = flowId();
    shared(flowX);
    const aPending = obligate(store, alice, 'flow-continuation', { continuationOf: { bindingId: flowX } });
    const bWhilePending = succeeds(() => obligate(store, aliceViaB, 'flow-continuation', { continuationOf: { bindingId: flowX } }),
        "B's continuation is independent of A's pending continuation");
    assert.equal(bWhilePending.admissionState, 'pending-coordinator');
    // Within one coordinator the one-open rule still holds.
    expectCode(assert, () => obligate(store, aliceViaB, 'flow-continuation', { continuationOf: { bindingId: flowX } }), 'operation_conflict');
    expectCode(assert, () => obligate(store, alice, 'flow-continuation', { continuationOf: { bindingId: flowX } }), 'operation_conflict');
    const flowY = flowId();
    shared(flowY);
    const aContinuation = obligate(store, alice, 'flow-continuation', { continuationOf: { bindingId: flowY } });
    assert.equal(accept(store, aContinuation.obligationId, flowY).decision, 'accepted');
    assert.equal(obligationRow(dir, aContinuation.obligationId).bound, 0, 'A posts no outbox revision 1');
    const bAfterAccept = succeeds(() => obligate(store, aliceViaB, 'flow-continuation', { continuationOf: { bindingId: flowY } }),
        "B's continuation is independent of A's accepted, unbound continuation");
    assert.equal(accept(store, bAfterAccept.obligationId, flowY, OTHER_COORDINATOR).decision, 'accepted');
    assert.deepEqual([bindingRowOf(dir, flowY).state, bindingRowOf(dir, flowY, OTHER_COORDINATOR).state], ['active', 'active']);
    assert.equal(obligationRow(dir, aPending.obligationId).state, 'pending');
});

test('F2: the list pages in acceptance order when accepts share a millisecond or the clock steps back; a cursor walk never skips an accepted, unbound obligation', (t) => {
    const { dir, store, clock } = setup(t);
    const alice = ownerRow('alice');
    const [o1, o2, o3] = [0, 1, 2].map(() => obligate(store, alice));
    clock.now = BASE_NOW + 50;
    accept(store, o2.obligationId, flowId());
    succeeds(() => accept(store, o3.obligationId, flowId()), 'a second accept in the same millisecond gets its own sequence');
    const list = (after, limit) => store.listObligations(coordinator(), { state: 'accepted', unbound: true, after, limit });
    const first = list('', 1);
    assert.deepEqual(first.obligations.map((item) => item.obligationId), [o2.obligationId]);
    // o1 is accepted in the same millisecond, after o2 and o3: it must still be reached by the walk.
    succeeds(() => accept(store, o1.obligationId, flowId()), 'a third accept in the same millisecond gets its own sequence');
    const second = list(first.nextAfter, 1);
    assert.deepEqual(second.obligations.map((item) => item.obligationId), [o3.obligationId]);
    const third = list(second.nextAfter, 1);
    assert.deepEqual(third.obligations.map((item) => item.obligationId), [o1.obligationId], 'the same-millisecond accept is not skipped');
    assert.equal(third.nextAfter, null);
    // The clock steps back between accepts: acceptance order still wins.
    const [o4, o5] = [0, 1].map(() => obligate(store, alice));
    clock.now = BASE_NOW + 500;
    accept(store, o4.obligationId, flowId());
    clock.now = BASE_NOW + 100;
    accept(store, o5.obligationId, flowId());
    assert.deepEqual(list('', 10).obligations.map((item) => item.obligationId), [o2, o3, o1, o4, o5].map((entry) => entry.obligationId));
    const sequence = rows(dir, 'SELECT accepted_seq FROM obligation WHERE accepted_seq IS NOT NULL ORDER BY accepted_seq').map((entry) => entry.accepted_seq);
    assert.deepEqual(sequence, [1, 2, 3, 4, 5]);
    // The acceptance sequence is immutable and exists exactly for accepted obligations.
    const db = rawDb(dir);
    try {
        assert.throws(() => db.prepare('UPDATE obligation SET accepted_seq = 99 WHERE obligation_id = ?').run(o1.obligationId), /immutable/u);
        assert.throws(() => db.prepare("UPDATE obligation SET accepted_seq = NULL WHERE obligation_id = ?").run(o2.obligationId));
    } finally {
        db.close();
    }
});

test('F3: with the bindings cap full, a flow-launch collision is still operation_conflict, not capacity_exceeded', (t) => {
    const { dir, store } = setup(t, { limits: { ...S6_LIMITS, bindings: 1 } });
    const alice = ownerRow('alice');
    const direct = flowId();
    store.registerBinding(alice, { operationId: newId(), bindingId: direct, kind: 'flow' });
    const admitted = obligate(store, alice);
    const before = tableCounts(dir);
    expectCode(assert, () => accept(store, admitted.obligationId, direct), 'operation_conflict');
    assert.deepEqual(tableCounts(dir), before);
    expectCode(assert, () => accept(store, admitted.obligationId, flowId()), 'capacity_exceeded');
});

test('F3: with the obligations cap full, a second open continuation is still operation_conflict, not capacity_exceeded', (t) => {
    const { dir, store } = setup(t, { limits: { ...S6_LIMITS, obligations: 2 } });
    const alice = ownerRow('alice');
    const { admitted, flow } = launch(store);
    control(store, alice, admitted.reference.id, 'pause');
    obligate(store, alice, 'flow-continuation', { continuationOf: { bindingId: flow } });
    const before = tableCounts(dir);
    expectCode(assert, () => obligate(store, alice, 'flow-continuation', { continuationOf: { bindingId: flow } }), 'operation_conflict');
    assert.deepEqual(tableCounts(dir), before);
    expectCode(assert, () => obligate(store, alice), 'capacity_exceeded');
});

// ---- W2 r3 (review code-review-s6w2-r2-96c8f531: R-1) -----------------------------------------

test('R-1: after a pause (fence revision 1) and a cancel through the paused reference (revision 2), the outbox reports fenced cancelled at the reported revisions 0 and 1', (t) => {
    const { dir, store } = setup(t);
    const alice = ownerRow('alice');
    const { admitted } = launch(store);
    outbox(store, admitted.obligationId, 1, 0, 'bound');
    assert.equal(control(store, alice, admitted.reference.id, 'pause').fenceRevision, 1);
    const cancel = control(store, alice, admitted.reference.id, 'stop');
    assert.deepEqual([cancel.state, cancel.bindingState, cancel.fenceRevision], ['paused', 'cancelled', 2]);
    for (const reported of [0, 1]) {
        assert.deepEqual(outbox(store, admitted.obligationId, 2, reported, 'progress', { step: reported }),
            { obligationId: admitted.obligationId, revision: 2, applied: false, fenced: 'cancelled', fenceRevision: 2 }, `reported revision ${reported}`);
    }
    assert.equal(outbox(store, admitted.obligationId, 2, 2, 'terminal', { status: 'completed', outputText: 'x' }).fenced, 'cancelled');
    assert.equal(count(dir, 'outbox_revision'), 1);
    // A paused interval whose binding a later continuation reactivated still reports paused,
    // and reports cancelled once that binding is cancelled through the later interval.
    const second = launch(store);
    outbox(store, second.admitted.obligationId, 1, 0, 'bound');
    control(store, alice, second.admitted.reference.id, 'pause');
    const continuation = obligate(store, alice, 'flow-continuation', { continuationOf: { bindingId: second.flow } });
    accept(store, continuation.obligationId, second.flow);
    assert.equal(outbox(store, second.admitted.obligationId, 2, 1, 'progress', {}).fenced, 'paused');
    control(store, alice, continuation.reference.id, 'stop');
    assert.deepEqual(outbox(store, second.admitted.obligationId, 2, 2, 'progress', {}),
        { obligationId: second.admitted.obligationId, revision: 2, applied: false, fenced: 'cancelled', fenceRevision: 3 });
});

// r10 Q1 = A. The Environment refusal belongs to admission validation only: the obligation REQUEST is an admission-time
// payload, but recorded outbox data is not, and a refusal there would strand an accepted obligation's later revisions.
test('r10 Q1 = A: an obligation request with a nonempty Environment is refused before any row; outbox data with an environment key still applies', (t) => {
    const { dir, store } = setup(t);
    const alice = ownerRow('alice');
    const before = tableCounts(dir);
    for (const environment of ['Repo/agent', ' ']) {
        expectCode(assert, () => obligate(store, alice, 'flow-launch', { request: { flow: 'synthetic', environment } }), 'environment_unavailable');
    }
    expectCode(assert, () => obligate(store, alice, 'flow-launch', { request: { flow: 'synthetic', environment: 7 } }), 'invalid_request');
    assert.deepEqual(tableCounts(dir), before, 'nothing recorded for a refused obligation request');
    succeeds(() => obligate(store, alice, 'flow-launch', { request: { flow: 'synthetic', environment: '' } }), 'a blank Environment is the ordinary backend');
    const { admitted } = launch(store);
    outbox(store, admitted.obligationId, 1, 0, 'bound', { capturedInputsDigest: 'abc' });
    for (const [revision, data] of [[2, { environment: 'Repo/agent', step: 1 }], [3, { environment: 7 }], [4, { environment: '' }]]) {
        const reply = succeeds(() => outbox(store, admitted.obligationId, revision, 0, 'progress', data), `a progress revision with data.environment ${JSON.stringify(data.environment)} applies`);
        assert.equal(reply.applied, true);
    }
    assert.equal(obligationRow(dir, admitted.obligationId).last_revision, 4);
});

test('r10 Q1 = A: a stored obligation and a recorded outbox revision without Environment replay and continue after reopen and recovery', (t) => {
    const dir = makeTempDir(t);
    const clock = { now: BASE_NOW };
    let store = openStore(dir, { limits: S6_LIMITS, now: () => clock.now });
    readyRobot(store, syntheticContext({ robotOwnerId: ROBOTS, scope: 'scope-robots' }));
    const alice = ownerRow('alice');
    const pendingRequest = obligationRequest(alice, 'flow-launch', { request: { flow: 'stored-before', project: null } });
    const pending = store.admitObligation(alice, pendingRequest);
    const { admitted } = launch(store);
    const bound = outbox(store, admitted.obligationId, 1, 0, 'bound', { capturedInputsDigest: 'abc' });
    const progress = outbox(store, admitted.obligationId, 2, 0, 'progress', { step: 1 });
    store.close();
    clock.now = BASE_NOW + 100;
    store = openStore(dir, { limits: S6_LIMITS, now: () => clock.now, create: false });
    t.after(() => store.close());
    const generation = store.beginGenerationRecovery(store.generationId);
    store.completeGenerationRecovery(generation.generationId);
    // Recorded revisions replay to their recorded acknowledgements; the chain continues; no environment key was ever stored.
    assert.deepEqual(outbox(store, admitted.obligationId, 1, 0, 'bound', { capturedInputsDigest: 'abc' }), bound);
    assert.deepEqual(outbox(store, admitted.obligationId, 2, 0, 'progress', { step: 1 }), progress);
    assert.equal(outbox(store, admitted.obligationId, 3, 0, 'progress', { step: 2 }).applied, true);
    assert.equal(outbox(store, admitted.obligationId, 4, 0, 'terminal', { status: 'completed', outputText: 'done' }).applied, true);
    // The obligation stored before replays as recorded and is still acceptable.
    assert.deepEqual(store.admitObligation(alice, { ...pendingRequest }), pending);
    assert.equal(accept(store, pending.obligationId, flowId()).decision, 'accepted');
});
