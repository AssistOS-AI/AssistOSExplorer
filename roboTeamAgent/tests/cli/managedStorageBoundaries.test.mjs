import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AgenticKnowledgeUnits } from '../../achillesAgentLib/AgenticKnowledgeUnits/index.mjs';
import { MainAgent } from '../../achillesAgentLib/MainAgent/index.mjs';
import { AkuMemoryAdapter } from '../achilles-cli/src/lib/akuMemory/AkuMemoryAdapter.mjs';
import { getManagedRepoSkillRoot } from '../achilles-cli/src/lib/repoManager.mjs';

function fixture(t, selectedInsideData = false) {
    const workspace = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'achilles-managed-boundary-')));
    const selected = selectedInsideData
        ? path.join(workspace, '.data', 'achilles-cli', 'repos', 'project')
        : path.join(workspace, 'projects', 'selected');
    fs.mkdirSync(selected, { recursive: true });
    const previousWorkspace = process.env.PLOINKY_WORKSPACE_ROOT;
    process.env.PLOINKY_WORKSPACE_ROOT = workspace;
    t.after(() => {
        if (previousWorkspace === undefined) delete process.env.PLOINKY_WORKSPACE_ROOT;
        else process.env.PLOINKY_WORKSPACE_ROOT = previousWorkspace;
        fs.rmSync(workspace, { recursive: true, force: true });
    });
    const replaceDataRoot = () => {
        const moved = path.join(workspace, '.ploinky', 'unexpected-state');
        fs.mkdirSync(path.dirname(moved), { recursive: true });
        fs.renameSync(path.join(workspace, '.data'), moved);
        fs.symlinkSync(moved, path.join(workspace, '.data'));
        return moved;
    };
    return { workspace, selected, replaceDataRoot };
}

for (const cached of [false, true]) {
    test(`AKU revalidates a replaced .data ancestor before ${cached ? 'cached' : 'initial'} use`, async (t) => {
        const { workspace, selected, replaceDataRoot } = fixture(t, true);
        const adapter = new AkuMemoryAdapter({
            rootDir: selected,
            workspaceRoot: workspace,
            AgenticKnowledgeUnitsClass: AgenticKnowledgeUnits,
        });
        if (cached) await adapter.getAKU();
        const moved = replaceDataRoot();

        await assert.rejects(() => adapter.initializeAKU(), { code: 'ACHILLES_PRIVATE_PATH_UNSAFE' });
        assert.equal(fs.existsSync(path.join(moved, 'achilles-cli', 'aku')), false);
    });
}

test('an initialized AKU adapter rejects reads and mutations after the storage root moves', async (t) => {
    const { workspace, selected, replaceDataRoot } = fixture(t, true);
    const adapter = new AkuMemoryAdapter({
        rootDir: selected,
        workspaceRoot: workspace,
        AgenticKnowledgeUnitsClass: AgenticKnowledgeUnits,
    });
    const ku = await adapter.createKU({ ku_name: 'Stored KU', summary: 'must stay unchanged' });
    const aku = await adapter.getAKU();
    assert.equal(aku.rootDir, selected);
    const moved = replaceDataRoot();
    const stateFile = path.join(moved, 'achilles-cli', 'aku', 'kus', ku.ku_id, 'state.md');
    const before = fs.readFileSync(stateFile, 'utf8');

    await assert.rejects(() => adapter.resolveKUCandidates('Stored'), { code: 'ACHILLES_PRIVATE_PATH_UNSAFE' });
    await assert.rejects(() => adapter.updateKUState(ku.ku_id, { state: 'blocked' }), {
        code: 'ACHILLES_PRIVATE_PATH_UNSAFE',
    });
    await assert.rejects(() => aku.updateKUState(ku.ku_id, { state: 'also blocked' }), { code: 'AKU_PATH_ESCAPE' });
    assert.equal(fs.readFileSync(stateFile, 'utf8'), before);
});

test('AKU keeps the original storage workspace if environment hints later change', async (t) => {
    const { workspace, selected } = fixture(t);
    const adapter = new AkuMemoryAdapter({ rootDir: selected, AgenticKnowledgeUnitsClass: AgenticKnowledgeUnits });
    process.env.PLOINKY_WORKSPACE_ROOT = selected;
    await adapter.initializeAKU();
    assert.equal(fs.existsSync(path.join(workspace, '.data', 'achilles-cli', 'aku', 'aku.json')), true);
    assert.equal(fs.existsSync(path.join(selected, '.data')), false);
});

function writeSkill(root, name) {
    const directory = path.join(root, 'skills', name);
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, 'cskill.md'), `# ${name}\n\n## Description\n${name} skill.\n`);
    return directory;
}

test('nested launches discover managed repo skills at startup and on add/remove refresh', (t) => {
    const { workspace, selected, replaceDataRoot } = fixture(t);
    const reposRoot = getManagedRepoSkillRoot(selected);
    assert.equal(fs.existsSync(path.join(workspace, '.data')), false);
    const agent = new MainAgent({
        startDir: selected,
        additionalWorkspaceRoots: () => [getManagedRepoSkillRoot(selected)],
    });
    t.after(() => agent.shutdown());
    assert.equal(agent.startDir, selected);

    const firstRepo = path.join(reposRoot, 'RepoA');
    writeSkill(firstRepo, 'repo-alpha');
    writeSkill(path.join(workspace, '.data', 'other-agent'), 'unrelated-private');
    writeSkill(path.join(workspace, '.data', 'achilles-cli', 'aku'), 'not-a-repository');
    assert.deepEqual(agent.refreshSkills().added, ['repo-alpha-cskill']);
    assert.ok(agent.getSkillRecord('repo-alpha'));
    assert.equal(agent.getSkillRecord('unrelated-private'), null);
    assert.equal(agent.getSkillRecord('not-a-repository'), null);

    const restarted = new MainAgent({
        startDir: selected,
        additionalWorkspaceRoots: () => [getManagedRepoSkillRoot(selected)],
    });
    t.after(() => restarted.shutdown());
    assert.ok(restarted.getSkillRecord('repo-alpha'));
    agent.disableSkills(['repo-alpha']);
    writeSkill(path.join(reposRoot, 'RepoB'), 'repo-beta');
    assert.deepEqual(agent.refreshSkills().added, ['repo-beta-cskill']);
    assert.equal(agent.getSkillRecord('repo-alpha').enabled, false);
    fs.rmSync(firstRepo, { recursive: true });
    assert.deepEqual(agent.refreshSkills().removed, ['repo-alpha-cskill']);
    assert.equal(agent.getSkillRecord('repo-alpha'), null);
    assert.equal(fs.existsSync(path.join(selected, '.data')), false);

    replaceDataRoot();
    assert.throws(() => agent.refreshSkills(), { code: 'ACHILLES_PRIVATE_PATH_UNSAFE' });
});
