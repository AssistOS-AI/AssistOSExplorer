// Decision M-60: a skill path that can reach a worker admission field (a folder grant now, `skills[]` later) is validated
// without following links and kept as declared. RoboTeam-owned sources keep their resolution (documented in the code).
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { RobotStore } from '../server/robot-store.mjs';
import { RobotSkillsets } from '../server/robot-skillsets.mjs';
import { discoverAnthropicSkills } from '../server/skill-descriptor.mjs';
import { workspaceCodePath } from '../copilot/src/lib/execution/workspaceCodePath.mjs';
import { createAnthropicSkillCatalog } from '../copilot/src/lib/skills/anthropicSkillCatalog.mjs';

async function discoverSkills(roots) {
    const result = [];
    async function scan(directory) {
        for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
            const file = path.join(directory, entry.name);
            if (entry.isDirectory()) await scan(file);
            if (entry.name === 'SKILL.md') {
                const text = await fs.readFile(file, 'utf8');
                result.push({ name: text.match(/^name: (.+)$/m)[1], description: text.match(/^description: (.+)$/m)[1], directoryPath: directory, filePath: file });
            }
        }
    }
    for (const root of roots) await scan(root);
    return result;
}

async function skill(root, directory, name = directory) {
    await fs.mkdir(path.join(root, directory), { recursive: true });
    await fs.writeFile(path.join(root, directory, 'SKILL.md'), `---\nname: ${name}\ndescription: Does ${name}\n---\nBody\n`);
}

async function fixture(t) {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'm60-skills-')));
    const previous = process.env.PLOINKY_WORKSPACE_ROOT;
    const workspace = path.join(root, 'workspace');
    await fs.mkdir(workspace, { recursive: true });
    process.env.PLOINKY_WORKSPACE_ROOT = workspace;
    t.after(async () => {
        if (previous === undefined) delete process.env.PLOINKY_WORKSPACE_ROOT; else process.env.PLOINKY_WORKSPACE_ROOT = previous;
        await fs.rm(root, { recursive: true, force: true });
    });
    const store = new RobotStore({ dataDir: path.join(root, 'private') });
    const robot = await store.create({ name: 'Analyst' });
    const source = path.join(workspace, 'repo');
    await skill(source, 'read-pdf');
    const documentation = path.join(workspace, 'DocumentationSkills');
    await skill(path.join(documentation, 'skills'), 'human-report');
    const skillsets = new RobotSkillsets({ robotStore: store, workspaceRoot: workspace, discoverSkills,
        repositoriesClient: { listRepositories: async () => [{ name: 'DocumentationSkills', source: documentation, origin: 'workspace' }] } });
    return { root, workspace, source, store, robot, skillsets };
}

test('M-60 channel skill path: an in-workspace folder is returned lexically and a linked component yields no grant path', async t => {
    const f = await fixture(t);
    await skill(f.workspace, 'real-area/skills/report-task-blocked', 'report-task-blocked');
    const lexical = path.join(f.workspace, 'real-area', 'skills', 'report-task-blocked');
    assert.equal(await workspaceCodePath(lexical, { workspaceRoot: f.workspace, env: {} }), lexical);
    await fs.symlink(path.join(f.workspace, 'real-area'), path.join(f.workspace, 'alias'));
    await fs.mkdir(path.join(f.workspace, 'other'));
    await fs.symlink(path.join(f.workspace, 'other'), path.join(f.workspace, 'real-area', 'skills', 'hop'));
    for (const source of [path.join(f.workspace, 'alias', 'skills', 'report-task-blocked'), path.join(f.workspace, 'real-area', 'skills', 'hop')]) {
        assert.equal(await workspaceCodePath(source, { workspaceRoot: f.workspace, env: {} }), null, source);
    }
});

test('M-60 skillset registration: a source reached through a link is refused and a plain source is kept as declared', async t => {
    const f = await fixture(t);
    const alias = path.join(f.workspace, 'alias');
    await fs.symlink(f.source, alias);
    await assert.rejects(f.skillsets.add(f.robot.id, { name: 'documents', source: alias }), /symbolic link|link/iu);
    await assert.rejects(f.skillsets.resolveLiveRepository(alias), { statusCode: 400 });
    const record = await f.skillsets.add(f.robot.id, { name: 'documents', source: `${f.source}/` });
    assert.equal(record.source, f.source);
    assert.equal(await f.skillsets.resolveLiveRepository(f.source), f.source);
});

test('M-60 skillset registration: the reserved channel skill names are refused as a source name and as a skill name', async t => {
    const f = await fixture(t);
    for (const name of ['require-human-input', 'report-task-blocked', 'copilot']) {
        await assert.rejects(f.skillsets.add(f.robot.id, { name, source: f.source }), /reserved/iu, name);
    }
    for (const reserved of ['require-human-input', 'report-task-blocked']) {
        const other = path.join(f.workspace, `repo-${reserved}`);
        await skill(other, reserved);
        await assert.rejects(f.skillsets.add(f.robot.id, { name: `set-${reserved}`, source: other }), /reserved/iu, reserved);
    }
    assert.deepEqual((await f.store.get(f.robot.id)).skillsets || [], []);
    await f.skillsets.add(f.robot.id, { name: 'documents', source: f.source });
});

test('M-60 skill discovery: records keep the declared path, and a repository that is itself a link is refused', async t => {
    const f = await fixture(t);
    const records = await discoverAnthropicSkills(f.source);
    assert.deepEqual(records.map(entry => entry.directoryPath), [path.join(f.source, 'read-pdf')]);
    const alias = path.join(f.workspace, 'alias');
    await fs.symlink(f.source, alias);
    await assert.rejects(discoverAnthropicSkills(alias), /symbolic link/iu);
});

test('M-60 CLI skill catalog: a working folder reached through a link is refused instead of resolved', async t => {
    const f = await fixture(t);
    const project = path.join(f.workspace, 'projects', 'app');
    await fs.mkdir(project, { recursive: true });
    await fs.symlink(path.join(f.workspace, 'projects'), path.join(f.workspace, 'alias'));
    const discoverTaskSkills = async () => [];
    await createAnthropicSkillCatalog({ workingDir: project, roots: [], discoverTaskSkills });
    await assert.rejects(createAnthropicSkillCatalog({ workingDir: path.join(f.workspace, 'alias', 'app'), roots: [], discoverTaskSkills }), { code: 'cwd_symlinked' });
});

test('M-60 channel names: a skill of a channel name that a local skillset gained after registration is never enabled', async t => {
    const f = await fixture(t);
    await f.skillsets.add(f.robot.id, { name: 'documents', source: f.source });
    await skill(f.source, 'require-human-input');
    await skill(f.source, 'report-task-blocked');
    const robot = await f.store.get(f.robot.id);
    const selected = await f.skillsets.start(robot, { skillSets: ['documents'] }, (_robot, selection) => selection);
    const inventory = await f.skillsets.inventory(robot, { policyId: selected.policyId, cwd: f.source });
    const byName = new Map(inventory.skills.map(entry => [entry.name, entry]));
    assert.equal(byName.get('read-pdf')?.enabled, true);
    for (const name of ['require-human-input', 'report-task-blocked']) {
        assert.equal(byName.get(name)?.enabled, false, name);
        assert.equal(byName.get(name)?.state, 'shadowed', name);
    }
});

test('M-60 local skillset catalog: the source and skill folders are kept as registered and a link in the source path is refused', async t => {
    const f = await fixture(t);
    await f.skillsets.add(f.robot.id, { name: 'documents', source: f.source });
    const robot = await f.store.get(f.robot.id);
    const selected = await f.skillsets.start(robot, { skillSets: ['documents'] }, (_robot, selection) => selection);
    const inventory = await f.skillsets.inventory(robot, { policyId: selected.policyId, cwd: f.source });
    const entry = inventory.skills.find(item => item.name === 'read-pdf');
    assert.equal(entry.sourcePath, path.join(f.source, 'read-pdf'));
    // The registered folder is replaced by a link to a copy of itself: the catalog refuses it rather than following it.
    await fs.rename(f.source, `${f.source}-moved`);
    await fs.symlink(`${f.source}-moved`, f.source);
    await assert.rejects(f.skillsets.inventory(robot, { policyId: selected.policyId, cwd: f.workspace }), /link/u);
});

test('M-61 launch-workflow: with the worker configured the catalog offers list-workflows but not launch-workflow', async t => {
    const f = await fixture(t);
    const robot = await f.store.get(f.robot.id);
    const selected = await f.skillsets.start(robot, { skillSets: [] }, (_robot, selection) => selection);
    const names = async () => (await f.skillsets.inventory(robot, { policyId: selected.policyId, cwd: f.workspace, workflowSkills: true }))
        .skills.filter(entry => entry.enabled).map(entry => entry.name);
    const previous = process.env.ROBOTEAM_WORKER_COORDINATOR_BASE;
    t.after(() => { if (previous === undefined) delete process.env.ROBOTEAM_WORKER_COORDINATOR_BASE; else process.env.ROBOTEAM_WORKER_COORDINATOR_BASE = previous; });
    delete process.env.ROBOTEAM_WORKER_COORDINATOR_BASE;
    assert.ok((await names()).includes('launch-workflow') && (await names()).includes('list-workflows'));
    process.env.ROBOTEAM_WORKER_COORDINATOR_BASE = 'http://127.0.0.1:1/coordinator';
    const worker = await names();
    assert.equal(worker.includes('launch-workflow'), false);
    assert.ok(worker.includes('list-workflows'));
});
