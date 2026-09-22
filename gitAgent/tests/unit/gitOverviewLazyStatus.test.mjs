import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { createGitService } from '../../lib/git-service.mjs';
import { createOverviewOps } from '../../lib/git/overview-ops.mjs';
import { DETAILED_STATUS_TIMEOUT_MS } from '../../lib/git/status-ops.mjs';
import { mergeRepoOverviewWithStatus } from '../../IDE-plugins/git-tool-button/components/git-panel/git-panel-status.js';

function runGit(args, cwd) {
    const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
    if (result.status !== 0) {
        throw new Error(result.stderr || result.stdout || `git ${args.join(' ')} failed`);
    }
    return result;
}

test('detailed status has a repository-scale timeout distinct from quick overview', () => {
    assert.equal(DETAILED_STATUS_TIMEOUT_MS, 120000);
});

test('repository overview stays compact and full status hydrates one repository', async () => {
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), 'git-overview-lazy-'));
    const repoDir = path.join(workspaceDir, 'large-repo');
    try {
        await fs.mkdir(repoDir, { recursive: true });
        runGit(['init'], repoDir);
        runGit(['config', 'user.name', 'Test User'], repoDir);
        runGit(['config', 'user.email', 'test@example.com'], repoDir);
        await fs.writeFile(path.join(repoDir, 'tracked.txt'), 'initial\n', 'utf8');
        runGit(['add', 'tracked.txt'], repoDir);
        runGit(['commit', '-m', 'initial'], repoDir);
        await fs.writeFile(path.join(repoDir, 'tracked.txt'), 'changed\n', 'utf8');
        await fs.writeFile(path.join(repoDir, 'new.txt'), 'new\n', 'utf8');
        runGit(['add', 'new.txt'], repoDir);

        const gitService = createGitService({ validatePath: async (value) => value });
        const overview = await gitService.gitReposOverview({ path: workspaceDir });
        const repoOverview = overview.repos.find((repo) => repo.path === repoDir);

        assert.equal(repoOverview?.dirty, true);
        assert.deepEqual(repoOverview?.counts, { staged: 1, unstaged: 1, untracked: 0, conflicted: 0 });
        assert.equal(repoOverview?.changesLoaded, false);
        assert.equal(Object.hasOwn(repoOverview, 'changesAll'), false);
        assert.equal(Object.hasOwn(repoOverview, 'changes'), false);

        const status = await gitService.gitStatus({ path: repoDir });
        const hydrated = mergeRepoOverviewWithStatus(repoOverview, status);
        assert.equal(hydrated.changesLoaded, true);
        assert.deepEqual(hydrated.changesAll.map((row) => row.path), ['new.txt', 'tracked.txt']);
        assert.equal(hydrated.changesAll.find((row) => row.path === 'new.txt')?.flags.staged, true);
        assert.equal(hydrated.changesAll.find((row) => row.path === 'tracked.txt')?.flags.unstaged, true);
    } finally {
        await fs.rm(workspaceDir, { recursive: true, force: true });
    }
});

test('repository overview keeps a repository loadable when its quick status fails', async () => {
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), 'git-overview-failure-'));
    const repoDir = path.join(workspaceDir, 'slow-repo');
    try {
        await fs.mkdir(path.join(repoDir, '.git'), { recursive: true });
        const ops = {
            async gitInfo() {
                return { ok: true, branch: 'main', ahead: 0, behind: 0 };
            },
            async gitStatusOverview() {
                throw new Error('quick status timed out');
            }
        };
        const overviewOps = createOverviewOps({ resolveRepoPath: async () => workspaceDir }, ops);
        const overview = await overviewOps.gitReposOverview({ path: workspaceDir });
        const repoOverview = overview.repos.find((repo) => repo.path === repoDir);

        assert.equal(repoOverview?.ok, true);
        assert.equal(repoOverview?.dirty, false);
        assert.equal(repoOverview?.statusUnavailable, true);
        assert.equal(repoOverview?.changesLoaded, false);
    } finally {
        await fs.rm(workspaceDir, { recursive: true, force: true });
    }
});
