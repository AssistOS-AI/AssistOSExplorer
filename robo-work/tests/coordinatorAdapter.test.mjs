import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { openWorkerState } from '../server/workerState.mjs';
import {
    COORDINATOR_ADMISSION_TOOL, TASK_REFERENCE_ORIGIN_TOOL, computeOriginRch, computeRchHttp, createReplayCache,
    createVerifierConfig, rawBodyHash
} from '../server/coordinatorAuth.mjs';
import { createCoordinatorAdapter } from '../server/coordinatorAdapter.mjs';
import { createDispatcher } from '../server/runtime/dispatcher.mjs';
import { deriveFlowLogicalId } from '../server/stateProtocol.mjs';
import { createWorkflowCatalogRequests } from '../server/runtime/workflowCatalogRequests.mjs';
import { skillsSelectionDigest } from '../server/stateProtocol.mjs';
import { LIMITS, PROVIDER, S6_LIMITS, WORKSPACE, count, makeTempDir, newId, newOriginId, openStore, rawDb, readyRobot, syntheticContext } from './helpers/synthetic.mjs';

// Coordinator adapter over the actual S1/S1x store in isolated temporary directories, with
// real HS256 tokens under generated keys. Positive admissions use the explicitly SYNTHETIC
// runtime of tests/helpers/synthetic.mjs: state and adapter evidence only, not protected
// execution or runtime readiness. Routed Router-to-worker integration is not exercised here.

const PROVIDER_PRINCIPAL = 'agent:RoboRepo/robo-work';
const COORDINATOR = 'agent:RoboRepo/roboTeamAgent';
const OTHER_AGENT = 'agent:RoboRepo/otherAgent';
const BASE = '/v1/coordinator';
const ADMIT_PATH = `${BASE}/admissions`;
const LOOKUP_PATH = `${BASE}/lookup`;
const BIND_PATH = `${BASE}/bindings`;
const DURABLE = ['receipt', 'admission', 'origin', 'reference'];
const EXTENDED = S6_LIMITS;
const ROBOTS = `workspace:${WORKSPACE}`;

function b64json(value) {
    return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

function sign(payload, secret) {
    const input = `${b64json({ alg: 'HS256', typ: 'JWT' })}.${b64json(payload)}`;
    return `${input}.${crypto.createHmac('sha256', secret).update(input).digest('base64url')}`;
}

function nowSeconds() {
    return Math.floor(Date.now() / 1000);
}

function flowId() {
    return `flow_${crypto.randomBytes(12).toString('hex')}`;
}

function openExtended(dir, options = {}) {
    return openStore(dir, { limits: EXTENDED, ...options });
}

function rig(store, secret = crypto.randomBytes(32)) {
    const replayCache = createReplayCache();
    const verifier = createVerifierConfig({ secret, audience: PROVIDER_PRINCIPAL, coordinators: [COORDINATOR], replayCache });
    return { secret, replayCache, adapter: createCoordinatorAdapter({ store, workspaceId: WORKSPACE, verifier }) };
}

function ownerClaims(userId, roles = ['user'], scope = ['execution:owner']) {
    return {
        usr: { id: userId, username: userId, email: '', roles },
        delegation: { jti: crypto.randomBytes(8).toString('hex'), scope, sourceAgentId: COORDINATOR }
    };
}

const OTHER_CALLER = Object.freeze({ sub: OTHER_AGENT, actor: { kind: 'agent', id: OTHER_AGENT }, caller: { kind: 'agent', id: OTHER_AGENT } });

function hop(secret, bodyValue, { path = ADMIT_PATH, claims = {}, bodyOverride } = {}) {
    const body = Buffer.from(JSON.stringify(bodyValue));
    const iat = nowSeconds();
    const payload = {
        typ: 'router-request', iss: 'ploinky-router', aud: PROVIDER_PRINCIPAL, sub: COORDINATOR,
        actor: { kind: 'agent', id: COORDINATOR, roles: [] }, caller: { kind: 'agent', id: COORDINATOR, roles: ['agent'] },
        method: 'POST', path, tool: COORDINATOR_ADMISSION_TOOL,
        rch: computeRchHttp({ method: 'POST', path, query: '', bodyHash: rawBodyHash(body) }),
        jti: crypto.randomBytes(16).toString('base64url'), iat, exp: iat + 30, ...claims
    };
    return { authInfo: JSON.stringify({ invocationToken: sign(payload, secret), invocationBody: {} }), method: 'POST', path, query: '', body: bodyOverride ?? body };
}

function originTokenFor(secret, { originKey = 'user:alice', originRequestId, agent = COORDINATOR, tool = 'runRobotTask', iat = nowSeconds() }) {
    const origin = { originKey, originRequestId, agent, tool };
    return sign({
        typ: 'router-request', iss: 'ploinky-router', aud: PROVIDER_PRINCIPAL, sub: originKey, method: 'ORIGIN', path: '/origin',
        tool: TASK_REFERENCE_ORIGIN_TOOL, rch: computeOriginRch(origin), origin,
        jti: crypto.randomBytes(16).toString('base64url'), iat, exp: iat + 30
    }, secret);
}

function admitBody(robotId, originRequestId, extra = {}) {
    return { originRequestId, robotId, configRevision: 1, kind: 'task', specification: { prompt: 'synthetic task' }, ...extra };
}

function mcpBody(secret, robotId, originRequestId, originOverrides = {}, extra = {}) {
    return admitBody(robotId, originRequestId, { taskRefOrigin: originTokenFor(secret, { originRequestId, ...originOverrides }), originTool: 'runRobotTask', ...extra });
}

function referencePath(id, action) {
    return `${BASE}/references/${id}/${action}`;
}

// SYNTHETIC workspace robot, provisioned and completed directly in S1.
function workspaceRobot(store) {
    return readyRobot(store, syntheticContext({ robotOwnerId: ROBOTS, scope: 'scope-robots' }));
}

function counts(dir) {
    return Object.fromEntries(DURABLE.map((table) => [table, count(dir, table)]));
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

test('workflow catalog: signed coordinator-only requests bind raw bytes, owner admission, attempt and one settlement', async (t) => {
    const store = openExtended(makeTempDir(t));
    t.after(() => store.close());
    const workflowCatalog = createWorkflowCatalogRequests({ store });
    t.after(() => workflowCatalog.close());
    const secret = crypto.randomBytes(32);
    const verifier = createVerifierConfig({ secret, audience: PROVIDER_PRINCIPAL, coordinators: [COORDINATOR, OTHER_AGENT], replayCache: createReplayCache() });
    const adapter = createCoordinatorAdapter({ store, workspaceId: WORKSPACE, verifier, workflowCatalog });
    const robotId = workspaceRobot(store);
    const skills = [{ name: 'list-workflows', path: '/ws/list-workflows', required: true }];
    const specification = { version: 2, prompt: 'unchanged', displayText: '', sessionId: 'session', turnId: 'turn', permissions: 'full-access',
        workflowCatalog: true, skills, skillsDigest: skillsSelectionDigest(skills) };
    const admitted = adapter.admit(hop(secret, turnBody(robotId, newOriginId(), 'catalog-session', { specification }), { claims: ownerClaims('alice') }));
    const queued = store.listQueuedAdmissions()[0];
    const ids = { executionId: queued.executionId, attemptId: queued.attemptId };
    store.transitionAttempt({ ...ids, expectedState: 'queued', nextState: 'running' });
    const handle = workflowCatalog.registerAttempt(ids);
    const result = handle.read();
    const requestsPath = `${BASE}/workflow-catalog/requests`;
    const request = hop(secret, {}, { path: requestsPath });
    const rows = adapter.workflowCatalogRequests(request).requests;
    assert.equal(rows.length, 1);
    assert.equal(rows[0].referenceId, admitted.taskRef.id);
    expectError(() => adapter.workflowCatalogRequests(request), 'CoordinatorAuthError', 'unauthorized', 'replay');
    expectError(() => adapter.workflowCatalogRequests(hop(secret, {}, { path: requestsPath, claims: ownerClaims('alice') })), 'CoordinatorAuthError', 'forbidden', 'row_ambiguous');
    expectError(() => adapter.workflowCatalogRequests(hop(secret, { ownerId: 'user:alice' }, { path: requestsPath })), 'WorkerStateError', 'invalid_request');
    expectError(() => adapter.workflowCatalogRequests(hop(secret, {}, { path: requestsPath, bodyOverride: Buffer.from('{ }') })), 'CoordinatorAuthError', 'unauthorized', 'rch');
    expectError(() => adapter.workflowCatalogRequests(hop(secret, {}, { path: `${requestsPath}?q=x` })), 'WorkerStateError', 'invalid_request');
    const foreign = { sub: OTHER_AGENT, actor: { kind: 'agent', id: OTHER_AGENT }, caller: { kind: 'agent', id: OTHER_AGENT } };
    assert.deepEqual(adapter.workflowCatalogRequests(hop(secret, {}, { path: requestsPath, claims: foreign })), { requests: [] });
    const { referenceId, ...row } = rows[0];
    const replyPath = `${BASE}/references/${referenceId}/workflow-catalog/reply`;
    const empty = { ok: true, workflows: [] };
    expectError(() => adapter.workflowCatalogReply(hop(secret, { ...row, result: { ...empty, prompt: 'private' } }, { path: replyPath })), 'WorkerStateError', 'invalid_request');
    assert.deepEqual(adapter.workflowCatalogReply(hop(secret, { ...row, result: empty }, { path: replyPath, claims: foreign })), { ok: true, settled: false });
    assert.deepEqual(adapter.workflowCatalogReply(hop(secret, { ...row, result: empty }, { path: `${BASE}/references/${newId()}/workflow-catalog/reply` })), { ok: true, settled: false });
    const reply = hop(secret, { ...row, result: empty }, { path: replyPath });
    assert.deepEqual(adapter.workflowCatalogReply(reply), { ok: true, settled: true });
    assert.deepEqual(await result, empty);
    expectError(() => adapter.workflowCatalogReply(reply), 'CoordinatorAuthError', 'unauthorized', 'replay');
    assert.deepEqual(adapter.workflowCatalogReply(hop(secret, { ...row, result: empty }, { path: replyPath })), { ok: true, settled: false });
});

function expectReplayed(fn) {
    expectError(fn, 'WorkerStateError', 'forbidden', 'token_replayed');
}

// Root binding registered with `userId`'s grant.
function rootBinding(adapter, secret, userId, bindingId = flowId()) {
    adapter.bind(hop(secret, { operationId: newId(), bindingId }, { path: BIND_PATH, claims: ownerClaims(userId) }));
    return bindingId;
}

test('coordinator-API row: verified owner admission and lookup of the recorded acceptance (synthetic runtime)', (t) => {
    const dir = makeTempDir(t);
    const store = openExtended(dir);
    t.after(() => store.close());
    const { secret, adapter } = rig(store);
    const robotId = workspaceRobot(store);
    const originRequestId = newOriginId();
    const admitted = adapter.admit(hop(secret, admitBody(robotId, originRequestId), { claims: ownerClaims('alice') }));
    assert.deepEqual(Object.keys(admitted), ['taskRef', 'state', 'originRequestId']);
    assert.deepEqual(Object.keys(admitted.taskRef), ['version', 'provider', 'id']);
    assert.equal(admitted.taskRef.provider, PROVIDER);
    assert.equal(admitted.state, 'queued');
    const found = adapter.lookup(hop(secret, { originRequestId }, { path: LOOKUP_PATH, claims: ownerClaims('alice') }));
    assert.equal(JSON.stringify(found), JSON.stringify(admitted));
    assert.deepEqual(counts(dir), { receipt: 2, admission: 1, origin: 1, reference: 1 });
    assert.equal(count(dir, 'token_replay'), 1);
});

test('RI-6: lookup returns the recorded acceptance byte-for-byte after the attempt runs and ends', (t) => {
    const dir = makeTempDir(t);
    const store = openExtended(dir);
    t.after(() => store.close());
    const { secret, adapter } = rig(store);
    const robotId = workspaceRobot(store);
    const originRequestId = newOriginId();
    const admitted = adapter.admit(hop(secret, admitBody(robotId, originRequestId), { claims: ownerClaims('alice') }));
    const lookup = () => JSON.stringify(adapter.lookup(hop(secret, { originRequestId }, { path: LOOKUP_PATH, claims: ownerClaims('alice') })));
    const { executionId, attemptId } = attemptOf(dir, admitted.taskRef.id);
    store.transitionAttempt({ executionId, attemptId, expectedState: 'queued', nextState: 'running' });
    assert.equal(lookup(), JSON.stringify(admitted));
    store.beginAttemptEnd(syntheticContext({ scope: 'scope-adapter' }), { executionId, attemptId, expectedState: 'running', outcome: { classification: 'completed' } });
    assert.equal(lookup(), JSON.stringify(admitted));
    const live = adapter.readReference(hop(secret, {}, { path: referencePath(admitted.taskRef.id, 'read'), claims: ownerClaims('alice') }));
    assert.equal(live.state, 'completed');
});

test('MCP row: taskRefOrigin verified in addition to the hop token (synthetic runtime)', (t) => {
    const dir = makeTempDir(t);
    const store = openExtended(dir);
    t.after(() => store.close());
    const { secret, adapter } = rig(store);
    const robotId = workspaceRobot(store);
    const originRequestId = newOriginId();
    const admitted = adapter.admit(hop(secret, mcpBody(secret, robotId, originRequestId)));
    assert.equal(admitted.originRequestId, originRequestId);
    assert.equal(count(dir, 'admission'), 1);
    assert.equal(count(dir, 'token_replay'), 2);
    // The coordinator cannot recover an MCP origin through the coordinator-API row.
    expectError(() => adapter.lookup(hop(secret, { originRequestId }, { path: LOOKUP_PATH, claims: ownerClaims('alice') })), 'WorkerStateError', 'not_found');
});

test('MCP row refusals record nothing and burn the verified hop token', (t) => {
    const dir = makeTempDir(t);
    const store = openExtended(dir);
    t.after(() => store.close());
    const { secret, adapter } = rig(store);
    const robotId = workspaceRobot(store);
    const before = counts(dir);
    const id = newOriginId();
    const cases = [
        [mcpBody(secret, robotId, id, { agent: OTHER_AGENT }), {}, 'CoordinatorAuthError', 'forbidden', 'origin_agent'],
        [mcpBody(secret, robotId, id, { originRequestId: newOriginId() }), {}, 'CoordinatorAuthError', 'forbidden', 'origin_binding'],
        [mcpBody(secret, robotId, id, { tool: 'otherTool' }), {}, 'CoordinatorAuthError', 'forbidden', 'origin_binding'],
        [admitBody(robotId, id, { originTool: 'runRobotTask' }), {}, 'CoordinatorAuthError', 'unauthorized', 'origin_claims'],
        [mcpBody(secret, robotId, id), ownerClaims('alice'), 'CoordinatorAuthError', 'forbidden', 'row_ambiguous'],
        [mcpBody(secret, robotId, id, {}, { bindingId: flowId() }), {}, 'CoordinatorAuthError', 'forbidden', 'row_ambiguous'],
        [admitBody(robotId, id, { bindingId: flowId() }), ownerClaims('alice'), 'CoordinatorAuthError', 'forbidden', 'row_ambiguous'],
        [admitBody(robotId, id), {}, 'CoordinatorAuthError', 'forbidden', 'row_missing']
    ];
    for (const [body, claims, name, code, reason] of cases) {
        expectError(() => adapter.admit(hop(secret, body, { claims })), name, code, reason);
    }
    assert.deepEqual(counts(dir), before);
    // Each refused request burned exactly its verified hop token (origin_agent/origin_binding
    // cases also verified their origin token and burned it).
    assert.equal(count(dir, 'token_replay'), cases.length + 3);
});

test('an expired origin token fails the MCP admission, records nothing and burns only the hop token', (t) => {
    const dir = makeTempDir(t);
    const store = openExtended(dir);
    t.after(() => store.close());
    const { secret, adapter } = rig(store);
    const robotId = workspaceRobot(store);
    const before = counts(dir);
    const id = newOriginId();
    expectError(() => adapter.admit(hop(secret, mcpBody(secret, robotId, id, { iat: nowSeconds() - 120 }))), 'CoordinatorAuthError', 'unauthorized', 'expired');
    assert.deepEqual(counts(dir), before);
    assert.equal(count(dir, 'token_replay'), 1);
});

test('replay of the exact admission request is refused durably and adds no receipt', (t) => {
    const dir = makeTempDir(t);
    const store = openExtended(dir);
    t.after(() => store.close());
    const { secret, adapter } = rig(store);
    const robotId = workspaceRobot(store);
    const request = hop(secret, admitBody(robotId, newOriginId()), { claims: ownerClaims('alice') });
    adapter.admit(request);
    const after = counts(dir);
    expectReplayed(() => adapter.admit(request));
    assert.deepEqual(counts(dir), after);
});

test('committed admission tokens stay refused after a verifier and store restart (no new receipt)', (t) => {
    const dir = makeTempDir(t);
    let store = openExtended(dir);
    const robotId = workspaceRobot(store);
    const secret = crypto.randomBytes(32);
    const request = hop(secret, admitBody(robotId, newOriginId()), { claims: ownerClaims('alice') });
    rig(store, secret).adapter.admit(request);
    store.close();
    const after = counts(dir);
    store = openExtended(dir, { create: false });
    t.after(() => store.close());
    // A fresh verifier with an empty in-memory cache: only the durable S1 record refuses it.
    expectReplayed(() => rig(store, secret).adapter.admit(request));
    assert.deepEqual(counts(dir), after);
});

test('RI-5: a refused admission burns its tokens; a replay to a fresh verifier is refused', (t) => {
    const dir = makeTempDir(t);
    const store = openExtended(dir);
    t.after(() => store.close());
    const secret = crypto.randomBytes(32);
    // A robot still provisioning: admission is robot_busy.
    const provisioning = store.beginProvision(syntheticContext({ robotOwnerId: ROBOTS, scope: 'scope-robots' }), { operationId: newId(), name: 'Busy', configuration: { backend: 'synthetic' } });
    const request = hop(secret, admitBody(provisioning.robotId, newOriginId()), { claims: ownerClaims('alice') });
    expectError(() => rig(store, secret).adapter.admit(request), 'WorkerStateError', 'robot_busy');
    const before = counts(dir);
    expectReplayed(() => rig(store, secret).adapter.admit(request));
    assert.deepEqual(counts(dir), before);
    assert.equal(count(dir, 'admission'), 0);
});

test('a changed body breaks the rch binding before verification: nothing recorded or burned', (t) => {
    const dir = makeTempDir(t);
    const store = openExtended(dir);
    t.after(() => store.close());
    const { secret, adapter } = rig(store);
    const robotId = workspaceRobot(store);
    const before = counts(dir);
    const signed = admitBody(robotId, newOriginId());
    const swapped = Buffer.from(JSON.stringify({ ...signed, configRevision: 2 }));
    expectError(() => adapter.admit(hop(secret, signed, { claims: ownerClaims('alice'), bodyOverride: swapped })), 'CoordinatorAuthError', 'unauthorized', 'rch');
    assert.deepEqual(counts(dir), before);
    assert.equal(count(dir, 'token_replay'), 0);
});

test('wrong coordinator principal and missing owner scope are refused at verification', (t) => {
    const dir = makeTempDir(t);
    const store = openExtended(dir);
    t.after(() => store.close());
    const { secret, adapter } = rig(store);
    const robotId = workspaceRobot(store);
    const before = counts(dir);
    expectError(() => adapter.admit(hop(secret, admitBody(robotId, newOriginId()), { claims: { ...OTHER_CALLER, ...ownerClaims('alice') } })), 'CoordinatorAuthError', 'forbidden', 'coordinator');
    expectError(() => adapter.admit(hop(secret, admitBody(robotId, newOriginId()), { claims: ownerClaims('alice', ['user'], ['execution:read']) })), 'CoordinatorAuthError', 'forbidden', 'owner_scope');
    // Missing owner scope never degrades to the background row, even with a binding.
    expectError(() => adapter.admit(hop(secret, admitBody(robotId, newOriginId(), { bindingId: flowId() }), { claims: ownerClaims('alice', ['user'], []) })), 'CoordinatorAuthError', 'forbidden', 'owner_scope');
    assert.deepEqual(counts(dir), before);
    assert.equal(count(dir, 'token_replay'), 0);
});

test('non-coordinator principal cannot bind or admit', (t) => {
    const dir = makeTempDir(t);
    const store = openExtended(dir);
    t.after(() => store.close());
    const { secret, adapter } = rig(store);
    const robotId = workspaceRobot(store);
    expectError(() => adapter.bind(hop(secret, { operationId: newId(), bindingId: flowId() }, { path: BIND_PATH, claims: { ...OTHER_CALLER, ...ownerClaims('alice') } })),
        'CoordinatorAuthError', 'forbidden', 'coordinator');
    expectError(() => adapter.admit(hop(secret, admitBody(robotId, newOriginId(), { bindingId: flowId() }), { claims: OTHER_CALLER })), 'CoordinatorAuthError', 'forbidden', 'coordinator');
    assert.equal(count(dir, 'binding'), 0);
});

test('JSON-injected owner, scope, context or operation fields are refused and record nothing', (t) => {
    const dir = makeTempDir(t);
    const store = openExtended(dir);
    t.after(() => store.close());
    const { secret, adapter } = rig(store);
    const robotId = workspaceRobot(store);
    const before = counts(dir);
    const injections = [
        { owner: 'user:alice' }, { ownerId: 'user:alice' }, { usr: { id: 'alice' } }, { scope: 'x' }, { originNamespace: 'mcp' },
        { originKey: 'user:alice' }, { verifiedContext: {} }, { operationId: 'AAAAAAAAAAAAAAAAAAAAAA' }, { delegation: { scope: ['execution:owner'] } },
        { roles: ['admin'] }, { originToken: 'renamed' }
    ];
    for (const extra of injections) {
        expectError(() => adapter.admit(hop(secret, admitBody(robotId, newOriginId(), extra))), 'WorkerStateError', 'invalid_request');
        expectError(() => adapter.admit(hop(secret, admitBody(robotId, newOriginId(), extra), { claims: ownerClaims('bob') })), 'WorkerStateError', 'invalid_request');
    }
    expectError(() => adapter.admit(hop(secret, admitBody(robotId, newOriginId(), { specification: { prompt: 'x', owner: 'user:alice' } }), { claims: ownerClaims('alice') })),
        'WorkerStateError', 'invalid_request');
    expectError(() => adapter.bind(hop(secret, { operationId: newId(), bindingId: flowId(), ownerId: 'user:alice' }, { path: BIND_PATH, claims: ownerClaims('bob') })),
        'WorkerStateError', 'invalid_request');
    expectError(() => adapter.bind(hop(secret, { operationId: newId(), bindingId: flowId(), kind: 'schedule' }, { path: BIND_PATH, claims: ownerClaims('bob') })),
        'WorkerStateError', 'invalid_request');
    assert.deepEqual(counts(dir), before);
    assert.equal(count(dir, 'binding'), 0);
});

test('cross-caller origin lookup returns not_found; the same originRequestId admits independently', (t) => {
    const dir = makeTempDir(t);
    const store = openExtended(dir);
    t.after(() => store.close());
    const { secret, adapter } = rig(store);
    const robotId = workspaceRobot(store);
    const originRequestId = newOriginId();
    const alice = adapter.admit(hop(secret, admitBody(robotId, originRequestId), { claims: ownerClaims('alice') }));
    const lookup = (claims, extra = {}) => adapter.lookup(hop(secret, { originRequestId, ...extra }, { path: LOOKUP_PATH, claims }));
    expectError(() => lookup(ownerClaims('bob')), 'WorkerStateError', 'not_found');
    expectError(() => lookup({}, { bindingId: flowId() }), 'WorkerStateError', 'not_found');
    expectError(() => lookup({}), 'CoordinatorAuthError', 'forbidden', 'row_missing');
    expectError(() => adapter.lookup(hop(secret, { originRequestId: newOriginId() }, { path: LOOKUP_PATH, claims: ownerClaims('alice') })), 'WorkerStateError', 'not_found');
    // Workspace robots: bob admits to the same robot under his own origin.
    const bob = adapter.admit(hop(secret, admitBody(robotId, originRequestId), { claims: ownerClaims('bob') }));
    assert.notEqual(bob.taskRef.id, alice.taskRef.id);
    assert.deepEqual(lookup(ownerClaims('alice')).taskRef, alice.taskRef);
});

test('F2: coordinator lookup with owner claims plus a binding is ambiguous and consumes no jti', (t) => {
    const dir = makeTempDir(t);
    const store = openExtended(dir);
    t.after(() => store.close());
    const { secret, replayCache, adapter } = rig(store);
    const robotId = workspaceRobot(store);
    const originRequestId = newOriginId();
    adapter.admit(hop(secret, admitBody(robotId, originRequestId), { claims: ownerClaims('alice') }));
    const memory = replayCache.size;
    const durable = count(dir, 'token_replay');
    const request = hop(secret, { originRequestId, bindingId: flowId() }, { path: LOOKUP_PATH, claims: ownerClaims('alice') });
    expectError(() => adapter.lookup(request), 'CoordinatorAuthError', 'forbidden', 'row_ambiguous');
    expectError(() => adapter.lookup(request), 'CoordinatorAuthError', 'forbidden', 'row_ambiguous');
    assert.equal(replayCache.size, memory);
    assert.equal(count(dir, 'token_replay'), durable);
});

test('same-origin retry after store close and reopen returns the recorded admission without a new receipt', (t) => {
    const dir = makeTempDir(t);
    let store = openExtended(dir);
    const robotId = workspaceRobot(store);
    const originRequestId = newOriginId();
    let { secret, adapter } = rig(store);
    const first = adapter.admit(hop(secret, admitBody(robotId, originRequestId), { claims: ownerClaims('alice') }));
    store.close();
    const after = counts(dir);
    store = openExtended(dir, { create: false });
    t.after(() => store.close());
    ({ secret, adapter } = rig(store));
    // Fresh tokens: the earlier jti was consumed by design.
    assert.deepEqual(adapter.admit(hop(secret, admitBody(robotId, originRequestId), { claims: ownerClaims('alice') })), first);
    assert.deepEqual(counts(dir), after);
    const mcpId = newOriginId();
    const mcpFirst = adapter.admit(hop(secret, mcpBody(secret, robotId, mcpId)));
    const mcpAfter = counts(dir);
    assert.deepEqual(adapter.admit(hop(secret, mcpBody(secret, robotId, mcpId))), mcpFirst);
    assert.deepEqual(counts(dir), mcpAfter);
});

test('default runtime refuses admission with zero admission, receipt, origin or reference rows; tokens are burned', (t) => {
    const dir = makeTempDir(t);
    const setupStore = openExtended(dir);
    const robotId = workspaceRobot(setupStore);
    setupStore.close();
    const before = counts(dir);
    // Reopened WITHOUT a runtime: S1's default runtimeUnavailable adapter.
    const store = openWorkerState({ dataDir: dir, workspaceId: WORKSPACE, provider: PROVIDER, limits: EXTENDED });
    t.after(() => store.close());
    const { secret, adapter } = rig(store);
    const id = newOriginId();
    const owner = hop(secret, admitBody(robotId, id), { claims: ownerClaims('alice') });
    expectError(() => adapter.admit(owner), 'WorkerStateError', 'runtime_unavailable');
    const mcpId = newOriginId();
    expectError(() => adapter.admit(hop(secret, mcpBody(secret, robotId, mcpId))), 'WorkerStateError', 'runtime_unavailable');
    assert.deepEqual(counts(dir), before);
    assert.equal(count(dir, 'admission'), 0);
    assert.equal(count(dir, 'origin'), 0);
    assert.equal(count(dir, 'reference'), 0);
    assert.equal(count(dir, 'token_replay'), 3);
    expectReplayed(() => rig(store, secret).adapter.admit(owner));
    expectError(() => adapter.lookup(hop(secret, { originRequestId: id }, { path: LOOKUP_PATH, claims: ownerClaims('alice') })), 'WorkerStateError', 'not_found');
});

test('root bind needs the owner grant; derived bind is coordinator-only; the generation form is unavailable', (t) => {
    const dir = makeTempDir(t);
    const store = openExtended(dir);
    t.after(() => store.close());
    const { secret, adapter } = rig(store);
    const root = flowId();
    expectError(() => adapter.bind(hop(secret, { operationId: newId(), bindingId: root }, { path: BIND_PATH })), 'CoordinatorAuthError', 'forbidden', 'owner_evidence');
    expectError(() => adapter.bind(hop(secret, { operationId: newId(), bindingId: `gen_${'a'.repeat(24)}` }, { path: BIND_PATH, claims: ownerClaims('alice') })),
        'CoordinatorAuthError', 'operation_unavailable', 'operation_unmapped');
    expectError(() => adapter.bind(hop(secret, { operationId: newId(), bindingId: 'flow1' }, { path: BIND_PATH, claims: ownerClaims('alice') })),
        'CoordinatorAuthError', 'invalid_request', 'binding');
    const registered = adapter.bind(hop(secret, { operationId: newId(), bindingId: root }, { path: BIND_PATH, claims: ownerClaims('alice') }));
    assert.equal(registered.kind, 'flow');
    expectError(() => adapter.bind(hop(secret, { operationId: newId(), bindingId: flowId(), parentBindingId: root }, { path: BIND_PATH, claims: ownerClaims('alice') })),
        'CoordinatorAuthError', 'forbidden', 'row_ambiguous');
    const child = flowId();
    const derived = adapter.bind(hop(secret, { operationId: newId(), bindingId: child, parentBindingId: root }, { path: BIND_PATH }));
    assert.equal(derived.parentBindingId, root);
    assert.deepEqual(store.readBindingOwner({ coordinator: COORDINATOR, bindingId: child }), { ownerId: 'user:alice' });
    const schedule = `cron_${crypto.randomBytes(12).toString('hex')}.r3`;
    assert.equal(adapter.bind(hop(secret, { operationId: newId(), bindingId: schedule }, { path: BIND_PATH, claims: ownerClaims('alice') })).kind, 'schedule');
    expectError(() => adapter.bind(hop(secret, { operationId: newId(), bindingId: flowId(), parentBindingId: flowId() }, { path: BIND_PATH })), 'WorkerStateError', 'not_found');
    assert.equal(count(dir, 'binding'), 3);
});

test('background admit takes the owner from the binding, never the coordinator', (t) => {
    const dir = makeTempDir(t);
    const store = openExtended(dir);
    t.after(() => store.close());
    const { secret, adapter } = rig(store);
    const robotId = workspaceRobot(store);
    const binding = rootBinding(adapter, secret, 'ursula');
    const before = counts(dir);
    expectError(() => adapter.admit(hop(secret, admitBody(robotId, newOriginId(), { bindingId: flowId() }))), 'WorkerStateError', 'not_found');
    expectError(() => adapter.admit(hop(secret, admitBody(robotId, newOriginId(), { bindingId: `gen_${'b'.repeat(24)}` }))), 'WorkerStateError', 'not_found');
    assert.deepEqual(counts(dir), before);
    const originRequestId = newOriginId();
    const admitted = adapter.admit(hop(secret, admitBody(robotId, originRequestId, { bindingId: binding })));
    const db = rawDb(dir, { readOnly: true });
    try {
        assert.equal(db.prepare('SELECT owner_id FROM admission').get().owner_id, 'user:ursula');
    } finally {
        db.close();
    }
    const read = (claims, body = {}) => adapter.readReference(hop(secret, body, { path: referencePath(admitted.taskRef.id, 'read'), claims }));
    assert.equal(read(ownerClaims('ursula')).state, 'queued');
    expectError(() => read(ownerClaims('victor')), 'WorkerStateError', 'not_found');
    // Coordinator alone reads through the origin row of the binding it admitted under.
    assert.equal(read({}, { bindingId: binding }).taskRef.id, admitted.taskRef.id);
    expectError(() => read({}, { bindingId: flowId() }), 'WorkerStateError', 'not_found');
    expectError(() => read({}), 'CoordinatorAuthError', 'forbidden', 'row_missing');
    expectError(() => read(ownerClaims('ursula'), { bindingId: binding }), 'CoordinatorAuthError', 'forbidden', 'row_ambiguous');
    const events = adapter.referenceEvents(hop(secret, { after: 0, limit: 10, bindingId: binding }, { path: referencePath(admitted.taskRef.id, 'events') }));
    assert.deepEqual(events.events.map((event) => event.data), [{ state: 'queued' }]);
    expectError(() => adapter.referenceEvents(hop(secret, { after: 0, limit: 10 }, { path: referencePath(admitted.taskRef.id, 'events'), claims: ownerClaims('victor') })), 'WorkerStateError', 'not_found');
    const found = adapter.lookup(hop(secret, { originRequestId, bindingId: binding }, { path: LOOKUP_PATH }));
    assert.equal(JSON.stringify(found), JSON.stringify(admitted));
});

test('F1 pin: coordinator alone with a bindingId observes only references admitted under that binding (sentinel owner)', (t) => {
    const dir = makeTempDir(t);
    const store = openExtended(dir);
    t.after(() => store.close());
    const { secret, adapter } = rig(store);
    const robotId = workspaceRobot(store);
    const binding = rootBinding(adapter, secret, 'ursula');
    const viaBinding = adapter.admit(hop(secret, admitBody(robotId, newOriginId(), { bindingId: binding })));
    const viaGrant = adapter.admit(hop(secret, admitBody(robotId, newOriginId()), { claims: ownerClaims('ursula') }));
    const read = (id) => adapter.readReference(hop(secret, { bindingId: binding }, { path: referencePath(id, 'read') }));
    const events = (id) => adapter.referenceEvents(hop(secret, { after: 0, limit: 10, bindingId: binding }, { path: referencePath(id, 'events') }));
    assert.equal(read(viaBinding.taskRef.id).taskRef.id, viaBinding.taskRef.id);
    assert.equal(events(viaBinding.taskRef.id).events.length, 1);
    // The same owner's reference admitted through her grant is invisible to the coordinator alone.
    expectError(() => read(viaGrant.taskRef.id), 'WorkerStateError', 'not_found');
    expectError(() => events(viaGrant.taskRef.id), 'WorkerStateError', 'not_found');
    // The owner herself still sees both.
    for (const id of [viaBinding.taskRef.id, viaGrant.taskRef.id]) {
        assert.equal(adapter.readReference(hop(secret, {}, { path: referencePath(id, 'read'), claims: ownerClaims('ursula') })).taskRef.id, id);
    }
});

test('M-14: an answer is accepted only from the reference\'s bound owner and only for a request of that very reference', (t) => {
    const dir = makeTempDir(t);
    const store = openExtended(dir);
    t.after(() => store.close());
    const { secret, adapter } = rig(store);
    const robotId = workspaceRobot(store);
    const service = syntheticContext({ scope: 'scope-adapter' });
    const asked = (owner) => {
        const admitted = adapter.admit(hop(secret, admitBody(robotId, newOriginId()), { claims: ownerClaims(owner) }));
        const { executionId, attemptId } = attemptOf(dir, admitted.taskRef.id);
        store.transitionAttempt({ executionId, attemptId, expectedState: 'queued', nextState: 'running' });
        const requestId = crypto.randomBytes(16).toString('base64url');
        store.recordChannelEvent({ executionId, attemptId, type: 'human-input-request', data: { requestId, question: 'Ship it?', options: ['a', 'b', 'c'] } });
        store.beginAttemptEnd(service, { executionId, attemptId, expectedState: 'running', outcome: { classification: 'human-input', data: { requestId } } });
        return { referenceId: admitted.taskRef.id, requestId };
    };
    const mine = asked('ursula');
    const theirs = asked('walter');
    const answer = (reference, requestId, claims, answerText = 'yes') => adapter.controlReference(hop(secret,
        { operationId: newId(), op: 'answer', payload: { requestId, answer: answerText } }, { path: referencePath(reference, 'control'), claims }));
    // An unrelated user sees nothing of the reference; an administrator who is not the owner may not answer.
    expectError(() => answer(mine.referenceId, mine.requestId, ownerClaims('victor')), 'WorkerStateError', 'not_found');
    expectError(() => answer(mine.referenceId, mine.requestId, ownerClaims('root', ['admin'])), 'WorkerStateError', 'forbidden');
    // The coordinator alone (no grant) cannot answer an interactive question.
    expectError(() => answer(mine.referenceId, mine.requestId, {}), 'CoordinatorAuthError', 'forbidden', 'owner_evidence');
    // The owner cannot answer with the request of another reference, even one of the same coordinator.
    expectError(() => answer(mine.referenceId, theirs.requestId, ownerClaims('ursula')), 'WorkerStateError', 'not_found');
    expectError(() => answer(theirs.referenceId, mine.requestId, ownerClaims('walter')), 'WorkerStateError', 'not_found');
    assert.equal(count(dir, 'reference_control'), 0, 'every refusal recorded nothing');
    const receipt = answer(mine.referenceId, mine.requestId, ownerClaims('ursula'));
    assert.deepEqual([receipt.outcome, receipt.delivery, receipt.requestId], ['accepted', 'applied', mine.requestId]);
    assert.equal(count(dir, 'reference_control'), 1);
});

test('relayed controls: owner message ok, admin stop ok, admin message refused, coordinator-alone control refused', (t) => {
    const dir = makeTempDir(t);
    const store = openExtended(dir);
    t.after(() => store.close());
    const { secret, adapter } = rig(store);
    const robotId = workspaceRobot(store);
    const binding = rootBinding(adapter, secret, 'ursula');
    const admitted = adapter.admit(hop(secret, admitBody(robotId, newOriginId(), { bindingId: binding })));
    const { executionId, attemptId } = attemptOf(dir, admitted.taskRef.id);
    store.transitionAttempt({ executionId, attemptId, expectedState: 'queued', nextState: 'running' });
    const control = (body, claims) => adapter.controlReference(hop(secret, body, { path: referencePath(admitted.taskRef.id, 'control'), claims }));
    const message = control({ operationId: newId(), op: 'message', payload: { message: 'hello' } }, ownerClaims('ursula'));
    assert.equal(message.delivery, 'pending');
    const stop = control({ operationId: newId(), op: 'stop', attemptId }, ownerClaims('root', [' Admin ']));
    assert.equal(stop.outcome, 'accepted');
    expectError(() => control({ operationId: newId(), op: 'message', payload: { message: 'hi' } }, ownerClaims('root', ['admin'])), 'WorkerStateError', 'forbidden');
    expectError(() => control({ operationId: newId(), op: 'stop' }, {}), 'CoordinatorAuthError', 'forbidden', 'owner_evidence');
    expectError(() => control({ operationId: newId(), op: 'stop' }, ownerClaims('victor')), 'WorkerStateError', 'not_found');
    // M-12 (C): the coordinator alone with the flow binding may stop its own flow work (the pending stop is returned, not recorded again);
    // a user grant together with a bindingId is ambiguous, and a message by the binding is owner-only.
    assert.equal(control({ operationId: newId(), op: 'stop', bindingId: binding }, {}).outcome, 'accepted');
    expectError(() => control({ operationId: newId(), op: 'stop', bindingId: binding }, ownerClaims('ursula')), 'CoordinatorAuthError', 'forbidden', 'row_ambiguous');
    expectError(() => control({ operationId: newId(), op: 'message', payload: { message: 'x' }, bindingId: binding }, {}), 'WorkerStateError', 'forbidden');
    assert.equal(count(dir, 'reference_control'), 2);
});

test('unmapped ops are refused before any state access; burning the token is the only store call', (t) => {
    const dir = makeTempDir(t);
    const real = openExtended(dir);
    t.after(() => real.close());
    const calls = [];
    const spy = new Proxy(real, {
        get(target, name) {
            const value = target[name];
            if (typeof value !== 'function') return value;
            return (...args) => {
                calls.push(name);
                return value.apply(target, args);
            };
        }
    });
    const secret = crypto.randomBytes(32);
    const verifier = createVerifierConfig({ secret, audience: PROVIDER_PRINCIPAL, coordinators: [COORDINATOR], replayCache: createReplayCache() });
    const adapter = createCoordinatorAdapter({ store: spy, workspaceId: WORKSPACE, verifier });
    const unknownReference = crypto.randomBytes(16).toString('base64url');
    for (const op of ['take-control', 'resume']) {
        calls.length = 0;
        expectError(() => adapter.controlReference(hop(secret, { operationId: newId(), op }, { path: referencePath(unknownReference, 'control'), claims: ownerClaims('alice') })),
            'CoordinatorAuthError', 'operation_unavailable', 'operation_unmapped');
        assert.deepEqual(calls, ['consumeTokenIds']);
    }
    for (const op of ['input', 'resize']) {
        calls.length = 0;
        expectError(() => adapter.controlReference(hop(secret, { operationId: newId(), op }, { path: referencePath(unknownReference, 'control'), claims: ownerClaims('alice') })),
            'WorkerStateError', 'invalid_request');
        assert.deepEqual(calls, ['consumeTokenIds']);
    }
    assert.equal(count(dir, 'token_replay'), 4);
});

test('lifecycle: administrator grant only, lifecycle-scope receipts; robot and operation reads for the coordinator', (t) => {
    const dir = makeTempDir(t);
    const store = openExtended(dir);
    t.after(() => store.close());
    const { secret, adapter } = rig(store);
    const robots = `${BASE}/robots`;
    const body = () => ({ operationId: newId(), name: 'Robot', configuration: { backend: 'synthetic' } });
    expectError(() => adapter.provision(hop(secret, body(), { path: `${robots}/provision` })), 'CoordinatorAuthError', 'forbidden', 'owner_evidence');
    expectError(() => adapter.provision(hop(secret, body(), { path: `${robots}/provision`, claims: ownerClaims('bob') })), 'CoordinatorAuthError', 'forbidden', 'administrator');
    expectError(() => adapter.provision(hop(secret, { ...body(), ownerId: 'user:root' }, { path: `${robots}/provision`, claims: ownerClaims('root', ['admin']) })), 'WorkerStateError', 'invalid_request');
    assert.equal(count(dir, 'robot'), 0);
    const request = body();
    const accepted = adapter.provision(hop(secret, request, { path: `${robots}/provision`, claims: ownerClaims('root', ['Admin']) }));
    assert.equal(accepted.type, 'provision');
    const db = rawDb(dir, { readOnly: true });
    try {
        assert.equal(db.prepare('SELECT owner_id FROM robot WHERE id = ?').get(accepted.robotId).owner_id, ROBOTS);
    } finally {
        db.close();
    }
    // Coordinator reads, alone and with any grant, in the lifecycle scope.
    const list = adapter.listRobots(hop(secret, {}, { path: `${robots}/list` }));
    assert.deepEqual(list.robots.map((robot) => robot.robotId), [accepted.robotId]);
    assert.equal(adapter.getRobot(hop(secret, { robotId: accepted.robotId }, { path: `${robots}/get`, claims: ownerClaims('bob') })).lifecycle, 'provisioning');
    const outcome = adapter.getOperation(hop(secret, { operationId: request.operationId }, { path: `${BASE}/operations/get` }));
    assert.equal(outcome.status, 'pending');
    // Another administrator manages the same workspace robot.
    // M-29: a robot whose creation is pending cannot be deleted yet.
    expectError(() => adapter.delete(hop(secret, { operationId: newId(), robotId: accepted.robotId, expectedRevision: 0 }, { path: `${robots}/delete`, claims: ownerClaims('other', ['admin']) })), 'WorkerStateError', 'robot_busy');
    expectError(() => adapter.delete(hop(secret, { operationId: newId(), robotId: accepted.robotId, expectedRevision: 0 }, { path: `${robots}/delete`, claims: ownerClaims('bob') })), 'CoordinatorAuthError', 'forbidden', 'administrator');
    assert.equal(adapter.getRobot(hop(secret, { robotId: accepted.robotId }, { path: `${robots}/get` })).lifecycle, 'provisioning');
    expectError(() => adapter.listRobots(hop(secret, { extra: 1 }, { path: `${robots}/list` })), 'WorkerStateError', 'invalid_request');
    expectError(() => adapter.provision(hop(secret, body(), { path: `${robots}/list`, claims: ownerClaims('root', ['admin']) })), 'WorkerStateError', 'invalid_request');
});

// ---- S6 source-only subset, Part A (step W1) ------------------------------------------------

const MAILER = 'agent:RoboRepo/mailer';
const MAILER_CALLER = Object.freeze({ sub: MAILER, actor: { kind: 'agent', id: MAILER }, caller: { kind: 'agent', id: MAILER } });
const SESSION_TABLES = [...DURABLE, 'session'];

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

function turnBody(robotId, originRequestId, sessionKey, extra = {}) {
    return admitBody(robotId, originRequestId, { kind: 'turn', logical: { sessionKey }, specification: { version: 1, prompt: 'synthetic turn' }, ...extra });
}

function sessionCounts(dir) {
    return Object.fromEntries(SESSION_TABLES.map((table) => [table, count(dir, table)]));
}

function twoCoordinatorRig(store, secret = crypto.randomBytes(32)) {
    const verifier = createVerifierConfig({ secret, audience: PROVIDER_PRINCIPAL, coordinators: [COORDINATOR, MAILER], replayCache: createReplayCache() });
    return { secret, adapter: createCoordinatorAdapter({ store, workspaceId: WORKSPACE, verifier }) };
}

const OBLIGATIONS_PATH = `${BASE}/obligations`;

function obligationPath(id, action) {
    return `${BASE}/obligations/${id}/${action}`;
}

// A generation binding created the only way one can be: a generation obligation admitted with
// `userId`'s grant, then accepted by the coordinator alone (S6 Part D).
function generationBinding(adapter, secret, userId) {
    const bindingId = `gen_${crypto.randomBytes(12).toString('hex')}`;
    const admitted = adapter.admitObligation(hop(secret, { originRequestId: newOriginId(), obligationKind: 'generation', request: { ticket: 'synthetic' } },
        { path: OBLIGATIONS_PATH, claims: ownerClaims(userId) }));
    const decision = adapter.acceptObligation(hop(secret, { operationId: newId(), domainRecordId: bindingId }, { path: obligationPath(admitted.taskRef.id, 'accept') }));
    assert.equal(decision.decision, 'accepted');
    return bindingId;
}

test('turn through the coordinator-API row: admitted queued, logical.kind session; a second turn shares logical.id and links the first (synthetic runtime)', (t) => {
    const dir = makeTempDir(t);
    const store = openExtended(dir);
    t.after(() => store.close());
    const { secret, adapter } = rig(store);
    const robotId = workspaceRobot(store);
    const first = adapter.admit(hop(secret, turnBody(robotId, newOriginId(), 'conv-adapter'), { claims: ownerClaims('alice') }));
    assert.deepEqual(Object.keys(first), ['taskRef', 'state', 'originRequestId']);
    assert.equal(first.state, 'queued');
    const attempt = attemptOf(dir, first.taskRef.id);
    store.transitionAttempt({ ...attempt, expectedState: 'queued', nextState: 'running' });
    const second = succeeds(() => adapter.admit(hop(secret, turnBody(robotId, newOriginId(), 'conv-adapter'), { claims: ownerClaims('alice') })),
        'a second turn is admitted while the first is running');
    assert.equal(second.state, 'queued', 'admitted queued while the first turn runs');
    const read = (id) => adapter.readReference(hop(secret, {}, { path: referencePath(id, 'read'), claims: ownerClaims('alice') }));
    const one = read(first.taskRef.id);
    const two = read(second.taskRef.id);
    assert.equal(one.logical.kind, 'session');
    assert.equal(two.logical.kind, 'session');
    assert.equal(two.logical.id, one.logical.id);
    assert.equal(one.logical.id.length, 22);
    assert.deepEqual(two.linked, { previousTaskRef: first.taskRef });
    assert.equal(count(dir, 'session'), 1);
    // The second turn waits for the first (first in, first out).
    expectError(() => store.transitionAttempt({ ...attemptOf(dir, second.taskRef.id), expectedState: 'queued', nextState: 'running' }), 'WorkerStateError', 'robot_busy');
    // Another user's turn with the same conversation ID is a different session and sees nothing.
    const other = succeeds(() => adapter.admit(hop(secret, turnBody(robotId, newOriginId(), 'conv-adapter'), { claims: ownerClaims('victor') })),
        "another user's turn with the same conversation ID is admitted");
    assert.notEqual(adapter.readReference(hop(secret, {}, { path: referencePath(other.taskRef.id, 'read'), claims: ownerClaims('victor') })).logical.id, one.logical.id);
    expectError(() => adapter.readReference(hop(secret, {}, { path: referencePath(first.taskRef.id, 'read'), claims: ownerClaims('victor') })), 'WorkerStateError', 'not_found');
});

test('turn row check and precedence: row-selection refusals first, then a turn on the MCP or background row is invalid_request with zero rows', (t) => {
    const dir = makeTempDir(t);
    const store = openExtended(dir);
    t.after(() => store.close());
    const { secret, adapter } = rig(store);
    const robotId = workspaceRobot(store);
    const binding = rootBinding(adapter, secret, 'alice');
    const before = sessionCounts(dir);
    // Owner grant plus bindingId: forbidden (row_ambiguous) before any turn check.
    expectError(() => adapter.admit(hop(secret, turnBody(robotId, newOriginId(), 'c', { bindingId: binding }), { claims: ownerClaims('alice') })),
        'CoordinatorAuthError', 'forbidden', 'row_ambiguous');
    // No row evidence at all: forbidden (row_missing).
    expectError(() => adapter.admit(hop(secret, turnBody(robotId, newOriginId(), 'c'))), 'CoordinatorAuthError', 'forbidden', 'row_missing');
    // MCP origin token for another serving agent: the origin refusal keeps precedence.
    const foreignId = newOriginId();
    expectError(() => adapter.admit(hop(secret, turnBody(robotId, foreignId, 'c', {
        taskRefOrigin: originTokenFor(secret, { originRequestId: foreignId, agent: OTHER_AGENT }), originTool: 'runRobotTask'
    }))), 'CoordinatorAuthError', 'forbidden', 'origin_agent');
    // After row selection: a valid MCP origin token or a registered binding gives invalid_request.
    const mcpId = newOriginId();
    expectError(() => adapter.admit(hop(secret, turnBody(robotId, mcpId, 'c', {
        taskRefOrigin: originTokenFor(secret, { originRequestId: mcpId }), originTool: 'runRobotTask'
    }))), 'WorkerStateError', 'invalid_request');
    expectError(() => adapter.admit(hop(secret, turnBody(robotId, newOriginId(), 'c', { bindingId: binding }))), 'WorkerStateError', 'invalid_request');
    // An unregistered binding is a row-selection refusal: not_found, not the turn check.
    expectError(() => adapter.admit(hop(secret, turnBody(robotId, newOriginId(), 'c', { bindingId: flowId() }))), 'WorkerStateError', 'not_found');
    assert.deepEqual(sessionCounts(dir), before);
});

test('background-row phases publish logical.kind flow with the flow ID as logical.id; a coordinator task publishes task (synthetic runtime)', (t) => {
    const dir = makeTempDir(t);
    const store = openExtended(dir);
    t.after(() => store.close());
    const { secret, adapter } = rig(store);
    const robotId = workspaceRobot(store);
    const binding = rootBinding(adapter, secret, 'alice');
    const one = adapter.admit(hop(secret, admitBody(robotId, newOriginId(), { bindingId: binding })));
    const two = adapter.admit(hop(secret, admitBody(robotId, newOriginId(), { bindingId: binding })));
    const task = adapter.admit(hop(secret, admitBody(robotId, newOriginId()), { claims: ownerClaims('alice') }));
    const readAlone = (id) => adapter.readReference(hop(secret, { bindingId: binding }, { path: referencePath(id, 'read') }));
    const readOwner = (id) => adapter.readReference(hop(secret, {}, { path: referencePath(id, 'read'), claims: ownerClaims('alice') }));
    assert.deepEqual(readAlone(one.taskRef.id).logical, { kind: 'flow', id: binding });
    assert.deepEqual(readAlone(two.taskRef.id).logical, { kind: 'flow', id: binding });
    assert.deepEqual(readOwner(two.taskRef.id).logical, { kind: 'flow', id: binding }, 'the owner sees the same wire logical');
    assert.equal(readOwner(task.taskRef.id).logical.kind, 'task');
    // Both phases share the internal logical ID derived from the coordinator and the binding.
    const db = rawDb(dir, { readOnly: true });
    try {
        const rows = db.prepare("SELECT logical_id, logical_kind FROM admission WHERE logical_kind = 'flow'").all();
        assert.equal(rows.length, 2);
        assert.ok(rows.every((row) => row.logical_id === deriveFlowLogicalId(COORDINATOR, binding)));
    } finally {
        db.close();
    }
});

test('background-row continuation is operation_unavailable before state access with zero rows', (t) => {
    const dir = makeTempDir(t);
    const store = openExtended(dir);
    t.after(() => store.close());
    const { secret, adapter } = rig(store);
    const robotId = workspaceRobot(store);
    const binding = rootBinding(adapter, secret, 'alice');
    adapter.admit(hop(secret, admitBody(robotId, newOriginId(), { bindingId: binding })));
    const before = sessionCounts(dir);
    for (const logicalId of [deriveFlowLogicalId(COORDINATOR, binding), newId()]) {
        expectError(() => adapter.admit(hop(secret, admitBody(robotId, newOriginId(), { bindingId: binding, kind: 'continuation', logical: { logicalId } }))),
            'CoordinatorAuthError', 'operation_unavailable', 'operation_unmapped');
    }
    // An unknown robot would be not_found in the store: the refusal precedes state access.
    expectError(() => adapter.admit(hop(secret, admitBody(newId(), newOriginId(), { bindingId: binding, kind: 'continuation', logical: { logicalId: newId() } }))),
        'CoordinatorAuthError', 'operation_unavailable', 'operation_unmapped');
    assert.deepEqual(sessionCounts(dir), before);
});

test('cron_ admission is invalid_request; a coordinator cron_ lookup of an unknown origin is not_found', (t) => {
    const dir = makeTempDir(t);
    const store = openExtended(dir);
    t.after(() => store.close());
    const { secret, adapter } = rig(store);
    const robotId = workspaceRobot(store);
    const schedule = `cron_${crypto.randomBytes(12).toString('hex')}.r2`;
    adapter.bind(hop(secret, { operationId: newId(), bindingId: schedule }, { path: BIND_PATH, claims: ownerClaims('alice') }));
    const before = sessionCounts(dir);
    expectError(() => adapter.admit(hop(secret, admitBody(robotId, newOriginId(), { bindingId: schedule }))), 'CoordinatorAuthError', 'invalid_request', 'binding');
    assert.deepEqual(sessionCounts(dir), before);
    expectError(() => adapter.lookup(hop(secret, { originRequestId: newOriginId(), bindingId: schedule }, { path: LOOKUP_PATH })), 'WorkerStateError', 'not_found');
    expectError(() => adapter.lookup(hop(secret, { originRequestId: newOriginId(), bindingId: `cron_${'0'.repeat(24)}.r1` }, { path: LOOKUP_PATH })), 'WorkerStateError', 'not_found');
    expectError(() => adapter.lookup(hop(secret, { originRequestId: newOriginId(), bindingId: 'cron_bad' }, { path: LOOKUP_PATH })), 'CoordinatorAuthError', 'invalid_request', 'binding');
});

test('N-5 gen_ reads: the coordinator alone reads, lists events of and looks up the reference admitted under its gen_ binding; another coordinator gets not_found', (t) => {
    const dir = makeTempDir(t);
    const store = openExtended(dir);
    t.after(() => store.close());
    const { secret, adapter } = twoCoordinatorRig(store);
    const robotId = workspaceRobot(store);
    const genId = generationBinding(adapter, secret, 'alice');
    const originRequestId = newOriginId();
    const admitted = adapter.admit(hop(secret, admitBody(robotId, originRequestId, { bindingId: genId })));
    const id = admitted.taskRef.id;
    const read = (claims = {}) => adapter.readReference(hop(secret, { bindingId: genId }, { path: referencePath(id, 'read'), claims }));
    const events = (claims = {}) => adapter.referenceEvents(hop(secret, { after: 0, limit: 10, bindingId: genId }, { path: referencePath(id, 'events'), claims }));
    const lookup = (claims = {}) => adapter.lookup(hop(secret, { originRequestId, bindingId: genId }, { path: LOOKUP_PATH, claims }));
    assert.deepEqual(succeeds(read, 'the admitting coordinator reads under its gen_ binding').logical, { kind: 'flow', id: genId });
    assert.equal(succeeds(events, 'the admitting coordinator lists events under its gen_ binding').events.length, 1);
    assert.deepEqual(succeeds(lookup, 'the admitting coordinator looks up under its gen_ binding'), admitted);
    expectError(() => read(MAILER_CALLER), 'WorkerStateError', 'not_found');
    expectError(() => events(MAILER_CALLER), 'WorkerStateError', 'not_found');
    expectError(() => lookup(MAILER_CALLER), 'WorkerStateError', 'not_found');
    // An unregistered gen_ binding answers not_found for reads too.
    expectError(() => adapter.readReference(hop(secret, { bindingId: `gen_${'f'.repeat(24)}` }, { path: referencePath(id, 'read') })), 'WorkerStateError', 'not_found');
});

test('N-5 cron_ parent: a derived flow binding under a cron_ parent registers at depth 1 with the parent owner', (t) => {
    const dir = makeTempDir(t);
    const store = openExtended(dir);
    t.after(() => store.close());
    const { secret, adapter } = rig(store);
    const schedule = `cron_${crypto.randomBytes(12).toString('hex')}.r1`;
    adapter.bind(hop(secret, { operationId: newId(), bindingId: schedule }, { path: BIND_PATH, claims: ownerClaims('ursula') }));
    const child = flowId();
    const derived = succeeds(() => adapter.bind(hop(secret, { operationId: newId(), bindingId: child, parentBindingId: schedule }, { path: BIND_PATH })),
        'a derived flow under a cron_ parent registers');
    assert.deepEqual([derived.status, derived.parentBindingId, derived.kind], ['registered', schedule, 'flow']);
    assert.deepEqual(store.readBindingOwner({ coordinator: COORDINATOR, bindingId: child }), { ownerId: 'user:ursula' });
    const db = rawDb(dir, { readOnly: true });
    try {
        const row = db.prepare('SELECT depth, root_binding_id, evidence FROM binding WHERE binding_id = ?').get(child);
        assert.deepEqual({ ...row }, { depth: 1, root_binding_id: schedule, evidence: 'derived' });
    } finally {
        db.close();
    }
});

test('/bindings refuses a gen_ root and a gen_ parent with operation_unavailable and zero binding rows', (t) => {
    const dir = makeTempDir(t);
    const store = openExtended(dir);
    t.after(() => store.close());
    const { secret, adapter } = rig(store);
    const genId = `gen_${crypto.randomBytes(12).toString('hex')}`;
    expectError(() => adapter.bind(hop(secret, { operationId: newId(), bindingId: genId }, { path: BIND_PATH, claims: ownerClaims('alice') })),
        'CoordinatorAuthError', 'operation_unavailable', 'operation_unmapped');
    expectError(() => adapter.bind(hop(secret, { operationId: newId(), bindingId: flowId(), parentBindingId: genId }, { path: BIND_PATH })),
        'CoordinatorAuthError', 'operation_unavailable', 'operation_unmapped');
    assert.equal(count(dir, 'binding'), 0);
    // Even a registered gen_ binding cannot parent a derived binding through /bindings.
    const registered = generationBinding(adapter, secret, 'alice');
    expectError(() => adapter.bind(hop(secret, { operationId: newId(), bindingId: flowId(), parentBindingId: registered }, { path: BIND_PATH })),
        'CoordinatorAuthError', 'operation_unavailable', 'operation_unmapped');
    assert.equal(count(dir, 'binding'), 1);
});

test('default runtime: turn admission is runtime_unavailable with zero admission, origin, reference and session rows', (t) => {
    const dir = makeTempDir(t);
    const setupStore = openExtended(dir);
    const robotId = workspaceRobot(setupStore);
    setupStore.close();
    const before = sessionCounts(dir);
    const store = openWorkerState({ dataDir: dir, workspaceId: WORKSPACE, provider: PROVIDER, limits: EXTENDED });
    t.after(() => store.close());
    const { secret, adapter } = rig(store);
    expectError(() => adapter.admit(hop(secret, turnBody(robotId, newOriginId(), 'conv-default'), { claims: ownerClaims('alice') })), 'WorkerStateError', 'runtime_unavailable');
    assert.deepEqual(sessionCounts(dir), before);
    assert.deepEqual([count(dir, 'admission'), count(dir, 'session')], [0, 0]);
});

// ---- S6 source-only subset, Part D (step W2): obligation routes ---------------------------

function obligationBody(originRequestId = newOriginId(), extra = {}) {
    return { originRequestId, obligationKind: 'flow-launch', request: { flow: 'synthetic' }, ...extra };
}

function obligationCounts(dir) {
    return Object.fromEntries(['receipt', 'obligation', 'reference', 'origin', 'binding'].map((table) => [table, count(dir, table)]));
}

function admitObligationAs(adapter, secret, userId, extra = {}) {
    return adapter.admitObligation(hop(secret, obligationBody(newOriginId(), extra), { path: OBLIGATIONS_PATH, claims: ownerClaims(userId) }));
}

test('obligation admission: coordinator-API and MCP rows admit pending-coordinator; background-row evidence, a missing row and ambiguity are forbidden (synthetic runtime)', (t) => {
    const dir = makeTempDir(t);
    const store = openExtended(dir);
    t.after(() => store.close());
    const { secret, adapter } = rig(store);
    const owner = admitObligationAs(adapter, secret, 'alice');
    assert.deepEqual(Object.keys(owner), ['taskRef', 'state', 'originRequestId']);
    assert.equal(owner.state, 'pending-coordinator');
    const mcpId = newOriginId();
    const mcp = adapter.admitObligation(hop(secret, obligationBody(mcpId, {
        obligationKind: 'generation', taskRefOrigin: originTokenFor(secret, { originRequestId: mcpId }), originTool: 'runRobotTask'
    }), { path: OBLIGATIONS_PATH }));
    assert.equal(mcp.state, 'pending-coordinator');
    const db = rawDb(dir, { readOnly: true });
    try {
        const row = db.prepare('SELECT coordinator, owner_id FROM obligation WHERE obligation_id = ?').get(mcp.taskRef.id);
        assert.deepEqual({ ...row }, { coordinator: COORDINATOR, owner_id: 'user:alice' });
    } finally {
        db.close();
    }
    const binding = rootBinding(adapter, secret, 'alice');
    const before = obligationCounts(dir);
    expectError(() => adapter.admitObligation(hop(secret, obligationBody(newOriginId(), { bindingId: binding }), { path: OBLIGATIONS_PATH })),
        'CoordinatorAuthError', 'forbidden', 'binding');
    expectError(() => adapter.admitObligation(hop(secret, obligationBody(newOriginId(), { bindingId: binding }), { path: OBLIGATIONS_PATH, claims: ownerClaims('alice') })),
        'CoordinatorAuthError', 'forbidden', 'row_ambiguous');
    expectError(() => adapter.admitObligation(hop(secret, obligationBody(), { path: OBLIGATIONS_PATH })), 'CoordinatorAuthError', 'forbidden', 'row_missing');
    const foreignId = newOriginId();
    expectError(() => adapter.admitObligation(hop(secret, obligationBody(foreignId, {
        taskRefOrigin: originTokenFor(secret, { originRequestId: foreignId, agent: OTHER_AGENT }), originTool: 'runRobotTask'
    }), { path: OBLIGATIONS_PATH })), 'CoordinatorAuthError', 'forbidden', 'origin_agent');
    expectError(() => adapter.admitObligation(hop(secret, obligationBody(newOriginId(), { owner: 'user:mallory' }), { path: OBLIGATIONS_PATH, claims: ownerClaims('alice') })),
        'WorkerStateError', 'invalid_request');
    assert.deepEqual(obligationCounts(dir), before);
    // A lost reply is recovered through the coordinator lookup: the recorded pending-coordinator.
    const lookup = adapter.lookup(hop(secret, { originRequestId: owner.originRequestId }, { path: LOOKUP_PATH, claims: ownerClaims('alice') }));
    assert.deepEqual(lookup, owner);
});

test('accept, reject, outbox and list through real tokens: 200 recorded decisions; a user grant is forbidden; another declared coordinator gets not_found', (t) => {
    const dir = makeTempDir(t);
    const store = openExtended(dir);
    t.after(() => store.close());
    const { secret, adapter } = twoCoordinatorRig(store);
    const admitted = admitObligationAs(adapter, secret, 'alice');
    const id = admitted.taskRef.id;
    const flow = flowId();
    const acceptBody = { operationId: newId(), domainRecordId: flow };
    expectError(() => adapter.acceptObligation(hop(secret, acceptBody, { path: obligationPath(id, 'accept'), claims: ownerClaims('alice') })),
        'CoordinatorAuthError', 'forbidden', 'row_ambiguous');
    expectError(() => adapter.acceptObligation(hop(secret, acceptBody, { path: obligationPath(id, 'accept'), claims: MAILER_CALLER })), 'WorkerStateError', 'not_found');
    const accepted = adapter.acceptObligation(hop(secret, acceptBody, { path: obligationPath(id, 'accept') }));
    assert.deepEqual(accepted, { obligationId: id, decision: 'accepted', state: 'accepted', bindingId: flow, fenceRevision: 0 });
    assert.deepEqual(adapter.acceptObligation(hop(secret, acceptBody, { path: obligationPath(id, 'accept') })), accepted, 'a retry returns the same bytes');
    const listed = adapter.listObligations(hop(secret, { state: 'accepted', unbound: true, after: '', limit: 10 }, { path: `${OBLIGATIONS_PATH}/list` }));
    assert.deepEqual(listed.obligations.map((item) => [item.obligationId, item.taskRef.id, item.owner]), [[id, id, 'user:alice']]);
    assert.deepEqual(adapter.listObligations(hop(secret, { state: 'accepted', unbound: true, after: '', limit: 10 }, { path: `${OBLIGATIONS_PATH}/list`, claims: MAILER_CALLER })).obligations, []);
    const bound = adapter.applyOutbox(hop(secret, { revision: 1, fenceRevision: 0, kind: 'bound', data: {} }, { path: obligationPath(id, 'outbox') }));
    assert.deepEqual(bound, { obligationId: id, revision: 1, applied: true, state: 'accepted', fenceRevision: 0 });
    expectError(() => adapter.applyOutbox(hop(secret, { revision: 2, fenceRevision: 0, kind: 'progress', data: {} }, { path: obligationPath(id, 'outbox'), claims: MAILER_CALLER })),
        'WorkerStateError', 'not_found');
    const rejectedOne = admitObligationAs(adapter, secret, 'alice');
    const rejected = adapter.rejectObligation(hop(secret, { operationId: newId(), reason: 'not_wanted' }, { path: obligationPath(rejectedOne.taskRef.id, 'reject') }));
    assert.deepEqual(rejected, { obligationId: rejectedOne.taskRef.id, decision: 'rejected', state: 'rejected' });
    const afterAccept = adapter.rejectObligation(hop(secret, { operationId: newId(), reason: 'late' }, { path: obligationPath(id, 'reject') }));
    assert.deepEqual([afterAccept.decision, afterAccept.reason], ['refused', 'accepted']);
    expectError(() => adapter.acceptObligation(hop(secret, { operationId: newId(), domainRecordId: flow, extra: 1 }, { path: obligationPath(id, 'accept') })),
        'WorkerStateError', 'invalid_request');
    // N1 (W2 r2 review): the path ID grammar is checked before row selection, as on the
    // reference routes, so a malformed ID with a user grant is invalid_request, not forbidden.
    for (const [method, action, body] of [['acceptObligation', 'accept', { operationId: newId(), domainRecordId: flowId() }],
        ['rejectObligation', 'reject', { operationId: newId(), reason: 'x' }], ['applyOutbox', 'outbox', { revision: 1, fenceRevision: 0, kind: 'bound', data: {} }]]) {
        expectError(() => adapter[method](hop(secret, body, { path: obligationPath('A'.repeat(23), action), claims: ownerClaims('alice') })), 'WorkerStateError', 'invalid_request');
        expectError(() => adapter[method](hop(secret, body, { path: obligationPath(id, action), claims: ownerClaims('alice') })), 'CoordinatorAuthError', 'forbidden', 'row_ambiguous');
    }
    // The obligation ID is the exact S1 form: 22 canonical base64url characters.
    for (const badId of [`${id}A`, `${id.slice(0, 21)}B`, 'A'.repeat(64)]) {
        if (badId === id) continue;
        for (const action of ['accept', 'reject', 'outbox']) {
            const body = action === 'accept' ? { operationId: newId(), domainRecordId: flowId() } : action === 'reject' ? { operationId: newId(), reason: 'x' }
                : { revision: 1, fenceRevision: 0, kind: 'bound', data: {} };
            const method = { accept: 'acceptObligation', reject: 'rejectObligation', outbox: 'applyOutbox' }[action];
            expectError(() => adapter[method](hop(secret, body, { path: obligationPath(badId, action) })), 'WorkerStateError', 'invalid_request');
        }
    }
    // The background row now admits flow work under the accepted binding.
    const robotId = workspaceRobot(store);
    assert.equal(adapter.admit(hop(secret, admitBody(robotId, newOriginId(), { bindingId: flow }))).state, 'queued');
});

test('fence controls through the coordinator: owner pause and stop on an observation reference; pause on an execution reference is invalid_request', (t) => {
    const dir = makeTempDir(t);
    const store = openExtended(dir);
    t.after(() => store.close());
    const { secret, adapter } = rig(store);
    const robotId = workspaceRobot(store);
    const admitted = admitObligationAs(adapter, secret, 'alice');
    const flow = flowId();
    adapter.acceptObligation(hop(secret, { operationId: newId(), domainRecordId: flow }, { path: obligationPath(admitted.taskRef.id, 'accept') }));
    const controlAs = (id, op, claims) => adapter.controlReference(hop(secret, { operationId: newId(), op }, { path: referencePath(id, 'control'), claims }));
    expectError(() => controlAs(admitted.taskRef.id, 'pause', ownerClaims('victor')), 'WorkerStateError', 'not_found');
    const paused = controlAs(admitted.taskRef.id, 'pause', ownerClaims('alice'));
    assert.deepEqual([paused.outcome, paused.state, paused.bindingState, paused.fenceRevision], ['accepted', 'paused', 'paused', 1]);
    expectError(() => adapter.admit(hop(secret, admitBody(robotId, newOriginId(), { bindingId: flow }))), 'WorkerStateError', 'not_found');
    const snapshot = adapter.readReference(hop(secret, {}, { path: referencePath(admitted.taskRef.id, 'read'), claims: ownerClaims('alice') }));
    assert.deepEqual([snapshot.kind, snapshot.state, snapshot.logical, snapshot.obligation.fenceRevision, snapshot.attempt], ['observation', 'paused', { kind: 'flow', id: flow }, 1, undefined]);
    const cancelled = controlAs(admitted.taskRef.id, 'stop', ownerClaims('root', ['admin']));
    assert.deepEqual([cancelled.outcome, cancelled.state, cancelled.bindingState, cancelled.fenceRevision], ['accepted', 'paused', 'cancelled', 2]);
    const execution = adapter.admit(hop(secret, admitBody(robotId, newOriginId()), { claims: ownerClaims('alice') }));
    expectError(() => controlAs(execution.taskRef.id, 'pause', ownerClaims('alice')), 'WorkerStateError', 'invalid_request');
    expectError(() => controlAs(execution.taskRef.id, 'pause', ownerClaims('victor')), 'WorkerStateError', 'not_found');
});

test('D6 through the coordinator API: a non-owner of the admitting coordinator reads and lists events of a generation reference, control is forbidden; the other coordinator user gets not_found', (t) => {
    const dir = makeTempDir(t);
    const store = openExtended(dir);
    t.after(() => store.close());
    const { secret, adapter } = twoCoordinatorRig(store);
    const generation = admitObligationAs(adapter, secret, 'alice', { obligationKind: 'generation' });
    adapter.acceptObligation(hop(secret, { operationId: newId(), domainRecordId: `gen_${crypto.randomBytes(12).toString('hex')}` }, { path: obligationPath(generation.taskRef.id, 'accept') }));
    const flowObservation = admitObligationAs(adapter, secret, 'alice');
    const mailerClaims = (userId) => ({ ...MAILER_CALLER, ...ownerClaims(userId), delegation: { ...ownerClaims(userId).delegation, sourceAgentId: MAILER } });
    const read = (id, claims) => adapter.readReference(hop(secret, {}, { path: referencePath(id, 'read'), claims }));
    const events = (id, claims) => adapter.referenceEvents(hop(secret, { after: 0, limit: 10 }, { path: referencePath(id, 'events'), claims }));
    // D6-1 (worker half).
    assert.equal(succeeds(() => read(generation.taskRef.id, ownerClaims('victor')), 'V reads through the admitting coordinator').obligation.obligationKind, 'generation');
    assert.ok(succeeds(() => events(generation.taskRef.id, ownerClaims('victor')), 'V lists events through the admitting coordinator').events.length >= 2);
    // D6-5.
    expectError(() => adapter.controlReference(hop(secret, { operationId: newId(), op: 'stop' }, { path: referencePath(generation.taskRef.id, 'control'), claims: ownerClaims('victor') })),
        'WorkerStateError', 'forbidden');
    // D6-3: the other declared coordinator's user context, with a valid grant from that coordinator.
    expectError(() => read(generation.taskRef.id, mailerClaims('victor')), 'WorkerStateError', 'not_found');
    expectError(() => events(generation.taskRef.id, mailerClaims('victor')), 'WorkerStateError', 'not_found');
    assert.equal(read(generation.taskRef.id, mailerClaims('alice')).state, 'accepted', 'the owner reads through either coordinator');
    expectError(() => read(flowObservation.taskRef.id, ownerClaims('victor')), 'WorkerStateError', 'not_found');
});

test('default runtime: obligation admission is runtime_unavailable with zero obligation, reference and origin rows', (t) => {
    const dir = makeTempDir(t);
    const setupStore = openExtended(dir);
    workspaceRobot(setupStore);
    setupStore.close();
    const before = obligationCounts(dir);
    const store = openWorkerState({ dataDir: dir, workspaceId: WORKSPACE, provider: PROVIDER, limits: EXTENDED });
    t.after(() => store.close());
    const { secret, adapter } = rig(store);
    expectError(() => admitObligationAs(adapter, secret, 'alice'), 'WorkerStateError', 'runtime_unavailable');
    assert.deepEqual(obligationCounts(dir), before);
    assert.equal(count(dir, 'obligation'), 0);
});

// r10 Q1 = A (AC14, second half): existing-agent environments are not available. A nonempty Environment selection is refused
// during admission validation, before any row is written and before the dispatcher could start a process, on every row
// (owner, MCP, background) and for every kind (task, continuation, turn) and for the obligation request. The dispatcher
// below runs over the same real store with a counting factory; the blank-Environment control proves the counter can move.
test('AC14: a nonempty Environment admission is refused environment_unavailable with zero rows and zero process starts', async (t) => {
    const dir = makeTempDir(t);
    const store = openExtended(dir);
    t.after(() => store.close());
    const { secret, adapter } = rig(store);
    const robotId = workspaceRobot(store);
    const binding = rootBinding(adapter, secret, 'alice');
    const specV2 = (extra = {}) => ({
        version: 2, prompt: 'native prompt', displayText: 'plain', sessionId: 'session-env-1', turnId: 'turn-1', cwd: '/ws/proj',
        permissions: 'full-access', ...extra
    });
    const spawns = [];
    const factory = { async open({ item }) { spawns.push(item.executionId); throw new Error('counted start'); } };
    const dispatcher = createDispatcher({
        store, workspaceId: WORKSPACE, workspaceRoot: '/ws', factory,
        options: { pollMs: 10, controlPollMs: 10, drainMs: 100, exitGraceMs: 80, failureAbortMs: 20 }
    });
    t.after(() => dispatcher.close());
    dispatcher.start();
    const before = counts(dir);
    const beforeObligations = obligationCounts(dir);
    const environment = 'Repo/agent';
    const owner = (extra, specification) => hop(secret, admitBody(robotId, newOriginId(), { specification, ...extra }), { claims: ownerClaims('alice') });
    const refused = {
        'owner task, v2': owner({}, specV2({ environment })),
        'owner task, legacy specification': owner({}, { prompt: 'legacy', environment }),
        'owner task, blank-space value': owner({}, specV2({ environment: ' ' })),
        'MCP task': hop(secret, mcpBody(secret, robotId, newOriginId(), {}, { specification: specV2({ environment }) })),
        'background task': hop(secret, admitBody(robotId, newOriginId(), { bindingId: binding, specification: specV2({ environment }) })),
        'owner continuation': owner({ kind: 'continuation', logical: { logicalId: newId() } }, specV2({ environment })),
        'MCP continuation': hop(secret, mcpBody(secret, robotId, newOriginId(), {}, { kind: 'continuation', logical: { logicalId: newId() }, specification: specV2({ environment }) })),
        'owner turn, v2': hop(secret, turnBody(robotId, newOriginId(), 'conv-env', { specification: specV2({ environment }) }), { claims: ownerClaims('alice') }),
        'owner turn, v1': hop(secret, turnBody(robotId, newOriginId(), 'conv-env', { specification: { version: 1, prompt: 'x', environment } }), { claims: ownerClaims('alice') })
    };
    for (const [label, request] of Object.entries(refused)) {
        assert.throws(() => adapter.admit(request), (error) => error.name === 'WorkerStateError' && error.code === 'environment_unavailable', label);
    }
    expectError(() => adapter.admit(owner({}, specV2({ environment: 7 }))), 'WorkerStateError', 'invalid_request');
    // The obligation request is an admission-time payload too.
    expectError(() => adapter.admitObligation(hop(secret, obligationBody(newOriginId(), { request: { flow: 'synthetic', environment } }), { path: OBLIGATIONS_PATH, claims: ownerClaims('alice') })),
        'WorkerStateError', 'environment_unavailable');
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.deepEqual(counts(dir), before);
    assert.deepEqual(obligationCounts(dir), beforeObligations);
    assert.equal(count(dir, 'admission'), 0);
    assert.equal(count(dir, 'session'), 0);
    assert.equal(spawns.length, 0, 'no process start for a refused Environment');
    // Controls: a blank Environment is the ordinary worker backend and reaches the factory.
    const control = adapter.admit(owner({}, specV2({ environment: '' })));
    assert.equal(control.state, 'queued');
    for (let waited = 0; spawns.length === 0 && waited < 2000; waited += 10) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(spawns.length, 1, 'the counter moves for the ordinary backend');
});

test('T5 models and agent-status authorize exactly as robots/get before touching the utility cache', async (t) => {
    const dir = makeTempDir(t);
    const store = openExtended(dir);
    t.after(() => store.close());
    const robotId = readyRobot(store, syntheticContext({ robotOwnerId: ROBOTS, scope: 'robots' }));
    const { secret } = rig(store);
    const reads = [];
    const verifier = createVerifierConfig({ secret, audience: PROVIDER_PRINCIPAL, coordinators: [COORDINATOR], replayCache: createReplayCache() });
    const adapter = createCoordinatorAdapter({ store, workspaceId: WORKSPACE, verifier, utilities: { read: (...args) => { reads.push(args); return { cached: true }; } } });
    for (const [method, suffix, extra] of [['models', 'models', { agent: 'codex' }], ['agentStatus', 'agent-status', {}]]) {
        const path = `${BASE}/robots/${suffix}`;
        const request = hop(secret, { robotId, ...extra }, { path });
        assert.deepEqual(await adapter[method](request), { cached: true });
        const before = reads.length;
        assert.throws(() => adapter[method](request), (error) => error.code === 'unauthorized');
        assert.throws(() => adapter[method](hop(secret, { robotId, ...extra }, { path, claims: OTHER_CALLER })), (error) => error.code === 'forbidden');
        assert.throws(() => adapter[method](hop(secret, { robotId: newId(), ...extra }, { path })), (error) => error.code === 'not_found');
        assert.throws(() => adapter[method](hop(secret, { robotId, ...extra, ownerId: 'user:injected' }, { path })), (error) => error.code === 'invalid_request');
        assert.equal(reads.length, before);
    }
});
