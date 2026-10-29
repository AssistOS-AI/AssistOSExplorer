import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { createRoboTeamServer } from '../server/http-server.mjs';
import { RobotStore } from '../server/robot-store.mjs';
import { COORDINATOR_BASE_ENV, createWorkerCoordinatorHop } from '../server/worker-coordinator/hop.mjs';
import { WorkerCoordinatorError } from '../server/worker-coordinator/errors.mjs';
import { newOriginId } from '../server/worker-coordinator/identities.mjs';
import { handleWorkerRoutes } from '../server/worker-coordinator/browser-routes.mjs';
import { authInfoOf, decodeJwtPayload, routedHeaders } from './helpers/router-worker.mjs';

// RoboTeam's browser API row against the real createRoboTeamServer: requests are Router-signed
// by the sibling Ploinky checkout over RoboTeam's real manifest, and verified by its real Agent
// helper; the coordinator hop is a recording stub (or, where headers matter, the real hop
// against a local private-listener stand-in). No Linux facility is used.
const PLOINKY_ROOT = fileURLToPath(new URL('../../../ploinky/', import.meta.url));
const ALICE = { id: 'alice', roles: ['user'] };
const BOB = { id: 'bob', roles: ['user'] };
const ADMIN = { id: 'admin-v', roles: ['admin'] };
const TASK_REF = { version: 1, provider: 'agent:AchillesIDE/robo-work', id: 'R'.repeat(22) };

function stubHop(script = {}) {
    const calls = [];
    return {
        calls,
        async call(operation, body, { grant } = {}) {
            const bytes = Buffer.isBuffer(body) ? body.toString('utf8') : typeof body === 'string' ? body : JSON.stringify(body);
            calls.push({ operation, body: JSON.parse(bytes), grant });
            const reply = script[operation];
            const outcome = typeof reply === 'function' ? reply(calls.at(-1), calls) : reply;
            if (outcome instanceof Error) throw outcome;
            return outcome || { outcome: 'response', status: 200, json: { taskRef: TASK_REF, state: 'queued', originRequestId: calls.at(-1).body.originRequestId }, refusal: null };
        },
    };
}

async function startServer(t, { hop, roboflow } = {}) {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'roboteam-worker-browser-')));
    const workspaceRoot = path.join(root, 'workspace');
    await fs.mkdir(workspaceRoot);
    const previousWorkspaceRoot = process.env.PLOINKY_WORKSPACE_ROOT;
    process.env.PLOINKY_WORKSPACE_ROOT = workspaceRoot;
    const robotStore = new RobotStore({ dataDir: path.join(root, 'private') });
    await robotStore.initialize();
    // Every local launch entry point is a spy: the worker routes must never reach one.
    const local = { start: 0, startTask: 0, resumeTask: 0, sendTaskMessage: 0 };
    const runtimeManager = {
        workspaceRoot, status: () => ({ state: 'stopped' }), activePort: () => null, hasUnfinishedTasks: () => false, logs: async () => '',
        start: async () => { local.start += 1; }, startTask: () => { local.startTask += 1; },
        resumeTask: () => { local.resumeTask += 1; }, sendTaskMessage: () => { local.sendTaskMessage += 1; },
    };
    const server = createRoboTeamServer({ robotStore, runtimeManager, internalToken: 'test-token', publicBasePath: '/rt/', mcpPort: 65534,
        ...(hop === undefined ? {} : { workerCoordinator: hop === null ? null : { hop } }), ...(roboflow ? { roboflow } : {}) });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    t.after(async () => {
        await new Promise((resolve) => server.close(resolve));
        if (previousWorkspaceRoot === undefined) delete process.env.PLOINKY_WORKSPACE_ROOT;
        else process.env.PLOINKY_WORKSPACE_ROOT = previousWorkspaceRoot;
        await fs.rm(root, { recursive: true, force: true });
    });
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    // POST as `user` through the routed (grant-bearing) declaration; `headers` overrides.
    const post = async (pathname, body, { user = ALICE, headers, raw } = {}) => {
        const text = raw ?? JSON.stringify(body);
        const signed = user ? routedHeaders(user, 'POST', pathname, text) : {};
        const response = await fetch(`${baseUrl}${pathname}`, { method: 'POST', headers: { 'content-type': 'application/json', ...signed, ...headers }, body: text });
        return { status: response.status, body: await response.json() };
    };
    return { baseUrl, post, local };
}

const admission = (extra = {}) => ({ originRequestId: newOriginId(), robotId: newOriginId(), configRevision: 1, kind: 'task',
    task: { type: 'simple', prompt: 'Summarize the release notes' }, ...extra });

test('a routed admission relays the exact A1 body with the requesting user\'s grant and returns the worker reply', async (t) => {
    const hop = stubHop();
    const { post, local } = await startServer(t, { hop });
    const body = admission({ task: { type: 'browser', prompt: 'Open the dashboard', cwd: 'projects/site' } });
    const result = await post('/api/worker/admissions', body);
    assert.equal(result.status, 200);
    assert.deepEqual(result.body, { taskRef: TASK_REF, state: 'queued', originRequestId: body.originRequestId });
    assert.equal(hop.calls.length, 1);
    const [call] = hop.calls;
    assert.equal(call.operation, 'admissions');
    assert.deepEqual(call.body, { originRequestId: body.originRequestId, robotId: body.robotId, configRevision: 1, kind: 'task',
        specification: { version: 1, taskType: 'browser', prompt: 'Open the dashboard', cwd: 'projects/site' } });
    for (const key of ['taskRefOrigin', 'originTool', 'bindingId']) assert.equal(Object.hasOwn(call.body, key), false, key);
    const grant = decodeJwtPayload(call.grant);
    assert.equal(grant.typ, 'user-delegation');
    assert.equal(grant.sub, 'user:alice');
    assert.deepEqual(grant.allowedTools, ['__coordinator_admission__']);
    assert.deepEqual(grant.allowedTargets, ['agent:AchillesIDE/robo-work']);
    assert.deepEqual(grant.scope, ['execution:owner']);
    const logicalId = newOriginId();
    const continuation = admission({ kind: 'continuation', logicalId });
    assert.equal((await post('/api/worker/admissions', continuation)).status, 200);
    assert.deepEqual(hop.calls[1].body.logical, { logicalId });
    assert.deepEqual(local, { start: 0, startTask: 0, resumeTask: 0, sendTaskMessage: 0 });
});

test('the real hop sends exactly one grant header and the body bytes to the private listener', async (t) => {
    const seen = [];
    const listener = http.createServer((req, res) => {
        const chunks = [];
        req.on('data', (chunk) => chunks.push(chunk));
        req.on('end', () => {
            seen.push({ url: req.url, rawHeaders: req.rawHeaders, body: Buffer.concat(chunks).toString('utf8') });
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ taskRef: TASK_REF, state: 'queued', originRequestId: JSON.parse(Buffer.concat(chunks)).originRequestId }));
        });
    });
    await new Promise((resolve) => listener.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise((resolve) => listener.close(resolve)));
    process.env.PLOINKY_AGENTLIB_DIR ||= path.join(PLOINKY_ROOT, 'node_modules', 'achillesAgentLib');
    const hop = createWorkerCoordinatorHop({ routerUrl: `http://127.0.0.1:${listener.address().port}`, env: {
        PLOINKY_AGENT_RUNTIME_ROOT: path.join(PLOINKY_ROOT, 'Agent'), PLOINKY_AGENT_ID: 'agent:AchillesIDE/roboTeamAgent',
        PLOINKY_AGENT_INSTANCE_ID: 'i-1', PLOINKY_AGENT_ENABLE_GENERATION: 'g-1', PLOINKY_AGENT_PRIVATE_SECRET: crypto.randomBytes(32).toString('hex'),
        [COORDINATOR_BASE_ENV]: '/base-agent-additional-server/robo-work/7311' } });
    const { post } = await startServer(t, { hop });
    const body = admission();
    assert.equal((await post('/api/worker/admissions', body)).status, 200);
    assert.equal(seen.length, 1);
    assert.equal(seen[0].url, '/base-agent-additional-server/robo-work/7311/v1/coordinator/admissions');
    const names = seen[0].rawHeaders.filter((_, index) => index % 2 === 0).map((name) => name.toLowerCase());
    assert.equal(names.filter((name) => name === 'x-ploinky-user-delegation').length, 1);
    assert.equal(names.filter((name) => name === 'ploinky-agent-assertion').length, 1);
    assert.equal(names.includes('x-ploinky-auth-info'), false, 'the browser auth-info is not forwarded');
    const grant = seen[0].rawHeaders[seen[0].rawHeaders.findIndex((name) => name.toLowerCase() === 'x-ploinky-user-delegation') + 1];
    assert.equal(decodeJwtPayload(grant).sub, 'user:alice');
    assert.equal(JSON.parse(seen[0].body).originRequestId, body.originRequestId);
});

test('owner evidence: internal callers, the broad route, a grant for another user and unconfigured hops are refused with zero hops', async (t) => {
    const hop = stubHop();
    const { post, baseUrl, local } = await startServer(t, { hop });
    const body = admission();
    const text = JSON.stringify(body);
    const internal = await post('/api/worker/admissions', body, { user: null, headers: { 'x-roboteam-internal-token': 'test-token', 'x-roboteam-user-id': 'alice', 'x-roboteam-user-roles': '["admin"]' } });
    assert.deepEqual(internal, { status: 403, body: { error: 'owner_evidence_unavailable' } });
    // Internal token plus a valid routed request: the internal caller still decides.
    const both = await post('/api/worker/admissions', body, { headers: { 'x-roboteam-internal-token': 'test-token' } });
    assert.deepEqual(both, { status: 403, body: { error: 'owner_evidence_unavailable' } });
    // A request routed through the broad declaration carries no grant.
    const broad = routedHeaders(ALICE, 'POST', '/api/worker/admissions', text, { manifest: { routerAccess: { httpRoutes: [
        { path: '/base-agent-additional-server/roboTeamAgent/3001/*', access: 'authenticated' }] } } });
    assert.equal(Object.hasOwn(authInfoOf(broad), 'delegations'), false);
    assert.deepEqual(await post('/api/worker/admissions', body, { user: null, headers: broad }), { status: 403, body: { error: 'owner_evidence_unavailable' } });
    // Alice's signed request carrying Bob's grant: the auth-info grant is not covered by the
    // request signature, so RoboTeam compares the grant's user with the verified principal.
    const aliceHeaders = routedHeaders(ALICE, 'POST', '/api/worker/admissions', text);
    const bobGrant = authInfoOf(routedHeaders(BOB, 'POST', '/api/worker/admissions', text)).delegations;
    const swapped = { 'x-ploinky-auth-info': JSON.stringify({ ...authInfoOf(aliceHeaders), delegations: bobGrant }) };
    assert.deepEqual(await post('/api/worker/admissions', body, { user: null, headers: swapped }), { status: 403, body: { error: 'owner_evidence_unavailable' } });
    // Each case mints fresh headers: the verifier refuses a replayed invocation token.
    const freshAlice = () => routedHeaders(ALICE, 'POST', '/api/worker/admissions', text);
    const forged = { 'x-ploinky-auth-info': JSON.stringify({ ...authInfoOf(freshAlice()), delegations: { providerAdmission: { token: 'a.b.c' } } }) };
    assert.deepEqual(await post('/api/worker/admissions', body, { user: null, headers: forged }), { status: 403, body: { error: 'owner_evidence_unavailable' } });
    // Positive control for the swap: Alice's own grant moved into another of her requests passes.
    const ownGrant = authInfoOf(freshAlice()).delegations;
    const ownSwap = { 'x-ploinky-auth-info': JSON.stringify({ ...authInfoOf(freshAlice()), delegations: ownGrant }) };
    const control = stubHop();
    const controlServer = await startServer(t, { hop: control });
    assert.equal((await controlServer.post('/api/worker/admissions', body, { user: null, headers: ownSwap })).status, 200);
    assert.equal(control.calls.length, 1);
    // Unsigned and guest callers stop at the existing gate.
    assert.equal((await post('/api/worker/admissions', body, { user: null })).status, 401);
    assert.equal((await post('/api/worker/admissions', body, { user: { id: 'g', roles: ['guest'] } })).status, 403);
    // The signature binds the body: a different body under Alice's headers is refused.
    assert.equal((await post('/api/worker/admissions', admission(), { user: null, headers: freshAlice() })).status, 401);
    // A replayed request is refused by the verifier.
    assert.equal((await post('/api/worker/admissions', body, { user: null, headers: aliceHeaders })).status, 401);
    assert.equal(hop.calls.length, 0);
    const unconfigured = await startServer(t, { hop: null });
    assert.deepEqual(await unconfigured.post('/api/worker/admissions', body), { status: 503, body: { error: 'worker_coordinator_unavailable' } });
    const failing = await startServer(t, { hop: stubHop({ admissions: new WorkerCoordinatorError('worker_coordinator_unavailable', 503) }) });
    assert.deepEqual(await failing.post('/api/worker/admissions', admission()), { status: 503, body: { error: 'worker_coordinator_unavailable' } });
    assert.equal((await fetch(`${baseUrl}/api/worker/admissions`, { method: 'GET', headers: routedHeaders(ALICE, 'GET', '/api/worker/admissions') })).status, 400);
    assert.deepEqual(local, { start: 0, startTask: 0, resumeTask: 0, sendTaskMessage: 0 });
});

test('boundary and malformed requests are refused with 400 and no hop; a unicode prompt is accepted', async (t) => {
    const hop = stubHop();
    const { post } = await startServer(t, { hop });
    const cases = {
        'origin of 21': admission({ originRequestId: 'A'.repeat(21) }),
        'origin of 23': admission({ originRequestId: 'A'.repeat(23) }),
        'non-canonical origin': admission({ originRequestId: 'AAAAAAAAAAAAAAAAAAAAAB' }),
        'empty prompt': admission({ task: { type: 'simple', prompt: '' } }),
        'prompt of 32769': admission({ task: { type: 'simple', prompt: 'x'.repeat(32769) } }),
        'unknown task type': admission({ task: { type: 'shell', prompt: 'x' } }),
        'absolute cwd': admission({ task: { type: 'simple', prompt: 'x', cwd: '/etc' } }),
        'parent cwd': admission({ task: { type: 'simple', prompt: 'x', cwd: 'a/../../b' } }),
        'long cwd': admission({ task: { type: 'simple', prompt: 'x', cwd: 'a'.repeat(4097) } }),
        'extra key': { ...admission(), owner: 'user:alice' },
        'extra task key': admission({ task: { type: 'simple', prompt: 'x', path: '/x' } }),
        'task with logicalId': admission({ logicalId: newOriginId() }),
        'continuation without logicalId': admission({ kind: 'continuation' }),
        'zero config revision': admission({ configRevision: 0 }),
        'robot name instead of ID': admission({ robotId: 'default' }),
        'missing kind': admission({ kind: undefined }),
    };
    for (const [name, body] of Object.entries(cases)) {
        assert.deepEqual(await post('/api/worker/admissions', body), { status: 400, body: { error: 'invalid_request' } }, name);
    }
    for (const kind of ['session', 'flow', 'generation', 7]) {
        assert.deepEqual(await post('/api/worker/admissions', admission({ kind })), { status: 400, body: { error: 'logical_kind_unavailable' } }, String(kind));
    }
    assert.deepEqual(await post('/api/worker/admissions', null, { raw: '{"originRequestId":' }), { status: 400, body: { error: 'invalid_request' } });
    assert.deepEqual(await post('/api/worker/admissions', null, { raw: '[]' }), { status: 400, body: { error: 'invalid_request' } });
    for (const id of ['r'.repeat(21), 'r'.repeat(65), 'r'.repeat(21) + '.']) {
        assert.equal((await post(`/api/worker/references/${id}/read`, {})).status, 400, id);
    }
    assert.deepEqual(await post('/api/worker/references/' + 'r'.repeat(22) + '/read', { extra: 1 }), { status: 400, body: { error: 'invalid_request' } });
    assert.deepEqual(await post('/api/worker/references/' + 'r'.repeat(22) + '/events', { after: -1, limit: 10 }), { status: 400, body: { error: 'invalid_request' } });
    assert.deepEqual(await post('/api/worker/references/' + 'r'.repeat(22) + '/control', { operationId: 'short', op: 'stop' }), { status: 400, body: { error: 'invalid_request' } });
    assert.deepEqual(await post('/api/worker/lookup', { originRequestId: 'A'.repeat(23) }), { status: 400, body: { error: 'invalid_request' } });
    assert.deepEqual(await post('/api/worker/delete', {}), { status: 404, body: { error: 'not_found' } });
    assert.equal(hop.calls.length, 0, 'no refused request reached the hop');
    const unicode = admission({ task: { type: 'simple', prompt: 'Résumé ✓ — 日本語 \u{1F680}' } });
    assert.equal((await post('/api/worker/admissions', unicode)).status, 200);
    // The full 32768-character prompt in multi-byte characters fits the admission body limit.
    const wide = admission({ task: { type: 'simple', prompt: '日'.repeat(32768) } });
    assert.equal((await post('/api/worker/admissions', wide)).status, 200);
    assert.equal(hop.calls.at(-1).body.specification.prompt.length, 32768);
});

test('lookup, read, events and control relay exact bodies with the grant; idempotent replays relay the same body', async (t) => {
    const hop = stubHop({
        lookup: { outcome: 'response', status: 404, json: { error: 'not_found' }, refusal: null },
        [`references/${'r'.repeat(22)}/read`]: { outcome: 'response', status: 200, json: { taskRef: TASK_REF, state: 'running' }, refusal: null },
        [`references/${'r'.repeat(22)}/events`]: { outcome: 'response', status: 200, json: { events: [], nextAfter: 3 }, refusal: null },
        [`references/${'r'.repeat(22)}/control`]: { outcome: 'response', status: 200, json: { outcome: 'delivered' }, refusal: null },
    });
    const { post } = await startServer(t, { hop });
    const origin = newOriginId();
    assert.deepEqual(await post('/api/worker/lookup', { originRequestId: origin }), { status: 404, body: { error: 'not_found' } });
    const ref = `/api/worker/references/${'r'.repeat(22)}`;
    assert.deepEqual(await post(`${ref}/read`, {}), { status: 200, body: { taskRef: TASK_REF, state: 'running' } });
    assert.deepEqual(await post(`${ref}/events`, { after: 3, limit: 50 }), { status: 200, body: { events: [], nextAfter: 3 } });
    const control = { operationId: 'O'.repeat(22), op: 'message', attemptId: newOriginId(), payload: { text: 'continue' } };
    assert.deepEqual(await post(`${ref}/control`, control, { user: ADMIN }), { status: 200, body: { outcome: 'delivered' } });
    assert.deepEqual(await post(`${ref}/control`, control, { user: ADMIN }), { status: 200, body: { outcome: 'delivered' } });
    assert.deepEqual(hop.calls.map(({ operation, body }) => [operation, body]), [
        ['lookup', { originRequestId: origin }],
        [`references/${'r'.repeat(22)}/read`, {}],
        [`references/${'r'.repeat(22)}/events`, { after: 3, limit: 50 }],
        [`references/${'r'.repeat(22)}/control`, control],
        [`references/${'r'.repeat(22)}/control`, control],
    ]);
    assert.deepEqual(hop.calls.map(({ grant }) => decodeJwtPayload(grant).sub), ['user:alice', 'user:alice', 'user:alice', 'user:admin-v', 'user:admin-v']);
    // The same admission twice relays the same body (the worker answers with the same reference).
    const body = admission();
    await post('/api/worker/admissions', body);
    await post('/api/worker/admissions', body);
    assert.deepEqual(hop.calls.at(-1).body, hop.calls.at(-2).body);
    assert.notEqual(hop.calls.at(-1).grant, hop.calls.at(-2).grant, 'each request carries its own fresh grant');
});

test('a lost admission reply (unmarked 502 or 504) is recovered by one same-grant lookup; a marked refusal is not', async (t) => {
    const committed = { taskRef: TASK_REF, state: 'queued' };
    for (const status of [502, 504]) {
        const hop = stubHop({ admissions: { outcome: 'unknown', status }, lookup: { outcome: 'response', status: 200, json: committed, refusal: null } });
        const { post } = await startServer(t, { hop });
        const body = admission();
        assert.deepEqual(await post('/api/worker/admissions', body), { status: 200, body: committed }, String(status));
        assert.deepEqual(hop.calls.map(({ operation }) => operation), ['admissions', 'lookup']);
        assert.deepEqual(hop.calls[1].body, { originRequestId: body.originRequestId });
        assert.equal(hop.calls[1].grant, hop.calls[0].grant, 'the same grant');
    }
    const marked = stubHop({ admissions: { outcome: 'response', status: 502, json: {}, refusal: { stage: 'relay', cause: 'relay-busy' } } });
    const markedServer = await startServer(t, { hop: marked });
    assert.deepEqual(await markedServer.post('/api/worker/admissions', admission()), { status: 503, body: { error: 'worker_route_unavailable' } });
    assert.deepEqual(marked.calls.map(({ operation }) => operation), ['admissions'], 'no lookup after a marked refusal');
    // Any non-200 recovery lookup leaves the outcome unknown, with the origin.
    const lookups = {
        unknown: { outcome: 'unknown' }, 'unmarked 504': { outcome: 'unknown', status: 504 }, unsent: { outcome: 'unsent' },
        401: { outcome: 'response', status: 401, json: {}, refusal: null }, 403: { outcome: 'response', status: 403, json: {}, refusal: null },
        404: { outcome: 'response', status: 404, json: { error: 'not_found' }, refusal: null },
        marked: { outcome: 'response', status: 503, json: {}, refusal: { stage: 'relay', cause: 'relay-busy' } },
        500: { outcome: 'response', status: 500, json: { error: 'state_corrupt' }, refusal: null },
        503: { outcome: 'response', status: 503, json: { error: 'runtime_unavailable' }, refusal: null },
        'lookup throws': new WorkerCoordinatorError('worker_coordinator_unavailable', 503),
    };
    for (const [name, lookup] of Object.entries(lookups)) {
        const hop = stubHop({ admissions: { outcome: 'unknown', status: 502 }, lookup });
        const { post, local } = await startServer(t, { hop });
        const body = admission();
        assert.deepEqual(await post('/api/worker/admissions', body), { status: 503, body: { error: 'worker_reply_unknown', originRequestId: body.originRequestId } }, name);
        assert.deepEqual(local, { start: 0, startTask: 0, resumeTask: 0, sendTaskMessage: 0 }, name);
    }
});

test('worker refusals map to fixed codes and never fall back to local execution', async (t) => {
    const rows = [
        [{ outcome: 'unsent' }, 503, { error: 'worker_unreachable' }],
        [{ outcome: 'response', status: 503, json: { error: 'runtime_unavailable', reason: 'x' }, refusal: null }, 503, { error: 'runtime_unavailable' }],
        [{ outcome: 'response', status: 401, json: { error: 'unauthorized', reason: 'token_replayed' }, refusal: null }, 502, { error: 'worker_auth_failed' }],
        [{ outcome: 'response', status: 403, json: { error: 'forbidden', reason: 'row_ambiguous' }, refusal: null }, 403, { error: 'forbidden' }],
        [{ outcome: 'response', status: 409, json: { error: 'operation_conflict' }, refusal: null }, 409, { error: 'operation_conflict' }],
        [{ outcome: 'response', status: 400, json: { error: 'invalid_request' }, refusal: null }, 400, { error: 'invalid_request' }],
    ];
    for (const [outcome, status, body] of rows) {
        const hop = stubHop({ admissions: outcome });
        const { post, local } = await startServer(t, { hop });
        assert.deepEqual(await post('/api/worker/admissions', admission()), { status, body });
        assert.deepEqual(local, { start: 0, startTask: 0, resumeTask: 0, sendTaskMessage: 0 });
    }
});

test('the route itself refuses a non-user decision even when the request carries a valid grant', async () => {
    const text = JSON.stringify(admission());
    const headers = routedHeaders(ALICE, 'POST', '/api/worker/admissions', text);
    const hop = stubHop();
    for (const access of [{ ok: true, internal: true, canAdmin: true, principal: 'user:alice' }, { ok: true, internal: false, principal: 'agent:x/y' },
        { ok: true, internal: false, principal: null }, null]) {
        let sent = null;
        await handleWorkerRoutes({ req: { method: 'POST', headers }, res: {}, pathname: '/api/worker/admissions', access, rawBody: Buffer.from(text), hop,
            records: null, sendJson: (res, status, body) => { sent = { status, body }; } });
        assert.deepEqual(sent, { status: 403, body: { error: 'owner_evidence_unavailable' } }, JSON.stringify(access));
    }
    let sent = null;
    await handleWorkerRoutes({ req: { method: 'POST', headers }, res: {}, pathname: '/api/worker/admissions', access: { ok: true, internal: false, canAdmin: false, principal: 'user:alice' },
        rawBody: Buffer.from(text), hop, records: null, sendJson: (res, status, body) => { sent = { status, body }; } });
    assert.equal(sent.status, 200, 'positive control: the same grant under a verified user decision is relayed');
    assert.equal(hop.calls.length, 1);
});
