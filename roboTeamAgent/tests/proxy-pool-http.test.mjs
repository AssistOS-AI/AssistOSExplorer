import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createRoboTeamServer } from '../server/http-server.mjs';
import { RobotStore } from '../server/robot-store.mjs';
import { ProxyPool } from '../server/proxy-pool/proxy-pool.mjs';

async function startFixture(t) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'roboteam-proxy-http-'));
    const workspaceRoot = path.join(root, 'workspace');
    await fs.mkdir(workspaceRoot);
    const previousWorkspaceRoot = process.env.PLOINKY_WORKSPACE_ROOT;
    process.env.PLOINKY_WORKSPACE_ROOT = workspaceRoot;
    const robotStore = new RobotStore({ dataDir: path.join(root, 'private') });
    await robotStore.initialize();
    const proxyPool = new ProxyPool({ file: path.join(root, 'proxy-pool', 'pool.sqlite'),
        checkImpl: async () => ({ ok: true, exitIp: '203.0.113.5' }) });
    const runs = new Map();
    const runtimeManager = { workspaceRoot, status: (id) => runs.get(id) || { state: 'stopped' }, activePort: () => null, hasUnfinishedTasks: () => false };
    const server = createRoboTeamServer({ robotStore, runtimeManager, proxyPool, internalToken: 'test-token', publicBasePath: '/rt/', mcpPort: 65534 });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    t.after(async () => {
        await new Promise((resolve) => server.close(resolve));
        proxyPool.close();
        if (previousWorkspaceRoot === undefined) delete process.env.PLOINKY_WORKSPACE_ROOT;
        else process.env.PLOINKY_WORKSPACE_ROOT = previousWorkspaceRoot;
        await fs.rm(root, { recursive: true, force: true });
    });
    const call = (pathname, { method = 'GET', body, roles = ['admin'] } = {}) => fetch(`http://127.0.0.1:${server.address().port}${pathname}`, {
        method,
        headers: { 'x-roboteam-internal-token': 'test-token', 'x-roboteam-user-id': 'actor', 'x-roboteam-user-roles': JSON.stringify(roles),
            ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
        body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { call, robotStore, proxyPool, runs };
}

test('proxy pool administration is reserved to administrators', async (t) => {
    const { call } = await startFixture(t);
    assert.equal((await call('/api/proxy-pool', { roles: ['user'] })).status, 403);
    assert.equal((await call('/api/proxy-pool/accounts', { method: 'POST', roles: ['user'], body: {} })).status, 403);
    assert.equal((await fetch(new URL('/api/proxy-pool', (await call('/status')).url))).status, 401);
});

test('administrators add, inspect, check and release pool proxies without seeing credentials', async (t) => {
    const { call, robotStore, proxyPool, runs } = await startFixture(t);
    const empty = await (await call('/api/proxy-pool')).json();
    assert.equal(empty.active, false);
    assert.deepEqual(empty.providers.map(provider => provider.id), ['webshare', 'static']);

    const created = await call('/api/proxy-pool/accounts', { method: 'POST', body: {
        provider: 'static', label: 'Manual', config: { proxies: 'http://alice:topsecret@192.0.2.10:3128 nl' } } });
    assert.equal(created.status, 201);
    const { accountId, sync } = await created.json();
    assert.deepEqual(sync, { ok: true, proxies: 1, skipped: 0 });
    assert.equal((await call('/api/proxy-pool/accounts', { method: 'POST', body: { provider: 'static', config: { proxies: 'ftp://x' } } })).status, 400);

    const robot = await robotStore.create({ name: 'Scout' });
    proxyPool.acquire(robot.id);
    const listing = await call('/api/proxy-pool');
    const text = await listing.text();
    assert.doesNotMatch(text, /topsecret|alice/u);
    const pool = JSON.parse(text);
    assert.equal(pool.active, true);
    assert.equal(pool.proxies[0].robotName, 'Scout');
    assert.equal(pool.proxies[0].country, 'NL');

    const check = await (await call(`/api/proxy-pool/proxies/${pool.proxies[0].id}/check`, { method: 'POST' })).json();
    assert.deepEqual(check.check, { ok: true, exitIp: '203.0.113.5' });

    runs.set(robot.id, { state: 'running' });
    assert.equal((await call(`/api/proxy-pool/assignments/${robot.id}`, { method: 'DELETE' })).status, 409);
    runs.delete(robot.id);
    assert.deepEqual(await (await call(`/api/proxy-pool/assignments/${robot.id}`, { method: 'DELETE' })).json(), { ok: true, released: true });

    assert.equal((await call(`/api/proxy-pool/accounts/${accountId}`, { method: 'PATCH', body: { status: 'paused' } })).status, 400);
    assert.equal((await call(`/api/proxy-pool/accounts/${accountId}`, { method: 'PATCH', body: { status: 'disabled' } })).status, 200);
    assert.equal((await (await call('/api/proxy-pool')).json()).active, false);
    assert.equal((await call(`/api/proxy-pool/accounts/${accountId}`, { method: 'DELETE' })).status, 200);
    assert.equal((await call(`/api/proxy-pool/accounts/${accountId}`, { method: 'DELETE' })).status, 404);
});
