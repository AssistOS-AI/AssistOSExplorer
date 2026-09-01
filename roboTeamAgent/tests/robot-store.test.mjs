import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { RobotStore } from '../server/robot-store.mjs';

async function withStore(operation) {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'roboteam-robot-test-'));
    try {
        const store = new RobotStore({ dataDir });
        await store.initialize();
        await operation(store, dataDir);
    } finally {
        await fs.rm(dataDir, { recursive: true, force: true });
    }
}

test('creates a persistent robot home and isolates listings by owner', async () => {
    await withStore(async (store, dataDir) => {
        const robot = await store.create({ ownerUserId: 'user-a', name: 'Research Analyst', specialization: 'Research' });
        assert.match(robot.id, /^research-analyst-[a-f0-9]{6}$/);
        assert.equal(robot.schema, 'roboteam-robot-v1');
        for (const directory of ['home', 'workspace', 'downloads', 'logs', 'runtime']) {
            assert.equal((await fs.stat(path.join(dataDir, 'robots', robot.id, directory))).isDirectory(), true);
        }
        assert.equal((await store.list('user-a')).length, 1);
        assert.equal((await store.list('user-b')).length, 0);
        assert.equal(await store.getOwned(robot.id, 'user-b'), null);
    });
});

test('migrates legacy profile records into robots without losing their home', async () => {
    await withStore(async (store, dataDir) => {
        const legacyRoot = path.join(dataDir, 'profiles', 'legacy-a1b2c3');
        await fs.mkdir(path.join(legacyRoot, 'home'), { recursive: true });
        await fs.writeFile(path.join(legacyRoot, 'home', 'kept.txt'), 'kept');
        await fs.writeFile(path.join(legacyRoot, 'metadata.json'), JSON.stringify({
            schema: 'roboteam-profile-v1',
            id: 'legacy-a1b2c3',
            name: 'Legacy',
            specialization: '',
            ownerUserId: 'user-a',
            createdAt: '2026-01-01T00:00:00.000Z',
        }));
        await store.initialize();
        assert.equal(await fs.readFile(path.join(dataDir, 'robots', 'legacy-a1b2c3', 'home', 'kept.txt'), 'utf8'), 'kept');
        assert.equal((await store.list('user-a'))[0].schema, 'roboteam-robot-v1');
    });
});
