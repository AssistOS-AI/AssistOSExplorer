import test from 'node:test';
import './helpers/isolated-ala-home.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { resolveAlaCommand } from '../../server/ala-command.mjs';
import { createOpenCodeModelCache } from '../../server/opencode-model-cache.mjs';

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

async function harness(t, { backend = 'opencode', listing = async () => MODELS, connect } = {}) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'achilles-model-cache-'));
    const workingDir = path.join(root, 'workspace');
    const home = path.join(root, 'home');
    const ala = path.join(root, 'ala');
    const binary = path.join(root, 'tools', 'node_modules', 'opencode-test', 'bin', 'opencode');
    await Promise.all([fs.mkdir(workingDir, { recursive: true }), fs.mkdir(path.join(home, '.config', 'opencode'), { recursive: true })]);
    await write(binary, '#!/bin/sh\n');
    await write(path.join(root, 'tools', 'node_modules', 'opencode-test', 'package.json'), '{"name":"opencode-test","version":"1.18.35"}');
    await write(path.join(home, '.cache', 'opencode', 'models.json'), '{"opencode":{"models":{}}}');
    await write(path.join(ala, 'package.json'), '{"name":"advanced-language-agent"}');
    await write(path.join(ala, 'src', 'coding-agents', 'opencode.mjs'), 'export {};\n');
    const saved = { home: process.env.ACHILLES_ALA_HOME, root: process.env.PLOINKY_WORKSPACE_ROOT };
    process.env.ACHILLES_ALA_HOME = home;
    process.env.PLOINKY_WORKSPACE_ROOT = root;
    t.after(async () => {
        for (const [name, value] of [['ACHILLES_ALA_HOME', saved.home], ['PLOINKY_WORKSPACE_ROOT', saved.root]]) {
            if (value === undefined) delete process.env[name]; else process.env[name] = value;
        }
        await fs.rm(root, { recursive: true, force: true });
    });
    const starts = { services: 0, closed: 0, listed: 0 };
    const installation = {
        packageRoot: ala,
        loadConfig: async () => ({ codingAgent: backend, models: {}, efforts: {} }),
        discoverCodingAgents: async () => [{ name: backend, binary, available: true }],
        createCodingAgentService() {
            starts.services++;
            return {
                async listModels(name, options) {
                    starts.listed++;
                    assert.equal(name, backend);
                    assert.equal(options.details, true);
                    return listing(options);
                },
                async close() { starts.closed++; },
            };
        },
    };
    const store = new ConversationSessionStore({ workingDir });
    const session = await store.createSession();
    const cache = createOpenCodeModelCache({ root: path.join(root, 'data'), robotId: 'robot-a1b2c3',
        connect: connect || (async () => ({ request: async () => GATEWAY })) });
    const engine = createAlaEngine({ workingDir, sessionStore: store, skillCatalog: { getSkills: () => [] }, installation,
        settings: { readAchillesSettings: () => ({}) }, modelCache: cache });
    t.after(() => engine.close());
    return { root, home, workingDir, engine, cache, starts, installation, sessionId: session.sessionId, store };
}

test('OpenCode is started once for an unchanged robot, then the stored list answers without starting it', { skip }, async (t) => {
    const h = await harness(t);
    const first = await h.engine.listModels({ sessionId: h.sessionId });
    assert.deepEqual(first.models, MODELS);
    assert.equal(h.starts.services, 1);
    const second = await h.engine.listModels({ sessionId: h.sessionId });
    const third = await h.engine.listModels({ sessionId: h.sessionId });
    assert.deepEqual(second, first);
    assert.deepEqual(third, first);
    assert.equal(h.starts.services, 1, 'no OpenCode start on a hit');
    // Any input change starts OpenCode again.
    await write(path.join(h.home, '.config', 'opencode', 'plugins', 'soul-gateway.js'), 'export const SoulGateway = 2;\n');
    await h.engine.listModels({ sessionId: h.sessionId });
    assert.equal(h.starts.services, 2);
    await h.engine.listModels({ sessionId: h.sessionId });
    assert.equal(h.starts.services, 2);
    await write(path.join(h.home, '.local', 'share', 'opencode', 'auth.json'), '{"p":{"type":"api"}}');
    await h.engine.listModels({ sessionId: h.sessionId });
    assert.equal(h.starts.services, 3);
});

test('a failed or incomplete listing is not remembered and the next call lists again', { skip }, async (t) => {
    let attempt = 0;
    const h = await harness(t, { listing: async () => {
        attempt++;
        if (attempt === 1) throw new Error('OpenCode server exited unexpectedly (1).');
        if (attempt === 2) return [MODELS[0]];
        return MODELS;
    } });
    await assert.rejects(h.engine.listModels({ sessionId: h.sessionId }), /exited unexpectedly/);
    assert.equal((await h.engine.listModels({ sessionId: h.sessionId })).models.length, 1, 'the gateway provider was missing');
    assert.deepEqual((await h.engine.listModels({ sessionId: h.sessionId })).models, MODELS);
    assert.equal(h.starts.services, 3);
    await h.engine.listModels({ sessionId: h.sessionId });
    assert.equal(h.starts.services, 3, 'the complete list is now reused');
    assert.equal(h.starts.closed, 3);
});

test('when the key cannot be established models are listed exactly as before', { skip }, async (t) => {
    const h = await harness(t, { connect: async () => { throw new Error('router down'); } });
    for (let call = 1; call <= 2; call++) {
        assert.deepEqual((await h.engine.listModels({ sessionId: h.sessionId })).models, MODELS);
        assert.equal(h.starts.services, call);
    }
});

test('only OpenCode is cached; other backends list on every call', { skip }, async (t) => {
    const h = await harness(t, { backend: 'codex' });
    await h.engine.listModels({ sessionId: h.sessionId });
    await h.engine.listModels({ sessionId: h.sessionId });
    assert.equal(h.starts.services, 2);
    await assert.rejects(fs.access(path.join(h.root, 'data', 'server-state', 'model-catalog', 'robot-a1b2c3', 'model-listing.json')));
});

test('the catalog is not blocked by OpenCode on a hit and keeps its ceiling on a miss', { skip }, async (t) => {
    let hang = false;
    const h = await harness(t, { listing: (options) => hang ? new Promise((_, reject) => {
        options.signal.addEventListener('abort', () => reject(new Error('aborted by the catalog ceiling')), { once: true });
    }) : MODELS });
    const load = (timeout) => loadAutocompleteCatalog({ dir: h.workingDir, skillCatalog: { getSkills: () => [] },
        installation: h.installation, freshSession: true, signal: AbortSignal.timeout(timeout),
        execution: { robotId: 'robot' }, modelCache: h.cache, sessionCompletions: [], taskCompletions: {} });
    const modelsOf = result => result.commands.find(command => command.name === '/model').subCommands.map(entry => entry.name);
    // Cold: OpenCode answers once and the list is stored.
    assert.deepEqual(modelsOf(await load(5000)), ['default', ...MODELS.map(model => model.id)]);
    // Warm with OpenCode now unresponsive: the stored list is served without starting it.
    hang = true;
    const started = performance.now();
    const warm = await load(5000);
    assert.deepEqual(modelsOf(warm), ['default', ...MODELS.map(model => model.id)]);
    assert.equal(warm.modelError, undefined);
    assert.ok(performance.now() - started < 2000);
    assert.equal(h.starts.services, 1);
    // A miss against an unresponsive OpenCode still ends at the caller's ceiling, with slash commands intact.
    await write(path.join(h.home, '.config', 'opencode', 'opencode.json'), '{}');
    const ceilingStarted = performance.now();
    const blocked = await load(300);
    assert.ok(performance.now() - ceilingStarted < 3000, 'the 20 s ceiling is a signal, not a wait');
    assert.match(blocked.modelError, /aborted by the catalog ceiling|abort|timed out/i);
    assert.deepEqual(modelsOf(blocked), ['default']);
    assert.ok(blocked.commands.length > 5);
});
