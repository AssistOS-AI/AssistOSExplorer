import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createRoboTeamServer } from '../server/http-server.mjs';
import { RobotStore } from '../server/robot-store.mjs';
import { RuntimeManager } from '../server/runtime-manager.mjs';

const ADMIN = { 'x-roboteam-internal-token': 'creation-token', 'x-roboteam-user-id': 'owner', 'x-roboteam-user-roles': '["admin"]', 'content-type': 'application/json' };

test('creating a robot answers before the OpenCode seed, which RoboWork finishes in the background', async t => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'roboteam-creation-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const calls = [];
    let seedStarted;
    const seeding = new Promise(resolve => { seedStarted = resolve; });
    // RoboWork answers the lightweight setup at once and never finishes the seed during this test.
    const roboWork = { call: async (tool, input) => {
        calls.push({ tool, input });
        if (tool === 'robot_ensure' && input.seed !== false) { seedStarted(); return new Promise(() => {}); }
        return {};
    } };
    const robotStore = new RobotStore({ dataDir: path.join(root, 'private'), roboWork });
    await robotStore.initialize();
    const runtimeManager = new RuntimeManager({ dataDir: path.join(root, 'data'), workspaceRoot: root, roboWork, robotStore });
    const server = createRoboTeamServer({ robotStore, runtimeManager, internalToken: 'creation-token', publicBasePath: '/rt/', mcpPort: 65534 });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise(resolve => server.close(resolve)));
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/robots`,
        { method: 'POST', headers: ADMIN, body: JSON.stringify({ name: 'Fresh' }), signal: AbortSignal.timeout(5000) });
    const body = await response.json();
    assert.equal(response.status, 201, JSON.stringify(body));
    await seeding;
    const ensures = calls.filter(call => call.tool === 'robot_ensure').map(call => call.input.seed);
    assert.deepEqual(ensures, [false, false, undefined], 'registry setup, lightweight preparation, then the unawaited seed');
});

test('a failed background seed is only reported, and it never throws into the caller', async t => {
    const warnings = [];
    t.mock.method(console, 'warn', (...args) => warnings.push(args));
    const manager = new RuntimeManager({ dataDir: '/data', workspaceRoot: os.tmpdir(),
        roboWork: { call: async () => { throw new Error('seed failed'); } } });
    assert.equal(manager.seedOpenCodeInBackground({ id: 'robot-abc', name: 'A', codingAgents: ['opencode'] }), undefined);
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(warnings, [['seed failed']]);
});
