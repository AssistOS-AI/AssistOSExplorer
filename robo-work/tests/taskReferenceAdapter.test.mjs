import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {
    COORDINATOR_ADMISSION_TOOL, TASK_REFERENCE_ORIGIN_TOOL, TASK_REFERENCE_TOOL, computeOriginRch, computeRchHttp,
    createReplayCache, createVerifierConfig, rawBodyHash, scopeFor
} from '../server/coordinatorAuth.mjs';
import { createCoordinatorAdapter } from '../server/coordinatorAdapter.mjs';
import { createTaskReferenceAdapter, projectAcceptance, projectSnapshot } from '../server/taskReferenceAdapter.mjs';
import { LIMITS, WORKSPACE, count, locatorFor, makeTempDir, newId, newOriginId, openStore, rawDb, readyRobot, syntheticContext } from './helpers/synthetic.mjs';

// Generic task-reference read, events, control and lookup over the actual S1/S1x store,
// with real HS256 tokens under generated keys. Admissions use the explicitly SYNTHETIC
// runtime of tests/helpers/synthetic.mjs (state/adapter evidence only).

const PROVIDER_PRINCIPAL = 'agent:RoboRepo/robo-work';
const COORDINATOR = 'agent:RoboRepo/roboTeamAgent';
const CALLER_AGENT = 'agent:RoboRepo/researchAgent';
const BASE = '/v1/task-refs';
const EXTENDED = Object.freeze({ ...LIMITS, bindings: 8, controls: 16, tokenReplayEntries: 256, obligations: 16, outboxRevisions: 16, obligationAcceptMs: 10000 });
const ROBOTS = `workspace:${WORKSPACE}`;
const ADAPTER = () => syntheticContext({ scope: 'scope-adapter' });

function b64json(value) {
    return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

function sign(payload, secret) {
    const input = `${b64json({ alg: 'HS256', typ: 'JWT' })}.${b64json(payload)}`;
    return `${input}.${crypto.createHmac('sha256', secret).update(input).digest('base64url')}`;
}

function seconds() {
    return Math.floor(Date.now() / 1000);
}

function verifierFor(secret) {
    return createVerifierConfig({ secret, audience: PROVIDER_PRINCIPAL, coordinators: [COORDINATOR], replayCache: createReplayCache() });
}

function rig(t) {
    const dir = makeTempDir(t);
    const store = openStore(dir, { limits: EXTENDED });
    t.after(() => store.close());
    const secret = crypto.randomBytes(32);
    const verifier = verifierFor(secret);
    const robotId = readyRobot(store, syntheticContext({ robotOwnerId: ROBOTS, scope: 'scope-robots' }));
    return {
        dir, store, secret, robotId,
        coordinator: createCoordinatorAdapter({ store, workspaceId: WORKSPACE, verifier }),
        refs: createTaskReferenceAdapter({ store, workspaceId: WORKSPACE, verifier, basePath: BASE }),
        freshRefs: () => createTaskReferenceAdapter({ store, workspaceId: WORKSPACE, verifier: verifierFor(secret), basePath: BASE })
    };
}

function signedRequest(secret, { method, path, query = '', body = Buffer.alloc(0), tool, claims, signQuery }) {
    const iat = seconds();
    const payload = {
        typ: 'router-request', iss: 'ploinky-router', aud: PROVIDER_PRINCIPAL, method, path, tool,
        rch: computeRchHttp({ method, path, query: signQuery ?? query, bodyHash: rawBodyHash(body) }),
        jti: crypto.randomBytes(16).toString('base64url'), iat, exp: iat + 30, ...claims
    };
    for (const key of Object.keys(payload)) if (payload[key] === undefined) delete payload[key];
    return { authInfo: JSON.stringify({ invocationToken: sign(payload, secret) }), method, path, query, body };
}

function userClaims(id, roles = ['user']) {
    return { sub: `user:${id}`, actor: { kind: 'user', id: `user:${id}`, roles } };
}

function agentClaims(principal, extra = {}) {
    return { sub: principal, actor: { kind: 'agent', id: principal, roles: [] }, caller: { kind: 'agent', id: principal, roles: ['agent'] }, ...extra };
}

function readRequest(secret, referenceId, claims, overrides = {}) {
    return signedRequest(secret, { method: 'GET', path: `${BASE}/${referenceId}`, tool: TASK_REFERENCE_TOOL, claims, ...overrides });
}

function eventsRequest(secret, referenceId, claims, query = '', overrides = {}) {
    return signedRequest(secret, { method: 'GET', path: `${BASE}/${referenceId}/events`, query, tool: TASK_REFERENCE_TOOL, claims, ...overrides });
}

function controlRequest(secret, referenceId, bodyValue, claims, overrides = {}) {
    return signedRequest(secret, {
        method: 'POST', path: `${BASE}/${referenceId}/control`, body: Buffer.from(JSON.stringify(bodyValue)), tool: TASK_REFERENCE_TOOL, claims, ...overrides
    });
}

function lookupRequest(secret, originRequestId, claims) {
    return signedRequest(secret, {
        method: 'POST', path: `${BASE}/lookup`, body: Buffer.from(JSON.stringify({ originRequestId })), tool: TASK_REFERENCE_TOOL, claims
    });
}

// MCP-row admission through the coordinator adapter for the direct caller `originKey`.
function admitMcp(secret, coordinator, robotId, originKey, extra = {}) {
    const originRequestId = newOriginId();
    const iat = seconds();
    const origin = { originKey, originRequestId, agent: COORDINATOR, tool: 'runRobotTask' };
    const taskRefOrigin = sign({
        typ: 'router-request', iss: 'ploinky-router', aud: PROVIDER_PRINCIPAL, sub: originKey, method: 'ORIGIN', path: '/origin',
        tool: TASK_REFERENCE_ORIGIN_TOOL, rch: computeOriginRch(origin), origin,
        jti: crypto.randomBytes(16).toString('base64url'), iat, exp: iat + 30
    }, secret);
    const body = { originRequestId, robotId, configRevision: 1, kind: 'task', specification: { prompt: 'synthetic' }, taskRefOrigin, originTool: 'runRobotTask', ...extra };
    const request = signedRequest(secret, {
        method: 'POST', path: '/v1/coordinator/admissions', body: Buffer.from(JSON.stringify(body)), tool: COORDINATOR_ADMISSION_TOOL, claims: agentClaims(COORDINATOR)
    });
    return { originRequestId, admitted: coordinator.admit(request) };
}

function attemptOf(dir, referenceId) {
    const db = rawDb(dir, { readOnly: true });
    try {
        return db.prepare('SELECT execution_id AS executionId, attempt_id AS attemptId FROM reference WHERE id = ?').get(referenceId);
    } finally {
        db.close();
    }
}

function expectError(fn, name, code, reason) {
    assert.throws(fn, (error) => {
        assert.equal(error.name, name);
        assert.equal(error.code, code);
        if (reason !== undefined) assert.equal(error.reason, reason);
        return true;
    });
}

function captureError(fn) {
    try {
        fn();
    } catch (error) {
        return [error.name, error.code, error.message];
    }
    return assert.fail('expected an error');
}

test('snapshot key sets for queued, running, stopping and terminal', (t) => {
    const { dir, store, secret, robotId, coordinator, refs } = rig(t);
    const { admitted, originRequestId } = admitMcp(secret, coordinator, robotId, 'user:alice');
    const id = admitted.taskRef.id;
    const read = () => refs.read(readRequest(secret, id, userClaims('alice')));
    const queued = read();
    assert.deepEqual(Object.keys(queued), ['taskRef', 'originRequestId', 'kind', 'state', 'attempt', 'logical', 'sequence']);
    assert.deepEqual(queued.taskRef, admitted.taskRef);
    assert.deepEqual(Object.keys(queued.taskRef), ['version', 'provider', 'id']);
    assert.equal(queued.originRequestId, originRequestId);
    assert.equal(queued.kind, 'execution');
    assert.deepEqual(queued.logical.kind, 'task');
    assert.deepEqual(Object.keys(queued.logical), ['kind', 'id']);
    assert.deepEqual(Object.keys(queued.attempt), ['attemptId', 'state']);
    assert.equal(queued.sequence, 1);
    const { executionId, attemptId } = attemptOf(dir, id);
    store.transitionAttempt({ executionId, attemptId, expectedState: 'queued', nextState: 'running' });
    const running = read();
    assert.deepEqual(Object.keys(running), ['taskRef', 'originRequestId', 'kind', 'state', 'attempt', 'logical', 'sequence']);
    assert.equal(running.state, 'running');
    assert.equal(running.sequence, 2);
    const { resourceId } = store.reserveResource({ kind: 'workdir', locator: locatorFor('workdir'), executionId, attemptId });
    store.beginAttemptEnd(ADAPTER(), { executionId, attemptId, expectedState: 'running', outcome: { classification: 'completed', outputText: 'done', data: { n: 1 } } });
    const stopping = read();
    assert.deepEqual(Object.keys(stopping), ['taskRef', 'originRequestId', 'kind', 'state', 'attempt', 'logical', 'sequence', 'cleanup']);
    assert.deepEqual(Object.keys(stopping.attempt), ['attemptId', 'state']);
    assert.equal(stopping.cleanup, 'pending');
    store.releaseResource({ resourceId, generationId: store.generationId });
    const terminal = read();
    assert.deepEqual(Object.keys(terminal), ['taskRef', 'originRequestId', 'kind', 'state', 'attempt', 'logical', 'sequence', 'result', 'cleanup']);
    assert.deepEqual(terminal.attempt, { attemptId, state: 'completed', endedReason: 'completed' });
    assert.deepEqual(terminal.result, { status: 'completed', outputText: 'done', data: { n: 1 } });
    assert.equal(terminal.cleanup, 'released');
    assert.equal(terminal.sequence, 4);
});

test('continuation snapshot links previousTaskRef; termination_unverified keeps its classification', (t) => {
    const { dir, store, secret, robotId, coordinator, refs } = rig(t);
    const { admitted } = admitMcp(secret, coordinator, robotId, 'user:alice');
    const first = attemptOf(dir, admitted.taskRef.id);
    store.beginAttemptEnd(ADAPTER(), { ...first, expectedState: 'queued', outcome: { classification: 'paused' } });
    const logicalId = refs.read(readRequest(secret, admitted.taskRef.id, userClaims('alice'))).logical.id;
    const { admitted: continued } = admitMcp(secret, coordinator, robotId, 'user:alice', { kind: 'continuation', logical: { logicalId } });
    const snapshot = refs.read(readRequest(secret, continued.taskRef.id, userClaims('alice')));
    assert.deepEqual(snapshot.linked, { previousTaskRef: admitted.taskRef });
    assert.equal(snapshot.logical.id, logicalId);
    const { admitted: tree } = admitMcp(secret, coordinator, robotId, 'user:alice');
    const attempt = attemptOf(dir, tree.taskRef.id);
    const { resourceId } = store.reserveResource({ kind: 'process-tree', locator: locatorFor('process-tree'), ...attempt, processBearing: true });
    store.beginAttemptEnd(ADAPTER(), { ...attempt, expectedState: 'queued', outcome: { classification: 'completed', outputText: 'out' } });
    store.quarantineResource({ resourceId, generationId: store.generationId });
    const unverified = refs.read(readRequest(secret, tree.taskRef.id, userClaims('alice')));
    assert.equal(unverified.attempt.endedReason, 'termination_unverified');
    assert.deepEqual(unverified.result, { status: 'failed', outputText: 'out', reason: 'termination_unverified', classification: 'completed' });
    assert.equal(unverified.cleanup, 'quarantined');
});

test('another caller and an unknown reference get the same not_found', (t) => {
    const { secret, robotId, coordinator, refs } = rig(t);
    const { admitted } = admitMcp(secret, coordinator, robotId, 'user:alice');
    const unknown = captureError(() => refs.read(readRequest(secret, crypto.randomBytes(16).toString('base64url'), userClaims('alice'))));
    assert.deepEqual(unknown.slice(0, 2), ['WorkerStateError', 'not_found']);
    assert.deepEqual(captureError(() => refs.read(readRequest(secret, admitted.taskRef.id, userClaims('bob')))), unknown);
    assert.deepEqual(captureError(() => refs.read(readRequest(secret, admitted.taskRef.id, agentClaims(CALLER_AGENT)))), unknown);
    assert.deepEqual(captureError(() => refs.events(eventsRequest(secret, admitted.taskRef.id, userClaims('bob')))), unknown);
    assert.deepEqual(captureError(() => refs.control(controlRequest(secret, admitted.taskRef.id, { operationId: newId(), op: 'stop' }, userClaims('bob')))), unknown);
});

test('an administrator user actor reads others; an agent actor or delegated agent never counts as administrator', (t) => {
    const { secret, robotId, coordinator, refs } = rig(t);
    const { admitted } = admitMcp(secret, coordinator, robotId, 'user:alice');
    assert.equal(refs.read(readRequest(secret, admitted.taskRef.id, userClaims('root', [' Admin ']))).taskRef.id, admitted.taskRef.id);
    assert.equal(refs.events(eventsRequest(secret, admitted.taskRef.id, userClaims('root', ['admin']))).events.length, 1);
    expectError(() => refs.read(readRequest(secret, admitted.taskRef.id, userClaims('root', ['admin', 'guest']))), 'CoordinatorAuthError', 'forbidden', 'guest');
    const delegated = agentClaims(CALLER_AGENT, {
        actor: { kind: 'agent', id: CALLER_AGENT, roles: ['admin'] }, usr: { id: 'root', roles: ['admin'] },
        delegation: { jti: 'g', scope: ['execution:owner'], sourceAgentId: CALLER_AGENT }
    });
    expectError(() => refs.read(readRequest(secret, admitted.taskRef.id, delegated)), 'WorkerStateError', 'not_found');
});

test('the same user reads a coordinator-API reference through /task-refs (owner equality across rows)', (t) => {
    const { secret, robotId, coordinator, refs } = rig(t);
    const originRequestId = newOriginId();
    const body = { originRequestId, robotId, configRevision: 1, kind: 'task', specification: { prompt: 'synthetic' } };
    const admitted = coordinator.admit(signedRequest(secret, {
        method: 'POST', path: '/v1/coordinator/admissions', body: Buffer.from(JSON.stringify(body)), tool: COORDINATOR_ADMISSION_TOOL,
        claims: { ...agentClaims(COORDINATOR), usr: { id: 'alice', roles: ['user'] }, delegation: { jti: 'g', scope: ['execution:owner'], sourceAgentId: COORDINATOR } }
    }));
    assert.equal(refs.read(readRequest(secret, admitted.taskRef.id, userClaims('alice'))).taskRef.id, admitted.taskRef.id);
    expectError(() => refs.read(readRequest(secret, admitted.taskRef.id, userClaims('bob'))), 'WorkerStateError', 'not_found');
    // Origin recovery stays per row: the /task-refs lookup recovers only MCP origins.
    expectError(() => refs.lookup(lookupRequest(secret, originRequestId, { ...userClaims('alice'), originKey: 'user:alice' })), 'WorkerStateError', 'not_found');
});

test('lookup: the recorded acceptance byte-for-byte after running and terminal; cross-caller and unsigned originKey refused', (t) => {
    const { dir, store, secret, robotId, coordinator, refs } = rig(t);
    const { admitted, originRequestId } = admitMcp(secret, coordinator, robotId, 'user:alice');
    const lookup = () => JSON.stringify(refs.lookup(lookupRequest(secret, originRequestId, { ...userClaims('alice'), originKey: 'user:alice' })));
    assert.equal(lookup(), JSON.stringify(admitted));
    const attempt = attemptOf(dir, admitted.taskRef.id);
    store.transitionAttempt({ ...attempt, expectedState: 'queued', nextState: 'running' });
    assert.equal(lookup(), JSON.stringify(admitted));
    store.beginAttemptEnd(ADAPTER(), { ...attempt, expectedState: 'running', outcome: { classification: 'failed' } });
    assert.equal(lookup(), JSON.stringify(admitted));
    expectError(() => refs.lookup(lookupRequest(secret, originRequestId, { ...userClaims('bob'), originKey: 'user:bob' })), 'WorkerStateError', 'not_found');
    expectError(() => refs.lookup(lookupRequest(secret, newOriginId(), { ...userClaims('alice'), originKey: 'user:alice' })), 'WorkerStateError', 'not_found');
    expectError(() => refs.lookup(lookupRequest(secret, originRequestId, userClaims('alice'))), 'CoordinatorAuthError', 'forbidden', 'lookup_key');
    expectError(() => refs.lookup(lookupRequest(secret, originRequestId, { ...userClaims('bob'), originKey: 'user:alice' })), 'CoordinatorAuthError', 'forbidden', 'lookup_key');
});

test('an agent caller reads, observes and looks up only its own MCP references', (t) => {
    const { secret, robotId, coordinator, refs } = rig(t);
    const { admitted, originRequestId } = admitMcp(secret, coordinator, robotId, CALLER_AGENT);
    assert.deepEqual(refs.read(readRequest(secret, admitted.taskRef.id, agentClaims(CALLER_AGENT))).taskRef, admitted.taskRef);
    assert.equal(JSON.stringify(refs.lookup(lookupRequest(secret, originRequestId, { ...agentClaims(CALLER_AGENT), originKey: CALLER_AGENT }))), JSON.stringify(admitted));
    expectError(() => refs.lookup(lookupRequest(secret, originRequestId, { ...userClaims('alice'), originKey: 'user:alice' })), 'WorkerStateError', 'not_found');
});

test('events through real __task_ref__ tokens; a changed query or body breaks rch; the query grammar is exact', (t) => {
    const { dir, store, secret, robotId, coordinator, refs } = rig(t);
    const { admitted } = admitMcp(secret, coordinator, robotId, 'user:alice');
    const id = admitted.taskRef.id;
    const attempt = attemptOf(dir, id);
    store.transitionAttempt({ ...attempt, expectedState: 'queued', nextState: 'running' });
    store.beginAttemptEnd(ADAPTER(), { ...attempt, expectedState: 'running', outcome: { classification: 'completed' } });
    const all = refs.events(eventsRequest(secret, id, userClaims('alice')));
    assert.deepEqual(all.events.map((event) => event.data.state), ['queued', 'running', 'stopping', 'completed']);
    assert.equal(all.nextAfter, 4);
    const page = refs.events(eventsRequest(secret, id, userClaims('alice'), '?after=1&limit=2'));
    assert.deepEqual(page.events.map((event) => event.sequence), [2, 3]);
    assert.equal(page.nextAfter, 3);
    expectError(() => refs.events(eventsRequest(secret, id, userClaims('alice'), '?after=2&limit=2', { signQuery: '?after=1&limit=2' })), 'CoordinatorAuthError', 'unauthorized', 'rch');
    expectError(() => refs.events(eventsRequest(secret, id, userClaims('alice'), '?after=1&limit=3', { signQuery: '?after=1&limit=2' })), 'CoordinatorAuthError', 'unauthorized', 'rch');
    const signed = eventsRequest(secret, id, userClaims('alice'));
    expectError(() => refs.events({ ...signed, body: Buffer.from('x') }), 'CoordinatorAuthError', 'unauthorized', 'rch');
    for (const query of ['?limit=2&after=1', '?after=01&limit=2', '?after=1&limit=0', '?after=1&limit=1001', '?after=1', '?after=-1&limit=2', '?after=1&limit=2&x=1']) {
        expectError(() => refs.events(eventsRequest(secret, id, userClaims('alice'), query)), 'WorkerStateError', 'invalid_request');
    }
    expectError(() => refs.events(eventsRequest(secret, id, userClaims('alice'), '?after=5&limit=2')), 'WorkerStateError', 'invalid_request');
    const db = rawDb(dir);
    try {
        db.prepare('UPDATE reference_cursor SET first_retained = 3 WHERE reference_id = ?').run(id);
    } finally {
        db.close();
    }
    assert.deepEqual(refs.events(eventsRequest(secret, id, userClaims('alice'))), { gap: true, snapshotSequence: 4 });
});

test('control through real tokens: owner and administrator rules, durable replay, unmapped ops burned', (t) => {
    const { dir, store, secret, robotId, coordinator, refs, freshRefs } = rig(t);
    const { admitted } = admitMcp(secret, coordinator, robotId, 'user:alice');
    const id = admitted.taskRef.id;
    const attempt = attemptOf(dir, id);
    store.transitionAttempt({ ...attempt, expectedState: 'queued', nextState: 'running' });
    const sent = controlRequest(secret, id, { operationId: newId(), op: 'message', payload: { message: 'hello' } }, userClaims('alice'));
    assert.equal(refs.control(sent).delivery, 'pending');
    // The exact request again is refused durably, even through a fresh verifier.
    expectError(() => freshRefs().control(sent), 'WorkerStateError', 'forbidden', 'token_replayed');
    expectError(() => refs.control(controlRequest(secret, id, { operationId: newId(), op: 'message', payload: { message: 'x' } }, userClaims('root', ['admin']))), 'WorkerStateError', 'forbidden');
    assert.equal(refs.control(controlRequest(secret, id, { operationId: newId(), op: 'stop', attemptId: attempt.attemptId }, userClaims('root', ['ADMIN']))).outcome, 'accepted');
    const durable = count(dir, 'token_replay');
    const unmapped = controlRequest(secret, id, { operationId: newId(), op: 'take-control' }, userClaims('alice'));
    expectError(() => refs.control(unmapped), 'CoordinatorAuthError', 'operation_unavailable', 'operation_unmapped');
    assert.equal(count(dir, 'token_replay'), durable + 1);
    // The burned token replayed to a fresh verifier is refused the same way before any state
    // access; its burn finds the key already consumed and records nothing new.
    expectError(() => freshRefs().control(unmapped), 'CoordinatorAuthError', 'operation_unavailable', 'operation_unmapped');
    assert.equal(count(dir, 'token_replay'), durable + 1);
    expectError(() => refs.control(controlRequest(secret, id, { operationId: newId(), op: 'resize' }, userClaims('alice'))), 'WorkerStateError', 'invalid_request');
    // S6 Part D (W1 review R3): `pause` is mapped; on an execution reference S1 refuses it
    // invalid_request after visibility, so a caller who cannot see the reference gets not_found.
    const burnedBefore = count(dir, 'token_replay');
    expectError(() => refs.control(controlRequest(secret, id, { operationId: newId(), op: 'pause' }, userClaims('alice'))), 'WorkerStateError', 'invalid_request');
    expectError(() => refs.control(controlRequest(secret, id, { operationId: newId(), op: 'pause' }, userClaims('bob'))), 'WorkerStateError', 'not_found');
    assert.equal(count(dir, 'token_replay'), burnedBefore + 2, 'each refused pause still burns its token');
    const changed = controlRequest(secret, id, { operationId: newId(), op: 'stop' }, userClaims('alice'));
    expectError(() => refs.control({ ...changed, body: Buffer.from(JSON.stringify({ operationId: newId(), op: 'stop' })) }), 'CoordinatorAuthError', 'unauthorized', 'rch');
    assert.equal(count(dir, 'reference_control'), 2);
});

test('request surface and token refusals on the reference routes', (t) => {
    const { secret, robotId, coordinator, refs } = rig(t);
    const { admitted } = admitMcp(secret, coordinator, robotId, 'user:alice');
    const id = admitted.taskRef.id;
    expectError(() => refs.read(readRequest(secret, id, userClaims('alice'), { query: '?after=1' })), 'WorkerStateError', 'invalid_request');
    expectError(() => refs.read(readRequest(secret, id, userClaims('alice'), { path: `/v1/other/${id}` })), 'WorkerStateError', 'invalid_request');
    expectError(() => refs.read(readRequest(secret, 'short', userClaims('alice'), { path: `${BASE}/short` })), 'WorkerStateError', 'invalid_request');
    const signed = readRequest(secret, id, userClaims('alice'));
    expectError(() => refs.read({ ...signed, path: `${BASE}/${crypto.randomBytes(16).toString('base64url')}` }), 'CoordinatorAuthError', 'unauthorized', 'path');
    expectError(() => refs.read(readRequest(secret, id, userClaims('alice'), { tool: COORDINATOR_ADMISSION_TOOL })), 'CoordinatorAuthError', 'unauthorized', 'tool');
    expectError(() => refs.read(readRequest(secret, id, { ...userClaims('alice'), aud: COORDINATOR })), 'CoordinatorAuthError', 'unauthorized', 'audience');
    refs.read(signed);
    expectError(() => refs.read(signed), 'CoordinatorAuthError', 'unauthorized', 'replay');
    const extra = signedRequest(secret, {
        method: 'POST', path: `${BASE}/lookup`, body: Buffer.from(JSON.stringify({ originRequestId: newOriginId(), originKey: 'user:bob' })),
        tool: TASK_REFERENCE_TOOL, claims: { ...userClaims('alice'), originKey: 'user:alice' }
    });
    expectError(() => refs.lookup(extra), 'WorkerStateError', 'invalid_request');
});

// ---- S6 source-only subset, Part A (step W1): the recorded logical kind and admission state ----

function coordinatorHop(secret, path, bodyValue, owner) {
    const claims = agentClaims(COORDINATOR);
    if (owner !== undefined) {
        claims.usr = { id: owner, username: owner, email: '', roles: ['user'] };
        claims.delegation = { jti: crypto.randomBytes(8).toString('hex'), scope: ['execution:owner'], sourceAgentId: COORDINATOR };
    }
    return signedRequest(secret, { method: 'POST', path, body: Buffer.from(JSON.stringify(bodyValue)), tool: COORDINATOR_ADMISSION_TOOL, claims });
}

test('the snapshot carries the recorded logical kind: session and flow through /task-refs, task for MCP work (synthetic runtime)', (t) => {
    const { secret, robotId, coordinator, refs } = rig(t);
    const turn = coordinator.admit(coordinatorHop(secret, '/v1/coordinator/admissions', {
        originRequestId: newOriginId(), robotId, configRevision: 1, kind: 'turn', logical: { sessionKey: 'conv-refs' },
        specification: { version: 1, prompt: 'synthetic turn' }
    }, 'alice'));
    const flowId = `flow_${crypto.randomBytes(12).toString('hex')}`;
    coordinator.bind(coordinatorHop(secret, '/v1/coordinator/bindings', { operationId: newId(), bindingId: flowId }, 'alice'));
    const phase = coordinator.admit(coordinatorHop(secret, '/v1/coordinator/admissions', {
        originRequestId: newOriginId(), robotId, configRevision: 1, kind: 'task', specification: { prompt: 'phase' }, bindingId: flowId
    }));
    const { admitted: task } = admitMcp(secret, coordinator, robotId, 'user:alice');
    const read = (id) => refs.read(readRequest(secret, id, userClaims('alice')));
    const session = read(turn.taskRef.id).logical;
    assert.equal(session.kind, 'session');
    assert.equal(session.id.length, 22);
    assert.deepEqual(read(phase.taskRef.id).logical, { kind: 'flow', id: flowId });
    assert.equal(read(task.taskRef.id).logical.kind, 'task');
    assert.notEqual(read(task.taskRef.id).logical.id, session.id);
});

test('projectSnapshot never defaults the logical kind: an unrecorded kind or a flow without its binding is state_corrupt', () => {
    const facts = {
        reference: { version: 1, provider: PROVIDER_PRINCIPAL, id: 'A'.repeat(22) }, originRequestId: newOriginId(), logicalId: newId(),
        attemptId: newId(), state: 'queued', cleanup: null, result: null, endedReason: null, sequence: 1, previousReference: null
    };
    assert.deepEqual(projectSnapshot({ ...facts, logicalKind: 'session', bindingId: null }).logical, { kind: 'session', id: facts.logicalId });
    assert.deepEqual(projectSnapshot({ ...facts, logicalKind: 'task', bindingId: null }).logical, { kind: 'task', id: facts.logicalId });
    assert.deepEqual(projectSnapshot({ ...facts, logicalKind: 'flow', bindingId: 'flow_x' }).logical, { kind: 'flow', id: 'flow_x' });
    for (const bad of [{ logicalKind: undefined }, { logicalKind: 'execution' }, { logicalKind: 'flow', bindingId: null }, { logicalKind: 'flow', bindingId: '' }]) {
        expectError(() => projectSnapshot({ ...facts, bindingId: null, ...bad }), 'WorkerStateError', 'state_corrupt');
    }
});

test('M-3: projectAcceptance reports the recorded admission state; an unrecorded state is state_corrupt', (t) => {
    const reference = { version: 1, provider: PROVIDER_PRINCIPAL, id: 'B'.repeat(22) };
    const originRequestId = newOriginId();
    assert.deepEqual(projectAcceptance(reference, originRequestId, 'queued'), { taskRef: reference, state: 'queued', originRequestId });
    assert.deepEqual(projectAcceptance(reference, originRequestId, 'pending-coordinator'),
        { taskRef: reference, state: 'pending-coordinator', originRequestId });
    for (const state of [undefined, 'running', 'accepted', 'completed', '']) {
        expectError(() => projectAcceptance(reference, originRequestId, state), 'WorkerStateError', 'state_corrupt');
    }
    // Through the real lookup: the recorded `queued`, whatever the live state.
    const { dir, store, secret, robotId, coordinator, refs } = rig(t);
    const { originRequestId: id, admitted } = admitMcp(secret, coordinator, robotId, 'user:alice');
    store.transitionAttempt({ ...attemptOf(dir, admitted.taskRef.id), expectedState: 'queued', nextState: 'running' });
    assert.deepEqual(refs.lookup(lookupRequest(secret, id, { ...userClaims('alice'), originKey: 'user:alice' })), admitted);
    const mcpAlice = syntheticContext({ originKey: 'user:alice', ownerId: 'user:alice', scope: scopeFor('mcp', 'user:alice'), robotOwnerId: ROBOTS });
    const looked = store.lookupOrigin(mcpAlice, { originRequestId: id });
    assert.deepEqual([looked.admissionState, looked.state], ['queued', 'running']);
});

// ---- S6 Part D (step W2): observation references through /task-refs -----------------------

test('D6-4: through /task-refs a non-owner cannot read, list events of or control a generation reference (not_found); the owner reads the observation snapshot', (t) => {
    const { secret, coordinator, refs } = rig(t);
    const generation = coordinator.admitObligation(coordinatorHop(secret, '/v1/coordinator/obligations', {
        originRequestId: newOriginId(), obligationKind: 'generation', request: { ticket: 'synthetic' }
    }, 'alice'));
    const ticket = `gen_${crypto.randomBytes(12).toString('hex')}`;
    const decision = coordinator.acceptObligation(coordinatorHop(secret, `/v1/coordinator/obligations/${generation.taskRef.id}/accept`, { operationId: newId(), domainRecordId: ticket }));
    assert.equal(decision.decision, 'accepted');
    const id = generation.taskRef.id;
    expectError(() => refs.read(readRequest(secret, id, userClaims('victor'))), 'WorkerStateError', 'not_found');
    expectError(() => refs.events(eventsRequest(secret, id, userClaims('victor'))), 'WorkerStateError', 'not_found');
    expectError(() => refs.control(controlRequest(secret, id, { operationId: newId(), op: 'stop' }, userClaims('victor'))), 'WorkerStateError', 'not_found');
    const snapshot = refs.read(readRequest(secret, id, userClaims('alice')));
    assert.deepEqual(Object.keys(snapshot), ['taskRef', 'originRequestId', 'kind', 'state', 'obligation', 'logical', 'sequence']);
    assert.deepEqual([snapshot.kind, snapshot.state, snapshot.logical, snapshot.obligation.obligationKind], ['observation', 'accepted', { kind: 'flow', id: ticket }, 'generation']);
    // A generation is not paused; an administrator may cancel it through /task-refs.
    expectError(() => refs.control(controlRequest(secret, id, { operationId: newId(), op: 'pause' }, userClaims('alice'))), 'WorkerStateError', 'operation_conflict');
    const cancelled = refs.control(controlRequest(secret, id, { operationId: newId(), op: 'stop' }, userClaims('root', ['admin'])));
    assert.deepEqual([cancelled.outcome, cancelled.bindingState, cancelled.fenceRevision], ['accepted', 'cancelled', 1]);
});
