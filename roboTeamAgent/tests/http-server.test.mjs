import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createRoboTeamServer } from '../server/http-server.mjs';
import { RobotStore } from '../server/robot-store.mjs';

function authHeader(userId, roles = ['user']) {
    return JSON.stringify({ user: { id: userId, username: userId, roles } });
}

async function startFixture() {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'roboteam-http-test-'));
    const robotStore = new RobotStore({ dataDir });
    await robotStore.initialize();
    const runs = new Map();
    const runtimeManager = {
        status: (id) => runs.get(id) || { state: 'stopped' },
        start: async (robot, mode) => {
            const run = { state: 'running', mode, sessionUrl: `/rt/api/robots/${robot.id}/session/` };
            runs.set(robot.id, run);
            return run;
        },
        stop: async (id) => { runs.delete(id); return { state: 'stopped' }; },
        logs: async () => 'line one',
        activePort: () => null,
    };
    const server = createRoboTeamServer({ robotStore, runtimeManager, internalToken: 'test-token', publicBasePath: '/rt/', mcpPort: 65534 });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    return {
        server,
        baseUrl: `http://127.0.0.1:${server.address().port}`,
        close: async () => {
            await new Promise((resolve) => server.close(resolve));
            await fs.rm(dataDir, { recursive: true, force: true });
        },
    };
}

test('robot API shares workspace robots and restricts creation to administrators', async () => {
    const fixture = await startFixture();
    try {
        assert.equal((await fetch(`${fixture.baseUrl}/api/robots`)).status, 401);
        const created = await fetch(`${fixture.baseUrl}/api/robots`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'x-ploinky-auth-info': authHeader('admin-a', ['admin']) },
            body: JSON.stringify({ name: 'Publisher', specialization: 'Editorial operations' }),
        });
        assert.equal(created.status, 201);
        const robot = (await created.json()).robot;
        const started = await fetch(`${fixture.baseUrl}/api/robots/${robot.id}/run`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'x-ploinky-auth-info': authHeader('user-a') },
            body: JSON.stringify({ mode: 'browser' }),
        });
        assert.equal((await started.json()).robot.run.mode, 'browser');
        const other = await fetch(`${fixture.baseUrl}/api/robots/${robot.id}/run`, { headers: { 'x-ploinky-auth-info': authHeader('user-b') } });
        assert.equal(other.status, 200);
        const denied = await fetch(`${fixture.baseUrl}/api/robots`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'x-ploinky-auth-info': authHeader('user-b') },
            body: JSON.stringify({ name: 'Denied' }),
        });
        assert.equal(denied.status, 403);
    } finally {
        await fixture.close();
    }
});

test('internal MCP control calls require only the generated service token', async () => {
    const fixture = await startFixture();
    try {
        assert.equal((await fetch(`${fixture.baseUrl}/api/robots`, { headers: { 'x-roboteam-internal-token': 'test-token' } })).status, 200);
        assert.equal((await fetch(`${fixture.baseUrl}/api/robots`, { headers: { 'x-roboteam-internal-token': 'wrong' } })).status, 401);
    } finally {
        await fixture.close();
    }
});

test('robot deletion requires an administrator role', async () => {
    const fixture = await startFixture();
    try {
        const created = await fetch(`${fixture.baseUrl}/api/robots`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'x-ploinky-auth-info': authHeader('admin-a', ['admin']) },
            body: JSON.stringify({ name: 'Disposable' }),
        });
        assert.equal(created.status, 201);
        const denied = await fetch(`${fixture.baseUrl}/api/control`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'x-ploinky-auth-info': authHeader('user-a') },
            body: JSON.stringify({ operation: 'robot-delete', robotName: 'Disposable' }),
        });
        assert.equal(denied.status, 403);
        const deleted = await fetch(`${fixture.baseUrl}/api/control`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'x-ploinky-auth-info': authHeader('admin-a', ['admin']) },
            body: JSON.stringify({ operation: 'robot-delete', robotName: 'Disposable' }),
        });
        assert.equal(deleted.status, 200);
    } finally {
        await fixture.close();
    }
});
