import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { RobotStore } from '../server/robot-store.mjs';
import { RobotSkillsets, publicSkillsets, publicRepositories, individualSkillRepositories } from '../server/robot-skillsets.mjs';
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
    await fs.writeFile(path.join(source, 'skillsets.md'), '# reports\n\n## Description\nRead and write reports\n\n## Skills\n- read-pdf\n- write-doc\n\n# reading\n## Description\nRead PDFs\n## Skills\n- read-pdf\n');
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

test('disabled skillsets persist per robot and disappear only from discovery', async (t) => {
    const f = await fixture(t);
    await f.skillsets.add(f.robot.id, { name: 'documents', source: f.source });
    const id = 'documents-set-1';
    await f.skillsets.setSkillsetEnabled(f.robot.id, { id, enabled: false });
    const saved = await f.store.get(f.robot.id);
    assert.deepEqual(publicSkillsets(saved).map(set => set.id), ['documents-set-2']);
    assert.equal(publicRepositories(saved)[0].skillsets[0].enabled, false);
    assert.deepEqual(individualSkillRepositories(saved), [], 'disabled combinations must not leak through individual-skill fallback');
    assert.equal((await f.capture(saved, { skillSets: [id] })).resolvedSkills.length, 2, 'saved task selections remain usable');
    const other = await f.store.create({ name: 'Other', specialization: 'Reports' });
    await f.skillsets.add(other.id, { name: 'documents', source: f.source });
    assert.equal(publicSkillsets(await f.store.get(other.id)).length, 2);
    await assert.rejects(f.skillsets.setSkillsetEnabled(f.robot.id, { id: 'missing', enabled: false }), /not found/);
    await assert.rejects(f.skillsets.setSkillsetEnabled(f.robot.id, { id, enabled: 'false' }), /boolean/);
    await f.skillsets.setSkillsetEnabled(f.robot.id, { id, enabled: true });
    assert.equal(publicSkillsets(await f.store.get(f.robot.id)).length, 2);
});

test('copilot is registered only on default and rejects selection on other robots', async (t) => {
    const f = await fixture(t);
    const robot = await f.store.ensureDefaultRobot();
    const selected = await f.capture(robot, { skillSets: ['copilot'] });
    assert.deepEqual((await f.capture(robot)).resolvedSkills, []);
    assert.deepEqual([...selected.resolvedSkills].sort(), [
        'copilot/bash', 'copilot/launch-gpt-researcher',
        'copilot/launch-robot',
    ]);
    assert.ok(selected.resolvedSkills.every((name) => name.startsWith('copilot/')));
    const other = await f.capture(f.robot);
    assert.deepEqual(other.resolvedSkills, []);
    assert.equal(publicSkillsets(f.robot).some(set => set.builtin), false);
    await assert.rejects(f.capture(f.robot, { skills: ['copilot/launch-robot'] }), /unavailable|not available/);
    await assert.rejects(f.capture(f.robot, { skillSets: ['copilot'] }), /unavailable|not available/);
    await assert.rejects(f.skillsets.remove(robot.id, 'copilot'), /reserved skill source/i);
});

test('imports allowed catalogs and publishes only skill names and frontmatter descriptions', async (t) => {
    const { skillsets, robot, source, store } = await fixture(t);
    await skillsets.add(robot.id, { name: 'documents', description: 'Read and write documents', source });
    const all = publicSkillsets(await store.get(robot.id));
    assert.equal(all.some(set => set.id === 'copilot'), false);
    const catalog = all.filter((set) => !set.builtin);
    assert.equal(catalog[0].skills.length, 2);
    assert.equal(catalog[0].skills[0], 'read-pdf');
    assert.equal(catalog.length, 2);
    assert.equal(catalog[0].description, 'Read and write reports');
    assert.equal(JSON.stringify(catalog).includes('PRIVATE FULL'), false);
    assert.equal(JSON.stringify(catalog).includes('directory'), false);
    await assert.rejects(skillsets.add(robot.id, { name: 'documents', source }), /already exists/);
});

test('registration rejects duplicate names and canonical local sources without publishing generations', async t => {
    const f = await fixture(t);
    const alias = path.join(f.source, '..', 'alias');
    const second = path.join(f.source, '..', 'second');
    await fs.symlink(f.source, alias);
    await fs.cp(f.source, second, { recursive: true });
    const original = await f.skillsets.add(f.robot.id, { name: 'documents', source: alias });
    assert.equal(original.source, f.source);
    for (const input of [
        { name: 'documents', source: second },
        { name: 'alias-again', source: alias },
        { name: 'canonical-again', source: `${f.source}/` },
    ]) await assert.rejects(f.skillsets.add(f.robot.id, input), /already exists/);
    assert.deepEqual((await f.store.get(f.robot.id)).skillsets, [original]);
    assert.deepEqual(await fs.readdir(path.join(f.store.robotPath(f.robot.id), 'skillsets')), [original.generation]);
    assert.deepEqual(await fs.readdir(path.join(f.dataDir, 'skillset-imports')), []);
});

test('concurrent registrations reserve one repository identity under the robot lock', async t => {
    const f = await fixture(t);
    const second = path.join(f.source, '..', 'second');
    await fs.cp(f.source, second, { recursive: true });
    const results = await Promise.allSettled([f.source, second].map(source =>
        f.skillsets.add(f.robot.id, { name: 'documents', source })));
    assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
    assert.match(results.find(result => result.status === 'rejected').reason.message, /already exists/);
    const saved = (await f.store.get(f.robot.id)).skillsets;
    assert.equal(saved.length, 1);
    assert.deepEqual(await fs.readdir(path.join(f.store.robotPath(f.robot.id), 'skillsets')), [saved[0].generation]);
    assert.deepEqual(await fs.readdir(path.join(f.dataDir, 'skillset-imports')), []);
});

for (const names of [['documents', 'documents-set-1'], ['documents-set-1', 'documents']]) {
    test(`registration rejects repository/subset selector collisions after ${names[0]}`, async t => {
        const f = await fixture(t);
        const second = path.join(f.source, '..', 'second');
        await fs.cp(f.source, second, { recursive: true });
        const original = await f.skillsets.add(f.robot.id, { name: names[0], source: f.source });
        await assert.rejects(f.skillsets.add(f.robot.id, { name: names[1], source: second }), /ambiguous skillset selector/);
        assert.deepEqual((await f.store.get(f.robot.id)).skillsets, [original]);
        assert.deepEqual(await fs.readdir(path.join(f.store.robotPath(f.robot.id), 'skillsets')), [original.generation]);
        assert.deepEqual(await fs.readdir(path.join(f.dataDir, 'skillset-imports')), []);
    });
}

test('saved ambiguous selectors fail on creation and continuation while qualified individuals stay usable', async t => {
    const f = await fixture(t);
    const second = path.join(f.source, '..', 'second');
    await fs.cp(f.source, second, { recursive: true });
    await fs.writeFile(path.join(second, 'read-pdf/helper.txt'), 'second source helper');
    await f.skillsets.add(f.robot.id, { name: 'documents', source: f.source });
    const policy = await f.skillsets.policies.make(await f.store.get(f.robot.id), { skillSets: ['documents-set-1'] });
    await f.skillsets.add(f.robot.id, { name: 'other', source: second });
    await f.store.withRobot(f.robot.id, (robot, save) => save({ ...robot,
        skillsets: robot.skillsets.map(repo => repo.name === 'other' ? { ...repo, name: 'documents-set-1' } : repo),
    }));
    const robot = await f.store.get(f.robot.id);
    await assert.rejects(f.skillsets.policies.make(robot, { skillSets: ['documents-set-1'] }), /ambiguous skillset selector/);
    await assert.rejects(f.skillsets.live.resolve(robot, policy, f.source), /ambiguous skillset selector/);
    const selected = await f.capture(robot, { skills: ['documents-set-1/read-pdf'] });
    assert.deepEqual(selected.resolvedSkills, ['documents-set-1/read-pdf']);
    assert.equal(await fs.readFile(path.join(selected.catalogPath, 'read-pdf/helper.txt'), 'utf8'), 'second source helper');
});

test('queues only policy references and explicit pinning preserves execution bytes through task continuation', async (t) => {
    const f = await fixture(t);
    const repo = await f.skillsets.add(f.robot.id, { source: f.source });
    const manager = new RuntimeManager({ dataDir: f.dataDir, toolCache: {}, skillsets: f.skillsets });
    manager.shuttingDown = true;
    const started = await f.skillsets.start(f.robot, { skillSets: [`${repo.name}-set-1`, `${repo.name}-set-2`] },
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
    await f.skillsets.remove(f.robot.id, repo.name);
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
    const secondSource = path.join(f.source, '..', 'second');
    await fs.cp(f.source, secondSource, { recursive: true });
    await f.skillsets.add(f.robot.id, { name: 'two', source: secondSource });
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
    const selected = await f.capture(f.robot, { skillSets: [`${repo.name}-set-2`] });
    const directory = await f.skillsets.catalogPath(f.robot.id, selected);
    assert.deepEqual(selected.resolvedSkills, [`${repo.name}/read-pdf`]);
    assert.equal(await fs.readFile(path.join(directory, 'read-pdf/helper.txt'), 'utf8'), 'original helper');
    assert.deepEqual((await fs.readdir(directory)).sort(), ['.catalog.json', 'read-pdf']);
    await fs.writeFile(path.join(f.source, 'read-pdf/helper.txt'), 'edited helper');
    await fs.mkdir(path.join(f.source, 'added'));
    await fs.writeFile(path.join(f.source, 'added/SKILL.md'), '---\nname: added\ndescription: Added locally\n---\n');
    const policy = await f.skillsets.policies.read(f.robot.id, selected.policyId);
    assert.deepEqual(policy.bindings[repo.name], { source: repo.source, generation: repo.generation });
    const current = await f.skillsets.live.capture(await f.store.get(f.robot.id), selected.policyId, f.source);
    f.releases.push(current.release);
    assert.deepEqual(current.resolvedSkills, [`${repo.name}/read-pdf`], 'subset must not select new siblings');
    assert.notEqual(current.revision, selected.revision);
    assert.equal(await fs.readFile(path.join(current.catalogPath, 'read-pdf/helper.txt'), 'utf8'), 'edited helper');
    const all = await f.capture(f.robot, { skillSets: [repo.name] });
    assert.deepEqual(all.resolvedSkills.map(identity => identity.split('/')[1]).sort(), ['added', 'read-pdf', 'write-doc']);
    const individual = await f.capture(f.robot, { skills: [`${repo.name}/added`] });
    assert.deepEqual(individual.resolvedSkills, [`${repo.name}/added`]);
});

test('named membership fails on removal while exclusions and overlapping sets retain their meaning', async t => {
    const f = await fixture(t);
    const repo = await f.skillsets.add(f.robot.id, { source: f.source });
    const selected = await f.capture(f.robot, { skillSets: [`${repo.name}-set-1`, `${repo.name}-set-2`] });
    assert.equal(selected.resolvedSkills.length, 2, 'overlapping groups must not duplicate registrations');
    const policy = await f.skillsets.policies.read(f.robot.id, selected.policyId);
    await fs.rm(path.join(f.source, 'read-pdf'), { recursive: true });
    await assert.rejects(f.skillsets.live.resolve(await f.store.get(f.robot.id), policy, f.source), /selected skill is unavailable/);
    policy.excludedSkills.push(`${repo.name}/read-pdf`);
    const remaining = await f.skillsets.live.resolve(await f.store.get(f.robot.id), policy, f.source);
    assert.deepEqual(remaining.entries.filter(entry => entry.enabled).map(entry => entry.name), ['write-doc']);
    policy.excludedSources.push(repo.name);
    await f.skillsets.remove(f.robot.id, repo.name);
    const empty = await f.skillsets.live.resolve(await f.store.get(f.robot.id), policy, f.source);
    assert.deepEqual(empty.entries.filter(entry => entry.enabled), []);
    policy.excludedSources = [];
    await assert.rejects(f.skillsets.live.resolve(await f.store.get(f.robot.id), policy, f.source), /not available/);
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
    const selected = await f.capture(robot, { skills: [`${repo.name}/read-pdf`] });
    assert.deepEqual(selected.resolvedSkills, [`${repo.name}/read-pdf`]);
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
        sessionStore, workingDir: f.source, discoverTaskSkills: discoverSkills });
    const chatId = crypto.randomUUID();
    const chat = await catalog.refresh(chatId);
    assert.equal(chat.skills.filter(skill => skill.enabled).length, 3);
    await catalog.command(chatId, 'use none');
    assert.deepEqual((await catalog.refresh(chatId)).skills.filter(skill => skill.enabled), []);
    const empty = await f.skillsets.start(robot, {}, (_robot, selection) => selection);
    session = { skillPolicyRef: empty.policyId };
    const delegated = await catalog.refresh(empty.policyId);
    assert.deepEqual(delegated.skills.filter(skill => skill.enabled), []);
    assert.equal(session.skillPolicyRef, empty.policyId);
});


test('removed named sources fail live continuation and do not revive after re-registration', async t => {
    const f = await fixture(t);
    const repo = await f.skillsets.add(f.robot.id, { source: f.source });
    const selection = await f.capture(f.robot, { skillSets: [`${repo.name}-set-1`] });
    await f.skillsets.remove(f.robot.id, repo.name);
    await f.skillsets.add(f.robot.id, { source: f.source });
    await assert.rejects(f.skillsets.live.capture(await f.store.get(f.robot.id), selection.policyId, f.source), /not available|unavailable/);
    assert.equal(await fs.readFile(path.join(selection.catalogPath, 'read-pdf/helper.txt'), 'utf8'), 'original helper');
});


test('empty legacy copied catalogs remain usable without deleting their directories', async t => {
    const f = await fixture(t);
    const catalogId = crypto.randomUUID();
    const legacy = path.join(f.store.robotPath(f.robot.id), 'runtime', 'skill-catalogs', catalogId);
    await fs.mkdir(legacy, { recursive: true });
    const file = await f.skillsets.catalogPath(f.robot.id, {
        catalogId, resolvedSkills: [], digest: crypto.createHash('sha256').digest('hex'),
    });
    assert.deepEqual(await fs.readdir(file), []);
    assert.ok((await fs.stat(legacy)).isDirectory());
});


test('selected skills accept a symlinked runtime storage path and save canonical paths', async t => {
    const f = await fixture(t);
    await f.skillsets.add(f.robot.id, { source: f.source });
    const alias = path.join(f.root, 'private-alias');
    await fs.symlink(f.dataDir, alias, 'dir');
    const store = new RobotStore({ dataDir: alias });
    const skillsets = new RobotSkillsets({ robotStore: store, workspaceRoot: path.dirname(f.source), discoverSkills: async roots =>
        discoverSkills(await Promise.all(roots.map(root => fs.realpath(root)))) });
    const robot = await store.get(f.robot.id);
    const set = publicSkillsets(robot).find(entry => !entry.builtin);
    const selected = await skillsets.start(robot, { skillSets: [set.id] }, (_robot, selection) => selection);
    const inventory = await skillsets.inventory(robot, { policyId: selected.policyId, cwd: f.source });
    const selectedPaths = inventory.skills.filter(skill => skill.enabled).map(skill => skill.sourcePath);
    assert.equal(selectedPaths.length, 2);
    for (const directory of selectedPaths) {
        assert.equal(directory, await fs.realpath(directory));
        assert.ok(directory.startsWith(f.source + path.sep));
    }
});
