import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { RobotStore } from '../server/robot-store.mjs';
import { RobotModels } from '../server/robot-models.mjs';
import { filterCodingModels } from '../public/skills-dialog.js';

test('model search matches all words across model IDs and labels regardless of case or order', () => {
    const models = [{ id: 'soul-gateway/deepseek-v4-flash', label: 'DeepSeek Flash' }, { id: 'opencode/big-pickle', label: 'Big Pickle' }];
    assert.deepEqual(filterCodingModels(models, ' FLASH   soul '), [models[0]]);
    assert.deepEqual(filterCodingModels(models, 'pickle BIG'), [models[1]]);
    assert.deepEqual(filterCodingModels(models, 'flash pickle'), []);
    assert.deepEqual(filterCodingModels(models, ''), models);
});

test('native catalog uses robot accounts and the same ALA model-list API without opening a session', async t => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'robot-models-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const store = new RobotStore({ dataDir: path.join(root, '.data') });
    await store.initialize();
    const robot = await store.create({ name: 'Catalog' });
    const home = path.join(store.robotPath(robot.id), 'home');
    const calls = [];
    let closed = 0, received, listed = 0;
    const runtime = { workspaceRoot: root, alaCommand: '/test/ala.mjs',
        toolCache: { root: '/tools', prepareCodingAgents: async names => { calls.push(names); return { opencode: { binPath: '/tools/opencode' } }; } },
        prepareOpenCode: async id => calls.push(id) };
    const service = new RobotModels({ robotStore: store, runtimeManager: runtime, installation: async () => ({
        loadConfig: async file => JSON.parse(await fs.readFile(file, 'utf8')),
        discoverCodingAgents: async ({ env }) => { assert.equal(env.HOME, home); assert.equal(env.OPENCODE_BIN, '/tools/opencode/opencode'); return [{ name: 'opencode', available: true }]; },
        createCodingAgentService: options => { received = options; return {
            listModels: async (agent, options) => { assert.equal(agent, 'opencode'); assert.equal(options.details, true); listed++; return [{ id: 'provider/model', efforts: ['high', 'low'] }]; },
            close: async () => { closed++; },
        }; },
    }) });
    assert.equal((await service.config(robot)).codingAgent, 'opencode');
    assert.deepEqual(calls, []);
    assert.deepEqual(await service.list(robot, 'opencode'), { agent: 'opencode', models: [{ id: 'provider/model', efforts: ['high', 'low'] }] });
    assert.equal(received.home, home); assert.equal(received.workspace, home); assert.equal(closed, 1);
    assert.deepEqual(calls, [['opencode'], robot.id]);
    await assert.rejects(service.list(robot, '../unknown'), /Unknown coding agent/);
    const abort = new AbortController(); abort.abort();
    await assert.rejects(service.list(robot, 'opencode', { signal: abort.signal }), /abort/i);
    const listedBefore = listed;
    await service.validateEffort(robot, 'opencode', 'provider/model', 'high');
    await assert.rejects(service.validateEffort(robot, 'opencode', 'provider/model', 'unsupported'), /does not advertise/);
    await assert.rejects(service.validateEffort(robot, 'opencode', 'provider/other', 'high'), /does not advertise/);
    // No reuse by age: each validation reads the model list again.
    assert.equal(listed - listedBefore, 3);
});

test('effort validation follows the current upstream model list with no waiting period', async t => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'robot-models-fresh-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const store = new RobotStore({ dataDir: path.join(root, '.data') });
    await store.initialize();
    const robot = await store.create({ name: 'Fresh' });
    let upstream = [{ id: 'provider/old', efforts: ['low'] }];
    const runtime = { workspaceRoot: root, alaCommand: '/test/ala.mjs',
        toolCache: { root: '/tools', prepareCodingAgents: async () => ({ opencode: { binPath: '/tools/opencode' } }) },
        prepareOpenCode: async () => {} };
    const service = new RobotModels({ robotStore: store, runtimeManager: runtime, installation: async () => ({
        discoverCodingAgents: async () => [{ name: 'opencode', available: true }],
        createCodingAgentService: () => ({ listModels: async () => upstream, close: async () => {} }),
    }) });
    // Fill any catalog the service might keep.
    await service.list(robot, 'opencode');
    await service.validateEffort(robot, 'opencode', 'provider/old', 'low');
    // A model and an effort added upstream are accepted immediately.
    upstream = [{ id: 'provider/old', efforts: ['low', 'max'] }, { id: 'provider/new', efforts: ['high'] }];
    await service.validateEffort(robot, 'opencode', 'provider/new', 'high');
    await service.validateEffort(robot, 'opencode', 'provider/old', 'max');
    // A model and an effort removed upstream are rejected immediately.
    upstream = [{ id: 'provider/old', efforts: ['low'] }];
    await assert.rejects(service.validateEffort(robot, 'opencode', 'provider/new', 'high'), /does not advertise/);
    await assert.rejects(service.validateEffort(robot, 'opencode', 'provider/old', 'max'), /does not advertise/);
});
