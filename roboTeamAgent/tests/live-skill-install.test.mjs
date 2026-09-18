import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { installLiveSkills } from '../server/live-skill-install.mjs';
import { installRepositoryLinks, removeRepositoryLinks } from '../../../ploinky/cli/utils/repositoryInstall.mjs';

test('robot prepares live links through the client, removes deselected links and preserves sources', async t => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'robot-live-install-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const cwd = path.join(root, 'robot');
    const source = path.join(root, 'Skills');
    const skill = path.join(source, 'skills/example');
    await fs.mkdir(cwd); await fs.mkdir(skill, { recursive: true });
    await fs.writeFile(path.join(skill, 'SKILL.md'), 'original');
    const repository = { name: 'Skills', source, origin: 'workspace' };
    const options = { workspaceRoot: root, resolveRepository: () => repository };
    let entries = [{ name: 'example', enabled: true, identity: 'Skills/example', sourcePath: skill }];
    const calls = [];
    const client = {
        listRepositories: async () => [repository],
        install: async input => { calls.push('install'); return installRepositoryLinks(input, options); },
        remove: async paths => { calls.push('remove'); return removeRepositoryLinks(paths, options); },
    };
    const service = { policies: { read: async () => ({ mode: 'live', policyVersion: 1 }) },
        live: { resolve: async () => ({ entries, diagnostics: [] }) } };
    const input = { service, robot: { id: 'robot' }, policyId: 'policy', cwd, client };
    const prepared = await installLiveSkills(input);
    assert.equal(prepared.live, true);
    assert.equal(prepared.catalogPath, undefined);
    await fs.writeFile(path.join(skill, 'SKILL.md'), 'new');
    assert.equal(await fs.readFile(path.join(cwd, '.agents/skills/example/SKILL.md'), 'utf8'), 'new');
    await installLiveSkills(input);
    assert.deepEqual(calls, ['install', 'install']);
    const replacement = path.join(root, 'WorkspaceSkills', 'skills', 'example');
    await fs.mkdir(replacement, { recursive: true });
    await fs.writeFile(path.join(replacement, 'SKILL.md'), 'workspace version');
    repository.source = path.dirname(path.dirname(replacement));
    entries[0].sourcePath = replacement;
    await installLiveSkills(input);
    assert.equal(await fs.readFile(path.join(cwd, '.agents/skills/example/SKILL.md'), 'utf8'), 'workspace version');
    entries = [];
    await installLiveSkills(input);
    assert.deepEqual(calls, ['install', 'install', 'remove', 'install', 'remove', 'install']);
    assert.equal(await fs.readFile(path.join(skill, 'SKILL.md'), 'utf8'), 'new');
    await assert.rejects(fs.lstat(path.join(cwd, '.agents/skills/example')), { code: 'ENOENT' });
});


test('skills without a Ploinky repository are skipped and reported, not fatal', async t => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'robot-live-orphan-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const cwd = path.join(root, 'robot');
    const source = path.join(root, 'Skills');
    const skill = path.join(source, 'skills/installed');
    const orphan = path.join(root, '.agents/skills/authoring');
    await fs.mkdir(cwd); await fs.mkdir(skill, { recursive: true }); await fs.mkdir(orphan, { recursive: true });
    await fs.writeFile(path.join(skill, 'SKILL.md'), 'installed');
    await fs.writeFile(path.join(orphan, 'SKILL.md'), 'authoring');
    const repository = { name: 'Skills', source, origin: 'workspace' };
    const options = { workspaceRoot: root, resolveRepository: () => repository };
    const client = {
        listRepositories: async () => [repository],
        install: async input => installRepositoryLinks(input, options),
        remove: async paths => removeRepositoryLinks(paths, options),
    };
    const service = { policies: { read: async () => ({ mode: 'live', policyVersion: 1 }) },
        live: { resolve: async () => ({ entries: [
            { name: 'installed', enabled: true, sourcePath: skill },
            { name: 'authoring', enabled: true, sourcePath: orphan },
        ], diagnostics: [] }) } };
    const prepared = await installLiveSkills({ service, robot: { id: 'robot' }, policyId: 'policy', cwd, client });
    assert.equal(prepared.live, true);
    assert.equal(await fs.readFile(path.join(cwd, '.agents/skills/installed/SKILL.md'), 'utf8'), 'installed');
    await assert.rejects(fs.lstat(path.join(cwd, '.agents/skills/authoring')), { code: 'ENOENT' });
    assert.ok(prepared.diagnostics.some(entry => /authoring/.test(entry.message)));
});


test('bundled skills use the repository workspace path rather than the running code alias', async t => {
    const { copilotSkillsRoot } = await import('../server/copilot-skillset.mjs');
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'robot-builtin-install-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const cwd = path.join(root, 'robot');
    const source = path.join(root, 'AchillesCLI');
    const skill = path.join(source, 'roboTeamAgent/copilot/src/skills/bash');
    await fs.mkdir(cwd); await fs.mkdir(skill, { recursive: true });
    await fs.writeFile(path.join(skill, 'SKILL.md'), 'current bundled skill');
    const repository = { name: 'AchillesCLI', source, origin: 'workspace' };
    const options = { workspaceRoot: root, resolveRepository: () => repository };
    const client = { listRepositories: async () => [repository],
        install: async input => installRepositoryLinks(input, options),
        remove: async paths => removeRepositoryLinks(paths, options) };
    const service = { policies: { read: async () => ({ mode: 'live', policyVersion: 1 }) },
        live: { resolve: async () => ({ entries: [{ builtin: true, name: 'bash', enabled: true,
            sourcePath: path.join(copilotSkillsRoot, 'bash') }], diagnostics: [] }) } };
    await installLiveSkills({ service, robot: { id: 'default' }, policyId: 'policy', cwd, client });
    assert.equal(await fs.readFile(path.join(cwd, '.agents/skills/bash/SKILL.md'), 'utf8'), 'current bundled skill');
});
