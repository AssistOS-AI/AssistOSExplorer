import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createRoboTeamServer } from '../server/http-server.mjs';
import { RobotStore } from '../server/robot-store.mjs';
import { EmailPool } from '../server/email-pool.mjs';

async function startFixture(t) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'roboteam-email-http-'));
    const workspaceRoot = path.join(root, 'workspace');
    await fs.mkdir(workspaceRoot);
    const previousWorkspaceRoot = process.env.PLOINKY_WORKSPACE_ROOT;
    process.env.PLOINKY_WORKSPACE_ROOT = workspaceRoot;
    const robotStore = new RobotStore({ dataDir: path.join(root, 'private') });
    await robotStore.initialize();
    const emailPool = new EmailPool({ file: path.join(root, 'email-pool', 'email-pool.sqlite') });
    const runs = new Map(), unfinished = new Set();
    const runtimeManager = { workspaceRoot, status: (id) => runs.get(id) || { state: 'stopped' }, activePort: () => null, hasUnfinishedTasks: (id) => unfinished.has(id) };
    const server = createRoboTeamServer({ robotStore, runtimeManager, emailPool, internalToken: 'test-token', publicBasePath: '/rt/', mcpPort: 65534 });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    t.after(async () => {
        await new Promise((resolve) => server.close(resolve));
        emailPool.close();
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
    return { call, robotStore, emailPool, runs, unfinished };
}

test('robot email administration is reserved to administrators', async (t) => {
    const { call } = await startFixture(t);
    assert.equal((await call('/api/email-pool', { roles: ['user'] })).status, 403);
    assert.equal((await call('/api/email-pool/emails', { method: 'POST', roles: ['user'], body: { addresses: ['a@example.com'] } })).status, 403);
});

test('administrators add, list, release and delete robot emails', async (t) => {
    const { call, robotStore, emailPool, runs, unfinished } = await startFixture(t);
    const added = await call('/api/email-pool/emails', { method: 'POST', body: { addresses: ['a@example.com', 'b@example.com', 'bad'] } });
    assert.deepEqual(await added.json(), { ok: true, added: 2, duplicates: 0, invalid: ['bad'] });
    assert.equal((await call('/api/email-pool/emails', { method: 'POST', body: { addresses: 'a@example.com' } })).status, 400);

    const robot = await robotStore.create({ name: 'Scout' });
    const address = emailPool.acquire(robot.id);
    const pool = await (await call('/api/email-pool')).json();
    assert.equal(pool.freeCount, 1);
    const held = pool.emails.find(email => email.address === address);
    assert.equal(held.robotName, 'Scout');
    assert.equal((await call(`/api/email-pool/emails/${held.id}`, { method: 'DELETE' })).status, 409);

    runs.set(robot.id, { state: 'running' });
    assert.equal((await call(`/api/email-pool/assignments/${robot.id}`, { method: 'DELETE' })).status, 409);
    runs.delete(robot.id);
    unfinished.add(robot.id);
    assert.equal((await call(`/api/email-pool/assignments/${robot.id}`, { method: 'DELETE' })).status, 409);
    unfinished.delete(robot.id);
    assert.deepEqual(await (await call(`/api/email-pool/assignments/${robot.id}`, { method: 'DELETE' })).json(), { ok: true, released: true });
    assert.deepEqual(await (await call(`/api/email-pool/emails/${held.id}`, { method: 'DELETE' })).json(), { ok: true, removed: true });
    assert.equal((await call('/api/email-pool/emails/eml_000000000000', { method: 'DELETE' })).status, 404);
});
