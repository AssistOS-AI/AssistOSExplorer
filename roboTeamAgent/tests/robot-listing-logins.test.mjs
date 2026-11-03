import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createRoboTeamServer } from '../server/http-server.mjs';
import { RobotStore } from '../server/robot-store.mjs';

// The listing of a caller that is not a verified administrator never asks RoboWork for logins and never carries them,
// whatever RoboWork would have answered. An agent acting on its own behalf is such a caller.
test('a robot listing for a non-administrator asks for no logins and reports none', async t => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'roboteam-listing-logins-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const robotStore = new RobotStore({ dataDir: path.join(root, 'private'), roboWork: { call: async () => ({}) } });
    await robotStore.initialize();
    const robot = await robotStore.create({ name: 'Listed Robot' });
    const calls = [];
    const roboWork = { call: async (tool, input) => {
        calls.push({ tool, input });
        return { robots: [{ id: robot.id, activeAgent: 'opencode', logins: { codex: true, opencode: true, pi: true, claude: true } }] };
    } };
    const runtimeManager = { workspaceRoot: root, roboWork, status: () => ({ state: 'stopped' }), activePort: () => null, hasUnfinishedTasks: () => false };
    const server = createRoboTeamServer({ robotStore, runtimeManager, internalToken: 'listing-token', publicBasePath: '/rt/', mcpPort: 65534 });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise(resolve => server.close(resolve)));
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/robots`,
        { headers: { 'x-roboteam-internal-token': 'listing-token', 'x-roboteam-listing-origin': 'agent' } });
    const body = await response.json();
    assert.equal(response.status, 200, JSON.stringify(body));
    assert.equal(body.canAdmin, false);
    assert.deepEqual(calls, [{ tool: 'robot_status', input: { robotIds: [robot.id], includeLogins: false } }]);
    assert.equal(body.robots[0].codingAgent, 'opencode');
    assert.equal('codingAgentLogins' in body.robots[0], false);
    assert.equal(JSON.stringify(body).includes('"logins"'), false);
});
