import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createGitService } from '../../lib/git-service.mjs';
import { pullWithAutoStashFlow, restoreStashFlow } from '../../IDE-plugins/git-tool-button/utils/git-auto-stash-flow.js';
import { requestPullStashConsent } from '../../IDE-plugins/git-tool-button/utils/git-pull-consent.js';
import { GitPullWarningModal } from '../../IDE-plugins/git-tool-button/components/git-pull-warning-modal/git-pull-warning-modal.js';
import { createGitOpsActions } from '../../IDE-plugins/git-tool-button/components/git-panel/git-panel-actions-gitops.js';

function git(cwd, ...args) {
    const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
    assert.equal(result.status, 0, result.error?.message || result.stderr || result.stdout);
    return result.stdout.trim();
}

async function withRepos(run) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'git-fetch-consent-'));
    try {
        const remote = path.join(root, 'remote.git');
        const source = path.join(root, 'source');
        const local = path.join(root, 'local');
        git(root, 'init', '--bare', '--initial-branch=main', remote);
        git(root, 'clone', remote, source);
        git(source, 'config', 'user.name', 'Test');
        git(source, 'config', 'user.email', 'test@example.com');
        await fs.writeFile(path.join(source, 'README.md'), 'initial\n');
        git(source, 'add', '.');
        git(source, 'commit', '-m', 'Initial');
        git(source, 'push', '-u', 'origin', 'main');
        git(root, 'clone', remote, local);
        git(local, 'config', 'user.name', 'Test');
        git(local, 'config', 'user.email', 'test@example.com');
        const canonicalRoot = await fs.realpath(root);
        const service = createGitService({ validatePath: async (value) => {
            const canonical = await fs.realpath(value);
            assert.ok(canonical.startsWith(canonicalRoot + path.sep));
            return canonical;
        } });
        await fs.writeFile(path.join(local, 'README.md'), 'staged\n');
        git(local, 'add', 'README.md');
        await fs.appendFile(path.join(local, 'README.md'), 'unstaged\n');
        await fs.writeFile(path.join(local, 'draft.txt'), 'untracked work\n');
        await run({ root, source, local, remote, service });
    } finally {
        await fs.rm(root, { recursive: true, force: true });
    }
}

async function snapshot(local) {
    return {
        head: git(local, 'rev-parse', 'HEAD'),
        index: git(local, 'diff', '--cached'),
        unstaged: git(local, 'diff'),
        status: git(local, 'status', '--porcelain'),
        stashes: git(local, 'stash', 'list'),
        draft: await fs.readFile(path.join(local, 'draft.txt'), 'utf8')
    };
}

async function remoteCommit(source, name = 'remote.txt') {
    await fs.writeFile(path.join(source, name), 'remote update\n');
    git(source, 'add', name);
    git(source, 'commit', '-m', 'Remote update');
    git(source, 'push');
}

test('fetch discovers a new remote commit without touching HEAD, index, files or stashes', async () => {
    await withRepos(async ({ source, local, service }) => {
        const before = await snapshot(local);
        await remoteCommit(source);
        assert.equal((await service.gitStatus({ path: local, includeAhead: true })).behind, 0);
        assert.equal((await service.gitFetch({ path: local })).ok, true);
        assert.equal((await service.gitStatus({ path: local, includeAhead: true })).behind, 1);
        assert.deepEqual(await snapshot(local), before);
    });
});

test('aborting an incoming update preserves the actual working tree and index', async () => {
    await withRepos(async ({ source, local, service }) => {
        const before = await snapshot(local);
        await remoteCommit(source);
        let prompts = 0;
        const result = await pullWithAutoStashFlow({
            repoPath: local,
            service: {
                gitStatus: (repoPath, options) => service.gitStatus({ path: repoPath, ...options }),
                gitFetch: service.gitFetch,
                gitStash: service.gitStash
            },
            confirmStash: async ({ behind }) => { prompts += 1; assert.equal(behind, 1); return false; },
            gitPullWithToken: () => assert.fail('Abort must not pull')
        });
        assert.equal(result.reason, 'aborted');
        assert.equal(prompts, 1);
        assert.deepEqual(await snapshot(local), before);
    });
});

test('approved stash/pull restores staged, unstaged and untracked work', async () => {
    await withRepos(async ({ source, local, service }) => {
        const before = await snapshot(local);
        await remoteCommit(source);
        const result = await pullWithAutoStashFlow({
            repoPath: local,
            service: {
                gitStatus: (repoPath, options) => service.gitStatus({ path: repoPath, ...options }),
                gitFetch: service.gitFetch,
                gitStash: service.gitStash
            },
            confirmStash: async () => true,
            gitPullWithToken: () => service.gitPull({ path: local, ffOnly: true }),
            restoreStash: (repoPath, stashRef) => restoreStashFlow({
                repoPath, stashRef, service: { gitStashPop: service.gitStashPop }
            })
        });
        assert.equal(result.ok, true, JSON.stringify(result));
        const after = await snapshot(local);
        assert.notEqual(after.head, before.head);
        assert.deepEqual({ ...after, head: before.head }, before);
        assert.equal(await fs.readFile(path.join(local, 'remote.txt'), 'utf8'), 'remote update\n');
    });
});

test('direct pull cannot enable implicit stash through merge.autoStash', async () => {
    await withRepos(async ({ source, local, service }) => {
        await remoteCommit(source, 'README.md');
        git(local, 'config', 'merge.autoStash', 'true');
        const before = await snapshot(local);
        await assert.rejects(() => service.gitPull({ path: local, ffOnly: false }), /would be overwritten|local changes/i);
        assert.deepEqual(await snapshot(local), before);
    });
});

test('fetch skips a branch without upstream and rejects a deleted remote branch', async () => {
    await withRepos(async ({ source, local, service }) => {
        git(local, 'branch', '--unset-upstream');
        assert.equal((await service.gitFetch({ path: local })).reason, 'no_upstream');
        git(local, 'branch', '--set-upstream-to=origin/main');
        git(source, 'push', 'origin', 'HEAD:other');
        // Delete the remote branch in the dedicated fixture's bare repository.
        const remote = git(source, 'remote', 'get-url', 'origin');
        git(remote, 'config', 'receive.denyDeleteCurrent', 'ignore');
        git(source, 'push', 'origin', '--delete', 'main');
        await assert.rejects(() => service.gitFetch({ path: local }), /remote ref|couldn't find/i);
    });
});

test('warning dismissal and Abort deny permission; only Stash & pull grants it', async () => {
    const original = globalThis.assistOS;
    try {
        for (const result of [null, {}, { policy: 'abort' }, { policy: 'stash' }]) {
            globalThis.assistOS = { UI: { async showModal(component, props) {
                assert.equal(component, 'git-pull-warning-modal');
                assert.equal(props.incoming, '2');
                assert.equal(decodeURIComponent(escape(atob(props.repoPath))), '/workspace/știri');
                return result;
            } } };
            assert.equal(await requestPullStashConsent({ repoPath: '/workspace/știri', behind: 2 }), result?.policy === 'stash');
        }
    } finally {
        globalThis.assistOS = original;
    }
});

test('warning presenter escapes repository paths and returns explicit choices', () => {
    const original = globalThis.assistOS;
    const results = [];
    const element = {
        closest() { return null; },
        addEventListener() {},
        removeEventListener() {},
        getAttribute(name) {
            return name === 'data-incoming' ? '2' : btoa('<img src=x onerror=alert(1)>');
        }
    };
    try {
        globalThis.assistOS = { UI: { closeModal(_element, result) { results.push(result.policy); } } };
        const modal = new GitPullWarningModal(element, () => {});
        assert.ok(!modal.repoPath.includes('<img'));
        modal.abort();
        modal.stashAndPull();
        assert.deepEqual(results, ['abort', 'stash']);
    } finally {
        globalThis.assistOS = original;
    }
});

test('fetch is a declared, auth-delegated MCP tool and the warning is registered', async () => {
    const config = JSON.parse(await fs.readFile(new URL('../../mcp-config.json', import.meta.url)));
    const fetchTool = config.tools.find((tool) => tool.name === 'git_fetch');
    assert.equal(fetchTool.env.TOOL_NAME, 'git_fetch');
    assert.equal(fetchTool.inputSchema.path.optional, false);
    assert.deepEqual(fetchTool.delegations[0].tools, ['dpu_secret_get']);
    const plugin = JSON.parse(await fs.readFile(new URL('../../IDE-plugins/git-tool-button/config.json', import.meta.url)));
    assert.equal(plugin.dependencies.find((item) => item.component === 'git-pull-warning-modal').presenter, 'GitPullWarningModal');
});

test('aborted pull stops Commit & Push and Sync before staging or creating commits', async () => {
    for (const action of ['commitSelectedRepos', 'syncSelectedRepos']) {
        const state = { commitMessage: 'Keep this draft', commitMode: 'commitPush', pullMode: 'ffOnly' };
        let checks = 0;
        const actions = createGitOpsActions({
            getState: () => state,
            applyState: (patch) => Object.assign(state, patch),
            getSelectedReposForBatch: () => ['/workspace/repo'],
            getPathsForCommitInRepo: () => ['README.md'],
            setStatusLine() {}, updateCommitButtons() {}, syncStaticUI() {}, clearPullBlockedState() {},
            hasConflictsForRepos: () => false,
            withPanelLoader: async (operation) => operation(),
            pullWithAutoStash: async () => { checks += 1; return false; },
            service: {
                gitStatus: async () => ({ ok: true, branch: 'main', upstream: 'origin/main', status: {
                    staged: [], unstaged: [{ path: 'README.md' }], untracked: [], conflicted: []
                } }),
                gitStageExact: async () => assert.fail('Abort must not stage'),
                gitCommit: async () => assert.fail('Abort must not commit'),
                gitPush: async () => assert.fail('Abort must not push'),
                gitPull: async () => assert.fail('Abort must not bypass the safe pull flow')
            }
        });
        await actions[action]();
        assert.equal(checks, 1);
        assert.equal(state.commitMessage, 'Keep this draft');
    }
});
