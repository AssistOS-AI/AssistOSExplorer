import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { Readable } from 'node:stream';
import { openWorkerState, runtimeUnavailable } from '../server/workerState.mjs';
import {
    TASK_REFERENCE_TOOL, TERMINAL_TARGETS_TOOL, computeRchHttp, createReplayCache, createVerifierConfig, rawBodyHash
} from '../server/coordinatorAuth.mjs';
import {
    MAX_INVENTORY_BYTES, MAX_TARGETS, TargetInventoryError, createTerminalTargetsAdapter, labelFor, projectTargets
} from '../server/terminalTargets.mjs';
import { createTerminalTargetsHttpHandler } from '../server/providerHttp.mjs';
import { LIMITS, PROVIDER, S6_LIMITS, WORKSPACE, count, makeTempDir, newId, openStore, readyRobot, robotConfig, syntheticContext } from './helpers/synthetic.mjs';

// Terminal-target inventory (S6 source-only subset, Part E) over the actual S1 store in
// isolated temporary directories, with real HS256 Router Requests under generated keys and
// the HTTP handler over in-memory requests (no socket). Robots are prepared with the
// explicitly SYNTHETIC runtime of tests/helpers/synthetic.mjs: state evidence only, never
// protected execution, runtime readiness, PTY ownership or routed authorization. No Router
// minter exists for this request yet (O11): the token shape is the assumed user Router
// Request, and the routed case TT1 stays NOT_BUILT.

const PROVIDER_PRINCIPAL = 'agent:RoboRepo/robo-work';
const TERMINALS = '/v1/terminals';
const TARGETS = `${TERMINALS}/targets`;
const ROBOTS = `workspace:${WORKSPACE}`;
const ROBOT_CONTEXT = () => syntheticContext({ robotOwnerId: ROBOTS, scope: 'scope-robots' });

function b64json(value) {
    return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

function sign(payload, secret, header = {}) {
    const input = `${b64json({ alg: 'HS256', typ: 'JWT', ...header })}.${b64json(payload)}`;
    return `${input}.${crypto.createHmac('sha256', secret).update(input).digest('base64url')}`;
}

function seconds() {
    return Math.floor(Date.now() / 1000);
}

function verifierFor(secret) {
    return createVerifierConfig({ secret, audience: PROVIDER_PRINCIPAL, replayCache: createReplayCache() });
}

function userClaims(id, roles = ['admin']) {
    return { sub: `user:${id}`, actor: { kind: 'user', id: `user:${id}`, roles } };
}

// A Router Request for the inventory. `claims` override the payload; `undefined` removes a key.
// `signed` overrides the signed surface (method, path, query, body) when it must differ from
// the received one.
// `header` overrides the JWS header, `token` replaces the whole token and `authInfo` the whole
// `x-ploinky-auth-info` value (null drops it).
function targetsRequest(secret, { claims = userClaims('root'), body = { project: null }, method = 'POST', path = TARGETS, query = '', signed = {}, rawBody, signWith, header, token, authInfo } = {}) {
    const bytes = rawBody ?? Buffer.from(JSON.stringify(body));
    const surface = { method, path, query, body: bytes, ...signed };
    const iat = seconds();
    const payload = {
        typ: 'router-request', iss: 'ploinky-router', aud: PROVIDER_PRINCIPAL, method: surface.method, path: surface.path, tool: TERMINAL_TARGETS_TOOL,
        rch: computeRchHttp({ method: surface.method, path: surface.path, query: surface.query, bodyHash: rawBodyHash(surface.body) }),
        jti: crypto.randomBytes(16).toString('base64url'), iat, exp: iat + 30, ...claims
    };
    for (const key of Object.keys(payload)) if (payload[key] === undefined) delete payload[key];
    const invocationToken = token ?? sign(payload, signWith ?? secret, header);
    const info = authInfo === undefined ? JSON.stringify({ invocationToken }) : (authInfo === null ? undefined : authInfo);
    return { authInfo: info, method, path, query, body: bytes };
}

function httpRequest(req) {
    const stream = Readable.from(req.body.length > 0 ? [req.body] : []);
    stream.method = req.method;
    stream.url = `${req.path}${req.query}`;
    stream.headers = { 'x-ploinky-auth-info': req.authInfo };
    return stream;
}

async function send(handler, req) {
    const res = {
        statusCode: 0, headers: {}, body: null, raw: null,
        setHeader(name, value) { this.headers[name.toLowerCase()] = value; },
        end(payload) { this.raw = payload ?? null; this.body = payload === undefined ? null : JSON.parse(payload); }
    };
    await handler(httpRequest(req), res);
    return res;
}

function rig(t, { limits = S6_LIMITS, runtime } = {}) {
    const dir = makeTempDir(t);
    const store = openStore(dir, { limits, ...(runtime ? { runtime } : {}) });
    t.after(() => store.close());
    const secret = crypto.randomBytes(32);
    const make = () => {
        const adapter = createTerminalTargetsAdapter({ store, workspaceId: WORKSPACE, verifier: verifierFor(secret), basePath: TERMINALS });
        return { adapter, handler: createTerminalTargetsHttpHandler({ adapter, basePath: TERMINALS, limits }) };
    };
    return { dir, store, secret, ...make(), fresh: make };
}

// A robot in a named lifecycle state, prepared through S1 (synthetic runtime). Returns its ID.
function robotIn(store, state, name = `robot ${state}`) {
    const context = ROBOT_CONTEXT();
    const operationId = newId();
    const { robotId } = store.beginProvision(context, { operationId, name, configuration: robotConfig() });
    if (state === 'provisioning') return robotId;
    if (state === 'failed') {
        store.completePreparation(context, { operationId, outcome: 'failed', effects: 'none' });
        return robotId;
    }
    store.completePreparation(context, { operationId, outcome: 'succeeded' });
    if (state === 'ready') return robotId;
    if (state === 'deleting' || state === 'deleted') {
        const deleteId = newId();
        store.beginDelete(context, { operationId: deleteId, robotId, expectedRevision: 1 });
        if (state === 'deleted') store.completeDelete(context, { operationId: deleteId });
        return robotId;
    }
    if (state === 'quarantined') {
        const { resourceId } = store.reserveResource({ kind: 'synthetic-dir', locator: { dir: `synthetic/${newId()}` }, robotId });
        store.quarantineResource({ resourceId, generationId: store.generationId });
        return robotId;
    }
    throw new Error(`unknown state ${state}`);
}

// Runs a call that the requirement says succeeds; a throw fails as an assertion naming it.
function succeeds(fn, message) {
    let value;
    let refusal = null;
    try {
        value = fn();
    } catch (error) {
        refusal = `${error.name}/${error.code ?? ''}`;
    }
    assert.equal(refusal, null, message);
    return value;
}

function expectRefusal(res, status, error) {
    assert.equal(res.statusCode, status, JSON.stringify(res.body));
    assert.deepEqual(res.body, { error });
}

// SYNTHETIC robot views for the pure projection (bounds the store cannot reach).
function views(n, name = (index) => `robot ${index}`) {
    return Array.from({ length: n }, (_, index) => ({ robotId: crypto.randomBytes(16).toString('base64url'), name: name(index), ready: true }));
}

// ---- Required cases --------------------------------------------------------------------

test('an admin user gets 200 with the ready robots only; unready, deleting and deleted robots are excluded (synthetic runtime)', async (t) => {
    const { store, secret, handler } = rig(t);
    const ready = [robotIn(store, 'ready', 'Alpha'), robotIn(store, 'ready', 'Beta')];
    for (const state of ['provisioning', 'failed', 'deleting', 'deleted', 'quarantined']) robotIn(store, state);
    const res = await send(handler, targetsRequest(secret));
    assert.equal(res.statusCode, 200);
    assert.equal(res.headers['cache-control'], 'no-store');
    assert.deepEqual(res.body, { version: 1, targets: [{ targetId: ready[0], label: 'Alpha' }, { targetId: ready[1], label: 'Beta' }] });
    assert.equal(store.listRobots(ROBOT_CONTEXT()).length, 7, 'precondition: seven robots exist');
});

test('robots unattested after the worker-start generation recovery are excluded', async (t) => {
    const { store, secret, handler } = rig(t);
    robotIn(store, 'ready');
    const generation = store.beginGenerationRecovery(store.generationId);
    store.completeGenerationRecovery(generation.generationId);
    const res = await send(handler, targetsRequest(secret));
    assert.deepEqual([res.statusCode, res.body], [200, { version: 1, targets: [] }]);
    store.attestReadiness(ROBOT_CONTEXT(), { robotId: store.listRobots(ROBOT_CONTEXT())[0].robotId });
    assert.equal((await send(handler, targetsRequest(secret))).body.targets.length, 1, 'a re-attested robot is listed again');
});

test('refusals: a non-admin, a guest, an agent and delegated evidence are 403; the wrong tool is 401; a wrong path is 404 at the handler, 401 when signed for another path, 400 when valid for another path', async (t) => {
    const { dir, store, secret, handler } = rig(t);
    robotIn(store, 'ready');
    const cases = [
        ['non-admin user', { claims: userClaims('bob', ['user']) }, 403, 'forbidden'],
        ['guest by id', { claims: { sub: 'user:guest:x', actor: { kind: 'user', id: 'user:guest:x', roles: ['admin'] } } }, 403, 'forbidden'],
        ['guest by role', { claims: userClaims('root', ['admin', 'guest']) }, 403, 'forbidden'],
        ['agent actor', { claims: { sub: 'agent:RoboRepo/other', actor: { kind: 'agent', id: 'agent:RoboRepo/other', roles: [] } } }, 403, 'forbidden'],
        ['delegated usr claim', { claims: { ...userClaims('root'), usr: { id: 'root', roles: ['admin'] } } }, 403, 'forbidden'],
        ['delegated delegation claim', { claims: { ...userClaims('root'), delegation: { scope: ['execution:owner'], sourceAgentId: 'agent:RoboRepo/x' } } }, 403, 'forbidden'],
        ['agent caller', { claims: { ...userClaims('root'), caller: { kind: 'agent', id: 'agent:RoboRepo/x' } } }, 403, 'forbidden'],
        ['another user as caller', { claims: { ...userClaims('root'), caller: { kind: 'user', id: 'user:other' } } }, 403, 'forbidden'],
        ['wrong tool', { claims: { ...userClaims('root'), tool: TASK_REFERENCE_TOOL } }, 401, 'unauthorized'],
        ['token signed for another path', { signed: { path: `${TERMINALS}/other/targets` } }, 401, 'unauthorized']
    ];
    for (const [label, options, status, error] of cases) {
        const res = await send(handler, targetsRequest(secret, options));
        assert.equal(res.statusCode, status, label);
        assert.deepEqual(res.body, { error }, label);
    }
    // The handler serves only <basePath>/targets: another path is 404 without an adapter call.
    expectRefusal(await send(handler, targetsRequest(secret, { path: `${TERMINALS}/other` })), 404, 'not_found');
    assert.equal(count(dir, 'token_replay'), 0, 'refusals inside the verifier consume nothing');
    // Wrong path at the adapter: a token valid for the path it was sent to, but that path is not
    // <basePath>/targets, is invalid_request (and burns the token).
    const { dir: otherDir, secret: otherSecret, adapter } = rig(t);
    assert.throws(() => adapter.targets(targetsRequest(otherSecret, { path: `${TERMINALS}/x/targets` })),
        (error) => error.name === 'WorkerStateError' && error.code === 'invalid_request');
    assert.equal(count(otherDir, 'token_replay'), 1);
});

test('a replay is refused 401 by the same adapter and by a fresh verifier and adapter over the same store (durable replay)', async (t) => {
    const { dir, store, secret, handler, fresh } = rig(t);
    robotIn(store, 'ready');
    const req = targetsRequest(secret);
    assert.equal((await send(handler, req)).statusCode, 200);
    assert.equal(count(dir, 'token_replay'), 1, 'the token ID is recorded durably');
    expectRefusal(await send(handler, req), 401, 'unauthorized');
    expectRefusal(await send(fresh().handler, req), 401, 'unauthorized');
    assert.equal(count(dir, 'token_replay'), 1);
    // A request refused after verification (a body error) still burns its token.
    const bad = targetsRequest(secret, { body: { project: 'home' } });
    expectRefusal(await send(handler, bad), 400, 'invalid_request');
    assert.equal(count(dir, 'token_replay'), 2);
    expectRefusal(await send(fresh().handler, bad), 401, 'unauthorized');
});

test('257 robots give 503 with the body exactly {"error":"target_inventory_too_large"}; the token is burned', async (t) => {
    const limits = { ...S6_LIMITS, robots: 300, receipts: 700 };
    const { dir, store, secret, handler } = rig(t, { limits });
    for (let index = 0; index < 257; index += 1) readyRobot(store, ROBOT_CONTEXT());
    const res = await send(handler, targetsRequest(secret));
    assert.equal(res.statusCode, 503);
    assert.equal(res.raw, '{"error":"target_inventory_too_large"}');
    assert.equal(count(dir, 'token_replay'), 1);
});

test('the default runtime returns {version: 1, targets: []}: a fresh store, and a store seeded by another runtime after the worker-start recovery', async (t) => {
    const { secret, handler } = rig(t, { runtime: runtimeUnavailable });
    const fresh = await send(handler, targetsRequest(secret));
    assert.deepEqual([fresh.statusCode, fresh.body], [200, { version: 1, targets: [] }]);
    const dir = makeTempDir(t);
    const seeded = openStore(dir, { limits: S6_LIMITS });
    robotIn(seeded, 'ready');
    seeded.close();
    const store = openWorkerState({ dataDir: dir, workspaceId: WORKSPACE, provider: PROVIDER, limits: S6_LIMITS, runtime: runtimeUnavailable });
    t.after(() => store.close());
    const generation = store.beginGenerationRecovery(store.generationId);
    store.completeGenerationRecovery(generation.generationId);
    const adapter = createTerminalTargetsAdapter({ store, workspaceId: WORKSPACE, verifier: verifierFor(secret), basePath: TERMINALS });
    const res = await send(createTerminalTargetsHttpHandler({ adapter, basePath: TERMINALS, limits: S6_LIMITS }), targetsRequest(secret));
    assert.deepEqual([res.statusCode, res.body], [200, { version: 1, targets: [] }]);
});

// ---- Verifier conjuncts ----------------------------------------------------------------

test('verifier conjuncts: signature, lifetime, audience, type, issuer, method, rch (changed body) and subject are each refused', async (t) => {
    const { dir, store, secret, handler } = rig(t);
    robotIn(store, 'ready');
    const old = seconds() - 120;
    const cases = [
        ['signature', { signWith: crypto.randomBytes(32) }, 401, 'unauthorized'],
        ['expired', { claims: { ...userClaims('root'), iat: old, exp: old + 30 } }, 401, 'unauthorized'],
        ['audience', { claims: { ...userClaims('root'), aud: 'agent:RoboRepo/other' } }, 401, 'unauthorized'],
        ['type', { claims: { ...userClaims('root'), typ: 'delegation' } }, 401, 'unauthorized'],
        ['issuer', { claims: { ...userClaims('root'), iss: 'someone-else' } }, 401, 'unauthorized'],
        ['method', { signed: { method: 'GET' } }, 401, 'unauthorized'],
        ['rch over another body', { signed: { body: Buffer.from(JSON.stringify({ project: { selection: 'home', relativePath: 'a' } })) } }, 401, 'unauthorized'],
        ['rch over another query', { query: '?x=1', signed: { query: '' } }, 401, 'unauthorized'],
        ['subject', { claims: { ...userClaims('root'), sub: 'user:other' } }, 403, 'forbidden'],
        ['missing roles', { claims: { sub: 'user:root', actor: { kind: 'user', id: 'user:root' } } }, 403, 'forbidden'],
        ['malformed roles', { claims: { sub: 'user:root', actor: { kind: 'user', id: 'user:root', roles: 'admin' } } }, 403, 'forbidden']
    ];
    for (const [label, options, status, error] of cases) {
        const res = await send(handler, targetsRequest(secret, options));
        assert.equal(res.statusCode, status, label);
        assert.deepEqual(res.body, { error }, label);
    }
    assert.equal(count(dir, 'token_replay'), 0);
});

test('the admin role is exact: administrator, admins, no roles and guest together with admin are refused; case and spacing are normalized', async (t) => {
    const { store, secret, handler } = rig(t);
    robotIn(store, 'ready');
    for (const roles of [['administrator'], ['admins'], [], ['user'], ['admin', 'GUEST']]) {
        expectRefusal(await send(handler, targetsRequest(secret, { claims: userClaims('root', roles) })), 403, 'forbidden');
    }
    for (const roles of [['admin'], ['ADMIN'], [' admin ', 'user']]) {
        assert.equal((await send(handler, targetsRequest(secret, { claims: userClaims('root', roles) }))).statusCode, 200, JSON.stringify(roles));
    }
    // An id carrying the user: prefix once is the same user.
    const prefixed = { sub: 'user:root', actor: { kind: 'user', id: 'user:root', roles: ['admin'] } };
    assert.equal((await send(handler, targetsRequest(secret, { claims: prefixed }))).statusCode, 200);
});

// ---- Route and body ----------------------------------------------------------------------

test('route and body: a query, a non-POST method and malformed bodies are invalid_request and burn the token; a project is syntax-checked only', async (t) => {
    const { dir, store, secret, adapter } = rig(t);
    robotIn(store, 'ready');
    const refuse = (options) => assert.throws(() => adapter.targets(targetsRequest(secret, options)), (error) => error.code === 'invalid_request');
    refuse({ query: '?all=1' });
    refuse({ method: 'PUT' });
    for (const body of [{}, { project: null, extra: 1 }, { project: 'home' }, { project: {} }, { project: { selection: 'home' } },
        { project: { selection: '', relativePath: 'a' } }, { project: { selection: 'home', relativePath: '/abs' } },
        { project: { selection: 'home', relativePath: 'a/../b' } }, { project: { selection: '/etc', relativePath: '' } },
        { project: { selection: 'home', relativePath: 'a', other: 1 } }, { project: { selection: 'a/../b', relativePath: '' } },
        { project: { selection: 'home', relativePath: 'a\u0007b' } }, { project: { selection: 'a//b', relativePath: '' } },
        { project: { selection: '.', relativePath: '' } }]) {
        refuse({ body });
    }
    refuse({ rawBody: Buffer.from('not json') });
    refuse({ rawBody: Buffer.alloc(0) });
    assert.equal(count(dir, 'token_replay'), 18, 'each request refused after verification burned its token');
    // Delta note 4 / B-2: the selection is a workspace-relative folder (any segment text but `.`, `..` and empty) and `relativePath` may be ''.
    for (const body of [{ project: null }, { project: { selection: 'home', relativePath: 'projects/demo' } }, { project: { selection: 'home', relativePath: '' } },
        { project: { selection: 'projects/my app', relativePath: '' } }]) {
        assert.equal(adapter.targets(targetsRequest(secret, { body })).version, 1);
    }
});

test('a store opened without the S1x extension limits fails closed with 503 capacity_exceeded (no replay table capacity)', async (t) => {
    const { store, secret, handler } = rig(t, { limits: LIMITS });
    robotIn(store, 'ready');
    expectRefusal(await send(handler, targetsRequest(secret)), 503, 'capacity_exceeded');
});

// ---- Projection, labels and bounds -----------------------------------------------------

test('labels: a name of 1-128 UTF-8 bytes without control characters is the label; 132 bytes, C0 and C1 controls fall back to the robot ID (store names)', async (t) => {
    const { store, secret, handler } = rig(t);
    const names = { exact: '\u{1F600}'.repeat(32), over: '\u{1F600}'.repeat(33), c1: 'robot\u0085x', c0: 'robot\u0007x', plain: 'Plain name' };
    const ids = Object.fromEntries(Object.entries(names).map(([key, name]) => [key, robotIn(store, 'ready', name)]));
    const res = await send(handler, targetsRequest(secret));
    const labels = Object.fromEntries(res.body.targets.map((entry) => [entry.targetId, entry.label]));
    assert.equal(Buffer.byteLength(names.exact, 'utf8'), 128);
    assert.equal(labels[ids.exact], names.exact);
    assert.equal(labels[ids.over], ids.over);
    assert.equal(labels[ids.c1], ids.c1);
    assert.equal(labels[ids.c0], ids.c0);
    assert.equal(labels[ids.plain], 'Plain name');
    // Pure rule (SYNTHETIC names the store would refuse): empty, DEL, 129 ASCII bytes.
    for (const name of ['', 'a\u007fb', 'x'.repeat(129), 'a\u009fb']) assert.equal(labelFor({ robotId: 'R', name }), 'R', JSON.stringify(name));
    for (const name of ['x', 'x'.repeat(128), 'tab-free é']) assert.equal(labelFor({ robotId: 'R', name }), name);
});

test('count bound: 256 targets are returned, 257 refuse the whole inventory (SYNTHETIC views); unready views do not count', () => {
    assert.equal(MAX_TARGETS, 256);
    assert.equal(succeeds(() => projectTargets(views(256)), '256 targets are within the bound').targets.length, 256);
    assert.throws(() => projectTargets(views(257)), TargetInventoryError);
    const mixed = [...views(256), ...views(10).map((view) => ({ ...view, ready: false }))];
    assert.equal(projectTargets(mixed).targets.length, 256);
    assert.deepEqual(projectTargets([{ robotId: 'R1', name: 'a', ready: false }, { robotId: 'R2', name: 'b', ready: 'yes' }]), { version: 1, targets: [] });
});

test('byte bound: an inventory of exactly 65536 bytes is returned, 65537 is refused (SYNTHETIC views; unreachable from store names, which are at most 80 characters)', () => {
    assert.equal(MAX_INVENTORY_BYTES, 65536);
    // A label of `a` x k then `\` x (128 - k) is always 128 bytes; JSON doubles each backslash,
    // so turning one backslash into `a` shrinks the response by exactly one byte.
    const label = (k) => `${'a'.repeat(k)}${'\\'.repeat(128 - k)}`;
    const ids = Array.from({ length: MAX_TARGETS }, () => crypto.randomBytes(16).toString('base64url'));
    const list = (n, conversions) => ids.slice(0, n).map((robotId, index) => ({
        robotId, ready: true, name: label(Math.min(128, Math.max(0, conversions - index * 128)))
    }));
    const size = (views) => Buffer.byteLength(JSON.stringify({ version: 1, targets: views.map((view) => ({ targetId: view.robotId, label: view.name })) }), 'utf8');
    let n = 1;
    while (size(list(n, 0)) <= MAX_INVENTORY_BYTES) n += 1;
    assert.ok(n <= MAX_TARGETS, 'precondition: the byte bound is reached under the count bound');
    const conversions = size(list(n, 0)) - MAX_INVENTORY_BYTES;
    const exact = list(n, conversions);
    assert.equal(size(exact), MAX_INVENTORY_BYTES, 'precondition: exactly 65536 bytes');
    assert.equal(Buffer.byteLength(JSON.stringify(succeeds(() => projectTargets(exact), 'an inventory of exactly 65536 bytes is within the bound')), 'utf8'), MAX_INVENTORY_BYTES);
    const over = list(n, conversions - 1);
    assert.equal(size(over), MAX_INVENTORY_BYTES + 1, 'precondition: exactly 65537 bytes');
    assert.throws(() => projectTargets(over), TargetInventoryError);
    assert.ok(exact.every((view) => labelFor(view) === view.name), 'every label is kept (128 bytes, no controls)');
    // The bound counts UTF-8 bytes, not UTF-16 code units: one 4-byte character plus 124
    // backslashes is a 128-byte label that is 2 code units shorter than its byte size.
    const mixed = ids.slice(0, 218).map((robotId) => ({ robotId, ready: true, name: `\u{1F600}${'\\'.repeat(124)}` }));
    const json = JSON.stringify({ version: 1, targets: mixed.map((view) => ({ targetId: view.robotId, label: view.name })) });
    assert.ok(json.length <= MAX_INVENTORY_BYTES && Buffer.byteLength(json, 'utf8') > MAX_INVENTORY_BYTES, `precondition: ${json.length} code units, ${Buffer.byteLength(json, 'utf8')} bytes`);
    assert.ok(mixed.every((view) => labelFor(view) === view.name));
    assert.throws(() => projectTargets(mixed), TargetInventoryError);
});

test('route table: only POST <basePath>/targets dispatches; other methods and paths are 404 without an adapter call', async (t) => {
    const calls = [];
    const adapter = { targets: (req) => { calls.push(req.path); return { version: 1, targets: [] }; } };
    const handler = createTerminalTargetsHttpHandler({ adapter, basePath: TERMINALS, limits: S6_LIMITS });
    const ok = await send(handler, { method: 'POST', path: TARGETS, query: '', body: Buffer.from('{}'), authInfo: '{}' });
    assert.equal(ok.statusCode, 200);
    for (const [method, path] of [['GET', TARGETS], ['PUT', TARGETS], ['POST', `${TARGETS}/x`], ['POST', TERMINALS], ['POST', '/v1/other/targets']]) {
        expectRefusal(await send(handler, { method, path, query: '', body: Buffer.alloc(0), authInfo: '{}' }), 404, 'not_found');
    }
    assert.deepEqual(calls, [TARGETS]);
    assert.throws(() => createTerminalTargetsHttpHandler({ adapter, basePath: 'relative', limits: S6_LIMITS }), TypeError);
    assert.throws(() => createTerminalTargetsAdapter({ store: {}, workspaceId: WORKSPACE, verifier: null, basePath: TERMINALS }));
    void t;
});

test('each verifier conjunct refuses on its own, with its own reason (claim-only method and path, rch still valid)', (t) => {
    const { dir, secret, adapter } = rig(t);
    const reasonOf = (options) => {
        try {
            adapter.targets(targetsRequest(secret, options));
        } catch (error) {
            return `${error.name}/${error.code}/${error.reason ?? ''}`;
        }
        return 'accepted';
    };
    const old = seconds() - 120;
    // The token of an otherwise valid request, for format cases built around it.
    const validToken = () => JSON.parse(targetsRequest(secret).authInfo).invocationToken;
    const cases = [
        ['signature', { signWith: crypto.randomBytes(32) }, 'unauthorized/signature'],
        ['lifetime', { claims: { ...userClaims('root'), iat: old, exp: old + 30 } }, 'unauthorized/expired'],
        ['audience', { claims: { ...userClaims('root'), aud: 'agent:RoboRepo/other' } }, 'unauthorized/audience'],
        ['type', { claims: { ...userClaims('root'), typ: 'delegation' } }, 'unauthorized/token_type'],
        ['issuer', { claims: { ...userClaims('root'), iss: 'someone-else' } }, 'unauthorized/issuer'],
        ['tool', { claims: { ...userClaims('root'), tool: TASK_REFERENCE_TOOL } }, 'unauthorized/tool'],
        ['method claim only', { claims: { ...userClaims('root'), method: 'GET' } }, 'unauthorized/method'],
        ['path claim only', { claims: { ...userClaims('root'), path: `${TERMINALS}/other/targets` } }, 'unauthorized/path'],
        ['rch', { signed: { body: Buffer.from('{"project":null }') } }, 'unauthorized/rch'],
        ['agent actor', { claims: { sub: 'agent:RoboRepo/other', actor: { kind: 'agent', id: 'agent:RoboRepo/other', roles: ['admin'] } } }, 'forbidden/actor'],
        ['usr claim', { claims: { ...userClaims('root'), usr: { id: 'root', roles: ['admin'] } } }, 'forbidden/delegated'],
        ['delegation claim', { claims: { ...userClaims('root'), delegation: { scope: ['execution:owner'] } } }, 'forbidden/delegated'],
        ['malformed roles', { claims: { sub: 'user:root', actor: { kind: 'user', id: 'user:root', roles: 'admin' } } }, 'forbidden/actor'],
        ['guest by id', { claims: { sub: 'user:guest:x', actor: { kind: 'user', id: 'user:guest:x', roles: ['admin'] } } }, 'forbidden/guest'],
        ['guest by role', { claims: userClaims('root', ['admin', 'guest']) }, 'forbidden/guest'],
        ['malformed user id', { claims: { sub: 'user:a b', actor: { kind: 'user', id: 'user:a b', roles: ['admin'] } } }, 'forbidden/actor'],
        ['agent caller', { claims: { ...userClaims('root'), caller: { kind: 'agent', id: 'agent:RoboRepo/x' } } }, 'forbidden/delegated'],
        ['subject', { claims: { ...userClaims('root'), sub: 'user:other' } }, 'forbidden/subject'],
        ['non-admin', { claims: userClaims('root', ['user']) }, 'forbidden/administrator'],
        ['algorithm none', { header: { alg: 'none' } }, 'unauthorized/algorithm'],
        ['algorithm HS512', { header: { alg: 'HS512' } }, 'unauthorized/algorithm'],
        ['lifetime over 30 s', { claims: { ...userClaims('root'), iat: seconds(), exp: seconds() + 31 } }, 'unauthorized/lifetime'],
        ['exp not after iat', { claims: { ...userClaims('root'), iat: seconds(), exp: seconds() } }, 'unauthorized/lifetime'],
        ['non-integer iat', { claims: { ...userClaims('root'), iat: seconds() + 0.5, exp: seconds() + 20 } }, 'unauthorized/lifetime'],
        ['not yet valid', { claims: { ...userClaims('root'), iat: seconds() + 120, exp: seconds() + 150 } }, 'unauthorized/not_yet_valid'],
        ['missing jti', { claims: { ...userClaims('root'), jti: undefined } }, 'unauthorized/jti'],
        ['empty jti', { claims: { ...userClaims('root'), jti: '' } }, 'unauthorized/jti'],
        ['oversize jti', { claims: { ...userClaims('root'), jti: 'j'.repeat(129) } }, 'unauthorized/jti'],
        ['four segments (a valid token plus one)', { token: `${validToken()}.extra` }, 'unauthorized/token_format'],
        ['oversize, correctly signed token', { claims: { ...userClaims('root'), pad: 'x'.repeat(6200) } }, 'unauthorized/token_format'],
        ['missing auth info', { authInfo: null }, 'unauthorized/auth_info'],
        ['auth info not JSON', { authInfo: 'not json' }, 'unauthorized/auth_info'],
        ['auth info without a token', { authInfo: '{}' }, 'unauthorized/auth_info'],
        ['oversize auth info around a valid token', { authInfo: JSON.stringify({ invocationToken: validToken(), pad: 'x'.repeat(16400) }) }, 'unauthorized/auth_info'],
        ['null actor', { claims: { sub: 'user:root', actor: null } }, 'forbidden/actor'],
        ['numeric actor id', { claims: { sub: 'user:root', actor: { kind: 'user', id: 7, roles: ['admin'] } } }, 'forbidden/actor']
    ];
    for (const [label, options, expected] of cases) {
        assert.equal(reasonOf(options), `CoordinatorAuthError/${expected}`, label);
    }
    assert.equal(count(dir, 'token_replay'), 0, 'no verifier refusal consumes a token');
    assert.equal(reasonOf({ claims: { ...userClaims('root'), caller: { kind: 'user', id: 'user:root' } } }), 'accepted', 'the user itself as caller is not delegation');
});
