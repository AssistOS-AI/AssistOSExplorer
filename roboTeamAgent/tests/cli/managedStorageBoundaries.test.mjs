import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveAlaInstallation } from '../roboTeamAgent/copilot/src/lib/alaInstallation.mjs';
import { createAnthropicSkillCatalog } from '../roboTeamAgent/copilot/src/lib/anthropicSkillCatalog.mjs';
import { setDisabledSkills } from '../roboTeamAgent/copilot/src/lib/achillesSettings.mjs';
import { writeSkill } from '../roboTeamAgent/copilot/tests/helpers/anthropicCatalogFixture.mjs';
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

test('nested launches discover only managed Anthropic repositories and revalidate their storage root', async (t) => {
    const { workspace, selected, replaceDataRoot } = fixture(t);
    const reposRoot = getManagedRepoSkillRoot(selected);
    assert.equal(fs.existsSync(path.join(workspace, '.data')), false);
    const firstRepo = path.join(reposRoot, 'RepoA');
    writeSkill(firstRepo, 'skills/alpha', 'repo-alpha');
    writeSkill(path.join(workspace, '.data', 'other-agent'), 'skills/private', 'unrelated-private');
    writeSkill(path.join(workspace, '.data', 'achilles-cli', 'private-state'), 'skills/private', 'not-a-repository');
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
