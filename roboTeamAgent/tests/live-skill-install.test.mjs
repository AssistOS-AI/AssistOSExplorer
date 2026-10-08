import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { installLiveSkills } from '../server/live-skill-install.mjs';
import { runProcess } from '../../../AdvancedLanguageAgent/src/coding-agents/process.mjs';
import { canStartBubblewrap, canMountPrivateProc } from '../../../AdvancedLanguageAgent/src/coding-agents/sandbox.mjs';

async function fixture(t) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'robot-session-skills-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const cwd = path.join(root, 'project');
    const local = path.join(cwd, '.agents/skills/local');
    await fs.mkdir(local, { recursive: true });
    await fs.writeFile(path.join(local, 'SKILL.md'), 'project skill');
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

test('bundled skills resolve to the workspace checkout', async t => {
    const { copilotSkillsRoot } = await import('../server/copilot-skillset.mjs');
    const { root, input, entries } = await fixture(t);
    const source = path.join(root, 'AchillesCLI');
    const skill = path.join(source, 'roboTeamAgent/copilot/src/skills/bash');
    await fs.mkdir(skill, { recursive: true });
    await fs.writeFile(path.join(skill, 'SKILL.md'), 'current bundled skill');
    entries[0] = [{ builtin: true, name: 'bash', enabled: true, sourcePath: path.join(copilotSkillsRoot, 'bash') }];
    const request = input(0);
    request.client.listRepositories = async () => [{ name: 'AchillesCLI', source, origin: 'workspace' }];
    const prepared = await installLiveSkills(request);
    assert.equal(await fs.readFile(path.join(prepared.skillsDirectory, 'bash/SKILL.md'), 'utf8'), 'current bundled skill');
});

test('two Bubblewrap processes see their own skills while private configuration stays hidden', {
    skip: canStartBubblewrap() && canMountPrivateProc() ? false : 'Bubblewrap unavailable',
}, async t => {
    const { root, cwd, input } = await fixture(t);
    const snapshots = await Promise.all([installLiveSkills(input(0)), installLiveSkills(input(1))]);
    await fs.writeFile(path.join(cwd, '.roboteam', 'secret.json'), 'private');
    const results = await Promise.all(snapshots.map(async snapshot => {
        const folders = [{ source: root }, ...snapshot.mounts,
            { source: snapshot.skillsDirectory, target: path.join(cwd, '.agents/skills'), expose: true },
            { source: snapshot.skillsDirectory, target: path.join(cwd, '.claude/skills'), expose: true }];
        return runProcess({ binary: process.execPath, cwd, args: ['-e', `
            const fs = require('node:fs');
            const read = name => fs.readFileSync('.agents/skills/' + name + '/SKILL.md', 'utf8');
            let writable = false;
            try { fs.writeFileSync('.agents/skills/local/SKILL.md', 'changed'); writable = true; } catch {}
            process.stdout.write(JSON.stringify({ example: read('example'), local: read('local'), writable,
                claude: fs.readFileSync('.claude/skills/example/SKILL.md', 'utf8'),
                privateFiles: fs.readdirSync('.roboteam') }));
        `], sandbox: { backend: 'codex', hostWorkspace: cwd, workspaceTarget: cwd, folders,
            ignoredPaths: [path.join(cwd, '.roboteam')] } });
    }));
    for (const [index, result] of results.entries()) {
        assert.equal(result.code, 0, result.stderr);
        assert.deepEqual(JSON.parse(result.stdout), { example: index ? 'second' : 'first',
            local: 'project skill', claude: index ? 'second' : 'first', writable: false, privateFiles: [] });
    }
    assert.deepEqual(await fs.readdir(path.join(cwd, '.agents/skills')), ['local']);
    assert.equal(await fs.readFile(path.join(cwd, '.roboteam/secret.json'), 'utf8'), 'private');
});
