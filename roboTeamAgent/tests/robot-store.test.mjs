import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { spawn } from 'node:child_process';
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

test('concurrent CLI users do not serialize execution but prevent deletion until all close', async () => {
    await withStore(async (store) => {
        const robot = await store.create({ name: 'Worker' });
        const releaseFirst = await store.acquireCliUsage(robot.id);
        const releaseSecond = await store.acquireCliUsage(robot.id);
        await assert.rejects(store.delete(robot.id), /close the robot chat/);
        await releaseFirst();
        await assert.rejects(store.delete(robot.id), /close the robot chat/);
        await releaseSecond();
        assert.equal(await store.delete(robot.id), true);
        await assert.rejects(store.acquireCliUsage(robot.id), /not found/);
    });
});

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

test('startup reuses an ordinary default robot unchanged and ordinary deletion permits recreation', async () => {
    await withStore(async (store, dataDir) => {
        const existing = await store.create({ name: 'default', specialization: 'Keep this role' });
        const homeFile = path.join(dataDir, 'robots', existing.id, 'home', 'keep.txt');
        const metadataFile = path.join(dataDir, 'robots', existing.id, 'metadata.json');
        await fs.writeFile(homeFile, 'keep this home');
        const before = await fs.readFile(metadataFile, 'utf8');
        assert.deepEqual(await store.ensureDefaultRobot(), existing);
        assert.deepEqual(await new RobotStore({ dataDir }).ensureDefaultRobot(), existing);
        assert.equal(await fs.readFile(metadataFile, 'utf8'), before);
        assert.equal(await fs.readFile(homeFile, 'utf8'), 'keep this home');
        assert.equal(await store.delete(existing.id), true);
        assert.equal(await store.getByName('default'), null);
        const recreated = await new RobotStore({ dataDir }).ensureDefaultRobot();
        assert.equal(recreated.name, 'default');
        assert.equal(recreated.specialization, '');
        assert.deepEqual(Object.keys(recreated).sort(),
            ['createdAt', 'id', 'name', 'schema', 'specialization', 'updatedAt']);
        assert.equal((await store.list()).length, 1);
    });
});

test('concurrent startup and ordinary creation produce exactly one default across processes', async () => {
    await withStore(async (store, dataDir) => {
        const moduleUrl = new URL('../server/robot-store.mjs', import.meta.url).href;
        const source = `import { RobotStore } from ${JSON.stringify(moduleUrl)};
const store = new RobotStore({dataDir:process.argv[1]});
await store.initialize();
if (process.argv[2] === 'create') {
    try { await store.create({name:'default'}); }
    catch (error) { if (error.message !== 'robot name already exists') throw error; }
}
console.log(JSON.stringify(await store.ensureDefaultRobot()));`;
        const start = (mode) => new Promise((resolve, reject) => {
            const child = spawn(process.execPath, ['--input-type=module', '-e', source, dataDir, mode],
                { stdio: ['ignore', 'pipe', 'pipe'] });
            let output = '';
            let errors = '';
            child.stdout.on('data', (chunk) => { output += chunk; });
            child.stderr.on('data', (chunk) => { errors += chunk; });
            child.on('error', reject);
            child.on('close', (code) => code === 0 ? resolve(JSON.parse(output)) : reject(new Error(errors)));
        });
        const robots = await Promise.all(['create', 'ensure', 'ensure', 'ensure'].map(start));
        assert.equal(new Set(robots.map((robot) => robot.id)).size, 1);
        assert.equal((await store.list()).filter((robot) => robot.name === 'default').length, 1);
    });
});

test('default provisioning reports corrupt and ambiguous registry metadata without overwriting it', async () => {
    await withStore(async (store, dataDir) => {
        const robot = await store.create({ name: 'default' });
        const file = path.join(dataDir, 'robots', robot.id, 'metadata.json');
        for (const invalid of ['{corrupt', JSON.stringify({ ...robot, name: null })]) {
            await fs.writeFile(file, invalid);
            await assert.rejects(store.ensureDefaultRobot(), /metadata is invalid/u);
            assert.equal(await fs.readFile(file, 'utf8'), invalid);
        }
        await fs.writeFile(file, JSON.stringify(robot));
        const duplicate = await store.create({ name: 'another' });
        const duplicateFile = path.join(dataDir, 'robots', duplicate.id, 'metadata.json');
        const bytes = JSON.stringify({ ...duplicate, name: 'default' });
        await fs.writeFile(duplicateFile, bytes);
        await assert.rejects(store.ensureDefaultRobot(), /more than one/u);
        assert.equal(await fs.readFile(duplicateFile, 'utf8'), bytes);
        assert.equal((await store.list()).length, 2);
    });
});
