import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { RobotStore } from '../server/robot-store.mjs';
import { RobotSkillsets, publicSkillsets, individualSkillRepositories } from '../server/robot-skillsets.mjs';
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
                result.push({ name, description, directoryPath: directory, filePath: file });
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
    await fs.writeFile(path.join(source, 'skillsets.md'), '# reports\n\n## Description\nRead and write reports\n\n## Skills\n- read-pdf\n- write-doc\n\n# reading\n## Description\nRead PDFs\n## Skills\n- read-pdf\n');
    const store = new RobotStore({ dataDir });
    const robot = await store.create({ name: 'Analyst', specialization: 'Reports' });
    const skillsets = new RobotSkillsets({ robotStore: store, workspaceRoot, discoverSkills });
    return { root, dataDir, source, store, robot, skillsets };
}

test('copilot is available but delegated tasks mount it only when explicitly selected', async (t) => {
    const f = await fixture(t);
    const robot = await f.store.ensureDefaultRobot();
    const selected = await f.skillsets.start(robot, { skillSets: ['copilot'] }, (_robot, selection) => selection);
    assert.deepEqual([...selected.resolvedSkills].sort(), [
        'copilot/bash', 'copilot/launch-gpt-researcher',
        'copilot/launch-robot',
    ]);
    assert.ok(selected.resolvedSkills.every((name) => name.startsWith('copilot/')));
    const delegatedDefault = await f.skillsets.start(robot, {}, (_robot, selection) => selection);
    assert.deepEqual(delegatedDefault.resolvedSkills, []);
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
    assert.equal(all.find((set) => set.id === 'copilot').skills.length, 3);
    const catalog = all.filter((set) => !set.builtin);
    assert.equal(catalog[0].skills.length, 2);
    assert.equal(catalog[0].skills[0], 'read-pdf');
    assert.equal(catalog.length, 2);
    assert.equal(catalog[0].description, 'Read and write reports');
    assert.equal(JSON.stringify(catalog).includes('PRIVATE FULL'), false);
    assert.equal(JSON.stringify(catalog).includes('directory'), false);
    await assert.rejects(skillsets.add(robot.id, { name: 'documents', source }), /already exists/);
});

test('stores source paths without copying and prunes removed skills on continuation after service recreation', async (t) => {
    const f = await fixture(t);
    const repo = await f.skillsets.add(f.robot.id, { source: f.source });
    const manager = new RuntimeManager({ dataDir: f.dataDir, toolCache: {}, skillsets: f.skillsets });
    manager.shuttingDown = true;
    const started = await f.skillsets.start(f.robot, { skillSets: [`${repo.name}-set-1`, `${repo.name}-set-2`] },
        (robot, selection) => manager.startTask(robot, 'simple', { cwd: f.source, task: 'Review', skillSelection: selection }));
    const original = manager.tasks.get(started.taskId);
    const selection = original.request.skillSelection;
    assert.equal(selection.resolvedSkills.length, 2);
    const directory = await f.skillsets.catalogPath(f.robot.id, selection);
    original.state = 'completed';
    await manager._saveTask(original);
    await f.skillsets.remove(f.robot.id, repo.name);
    await fs.writeFile(path.join(f.source, 'read-pdf/helper.txt'), 'changed upstream');
    assert.equal(path.basename(directory), 'skill-catalog.json');
    const next = new RuntimeManager({ dataDir: f.dataDir, toolCache: {}, skillsets: f.skillsets });
    next.shuttingDown = true;
    const resumed = await next.resumeTask(f.robot, started.taskId, 'Continue review');
    assert.deepEqual(next.tasks.get(resumed.taskId).request.skillSelection, selection);
    const warnings = [];
    assert.equal(await f.skillsets.catalogPath(f.robot.id, selection, message => warnings.push(message)), directory);
    assert.deepEqual(JSON.parse(await fs.readFile(directory, 'utf8')), []);
    assert.equal(warnings.length, 2);
    await assert.rejects(f.skillsets.start(f.robot, { skillSets: 'documents' }, () => {}), /not available/);
});

test('empty selection mounts no skills; individual selection excludes the rest', async (t) => {
    const f = await fixture(t);
    const repo = await f.skillsets.add(f.robot.id, { source: f.source });
    for (const [input, expected] of [[{}, []], [{ skills: `${repo.name}/read-pdf` }, ['read-pdf']]]) {
        const selection = await f.skillsets.start(f.robot, input, (_robot, selected) => selected);
        assert.deepEqual(JSON.parse(await fs.readFile(await f.skillsets.catalogPath(f.robot.id, selection), 'utf8')).map(value => path.basename(value)), expected);
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
    const one = await f.skillsets.add(f.robot.id, { source: f.source });
    const secondSource = path.join(f.source, '..', 'second');
    await fs.cp(f.source, secondSource, { recursive: true });
    const two = await f.skillsets.add(f.robot.id, { source: secondSource });
    await assert.rejects(f.skillsets.start(f.robot, { skillSets: [`${one.name}-set-1`, `${two.name}-set-1`] }, () => {}), /duplicate native name/);
    const selection = await f.skillsets.start(f.robot, { skills: `${one.name}/read-pdf` }, (_robot, selected) => selected);
    const directory = await f.skillsets.catalogPath(f.robot.id, selection);
    await fs.writeFile(directory, JSON.stringify(['/etc']));
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

test('skillsets.md validates named sections and known members, with no implicit whole-repo sets', async t => {
    const f = await fixture(t);
    const file = path.join(f.source, 'skillsets.md');
    for (const value of [
        '{broken', '# reports\n## Description\nReview',
        '# reports\n## Skills\n- read-pdf',
        '# reports\n## Description\nReview\n## Skills\n- missing',
        '# reports\n## Description\nReview\n## Skills\n- ../read-pdf',
        '# reports\n## Description\nReview\n## Other\ntext',
    ]) {
        await fs.writeFile(file, value);
        await assert.rejects(f.skillsets.add(f.robot.id, { source: f.source }), /Invalid skillsets.md/);
    }
    await fs.unlink(file);
    const repo = await f.skillsets.add(f.robot.id, { source: f.source });
    assert.deepEqual(repo.definitions, []);
    assert.equal(publicSkillsets(await f.store.get(f.robot.id)).filter(set => !set.builtin).length, 0);
});

test('a described skillset mounts only its members with their resource files', async t => {
    const f = await fixture(t);
    const repo = await f.skillsets.add(f.robot.id, { source: f.source });
    const selected = await f.skillsets.start(f.robot, { skillSets: [`${repo.name}-set-2`] }, (_robot, selection) => selection);
    const directory = await f.skillsets.catalogPath(f.robot.id, selected);
    const paths = JSON.parse(await fs.readFile(directory, 'utf8'));
    assert.deepEqual(paths, [path.join(f.store.robotPath(f.robot.id), 'skillsets', repo.generation, 'read-pdf')]);
    assert.equal(await fs.readFile(path.join(paths[0], 'helper.txt'), 'utf8'), 'original helper');
    assert.deepEqual(await fs.readdir(path.dirname(directory)), ['skill-catalog.json']);
});


test('repositories without skillsets publish only skill metadata and support exact individual selection', async t => {
    const f = await fixture(t);
    await fs.unlink(path.join(f.source, 'skillsets.md'));
    const repo = await f.skillsets.add(f.robot.id, { source: f.source });
    const robot = await f.store.get(f.robot.id);
    const fallback = individualSkillRepositories(robot);
    assert.equal(fallback.length, 1);
    assert.equal(fallback[0].id, repo.name);
    assert.deepEqual(fallback[0].skills[0], { name: 'read-pdf', description: 'Can read-pdf' });
    assert.doesNotMatch(JSON.stringify(fallback), /PRIVATE FULL|directory|helper/);
    const selected = await f.skillsets.start(robot, { skills: [`${repo.name}/read-pdf`] }, (_robot, selection) => selection);
    assert.deepEqual(JSON.parse(await fs.readFile(await f.skillsets.catalogPath(robot.id, selected), 'utf8')).map(value => path.basename(value)), ['read-pdf']);
});


test('default chat gets copilot while a saved delegated default conversation stays empty', async t => {
    const { createRobotSkillCatalog } = await import('../copilot/src/lib/robotSkillCatalog.mjs');
    const f = await fixture(t);
    const robot = await f.store.ensureDefaultRobot();
    let session = {};
    const sessionStore = {
        loadSession: () => session,
        updateSession: async (_id, update) => update(session),
    };
    const catalog = createRobotSkillCatalog({ context: { robot, store: f.store, skillsets: f.skillsets },
        sessionStore, workingDir: f.root, discoverTaskSkills: discoverSkills });
    const chat = await catalog.refresh('chat');
    assert.equal(chat.skills.length, 3);
    const empty = await f.skillsets.start(robot, {}, (_robot, selection) => selection);
    session = { skillSelection: empty };
    const delegated = await catalog.refresh('delegated');
    assert.deepEqual(delegated.skills, []);
    assert.equal(session.skillSelection, empty);
});


test('prunes only missing paths, preserves valid skills, and does not restore re-added repositories', async t => {
    const f = await fixture(t);
    const repo = await f.skillsets.add(f.robot.id, { source: f.source });
    const selection = await f.skillsets.start(f.robot, { skillSets: [`${repo.name}-set-1`] }, (_robot, value) => value);
    const file = await f.skillsets.catalogPath(f.robot.id, selection);
    const [first, second] = JSON.parse(await fs.readFile(file, 'utf8'));
    await fs.rm(first, { recursive: true });
    await f.skillsets.catalogPath(f.robot.id, selection, () => {});
    assert.deepEqual(JSON.parse(await fs.readFile(file, 'utf8')), [second]);
    await f.skillsets.remove(f.robot.id, repo.name);
    await f.skillsets.add(f.robot.id, { source: f.source });
    await f.skillsets.catalogPath(f.robot.id, selection, () => {});
    assert.deepEqual(JSON.parse(await fs.readFile(file, 'utf8')), []);
});


test('empty legacy copied catalogs remain usable without deleting their directories', async t => {
    const f = await fixture(t);
    const catalogId = crypto.randomUUID();
    const legacy = path.join(f.store.robotPath(f.robot.id), 'runtime', 'skill-catalogs', catalogId);
    await fs.mkdir(legacy, { recursive: true });
    const file = await f.skillsets.catalogPath(f.robot.id, {
        catalogId, resolvedSkills: [], digest: crypto.createHash('sha256').digest('hex'),
    });
    assert.deepEqual(JSON.parse(await fs.readFile(file, 'utf8')), []);
    assert.ok((await fs.stat(legacy)).isDirectory());
});


test('selected skills accept a symlinked runtime storage path and save canonical paths', async t => {
    const f = await fixture(t);
    await f.skillsets.add(f.robot.id, { source: f.source });
    const alias = path.join(f.root, 'private-alias');
    await fs.symlink(f.dataDir, alias, 'dir');
    const store = new RobotStore({ dataDir: alias });
    const skillsets = new RobotSkillsets({ robotStore: store, discoverSkills: async roots =>
        discoverSkills(await Promise.all(roots.map(root => fs.realpath(root)))) });
    const robot = await store.get(f.robot.id);
    const set = publicSkillsets(robot).find(entry => !entry.builtin);
    const selected = await skillsets.start(robot, { skillSets: [set.id] }, (_robot, selection) => selection);
    assert.equal(selected.paths.length, 2);
    for (const directory of selected.paths) {
        assert.equal(directory, await fs.realpath(directory));
        assert.ok(directory.startsWith(f.dataDir + path.sep));
    }
});
