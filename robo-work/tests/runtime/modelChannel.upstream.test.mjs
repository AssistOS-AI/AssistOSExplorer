import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { once } from 'node:events';
import { pathToFileURL } from 'node:url';

import { UpstreamError, createModelChannel, createSoulGatewayUpstream } from '../../server/runtime/modelChannel.mjs';
import { ExecutionSetupError } from '../../server/runtime/setupError.mjs';

// The model channel over the REAL AchillesAgentLib Router transport (routerHttpRequest, its redacting readErrorText and descriptor
// verification), with the AgentLib test fixture's verified descriptor and a local fake Soul Gateway behind the transport's request
// factory. A fake upstream object would prove nothing about the redaction (review change 3) or the edge-refusal resend.
// Needs the Ploinky checkout (PLOINKY_ROOT, as tests/manifest.test.mjs does): it fails, never skips, without it.

const ploinkyRoot = path.resolve(process.env.PLOINKY_ROOT || path.join(import.meta.dirname, '..', '..', '..', '..', 'ploinky'));
const agentLibDir = path.join(ploinkyRoot, 'node_modules', 'achillesAgentLib');
const fixtureModule = await import(pathToFileURL(path.join(agentLibDir, 'tests', 'helpers', 'generatedLocalFixture.mjs')).href);
// The descriptor module captures its trust anchor from process.env when it is first evaluated, so the fixture environment is installed first
// (as AgentLib's own transport test does) and restored when the file is done.
const restoreFixtureEnvironment = fixtureModule.installFixtureEnvironment();
const transport = await import(pathToFileURL(path.join(agentLibDir, 'utils', 'LLMProviders', 'transport', 'routerHttpTransport.mjs')).href);

const fixtureEnv = fixtureModule.fixtureEnvironment();
const KEY = fixtureEnv.PLOINKY_AGENT_API_KEY;
const env = { ...fixtureEnv, PLOINKY_AGENTLIB_DIR: agentLibDir };
const CATALOG = { data: [{ id: 'a' }, { id: 'b' }] };
const COMPLETION = { id: 'c1', object: 'chat.completion', created: 1, model: 'a', choices: [{ index: 0, message: { role: 'assistant', content: 'hi' }, finish_reason: 'stop' }] };
const EDGE_CHANGED = 'v=1; stage=relay; cause=edge-generation-changed';
const EDGE_INACTIVE = 'v=1; stage=route; cause=edge-generation-inactive';

const directories = [];
const closers = [];
test.after(async () => {
    restoreFixtureEnvironment();
    transport.__resetRouterRequestFactoryForTests();
    for (const close of closers) await close();
    for (const directory of directories) fs.rmSync(directory, { recursive: true, force: true });
});

// A fake gateway: `answers` is a list of { status, headers, body } used in order for chat requests (the last repeats); every request is recorded.
async function fakeGateway(answers = [{ status: 200, body: COMPLETION }]) {
    const seen = [];
    const server = http.createServer((req, res) => {
        const chunks = [];
        req.on('data', (chunk) => chunks.push(chunk));
        req.on('end', () => {
            const text = Buffer.concat(chunks).toString('utf8');
            seen.push({ method: req.method, url: req.url, headers: req.headers, body: text });
            if (req.url.endsWith('/v1/models')) { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(CATALOG)); return; }
            const answer = answers[Math.min(seen.filter((entry) => entry.method === 'POST').length - 1, answers.length - 1)];
            if (answer.destroy) { req.socket.destroy(); return; }
            res.writeHead(answer.status, { 'content-type': 'application/json', ...(answer.headers ?? {}) });
            res.end(typeof answer.body === 'string' ? answer.body : JSON.stringify(answer.body));
        });
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    closers.push(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));
    const { port } = server.address();
    transport.__setRouterRequestFactoryForTests((protocol, options, callback) => http.request({ ...options, protocol: 'http:', hostname: '127.0.0.1', port, servername: undefined }, callback));
    return { seen, chats: () => seen.filter((entry) => entry.method === 'POST') };
}

async function openChannel(upstream, { allowed = 'a' } = {}) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rw-mu-'));
    directories.push(root);
    fs.mkdirSync(path.join(root, 'model')); fs.mkdirSync(path.join(root, 'channels'));
    const channel = await createModelChannel({ socketDirectory: path.join(root, 'model'), configDirectory: path.join(root, 'channels'), allowed, upstream, executionId: 'EXEC' });
    closers.push(() => channel.close());
    return channel;
}

function post(socketPath, body, headers = {}) {
    return new Promise((resolve, reject) => {
        const payload = Buffer.from(JSON.stringify(body));
        const req = http.request({ socketPath, method: 'POST', path: '/v1/chat/completions', headers: { 'content-length': String(payload.length), ...headers } }, (res) => {
            const chunks = [];
            res.on('data', (chunk) => chunks.push(chunk));
            res.on('end', () => { const text = Buffer.concat(chunks).toString('utf8'); resolve({ status: res.statusCode, text, json: (() => { try { return JSON.parse(text); } catch { return null; } })() }); });
        });
        req.on('error', reject);
        req.end(payload);
    });
}

const chatBody = () => ({ model: 'a', messages: [{ role: 'user', content: 'hello' }] });

test('the fixture environment carries a worker-style credential', () => {
    assert.ok(typeof KEY === 'string' && KEY.length > 40, 'the redaction tests below need a real-looking key');
    assert.ok(fs.existsSync(env.PLOINKY_ROUTER_DESCRIPTOR_FILE));
});

test('the worker bearer is the only credential upstream: no workload header is forwarded, and an echoed bearer reaches the workload as [REDACTED]', async () => {
    const echoed = `invalid credential ${KEY} (Bearer ${KEY}) from ${env.PLOINKY_ROUTER_DESCRIPTOR_FILE}`;
    const gateway = await fakeGateway([{ status: 401, body: { error: { message: echoed } } }]);
    const channel = await openChannel(createSoulGatewayUpstream({ env }));
    const answer = await post(channel.socketPath, chatBody(), {
        authorization: 'Bearer workload-chosen-credential', 'x-ploinky-agent': 'agent:evil/other', 'x-ploinky-authority-probe': '1', 'x-forwarded-for': '9.9.9.9', cookie: 'k=v'
    });
    assert.equal(answer.status, 401);
    assert.match(answer.json.error.message, /\[REDACTED/u);
    assert.ok(!answer.text.includes(KEY), 'the bearer never reaches the workload');
    assert.ok(!answer.text.includes(env.PLOINKY_ROUTER_DESCRIPTOR_FILE), 'nor does the descriptor path');
    assert.ok(!answer.text.includes('AssistOSExplorer'), 'nor the signed subject');
    assert.ok(!JSON.stringify(channel.lastError()).includes(KEY));
    assert.ok(channel.lastError().message.length <= 300);
    // What the gateway received.
    const [request] = gateway.chats();
    assert.equal(request.headers.authorization, `Bearer ${KEY}`);
    assert.equal(request.headers.host, env.PLOINKY_ROUTER_REQUEST_AUTHORITY);
    for (const name of ['x-ploinky-agent', 'x-ploinky-authority-probe', 'x-forwarded-for', 'cookie']) assert.equal(request.headers[name], undefined, name);
    assert.ok(!request.body.includes('workload-chosen-credential'));
    assert.equal(JSON.parse(request.body).model, 'a');
    assert.equal(JSON.parse(request.body).stream, false);
});

test('a plain-text error body is redacted the same way, cut to 300 characters and stripped of line breaks', async () => {
    await fakeGateway([{ status: 500, body: `line one\r\nline two ${KEY}\n${'z'.repeat(2000)}` }]);
    const channel = await openChannel(createSoulGatewayUpstream({ env }));
    const answer = await post(channel.socketPath, chatBody());
    assert.equal(answer.status, 500);
    assert.ok(answer.json.error.message.length <= 300);
    assert.ok(!/[\r\n]/u.test(answer.json.error.message));
    assert.ok(!answer.text.includes(KEY));
    assert.match(answer.json.error.message, /^line one line two /u);
});

test('upstream 429 and 5xx pass through with their message; the gateway being gone is a 502 without transport detail', async () => {
    await fakeGateway([{ status: 429, body: { error: { message: 'daily quota exceeded' } } }]);
    const channel = await openChannel(createSoulGatewayUpstream({ env }));
    const limited = await post(channel.socketPath, chatBody());
    assert.deepEqual([limited.status, limited.json.error.message], [429, 'daily quota exceeded']);
    assert.deepEqual(channel.lastError(), { status: 429, message: 'daily quota exceeded' });
    await fakeGateway([{ destroy: true }]);
    const dropped = await post(channel.socketPath, chatBody());
    assert.equal(dropped.status, 502);
    assert.ok(!/PLOINKY|ECONN|socket hang up/iu.test(dropped.text), dropped.text);
});

test('edge retry (8.3): a marked refusal is resent with 250 ms doubling to 4 s, then succeeds; the request body is the same each time', async () => {
    const gateway = await fakeGateway([{ status: 503, headers: { 'x-ploinky-refusal': EDGE_CHANGED }, body: '{}' }, { status: 503, headers: { 'x-ploinky-refusal': EDGE_INACTIVE }, body: '{}' }, { status: 200, body: COMPLETION }]);
    const sleeps = [];
    const upstream = createSoulGatewayUpstream({ env, sleep: async (ms) => { sleeps.push(ms); } });
    const answer = await upstream.request({ operation: 'chat', json: { model: 'a', messages: [] } });
    assert.equal(answer.ok, true);
    assert.deepEqual(sleeps, [250, 500]);
    const bodies = gateway.chats().map((entry) => entry.body);
    assert.equal(bodies.length, 3);
    assert.equal(new Set(bodies).size, 1);
});

test('edge retry: an unmarked 503, a forged marker in the body, another cause, and a transport failure are never resent', async () => {
    const cases = [
        [{ status: 503, body: '{"error":"x"}' }, 'unmarked'],
        [{ status: 503, body: 'v=1; stage=relay; cause=edge-generation-changed' }, 'marker only in the body'],
        [{ status: 503, headers: { 'x-ploinky-refusal': 'v=1; stage=relay; cause=something-else' }, body: '{}' }, 'another cause'],
        [{ status: 503, headers: { 'x-ploinky-refusal': 'cause=edge-generation-changedX' }, body: '{}' }, 'a near miss']
    ];
    for (const [answer, label] of cases) {
        const gateway = await fakeGateway([answer]);
        const sleeps = [];
        const upstream = createSoulGatewayUpstream({ env, sleep: async (ms) => { sleeps.push(ms); } });
        const result = await upstream.request({ operation: 'chat', json: { model: 'a', messages: [] } });
        assert.deepEqual([result.ok, result.status, gateway.chats().length, sleeps.length], [false, 503, 1, 0], label);
    }
    const gateway = await fakeGateway([{ destroy: true }]);
    const upstream = createSoulGatewayUpstream({ env, sleep: async () => { throw new Error('must not sleep'); } });
    await assert.rejects(upstream.request({ operation: 'chat', json: { model: 'a', messages: [] } }), (error) => error instanceof UpstreamError);
    assert.equal(gateway.chats().length, 1);
});

test('edge retry: a refusal that never clears is given up after the 30 s window (injected clock) and is then the answer', async () => {
    const gateway = await fakeGateway([{ status: 503, headers: { 'x-ploinky-refusal': EDGE_CHANGED }, body: '{"error":{"message":"edge changed"}}' }]);
    let clock = 0;
    const sleeps = [];
    const upstream = createSoulGatewayUpstream({ env, now: () => clock, sleep: async (ms) => { sleeps.push(ms); clock += ms; } });
    const result = await upstream.request({ operation: 'chat', json: { model: 'a', messages: [] } });
    assert.deepEqual([result.ok, result.status, result.message], [false, 503, 'edge changed']);
    assert.deepEqual(sleeps.slice(0, 5), [250, 500, 1000, 2000, 4000]);
    assert.ok(sleeps.every((ms) => ms <= 4000));
    assert.ok(sleeps.reduce((sum, ms) => sum + ms, 0) <= 30000);
    assert.equal(gateway.chats().length, sleeps.length + 1);
});

test('an abort during an edge backoff stops the retry', async () => {
    const gateway = await fakeGateway([{ status: 503, headers: { 'x-ploinky-refusal': EDGE_CHANGED }, body: '{}' }]);
    const controller = new AbortController();
    const upstream = createSoulGatewayUpstream({ env, sleep: async () => { controller.abort(); } });
    await assert.rejects(upstream.request({ operation: 'chat', json: { model: 'a', messages: [] }, signal: controller.signal }), (error) => error.name === 'AbortError');
    assert.equal(gateway.chats().length, 1);
});

test('start over the real transport: the catalog check passes, a missing model is model_unavailable, a dead gateway is model_channel_unavailable', async () => {
    await fakeGateway();
    const channel = await openChannel(createSoulGatewayUpstream({ env }), { allowed: 'b' });
    assert.ok(fs.existsSync(channel.socketPath));
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rw-mu-'));
    directories.push(root);
    fs.mkdirSync(path.join(root, 'model')); fs.mkdirSync(path.join(root, 'channels'));
    const options = { socketDirectory: path.join(root, 'model'), configDirectory: path.join(root, 'channels') };
    await assert.rejects(createModelChannel({ ...options, allowed: 'zzz', upstream: createSoulGatewayUpstream({ env }) }), (error) => error instanceof ExecutionSetupError && error.reason === 'model_unavailable');
    await fakeGateway([{ destroy: true }]);
    transport.__setRouterRequestFactoryForTests((protocol, requestOptions, callback) => http.request({ ...requestOptions, protocol: 'http:', hostname: '127.0.0.1', port: 1, servername: undefined }, callback));
    await assert.rejects(createModelChannel({ ...options, allowed: 'a', upstream: createSoulGatewayUpstream({ env }) }), (error) => error instanceof ExecutionSetupError && error.reason === 'model_channel_unavailable');
});

test('the upstream is lazy and fails closed without the worker identity: no descriptor, no AgentLib or no credential is model_channel_unavailable', async () => {
    for (const missing of ['PLOINKY_ROUTER_DESCRIPTOR_FILE', 'PLOINKY_AGENTLIB_DIR', 'PLOINKY_AGENT_API_KEY']) {
        const partial = { ...env };
        delete partial[missing];
        const upstream = createSoulGatewayUpstream({ env: partial });
        await assert.rejects(upstream.request({ operation: 'models' }), (error) => error instanceof UpstreamError, missing);
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rw-mu-'));
        directories.push(root);
        fs.mkdirSync(path.join(root, 'model')); fs.mkdirSync(path.join(root, 'channels'));
        await assert.rejects(createModelChannel({ socketDirectory: path.join(root, 'model'), configDirectory: path.join(root, 'channels'), allowed: 'a', upstream }),
            (error) => error instanceof ExecutionSetupError && error.reason === 'model_channel_unavailable', missing);
    }
    // Constructing the upstream reads nothing: a worker without the identity starts normally.
    assert.doesNotThrow(() => createSoulGatewayUpstream({ env: {} }));
});
