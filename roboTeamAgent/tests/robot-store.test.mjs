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

test('enforces owner-local unique names and deletes only an owned robot', async () => {
    await withStore(async (store, dataDir) => {
        const robot = await store.create({ ownerUserId: 'user-a', name: 'Unique', specialization: '' });
        await assert.rejects(() => store.create({ ownerUserId: 'user-a', name: 'Unique' }), /already exists/);
        await store.create({ ownerUserId: 'user-b', name: 'Unique' });
        assert.equal((await store.getOwnedByName('Unique', 'user-a')).id, robot.id);
        assert.equal(await store.deleteOwned(robot.id, 'user-b'), false);
        assert.equal(await store.deleteOwned(robot.id, 'user-a'), true);
        await assert.rejects(() => fs.stat(path.join(dataDir, 'robots', robot.id)), /ENOENT/);
    });
});
