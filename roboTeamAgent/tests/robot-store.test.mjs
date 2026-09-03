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

test('creates a persistent workspace robot and exposes it in the shared listing', async () => {
    await withStore(async (store, dataDir) => {
        const robot = await store.create({ name: 'Research Analyst', specialization: 'Research' });
        assert.match(robot.id, /^research-analyst-[a-f0-9]{6}$/);
        assert.equal(robot.schema, 'roboteam-robot-v1');
        assert.equal(Object.hasOwn(robot, 'ownerUserId'), false);
        for (const directory of ['home', 'workspace', 'downloads', 'logs', 'runtime']) {
            assert.equal((await fs.stat(path.join(dataDir, 'robots', robot.id, directory))).isDirectory(), true);
        }
        assert.equal((await fs.stat(path.join(dataDir, 'robots', robot.id, 'home', '.codex'))).isDirectory(), true);
        assert.equal((await store.list()).length, 1);
        assert.equal((await store.get(robot.id)).id, robot.id);
    });
});

test('enforces workspace-wide unique names and deletes by robot id', async () => {
    await withStore(async (store, dataDir) => {
        const robot = await store.create({ name: 'Unique', specialization: '' });
        await assert.rejects(() => store.create({ name: 'Unique' }), /already exists/);
        assert.equal((await store.getByName('Unique')).id, robot.id);
        assert.equal(await store.delete(robot.id), true);
        await assert.rejects(() => fs.stat(path.join(dataDir, 'robots', robot.id)), /ENOENT/);
    });
});
