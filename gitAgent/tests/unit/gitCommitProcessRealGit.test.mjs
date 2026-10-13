import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createGitService } from '../../lib/git-service.mjs';
import { createGitOpsActions } from '../../IDE-plugins/git-tool-button/components/git-panel/git-panel-actions-gitops.js';
import { pullWithAutoStashFlow, restoreStashFlow } from '../../IDE-plugins/git-tool-button/utils/git-auto-stash-flow.js';
import { createSelectionEntry } from '../../IDE-plugins/git-tool-button/components/git-panel/git-panel-selection.js';

const execute = promisify(execFile);
const git = async (cwd, ...args) => (await execute('git', args, { cwd })).stdout.trim();

for (const scenario of ['local-only', 'incoming-approved', 'incoming-aborted', 'no-selected-changes']) {
    test(`real Git commit process: ${scenario}`, async () => {
        const root = await fs.mkdtemp(path.join(os.tmpdir(), 'git-commit-process-'));
        try {
            const remote = path.join(root, 'remote.git');
            const seed = path.join(root, 'seed');
            const work = path.join(root, 'work');
            await git(root, 'init', '--bare', '--initial-branch=main', remote);
            await git(root, 'init', '--initial-branch=main', seed);
            await git(seed, 'config', 'user.name', 'Fixture');
            await git(seed, 'config', 'user.email', 'fixture@example.invalid');
            await fs.writeFile(path.join(seed, 'app.txt'), 'original\n');
            await git(seed, 'add', 'app.txt');
            await git(seed, 'commit', '-m', 'Initial');
            await git(seed, 'remote', 'add', 'origin', remote);
            await git(seed, 'push', '-u', 'origin', 'main');
            await git(root, 'clone', remote, work);
            await git(work, 'config', 'user.name', 'Fixture');
            await git(work, 'config', 'user.email', 'fixture@example.invalid');
            if (scenario.startsWith('incoming')) {
                await fs.writeFile(path.join(seed, 'remote.txt'), 'incoming\n');
                await git(seed, 'add', 'remote.txt');
                await git(seed, 'commit', '-m', 'Remote update');
                await git(seed, 'push');
            }
            const changed = scenario !== 'no-selected-changes';
            if (changed) await fs.writeFile(path.join(work, 'app.txt'), 'local change\n');
            const beforeHead = await git(work, 'rev-parse', 'HEAD');
            const beforeRemote = await git(remote, 'rev-parse', 'main');
            const beforeStatus = await git(work, 'status', '--porcelain');
            const backend = createGitService({ validatePath: async value => value });
            const events = [];
            const service = {
                gitStatus: (repoPath, options) => backend.gitStatus({ path: repoPath, ...options }),
                gitFetch: args => backend.gitFetch(args),
                gitInfo: repoPath => backend.gitInfo({ path: repoPath }),
                gitStash: async args => { events.push('stash'); return backend.gitStash(args); },
                gitStashPop: args => backend.gitStashPop(args),
                gitStageExact: async (repoPath, files) => { events.push('stage'); return backend.gitStageExact({ path: repoPath, files }); },
                gitCommit: async args => { events.push('commit'); return backend.gitCommit(args); },
                gitPush: async (args, options) => {
                    await options.beforeMutation();
                    events.push('push');
                    return backend.gitPush(args);
                }
            };
            const selection = createSelectionEntry();
            selection.files.add('app.txt');
            const state = {
                selectedFilesByRepo: { [work]: selection }, repoOverviews: [],
                commitMode: 'commitPush', pullMode: 'ffOnly', commitMessage: 'Publish selected change'
            };
            const messages = [];
            const actions = createGitOpsActions({
                getState: () => state, applyState: patch => Object.assign(state, patch), service,
                getSelectedReposForBatch: () => [work],
                setStatusLine: (message, error) => messages.push({ message, error }),
                updateRepoOverviewFromStatus() {}, updateCommitButtons() {}, syncStaticUI() {},
                clearPullBlockedState() {}, clearCommitMessageInput() {},
                hasConflictsForRepos: () => false, ensureGitIdentityOrPrompt: async () => true,
                withPanelLoader: operation => operation(), refreshAfterGitOperation: async () => {},
                async pullWithAutoStash(repoPath) {
                    const result = await pullWithAutoStashFlow({
                        service, repoPath,
                        async confirmStash() { events.push('consent'); return scenario !== 'incoming-aborted'; },
                        async gitPullWithToken() { events.push('pull'); await backend.gitPull({ path: repoPath, ffOnly: true }); },
                        restoreStash: (path, stashRef) => restoreStashFlow({ service, repoPath: path, stashRef })
                    });
                    return result.ok ? result : false;
                }
            });
            await actions.commitSelectedRepos();
            assert.ok(!messages.some(row => row.error), JSON.stringify(messages));
            if (scenario === 'incoming-aborted' || !changed) {
                assert.equal(await git(work, 'rev-parse', 'HEAD'), beforeHead);
                assert.equal(await git(remote, 'rev-parse', 'main'), beforeRemote);
                assert.equal(await git(work, 'status', '--porcelain'), beforeStatus);
                assert.equal(state.commitMessage, 'Publish selected change');
                assert.equal(state.selectedFilesByRepo[work], selection);
                assert.ok(!events.includes('stage') && !events.includes('commit') && !events.includes('push'));
                assert.ok(!events.includes('stash') && !events.includes('pull'));
            } else {
                assert.notEqual(await git(work, 'rev-parse', 'HEAD'), beforeHead);
                assert.equal(await git(remote, 'rev-parse', 'main'), await git(work, 'rev-parse', 'HEAD'));
                assert.equal(await git(work, 'status', '--porcelain'), '');
                assert.equal(await git(remote, 'show', 'main:app.txt'), 'local change');
                assert.deepEqual(Object.keys(state.selectedFilesByRepo), []);
                assert.equal(state.commitMessage, '');
                assert.deepEqual(events, scenario === 'local-only' ? ['stage', 'commit', 'push'] : ['consent', 'stash', 'pull', 'stage', 'commit', 'push']);
                assert.equal(finishedPullCount(messages), scenario === 'incoming-approved' ? 1 : 0);
                assert.equal(await git(work, 'stash', 'list'), '');
            }
        } finally {
            await fs.rm(root, { recursive: true, force: true });
        }
    });
}

function finishedPullCount(messages) {
    return messages.at(-1).message.includes('pulled the latest changes for 1 repository') ? 1 : 0;
}
