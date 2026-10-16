import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { workspaceSkillSource } from '../server/skill-repository-source.mjs';

test('registered remote and managed skill sources prefer a workspace checkout, including worktrees', async t => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'robot-workspace-skills-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const local = path.join(root, 'LocalSkills');
    const managed = path.join(root, '.ploinky/repos/LocalSkills');
    const remote = 'https://example.com/LocalSkills.git';
    assert.equal(await workspaceSkillSource(remote, root), remote);
    await fs.mkdir(path.join(local, 'skills'), { recursive: true });
    assert.equal(await workspaceSkillSource(remote, root), remote);
    await fs.writeFile(path.join(local, '.git'), 'gitdir: /worktree');
    assert.equal(await workspaceSkillSource(remote, root), local);
    assert.equal(await workspaceSkillSource(managed, root), local);
    const other = path.join(root, 'explicit/LocalSkills');
    assert.equal(await workspaceSkillSource(other, root), other);
    await fs.symlink(local, path.join(root, 'Alias'));
    assert.equal(await workspaceSkillSource('https://example.com/Alias.git', root), 'https://example.com/Alias.git');
});
