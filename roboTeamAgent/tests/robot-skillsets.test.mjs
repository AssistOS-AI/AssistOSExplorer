import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { RobotStore } from '../server/robot-store.mjs';
import { RobotSkillsets, publicSkillsets, publicRepositories, individualSkillRepositories } from '../server/robot-skillsets.mjs';
import { RuntimeManager } from '../server/runtime-manager.mjs';
import { listedRepository } from './helpers/repository-listing.mjs';

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

// Every robot always receives the required human-report skill (DS006 and README: required skill from DocumentationSkills).
const REQUIRED_REPORT = 'required/human-report';
function selectedSkills(resolvedSkills) {
    assert.equal(resolvedSkills.filter(name => name === REQUIRED_REPORT).length, 1, 'the required human-report skill is mounted exactly once');
    return resolvedSkills.filter(name => name !== REQUIRED_REPORT);
}

async function fixture(t) {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'robot-skillsets-')));
    const releases = [];
    const previousWorkspaceRoot = process.env.PLOINKY_WORKSPACE_ROOT;
    t.after(async () => {
        for (const release of releases) await release();
        if (previousWorkspaceRoot === undefined) delete process.env.PLOINKY_WORKSPACE_ROOT;
        else process.env.PLOINKY_WORKSPACE_ROOT = previousWorkspaceRoot;
        await fs.rm(root, { recursive: true, force: true });
    });
    const dataDir = path.join(root, 'private');
    const workspaceRoot = path.join(root, 'workspace');
    const source = path.join(workspaceRoot, 'Documents');
    await fs.mkdir(workspaceRoot, { recursive: true });
    // RoboTeam runs inside a configured Ploinky workspace; the fixture provides one.
    process.env.PLOINKY_WORKSPACE_ROOT = workspaceRoot;
    for (const name of ['read-pdf', 'write-doc']) {
        const folder = path.join(source, 'skills', name);
        await fs.mkdir(folder, { recursive: true });
        await fs.writeFile(path.join(folder, 'SKILL.md'), `---\nname: ${name}\ndescription: Can ${name}\n---\nPRIVATE FULL INSTRUCTIONS\n`);
        await fs.writeFile(path.join(folder, 'helper.txt'), 'original helper');
    }
    await fs.writeFile(path.join(source, 'skillsets.md'), '# reports\n\n## Description\nRead and write reports\n\n## Skills\n- read-pdf\n- write-doc\n\n# reading\n## Description\nRead reports\n## Skills\n- read-pdf\n');
    const store = new RobotStore({ dataDir });
    const robot = await store.create({ name: 'Analyst' });
    // The required human-report skill comes from the workspace DocumentationSkills repository.
    const documentation = path.join(workspaceRoot, 'DocumentationSkills');
    await fs.mkdir(path.join(documentation, 'skills/human-report'), { recursive: true });
    await fs.writeFile(path.join(documentation, 'skills/human-report/SKILL.md'), '---\nname: human-report\ndescription: Final report\n---\nReport instructions\n');
    const listed = new Map([['Documents', () => listedRepository('Documents', source, { url: 'https://example.invalid/Documents.git' })],
        ['DocumentationSkills', () => listedRepository('DocumentationSkills', documentation)]]);
    const skillsets = new RobotSkillsets({ robotStore: store, workspaceRoot, discoverSkills,
        repositoriesClient: { listRepositories: async () => [...listed.values()].map(entry => entry()) } });
    const capture = async (selectedRobot, input = {}) => {
        const reference = await skillsets.start(await store.get(selectedRobot.id), input, (_robot, selection) => selection);
        assert.equal(reference.version, 2);
        assert.equal(reference.catalogId, undefined, 'submission must not freeze execution bytes');
        const result = await skillsets.live.capture(await store.get(selectedRobot.id), reference.policyId, source);
        releases.push(result.release);
        return result;
    };
    // The listing is fresh in tests that change the repository on disk.
    const current = async () => { skillsets.listing = null; return store.get(robot.id); };
    return { root, dataDir, source, workspaceRoot, store, robot, skillsets, capture, releases, listed, current };
}

const metadata = (f, id) => fs.readFile(path.join(f.store.robotPath(id), 'metadata.json'), 'utf8').then(JSON.parse);

test('a robot saves only repository names and flat active skills, and adding activates every set member', async t => {
    const f = await fixture(t);
    assert.deepEqual(await f.skillsets.add(f.robot.id, { source: 'Documents' }), { name: 'Documents', skills: ['read-pdf', 'write-doc'] });
    const saved = await metadata(f, f.robot.id);
    assert.deepEqual(saved.repositories, [{ name: 'Documents', skills: ['read-pdf', 'write-doc'] }]);
    assert.equal(saved.skillsets, undefined);
    assert.doesNotMatch(JSON.stringify(saved), /\/workspace\/|definitions|generation/);
    const view = await f.store.get(f.robot.id);
    assert.deepEqual(publicSkillsets(view).map(set => set.id), ['Documents/reports', 'Documents/reading']);
    await assert.rejects(f.skillsets.add(f.robot.id, { source: f.source }), /already exists/);
    await assert.rejects(f.skillsets.add(f.robot.id, { source: 'https://example.invalid/Documents.git' }), /already exists/);
});

test('sets toggle their members in the flat list, so shared members leave a neighbour partial', async t => {
    const f = await fixture(t);
    await f.skillsets.add(f.robot.id, { source: 'Documents' });
    await f.skillsets.setSkillsetEnabled(f.robot.id, { id: 'Documents/reading', enabled: false });
    assert.deepEqual((await metadata(f, f.robot.id)).repositories[0].skills, ['write-doc']);
    let view = await f.store.get(f.robot.id);
    const [reports, reading] = publicRepositories(view)[0].skillsets;
    assert.deepEqual([reports.enabled, reports.partial, reading.enabled, reading.partial], [false, true, false, false]);
    assert.deepEqual(publicSkillsets(view), [], 'discovery omits a partial set');
    assert.deepEqual(individualSkillRepositories(view), [], 'declared sets never fall back to individual skills');
    await f.skillsets.setSkillsetEnabled(f.robot.id, { id: 'Documents/reports', enabled: true });
    view = await f.store.get(f.robot.id);
    assert.deepEqual(publicSkillsets(view).map(set => set.name), ['reports', 'reading']);
    await assert.rejects(f.skillsets.setSkillsetEnabled(f.robot.id, { id: 'Documents/read-pdf', enabled: false }), /skillset controls/);
    await assert.rejects(f.skillsets.setSkillsetEnabled(f.robot.id, { id: 'Documents/reports', enabled: 'false' }), /boolean/);
    await assert.rejects(f.skillsets.setSkillsetEnabled(f.robot.id, { id: 'Missing/reports', enabled: false }), /not found/);
    const other = await f.store.create({ name: 'Other' });
    await f.skillsets.add(other.id, { source: 'Documents' });
    await f.skillsets.setSkillsetEnabled(f.robot.id, { id: 'Documents/reports', enabled: false });
    assert.equal(publicSkillsets(await f.store.get(other.id)).length, 2, 'selection is per robot');
});

test('a set is selected by name, whatever its position and even with spaces', async t => {
    const f = await fixture(t);
    await fs.writeFile(path.join(f.source, 'skillsets.md'), '# Only reading set\n## Description\nRead\n## Skills\n- read-pdf\n\n# reports\n## Description\nBoth\n## Skills\n- read-pdf\n- write-doc\n');
    await f.skillsets.add(f.robot.id, { source: 'Documents' });
    const selected = await f.capture(f.robot, { skillSets: ['Documents/Only reading set'] });
    assert.deepEqual(selectedSkills(selected.resolvedSkills), ['Documents/read-pdf']);
    await fs.writeFile(path.join(f.source, 'skillsets.md'), '# reports\n## Description\nBoth\n## Skills\n- read-pdf\n- write-doc\n\n# Only reading set\n## Description\nRead\n## Skills\n- read-pdf\n');
    await f.current();
    const reordered = await f.skillsets.live.capture(await f.current(), selected.policyId, f.source);
    f.releases.push(reordered.release);
    assert.deepEqual(selectedSkills(reordered.resolvedSkills), ['Documents/read-pdf']);
});

test('repositories without skillsets toggle one skill; disabled skills cannot be selected', async t => {
    const f = await fixture(t);
    await fs.unlink(path.join(f.source, 'skillsets.md'));
    await f.skillsets.add(f.robot.id, { source: 'Documents' });
    await f.skillsets.setSkillsetEnabled(f.robot.id, { id: 'Documents/write-doc', enabled: false });
    const robot = await f.store.get(f.robot.id);
    const fallback = individualSkillRepositories(robot);
    assert.deepEqual(fallback, [{ id: 'Documents', skills: [{ name: 'read-pdf', description: 'Can read-pdf' }] }]);
    assert.doesNotMatch(JSON.stringify(fallback), /PRIVATE FULL|directory|helper/);
    assert.deepEqual(publicRepositories(robot)[0].skills.map(skill => [skill.id, skill.enabled]), [['Documents/read-pdf', true], ['Documents/write-doc', false]]);
    assert.deepEqual(selectedSkills((await f.capture(robot, { skills: ['Documents/read-pdf'] })).resolvedSkills), ['Documents/read-pdf']);
    await assert.rejects(f.capture(robot, { skills: ['Documents/write-doc'] }), /unavailable/);
    await assert.rejects(f.skillsets.setSkillsetEnabled(f.robot.id, { id: 'Documents/missing', enabled: true }), /not found/);
});

test('a skill the repository adds later stays off until it is enabled', async t => {
    const f = await fixture(t);
    await fs.unlink(path.join(f.source, 'skillsets.md'));
    await f.skillsets.add(f.robot.id, { source: 'Documents' });
    await fs.mkdir(path.join(f.source, 'skills/added'));
    await fs.writeFile(path.join(f.source, 'skills/added/SKILL.md'), '---\nname: added\ndescription: Added locally\n---\n');
    let robot = await f.current();
    assert.equal(publicRepositories(robot)[0].skills.find(skill => skill.name === 'added').enabled, false);
    assert.deepEqual(selectedSkills((await f.capture(robot, { skillSets: ['Documents'] })).resolvedSkills).sort(), ['Documents/read-pdf', 'Documents/write-doc']);
    await f.skillsets.setSkillsetEnabled(f.robot.id, { id: 'Documents/added', enabled: true });
    robot = await f.current();
    assert.deepEqual(selectedSkills((await f.capture(robot, { skills: ['Documents/added'] })).resolvedSkills), ['Documents/added']);
});

test('the checkout location comes from Ploinky at each read, never from the robot', async t => {
    const f = await fixture(t);
    await f.skillsets.add(f.robot.id, { source: 'Documents' });
    const moved = path.join(f.workspaceRoot, '.ploinky/repos/Documents');
    await fs.mkdir(path.dirname(moved), { recursive: true });
    await fs.cp(f.source, moved, { recursive: true });
    await fs.writeFile(path.join(moved, 'skills/read-pdf/helper.txt'), 'moved helper');
    const selected = await f.capture(f.robot, { skillSets: ['Documents/reading'] });
    f.listed.set('Documents', () => listedRepository('Documents', moved, { origin: 'installed' }));
    const captured = await f.skillsets.live.capture(await f.current(), selected.policyId, f.source);
    f.releases.push(captured.release);
    assert.equal(await fs.readFile(path.join(captured.catalogPath, 'read-pdf/helper.txt'), 'utf8'), 'moved helper');
});

test('an unavailable repository keeps its saved selection and only fails work that needs it', async t => {
    const f = await fixture(t);
    await f.skillsets.add(f.robot.id, { source: 'Documents' });
    const selected = await f.capture(f.robot, { skillSets: ['Documents/reading'] });
    const empty = await f.capture(f.robot);
    f.listed.delete('Documents');
    const robot = await f.current();
    assert.deepEqual(publicRepositories(robot)[0].skills, []);
    assert.deepEqual((await metadata(f, f.robot.id)).repositories, [{ name: 'Documents', skills: ['read-pdf', 'write-doc'] }]);
    await assert.rejects(f.skillsets.live.capture(robot, selected.policyId, f.source), /not available|unavailable/);
    const unaffected = await f.skillsets.live.capture(robot, empty.policyId, f.source);
    f.releases.push(unaffected.release);
    assert.deepEqual(selectedSkills(unaffected.resolvedSkills), []);
    f.skillsets.repositoriesClient = { listRepositories: async () => { throw new Error('router down'); } };
    assert.deepEqual(publicRepositories(await f.current())[0].skills, [], 'a failed listing cannot break robot reads');
});

test('a folder that differs from its SKILL.md name is invalid when it is used', async t => {
    const f = await fixture(t);
    await fs.unlink(path.join(f.source, 'skillsets.md'));
    await fs.writeFile(path.join(f.source, 'skills/read-pdf/SKILL.md'), '---\nname: other-name\ndescription: Renamed\n---\n');
    await f.skillsets.add(f.robot.id, { source: 'Documents' });
    await assert.rejects(f.capture(f.robot, { skills: ['Documents/read-pdf'] }), /differs from its folder/);
    assert.deepEqual(selectedSkills((await f.capture(f.robot, { skills: ['Documents/write-doc'] })).resolvedSkills), ['Documents/write-doc']);
});

test('copilot is registered only on default and rejects selection on other robots', async (t) => {
    const f = await fixture(t);
    const robot = await f.store.ensureDefaultRobot();
    const selected = await f.capture(robot, { skillSets: ['copilot/copilot'] });
    assert.deepEqual(selectedSkills((await f.capture(robot)).resolvedSkills), []);
    assert.deepEqual(selectedSkills(selected.resolvedSkills).sort(), ['copilot/bash', 'copilot/launch-gpt-researcher']);
    assert.deepEqual(publicSkillsets(robot).map(set => set.id), ['copilot/copilot']);
    assert.deepEqual(selectedSkills((await f.capture(f.robot)).resolvedSkills), []);
    assert.equal(publicSkillsets(f.robot).some(set => set.builtin), false);
    await assert.rejects(f.capture(f.robot, { skills: ['copilot/launch-workflow'] }), /unavailable|not available/);
    await assert.rejects(f.capture(f.robot, { skillSets: ['copilot/copilot'] }), /unavailable|not available/);
    await assert.rejects(f.skillsets.remove(robot.id, 'copilot'), /reserved skill source/i);
    await f.skillsets.setSkillsetEnabled(robot.id, { id: 'copilot/copilot', enabled: false });
    assert.deepEqual(publicSkillsets(await f.store.get(robot.id)), [], 'the bundled set toggles through the same flat list');
    await f.skillsets.setSkillsetEnabled(robot.id, { id: 'copilot/copilot', enabled: true });
    assert.deepEqual(publicSkillsets(await f.store.get(robot.id)).map(set => set.id), ['copilot/copilot']);
});

test('publishes only skill names and frontmatter descriptions', async (t) => {
    const f = await fixture(t);
    await f.skillsets.add(f.robot.id, { source: 'Documents' });
    const catalog = publicSkillsets(await f.store.get(f.robot.id));
    assert.deepEqual(catalog[0].skills, ['read-pdf', 'write-doc']);
    assert.equal(catalog[0].description, 'Read and write reports');
    assert.doesNotMatch(JSON.stringify(catalog), /PRIVATE FULL|directory/);
});

test('registration accepts only what Ploinky lists as a local skill repository', async t => {
    const f = await fixture(t);
    await assert.rejects(f.skillsets.add(f.robot.id, { source: f.dataDir }), /unavailable/);
    await assert.rejects(f.skillsets.add(f.robot.id, { source: path.join(f.workspaceRoot, 'unlisted') }), /unavailable/);
    f.listed.set('Agents', () => ({ name: 'Agents', source: f.source, origin: 'workspace', kind: 'agents' }));
    await assert.rejects(f.skillsets.add(f.robot.id, { source: 'Agents' }), /no skills/);
    f.listed.set('Outside', () => listedRepository('Outside', f.dataDir));
    await assert.rejects(f.skillsets.add(f.robot.id, { source: 'Outside' }), /no skills/);
    await assert.rejects(f.skillsets.add(f.robot.id, { source: 'http://example.invalid/x.git' }), /HTTPS/);
    await assert.rejects(f.skillsets.add(f.robot.id, { source: '' }), /invalid repository source/);
});

test('a remote repository is prepared through Ploinky before it is registered', async t => {
    const f = await fixture(t);
    const url = 'https://example.invalid/Remote.git';
    const remote = path.join(f.workspaceRoot, '.ploinky/repos/Remote');
    await fs.mkdir(path.join(remote, 'skills/report'), { recursive: true });
    await fs.writeFile(path.join(remote, 'skills/report/SKILL.md'), '---\nname: report\ndescription: Report\n---\n');
    const prepared = [];
    f.listed.set('Remote', () => ({ name: 'Remote', source: url, url, origin: 'remote', kind: 'skills', skills: [], skillsets: [] }));
    f.skillsets.repositoriesClient.prepareRepository = async request => {
        prepared.push(request);
        f.listed.set('Remote', () => listedRepository('Remote', remote, { origin: 'installed', url }));
        return f.skillsets.repositoriesClient.listRepositories();
    };
    assert.deepEqual(await f.skillsets.add(f.robot.id, { source: url }), { name: 'Remote', skills: ['report'] });
    assert.deepEqual(prepared, [{ url, name: 'Remote' }]);
});

test('concurrent registrations save one repository under the robot lock', async t => {
    const f = await fixture(t);
    const results = await Promise.allSettled([1, 2].map(() => f.skillsets.add(f.robot.id, { source: 'Documents' })));
    assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
    assert.match(results.find(result => result.status === 'rejected').reason.message, /already exists/);
    assert.equal((await metadata(f, f.robot.id)).repositories.length, 1);
});

test('queues only policy references and explicit pinning preserves execution bytes through task continuation', async (t) => {
    const f = await fixture(t);
    await f.skillsets.add(f.robot.id, { source: 'Documents' });
    const manager = new RuntimeManager({ dataDir: f.dataDir, workspaceRoot: f.skillsets.workspaceRoot, toolCache: {}, skillsets: f.skillsets });
    manager.shuttingDown = true;
    const started = await f.skillsets.start(await f.store.get(f.robot.id), { skillSets: ['Documents/reports', 'Documents/reading'] },
        (robot, reference) => manager.startTask(robot, 'simple', { cwd: f.source, task: 'Review', skillPolicyRef: reference.policyId, alaSessionId: reference.policyId }));
    const original = manager.tasks.get(started.taskId);
    assert.equal(original.request.skillSelection, undefined);
    const selection = await f.skillsets.live.capture(await f.store.get(f.robot.id), original.request.skillPolicyRef, f.source);
    f.releases.push(selection.release);
    assert.equal(selectedSkills(selection.resolvedSkills).length, 2);
    const directory = await f.skillsets.catalogPath(f.robot.id, selection);
    const { release, ...pinnedCatalog } = selection;
    await f.skillsets.policies.update(f.robot.id, selection.policyId, selection.policyVersion, (policy) => ({ ...policy, mode: 'pinned', pinnedCatalog }));
    original.state = 'completed';
    await manager._saveTask(original);
    await f.skillsets.remove(f.robot.id, 'Documents');
    await fs.writeFile(path.join(f.source, 'skills/read-pdf/helper.txt'), 'changed upstream');
    assert.equal(await fs.readFile(path.join(directory, 'read-pdf/helper.txt'), 'utf8'), 'original helper');
    const next = new RuntimeManager({ dataDir: f.dataDir, workspaceRoot: f.skillsets.workspaceRoot, toolCache: {}, skillsets: f.skillsets });
    next.shuttingDown = true;
    const resumed = await next.resumeTask(f.robot, started.taskId, 'Continue review');
    assert.equal(next.tasks.get(resumed.taskId).request.skillPolicyRef, selection.policyId);
    assert.equal(next.tasks.get(resumed.taskId).request.skillSelection, undefined);
    assert.equal(next.tasks.get(resumed.taskId).alaSessionId, original.alaSessionId);
    const continued = await f.skillsets.live.capture(await f.store.get(f.robot.id), selection.policyId, f.source);
    f.releases.push(continued.release);
    assert.equal(continued.catalogPath, directory);
    await assert.rejects(f.skillsets.start(await f.store.get(f.robot.id), { skillSets: 'Documents/reports' }, () => {}), /not available/);
});

test('empty selection mounts only the required report skill; individual selection excludes the rest', async (t) => {
    const f = await fixture(t);
    await f.skillsets.add(f.robot.id, { source: 'Documents' });
    for (const [input, expected] of [[{}, ['human-report']], [{ skills: 'Documents/read-pdf' }, ['human-report', 'read-pdf']]]) {
        const selection = await f.capture(f.robot, input);
        assert.deepEqual((await fs.readdir(await f.skillsets.catalogPath(f.robot.id, selection))).filter((name) => name !== '.catalog.json'), expected);
    }
    const robot = await f.store.get(f.robot.id);
    for (const input of [{ skills: '../secret' }, { skillSets: 'missing' }, { skills: 'Documents/nope' }, { skills: {} }]) {
        await assert.rejects(f.skillsets.start(robot, input, () => assert.fail('must not enqueue')));
    }
});

test('rejects symlinked skills at capture, duplicate selected names and catalog tampering', async (t) => {
    const f = await fixture(t);
    await f.skillsets.add(f.robot.id, { source: 'Documents' });
    const second = path.join(f.workspaceRoot, 'Second');
    await fs.cp(f.source, second, { recursive: true });
    f.listed.set('Second', () => listedRepository('Second', second));
    await f.skillsets.add(f.robot.id, { source: 'Second' });
    const robot = await f.current();
    await assert.rejects(f.skillsets.start(robot, { skills: ['Documents/read-pdf', 'Second/read-pdf'] }, () => {}), /duplicate native name/);
    const selection = await f.capture(f.robot, { skills: 'Documents/read-pdf' });
    const directory = await f.skillsets.catalogPath(f.robot.id, selection);
    await fs.chmod(path.join(directory, 'read-pdf/helper.txt'), 0o600);
    await fs.writeFile(path.join(directory, 'read-pdf/helper.txt'), 'tampered');
    await assert.rejects(f.skillsets.catalogPath(f.robot.id, selection), /changed/);
    await fs.symlink('/etc/passwd', path.join(f.source, 'skills/write-doc/link'));
    await assert.rejects(f.capture(f.robot, { skills: 'Documents/write-doc' }), /symbolic|invalid|write-doc/);
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

test('a described skillset mounts only its members with their resource files', async t => {
    const f = await fixture(t);
    await f.skillsets.add(f.robot.id, { source: 'Documents' });
    const selected = await f.capture(f.robot, { skillSets: ['Documents/reading'] });
    const directory = await f.skillsets.catalogPath(f.robot.id, selected);
    assert.deepEqual(selectedSkills(selected.resolvedSkills), ['Documents/read-pdf']);
    assert.equal(await fs.readFile(path.join(directory, 'read-pdf/helper.txt'), 'utf8'), 'original helper');
    assert.deepEqual((await fs.readdir(directory)).sort(), ['.catalog.json', 'human-report', 'read-pdf']);
    await fs.writeFile(path.join(f.source, 'skills/read-pdf/helper.txt'), 'edited helper');
    const current = await f.skillsets.live.capture(await f.store.get(f.robot.id), selected.policyId, f.source);
    f.releases.push(current.release);
    assert.deepEqual(selectedSkills(current.resolvedSkills), ['Documents/read-pdf']);
    assert.notEqual(current.revision, selected.revision);
    assert.equal(await fs.readFile(path.join(current.catalogPath, 'read-pdf/helper.txt'), 'utf8'), 'edited helper');
});

test('named membership fails on removal while exclusions and overlapping sets retain their meaning', async t => {
    const f = await fixture(t);
    await f.skillsets.add(f.robot.id, { source: 'Documents' });
    const selected = await f.capture(f.robot, { skillSets: ['Documents/reports', 'Documents/reading'] });
    assert.equal(selectedSkills(selected.resolvedSkills).length, 2, 'overlapping groups must not duplicate registrations');
    const policy = await f.skillsets.policies.read(f.robot.id, selected.policyId);
    await fs.rm(path.join(f.source, 'skills/read-pdf'), { recursive: true });
    await fs.writeFile(path.join(f.source, 'skillsets.md'), '# reports\n## Description\nBoth\n## Skills\n- write-doc\n\n# reading\n## Description\nNow writing\n## Skills\n- write-doc\n');
    policy.selectors.skills = ['Documents/read-pdf'];
    await assert.rejects(f.skillsets.live.resolve(await f.current(), policy, f.source), /skill is unavailable/);
    policy.excludedSkills.push('Documents/read-pdf');
    const remaining = await f.skillsets.live.resolve(await f.store.get(f.robot.id), policy, f.source);
    assert.ok(remaining.entries.filter(entry => entry.enabled).every(entry => entry.name !== 'read-pdf'));
    policy.excludedSources.push('Documents');
    await f.skillsets.remove(f.robot.id, 'Documents');
    const empty = await f.skillsets.live.resolve(await f.store.get(f.robot.id), policy, f.source);
    assert.deepEqual(empty.entries.filter(entry => entry.enabled).map(entry => entry.name), ['human-report']);
    policy.excludedSources = [];
    await assert.rejects(f.skillsets.live.resolve(await f.store.get(f.robot.id), policy, f.source), /not available|unavailable/);
});

test('default chat gets copilot while a saved delegated default conversation selects only the required report skill', async t => {
    const { createRobotSkillCatalog } = await import('../copilot/src/lib/skills/robotSkillCatalog.mjs');
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
    assert.deepEqual(chat.skills.filter(skill => skill.enabled).map(skill => skill.name).sort(),
        ['bash', 'human-report', 'launch-gpt-researcher']);
    assert.equal(catalog.command, undefined);
    const empty = await f.skillsets.start(robot, {}, (_robot, selection) => selection);
    session = { skillPolicyRef: empty.policyId };
    const delegated = await catalog.refresh(empty.policyId);
    assert.deepEqual(delegated.skills.filter(skill => skill.enabled).map(skill => skill.name), ['human-report'],
        'a delegated default conversation selects nothing beyond the required report skill');
    assert.equal(session.skillPolicyRef, empty.policyId);
});

test('removing a repository fails live continuation that still needs it', async t => {
    const f = await fixture(t);
    await f.skillsets.add(f.robot.id, { source: 'Documents' });
    const selection = await f.capture(f.robot, { skillSets: ['Documents/reports'] });
    await f.skillsets.remove(f.robot.id, 'Documents');
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
    await f.skillsets.add(f.robot.id, { source: 'Documents' });
    const alias = path.join(f.root, 'private-alias');
    await fs.symlink(f.dataDir, alias, 'dir');
    const store = new RobotStore({ dataDir: alias });
    const skillsets = new RobotSkillsets({ robotStore: store, workspaceRoot: f.workspaceRoot, repositoriesClient: f.skillsets.repositoriesClient,
        discoverSkills: async roots => discoverSkills(await Promise.all(roots.map(root => fs.realpath(root)))) });
    const robot = await store.get(f.robot.id);
    const set = publicSkillsets(robot).find(entry => !entry.builtin);
    const selected = await skillsets.start(robot, { skillSets: [set.id] }, (_robot, selection) => selection);
    const inventory = await skillsets.inventory(robot, { policyId: selected.policyId, cwd: f.source });
    const enabledSkills = inventory.skills.filter(skill => skill.enabled);
    assert.ok(enabledSkills.some(skill => skill.name === 'human-report' && skill.required));
    const selectedPaths = enabledSkills.filter(skill => !skill.required).map(skill => skill.sourcePath);
    assert.equal(selectedPaths.length, 2);
    for (const directory of selectedPaths) {
        assert.equal(directory, await fs.realpath(directory));
        assert.ok(directory.startsWith(f.source + path.sep));
    }
});

test('a mixed repository contributes only its root skills/ folder, not its agents\' skills', async t => {
    const f = await fixture(t);
    const mixed = path.join(f.workspaceRoot, 'Mixed');
    for (const [folder, name] of [['skills/report', 'report'], ['agent/skills/private', 'private'], ['.agents/skills/specs', 'specs']]) {
        await fs.mkdir(path.join(mixed, folder), { recursive: true });
        await fs.writeFile(path.join(mixed, folder, 'SKILL.md'), `---\nname: ${name}\ndescription: ${name}\n---\n`);
    }
    f.listed.set('Mixed', () => listedRepository('Mixed', mixed, { kind: 'mixed' }));
    assert.deepEqual(await f.skillsets.add(f.robot.id, { source: mixed }), { name: 'Mixed', skills: ['report'] });
    const captured = await f.capture(f.robot, { skillSets: ['Mixed'] });
    assert.deepEqual(selectedSkills(captured.entries.map(entry => entry.identity)), ['Mixed/report']);
});
