import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ProfileStore } from '../server/profile-store.mjs';

async function withStore(operation) {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'roboteam-profile-test-'));
    try {
        const store = new ProfileStore({ dataDir, applyOwnership: false });
        await store.initialize();
        return await operation(store, dataDir);
    } finally {
        await fs.rm(dataDir, { recursive: true, force: true });
    }
}

test('creates a persistent profile layout and lists only the owner profiles', async () => {
    await withStore(async (store, dataDir) => {
        const profile = await store.create({
            ownerUserId: 'user-a',
            name: 'Research Analyst',
            specialization: 'Market research',
        });
        assert.match(profile.id, /^research-analyst-[a-f0-9]{6}$/);
        assert.equal(profile.ownerUserId, 'user-a');
        assert.equal(profile.specialization, 'Market research');

        const ownerProfiles = await store.list('user-a');
        assert.equal(ownerProfiles.length, 1);
        assert.equal((await store.list('user-b')).length, 0);
        assert.equal(await store.getOwned(profile.id, 'user-b'), null);

        for (const directory of ['home', 'workspace', 'browser', 'downloads', 'logs', 'runtime']) {
            const stats = await fs.stat(path.join(dataDir, 'profiles', profile.id, directory));
            assert.equal(stats.isDirectory(), true);
        }
    });
});

test('rejects invalid profile and owner inputs', async () => {
    await withStore(async (store) => {
        await assert.rejects(() => store.create({ ownerUserId: '', name: 'Robot' }), /identity is required/);
        await assert.rejects(() => store.create({ ownerUserId: 'user-a', name: '' }), /name is required/);
        await assert.rejects(() => store.getOwned('../escape', 'user-a'), /invalid profile id/);
    });
});

test('allocates a distinct Linux uid for every profile', async () => {
    await withStore(async (store) => {
        const first = await store.create({ ownerUserId: 'user-a', name: 'One' });
        const second = await store.create({ ownerUserId: 'user-a', name: 'Two' });
        assert.notEqual(first.uid, second.uid);
        assert.equal(second.uid, first.uid + 1);
    });
});
