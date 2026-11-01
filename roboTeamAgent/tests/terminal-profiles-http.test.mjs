import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import test from 'node:test';
import { createRoboTeamServer } from '../server/http-server.mjs';

test('RoboTeam has no terminal profile or native-home preparation surface', async t => {
    const calls = [];
    const server = createRoboTeamServer({
        robotStore: { list: async () => [], robotPath: () => assert.fail('must not resolve a native home') },
        runtimeManager: { workspaceRoot: os.tmpdir(), roboWork: { call: async (...args) => { calls.push(args); } } },
        skillsets: {}, internalToken: 'test-token', publicBasePath: '/rt/', mcpPort: 65534,
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
    for (const roles of [['admin'], ['user']]) for (const [method, target] of [
        ['GET', '/api/terminal-profiles'],
        ['POST', '/api/terminal-profiles/resolve'],
        ['POST', '/api/terminal-profiles/robot-abc/prepare'],
        ['POST', '/api/robots/robot-abc/terminal'],
    ]) {
        const response = await fetch('http://127.0.0.1:' + server.address().port + target, {
            method, headers: { 'x-roboteam-internal-token': 'test-token', 'x-roboteam-user-id': 'actor',
                'x-roboteam-user-roles': JSON.stringify(roles), 'content-type': 'application/json' },
            ...(method === 'POST' ? { body: '{}' } : {}),
        });
        assert.equal(response.status, 404, method + ' ' + target);
        assert.deepEqual(await response.json(), { ok: false, error: 'not found' });
    }
    assert.deepEqual(calls, []);
    assert.ok(server instanceof http.Server);
});
