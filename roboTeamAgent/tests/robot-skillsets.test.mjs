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
    const releases = [];
    t.after(async () => { for (const release of releases) await release(); await fs.rm(root, { recursive: true, force: true }); });
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
    const capture = async (selectedRobot, input = {}) => {
        const reference = await skillsets.start(selectedRobot, input, (_robot, selection) => selection);
        assert.equal(reference.version, 2);
        assert.equal(reference.catalogId, undefined, 'submission must not freeze execution bytes');
        const result = await skillsets.live.capture(await store.get(selectedRobot.id), reference.policyId, source);
        releases.push(result.release);
        return result;
    };
    return { root, dataDir, source, store, robot, skillsets, capture, releases };
}

test('copilot is available to every robot but selected automatically only by default', async (t) => {
    const f = await fixture(t);
    const robot = await f.store.ensureDefaultRobot();
    const selected = await f.capture(robot);
    assert.deepEqual([...selected.resolvedSkills].sort(), [
        'copilot/bash', 'copilot/launch-gpt-researcher', 'copilot/launch-open-interpreter',
        'copilot/launch-robot', 'copilot/launch-web-search',
    ]);
    assert.ok(selected.resolvedSkills.every((name) => name.startsWith('copilot/')));
    const other = await f.capture(f.robot);
    assert.deepEqual(other.resolvedSkills, []);
    const explicit = await f.capture(f.robot, { skills: ['copilot/launch-robot'] });
    assert.deepEqual(explicit.resolvedSkills, ['copilot/launch-robot']);
    await assert.rejects(f.skillsets.remove(robot.id, 'copilot'), /reserved skill source/i);
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

test('queues only policy references and explicit pinning preserves execution bytes through task continuation', async (t) => {
    const f = await fixture(t);
    await f.skillsets.add(f.robot.id, { name: 'documents', source: f.source });
    const manager = new RuntimeManager({ dataDir: f.dataDir, toolCache: {}, skillsets: f.skillsets });
    manager.shuttingDown = true;
    const started = await f.skillsets.start(f.robot, { skillset: 'documents', skills: ['documents/read-pdf'] },
        (robot, reference) => manager.startTask(robot, 'simple', { cwd: f.source, task: 'Review', skillPolicyRef: reference.policyId, alaSessionId: reference.policyId }));
    const original = manager.tasks.get(started.taskId);
    assert.equal(original.request.skillSelection, undefined);
    const selection = await f.skillsets.live.capture(await f.store.get(f.robot.id), original.request.skillPolicyRef, f.source);
    f.releases.push(selection.release);
    assert.equal(selection.resolvedSkills.length, 2);
    const directory = await f.skillsets.catalogPath(f.robot.id, selection);
    const { release, ...pinnedCatalog } = selection;
    await f.skillsets.policies.update(f.robot.id, selection.policyId, selection.policyVersion, (policy) => ({ ...policy, mode: 'pinned', pinnedCatalog }));
    original.state = 'completed';
    await manager._saveTask(original);
    await f.skillsets.remove(f.robot.id, 'documents');
    await fs.writeFile(path.join(f.source, 'read-pdf/helper.txt'), 'changed upstream');
    assert.equal(await fs.readFile(path.join(directory, 'read-pdf/helper.txt'), 'utf8'), 'original helper');
    const next = new RuntimeManager({ dataDir: f.dataDir, toolCache: {}, skillsets: f.skillsets });
    next.shuttingDown = true;
    const resumed = await next.resumeTask(f.robot, started.taskId, 'Continue review');
    assert.equal(next.tasks.get(resumed.taskId).request.skillPolicyRef, selection.policyId);
    assert.equal(next.tasks.get(resumed.taskId).request.skillSelection, undefined);
    assert.equal(next.tasks.get(resumed.taskId).alaSessionId, original.alaSessionId);
    const continued = await f.skillsets.live.capture(await f.store.get(f.robot.id), selection.policyId, f.source);
    f.releases.push(continued.release);
    assert.equal(continued.catalogPath, directory);
    await assert.rejects(f.skillsets.start(f.robot, { skillSets: 'documents' }, () => {}), /not available/);
});

test('empty selection mounts no skills; individual selection excludes the rest', async (t) => {
    const f = await fixture(t);
    await f.skillsets.add(f.robot.id, { name: 'documents', source: f.source });
    for (const [input, expected] of [[{}, []], [{ skills: 'documents/read-pdf' }, ['read-pdf']]]) {
        const selection = await f.capture(f.robot, input);
        assert.deepEqual((await fs.readdir(await f.skillsets.catalogPath(f.robot.id, selection))).filter((name) => name !== '.catalog.json'), expected);
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
    await assert.rejects(f.skillsets.start(f.robot, { skills: ['one/read-pdf', 'two/read-pdf'] }, () => {}), /duplicate native name/);
    const selection = await f.capture(f.robot, { skills: 'one/read-pdf' });
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
