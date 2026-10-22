import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createRoboTeamServer } from '../server/http-server.mjs';
import { RobotStore } from '../server/robot-store.mjs';

async function startFixture(t, proxyPool) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'roboteam-robot-proxies-'));
    const workspaceRoot = path.join(root, 'workspace');
    await fs.mkdir(workspaceRoot);
    const previousWorkspaceRoot = process.env.PLOINKY_WORKSPACE_ROOT;
    process.env.PLOINKY_WORKSPACE_ROOT = workspaceRoot;
    const robotStore = new RobotStore({ dataDir: path.join(root, 'private') });
    await robotStore.initialize();
    const runs = new Map();
    const runtimeManager = { workspaceRoot, status: (id) => runs.get(id) || { state: 'stopped' }, activePort: () => null, hasUnfinishedTasks: () => false };
    const server = createRoboTeamServer({ robotStore, runtimeManager, proxyPool, internalToken: 'test-token', publicBasePath: '/rt/', mcpPort: 65534 });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    t.after(async () => {
        await new Promise((resolve) => server.close(resolve));
        if (previousWorkspaceRoot === undefined) delete process.env.PLOINKY_WORKSPACE_ROOT;
        else process.env.PLOINKY_WORKSPACE_ROOT = previousWorkspaceRoot;
        await fs.rm(root, { recursive: true, force: true });
    });
    const call = (pathname, { method = 'GET', roles = ['admin'] } = {}) => fetch(`http://127.0.0.1:${server.address().port}${pathname}`, {
        method,
        headers: { 'x-roboteam-internal-token': 'test-token', 'x-roboteam-user-id': 'actor', 'x-roboteam-user-roles': JSON.stringify(roles) },
    });
    return { call, robotStore, runs };
}

function fakePool(held) {
    const released = [];
    return {
        released,
        assignments: async () => ({ available: true, active: true, assignments: held() }),
        release: async (robotId) => { released.push(robotId); return true; },
    };
}

test('administrators see the proxy each robot holds and leases of deleted robots are released', async (t) => {
    let robotId = null;
    const pool = fakePool(() => [
        { subject: robotId, host: '192.0.2.10', port: 3128, country: 'NL', usable: true, locale: { timezone: 'Europe/Amsterdam', locale: 'nl_NL.UTF-8', lang: 'nl-NL' } },
        { subject: 'deleted-a1b2c3', host: '192.0.2.11', port: 3128, usable: true, locale: null },
    ]);
    const { call, robotStore } = await startFixture(t, pool);
    robotId = (await robotStore.create({ name: 'Scout' })).id;
    assert.equal((await call('/api/robot-proxies', { roles: ['user'] })).status, 403);
    const listing = await (await call('/api/robot-proxies')).json();
    assert.equal(listing.available, true);
    assert.deepEqual(Object.keys(listing.proxies), [robotId]);
    assert.equal(listing.proxies[robotId].host, '192.0.2.10');
    assert.deepEqual(pool.released, ['deleted-a1b2c3']);
});

test('a robot proxy is released only while its workstation is stopped', async (t) => {
    const pool = fakePool(() => []);
    const { call, robotStore, runs } = await startFixture(t, pool);
    const robot = await robotStore.create({ name: 'Scout' });
    runs.set(robot.id, { state: 'running' });
    assert.equal((await call(`/api/robots/${robot.id}/proxy`, { method: 'DELETE' })).status, 409);
    runs.delete(robot.id);
    assert.equal((await call(`/api/robots/${robot.id}/proxy`, { method: 'DELETE', roles: ['user'] })).status, 403);
    assert.deepEqual(await (await call(`/api/robots/${robot.id}/proxy`, { method: 'DELETE' })).json(), { ok: true, released: true });
    assert.equal((await call('/api/robots/missing-a1b2c3/proxy', { method: 'DELETE' })).status, 404);
    assert.deepEqual(pool.released, [robot.id]);
});

test('the pool administration moved to proxyAgent', async (t) => {
    const { call } = await startFixture(t, fakePool(() => []));
    assert.equal((await call('/api/proxy-pool')).status, 404);
    assert.equal((await call('/proxy-pool.js')).status, 404);
});
