import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { RobotStore } from '../server/robot-store.mjs';
import { RobotSkillsets, publicSkillsets } from '../server/robot-skillsets.mjs';
import { RuntimeManager } from '../server/runtime-manager.mjs';

async function discoverSkills(roots) {
    const result = [];
    async function scan(directory) {
        for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
            const file = path.join(directory, entry.name);
            if (entry.isDirectory()) await scan(file);
            if (entry.name === 'SKILL.md') {
                const source = await fs.readFile(file, 'utf8');
                const name = source.match(/^name: (.+)$/m)?.[1];
                const description = source.match(/^description: (.+)$/m)?.[1];
                if (!name || !description) throw new Error('invalid descriptor');
                result.push({ name, description, directoryPath: directory });
            }
        }
    }
    for (const root of roots) await scan(root);
    if (new Set(result.map((skill) => skill.name)).size !== result.length) throw new Error('duplicate');
    return result;
}

async function fixture(t) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'robot-skillsets-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const dataDir = path.join(root, 'private');
    const workspaceRoot = path.join(root, 'workspace');
    const source = path.join(workspaceRoot, 'repo');
    for (const name of ['read-pdf', 'write-doc']) {
        const folder = path.join(source, name);
        await fs.mkdir(folder, { recursive: true });
        await fs.writeFile(path.join(folder, 'SKILL.md'), `---\nname: ${name}\ndescription: Can ${name}\n---\nPRIVATE FULL INSTRUCTIONS\n`);
        await fs.writeFile(path.join(folder, 'helper.txt'), 'original helper');
    }
    const store = new RobotStore({ dataDir });
    const robot = await store.create({ name: 'Analyst', specialization: 'Reports' });
    const skillsets = new RobotSkillsets({ robotStore: store, workspaceRoot, discoverSkills });
    return { root, dataDir, source, store, robot, skillsets };
}

test('copilot is available to every robot but selected automatically only by default', async (t) => {
    const f = await fixture(t);
    const robot = await f.store.ensureDefaultRobot();
    const selected = await f.skillsets.start(robot, {}, (_robot, selection) => selection);
    assert.deepEqual([...selected.resolvedSkills].sort(), [
        'copilot/bash', 'copilot/launch-gpt-researcher', 'copilot/launch-open-interpreter',
        'copilot/launch-robot', 'copilot/launch-web-search',
    ]);
    assert.ok(selected.resolvedSkills.every((name) => name.startsWith('copilot/')));
    const other = await f.skillsets.start(f.robot, {}, (_robot, selection) => selection);
    assert.deepEqual(other.resolvedSkills, []);
    const explicit = await f.skillsets.start(f.robot, { skills: ['copilot/launch-robot'] }, (_robot, selection) => selection);
    assert.deepEqual(explicit.resolvedSkills, ['copilot/launch-robot']);
    await assert.rejects(f.skillsets.remove(robot.id, 'copilot'), /bundled read-only/i);
});

test('imports allowed catalogs and publishes only skill names and frontmatter descriptions', async (t) => {
    const { skillsets, robot, source, store } = await fixture(t);
    await skillsets.add(robot.id, { name: 'documents', description: 'Read and write documents', source });
    const all = publicSkillsets(await store.get(robot.id));
    assert.equal(all.find((set) => set.name === 'copilot').skills.length, 5);
    const catalog = all.filter((set) => !set.builtin);
    assert.equal(catalog[0].skills.length, 2);
    assert.equal(catalog[0].skills[0].id, 'documents/read-pdf');
    assert.equal(JSON.stringify(catalog).includes('PRIVATE FULL'), false);
    assert.equal(JSON.stringify(catalog).includes('directory'), false);
    await assert.rejects(skillsets.add(robot.id, { name: 'documents', source }), /already exists/);
});

test('selects a union once and continues the saved catalog after removal and service recreation', async (t) => {
    const f = await fixture(t);
    await f.skillsets.add(f.robot.id, { name: 'documents', source: f.source });
    const manager = new RuntimeManager({ dataDir: f.dataDir, toolCache: {}, skillsets: f.skillsets });
    manager.shuttingDown = true;
    const started = await f.skillsets.start(f.robot, { skillset: 'documents', skills: ['documents/read-pdf'] },
        (robot, selection) => manager.startTask(robot, 'simple', { cwd: f.source, task: 'Review', skillSelection: selection }));
    const original = manager.tasks.get(started.taskId);
    const selection = original.request.skillSelection;
    assert.equal(selection.resolvedSkills.length, 2);
    const directory = await f.skillsets.catalogPath(f.robot.id, selection);
    original.state = 'completed';
    await manager._saveTask(original);
    await f.skillsets.remove(f.robot.id, 'documents');
    await fs.writeFile(path.join(f.source, 'read-pdf/helper.txt'), 'changed upstream');
    assert.equal(await fs.readFile(path.join(directory, 'read-pdf/helper.txt'), 'utf8'), 'original helper');
    const next = new RuntimeManager({ dataDir: f.dataDir, toolCache: {}, skillsets: f.skillsets });
    next.shuttingDown = true;
    const resumed = await next.resumeTask(f.robot, started.taskId, 'Continue review');
    assert.deepEqual(next.tasks.get(resumed.taskId).request.skillSelection, selection);
    assert.equal(await f.skillsets.catalogPath(f.robot.id, selection), directory);
    await assert.rejects(f.skillsets.start(f.robot, { skillSets: 'documents' }, () => {}), /not available/);
});

test('empty selection mounts no skills; individual selection excludes the rest', async (t) => {
    const f = await fixture(t);
    await f.skillsets.add(f.robot.id, { name: 'documents', source: f.source });
    for (const [input, expected] of [[{}, []], [{ skills: 'documents/read-pdf' }, ['read-pdf']]]) {
        const selection = await f.skillsets.start(f.robot, input, (_robot, selected) => selected);
        assert.deepEqual(await fs.readdir(await f.skillsets.catalogPath(f.robot.id, selection)), expected);
    }
    for (const input of [{ skills: '../secret' }, { skillSets: 'missing' }, { skills: 'documents/nope' }, { skills: {} }]) {
        await assert.rejects(f.skillsets.start(f.robot, input, () => assert.fail('must not enqueue')));
    }
});

test('rejects symlinks, private/outside sources, invalid descriptors, duplicate selected names and tampering', async (t) => {
    const f = await fixture(t);
    await assert.rejects(f.skillsets.add(f.robot.id, { name: 'bad', source: f.dataDir }), /workspace/);
    await fs.symlink('/etc/passwd', path.join(f.source, 'read-pdf/link'));
    await assert.rejects(f.skillsets.add(f.robot.id, { name: 'bad', source: f.source }), /symbolic/);
    await fs.unlink(path.join(f.source, 'read-pdf/link'));
    await f.skillsets.add(f.robot.id, { name: 'one', source: f.source });
    await f.skillsets.add(f.robot.id, { name: 'two', source: f.source });
    await assert.rejects(f.skillsets.start(f.robot, { skillSets: ['one', 'two'] }, () => {}), /duplicate native name/);
    const selection = await f.skillsets.start(f.robot, { skills: 'one/read-pdf' }, (_robot, selected) => selected);
    const directory = await f.skillsets.catalogPath(f.robot.id, selection);
    await fs.chmod(path.join(directory, 'read-pdf/helper.txt'), 0o600);
    await fs.writeFile(path.join(directory, 'read-pdf/helper.txt'), 'tampered');
    await assert.rejects(f.skillsets.catalogPath(f.robot.id, selection), /changed/);
    await fs.writeFile(path.join(f.source, 'read-pdf/SKILL.md'), 'invalid');
    await assert.rejects(f.skillsets.add(f.robot.id, { name: 'bad', source: f.source }), /valid/);
});

test('robot deletion refuses queued work and prevents late starts after deletion', async (t) => {
    const f = await fixture(t);
    const manager = new RuntimeManager({ dataDir: f.dataDir, toolCache: {} });
    manager.shuttingDown = true;
    const task = manager.startTask(f.robot, 'simple', { task: 'test', cwd: f.source });
    await assert.rejects(manager.deleteRobot(f.robot.id, () => f.store.delete(f.robot.id)), /stop/);
    manager.tasks.get(task.taskId).state = 'completed';
    await manager.deleteRobot(f.robot.id, () => f.store.delete(f.robot.id));
    assert.equal(await f.store.get(f.robot.id), null);
    assert.throws(() => manager.startTask(f.robot, 'simple', {}), /deleted/);
});
