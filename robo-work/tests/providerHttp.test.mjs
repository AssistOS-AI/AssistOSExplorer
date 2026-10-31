import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { Readable } from 'node:stream';
import { WorkerStateError, openWorkerState } from '../server/workerState.mjs';
import {
    COORDINATOR_ADMISSION_TOOL, CoordinatorAuthError, TASK_REFERENCE_TOOL, computeRchHttp, createReplayCache, createVerifierConfig, rawBodyHash
} from '../server/coordinatorAuth.mjs';
import { createCoordinatorAdapter } from '../server/coordinatorAdapter.mjs';
import { createTaskReferenceAdapter } from '../server/taskReferenceAdapter.mjs';
import { createCoordinatorHttpHandler, createTaskReferenceHttpHandler, parseTarget } from '../server/providerHttp.mjs';
import { LIMITS, PROVIDER, WORKSPACE, count, makeTempDir, newOriginId, openStore, readyRobot, syntheticContext } from './helpers/synthetic.mjs';

// HTTP layer over in-memory requests and responses (no socket, no listener). Route and
// error-mapping tests use a recording STUB adapter to exercise this layer alone; the
// end-to-end cases use the real adapters, real HS256 tokens and the real S1/S1x store
// (synthetic or default runtime as labelled).

const PROVIDER_PRINCIPAL = 'agent:RoboRepo/robo-work';
const COORDINATOR = 'agent:RoboRepo/roboTeamAgent';
const BASE = '/v1/task-refs';
const EXTENDED = Object.freeze({ ...LIMITS, bindings: 8, controls: 8, tokenReplayEntries: 64 });
const ROBOTS = `workspace:${WORKSPACE}`;
const REF = 'A'.repeat(22);

function request({ method = 'POST', url, headers = {}, body = Buffer.alloc(0) }) {
    const req = Readable.from(body.length > 0 ? [body] : []);
    req.method = method;
    req.url = url;
    req.headers = headers;
    return req;
}

function response() {
    return {
        statusCode: 0, headers: {}, body: null,
        setHeader(name, value) { this.headers[name.toLowerCase()] = value; },
        end(payload) { this.body = payload === undefined ? null : JSON.parse(payload); }
    };
}

async function call(handler, options) {
    const res = response();
    await handler(request(options), res);
    return res;
}

function recordingAdapter(names, result = { ok: true }) {
    const calls = [];
    const adapter = {};
    for (const name of names) {
        adapter[name] = (req) => {
            calls.push({ name, path: req.path, query: req.query, method: req.method, body: req.body.toString('utf8'), authInfo: req.authInfo });
            return typeof result === 'function' ? result(name) : result;
        };
    }
    return { adapter, calls };
}

const COORDINATOR_METHODS = ['admit', 'lookup', 'bind', 'readReference', 'referenceEvents', 'controlReference', 'provision', 'configure', 'delete', 'listRobots', 'getRobot', 'getOperation',
    'admitObligation', 'listObligations', 'acceptObligation', 'rejectObligation', 'applyOutbox'];
const TASK_METHODS = ['read', 'events', 'control', 'lookup'];

test('coordinator route table: every route dispatches exactly; unknown paths and methods are 404 without an adapter call', async () => {
    const { adapter, calls } = recordingAdapter(COORDINATOR_METHODS);
    const handler = createCoordinatorHttpHandler({ adapter, limits: LIMITS });
    const routes = [
        ['/v1/coordinator/admissions', 'admit'], ['/v1/coordinator/lookup', 'lookup'], ['/v1/coordinator/bindings', 'bind'],
        [`/v1/coordinator/references/${REF}/read`, 'readReference'], [`/v1/coordinator/references/${REF}/events`, 'referenceEvents'],
        [`/v1/coordinator/references/${REF}/control`, 'controlReference'], ['/v1/coordinator/robots/provision', 'provision'],
        ['/v1/coordinator/robots/configure', 'configure'], ['/v1/coordinator/robots/delete', 'delete'], ['/v1/coordinator/robots/list', 'listRobots'],
        ['/v1/coordinator/robots/get', 'getRobot'], ['/v1/coordinator/operations/get', 'getOperation'],
        ['/v1/coordinator/obligations', 'admitObligation'], ['/v1/coordinator/obligations/list', 'listObligations'],
        [`/v1/coordinator/obligations/${REF}/accept`, 'acceptObligation'], [`/v1/coordinator/obligations/${REF}/reject`, 'rejectObligation'],
        [`/v1/coordinator/obligations/${REF}/outbox`, 'applyOutbox']
    ];
    for (const [url, name] of routes) {
        calls.length = 0;
        const res = await call(handler, { url, headers: { 'x-ploinky-auth-info': '{"invocationToken":"t"}' }, body: Buffer.from('{"a":1}') });
        assert.equal(res.statusCode, 200, url);
        assert.deepEqual(res.body, { ok: true });
        assert.equal(res.headers['content-type'], 'application/json');
        assert.equal(res.headers['cache-control'], 'no-store');
        assert.deepEqual(calls, [{ name, path: url, query: '', method: 'POST', body: '{"a":1}', authInfo: '{"invocationToken":"t"}' }]);
    }
    calls.length = 0;
    for (const [method, url] of [['GET', '/v1/coordinator/admissions'], ['PUT', '/v1/coordinator/admissions'], ['POST', '/v1/coordinator/unknown'],
        ['POST', '/v1/coordinator/references/short/read'], ['POST', `/v1/coordinator/references/${REF}/delete`], ['POST', '/v1/task-refs/lookup'],
        ['POST', '/v1/coordinator/admissions/'], ['POST', `/v1/coordinator/obligations/${REF}/delete`], ['POST', '/v1/coordinator/obligations/short/accept'],
        ['GET', '/v1/coordinator/obligations'], ['POST', `/v1/coordinator/obligations/${REF}`]]) {
        const res = await call(handler, { method, url });
        assert.equal(res.statusCode, 404, `${method} ${url}`);
        assert.deepEqual(res.body, { error: 'not_found' });
    }
    assert.equal(calls.length, 0);
});

test('task-reference route table: read, events, control and lookup; everything else 404', async () => {
    const { adapter, calls } = recordingAdapter(TASK_METHODS);
    const handler = createTaskReferenceHttpHandler({ adapter, basePath: BASE, limits: LIMITS });
    for (const [method, url, name, query] of [['GET', `${BASE}/${REF}`, 'read', ''], ['GET', `${BASE}/${REF}/events?after=1&limit=2`, 'events', '?after=1&limit=2'],
        ['POST', `${BASE}/${REF}/control`, 'control', ''], ['POST', `${BASE}/lookup`, 'lookup', '']]) {
        calls.length = 0;
        const res = await call(handler, { method, url });
        assert.equal(res.statusCode, 200, url);
        assert.equal(calls.length, 1);
        assert.equal(calls[0].name, name);
        assert.equal(calls[0].query, query);
        assert.equal(calls[0].path, url.split('?')[0]);
    }
    calls.length = 0;
    for (const [method, url] of [['POST', `${BASE}/${REF}`], ['GET', `${BASE}/lookup`], ['GET', `${BASE}/${REF}/control`], ['POST', `${BASE}/${REF}/events`],
        ['GET', `/v1/other/${REF}`], ['GET', `${BASE}/short`]]) {
        const res = await call(handler, { method, url });
        assert.equal(res.statusCode, 404, `${method} ${url}`);
    }
    assert.equal(calls.length, 0);
    const gap = createTaskReferenceHttpHandler({ adapter: recordingAdapter(TASK_METHODS, { gap: true, snapshotSequence: 7 }).adapter, basePath: BASE, limits: LIMITS });
    const res = await call(gap, { method: 'GET', url: `${BASE}/${REF}/events` });
    assert.equal(res.statusCode, 409);
    assert.deepEqual(res.body, { error: 'retention_gap', snapshotSequence: 7 });
});

test('error mapping table: status and body for every code; no reason, token or claim in the body', async () => {
    const cases = [
        [new CoordinatorAuthError('unauthorized', 'signature'), 401, 'unauthorized'],
        [new CoordinatorAuthError('forbidden', 'coordinator'), 403, 'forbidden'],
        [new CoordinatorAuthError('invalid_request', 'binding'), 400, 'invalid_request'],
        [new CoordinatorAuthError('unavailable', 'replay_capacity'), 503, 'unavailable'],
        [new CoordinatorAuthError('operation_unavailable', 'operation_unmapped'), 400, 'operation_unavailable'],
        [new WorkerStateError('invalid_request'), 400, 'invalid_request'],
        [new WorkerStateError('not_found'), 404, 'not_found'],
        [new WorkerStateError('forbidden'), 403, 'forbidden'],
        [new WorkerStateError('forbidden', 'token_replayed'), 401, 'unauthorized'],
        ...['operation_conflict', 'revision_conflict', 'robot_busy', 'resource_quarantined', 'resource_present'].map((code) => [new WorkerStateError(code), 409, code]),
        ...['runtime_unavailable', 'recovery_pending', 'stale_generation', 'capacity_exceeded'].map((code) => [new WorkerStateError(code), 503, code]),
        [new WorkerStateError('environment_unavailable'), 400, 'environment_unavailable'],
        [new WorkerStateError('state_corrupt'), 500, 'state_corrupt'],
        [new Error('bug with /secret/path and token xyz'), 500, 'internal_error']
    ];
    for (const [error, status, code] of cases) {
        const refusals = [];
        const adapter = { admit() { throw error; } };
        const handler = createCoordinatorHttpHandler({ adapter, limits: LIMITS, onRefusal: (entry) => refusals.push(entry) });
        const res = await call(handler, { url: '/v1/coordinator/admissions', body: Buffer.from('{}') });
        assert.equal(res.statusCode, status, code);
        assert.deepEqual(res.body, { error: code });
        assert.equal(refusals.length, 1);
        assert.equal(refusals[0].route, 'admit');
        assert.equal(refusals[0].code, code);
    }
    // The diagnostics hook sees the reason; the response never does, and a throwing hook changes nothing.
    const handler = createCoordinatorHttpHandler({
        adapter: { admit() { throw new CoordinatorAuthError('forbidden', 'owner_scope'); } }, limits: LIMITS, onRefusal: () => { throw new Error('hook'); }
    });
    const res = await call(handler, { url: '/v1/coordinator/admissions', body: Buffer.from('{}') });
    assert.equal(res.statusCode, 403);
    assert.equal(JSON.stringify(res.body).includes('owner_scope'), false);
});

test('bounds: an oversize body is 400 without an adapter call; a missing auth-info is 401', async () => {
    const { adapter, calls } = recordingAdapter(COORDINATOR_METHODS);
    const handler = createCoordinatorHttpHandler({ adapter, limits: LIMITS });
    const limit = LIMITS.requestBytes + 16384;
    const exact = await call(handler, { url: '/v1/coordinator/admissions', body: Buffer.alloc(limit, 0x20) });
    assert.equal(exact.statusCode, 200);
    const over = await call(handler, { url: '/v1/coordinator/admissions', body: Buffer.alloc(limit + 1, 0x20) });
    assert.equal(over.statusCode, 400);
    assert.deepEqual(over.body, { error: 'invalid_request' });
    assert.equal(calls.length, 1);
    const real = createCoordinatorHttpHandler({
        adapter: createCoordinatorAdapter({ store: stubStoreForAuthOnly(), workspaceId: WORKSPACE, verifier: verifierFor(crypto.randomBytes(32)) }), limits: LIMITS
    });
    const missing = await call(real, { url: '/v1/coordinator/admissions', body: Buffer.from('{}') });
    assert.equal(missing.statusCode, 401);
    assert.deepEqual(missing.body, { error: 'unauthorized' });
    const repeated = await call(real, { url: '/v1/coordinator/admissions', headers: { 'x-ploinky-auth-info': ['a', 'b'] }, body: Buffer.from('{}') });
    assert.equal(repeated.statusCode, 401);
});

// Every S1 method throws: the auth-only case must be refused before any store call.
function stubStoreForAuthOnly() {
    const store = {};
    for (const name of ['admit', 'lookupOrigin', 'registerBinding', 'readBindingOwner', 'observeReference', 'listReferenceEvents', 'controlReference',
        'consumeTokenIds', 'beginProvision', 'configure', 'beginDelete', 'listRobots', 'getRobot', 'getOperationOutcome',
        'admitObligation', 'acceptObligation', 'rejectObligation', 'listObligations', 'applyOutbox']) {
        store[name] = () => { throw new Error(`store.${name} must not be called`); };
    }
    return store;
}

function verifierFor(secret) {
    return createVerifierConfig({ secret, audience: PROVIDER_PRINCIPAL, coordinators: [COORDINATOR], replayCache: createReplayCache() });
}

test('raw target parsing: percent-encoded, dot-segment, empty-segment and backslash paths refused; a bare ? is an empty search', () => {
    assert.deepEqual(parseTarget('/v1/coordinator/admissions'), { path: '/v1/coordinator/admissions', query: '' });
    assert.deepEqual(parseTarget('/v1/coordinator/admissions?'), { path: '/v1/coordinator/admissions', query: '' });
    assert.deepEqual(parseTarget('/x/events?after=1&limit=2'), { path: '/x/events', query: '?after=1&limit=2' });
    for (const bad of ['/v1/coordinator/%61dmissions', '/v1/coordinator/./admissions', '/v1/coordinator/../admissions', '/v1//coordinator',
        '/v1\\coordinator', 'v1/coordinator', '', '/a#frag', `/${'a'.repeat(9000)}`, '/a b', undefined]) {
        assert.throws(() => parseTarget(bad), (error) => error.status === 400 && error.code === 'invalid_request', String(bad).slice(0, 40));
    }
});

function hopRequest(secret, path, bodyValue, claims) {
    const body = Buffer.from(JSON.stringify(bodyValue));
    const iat = Math.floor(Date.now() / 1000);
    const payload = {
        typ: 'router-request', iss: 'ploinky-router', aud: PROVIDER_PRINCIPAL, sub: COORDINATOR,
        actor: { kind: 'agent', id: COORDINATOR, roles: [] }, caller: { kind: 'agent', id: COORDINATOR, roles: ['agent'] },
        method: 'POST', path, tool: COORDINATOR_ADMISSION_TOOL, rch: computeRchHttp({ method: 'POST', path, query: '', bodyHash: rawBodyHash(body) }),
        jti: crypto.randomBytes(16).toString('base64url'), iat, exp: iat + 30, ...claims
    };
    const input = `${Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url')}.${Buffer.from(JSON.stringify(payload)).toString('base64url')}`;
    const token = `${input}.${crypto.createHmac('sha256', secret).update(input).digest('base64url')}`;
    return { url: path, headers: { 'x-ploinky-auth-info': JSON.stringify({ invocationToken: token }) }, body };
}

function taskRefRequest(secret, method, path, claims) {
    const iat = Math.floor(Date.now() / 1000);
    const payload = {
        typ: 'router-request', iss: 'ploinky-router', aud: PROVIDER_PRINCIPAL, method, path, tool: TASK_REFERENCE_TOOL,
        rch: computeRchHttp({ method, path, query: '', bodyHash: rawBodyHash(Buffer.alloc(0)) }),
        jti: crypto.randomBytes(16).toString('base64url'), iat, exp: iat + 30, ...claims
    };
    const input = `${Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url')}.${Buffer.from(JSON.stringify(payload)).toString('base64url')}`;
    const token = `${input}.${crypto.createHmac('sha256', secret).update(input).digest('base64url')}`;
    return { method, url: path, headers: { 'x-ploinky-auth-info': JSON.stringify({ invocationToken: token }) } };
}

const OWNER = Object.freeze({ usr: { id: 'alice', roles: ['user'] }, delegation: { jti: 'g', scope: ['execution:owner'], sourceAgentId: COORDINATOR } });

test('end to end through both handlers: admission 200, then the owner reads it through /task-refs (synthetic runtime)', async (t) => {
    const dir = makeTempDir(t);
    const store = openStore(dir, { limits: EXTENDED });
    t.after(() => store.close());
    const robotId = readyRobot(store, syntheticContext({ robotOwnerId: ROBOTS, scope: 'scope-robots' }));
    const secret = crypto.randomBytes(32);
    const verifier = verifierFor(secret);
    const coordinator = createCoordinatorHttpHandler({ adapter: createCoordinatorAdapter({ store, workspaceId: WORKSPACE, verifier }), limits: EXTENDED });
    const refs = createTaskReferenceHttpHandler({ adapter: createTaskReferenceAdapter({ store, workspaceId: WORKSPACE, verifier, basePath: BASE }), basePath: BASE, limits: EXTENDED });
    const admitted = await call(coordinator, hopRequest(secret, '/v1/coordinator/admissions',
        { originRequestId: newOriginId(), robotId, configRevision: 1, kind: 'task', specification: { prompt: 'synthetic' } }, OWNER));
    assert.equal(admitted.statusCode, 200);
    assert.equal(admitted.body.state, 'queued');
    const read = await call(refs, taskRefRequest(secret, 'GET', `${BASE}/${admitted.body.taskRef.id}`, { sub: 'user:alice', actor: { kind: 'user', id: 'user:alice', roles: [] } }));
    assert.equal(read.statusCode, 200);
    assert.equal(read.body.kind, 'execution');
    const foreign = await call(refs, taskRefRequest(secret, 'GET', `${BASE}/${admitted.body.taskRef.id}`, { sub: 'user:bob', actor: { kind: 'user', id: 'user:bob', roles: [] } }));
    assert.equal(foreign.statusCode, 404);
    assert.deepEqual(foreign.body, { error: 'not_found' });
});

test('default runtime: admission through the handler returns 503 with zero admission, receipt, origin and reference rows; the token is burned', async (t) => {
    const dir = makeTempDir(t);
    const setup = openStore(dir, { limits: EXTENDED });
    const robotId = readyRobot(setup, syntheticContext({ robotOwnerId: ROBOTS, scope: 'scope-robots' }));
    setup.close();
    const before = Object.fromEntries(['receipt', 'admission', 'origin', 'reference'].map((table) => [table, count(dir, table)]));
    // Reopened WITHOUT a runtime: S1's default runtimeUnavailable adapter.
    const store = openWorkerState({ dataDir: dir, workspaceId: WORKSPACE, provider: PROVIDER, limits: EXTENDED });
    t.after(() => store.close());
    const secret = crypto.randomBytes(32);
    const handler = createCoordinatorHttpHandler({ adapter: createCoordinatorAdapter({ store, workspaceId: WORKSPACE, verifier: verifierFor(secret) }), limits: EXTENDED });
    const options = hopRequest(secret, '/v1/coordinator/admissions', { originRequestId: newOriginId(), robotId, configRevision: 1, kind: 'task', specification: { prompt: 'x' } }, OWNER);
    const res = await call(handler, options);
    assert.equal(res.statusCode, 503);
    assert.deepEqual(res.body, { error: 'runtime_unavailable' });
    assert.deepEqual(Object.fromEntries(['receipt', 'admission', 'origin', 'reference'].map((table) => [table, count(dir, table)])), before);
    assert.equal(count(dir, 'admission'), 0);
    assert.equal(count(dir, 'token_replay'), 1);
    // A replay of the burned token to a fresh verifier: 401.
    const fresh = createCoordinatorHttpHandler({ adapter: createCoordinatorAdapter({ store, workspaceId: WORKSPACE, verifier: verifierFor(secret) }), limits: EXTENDED });
    const replay = await call(fresh, options);
    assert.equal(replay.statusCode, 401);
    assert.deepEqual(replay.body, { error: 'unauthorized' });
});
