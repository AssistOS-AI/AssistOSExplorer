import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

const agentRoot = new URL('../../', import.meta.url);

async function readAgentFile(relativePath) {
    return fs.readFile(new URL(relativePath, agentRoot), 'utf8');
}

test('MCP config declares the git_submodule_add contract and secret delegation', async () => {
    const config = JSON.parse(await readAgentFile('mcp-config.json'));
    const tool = config.tools.find((entry) => entry.name === 'git_submodule_add');

    assert.ok(tool);
    assert.equal(tool.env.TOOL_NAME, 'git_submodule_add');
    assert.deepEqual(Object.keys(tool.inputSchema), ['path', 'name', 'remoteUrl']);
    assert.equal(tool.inputSchema.path.optional, false);
    assert.equal(tool.inputSchema.name.optional, false);
    assert.equal(tool.inputSchema.remoteUrl.optional, false);
    assert.deepEqual(tool.delegations[0].tools, ['dpu_secret_get']);
    assert.deepEqual(tool.delegations[0].scopes, ['secret:read']);
});

test('Add repository flow creates or initializes a repository and becomes a submodule inside a worktree', async () => {
    const menuSource = await readAgentFile('IDE-plugins/git-menu-contributions/menu-contributions.js');
    const modalSource = await readAgentFile('IDE-plugins/git-tool-button/components/git-add-repository-modal/git-add-repository-modal.js');
    const modalHtml = await readAgentFile('IDE-plugins/git-tool-button/components/git-add-repository-modal/git-add-repository-modal.html');

    assert.match(menuSource, /callGitTool\('git_info', \{ path: basePath \}\)/);
    assert.match(menuSource, /openAddRepositoryModal\(basePath, \{ submoduleMode \}\)/);
    assert.match(menuSource, /callGitTool\('git_submodule_add'/);
    assert.match(menuSource, /callGitTool\('git_create_github_repository'/);
    assert.match(menuSource, /callGitTool\('git_init_repository'/);
    assert.match(menuSource, /parseGithubTarget/);
    assert.match(menuSource, /beginRepositoryLoader\(\)/);
    assert.match(menuSource, /endRepositoryLoader\(\)/);
    assert.match(modalSource, /data-submoduleMode/);
    assert.match(modalSource, /Add Git submodule/);
    assert.match(modalSource, /selectTarget/);
    assert.match(modalSource, /remoteUrl/);
    assert.match(modalSource, /hideRepositoryLoader\(\)/);
    assert.match(modalHtml, /data-git-add-repository-title/);
    assert.match(modalHtml, /data-github-targets/);
    assert.match(modalHtml, /name="remoteUrl"/);
});

test('Clone repository flow clones or adds a submodule inside a worktree', async () => {
    const menuSource = await readAgentFile('IDE-plugins/git-clone-repository/menu-contributions.js');
    const modalSource = await readAgentFile('IDE-plugins/git-tool-button/components/git-clone-repository-modal/git-clone-repository-modal.js');
    const modalHtml = await readAgentFile('IDE-plugins/git-tool-button/components/git-clone-repository-modal/git-clone-repository-modal.html');

    assert.match(menuSource, /callGitTool\('git_info', \{ path: basePath \}\)/);
    assert.match(menuSource, /openCloneRepositoryModal\(basePath, \{ submoduleMode \}\)/);
    assert.match(menuSource, /callGitTool\('git_submodule_add'/);
    assert.match(menuSource, /callGitTool\('git_clone_repository'/);
    assert.match(menuSource, /beginRepositoryLoader\(\)/);
    assert.match(menuSource, /endRepositoryLoader\(\)/);
    assert.match(modalSource, /data-submoduleMode/);
    assert.match(modalSource, /Add Git submodule/);
    assert.match(modalSource, /selectRepository/);
    assert.match(modalSource, /setRemoteUrl/);
    assert.match(modalSource, /hideRepositoryLoader\(\)/);
    assert.match(modalHtml, /data-git-clone-repository-title/);
    assert.match(modalHtml, /data-github-repositories/);
    assert.match(modalHtml, /name="remoteUrl"/);
});

test('Explorer Git menus publish separate add and clone entries and lazy click activation', async () => {
    const addConfig = JSON.parse(await readAgentFile('IDE-plugins/git-menu-contributions/config.json'));
    const cloneConfig = JSON.parse(await readAgentFile('IDE-plugins/git-clone-repository/config.json'));
    const addSource = await readAgentFile('IDE-plugins/git-menu-contributions/menu-contributions.js');
    const cloneSource = await readAgentFile('IDE-plugins/git-clone-repository/menu-contributions.js');

    assert.equal(Object.hasOwn(addConfig, 'menuItems'), false);
    assert.equal(addConfig.presentation['file-exp:context-menu:file'].label, 'Add to .gitignore');
    assert.equal(addConfig.presentation['file-exp:new-menu'].label, 'Add new repository');
    assert.equal(cloneConfig.presentation['file-exp:new-menu'].label, 'Clone repository');
    assert.notEqual(addConfig.id, cloneConfig.id);
    assert.match(addSource, /export async function activateMenuItem/);
    assert.match(addSource, /context\?\.slot === 'file-exp:new-menu'/);
    assert.match(cloneSource, /export async function activateMenuItem/);
});

test('Git opens its modal without an Explorer-owned loader and keeps forced refresh local', async () => {
    const controllerSource = await readAgentFile('IDE-plugins/git-tool-button/git-tool-button-controller.js');
    const modalSource = await readAgentFile('IDE-plugins/git-tool-button/components/git-commit-modal/git-commit-modal.js');
    const openModalBlock = controllerSource.match(/async function openGitModal[\s\S]*?\n    }/)?.[0] || '';

    assert.doesNotMatch(openModalBlock, /fileExp\.withLoader/);
    assert.doesNotMatch(openModalBlock, /suppressGlobalLoader/);
    assert.match(openModalBlock, /syncConflictFlagFromRepos\(\)/);
    assert.match(modalSource, /withModalLoader\(async \(\) =>/);
    assert.match(modalSource, /refreshAll\(\{ force: true \}\)/);
});
