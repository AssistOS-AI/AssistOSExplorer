import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createRoboTeamServer } from '../server/http-server.mjs';
import { ProfileStore } from '../server/profile-store.mjs';

function authHeader(userId) {
    return JSON.stringify({ user: { id: userId, username: userId, roles: ['user'] } });
}

async function startFixture() {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'roboteam-http-test-'));
    const profileStore = new ProfileStore({ dataDir, applyOwnership: false });
    await profileStore.initialize();
    const running = new Set();
    const desktopManager = {
        commands: { xvfb: '/usr/bin/Xvfb' },
        status: (id) => ({ state: running.has(id) ? 'running' : 'stopped' }),
        start: async (profile) => { running.add(profile.id); return { state: 'running' }; },
        stop: async (id) => { running.delete(id); return { state: 'stopped' }; },
        activeWebsockifyPort: () => null,
    };
    const server = createRoboTeamServer({
        profileStore,
        desktopManager,
        internalToken: 'test-token',
        publicBasePath: '/base-agent-additional-server/roboTeamAgent/7000/',
        mcpPort: 65534,
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    return {
        dataDir,
        server,
        baseUrl: `http://127.0.0.1:${address.port}`,
        close: async () => {
            await new Promise((resolve) => server.close(resolve));
            await fs.rm(dataDir, { recursive: true, force: true });
        },
    };
}

test('profile API requires router identity and preserves owner separation', async () => {
    const fixture = await startFixture();
    try {
        const denied = await fetch(`${fixture.baseUrl}/api/profiles`);
        assert.equal(denied.status, 401);

        const created = await fetch(`${fixture.baseUrl}/api/profiles`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'x-ploinky-auth-info': authHeader('owner-a') },
            body: JSON.stringify({ name: 'Publisher', specialization: 'Editorial operations' }),
        });
        assert.equal(created.status, 201);
        const createdBody = await created.json();
        assert.equal(createdBody.profile.name, 'Publisher');

        const ownerList = await fetch(`${fixture.baseUrl}/api/profiles`, { headers: { 'x-ploinky-auth-info': authHeader('owner-a') } });
        assert.equal((await ownerList.json()).profiles.length, 1);
        const otherList = await fetch(`${fixture.baseUrl}/api/profiles`, { headers: { 'x-ploinky-auth-info': authHeader('owner-b') } });
        assert.equal((await otherList.json()).profiles.length, 0);
    } finally {
        await fixture.close();
    }
});

test('internal MCP control calls require the generated token and explicit user id', async () => {
    const fixture = await startFixture();
    try {
        const allowed = await fetch(`${fixture.baseUrl}/api/profiles`, {
            headers: { 'x-roboteam-internal-token': 'test-token', 'x-roboteam-user-id': 'owner-a' },
        });
        assert.equal(allowed.status, 200);

        const denied = await fetch(`${fixture.baseUrl}/api/profiles`, {
            headers: { 'x-roboteam-internal-token': 'wrong', 'x-roboteam-user-id': 'owner-a' },
        });
        assert.equal(denied.status, 401);
    } finally {
        await fixture.close();
    }
});
