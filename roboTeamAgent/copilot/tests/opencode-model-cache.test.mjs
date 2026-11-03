import test from 'node:test';
import './helpers/isolated-ala-home.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import fsSync, { existsSync } from 'node:fs';
import http from 'node:http';
import { resolveAlaCommand } from '../../server/ala-command.mjs';
import { createRunManagerRoboWork } from './helpers/robowork-run-stand-in.mjs';

// The engine reads the ALA transcript module while it loads, so these tests need an ALA
// checkout (the container mount, a sibling AdvancedLanguageAgent, or ACHILLES_ALA_COMMAND).
const alaAvailable = existsSync(process.env.ACHILLES_ALA_COMMAND || resolveAlaCommand());
const skip = alaAvailable ? false : 'ALA is not installed in this environment';
const { createAlaEngine } = alaAvailable ? await import('../src/lib/execution/alaEngine.mjs') : {};
const { ConversationSessionStore } = alaAvailable ? await import('../src/lib/storage/conversationSessionStore.mjs') : {};
const { loadAutocompleteCatalog } = alaAvailable ? await import('../src/mcp/list-slash-commands.mjs') : {};

const MODELS = [{ id: 'opencode/big-pickle', label: 'Big Pickle', efforts: [] },
    { id: 'soul-gateway/axl/fast', label: 'Fast', efforts: ['high', 'low'] }];
const GATEWAY = { data: [{ id: 'axl/fast', name: 'Fast' }] };

async function write(file, content) {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, content);
}

// The engine asks RoboWork for the list. RoboWork's model operation, with its OpenCode list cache, runs against a stand-in
// ALA installation whose service records every start, listing and close in a log.
async function harness(t, { backend = 'opencode', listing = 'ok', gateway = true } = {}) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'achilles-model-cache-'));
    const workingDir = path.join(root, 'workspace');
    const home = path.join(root, 'home');
    const ala = path.join(root, 'ala');
    const soul = path.join(root, 'soul');
    const control = path.join(root, 'control.json');
    const log = path.join(root, 'service.log');
    const binary = path.join(root, 'tools', 'node_modules', 'opencode-test', 'bin', 'opencode');
    await Promise.all([fs.mkdir(workingDir, { recursive: true }), fs.mkdir(path.join(home, '.config', 'opencode'), { recursive: true }),
        fs.mkdir(soul, { recursive: true })]);
    await write(binary, '#!/bin/sh\n');
    await write(path.join(root, 'tools', 'node_modules', 'opencode-test', 'package.json'), '{"name":"opencode-test","version":"1.18.35"}');
    await write(path.join(home, '.cache', 'opencode', 'models.json'), '{"opencode":{"models":{}}}');
    await write(path.join(ala, 'bin', 'ala.mjs'), '');
    await write(path.join(ala, 'package.json'), '{"name":"advanced-language-agent"}');
    await write(path.join(ala, 'src', 'config.mjs'), '');
    await write(path.join(ala, 'src', 'coding-agents', 'logins.mjs'), '');
    await write(path.join(ala, 'src', 'coding-agents', 'opencode.mjs'), 'export {};\n');
    const setControl = (changes) => write(control, JSON.stringify({ backend, binary, listing, ...changes }));
    await setControl({});
    await write(path.join(ala, 'src', 'coding-agents', 'discovery.mjs'), `import fs from 'node:fs';
export const discoverCodingAgents = async () => {
    const c = JSON.parse(fs.readFileSync(${JSON.stringify(control)}, 'utf8'));
    return [{ name: c.backend, binary: c.binary, available: true }];
};`);
    await write(path.join(ala, 'src', 'coding-agents', 'service.mjs'), `import fs from 'node:fs';
const log = (line) => fs.appendFileSync(${JSON.stringify(log)}, line + '\\n');
const MODELS = ${JSON.stringify(MODELS)};
export const createCodingAgentService = () => {
    log('service');
    return {
        async listModels(name, options) {
            log('list');
            const c = JSON.parse(fs.readFileSync(${JSON.stringify(control)}, 'utf8'));
            if (name !== c.backend || options.details !== true) throw new Error('unexpected listing request');
            const attempt = fs.readFileSync(${JSON.stringify(log)}, 'utf8').split('\\n').filter((line) => line === 'list').length;
            if (c.listing === 'sequence') {
                if (attempt === 1) throw new Error('OpenCode server exited unexpectedly (1).');
                if (attempt === 2) return [MODELS[0]];
            }
            if (c.listing === 'hang') await new Promise((_, reject) => {
                const timer = setTimeout(() => reject(new Error('aborted by the catalog ceiling')), 4000);
                options.signal.addEventListener('abort', () => { clearTimeout(timer); reject(new Error('aborted by the catalog ceiling')); }, { once: true });
            });
            return MODELS;
        },
        async close() { log('close'); },
    };
};`);
    await write(log, '');
    const saved = { home: process.env.ACHILLES_ALA_HOME, root: process.env.PLOINKY_WORKSPACE_ROOT };
    process.env.ACHILLES_ALA_HOME = home;
    process.env.PLOINKY_WORKSPACE_ROOT = root;
    // The Soul Gateway socket RoboWork's model operation reads the gateway provider from.
    const server = http.createServer((request, response) => { response.setHeader('content-type', 'application/json'); response.end(JSON.stringify(GATEWAY)); });
    if (gateway) await new Promise((resolve) => server.listen(path.join(soul, 'soul-gateway.sock'), resolve));
    const robotId = 'robot-a1b2c3';
    const roboWork = await createRunManagerRoboWork({ workspaceRoot: root, home, childEntry: '/unused',
        robot: { config: async () => ({ codingAgent: backend, models: {}, efforts: {} }),
            agents: async () => [{ name: backend, available: true }] },
        modelOperation: { alaEntry: path.join(ala, 'bin', 'ala.mjs'), soul, dataDir: path.join(root, 'data') } });
    const lines = () => fsSync.readFileSync(log, 'utf8').split('\n').filter(Boolean);
    const starts = { get services() { return lines().filter((line) => line === 'service').length; },
        get closed() { return lines().filter((line) => line === 'close').length; },
        get listed() { return lines().filter((line) => line === 'list').length; } };
    const store = new ConversationSessionStore({ workingDir });
    const session = await store.createSession();
    const engine = createAlaEngine({ workingDir, sessionStore: store, skillCatalog: { getSkills: () => [] },
        settings: { readAchillesSettings: () => ({}) }, execution: { robotId }, roboWork });
    t.after(async () => {
        await engine.close();
        await roboWork.close();
        if (gateway) await new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); });
        for (const [name, value] of [['ACHILLES_ALA_HOME', saved.home], ['PLOINKY_WORKSPACE_ROOT', saved.root]]) {
            if (value === undefined) delete process.env[name]; else process.env[name] = value;
        }
        await fs.rm(root, { recursive: true, force: true });
    });
    return { root, home, workingDir, engine, starts, setControl, sessionId: session.sessionId, store };
}

test('OpenCode is started once for an unchanged robot, then the stored list answers without starting it', { skip }, async (t) => {
    const h = await harness(t);
    const first = await h.engine.listModels({ sessionId: h.sessionId });
    assert.deepEqual(first.models, MODELS);
    assert.equal(h.starts.listed, 1);
    const second = await h.engine.listModels({ sessionId: h.sessionId });
    const third = await h.engine.listModels({ sessionId: h.sessionId });
    assert.deepEqual(second, first);
    assert.deepEqual(third, first);
    assert.equal(h.starts.listed, 1, 'no OpenCode start on a hit');
    // Any input change starts OpenCode again.
    await write(path.join(h.home, '.config', 'opencode', 'plugins', 'soul-gateway.js'), 'export const SoulGateway = 2;\n');
    await h.engine.listModels({ sessionId: h.sessionId });
    assert.equal(h.starts.listed, 2);
    await h.engine.listModels({ sessionId: h.sessionId });
    assert.equal(h.starts.listed, 2);
    await write(path.join(h.home, '.local', 'share', 'opencode', 'auth.json'), '{"p":{"type":"api"}}');
    await h.engine.listModels({ sessionId: h.sessionId });
    assert.equal(h.starts.listed, 3);
});

test('a failed or incomplete listing is not remembered and the next call lists again', { skip }, async (t) => {
    const h = await harness(t, { listing: 'sequence' });
    // RoboWork reports a failed discovery without OpenCode's own message.
    await assert.rejects(h.engine.listModels({ sessionId: h.sessionId }), /Model discovery failed/);
    assert.equal((await h.engine.listModels({ sessionId: h.sessionId })).models.length, 1, 'the gateway provider was missing');
    assert.deepEqual((await h.engine.listModels({ sessionId: h.sessionId })).models, MODELS);
    assert.equal(h.starts.listed, 3);
    await h.engine.listModels({ sessionId: h.sessionId });
    assert.equal(h.starts.listed, 3, 'the complete list is now reused');
    // RoboWork opens a coding-agent service for every request, hit or miss, and closes each one.
    assert.equal(h.starts.closed, h.starts.services);
});

test('when the key cannot be established models are listed exactly as before', { skip }, async (t) => {
    const h = await harness(t, { gateway: false });
    for (let call = 1; call <= 2; call++) {
        assert.deepEqual((await h.engine.listModels({ sessionId: h.sessionId })).models, MODELS);
        assert.equal(h.starts.listed, call);
    }
});

test('only OpenCode is cached; other backends list on every call', { skip }, async (t) => {
    const h = await harness(t, { backend: 'codex' });
    await h.engine.listModels({ sessionId: h.sessionId });
    await h.engine.listModels({ sessionId: h.sessionId });
    assert.equal(h.starts.listed, 2);
    await assert.rejects(fs.access(path.join(h.root, 'data', 'server-state', 'model-catalog', 'robot-a1b2c3', 'model-listing.json')));
});

test('the catalog is not blocked by OpenCode on a hit and keeps its ceiling on a miss', { skip }, async (t) => {
    const h = await harness(t);
    const load = (timeout) => loadAutocompleteCatalog({ dir: h.workingDir, skillCatalog: { getSkills: () => [] },
        engine: h.engine, sessionId: h.sessionId, signal: AbortSignal.timeout(timeout),
        sessionCompletions: [], taskCompletions: {} });
    const modelsOf = result => result.commands.find(command => command.name === '/model').subCommands.map(entry => entry.name);
    // Cold: OpenCode answers once and the list is stored.
    assert.deepEqual(modelsOf(await load(5000)), ['default', ...MODELS.map(model => model.id)]);
    // Warm with OpenCode now unresponsive: the stored list is served without starting it.
    await h.setControl({ listing: 'hang' });
    const started = performance.now();
    const warm = await load(5000);
    assert.deepEqual(modelsOf(warm), ['default', ...MODELS.map(model => model.id)]);
    assert.equal(warm.modelError, undefined);
    assert.ok(performance.now() - started < 2000);
    assert.equal(h.starts.listed, 1);
    // A miss against an unresponsive OpenCode still ends at the caller's ceiling, with slash commands intact.
    await write(path.join(h.home, '.config', 'opencode', 'opencode.json'), '{}');
    const ceilingStarted = performance.now();
    const blocked = await load(300);
    assert.ok(performance.now() - ceilingStarted < 3000, 'the 20 s ceiling is a signal, not a wait');
    assert.match(blocked.modelError, /aborted by the catalog ceiling|abort|timed out/i);
    assert.deepEqual(modelsOf(blocked), ['default']);
    assert.ok(blocked.commands.length > 5);
});
