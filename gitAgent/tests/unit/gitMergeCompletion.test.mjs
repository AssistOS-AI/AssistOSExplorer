import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { createGitService } from '../../lib/git-service.mjs';
import { createGitOpsActions } from '../../IDE-plugins/git-tool-button/components/git-panel/git-panel-actions-gitops.js';
import { createGitCommitUI } from '../../IDE-plugins/git-tool-button/components/git-panel/git-panel-ui.js';
import { GitCommitActions } from '../../IDE-plugins/git-tool-button/components/git-commit-actions/git-commit-actions.js';

function runGit(args, cwd, { allowFailure = false } = {}) {
    const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
    if (!allowFailure && result.status !== 0) {
        throw new Error(result.stderr || result.stdout || `git ${args.join(' ')} failed`);
    }
    return result;
}

test('gitStatus reports a resolved pending merge and gitCommit can complete it with the existing message', async () => {
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), 'git-merge-completion-'));
    const repoDir = path.join(workspaceDir, 'repo');
    try {
        await fs.mkdir(repoDir, { recursive: true });
        runGit(['init'], repoDir);
        await fs.writeFile(path.join(repoDir, 'shared.txt'), 'base\n', 'utf8');
        runGit(['add', 'shared.txt'], repoDir);
        runGit(['-c', 'user.name=Test User', '-c', 'user.email=test@example.com', 'commit', '-m', 'base'], repoDir);
        const mainBranch = runGit(['branch', '--show-current'], repoDir).stdout.trim();

        runGit(['checkout', '-b', 'remote-change'], repoDir);
        await fs.writeFile(path.join(repoDir, 'shared.txt'), 'remote\n', 'utf8');
        runGit(['add', 'shared.txt'], repoDir);
        runGit(['-c', 'user.name=Test User', '-c', 'user.email=test@example.com', 'commit', '-m', 'remote change'], repoDir);

        runGit(['checkout', mainBranch], repoDir);
        await fs.writeFile(path.join(repoDir, 'shared.txt'), 'local\n', 'utf8');
        runGit(['add', 'shared.txt'], repoDir);
        runGit(['-c', 'user.name=Test User', '-c', 'user.email=test@example.com', 'commit', '-m', 'local change'], repoDir);
        const merge = runGit(['merge', 'remote-change'], repoDir, { allowFailure: true });
        assert.notEqual(merge.status, 0);

        await fs.writeFile(path.join(repoDir, 'shared.txt'), 'resolved\n', 'utf8');
        runGit(['add', 'shared.txt'], repoDir);

        const gitService = createGitService({ validatePath: async (value) => value });
        const pending = await gitService.gitStatus({ path: repoDir });
        assert.equal(pending.mergeInProgress, true);
        assert.equal(pending.mergeMessage, "Merge branch 'remote-change'");
        assert.equal(pending.status.conflicted.length, 0);
        assert.equal(pending.status.staged.some((entry) => entry?.path === 'shared.txt'), true);
        const overview = await gitService.gitReposOverview({ path: workspaceDir });
        const pendingOverview = overview.repos.find((repo) => repo.path === repoDir);
        assert.equal(pendingOverview?.mergeInProgress, true);
        assert.equal(pendingOverview?.mergeMessage, "Merge branch 'remote-change'");

        await assert.rejects(
            gitService.gitStash({ path: repoDir, includeUntracked: true }),
            /pending merge before stashing/i
        );
        await assert.rejects(
            gitService.gitStashPop({ path: repoDir }),
            /pending merge before restoring/i
        );
        assert.equal(runGit(['rev-parse', '--verify', '-q', 'MERGE_HEAD'], repoDir).status, 0);

        await gitService.gitCommit({
            path: repoDir,
            useExistingMessage: true,
            userName: 'Test User',
            userEmail: 'test@example.com'
        });

        const completed = await gitService.gitStatus({ path: repoDir });
        assert.equal(completed.mergeInProgress, false);
        assert.equal(completed.status.conflicted.length, 0);
        assert.equal(runGit(['rev-list', '--parents', '-n', '1', 'HEAD'], repoDir).stdout.trim().split(/\s+/).length, 3);
    } finally {
        await fs.rm(workspaceDir, { recursive: true, force: true });
    }
});

test('Explorer completes merges without dropping remaining selected changes', async () => {
    const source = await fs.readFile(new URL(
        '../../IDE-plugins/git-tool-button/components/git-panel/git-panel-actions-gitops.js',
        import.meta.url
    ), 'utf8');

    assert.match(source, /!message && !hasPendingMergeForRepos\(selected, state\)/);
    assert.doesNotMatch(source, /if \(completedMergeRepos\.has\(repoPath\)\) continue;/);
    assert.match(source, /const afterStage = parseJsonToolResult\(await service\.gitStatus\(repoPath\)\)/);
    assert.match(source, /if \(stagedPaths\.length\)/);
});

test('AutoSync continues after a successfully resolved pull conflict', async () => {
    const source = await fs.readFile(new URL(
        '../../IDE-plugins/git-tool-button/git-tool-button-controller.js',
        import.meta.url
    ), 'utf8');

    assert.match(source, /if \(isGitConflictError\(msg\)\)[\s\S]*?else if \(isGitPullBlockedError\(msg\)\)/);
    assert.match(source, /completePendingAutocommitMerge\(repoPath, status, rememberedIdentity\)/);
});

test('Explorer hides and rejects actions that would bypass or discard a pending merge', () => {
    const repoPath = '/workspace/repo';
    const state = {
        repoPath,
        reposRoot: '/workspace',
        repoInfoOk: true,
        repoOverviews: [{ path: repoPath, mergeInProgress: true, mergeMessage: "Merge branch 'remote-change'" }],
        selectedFilesByRepo: {
            [repoPath]: { files: new Set(['shared.txt']), prefixes: new Set() }
        },
        identityPrompt: { visible: false },
        authPrompt: { visible: false },
        commitMessage: ''
    };
    const actionStates = [];
    const ui = createGitCommitUI({
        element: {
            querySelector(selector) {
                if (selector === 'git-commit-actions') {
                    return { webSkelPresenter: { setState: (next) => actionStates.push(next) } };
                }
                return null;
            }
        },
        state,
        setMenuAbortController() {},
        selectConflictFile() {},
        closeModal() {}
    });

    ui.updateCommitButtons();
    assert.deepEqual(actionStates.at(-1).hiddenActions, ['push', 'stash', 'unstash']);
    assert.equal(actionStates.at(-1).commitMessage, "Merge branch 'remote-change'");
    assert.equal(state.commitMessage, "Merge branch 'remote-change'");

    const statuses = [];
    let stashCalls = 0;
    let unstashCalls = 0;
    const actions = createGitOpsActions({
        getState: () => state,
        getSelectedReposForBatch: () => [repoPath],
        closeActionsMenu() {},
        setStatusLine(message, isError = false) {
            statuses.push({ message, isError });
        },
        service: {},
        stashSelectedRepos() {
            stashCalls += 1;
        },
        unstashSelectedRepos() {
            unstashCalls += 1;
        }
    });

    actions.runGitAction(null, 'push');
    actions.runGitAction(null, 'stash');
    actions.runGitAction(null, 'unstash');

    assert.equal(stashCalls, 0);
    assert.equal(unstashCalls, 0);
    assert.deepEqual(statuses.map(({ message }) => message), [
        'Complete the pending merge before pushing.',
        'Complete the pending merge before stashing changes.',
        'Complete the pending merge before restoring a stash.'
    ]);
    assert.equal(statuses.every(({ isError }) => isError), true);
});

test('manual Commit and Commit & Push use the merge message shown in the editable field', async () => {
    const repoPath = '/workspace/repo';
    const commits = [];
    let pulls = 0;
    let pushes = 0;
    const state = {
        repoPath,
        reposRoot: '/workspace',
        repoInfoOk: true,
        repoOverviews: [{ path: repoPath, mergeInProgress: true, mergeMessage: "Merge branch 'remote-change'" }],
        selectedFilesByRepo: {
            [repoPath]: { files: new Set(['shared.txt']), prefixes: new Set() }
        },
        identityPrompt: { visible: false, name: 'Test User', email: 'test@example.com' },
        authPrompt: { visible: false },
        githubAuth: {},
        pullMode: 'merge',
        commitMode: 'commit',
        commitMessage: 'Edited merge message'
    };
    const actions = createGitOpsActions({
        getState: () => state,
        applyState() {},
        getSelectedReposForBatch: () => [repoPath],
        getPathsForCommitInRepo: () => ['shared.txt'],
        setStatusLine() {},
        updateCommitButtons() {},
        syncStaticUI() {},
        closeActionsMenu() {},
        clearPullBlockedState() {},
        hasConflictsForRepos: () => false,
        loadRepoOverviews: async () => {},
        refreshAfterGitOperation: async () => {},
        clearCommitMessageInput() {},
        withPanelLoader: async (operation) => operation(),
        ensureGitIdentityOrPrompt: async () => true,
        service: {
            async gitSetIdentity() {},
            async gitStatus() {
                return {
                    ok: true,
                    mergeInProgress: true,
                    mergeMessage: "Merge branch 'remote-change'",
                    status: {
                        staged: [{ path: 'shared.txt', x: 'M', y: ' ' }],
                        unstaged: [],
                        untracked: [],
                        conflicted: [],
                        ignored: []
                    }
                };
            },
            async gitStageExact() {},
            async gitCommit(payload) {
                commits.push(payload);
            },
            async gitInfo() {
                return { ok: true, remoteUrl: null };
            },
            async gitPush() {
                pushes += 1;
            },
            async gitPull() {
                pulls += 1;
            }
        }
    });

    await actions.commitSelectedRepos();
    state.commitMode = 'commitPush';
    await actions.commitSelectedRepos();

    assert.equal(pulls, 0);
    assert.equal(pushes, 1);
    assert.equal(commits.length, 2);
    assert.equal(commits.every((commit) => commit.message === 'Edited merge message'), true);
    assert.equal(commits.every((commit) => commit.useExistingMessage === undefined), true);
});

test('Git actions component removes pending-merge actions from the menu', () => {
    const items = ['commit', 'push', 'stash', 'unstash'].map((mode) => ({
        mode,
        hidden: false,
        getAttribute: () => `runGitAction ${mode}`
    }));
    const presenter = new GitCommitActions({}, () => {});
    presenter.actionsMenu = {
        style: {},
        querySelectorAll: () => items
    };

    presenter.setState({ hiddenActions: ['push', 'stash', 'unstash'] });

    assert.deepEqual(
        Object.fromEntries(items.map((item) => [item.mode, item.hidden])),
        { commit: false, push: true, stash: true, unstash: true }
    );
});
