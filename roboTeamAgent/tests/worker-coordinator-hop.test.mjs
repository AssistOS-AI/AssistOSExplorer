import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { COORDINATOR_BASE_ENV, classifyResponse, createWorkerCoordinatorHop, parseRefusalMarker } from '../server/worker-coordinator/hop.mjs';
import { STATUS, WorkerCoordinatorError, mapHopOutcome, settlesAsRefused } from '../server/worker-coordinator/errors.mjs';
import {
    bindOperationId, isBindingId, isFlowBindingId, isInternalId, isOperationId, isOriginId, isReferenceId, newOriginId, parseScheduleBindingId,
} from '../server/worker-coordinator/identities.mjs';

// The coordinator hop client against a local stand-in for the Router's private listener.
// The private assertion is signed by the sibling Ploinky checkout's real Agent library.
const PLOINKY_ROOT = fileURLToPath(new URL('../../../ploinky/', import.meta.url));
// The Agent libraries resolve AchillesAgentLib from here, as in a Ploinky-started agent.
process.env.PLOINKY_AGENTLIB_DIR ||= path.join(PLOINKY_ROOT, 'node_modules', 'achillesAgentLib');
const { computeRchHttp, sha256RawBodyHash } = await import(pathToFileURL(path.join(PLOINKY_ROOT, 'Agent/lib/requestHash.mjs')).href);
const BASE = '/base-agent-additional-server/robo-work/7311';
const SECRET = crypto.randomBytes(32).toString('hex');
const ENV = Object.freeze({
    PLOINKY_AGENT_RUNTIME_ROOT: path.join(PLOINKY_ROOT, 'Agent'),
    PLOINKY_AGENT_ID: 'agent:AchillesIDE/roboTeamAgent',
    PLOINKY_AGENT_INSTANCE_ID: 'instance-1',
    PLOINKY_AGENT_ENABLE_GENERATION: 'generation-1',
    PLOINKY_AGENT_PRIVATE_SECRET: SECRET,
    [COORDINATOR_BASE_ENV]: BASE,
});
const GRANT = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1c2VyOmFsaWNlIn0.c2lnbmF0dXJl';

// A private-listener stand-in. `reply(req, body, res)` answers; every request is recorded.
async function listener(t, reply) {
    const seen = [];
    const server = http.createServer((req, res) => {
        const chunks = [];
        req.on('data', (chunk) => chunks.push(chunk));
        req.on('end', () => {
            const body = Buffer.concat(chunks);
            seen.push({ method: req.method, url: req.url, headers: req.headers, body });
            reply(req, body, res);
        });
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise((resolve) => { server.closeAllConnections?.(); server.close(resolve); }));
    return { seen, url: `http://127.0.0.1:${server.address().port}` };
}

const json = (status, body, headers = {}) => (req, raw, res) => {
    const bytes = Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
    res.writeHead(status, { 'content-type': 'application/json', 'content-length': bytes.length, ...headers });
    res.end(bytes);
};

function decodeJwt(token) {
    const [header, payload, signature] = token.split('.');
    return { header, payload: JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')), signature };
}

test('identity grammars and the S3c-7 bind operation ID', () => {
    const origin = newOriginId();
    assert.equal(isOriginId(origin), true);
    assert.equal(isOriginId('A'.repeat(21)), false, '21 characters');
    assert.equal(isOriginId('A'.repeat(23)), false, '23 characters');
    assert.equal(isOriginId('AAAAAAAAAAAAAAAAAAAAAB'), false, '22 characters whose last one does not decode to 16 bytes');
    assert.equal(isOriginId('AAAAAAAAAAAAAAAAAAAAAA'), true);
    assert.equal(isOriginId('AAAAAAAAAAAAAAAAAAAAA+'), false, 'not base64url');
    assert.equal(isInternalId(origin), true);
    assert.equal(isReferenceId('a'.repeat(21)), false);
    assert.equal(isReferenceId('a'.repeat(22)), true);
    assert.equal(isReferenceId('a'.repeat(64)), true);
    assert.equal(isReferenceId('a'.repeat(65)), false);
    const flow = `flow_${'a1'.repeat(12)}`;
    const cron = `cron_${'0f'.repeat(12)}`;
    assert.equal(isFlowBindingId(flow), true);
    assert.deepEqual(parseScheduleBindingId(`${cron}.r1`), { scheduleId: cron, revision: 1 });
    assert.deepEqual(parseScheduleBindingId(`${cron}.r123456789`), { scheduleId: cron, revision: 123456789 });
    for (const bad of [`${cron}.r0`, `${cron}.r01`, `${cron}.r1234567890`, cron, `${cron}.r1x`, `gen_${'a'.repeat(24)}`, `flow_${'A1'.repeat(12)}`]) {
        assert.equal(isBindingId(bad), false, bad);
    }
    const operation = bindOperationId(flow);
    assert.equal(isOperationId(operation), true);
    assert.equal(bindOperationId(flow), operation, 'reproducible');
    assert.notEqual(bindOperationId(`${cron}.r1`), bindOperationId(`${cron}.r2`));
    assert.equal(operation, crypto.createHash('sha256').update(`roboteam/bind/v1\n${flow}`).digest('base64url').slice(0, 22));
    assert.throws(() => bindOperationId('flow_x'), TypeError);
});

test('the hop signs the exact body bytes for the routed coordinator path and sends the grant only when given', async (t) => {
    const stub = await listener(t, json(200, { taskRef: { version: 1, provider: 'agent:AchillesIDE/robo-work', id: 'r'.repeat(22) }, state: 'queued' }));
    const hop = createWorkerCoordinatorHop({ env: ENV, routerUrl: stub.url });
    const body = { originRequestId: newOriginId(), robotId: newOriginId(), configRevision: 1, kind: 'task', specification: { version: 1, taskType: 'simple', prompt: 'Résumé ✓' } };
    const granted = await hop.call('admissions', body, { grant: GRANT });
    assert.equal(granted.outcome, 'response');
    assert.equal(granted.status, 200);
    assert.equal(granted.refusal, null);
    const withoutGrant = await hop.call('lookup', { originRequestId: body.originRequestId });
    assert.equal(withoutGrant.status, 200);
    assert.equal(stub.seen.length, 2);
    const [first, second] = stub.seen;
    assert.equal(first.method, 'POST');
    assert.equal(first.url, `${BASE}/v1/coordinator/admissions`);
    assert.deepEqual(first.body, Buffer.from(JSON.stringify(body)), 'the signed bytes are the sent bytes');
    assert.equal(first.headers['x-ploinky-user-delegation'], GRANT);
    assert.equal(Object.keys(first.headers).filter((name) => name === 'x-ploinky-user-delegation').length, 1);
    assert.equal(second.url, `${BASE}/v1/coordinator/lookup`);
    assert.equal(Object.hasOwn(second.headers, 'x-ploinky-user-delegation'), false, 'no grant header without a grant');
    for (const seen of stub.seen) {
        const assertion = seen.headers['ploinky-agent-assertion'];
        const { header, payload, signature } = decodeJwt(assertion);
        const expected = crypto.createHmac('sha256', Buffer.from(SECRET, 'hex')).update(`${header}.${assertion.split('.')[1]}`).digest('base64url');
        assert.equal(signature, expected, 'signed with the private secret');
        assert.equal(payload.typ, 'private-agent-assertion');
        assert.equal(payload.iss, ENV.PLOINKY_AGENT_ID);
        assert.equal(payload.instanceId, ENV.PLOINKY_AGENT_INSTANCE_ID);
        assert.equal(payload.path, seen.url);
        assert.equal(payload.rch, computeRchHttp({ method: 'POST', path: seen.url, query: '', bodyHash: sha256RawBodyHash(seen.body) }));
    }
    const stored = Buffer.from('{"originRequestId":"x"}');
    await hop.call('admissions', stored, { grant: GRANT });
    assert.deepEqual(stub.seen[2].body, stored, 'stored bytes are retransmitted unchanged');
});

test('the hop refuses before any I/O without a base, identity, Agent libraries, descriptor or a well-formed grant', async (t) => {
    const stub = await listener(t, json(200, {}));
    const cases = {
        'no base': { env: { ...ENV, [COORDINATOR_BASE_ENV]: '' }, routerUrl: stub.url },
        'base with a path suffix': { env: { ...ENV, [COORDINATOR_BASE_ENV]: `${BASE}/v1` }, routerUrl: stub.url },
        'base on port 0': { env: { ...ENV, [COORDINATOR_BASE_ENV]: '/base-agent-additional-server/robo-work/0' }, routerUrl: stub.url },
        'short private secret': { env: { ...ENV, PLOINKY_AGENT_PRIVATE_SECRET: 'ab' }, routerUrl: stub.url },
        'no instance': { env: { ...ENV, PLOINKY_AGENT_INSTANCE_ID: '' }, routerUrl: stub.url },
        'no enable generation': { env: { ...ENV, PLOINKY_AGENT_ENABLE_GENERATION: '' }, routerUrl: stub.url },
        'no agent id': { env: { ...ENV, PLOINKY_AGENT_ID: '' }, routerUrl: stub.url },
        'no Agent libraries': { env: { ...ENV, PLOINKY_AGENT_RUNTIME_ROOT: path.join(PLOINKY_ROOT, 'no-such-agent-root') }, routerUrl: stub.url },
        'no verified descriptor': { env: ENV },
        'non-http private origin': { env: ENV, routerUrl: 'https://127.0.0.1:1' },
    };
    for (const [name, options] of Object.entries(cases)) {
        const hop = createWorkerCoordinatorHop(options);
        await assert.rejects(hop.call('lookup', { originRequestId: newOriginId() }, { grant: GRANT }),
            (error) => error instanceof WorkerCoordinatorError && error.code === 'worker_coordinator_unavailable' && error.status === 503, name);
    }
    const hop = createWorkerCoordinatorHop({ env: ENV, routerUrl: stub.url });
    for (const grant of ['not-a-jwt', 'a.b.c\r\nx-evil: 1', `${'a'.repeat(17000)}.b.c`]) {
        await assert.rejects(hop.call('lookup', { originRequestId: newOriginId() }, { grant }), (error) => error.code === 'owner_evidence_unavailable');
    }
    for (const operation of ['robots/delete', 'robots/list', 'references/short/read', 'admissions?x=1', '../admissions', 'references/' + 'a'.repeat(22) + '/delete']) {
        await assert.rejects(hop.call(operation, {}), (error) => error.code === 'invalid_request', operation);
    }
    assert.equal(stub.seen.length, 0, 'no request reached the listener');
});

test('hop outcomes: unmarked 502/504 and statuses the worker never sends are unknown; a marked refusal is a refusal', async (t) => {
    const replies = [];
    const stub = await listener(t, (req, body, res) => replies.shift()(req, body, res));
    const hop = createWorkerCoordinatorHop({ env: ENV, routerUrl: stub.url });
    const call = async (reply) => { replies.push(reply); return hop.call('admissions', { originRequestId: newOriginId() }, { grant: GRANT }); };
    const marker = { 'x-ploinky-refusal': 'v=1; stage=relay; cause=upstream-unavailable' };
    assert.deepEqual(await call(json(502, { ok: false, error: 'bad gateway' })), { outcome: 'unknown', status: 502 });
    assert.deepEqual(await call(json(504, { ok: false, error: 'timeout' })), { outcome: 'unknown', status: 504 });
    assert.deepEqual(await call(json(418, {})), { outcome: 'unknown', status: 418 });
    assert.deepEqual(await call(json(200, 'not json')), { outcome: 'unknown', status: 200 });
    const marked = await call(json(502, { ok: false }, marker));
    assert.equal(marked.outcome, 'response');
    assert.deepEqual(marked.refusal, { stage: 'relay', cause: 'upstream-unavailable' });
    const malformedMarker = await call(json(502, {}, { 'x-ploinky-refusal': 'stage=relay' }));
    assert.deepEqual(malformedMarker, { outcome: 'unknown', status: 502 }, 'a malformed marker is no marker');
    const notFound = await call(json(404, { error: 'not_found' }));
    assert.equal(notFound.outcome, 'response');
    assert.equal(notFound.status, 404);
    assert.deepEqual(await call((req, body, res) => req.socket.destroy()), { outcome: 'unknown' }, 'dropped after the request was written');
    const big = Buffer.alloc(1024 * 1024 + 1, 0x20);
    assert.deepEqual(await call((req, body, res) => { res.writeHead(200, { 'content-length': big.length }); res.end(big); }), { outcome: 'unknown', status: 200 });
    // A closed port: nothing was written.
    const closed = http.createServer();
    await new Promise((resolve) => closed.listen(0, '127.0.0.1', resolve));
    const closedUrl = `http://127.0.0.1:${closed.address().port}`;
    await new Promise((resolve) => closed.close(resolve));
    const unsent = await createWorkerCoordinatorHop({ env: ENV, routerUrl: closedUrl }).call('lookup', { originRequestId: newOriginId() });
    assert.deepEqual(unsent, { outcome: 'unsent' });
    // A listener that never answers: written but no complete response.
    const silent = await listener(t, () => {});
    assert.deepEqual(await createWorkerCoordinatorHop({ env: ENV, routerUrl: silent.url, timeoutMs: 200 }).call('lookup', { originRequestId: newOriginId() }), { outcome: 'unknown' });
});

test('every response-mapping row; no mapped body carries a reason, token or grant', () => {
    const response = (status, body, refusal = null) => ({ outcome: 'response', status, json: body, refusal });
    const rows = [
        [{ outcome: 'unsent' }, 503, { error: 'worker_unreachable' }],
        [{ outcome: 'unknown' }, 503, { error: 'worker_reply_unknown' }],
        [{ outcome: 'unknown', status: 502 }, 503, { error: 'worker_reply_unknown' }],
        [response(503, { error: 'x' }, { stage: 'relay', cause: 'relay-busy' }), 503, { error: 'worker_route_unavailable' }],
        [response(403, { ok: false, error: 'COORDINATOR_OWNER_GRANT_REJECTED' }, { stage: 'auth', cause: 'forbidden' }), 503, { error: 'worker_route_unavailable' }],
        [response(200, { taskRef: { id: 'r' }, state: 'queued' }), 200, { taskRef: { id: 'r' }, state: 'queued' }],
        [response(400, { error: 'invalid_request', reason: 'origin_claims' }), 400, { error: 'invalid_request' }],
        [response(400, { error: 'operation_unavailable' }), 400, { error: 'operation_unavailable' }],
        [response(404, { error: 'not_found' }), 404, { error: 'not_found' }],
        [response(409, { error: 'operation_conflict', reason: 'x' }), 409, { error: 'operation_conflict' }],
        [response(409, { error: 'retention_gap', snapshotSequence: 7 }), 409, { error: 'retention_gap', snapshotSequence: 7 }],
        [response(403, { error: 'forbidden', reason: 'row_ambiguous' }), 403, { error: 'forbidden' }],
        [response(403, { ok: false, error: 'COORDINATOR_OWNER_GRANT_REJECTED' }), 403, { error: 'forbidden' }],
        [response(401, { error: 'unauthorized', reason: 'token_replayed' }), 502, { error: 'worker_auth_failed' }],
        [response(401, { ok: false, error: 'PRIVATE_REQUEST_REJECTED' }), 502, { error: 'worker_auth_failed' }],
        [response(503, { error: 'runtime_unavailable' }), 503, { error: 'runtime_unavailable' }],
        [response(503, { error: 'capacity_exceeded' }), 503, { error: 'capacity_exceeded' }],
        [response(500, { error: 'state_corrupt' }), 500, { error: 'state_corrupt' }],
        [response(500, { error: 'BAD CODE <script>' }), 500, { error: 'state_corrupt' }],
        [response(404, undefined), 404, { error: 'not_found' }],
    ];
    for (const [outcome, status, body] of rows) {
        const mapped = mapHopOutcome(outcome);
        assert.equal(mapped.status, status, JSON.stringify(outcome));
        assert.deepEqual(mapped.body, body, JSON.stringify(outcome));
        if (status !== 200) assert.doesNotMatch(JSON.stringify(mapped.body), /reason|token|grant|delegation/iu);
    }
    assert.equal(settlesAsRefused(response(404, {})), true);
    assert.equal(settlesAsRefused(response(503, {})), true, 'a worker 503 rolled back');
    assert.equal(settlesAsRefused(response(500, {})), true, 'a worker 500 rolled back');
    assert.equal(settlesAsRefused(response(502, {}, { stage: 'relay', cause: 'relay-busy' })), true, 'a marked refusal forwarded nothing');
    assert.equal(settlesAsRefused({ outcome: 'unknown', status: 502 }), false);
    assert.equal(settlesAsRefused({ outcome: 'unknown' }), false);
    assert.equal(settlesAsRefused(response(200, {})), false);
    assert.equal(STATUS.owner_evidence_unavailable, 403);
    assert.equal(parseRefusalMarker(['v=1; stage=route; cause=route-denied']).cause, 'route-denied');
    assert.deepEqual(classifyResponse(401, {}, Buffer.from('{}')), { outcome: 'response', status: 401, json: {}, refusal: null });
});
