import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { installLiveSkills } from '../server/live-skill-install.mjs';

async function fixture(t, { projectSkills = true } = {}) {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'robot-session-skills-')));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const cwd = path.join(root, 'project');
    const local = path.join(cwd, '.agents/skills/local');
    await fs.mkdir(cwd, { recursive: true });
    if (projectSkills) {
        await fs.mkdir(local, { recursive: true });
        await fs.writeFile(path.join(local, 'SKILL.md'), 'project skill');
    }
    const sources = await Promise.all(['first', 'second'].map(async name => {
        const source = path.join(root, name, 'skills/example');
        await fs.mkdir(source, { recursive: true });
        await fs.writeFile(path.join(source, 'SKILL.md'), name);
        return source;
    }));
    const entries = sources.map(sourcePath => [{ name: 'example', sourcePath, enabled: true }]);
    const client = { listRepositories: async () => [], install: () => { throw new Error('Shared links must not be installed'); } };
    const input = index => ({ sessionId: randomUUID(), cwd, client, robot: { id: `robot-${index}` }, policyId: `policy-${index}`,
        service: { workspaceRoot: root, policies: { read: async () => ({ mode: 'live', policyVersion: 1 }) },
            live: { resolve: async () => ({ entries: entries[index], diagnostics: [] }) } } });
    return { root, cwd, local, sources, entries, input };
}

test('concurrent robot sessions publish separate links and preserve the working folder', async t => {
    const { cwd, local, sources, entries, input } = await fixture(t);
    const first = input(0), second = input(1);
    const [a, b] = await Promise.all([installLiveSkills(first), installLiveSkills(second)]);
    assert.notEqual(a.skillsDirectory, b.skillsDirectory);
    assert.equal(a.skillsDirectory, path.join(cwd, '.roboteam/sessions', first.sessionId, 'skills'));
    assert.equal(await fs.readFile(path.join(a.skillsDirectory, 'example/SKILL.md'), 'utf8'), 'first');
    assert.equal(await fs.readFile(path.join(b.skillsDirectory, 'example/SKILL.md'), 'utf8'), 'second');
    assert.equal(await fs.readlink(path.join(a.skillsDirectory, 'example')), sources[0]);
    assert.ok(a.mounts.some(mount => mount.source === local));
    assert.deepEqual(await fs.readdir(path.join(cwd, '.agents/skills')), ['local']);
    await assert.rejects(fs.lstat(path.join(cwd, '.agents/.roboteam-links.json')), { code: 'ENOENT' });
    entries[0] = [];
    await installLiveSkills(first);
    assert.deepEqual(await fs.readdir(a.skillsDirectory), ['local']);
    assert.equal(await fs.readFile(path.join(b.skillsDirectory, 'example/SKILL.md'), 'utf8'), 'second');
    assert.equal(await fs.readFile(path.join(local, 'SKILL.md'), 'utf8'), 'project skill');
});

test('robot selection overrides a project name only in its session, including non-repository sources', async t => {
    const { cwd, input } = await fixture(t);
    await fs.mkdir(path.join(cwd, '.agents/skills/example'));
    await fs.writeFile(path.join(cwd, '.agents/skills/example/SKILL.md'), 'project example');
    const prepared = await installLiveSkills(input(0));
    assert.equal(await fs.readFile(path.join(prepared.skillsDirectory, 'example/SKILL.md'), 'utf8'), 'first');
    assert.equal(await fs.readFile(path.join(cwd, '.agents/skills/example/SKILL.md'), 'utf8'), 'project example');
});

// Decision M-60: a workspace checkout of AchillesIDE (`origin: 'workspace'`) is a project a workload can write. Its copy of a bundled
// skill is used only when it is the bundle itself (same device and inode), walked without following links and never resolved.
async function bundleFixture(t, { make }) {
    const { copilotSkillsRoot } = await import('../server/copilot-skillset.mjs');
    const { workspaceCodePath } = await import('../copilot/src/lib/execution/workspaceCodePath.mjs');
    const { root, input, entries } = await fixture(t);
    const source = path.join(root, 'AchillesIDE');
    const skills = path.join(source, 'roboTeamAgent/copilot/src/skills');
    await fs.mkdir(skills, { recursive: true });
    const victim = path.join(root, 'victim-project');
    await fs.mkdir(victim);
    await fs.writeFile(path.join(victim, 'SKILL.md'), 'victim');
    await make({ skills, victim });
    const bundled = await fs.realpath(path.join(copilotSkillsRoot, 'bash'));
    entries[0] = [{ builtin: true, name: 'bash', enabled: true, owner: await fs.realpath(copilotSkillsRoot), sourcePath: path.join(copilotSkillsRoot, 'bash') }];
    const request = input(0);
    request.client.listRepositories = async () => [{ name: 'AchillesIDE', source, origin: 'workspace' }];
    return { root, request, skills, victim, bundled, workspaceCodePath, copy: path.join(skills, 'bash') };
}

test('bundled skills resolve to the workspace checkout only when it is the same folder as the bundle', async t => {
    const f = await bundleFixture(t, { make: async ({ skills }) => {
        await fs.mkdir(path.join(skills, 'bash'));
        await fs.writeFile(path.join(skills, 'bash/SKILL.md'), 'the bundle seen through the checkout');
    } });
    // The genuine bundle: the same device and inode through both spellings (a bind mount, which a test cannot make).
    const same = async () => ({ isDirectory: () => true, dev: 1, ino: 2 });
    const prepared = await installLiveSkills({ ...f.request, stat: same });
    assert.equal(prepared.entries[0].sourcePath, f.copy, 'kept as walked, not resolved');
    assert.equal(await fs.readFile(path.join(prepared.skillsDirectory, 'bash/SKILL.md'), 'utf8'), 'the bundle seen through the checkout');
    assert.equal(await f.workspaceCodePath(prepared.entries[0].sourcePath, { workspaceRoot: f.root, env: {} }), f.copy);
});

test('a checkout copy that is a different folder is not used, so a rewritten bundle script is never granted', async t => {
    const f = await bundleFixture(t, { make: async ({ skills }) => {
        await fs.mkdir(path.join(skills, 'bash/scripts'), { recursive: true });
        await fs.writeFile(path.join(skills, 'bash/SKILL.md'), 'substituted');
    } });
    const prepared = await installLiveSkills(f.request);
    assert.equal(prepared.entries[0].sourcePath, f.bundled);
    assert.notEqual(await fs.readFile(path.join(prepared.skillsDirectory, 'bash/SKILL.md'), 'utf8'), 'substituted');
    assert.equal(await f.workspaceCodePath(prepared.entries[0].sourcePath, { workspaceRoot: f.root, env: {} }), null, 'no grant path');
});

test('a link planted at the checkout copy is never resolved into a grant on another project', async t => {
    const f = await bundleFixture(t, { make: async ({ skills, victim }) => { await fs.symlink(victim, path.join(skills, 'bash')); } });
    const same = async () => ({ isDirectory: () => true, dev: 1, ino: 2 });
    for (const options of [{}, { stat: same }]) {
        const prepared = await installLiveSkills({ ...f.request, ...options });
        assert.equal(prepared.entries[0].sourcePath, f.bundled, 'the link is refused even when an identity check would accept it');
        assert.notEqual(await fs.readlink(path.join(prepared.skillsDirectory, 'bash')), f.victim);
        assert.equal(await f.workspaceCodePath(prepared.entries[0].sourcePath, { workspaceRoot: f.root, env: {} }), null);
    }
});
