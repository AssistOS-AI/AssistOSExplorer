import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveAlaInstallation } from '../roboTeamAgent/copilot/src/lib/alaInstallation.mjs';
import { createAnthropicSkillCatalog } from '../roboTeamAgent/copilot/src/lib/anthropicSkillCatalog.mjs';
import { setDisabledSkills } from '../roboTeamAgent/copilot/src/lib/achillesSettings.mjs';
import { writeSkill } from '../roboTeamAgent/copilot/tests/helpers/anthropicCatalogFixture.mjs';
import { AkuMemoryAdapter } from '../roboTeamAgent/copilot/src/lib/akuMemory/AkuMemoryAdapter.mjs';
import { getManagedRepoSkillRoot } from '../roboTeamAgent/copilot/src/lib/repoManager.mjs';

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
    });
    const ku = await adapter.createKU({ ku_name: 'Stored KU', summary: 'must stay unchanged' });
    const aku = await adapter.getAKU();
    assert.equal(aku.rootDir, selected);
    const before = await aku.loadKU(ku.ku_id);
    const moved = replaceDataRoot();

    await assert.rejects(() => adapter.resolveKUCandidates('Stored'), { code: 'ACHILLES_PRIVATE_PATH_UNSAFE' });
    await assert.rejects(() => adapter.updateKUState(ku.ku_id, { state: 'blocked' }), {
        code: 'ACHILLES_PRIVATE_PATH_UNSAFE',
    });
    await assert.rejects(() => aku.updateKUState(ku.ku_id, { state: 'also blocked' }), { code: 'AKU_PATH_ESCAPE' });
    fs.unlinkSync(path.join(workspace, '.data'));
    fs.renameSync(moved, path.join(workspace, '.data'));
    assert.deepEqual(await aku.loadKU(ku.ku_id), before);
});

test('AKU keeps the original storage workspace if environment hints later change', async (t) => {
    const { workspace, selected } = fixture(t);
    const adapter = new AkuMemoryAdapter({ rootDir: selected });
    process.env.PLOINKY_WORKSPACE_ROOT = selected;
    await adapter.initializeAKU();
    assert.equal(fs.statSync(path.join(workspace, '.data', 'achilles-cli', 'aku')).isDirectory(), true);
    assert.equal(fs.existsSync(path.join(selected, '.data')), false);
});

test('an older AKU implementation cannot silently write to its default project storage', async (t) => {
    const { workspace, selected } = fixture(t);
    const unexpected = path.join(selected, 'unexpected-aku');
    class LegacyAKU {
        async exists() { return false; }
        async initAKU() { fs.writeFileSync(unexpected, 'wrong root'); }
    }
    const adapter = new AkuMemoryAdapter({
        rootDir: selected, workspaceRoot: workspace, AgenticKnowledgeUnitsClass: LegacyAKU,
    });
    await assert.rejects(adapter.initializeAKU(), { code: 'AKU_PERSISTENCE_ROOT_UNSUPPORTED' });
    assert.equal(fs.existsSync(unexpected), false);
});

test('nested launches discover only managed Anthropic repositories and revalidate their storage root', async (t) => {
    const { workspace, selected, replaceDataRoot } = fixture(t);
    const reposRoot = getManagedRepoSkillRoot(selected);
    assert.equal(fs.existsSync(path.join(workspace, '.data')), false);
    const firstRepo = path.join(reposRoot, 'RepoA');
    writeSkill(firstRepo, 'skills/alpha', 'repo-alpha');
    writeSkill(path.join(workspace, '.data', 'other-agent'), 'skills/private', 'unrelated-private');
    writeSkill(path.join(workspace, '.data', 'achilles-cli', 'aku'), 'skills/private', 'not-a-repository');
    const { discoverTaskSkills } = await resolveAlaInstallation();
    const options = { workingDir: selected, roots: [reposRoot], discoverTaskSkills };
    const catalog = await createAnthropicSkillCatalog(options);
    assert.deepEqual(catalog.getSkills().map((skill) => skill.name), ['repo-alpha']);
    await setDisabledSkills(selected, ['repo-alpha']);
    const restarted = await createAnthropicSkillCatalog(options);
    assert.equal(restarted.getSkill('repo-alpha').enabled, false);
    writeSkill(path.join(reposRoot, 'RepoB'), 'skills/beta', 'repo-beta');
    await catalog.refresh();
    assert.equal(catalog.getSkill('repo-beta').enabled, true);
    assert.equal(catalog.getSkill('repo-alpha').enabled, false);
    fs.rmSync(firstRepo, { recursive: true });
    await catalog.refresh();
    assert.deepEqual(catalog.getSkills().map((skill) => skill.name), ['repo-beta']);
    assert.equal(fs.existsSync(path.join(selected, '.data')), false);
    replaceDataRoot();
    await assert.rejects(catalog.refresh(), { code: 'ACHILLES_PRIVATE_PATH_UNSAFE' });
});
