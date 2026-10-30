import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
    MODEL_RELAY_PORT, UpstreamError, canonicalModel, createModelChannel, gatewayModelId, isGatewayModel, openCodeGatewayModels, sanitizeUpstreamMessage,
    selectGatewayModel
} from '../../server/runtime/modelChannel.mjs';
import { ExecutionSetupError } from '../../server/runtime/setupError.mjs';

// The Soul Gateway model channel (M-26) over a FAKE upstream: model selection, the exact-route and body-allowlist rules, the single
// allowed model, error passthrough, activity on 2xx only, limits and teardown. The real AgentLib Router transport (bearer redaction, the
// edge-refusal resend) is exercised in modelChannel.upstream.test.mjs.

const CATALOG = { data: [
    { id: 'a', name: 'Model A', _context: { window: 8000, max_output_tokens: 1000 }, _pricing: { mode: 'token', input_per_million: 1, output_per_million: 2 } },
    { id: 'b' }, { id: 'モデル-é' }
] };
const COMPLETION = { id: 'c1', object: 'chat.completion', created: 1, model: 'a', choices: [{ index: 0, message: { role: 'assistant', content: 'hi' }, finish_reason: 'stop' }], usage: { total_tokens: 3 } };

function fakeUpstream({ catalog = CATALOG, chat = () => ({ ok: true, status: 200, json: COMPLETION }) } = {}) {
    const calls = [];
    return {
        calls,
        async request(call) {
            calls.push(call);
            if (call.operation === 'models') {
                if (catalog instanceof Error) throw catalog;
                return catalog.ok === false ? catalog : { ok: true, status: 200, json: catalog };
            }
            return chat(call);
        }
    };
}

const directories = [];
test.after(() => { for (const directory of directories) fs.rmSync(directory, { recursive: true, force: true }); });

async function open({ allowed = 'a', upstream = fakeUpstream(), activity = () => {}, log = () => {}, executionId = 'EXEC' } = {}) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rw-mc-'));
    directories.push(root);
    const socketDirectory = path.join(root, 'model');
    const configDirectory = path.join(root, 'channels');
    fs.mkdirSync(socketDirectory, { mode: 0o700 });
    fs.mkdirSync(configDirectory, { mode: 0o700 });
    const channel = await createModelChannel({ socketDirectory, configDirectory, allowed, upstream, activity, log, executionId });
    return { channel, upstream, socketDirectory, configDirectory, socketPath: channel.socketPath, close: () => channel.close() };
}

// One request over the unix socket; resolves { status, headers, text, json }.
function send(socketPath, { method = 'POST', url = '/v1/chat/completions', headers = {}, body = undefined } = {}) {
    return new Promise((resolve, reject) => {
        const payload = body === undefined ? null : (Buffer.isBuffer(body) ? body : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body)));
        const req = http.request({ socketPath, method, path: url, headers: { ...(payload ? { 'content-length': String(payload.length), 'content-type': 'application/json' } : {}), ...headers } }, (res) => {
            const chunks = [];
            res.on('data', (chunk) => chunks.push(chunk));
            res.on('end', () => {
                const text = Buffer.concat(chunks).toString('utf8');
                let json = null;
                try { json = JSON.parse(text); } catch { /* not JSON */ }
                resolve({ status: res.statusCode, headers: res.headers, text, json });
            });
        });
        req.on('error', reject);
        req.end(payload ?? undefined);
    });
}

const chatBody = (extra = {}) => ({ model: 'a', messages: [{ role: 'user', content: 'SECRET-PROMPT-TEXT' }], ...extra });

// ---- selection ----------------------------------------------------------------------------------------------------------------

test('selectGatewayModel: the single effective model is spec.model ?? managed.models.opencode, only for OpenCode, prefix case-insensitive', () => {
    const managed = { codingAgent: 'opencode', models: { opencode: 'soul-gateway/a' } };
    assert.equal(selectGatewayModel({ specification: {}, managed }), 'a', 'managed model when the spec names none');
    assert.equal(selectGatewayModel({ specification: { model: 'soul-gateway/b' }, managed }), 'b', 'an override to gateway b beats managed a');
    assert.equal(selectGatewayModel({ specification: { model: 'opencode/glm-5.3-flash-free' }, managed }), null, 'an override to a non-gateway model beats a managed gateway model: no channel');
    assert.equal(selectGatewayModel({ specification: { model: 'Soul-Gateway/x' }, managed }), 'x', 'case variant of the prefix');
    assert.equal(selectGatewayModel({ specification: { codingAgent: 'opencode', model: ' SOUL-GATEWAY/x ' }, managed: {} }), 'x');
    assert.equal(selectGatewayModel({ specification: { codingAgent: 'opencode', model: 'soul-gateway/openai/gpt-x' }, managed: {} }), 'openai/gpt-x', 'the id is everything after the prefix');
    // Only OpenCode is served; the agent is spec.codingAgent ?? managed.codingAgent.
    assert.equal(selectGatewayModel({ specification: { codingAgent: 'codex' }, managed }), null);
    assert.equal(selectGatewayModel({ specification: { model: 'soul-gateway/a' }, managed: { codingAgent: 'codex' } }), null);
    assert.equal(selectGatewayModel({ specification: { codingAgent: 'opencode', model: 'soul-gateway/a' }, managed: { codingAgent: 'codex' } }), 'a');
    assert.equal(selectGatewayModel({ specification: { model: 'soul-gateway/a' }, managed: {} }), null, 'no agent: nothing says OpenCode');
    // Implausible ids and absent models.
    for (const model of ['soul-gateway/', 'soul-gateway/a\nb', `soul-gateway/${'x'.repeat(600)}`, 'soul-gateway', 'notsoul-gateway/x', undefined, 42]) {
        assert.equal(selectGatewayModel({ specification: { codingAgent: 'opencode', model }, managed: {} }), null, String(model));
    }
    assert.equal(selectGatewayModel({ specification: {}, managed: { codingAgent: 'opencode', models: {} } }), null);
    assert.equal(selectGatewayModel({ specification: undefined, managed: undefined }), null);
});

test('prefix helpers: one canonical spelling for ALA and the managed configuration (OpenCode looks providers up case-sensitively)', () => {
    assert.equal(isGatewayModel('Soul-Gateway/x'), true);
    assert.equal(isGatewayModel('soul-gateway'), false);
    assert.equal(gatewayModelId('SOUL-GATEWAY/y'), 'y');
    assert.equal(canonicalModel('Soul-Gateway/x'), 'soul-gateway/x');
    assert.equal(canonicalModel(' soul-gateway/X '), 'soul-gateway/X', 'the id keeps its case');
    assert.equal(canonicalModel('opencode/glm'), 'opencode/glm');
    assert.equal(canonicalModel(undefined), undefined);
});

test('openCodeGatewayModels maps ids, limits and prices exactly and invents nothing; an invalid catalog throws', () => {
    const models = openCodeGatewayModels(CATALOG);
    assert.deepEqual(models.get('a'), { name: 'Model A', limit: { context: 8000, output: 1000 }, cost: { input: 1, output: 2 } });
    assert.deepEqual(models.get('b'), { name: 'b' });
    assert.throws(() => openCodeGatewayModels({ data: [{ id: '' }] }));
    assert.throws(() => openCodeGatewayModels({ data: [{ id: 'a\nb' }] }));
    assert.throws(() => openCodeGatewayModels({}));
});

test('sanitizeUpstreamMessage: JSON error.message, control characters and line breaks removed, at most 300 characters', () => {
    assert.equal(sanitizeUpstreamMessage('{"error":{"message":"quota\\nexceeded\\u0007!"}}'), 'quota exceeded !');
    assert.equal(sanitizeUpstreamMessage('plain\r\ntext here'), 'plain text here');
    assert.equal(sanitizeUpstreamMessage('x'.repeat(1000)).length, 300);
    assert.equal(sanitizeUpstreamMessage('{"message":"top"}'), 'top');
    assert.equal(sanitizeUpstreamMessage(''), '');
});

// ---- start ----------------------------------------------------------------------------------------------------------------------

test('start: the catalog is checked, model.sock listens, and opencode.json (no secret, one model, timeout above the upstream limit) is written after it', async () => {
    const world = await open();
    try {
        assert.ok(fs.statSync(world.socketPath).isSocket());
        const written = fs.readFileSync(path.join(world.configDirectory, 'opencode.json'), 'utf8');
        const config = JSON.parse(written);
        const provider = config.provider['soul-gateway'];
        assert.equal(provider.npm, '@ai-sdk/openai-compatible');
        assert.equal(provider.options.baseURL, `http://127.0.0.1:${MODEL_RELAY_PORT}/v1`);
        assert.equal(provider.options.apiKey, 'robo-work');
        assert.ok(provider.options.timeout >= 510000, 'OpenCode must not give up before the upstream limit');
        assert.deepEqual(Object.keys(provider.models), ['a'], 'only the allowed model');
        assert.deepEqual(provider.models.a, { name: 'Model A', limit: { context: 8000, output: 1000 }, cost: { input: 1, output: 2 } });
        assert.deepEqual(Object.keys(config.provider), ['soul-gateway'], 'no other provider is defined or disabled');
        assert.ok(!/Bearer|PLOINKY|token/iu.test(written));
        assert.deepEqual(world.upstream.calls.map((call) => call.operation), ['models']);
        assert.ok(world.upstream.calls[0].totalTimeoutMs <= 15000, 'the catalog request is limited to 15 s');
    } finally { await world.close(); }
});

test('start: a model missing from the catalog is model_unavailable; an unreachable, refusing or malformed gateway is model_channel_unavailable; nothing is left behind', async () => {
    const cases = [
        [{ allowed: 'missing' }, 'model_unavailable'],
        [{ upstream: fakeUpstream({ catalog: new UpstreamError('PLOINKY_ROUTER_CONNECT_TIMEOUT') }) }, 'model_channel_unavailable'],
        [{ upstream: fakeUpstream({ catalog: { ok: false, status: 503, message: 'down' } }) }, 'model_channel_unavailable'],
        [{ upstream: fakeUpstream({ catalog: { data: 'nope' } }) }, 'model_channel_unavailable']
    ];
    for (const [options, reason] of cases) {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rw-mc-'));
        directories.push(root);
        fs.mkdirSync(path.join(root, 'model')); fs.mkdirSync(path.join(root, 'channels'));
        await assert.rejects(createModelChannel({ socketDirectory: path.join(root, 'model'), configDirectory: path.join(root, 'channels'), allowed: 'a', upstream: fakeUpstream(), ...options }),
            (error) => error instanceof ExecutionSetupError && error.reason === reason, reason);
        assert.deepEqual(fs.readdirSync(path.join(root, 'model')), [], `${reason}: no socket`);
        assert.deepEqual(fs.readdirSync(path.join(root, 'channels')), [], `${reason}: no configuration`);
    }
});

test('start: a socket path beyond the safe length is refused', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rw-mc-'));
    directories.push(root);
    const deep = path.join(root, 'x'.repeat(95));
    fs.mkdirSync(deep);
    await assert.rejects(createModelChannel({ socketDirectory: deep, configDirectory: root, allowed: 'a', upstream: fakeUpstream() }), { reason: 'model_channel_unavailable' });
});

// ---- routes ---------------------------------------------------------------------------------------------------------------------

test('only GET /v1/models and POST /v1/chat/completions exist, by exact request line; the model list is the one allowed model', async () => {
    const world = await open();
    try {
        const models = await send(world.socketPath, { method: 'GET', url: '/v1/models' });
        assert.equal(models.status, 200);
        assert.deepEqual(models.json, { object: 'list', data: [{ id: 'a', object: 'model', owned_by: 'soul-gateway' }] });
        for (const [method, url] of [['GET', '/v1/models?x=1'], ['GET', '/v1/models/'], ['GET', '/v1/models/a'], ['POST', '/v1/models'], ['GET', '/v1/chat/completions'],
            ['POST', '/v1/chat/completions?stream=1'], ['POST', '/v1/chat/completions/'], ['POST', '/v1/embeddings'], ['POST', '/v1/completions'], ['GET', '/'], ['DELETE', '/v1/models'], ['POST', '//v1/chat/completions'],
            ['POST', 'http://127.0.0.1/v1/chat/completions'], ['POST', '/V1/chat/completions'], ['POST', '/v1/chat/completions#x']]) {
            const answer = await send(world.socketPath, { method, url, body: method === 'POST' ? chatBody() : undefined });
            assert.equal(answer.status, 404, `${method} ${url}`);
        }
        assert.equal(world.upstream.calls.length, 1, 'only the catalog check reached the upstream: none of the probes did');
    } finally { await world.close(); }
});

// ---- chat -----------------------------------------------------------------------------------------------------------------------

test('chat: the body is rebuilt from the allowlist, model is forced, stream is off, and no inbound header or unknown key reaches the upstream', async () => {
    const world = await open();
    try {
        const body = chatBody({
            stream: true, stream_options: { include_usage: true }, max_tokens: 5, tools: [{ type: 'function', function: { name: 'f' } }], tool_choice: 'auto', temperature: 0.2,
            // None of these may reach the gateway.
            provider: 'openai', route: 'other', user: 'someone', metadata: { a: 1 }, x_ploinky_target: 'agent:x', n: 3, logit_bias: { 1: 2 }, __proto__x: 1
        });
        body.model = 'soul-gateway/a';
        const answer = await send(world.socketPath, { body, headers: { authorization: 'Bearer workload-chosen', 'x-ploinky-agent': 'agent:evil', 'x-ploinky-refusal': 'v=1', 'x-forwarded-for': '1.2.3.4', cookie: 'a=b' } });
        assert.equal(answer.status, 200);
        assert.match(answer.headers['content-type'], /text\/event-stream/u, 'a streaming client gets the SSE emulation');
        assert.match(answer.text, /^data: .*"content":"hi"/mu);
        assert.ok(answer.text.endsWith('data: [DONE]\n\n'));
        const call = world.upstream.calls.at(-1);
        assert.deepEqual(Object.keys(call).sort(), ['json', 'operation', 'signal'], 'nothing but the operation, the body and the abort signal is handed to the transport: no header');
        assert.deepEqual(call.json, {
            model: 'a', stream: false, messages: body.messages, max_tokens: 5, tools: body.tools, tool_choice: 'auto', temperature: 0.2
        });
    } finally { await world.close(); }
});

test('chat: a non-streaming client gets the plain completion; the same POST twice is two independent upstream calls', async () => {
    const world = await open();
    try {
        const first = await send(world.socketPath, { body: chatBody() });
        const second = await send(world.socketPath, { body: chatBody() });
        assert.deepEqual([first.status, second.status], [200, 200]);
        assert.deepEqual(first.json, COMPLETION);
        assert.equal(world.upstream.calls.filter((call) => call.operation === 'chat').length, 2);
    } finally { await world.close(); }
});

test('403: every model other than the one allowed (a managed model under an override, another gateway id, the prefix of another) is refused and never reaches the upstream', async () => {
    // Override to gateway b over a managed a: the channel is opened for b, so a is refused.
    const world = await open({ allowed: 'b' });
    try {
        for (const model of ['a', 'soul-gateway/a', 'Soul-Gateway/a', 'B', 'b ', '', 'soul-gateway/', 'soul-gateway/soul-gateway/b', '*', 'b/../a']) {
            const answer = await send(world.socketPath, { body: chatBody({ model }) });
            assert.equal(answer.status, 403, JSON.stringify(model));
            assert.equal(answer.json.error.message, 'model_not_allowed');
        }
        assert.equal(world.upstream.calls.filter((call) => call.operation === 'chat').length, 0);
        // The allowed model is accepted in both spellings, and the upstream always gets the bare id.
        for (const model of ['b', 'soul-gateway/b', 'SOUL-GATEWAY/b']) assert.equal((await send(world.socketPath, { body: chatBody({ model }) })).status, 200, model);
        assert.deepEqual(world.upstream.calls.filter((call) => call.operation === 'chat').map((call) => call.json.model), ['b', 'b', 'b']);
    } finally { await world.close(); }
});

test('a Unicode model id works end to end', async () => {
    const world = await open({ allowed: 'モデル-é' });
    try {
        assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(path.join(world.configDirectory, 'opencode.json'), 'utf8')).provider['soul-gateway'].models), ['モデル-é']);
        assert.equal((await send(world.socketPath, { body: chatBody({ model: 'モデル-é' }) })).status, 200);
        assert.equal((await send(world.socketPath, { body: chatBody({ model: 'モデル-e' }) })).status, 403);
    } finally { await world.close(); }
});

test('400: bad JSON, an empty body, a non-object, a missing model or messages; 413 one byte above 2 MiB while exactly 2 MiB is served', async () => {
    const world = await open();
    try {
        for (const body of ['{', '', '[]', '"x"', 'null', '{"messages":[]}', '{"model":"a"}', '{"model":1,"messages":[]}', '{"model":"a","messages":"x"}']) {
            const answer = await send(world.socketPath, { body: Buffer.from(body) });
            assert.equal(answer.status, 400, JSON.stringify(body));
        }
        const exact = (size) => {
            const frame = Buffer.from(JSON.stringify(chatBody()).replace('SECRET-PROMPT-TEXT', ''));
            const padding = size - frame.length;
            return Buffer.from(JSON.stringify(chatBody()).replace('SECRET-PROMPT-TEXT', 'p'.repeat(padding)));
        };
        const limit = 2 * 1024 * 1024;
        assert.equal(exact(limit).length, limit);
        assert.equal((await send(world.socketPath, { body: exact(limit) })).status, 200, 'exactly 2 MiB');
        const over = await send(world.socketPath, { body: exact(limit + 1) });
        assert.equal(over.status, 413, '2 MiB + 1 byte');
        assert.equal(world.upstream.calls.filter((call) => call.operation === 'chat').length, 1, 'the oversize request never reached the upstream');
    } finally { await world.close(); }
});

// ---- upstream errors, activity, last error ----------------------------------------------------------------------------------------

test('an upstream error passes its status and a short single-line message through; invalid upstream output and transport failures are 502', async () => {
    let next = null;
    const upstream = fakeUpstream({ chat: () => { if (next instanceof Error) throw next; return next; } });
    const world = await open({ upstream });
    try {
        next = { ok: false, status: 429, message: 'quota exhausted' };
        const limited = await send(world.socketPath, { body: chatBody() });
        assert.equal(limited.status, 429);
        assert.equal(limited.json.error.message, 'quota exhausted');
        next = { ok: false, status: 503, message: '' };
        const unavailable = await send(world.socketPath, { body: chatBody() });
        assert.equal(unavailable.status, 503);
        assert.match(unavailable.json.error.message, /503/u);
        next = { ok: false, status: 302, message: 'moved' };
        assert.equal((await send(world.socketPath, { body: chatBody() })).status, 502, 'a status outside 400-599 is a bad gateway');
        next = { ok: true, status: 200, json: { nope: true } };
        assert.equal((await send(world.socketPath, { body: chatBody() })).status, 502, 'a completion without choices');
        next = new UpstreamError('upstream_response_invalid');
        const broken = await send(world.socketPath, { body: chatBody() });
        assert.equal(broken.status, 502);
        assert.ok(!/upstream_response_invalid|PLOINKY/u.test(broken.text), 'the transport error code is not shown');
        assert.deepEqual(world.channel.lastError(), { status: 502, message: 'Soul Gateway could not be reached' });
    } finally { await world.close(); }
});

test('activity (M-33) only for a 2xx chat response; the last error is kept until a success clears it', async () => {
    let answer = { ok: false, status: 429, message: 'slow down' };
    const upstream = fakeUpstream({ chat: () => answer });
    let activity = 0;
    const world = await open({ upstream, activity: () => { activity += 1; } });
    try {
        await send(world.socketPath, { method: 'GET', url: '/v1/models' });
        for (const status of [429, 500, 503]) {
            answer = { ok: false, status, message: `error ${status}` };
            await send(world.socketPath, { body: chatBody() });
        }
        await send(world.socketPath, { body: chatBody({ model: 'zzz' }) });
        await send(world.socketPath, { body: '{' });
        assert.equal(activity, 0, 'request starts, catalog calls and errors are not activity: a retry loop must not keep a stalled attempt alive');
        assert.deepEqual(world.channel.lastError(), { status: 503, message: 'error 503' });
        answer = { ok: true, status: 200, json: COMPLETION };
        await send(world.socketPath, { body: chatBody() });
        assert.equal(activity, 1);
        assert.equal(world.channel.lastError(), null);
    } finally { await world.close(); }
});

test('the log has model, status and timing only: no prompt, no completion, no upstream message', async () => {
    const lines = [];
    const upstream = fakeUpstream({ chat: () => ({ ok: false, status: 429, message: 'UPSTREAM-MESSAGE' }) });
    const world = await open({ upstream, log: (event, fields) => lines.push({ event, ...fields }) });
    try {
        await send(world.socketPath, { body: chatBody() });
        await send(world.socketPath, { body: chatBody({ model: 'zzz' }) });
        const requests = lines.filter((line) => line.event === 'model_request');
        assert.deepEqual(requests.map((line) => [line.executionId, line.model, line.status]), [['EXEC', 'a', 429], ['EXEC', null, 403]]);
        assert.ok(requests.every((line) => Number.isInteger(line.ms)));
        const text = JSON.stringify(lines);
        assert.ok(!text.includes('SECRET-PROMPT-TEXT') && !text.includes('UPSTREAM-MESSAGE') && !text.includes('zzz'));
    } finally { await world.close(); }
});

// ---- limits and teardown --------------------------------------------------------------------------------------------------------

test('at most 8 upstream calls at once (the ninth is 429); in-flight calls are aborted by close(), which is safe twice; a request after close is refused', async () => {
    const waiting = [];
    const upstream = fakeUpstream({ chat: (call) => new Promise((resolve, reject) => { waiting.push({ resolve }); call.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))); }) });
    const world = await open({ upstream });
    const pending = Array.from({ length: 8 }, () => send(world.socketPath, { body: chatBody() }).catch((error) => ({ error })));
    while (waiting.length < 8) await new Promise((resolve) => setTimeout(resolve, 5));
    const ninth = await send(world.socketPath, { body: chatBody() });
    assert.equal(ninth.status, 429);
    const signals = upstream.calls.filter((call) => call.operation === 'chat').map((call) => call.signal);
    assert.equal(signals.length, 8);
    await Promise.all([world.close(), world.close()]);
    assert.ok(signals.every((signal) => signal.aborted), 'in-flight upstream calls were aborted');
    await Promise.all(pending);
    await assert.rejects(send(world.socketPath, { method: 'GET', url: '/v1/models' }), (error) => ['ECONNREFUSED', 'ENOENT'].includes(error.code));
});

test('a client that goes away aborts its upstream call', async () => {
    let signal = null;
    const upstream = fakeUpstream({ chat: (call) => new Promise((resolve, reject) => { signal = call.signal; call.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))); }) });
    const world = await open({ upstream });
    try {
        const payload = JSON.stringify(chatBody());
        const request = http.request({ socketPath: world.socketPath, method: 'POST', path: '/v1/chat/completions', headers: { 'content-length': String(Buffer.byteLength(payload)) } });
        request.on('error', () => {});
        request.end(payload);
        while (signal === null) await new Promise((resolve) => setTimeout(resolve, 5));
        request.destroy();
        while (!signal.aborted) await new Promise((resolve) => setTimeout(resolve, 5));
    } finally { await world.close(); }
});

test('the socket server has its own connection limit: connection 17 is dropped while 16 idle ones are held', async () => {
    const world = await open();
    const held = [];
    try {
        for (let index = 0; index < 16; index += 1) {
            const socket = net.connect(world.socketPath);
            socket.on('error', () => {});
            await new Promise((resolve) => socket.once('connect', resolve));
            held.push(socket);
        }
        const extra = net.connect(world.socketPath);
        extra.on('error', () => {});
        const closed = await Promise.race([new Promise((resolve) => extra.once('close', () => resolve(true))), new Promise((resolve) => setTimeout(() => resolve(false), 2000))]);
        assert.equal(closed, true);
    } finally {
        for (const socket of held) socket.destroy();
        await world.close();
    }
});
