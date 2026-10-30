import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import { COORDINATOR_BASE_ENV, createWorkerCoordinatorHop } from '../server/worker-coordinator/hop.mjs';
import { WorkerCoordinatorError } from '../server/worker-coordinator/errors.mjs';
import { WorkerError, createWorkerClient } from '../server/worker-coordinator/worker-client.mjs';

// The streaming hop (decision M-12 (a)): one NDJSON event subscription authorized at open, against a
// loopback stand-in for the Router's private listener. The private assertion signer is injected, so
// no Agent library or sibling checkout is needed.
const BASE = '/base-agent-additional-server/robo-work/7311';
const ENV = Object.freeze({
    PLOINKY_AGENT_ID: 'agent:AchillesIDE/roboTeamAgent', PLOINKY_AGENT_INSTANCE_ID: 'i', PLOINKY_AGENT_ENABLE_GENERATION: 'g',
    PLOINKY_AGENT_PRIVATE_SECRET: 'a'.repeat(64), [COORDINATOR_BASE_ENV]: BASE,
});
const GRANT = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1c2VyOmFsaWNlIn0.c2lnbmF0dXJl';
const REFERENCE = 'r'.repeat(22);
const OPERATION = `references/${REFERENCE}/events`;

async function listener(t, reply) {
    const seen = [];
    const server = http.createServer((req, res) => {
        const chunks = [];
        req.on('data', (chunk) => chunks.push(chunk));
        req.on('end', () => { seen.push({ url: req.url, headers: req.headers, body: Buffer.concat(chunks).toString('utf8') }); reply(req, res, seen.length); });
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise((resolve) => { server.closeAllConnections?.(); server.close(resolve); }));
    return { seen, url: `http://127.0.0.1:${server.address().port}` };
}

const hopFor = (url, extra = {}) => createWorkerCoordinatorHop({ env: ENV, routerUrl: url, libraries: { assertion: { signPrivateRouterAssertion: () => 'signed' } }, ...extra });
const ndjson = (res, status = 200) => res.writeHead(status, { 'content-type': 'application/x-ndjson' });
const collect = async (lines) => { const out = []; for await (const line of lines) out.push(line); return out; };

test('a 200 NDJSON answer is a stream of parsed lines authorized by the opening grant alone', async (t) => {
    const stub = await listener(t, (req, res) => {
        ndjson(res);
        res.write('{"sequence":1,"type":"state","data":{"state":"running"}}\n{"sequence":2,');
        setTimeout(() => res.end('"type":"ala","data":{"record":{"type":"x"}}}\n'), 10);
    });
    const hop = hopFor(stub.url);
    const opened = await hop.stream(OPERATION, { after: 0, stream: true }, { grant: GRANT });
    assert.equal(opened.outcome, 'stream');
    assert.deepEqual((await collect(opened.lines)).map((line) => line.sequence), [1, 2], 'a line split across chunks is joined');
    assert.equal(stub.seen.length, 1, 'one request, one grant');
    assert.equal(stub.seen[0].url, `${BASE}/v1/coordinator/${OPERATION}`);
    assert.equal(stub.seen[0].headers['x-ploinky-user-delegation'], GRANT);
    assert.equal(stub.seen[0].headers.accept, 'application/x-ndjson');
    assert.deepEqual(JSON.parse(stub.seen[0].body), { after: 0, stream: true });
});

test('a connection that breaks mid-stream, goes idle or sends a bad line throws worker_stream_dropped after the lines already delivered', async (t) => {
    const broken = await listener(t, (req, res) => { ndjson(res); res.write('{"sequence":1}\n'); setTimeout(() => req.socket.destroy(), 10); });
    const opened = await hopFor(broken.url).stream(OPERATION, { after: 0 }, {});
    const seen = [];
    await assert.rejects((async () => { for await (const line of opened.lines) seen.push(line.sequence); })(), (error) => error instanceof WorkerCoordinatorError && error.code === 'worker_stream_dropped');
    assert.deepEqual(seen, [1]);

    const idle = await listener(t, (req, res) => { ndjson(res); res.write('{"sequence":1}\n'); });
    const idleOpen = await hopFor(idle.url, { streamIdleMs: 60 }).stream(OPERATION, { after: 0 }, {});
    await assert.rejects(collect(idleOpen.lines), (error) => error.code === 'worker_stream_dropped');

    const bad = await listener(t, (req, res) => { ndjson(res); res.write('{"sequence":1}\nnot json\n{"sequence":3}\n'); });
    const badOpen = await hopFor(bad.url).stream(OPERATION, { after: 0 }, {});
    const got = [];
    await assert.rejects((async () => { for await (const line of badOpen.lines) got.push(line.sequence); })(), (error) => error.code === 'worker_stream_dropped');
    assert.deepEqual(got, [1], 'nothing after a malformed line');
});

test('the caller can end a stream, and a refused or plain answer resolves like an ordinary call', async (t) => {
    const open = await listener(t, (req, res) => { ndjson(res); res.write('{"sequence":1}\n'); });
    const controller = new AbortController();
    const opened = await hopFor(open.url).stream(OPERATION, { after: 0 }, { signal: controller.signal });
    const received = [];
    await assert.rejects((async () => { for await (const line of opened.lines) { received.push(line.sequence); controller.abort(); } })(), (error) => error.code === 'worker_stream_dropped');
    assert.deepEqual(received, [1]);

    const refused = await listener(t, (req, res) => { res.writeHead(403, { 'content-type': 'application/json' }); res.end('{"error":"forbidden"}'); });
    assert.deepEqual(await hopFor(refused.url).stream(OPERATION, { after: 0 }, { grant: GRANT }), { outcome: 'response', status: 403, json: { error: 'forbidden' }, refusal: null });

    const plain = await listener(t, (req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"events":[],"nextAfter":0}'); });
    assert.equal((await hopFor(plain.url).stream(OPERATION, { after: 0 }, {})).outcome, 'response');

    const unsent = await hopFor('http://127.0.0.1:1').stream(OPERATION, { after: 0 }, {});
    assert.equal(unsent.outcome, 'unsent');
    await assert.rejects(hopFor(refused.url).stream('robots/list', {}, {}), (error) => error.code === 'invalid_request');
    await assert.rejects(hopFor(refused.url).stream(OPERATION, { after: 0 }, { grant: 'not-a-jwt' }), (error) => error.code === 'owner_evidence_unavailable');
});

test('the client subscribes with the opening auth, reads a worker that answers a plain page, and maps refusals', async (t) => {
    const streaming = await listener(t, (req, res) => { ndjson(res); res.end('{"sequence":4,"type":"state","data":{"state":"completed"}}\n'); });
    const client = createWorkerClient({ hop: hopFor(streaming.url) });
    assert.deepEqual((await collect(await client.subscribe(REFERENCE, { after: 3 }, { grant: GRANT }))).map((row) => row.sequence), [4]);
    assert.deepEqual(JSON.parse(streaming.seen[0].body), { after: 3, stream: true });
    assert.equal(streaming.seen[0].headers['x-ploinky-user-delegation'], GRANT);

    const background = await listener(t, (req, res) => { ndjson(res); res.end(''); });
    await collect(await createWorkerClient({ hop: hopFor(background.url) }).subscribe(REFERENCE, { after: 0 }, { bindingId: `flow_${'ab'.repeat(12)}` }));
    assert.deepEqual(JSON.parse(background.seen[0].body), { after: 0, stream: true, bindingId: `flow_${'ab'.repeat(12)}` });
    assert.equal(Object.hasOwn(background.seen[0].headers, 'x-ploinky-user-delegation'), false, 'the background row sends no user grant');

    const plain = await listener(t, (req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"events":[{"sequence":1,"type":"state","data":{"state":"running"}}],"nextAfter":1}'); });
    assert.deepEqual((await collect(await createWorkerClient({ hop: hopFor(plain.url) }).subscribe(REFERENCE, { after: 0 }, { grant: GRANT }))).map((row) => row.sequence), [1]);

    const missing = await listener(t, (req, res) => { res.writeHead(404, { 'content-type': 'application/json' }); res.end('{"error":"not_found"}'); });
    await assert.rejects(createWorkerClient({ hop: hopFor(missing.url) }).subscribe(REFERENCE, { after: 0 }, { grant: GRANT }), (error) => error instanceof WorkerError && error.code === 'not_found' && error.status === 404);
});
