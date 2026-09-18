import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { requireWorkspaceRoot } from '../server/workspace-root.mjs';
import { resolveAchillesWorkspaceRoot } from '../copilot/src/lib/privateDataRoot.mjs';
import { collectPloinkyRepoSkillRoots } from '../copilot/src/lib/cliSkillRoots.mjs';

test('workspace configuration fails explicitly instead of falling back to cwd', t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'required-workspace-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    for (const value of [undefined, '', '  ']) {
        const env = { PLOINKY_WORKSPACE_ROOT: value };
        assert.throws(() => requireWorkspaceRoot(env), /PLOINKY_WORKSPACE_ROOT is required/);
        assert.throws(() => resolveAchillesWorkspaceRoot(root, env), /PLOINKY_WORKSPACE_ROOT is required/);
        assert.throws(() => collectPloinkyRepoSkillRoots(root, env), /PLOINKY_WORKSPACE_ROOT is required/);
    }
    assert.throws(() => requireWorkspaceRoot({ PLOINKY_WORKSPACE_ROOT: 'relative' }), /absolute/);
    assert.throws(() => requireWorkspaceRoot({ PLOINKY_WORKSPACE_ROOT: path.join(root, 'absent') }), /existing directory/);
    fs.writeFileSync(path.join(root, 'file'), 'data');
    assert.throws(() => requireWorkspaceRoot({ PLOINKY_WORKSPACE_ROOT: path.join(root, 'file') }), /existing directory/);
    assert.equal(requireWorkspaceRoot({ PLOINKY_WORKSPACE_ROOT: root }), fs.realpathSync(root));
    const project = path.join(root, 'project');
    fs.mkdirSync(project);
    assert.equal(resolveAchillesWorkspaceRoot(project, { PLOINKY_WORKSPACE_ROOT: root }), fs.realpathSync(root));
});


test('CLI context rejects missing workspace before creating robot data', async t => {
    const { prepareCopilotContext } = await import('../server/copilot-context.mjs');
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'missing-workspace-'));
    const previous = process.env.PLOINKY_WORKSPACE_ROOT;
    delete process.env.PLOINKY_WORKSPACE_ROOT;
    t.after(() => {
        if (previous !== undefined) process.env.PLOINKY_WORKSPACE_ROOT = previous;
        fs.rmSync(root, { recursive: true, force: true });
    });
    const dataDir = path.join(root, 'data');
    await assert.rejects(prepareCopilotContext('analyst', { dataDir, prepareTools: false }), /PLOINKY_WORKSPACE_ROOT is required/);
    assert.equal(fs.existsSync(dataDir), false);
});
