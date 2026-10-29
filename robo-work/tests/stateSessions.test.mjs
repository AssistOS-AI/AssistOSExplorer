import assert from 'node:assert/strict';
import test from 'node:test';
import { runtimeUnavailable } from '../server/workerState.mjs';
import { OPERATIONS, deriveFlowLogicalId, deriveOperationId, isInternalId } from '../server/stateProtocol.mjs';
import { createVerifiedCoordinatorContext } from '../server/workerState.mjs';
import { raceChildren } from './helpers/childRunner.mjs';
import {
    LIMITS, S6_LIMITS, WORKSPACE, admitRequest, count, expectCode, makeTempDir, newId, newOriginId, openStore, rawDb, readyRobot, syntheticContext
} from './helpers/synthetic.mjs';

// S6 source-only subset, Part A: the logical kind recorded at admission, conversation
// sessions and their first-in, first-out turns, and the flow identity of background-row
// work. Contexts are SYNTHETIC internal preconditions and the runtime is the explicitly
// synthetic adapter of tests/helpers/synthetic.mjs: state evidence only, never protected
// execution, runtime readiness or routed authorization.

const EXTENDED = Object.freeze({ ...LIMITS, bindings: 16, controls: 16, tokenReplayEntries: 16 });
const ROBOTS = `workspace:${WORKSPACE}`;
const COORDINATOR = 'agent:RoboRepo/roboTeamAgent';
const OTHER_COORDINATOR = 'agent:RoboRepo/mailer';
const SESSION_TABLES = ['receipt', 'admission', 'origin', 'reference', 'session'];
const ADAPTER = () => syntheticContext({ scope: 'scope-adapter' });

// Coordinator-API row of `user` under coordinator `svc`.
function ownerRow(user, svc = COORDINATOR, extra = {}) {
    return syntheticContext({
        originNamespace: `coordinator:${svc}`, originKey: `owner:user:${user}`, ownerId: `user:${user}`, scope: `scope-${svc}-${user}`,
        robotOwnerId: ROBOTS, ...extra
    });
}

// MCP row of the direct caller `user:<user>`.
function mcpRow(user) {
    return syntheticContext({ originNamespace: 'mcp', originKey: `user:${user}`, ownerId: `user:${user}`, scope: `scope-mcp-${user}`, robotOwnerId: ROBOTS });
}

// Background row of binding `id` under `svc`, with the owner read from the binding.
function bindingRow(id, ownerId, svc = COORDINATOR) {
    return syntheticContext({
        originNamespace: `coordinator:${svc}`, originKey: `binding:${id}`, ownerId, scope: `scope-${svc}-binding-${id}`, robotOwnerId: ROBOTS
    });
}

// Runs a call that the requirement says succeeds; a refusal fails as an assertion naming it.
function succeeds(fn, message) {
    let value;
    let refusal = null;
    try {
        value = fn();
    } catch (error) {
        refusal = `${error.name}/${error.code}`;
    }
    assert.equal(refusal, null, message);
    return value;
}

function setup(t, options = {}) {
    const dir = makeTempDir(t);
    const store = openStore(dir, { limits: EXTENDED, ...options });
    t.after(() => store.close());
    const robotId = readyRobot(store, syntheticContext({ robotOwnerId: ROBOTS, scope: 'scope-robots' }));
    return { dir, store, robotId };
}

function turnRequest(robotId, context, sessionKey, overrides = {}) {
    return admitRequest(robotId, {
        kind: 'turn', logical: { sessionKey }, specification: { version: 1, prompt: 'synthetic turn' }, ...overrides
    }, context);
}

function admitTurn(store, robotId, context, sessionKey, overrides = {}) {
    return store.admit(context, turnRequest(robotId, context, sessionKey, overrides));
}

function start(store, admitted) {
    return store.transitionAttempt({ executionId: admitted.executionId, attemptId: admitted.attemptId, expectedState: 'queued', nextState: 'running' });
}

function finish(store, admitted, expectedState = 'running') {
    return store.beginAttemptEnd(ADAPTER(), {
        executionId: admitted.executionId, attemptId: admitted.attemptId, expectedState, outcome: { classification: 'completed' }
    });
}

function counts(dir, tables = SESSION_TABLES) {
    return Object.fromEntries(tables.map((table) => [table, count(dir, table)]));
}

function sessions(dir) {
    const db = rawDb(dir, { readOnly: true });
    try {
        return db.prepare('SELECT * FROM session ORDER BY rowid').all();
    } finally {
        db.close();
    }
}

function admissionRow(dir, executionId) {
    const db = rawDb(dir, { readOnly: true });
    try {
        return db.prepare('SELECT * FROM admission WHERE execution_id = ?').get(executionId);
    } finally {
        db.close();
    }
}

function registerRoot(store, user, bindingId, svc = COORDINATOR, kind = 'flow') {
    return store.registerBinding(ownerRow(user, svc), { operationId: newId(), bindingId, kind });
}

// A flow binding ID whose derived internal logical ID also has the internal-ID grammar, so a
// continuation naming it reaches the recorded-kind rule instead of the request grammar.
function grammaticalFlowId(svc = COORDINATOR) {
    for (let index = 0; index < 4096; index += 1) {
        const bindingId = `flow_${index.toString(16).padStart(24, '0')}`;
        if (isInternalId(deriveFlowLogicalId(svc, bindingId))) return bindingId;
    }
    return assert.fail('no grammatical derived flow logical ID found');
}

// ---- Required named cases (S6 delta "Required named unit cases", stateSessions) -------------

test('turn creates a session; a second turn joins it with the same logicalId and is admitted queued', (t) => {
    const { dir, store, robotId } = setup(t);
    const alice = ownerRow('alice');
    const first = admitTurn(store, robotId, alice, 'conv-1');
    start(store, first);
    // Plan §10.2: admitted queued even while the earlier turn of the conversation is active.
    const second = succeeds(() => admitTurn(store, robotId, alice, 'conv-1'), 'a second turn is admitted while the first is running');
    assert.equal(first.logicalKind, 'session');
    assert.equal(second.logicalKind, 'session');
    assert.equal(second.logicalId, first.logicalId);
    assert.notEqual(second.reference.id, first.reference.id);
    assert.equal(second.admissionState, 'queued');
    assert.equal(store.observeReference(alice, { referenceId: second.reference.id }).state, 'queued');
    assert.equal(store.observeReference(alice, { referenceId: second.reference.id }).logicalKind, 'session');
    const rows = sessions(dir);
    assert.equal(rows.length, 1, 'one session row');
    assert.deepEqual([rows[0].session_key, rows[0].logical_id, rows[0].robot_id, rows[0].owner_id], ['conv-1', first.logicalId, robotId, 'user:alice']);
    assert.equal(count(dir, 'admission'), 2);
    // The second turn links the first.
    assert.equal(store.observeReference(alice, { referenceId: second.reference.id }).previousReference.id, first.reference.id);
});

test('transitionAttempt of turn 2 while turn 1 is running is robot_busy; after turn 1 ends, turn 2 reaches running', (t) => {
    const { store, robotId } = setup(t);
    const alice = ownerRow('alice');
    const first = admitTurn(store, robotId, alice, 'conv-fifo');
    const second = succeeds(() => admitTurn(store, robotId, alice, 'conv-fifo'), 'a second turn is admitted while the first is queued');
    start(store, first);
    expectCode(assert, () => start(store, second), 'robot_busy');
    assert.equal(store.observeReference(alice, { referenceId: second.reference.id }).state, 'queued', 'the refused turn stays queued');
    finish(store, first);
    assert.equal(start(store, second).state, 'running');
});

test('a turn naming another robot for the same sessionKey is operation_conflict with zero new rows', (t) => {
    const { dir, store, robotId } = setup(t);
    const otherRobot = readyRobot(store, syntheticContext({ robotOwnerId: ROBOTS, scope: 'scope-robots' }));
    const alice = ownerRow('alice');
    admitTurn(store, robotId, alice, 'conv-robot');
    const before = counts(dir);
    expectCode(assert, () => admitTurn(store, otherRobot, alice, 'conv-robot'), 'operation_conflict');
    assert.deepEqual(counts(dir), before);
    // Another conversation of the same user may use the other robot.
    assert.equal(admitTurn(store, otherRobot, alice, 'conv-robot-2').logicalKind, 'session');
});

test("the same sessionKey under another user's scope is a separate session; neither sees the other", (t) => {
    const { dir, store, robotId } = setup(t);
    const alice = ownerRow('alice');
    const bob = ownerRow('bob');
    const aliceTurn = admitTurn(store, robotId, alice, 'shared-key');
    const bobTurn = succeeds(() => admitTurn(store, robotId, bob, 'shared-key'), 'another scope creates its own session for the same sessionKey');
    assert.notEqual(aliceTurn.logicalId, bobTurn.logicalId);
    assert.equal(sessions(dir).length, 2);
    expectCode(assert, () => store.observeReference(bob, { referenceId: aliceTurn.reference.id }), 'not_found');
    expectCode(assert, () => store.observeReference(alice, { referenceId: bobTurn.reference.id }), 'not_found');
    // The same user through another coordinator is another scope, so another session too.
    const viaMailer = succeeds(() => admitTurn(store, robotId, ownerRow('alice', OTHER_COORDINATOR), 'shared-key'), 'another coordinator scope creates its own session');
    assert.notEqual(viaMailer.logicalId, aliceTurn.logicalId);
    assert.equal(sessions(dir).length, 3);
    // FIFO is per session: bob's turn runs while alice's is running.
    start(store, aliceTurn);
    assert.equal(start(store, bobTurn).state, 'running');
});

test('task continuation while busy is robot_busy (regression of the stateAdmission continuation case)', (t) => {
    const { store, robotId } = setup(t);
    const alice = ownerRow('alice');
    const first = store.admit(alice, admitRequest(robotId, {}, alice));
    assert.equal(first.logicalKind, 'task');
    const continuation = () => admitRequest(robotId, { kind: 'continuation', logical: { logicalId: first.logicalId } }, alice);
    expectCode(assert, () => store.admit(alice, continuation()), 'robot_busy');
    start(store, first);
    expectCode(assert, () => store.admit(alice, continuation()), 'robot_busy');
    finish(store, first);
    const continued = store.admit(alice, continuation());
    assert.equal(continued.logicalId, first.logicalId);
    assert.equal(continued.logicalKind, 'task', 'a continuation inherits the recorded kind');
});

test('continuation of a session or flow logical is invalid_request', (t) => {
    const { dir, store, robotId } = setup(t);
    const alice = ownerRow('alice');
    const turn = admitTurn(store, robotId, alice, 'conv-cont');
    finish(store, turn, 'queued');
    const before = counts(dir);
    expectCode(assert, () => store.admit(alice, admitRequest(robotId, { kind: 'continuation', logical: { logicalId: turn.logicalId } }, alice)), 'invalid_request');
    // Another user naming the session logical learns nothing: not_found.
    const bob = ownerRow('bob');
    expectCode(assert, () => store.admit(bob, admitRequest(robotId, { kind: 'continuation', logical: { logicalId: turn.logicalId } }, bob)), 'not_found');
    // Flow: a derived logical ID that passes the request grammar, so the recorded kind decides.
    const flowId = grammaticalFlowId();
    registerRoot(store, 'alice', flowId);
    const background = bindingRow(flowId, 'user:alice');
    const phase = store.admit(background, admitRequest(robotId, {}, background));
    assert.equal(phase.logicalKind, 'flow');
    assert.ok(isInternalId(phase.logicalId), 'precondition: the flow logical ID passes the internal-ID grammar');
    finish(store, phase, 'queued');
    expectCode(assert, () => store.admit(background, admitRequest(robotId, { kind: 'continuation', logical: { logicalId: phase.logicalId } }, background)), 'invalid_request');
    // From another row the flow logical is foreign: not_found.
    expectCode(assert, () => store.admit(alice, admitRequest(robotId, { kind: 'continuation', logical: { logicalId: phase.logicalId } }, alice)), 'not_found');
    assert.deepEqual(counts(dir), { ...before, receipt: before.receipt + 2, admission: before.admission + 1, origin: before.origin + 1, reference: before.reference + 1 });
});

test('background-row admission records logical kind flow; coordinator task records task; turn records session', (t) => {
    const { dir, store, robotId } = setup(t);
    const alice = ownerRow('alice');
    const flowId = 'flow_0123456789abcdef01234567';
    registerRoot(store, 'alice', flowId);
    const background = bindingRow(flowId, 'user:alice');
    const phase = store.admit(background, admitRequest(robotId, {}, background));
    const task = store.admit(alice, admitRequest(robotId, {}, alice));
    const turn = admitTurn(store, robotId, alice, 'conv-kinds');
    const mcp = mcpRow('alice');
    const mcpTask = store.admit(mcp, admitRequest(robotId, {}, mcp));
    const observed = (context, admitted) => store.observeReference(context, { referenceId: admitted.reference.id });
    assert.deepEqual([observed(background, phase).logicalKind, observed(background, phase).bindingId], ['flow', flowId]);
    assert.deepEqual([observed(alice, task).logicalKind, observed(alice, task).bindingId], ['task', null]);
    assert.deepEqual([observed(alice, turn).logicalKind, observed(alice, turn).bindingId], ['session', null]);
    assert.equal(observed(mcp, mcpTask).logicalKind, 'task');
    assert.deepEqual([phase.logicalKind, task.logicalKind, turn.logicalKind, mcpTask.logicalKind], ['flow', 'task', 'session', 'task']);
    assert.equal(admissionRow(dir, phase.executionId).logical_kind, 'flow');
    assert.equal(admissionRow(dir, task.executionId).logical_kind, 'task');
    assert.equal(admissionRow(dir, turn.executionId).logical_kind, 'session');
    assert.equal(phase.logicalId, deriveFlowLogicalId(COORDINATOR, flowId));
});

test('a turn specification with path, context, token or workspace at depth 2 is invalid_request', (t) => {
    const { dir, store, robotId } = setup(t);
    const alice = ownerRow('alice');
    const before = counts(dir);
    for (const key of ['path', 'context', 'token', 'workspace']) {
        // Depth 2 inside an allowed field, and as an extra nested object.
        for (const specification of [
            { version: 1, prompt: 'x', model: { [key]: 'v' } },
            { version: 1, prompt: 'x', options: { [key]: 'v' } },
            { version: 1, prompt: 'x', [key]: { nested: 'v' } }
        ]) {
            expectCode(assert, () => admitTurn(store, robotId, alice, 'conv-auth', { specification }), 'invalid_request');
        }
    }
    assert.deepEqual(counts(dir), before);
});

test('turn on the MCP and background rows is refused before state access with zero rows', (t) => {
    const { dir, store, robotId } = setup(t);
    const flowId = 'flow_00000000000000000000aaaa';
    registerRoot(store, 'alice', flowId);
    const before = counts(dir);
    for (const context of [mcpRow('alice'), bindingRow(flowId, 'user:alice')]) {
        expectCode(assert, () => admitTurn(store, robotId, context, 'conv-row'), 'invalid_request');
        // An unknown robot would be not_found at the first state read: invalid_request proves
        // the refusal happens before any state access.
        expectCode(assert, () => admitTurn(store, newId(), context, 'conv-row'), 'invalid_request');
    }
    assert.deepEqual(counts(dir), before);
    // The same body on the coordinator-API row is admitted.
    assert.equal(admitTurn(store, robotId, ownerRow('alice'), 'conv-row').logicalKind, 'session');
});

test('default runtime turn is runtime_unavailable with zero admission, origin, reference and session rows', (t) => {
    const dir = makeTempDir(t);
    const seeded = openStore(dir, { limits: EXTENDED });
    const robotId = readyRobot(seeded, syntheticContext({ robotOwnerId: ROBOTS, scope: 'scope-robots' }));
    seeded.close();
    const before = counts(dir);
    const store = openStore(dir, { limits: EXTENDED, create: false, runtime: runtimeUnavailable });
    t.after(() => store.close());
    expectCode(assert, () => admitTurn(store, robotId, ownerRow('alice'), 'conv-default'), 'runtime_unavailable');
    assert.deepEqual(counts(dir), before);
    assert.deepEqual(counts(dir, ['admission', 'origin', 'reference', 'session']), { admission: 0, origin: 0, reference: 0, session: 0 });
});

// ---- Further Part A cases ---------------------------------------------------------------

test('FIFO applies only to sessions: two task admissions and two flow phases under one binding both reach running', (t) => {
    const { store, robotId } = setup(t);
    const alice = ownerRow('alice');
    const taskA = store.admit(alice, admitRequest(robotId, {}, alice));
    const taskB = store.admit(alice, admitRequest(robotId, {}, alice));
    assert.equal(start(store, taskA).state, 'running');
    assert.equal(start(store, taskB).state, 'running');
    const flowId = 'flow_00000000000000000000bbbb';
    registerRoot(store, 'alice', flowId);
    const background = bindingRow(flowId, 'user:alice');
    const phaseA = store.admit(background, admitRequest(robotId, {}, background));
    const phaseB = store.admit(background, admitRequest(robotId, {}, background));
    assert.equal(phaseA.logicalId, phaseB.logicalId, 'phases share the flow logical ID');
    assert.equal(start(store, phaseA).state, 'running');
    assert.equal(start(store, phaseB).state, 'running', 'no phase serialization');
});

test('turns start first in, first out: a queued or stopping earlier turn holds a later one; cancelling it releases the next', (t) => {
    const { store, robotId } = setup(t);
    const alice = ownerRow('alice');
    const first = admitTurn(store, robotId, alice, 'conv-order');
    const second = admitTurn(store, robotId, alice, 'conv-order');
    const third = admitTurn(store, robotId, alice, 'conv-order');
    // The first, still queued, holds the second; the second holds the third.
    expectCode(assert, () => start(store, second), 'robot_busy');
    expectCode(assert, () => start(store, third), 'robot_busy');
    // A queued stop cancels the first in its transaction.
    store.controlReference(alice, { referenceId: first.reference.id, operationId: newId(), op: 'stop' });
    expectCode(assert, () => start(store, third), 'robot_busy');
    assert.equal(start(store, second).state, 'running');
    // A stopping attempt (unsettled blocker) still holds the next turn.
    const blocker = store.reserveResource({ kind: 'synthetic-dir', locator: { dir: `synthetic/${newId()}` }, executionId: second.executionId, attemptId: second.attemptId });
    assert.equal(finish(store, second).state, 'stopping');
    expectCode(assert, () => start(store, third), 'robot_busy');
    store.releaseResource({ resourceId: blocker.resourceId, generationId: store.generationId });
    assert.equal(start(store, third).state, 'running');
});

test('flow logical identity: phases under one binding share the derived logical ID; the same flow ID under another coordinator derives another', (t) => {
    const { store, robotId } = setup(t, { limits: { ...EXTENDED, controls: 16 } });
    const flowId = 'flow_0000000000000000000000cc';
    registerRoot(store, 'alice', flowId, COORDINATOR);
    registerRoot(store, 'alice', flowId, OTHER_COORDINATOR);
    const mine = bindingRow(flowId, 'user:alice', COORDINATOR);
    const theirs = bindingRow(flowId, 'user:alice', OTHER_COORDINATOR);
    const first = store.admit(mine, admitRequest(robotId, {}, mine));
    const second = store.admit(mine, admitRequest(robotId, {}, mine));
    const other = store.admit(theirs, admitRequest(robotId, {}, theirs));
    assert.equal(first.logicalId, second.logicalId);
    assert.equal(first.logicalId, deriveFlowLogicalId(COORDINATOR, flowId));
    assert.notEqual(other.logicalId, first.logicalId);
    assert.equal(other.logicalId, deriveFlowLogicalId(OTHER_COORDINATOR, flowId));
    assert.equal(store.observeReference(mine, { referenceId: second.reference.id }).bindingId, flowId);
    assert.equal(store.observeReference(theirs, { referenceId: other.reference.id }).bindingId, flowId);
    // The second phase links the first (same logical); the other coordinator's does not.
    assert.equal(store.observeReference(mine, { referenceId: second.reference.id }).previousReference.id, first.reference.id);
    assert.equal(store.observeReference(theirs, { referenceId: other.reference.id }).previousReference, null);
});

test('background-row admission under a schedule binding is invalid_request (binding_kind) with zero rows', (t) => {
    const { dir, store, robotId } = setup(t);
    const scheduleId = 'cron_0123456789abcdef01234567.r1';
    registerRoot(store, 'alice', scheduleId, COORDINATOR, 'schedule');
    const background = bindingRow(scheduleId, 'user:alice');
    const before = counts(dir);
    assert.throws(() => store.admit(background, admitRequest(robotId, {}, background)), (error) => {
        assert.equal(error.name, 'WorkerStateError');
        assert.equal(error.code, 'invalid_request');
        assert.equal(error.reason, 'binding_kind');
        return true;
    });
    assert.deepEqual(counts(dir), before);
    // An unregistered binding is still not_found, before the kind is consulted.
    const unknown = bindingRow('cron_0000000000000000000000ff.r1', 'user:alice');
    expectCode(assert, () => store.admit(unknown, admitRequest(robotId, {}, unknown)), 'not_found');
});

test('a generation binding admits flow work under its own gen_ ID (binding created by an accepted generation obligation)', (t) => {
    const { store, robotId } = setup(t, { limits: S6_LIMITS });
    const genId = `gen_${'0'.repeat(20)}abcd`;
    const alice = ownerRow('alice');
    const originRequestId = newOriginId();
    const obligation = store.admitObligation(alice, {
        operationId: deriveOperationId(alice, originRequestId), originRequestId, obligationKind: 'generation', request: { ticket: 'synthetic' }
    });
    const decider = createVerifiedCoordinatorContext({ workspaceId: WORKSPACE, scope: 'scope-obligations', coordinator: COORDINATOR, operations: ['decide'] });
    assert.equal(store.acceptObligation(decider, { operationId: newId(), obligationId: obligation.obligationId, domainRecordId: genId }).decision, 'accepted');
    const background = bindingRow(genId, 'user:alice');
    const admitted = store.admit(background, admitRequest(robotId, {}, background));
    assert.equal(admitted.logicalKind, 'flow');
    assert.equal(admitted.logicalId, deriveFlowLogicalId(COORDINATOR, genId));
    assert.equal(store.observeReference(background, { referenceId: admitted.reference.id }).bindingId, genId);
    // registerBinding never creates a generation binding (S1 defense in depth), whatever kind is claimed.
    expectCode(assert, () => store.registerBinding(ownerRow('alice'), { operationId: newId(), bindingId: `gen_${'1'.repeat(24)}`, kind: 'generation' }), 'invalid_request');
    expectCode(assert, () => store.registerBinding(ownerRow('alice'), { operationId: newId(), bindingId: `gen_${'1'.repeat(24)}`, kind: 'flow' }), 'invalid_request');
});

test('R1: a turn specification within the code-point bounds but over requestBytes is invalid_request with zero rows', (t) => {
    const { dir, store, robotId } = setup(t);
    const alice = ownerRow('alice');
    const before = counts(dir);
    // 2000 code points of a 4-byte character: under 32768 code points, over the 4096-byte requestBytes.
    const prompt = '\u{1F600}'.repeat(2000);
    expectCode(assert, () => admitTurn(store, robotId, alice, 'conv-bytes', { specification: { version: 1, prompt } }), 'invalid_request');
    assert.deepEqual(counts(dir), before);
    assert.equal(succeeds(() => admitTurn(store, robotId, alice, 'conv-bytes', { specification: { version: 1, prompt: '\u{1F600}'.repeat(500) } }),
        'the same prompt within requestBytes is admitted').logicalKind, 'session');
});

test('logical_kind is CHECK-constrained and immutable; a turn admission records session and nothing else', (t) => {
    const { dir, store, robotId } = setup(t);
    const alice = ownerRow('alice');
    const task = store.admit(alice, admitRequest(robotId, {}, alice));
    const turn = admitTurn(store, robotId, alice, 'conv-immutable');
    const db = rawDb(dir);
    try {
        for (const kind of ['session', 'flow', 'task']) {
            const target = kind === 'task' ? turn : task;
            assert.throws(() => db.prepare('UPDATE admission SET logical_kind = ? WHERE execution_id = ?').run(kind, target.executionId), /immutable/u);
        }
        // Together with an otherwise valid queued->running transition, so only the immutability
        // trigger can refuse it (the transition trigger allows the state change).
        assert.throws(() => db.prepare("UPDATE admission SET logical_kind = 'flow', state = 'running' WHERE execution_id = ?").run(task.executionId),
            /immutable/u, 'logical_kind is immutable across a state transition');
        assert.equal(db.prepare('SELECT state FROM admission WHERE execution_id = ?').get(task.executionId).state, 'queued');
        db.prepare("UPDATE admission SET state = 'running' WHERE execution_id = ?").run(task.executionId);
        assert.throws(() => db.prepare("UPDATE admission SET logical_kind = 'other' WHERE execution_id = ?").run(task.executionId));
        // A raw admission with an unknown kind, or a turn that is not session work, violates a CHECK.
        const columns = db.prepare('SELECT * FROM admission WHERE execution_id = ?').get(task.executionId);
        const insert = (overrides) => {
            const row = { ...columns, execution_id: newId(), attempt_id: newId(), ...overrides };
            const keys = Object.keys(row);
            db.prepare(`INSERT INTO admission (${keys.join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`).run(...keys.map((key) => row[key]));
        };
        assert.throws(() => insert({ logical_kind: 'other' }), /CHECK/u);
        assert.throws(() => insert({ kind: 'turn', logical_kind: 'task' }), /CHECK/u);
        assert.throws(() => insert({ kind: 'task', logical_kind: 'session' }), /CHECK/u);
        assert.throws(() => insert({ kind: 'unknown' }), /CHECK/u);
    } finally {
        db.close();
    }
    assert.deepEqual([admissionRow(dir, task.executionId).logical_kind, admissionRow(dir, task.executionId).state], ['task', 'running']);
    assert.equal(admissionRow(dir, turn.executionId).logical_kind, 'session');
});

test('v5 schema: a reference or origin holds exactly one of an execution or an obligation; binding fences are constrained', (t) => {
    const { dir, store, robotId } = setup(t);
    const alice = ownerRow('alice');
    const task = store.admit(alice, admitRequest(robotId, {}, alice));
    registerRoot(store, 'alice', 'flow_0000000000000000000000dd');
    const db = rawDb(dir);
    try {
        const reference = db.prepare('SELECT * FROM reference WHERE id = ?').get(task.reference.id);
        assert.equal(reference.kind, 'execution');
        assert.equal(reference.obligation_id, null);
        const insertReference = (overrides) => {
            const row = { ...reference, id: newId(), attempt_id: newId(), ...overrides };
            const keys = Object.keys(row);
            db.prepare(`INSERT INTO reference (${keys.join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`).run(...keys.map((key) => row[key]));
        };
        // Observation without an obligation; execution without its attempt or logical ID; both null.
        assert.throws(() => insertReference({ kind: 'observation', execution_id: null, attempt_id: null, logical_id: null }), /CHECK/u);
        assert.throws(() => insertReference({ attempt_id: null }), /CHECK/u);
        assert.throws(() => insertReference({ logical_id: null }), /CHECK/u);
        assert.throws(() => insertReference({ kind: 'other' }), /CHECK/u);
        const origin = db.prepare('SELECT * FROM origin WHERE reference_id = ?').get(task.reference.id);
        assert.equal(origin.obligation_id, null);
        const insertOrigin = (overrides) => {
            const row = { ...origin, origin_id: newOriginId(), reference_id: newId(), ...overrides };
            const keys = Object.keys(row);
            db.prepare(`INSERT INTO origin (${keys.join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`).run(...keys.map((key) => row[key]));
        };
        assert.throws(() => insertOrigin({ execution_id: null }), /CHECK/u);
        // Binding fences: only active->paused|cancelled and paused->active|cancelled, each with
        // fence_revision + 1; cancelled is final; a derived binding is never fenced.
        const bindingId = 'flow_0000000000000000000000dd';
        const fence = (state, revision) => db.prepare('UPDATE binding SET state = ?, fence_revision = ? WHERE binding_id = ?').run(state, revision, bindingId);
        assert.throws(() => fence('paused', 0), /immutable/u, 'a fence without a revision increment');
        assert.throws(() => fence('paused', 2), /immutable/u, 'a revision jump');
        fence('paused', 1);
        fence('active', 2);
        fence('cancelled', 3);
        assert.throws(() => fence('active', 4), /immutable/u, 'cancelled is final');
        assert.throws(() => db.prepare('UPDATE binding SET fence_revision = 2 WHERE binding_id = ?').run(bindingId), /immutable/u, 'never decreases');
        // A generation binding must come from an obligation; an obligation binding is a root flow or generation.
        const binding = db.prepare('SELECT * FROM binding WHERE binding_id = ?').get(bindingId);
        const insertBindingRow = (overrides) => {
            const row = { ...binding, binding_id: `flow_${newId().slice(0, 4)}`, state: 'active', fence_revision: 0, ...overrides };
            row.root_binding_id = overrides.root_binding_id ?? row.binding_id;
            const keys = Object.keys(row);
            db.prepare(`INSERT INTO binding (${keys.join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`).run(...keys.map((key) => row[key]));
        };
        assert.throws(() => insertBindingRow({ kind: 'generation', evidence: 'owner-grant' }), /CHECK/u);
        assert.throws(() => insertBindingRow({ kind: 'schedule', evidence: 'obligation' }), /CHECK/u);
        assert.throws(() => insertBindingRow({ state: 'paused', depth: 1, parent_binding_id: bindingId, root_binding_id: bindingId, evidence: 'derived' }), /CHECK/u);
        insertBindingRow({ kind: 'generation', evidence: 'obligation', binding_id: `gen_${'2'.repeat(24)}` });
        // The obligation and outbox tables exist, are empty and refuse a pending row without its deadline.
        assert.equal(db.prepare('SELECT COUNT(*) AS c FROM obligation').get().c, 0);
        assert.equal(db.prepare('SELECT COUNT(*) AS c FROM outbox_revision').get().c, 0);
        assert.throws(() => db.prepare("INSERT INTO obligation (obligation_id, coordinator, obligation_kind, scope, owner_id, operation_id, request, state, bound, last_revision, generation_id, created_at, updated_at) VALUES ('o', 'c', 'flow-launch', 's', 'u', 'op', '{}', 'pending', 0, 0, ?, 0, 0)").run(store.generationId), /NOT NULL/u);
    } finally {
        db.close();
    }
});

// ---- Adversarial probes -------------------------------------------------------------------

test('sessionKey boundaries: 1 and 128 characters admit; 0, 129, unicode and separators outside the grammar refuse', (t) => {
    const { dir, store, robotId } = setup(t, { limits: { ...EXTENDED, admissions: 64, receipts: 128 } });
    const alice = ownerRow('alice');
    for (const key of ['a', 'k'.repeat(128), '..', 'a.b:c_d-e', 'Z9']) {
        assert.equal(admitTurn(store, robotId, alice, key).logicalKind, 'session', `key ${key.slice(0, 10)}`);
    }
    const before = counts(dir);
    for (const key of ['', 'k'.repeat(129), 'convé', 'a/b', 'a b', 'a\nb', 7, null]) {
        expectCode(assert, () => admitTurn(store, robotId, alice, key), 'invalid_request');
    }
    expectCode(assert, () => store.admit(alice, turnRequest(robotId, alice, 'x', { logical: { sessionKey: 'x', logicalId: newId() } })), 'invalid_request');
    expectCode(assert, () => store.admit(alice, turnRequest(robotId, alice, 'x', { logical: {} })), 'invalid_request');
    assert.deepEqual(counts(dir), before);
});

test('turn specification grammar: prompt 1-32768 code points, model and effort 1-128, a relative cwd without ..', (t) => {
    const { dir, store, robotId } = setup(t, { limits: { ...EXTENDED, requestBytes: 200000, admissions: 64, receipts: 128 } });
    const alice = ownerRow('alice');
    const ok = (specification) => assert.equal(admitTurn(store, robotId, alice, 'conv-spec', { specification }).logicalKind, 'session');
    const bad = (specification) => expectCode(assert, () => admitTurn(store, robotId, alice, 'conv-spec', { specification }), 'invalid_request');
    ok({ version: 1, prompt: 'p'.repeat(32768) });
    ok({ version: 1, prompt: '\u{1F600}'.repeat(32768) });
    ok({ version: 1, prompt: 'x', model: 'm'.repeat(128), effort: 'e', cwd: 'a/b/c.d' });
    ok({ version: 1, prompt: 'x', cwd: 'c'.repeat(4096) });
    const before = counts(dir);
    bad({ version: 1, prompt: 'p'.repeat(32769) });
    bad({ version: 1, prompt: '' });
    bad({ version: 2, prompt: 'x' });
    bad({ prompt: 'x' });
    bad({ version: 1 });
    bad({ version: 1, prompt: 'x', model: '' });
    bad({ version: 1, prompt: 'x', effort: 'e'.repeat(129) });
    bad({ version: 1, prompt: 'x', cwd: '/abs' });
    bad({ version: 1, prompt: 'x', cwd: 'a/../b' });
    bad({ version: 1, prompt: 'x', cwd: '..' });
    bad({ version: 1, prompt: 'x', cwd: '' });
    bad({ version: 1, prompt: 'x', cwd: 'c'.repeat(4097) });
    bad({ version: 1, prompt: 'x', attachments: [] });
    bad({ version: 1, prompt: 7 });
    assert.deepEqual(counts(dir), before);
});

test('turn admission replays: an identical retry returns the recorded admission; a changed body with the same origin conflicts', (t) => {
    const { dir, store, robotId } = setup(t);
    const alice = ownerRow('alice');
    const request = turnRequest(robotId, alice, 'conv-replay');
    const first = store.admit(alice, request);
    const before = counts(dir);
    assert.deepEqual(store.admit(alice, { ...request }), first);
    assert.deepEqual(counts(dir), before, 'no new receipt or row');
    expectCode(assert, () => store.admit(alice, { ...request, specification: { version: 1, prompt: 'changed' } }), 'operation_conflict');
    expectCode(assert, () => store.admit(alice, { ...request, logical: { sessionKey: 'conv-other' } }), 'operation_conflict');
    assert.deepEqual(counts(dir), before);
    // Lookup returns the recorded admission state, never live state.
    start(store, first);
    const looked = store.lookupOrigin(alice, { originRequestId: request.originRequestId });
    assert.deepEqual([looked.admissionState, looked.state], ['queued', 'running']);
});

test('a turn joining a deleted robot session is not_found; an unknown robot is not_found', (t) => {
    const { dir, store, robotId } = setup(t);
    const robots = syntheticContext({ robotOwnerId: ROBOTS, scope: 'scope-robots' });
    const alice = ownerRow('alice');
    const turn = admitTurn(store, robotId, alice, 'conv-deleted');
    finish(store, turn, 'queued');
    const operationId = newId();
    store.beginDelete(robots, { operationId, robotId, expectedRevision: 1 });
    store.completeDelete(robots, { operationId });
    const before = counts(dir);
    expectCode(assert, () => admitTurn(store, robotId, alice, 'conv-deleted'), 'not_found');
    expectCode(assert, () => admitTurn(store, newId(), alice, 'conv-fresh'), 'not_found');
    assert.deepEqual(counts(dir), before);
});

test('pause is refused after visibility: a caller who cannot see the reference gets not_found', (t) => {
    const { store, robotId } = setup(t);
    const alice = ownerRow('alice');
    const turn = admitTurn(store, robotId, alice, 'conv-pause');
    const pause = { referenceId: turn.reference.id, operationId: newId(), op: 'pause' };
    expectCode(assert, () => store.controlReference(ownerRow('bob'), pause), 'not_found');
    expectCode(assert, () => store.controlReference(alice, pause), 'invalid_request');
});

test('a fault before commit of a first turn leaves no session row; the retry creates exactly one', (t) => {
    const dir = makeTempDir(t);
    let armed = true;
    const store = openStore(dir, {
        limits: EXTENDED,
        faults: { beforeCommit: (label) => { if (armed && label === 'admit') throw new Error('synthetic fault'); } }
    });
    t.after(() => store.close());
    const robotId = readyRobot(store, syntheticContext({ robotOwnerId: ROBOTS, scope: 'scope-robots' }));
    const alice = ownerRow('alice');
    const request = turnRequest(robotId, alice, 'conv-fault');
    expectCode(assert, () => store.admit(alice, request), 'state_corrupt');
    assert.deepEqual(counts(dir), { receipt: 1, admission: 0, origin: 0, reference: 0, session: 0 });
    armed = false;
    assert.equal(store.admit(alice, request).logicalKind, 'session');
    assert.equal(sessions(dir).length, 1);
});

test('two processes admitting the first turns of one sessionKey create exactly one session row', async (t) => {
    const dir = makeTempDir(t);
    const seeded = openStore(dir);
    const robotId = readyRobot(seeded, syntheticContext({ robotOwnerId: ROBOTS, scope: 'scope-robots' }));
    seeded.close();
    const fields = {
        workspaceId: WORKSPACE, scope: `scope-${COORDINATOR}-alice`, ownerId: 'user:alice', operations: [...OPERATIONS],
        originNamespace: `coordinator:${COORDINATOR}`, originKey: 'owner:user:alice', robotOwnerId: ROBOTS
    };
    const specs = [newOriginId(), newOriginId(), newOriginId()].map((originRequestId) => ({
        dir, method: 'admit', context: fields,
        request: {
            operationId: deriveOperationId({ originNamespace: fields.originNamespace, originKey: fields.originKey }, originRequestId),
            originRequestId, robotId, configRevision: 1, kind: 'turn', logical: { sessionKey: 'conv-race' },
            specification: { version: 1, prompt: 'synthetic turn' }
        }
    }));
    const results = await raceChildren(specs);
    for (const result of results) assert.equal(result.output?.ok, true, JSON.stringify(result.output));
    const logicalIds = new Set(results.map((result) => result.output.result.logicalId));
    assert.equal(logicalIds.size, 1, 'every turn joined one session');
    assert.equal(sessions(dir).length, 1);
    assert.equal(count(dir, 'admission'), 3);
});
