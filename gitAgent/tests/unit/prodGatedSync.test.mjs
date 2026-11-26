import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { canSyncGit } from '../../IDE-plugins/git-tool-button/utils/git-sync-permission.mjs';

const required = ['git_pull', 'git_commit', 'git_push'];
const sdk = (names) => ({ getClient: () => ({ listTools: async () => names.map((name) => ({ name })) }) });

test('Sync requires all three tools in the filtered Router list', async () => {
    assert.equal(await canSyncGit(sdk(required)), true);
    for (const missing of required) {
        assert.equal(await canSyncGit(sdk(required.filter((name) => name !== missing))), false);
    }
    assert.equal(await canSyncGit({ getClient() { throw new Error('offline'); } }), false);
});

test('production-gated Git and skills editor tools retain the policy tag', async () => {
    const git = JSON.parse(await readFile(new URL('../../mcp-config.json', import.meta.url)));
    const explorer = JSON.parse(await readFile(new URL('../../../explorer/mcp-config.json', import.meta.url)));
    const names = [...required, 'git_branch_checkout', 'git_branch_create', 'git_branch_merge', 'git_restore', 'git_stash', 'git_stash_pop', 'git_checkout_conflict', 'git_resolve_conflict', 'git_clone_repository', 'git_submodule_add', 'git_init_repository', 'git_create_github_repository', 'git_remote_set'];
    for (const name of names) assert.ok(git.tools.find((tool) => tool.name === name)?.tags?.includes('prod-disabled'), name);
    for (const name of ['add_skills_manifest_repo', 'set_skills_manifest_skill_enabled', 'remove_skills_manifest_repo']) assert.ok(explorer.tools.find((tool) => tool.name === name)?.tags?.includes('prod-disabled'), name);
});

test('Git action controls follow the filtered tool list', async () => {
    const { createGitCommitUI } = await import('../../IDE-plugins/git-tool-button/components/git-panel/git-panel-ui.js');
    const updates = [];
    const state = { availableGitTools: [], repoOverviews: [], selectedFilesByRepo: {}, identityPrompt: {}, authPrompt: {} };
    const ui = createGitCommitUI({
        element: { querySelector: (selector) => selector === 'git-commit-actions' ? { webSkelPresenter: { setState: (value) => updates.push(value) } } : null },
        state,
    });
    ui.updateCommitButtons();
    assert.deepEqual(updates.at(-1).hiddenActions, ['commit', 'commitPush', 'push', 'stash', 'unstash', 'pull', 'pullRebase']);
    state.availableGitTools = ['git_commit', 'git_push', 'git_pull', 'git_stash', 'git_stash_pop'];
    ui.updateCommitButtons();
    assert.deepEqual(updates.at(-1).hiddenActions, []);
});
