import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { prepareRobotShell } from '../server/robot-shell.mjs';
import { openCodeGatewayModels } from '../server/soul-gateway-models.mjs';
import { createSoulGatewayOpenCode } from '../server/soul-gateway-opencode.mjs';
import { soulGatewayConnection } from '../server/soul-gateway-connection.mjs';
import { createSoulGatewayService } from '../server/soul-gateway-service.mjs';

const listing = () => ({ data: [
    { id: 'vendor/model-a', _context: { window: 128000, max_output_tokens: 8192 },
        _pricing: { mode: 'token', input_per_million: 1, output_per_million: 2 } },
    { id: 'plan', _strategy: 'cascade' },
] });

test('catalog conversion preserves exact IDs and known metadata without inventing limits', () => {
    const models = openCodeGatewayModels(listing());
    assert.deepEqual(Object.keys(models), ['vendor/model-a', 'plan']);
    assert.deepEqual(models['vendor/model-a'].limit, { context: 128000, output: 8192 });
    assert.deepEqual(models['vendor/model-a'].cost, { input: 1, output: 2 });
    assert.equal(models.plan.limit, undefined);
    assert.throws(() => openCodeGatewayModels({ data: [{ id: '' }] }), /invalid model/);
    assert.throws(() => openCodeGatewayModels({ error: 'upstream error' }), /invalid model catalog/);
});

async function setup(t, upstream) {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), 'soul-plugin-'));
    await prepareRobotShell(home);
    const adapter = createSoulGatewayOpenCode({ connect: async () => upstream });
    const socket = path.join(home, '.config/opencode/soul-gateway.sock');
    await adapter.listen(socket);
    const { SoulGateway } = await import(pathToFileURL(path.join(home, '.config/opencode/plugins/soul-gateway.js')));
    const plugin = await SoulGateway();
    t.after(async () => { await plugin.dispose(); await adapter.close(); await fs.rm(home, { recursive: true, force: true }); });
    assert.equal((await fs.stat(socket)).mode & 0o777, 0o600);
    await assert.rejects(fs.access(path.join(home, '.config/opencode/opencode.json')), { code: 'ENOENT' });
    return { home, plugin, adapter };
}

test('OpenCode receives a merged provider and private capability, never the gateway credential', async (t) => {
    const calls = [];
    const upstream = { scope: 'test-scope', async request(operation, payload) {
        if (operation === 'models') return listing();
        calls.push({ operation, payload });
        return { id: 'completion-1', created: 123, model: payload.model,
            choices: [{ index: 0, message: { role: 'assistant', content: null,
                tool_calls: [{ id: 'tool-1', type: 'function', function: { name: 'read', arguments: '{"path":"a"}' } }] },
            finish_reason: 'tool_calls' }], usage: { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 } };
    } };
    const { plugin } = await setup(t, upstream);
    const config = { permission: { bash: 'ask' }, provider: { personal: { name: 'Personal' } } };
    await plugin.config(config);
    assert.equal(config.provider.personal.name, 'Personal');
    assert.equal(config.permission.bash, 'ask');
    assert.doesNotMatch(JSON.stringify(config), /upstream-only/);
    const provider = config.provider['soul-gateway'];
    const url = `${provider.options.baseURL}/chat/completions`;
    assert.equal((await fetch(url, { method: 'POST', body: '{}' })).status, 401);
    const headers = { authorization: `Bearer ${provider.options.apiKey}`, 'content-type': 'application/json' };
    assert.equal((await fetch(`${provider.options.baseURL}/models`, { headers })).status, 404);
    const response = await fetch(url, { method: 'POST', headers,
        body: JSON.stringify({ model: 'vendor/model-a', messages: [{ role: 'user', content: 'hello' }], stream: true,
            stream_options: { include_usage: true }, tools: [{ type: 'function', function: { name: 'read' } }] }) });
    assert.equal(response.status, 200);
    const text = await response.text();
    assert.match(text, /data: \[DONE\]/);
    const chunks = text.split('\n').filter((line) => line.startsWith('data: {')).map((line) => JSON.parse(line.slice(6)));
    assert.equal(chunks[0].choices[0].delta.tool_calls[0].index, 0);
    assert.equal(chunks[1].choices[0].finish_reason, 'tool_calls');
    assert.equal(chunks[1].usage.total_tokens, 7);
    assert.equal(calls[0].payload.model, 'vendor/model-a');
    assert.equal(calls[0].payload.stream, false);
    assert.equal(calls[0].payload.stream_options, undefined);
    assert.equal(calls[0].payload.tools[0].function.name, 'read');
    upstream.request = async () => { throw Object.assign(new Error('upstream-only'), { status: 429 }); };
    const failure = await fetch(url, { method: 'POST', headers, body: JSON.stringify({ model: 'plan', messages: [] }) });
    assert.equal(failure.status, 429);
    assert.doesNotMatch(await failure.text(), /upstream-only/);
});

test('plugin reload reads a changed catalog without polling or generated configuration', async t => {
    let calls = 0;
    let model = 'first';
    const { plugin, home } = await setup(t, { scope: 'test', async request() { calls++; return { data: [{ id: model }] }; } });
    const config = {};
    await plugin.config(config);
    assert.deepEqual(Object.keys(config.provider['soul-gateway'].models), ['first']);
    model = 'second';
    await plugin.config(config);
    assert.equal(calls, 2);
    assert.deepEqual(Object.keys(config.provider['soul-gateway'].models), ['second']);
    await prepareRobotShell(home);
    assert.equal(calls, 2, 'Installing the plugin does not fetch the catalog');
});

test('missing Ploinky runtime does not create a gateway listener', async () => {
    assert.equal(await soulGatewayConnection({}), null);
    const adapter = createSoulGatewayOpenCode();
    assert.equal(await adapter.listen('/unused', {}), false);
    await adapter.close();
});

test('closing the service aborts an in-flight inference request', async t => {
    let began;
    const started = new Promise(resolve => { began = resolve; });
    let aborted = false;
    const { plugin, adapter } = await setup(t, { scope: 'abort', request(operation, payload, signal) {
        if (operation === 'models') return listing();
        began();
        return new Promise((resolve, reject) => signal.addEventListener('abort', () => {
            aborted = true; reject(new Error('cancelled'));
        }, { once: true }));
    } });
    const config = {};
    await plugin.config(config);
    const provider = config.provider['soul-gateway'];
    const request = fetch(`${provider.options.baseURL}/chat/completions`, { method: 'POST',
        headers: { authorization: `Bearer ${provider.options.apiKey}` }, body: JSON.stringify({ model: 'plan', messages: [] }) }).catch(() => null);
    await started;
    await adapter.close();
    await request;
    assert.equal(aborted, true);
});

test('plugin reports unavailable service and installer refuses symlinks', async t => {
    const { plugin, adapter, home } = await setup(t, { scope: 'offline', request: async () => listing() });
    await adapter.close();
    await assert.rejects(plugin.config({}), /Soul Gateway is unavailable/);
    const helper = path.join(home, '.config/opencode/soul-gateway-models.mjs');
    await fs.unlink(helper);
    await fs.symlink('/etc/passwd', helper);
    await assert.rejects(prepareRobotShell(home), /Unsafe Soul Gateway plugin file/);
});

test('service shares preparation, supports long mounted homes and closes robot sockets', async t => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'soul-service-'));
    const home = path.join(root, 'long-mounted-workspace-'.repeat(5), 'home');
    await fs.mkdir(home, { recursive: true });
    await prepareRobotShell(home);
    let connections = 0;
    const service = createSoulGatewayService({ adapter: () => createSoulGatewayOpenCode({ connect: async () => {
        connections++;
        return { scope: 'test', request: async () => listing() };
    } }) });
    t.after(async () => { await service.close(); await fs.rm(root, { recursive: true, force: true }); });
    await Promise.all([service.prepare(home), service.prepare(home)]);
    assert.equal(connections, 1);
    const { SoulGateway } = await import(pathToFileURL(path.join(home, '.config/opencode/plugins/soul-gateway.js')));
    const plugin = await SoulGateway();
    try {
        const config = {};
        await plugin.config(config);
        assert.ok(config.provider['soul-gateway'].models['vendor/model-a']);
        const duplicate = createSoulGatewayOpenCode({ connect: async () => ({ scope: 'other' }) });
        await assert.rejects(duplicate.listen(path.join(home, '.config/opencode/soul-gateway.sock')), /already has an owner/);
        await duplicate.close();
        await service.remove(home);
        await assert.rejects(plugin.config({}), /Soul Gateway is unavailable/);
    } finally { await plugin.dispose(); }
    await service.close();
    await assert.rejects(service.prepare(home), /service is closed/);
});

// A mount shared from a macOS host rejects chmod on a socket with EINVAL.
function failSocketChmod(t, socket, code) {
    const chmod = fs.chmod;
    t.mock.method(fs, 'chmod', async (target, mode) => {
        if (target === socket) throw Object.assign(new Error(`${code}: chmod '${target}'`), { code });
        return chmod(target, mode);
    });
}

test('the listener starts where the filesystem cannot set the socket mode', async t => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), 'soul-socket-mode-'));
    await prepareRobotShell(home);
    const socket = path.join(home, '.config/opencode/soul-gateway.sock');
    failSocketChmod(t, socket, 'EINVAL');
    const warn = t.mock.method(console, 'warn', () => {});
    const adapter = createSoulGatewayOpenCode({ connect: async () => ({ scope: 'mode', request: async () => listing() }) });
    t.after(async () => { await adapter.close(); await fs.rm(home, { recursive: true, force: true }); });
    assert.equal(await adapter.listen(socket), true);
    assert.match(warn.mock.calls[0].arguments[0], /socket permissions cannot be set/);
    const { SoulGateway } = await import(pathToFileURL(path.join(home, '.config/opencode/plugins/soul-gateway.js')));
    const plugin = await SoulGateway();
    try {
        const config = {};
        await plugin.config(config);
        assert.ok(config.provider['soul-gateway'].models['vendor/model-a']);
    } finally { await plugin.dispose(); }
});

test('any other failure to restrict the socket stops the listener', async t => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), 'soul-socket-mode-'));
    await prepareRobotShell(home);
    const socket = path.join(home, '.config/opencode/soul-gateway.sock');
    failSocketChmod(t, socket, 'EPERM');
    const adapter = createSoulGatewayOpenCode({ connect: async () => ({ scope: 'mode', request: async () => listing() }) });
    t.after(async () => { await adapter.close(); await fs.rm(home, { recursive: true, force: true }); });
    await assert.rejects(adapter.listen(socket), { code: 'EPERM' });
});
