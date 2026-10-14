import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import { createGitOpsActions } from '../../IDE-plugins/git-tool-button/components/git-panel/git-panel-actions-gitops.js';
import { createSelectionEntry } from '../../IDE-plugins/git-tool-button/components/git-panel/git-panel-selection.js';

function deferred() {
    let resolve;
    const promise = new Promise(done => { resolve = done; });
    return { promise, resolve };
}

function waitForStatusRequest(started, operation) {
    return Promise.race([started.promise, operation.then(() => {
        throw new Error('Operation completed before requesting the expected status.');
    })]);
}

function fixture({ changed = ['src/app.js'], chosen = ['src/app.js'], mode = 'commitPush', pulled = false } = {}) {
    const repoPath = '/workspace/repo';
    const selection = createSelectionEntry();
    chosen.forEach(file => selection.files.add(file));
    const state = {
        repoPath, commitMode: mode, pullMode: 'ffOnly', commitMessage: 'Keep this draft',
        selectedFilesByRepo: { [repoPath]: selection },
        repoOverviews: [{ path: repoPath, dirty: true, counts: { unstaged: changed.length }, changesLoaded: false }]
    };
    const events = [];
    const messages = [];
    const staged = new Map();
    const changes = new Map([[repoPath, changed]]);
    const currentStatus = path => ({
        ok: true, branch: 'main', upstream: 'origin/main', ahead: 0, behind: 0,
        status: {
            staged: (staged.get(path) || []).map(file => ({ path: file })),
            unstaged: (changes.get(path) || []).map(file => ({ path: file })),
            untracked: [], conflicted: [], ignored: [{ path: 'ignored.txt' }]
        }
    });
    const service = {
        async gitStatus(path, options) {
            events.push(options?.includeAhead ? 'remote-status' : 'complete-status');
            return currentStatus(path);
        },
        async gitStageExact(path, files) { events.push('stage'); staged.set(path, files); },
        async gitCommit({ path }) { events.push('commit'); staged.set(path, []); changes.set(path, []); },
        async gitPush() { events.push('push'); },
        async gitInfo() { return { ok: true, remoteUrl: '' }; }
    };
    const ctx = {
        getState: () => state,
        applyState: patch => Object.assign(state, patch),
        service,
        setStatusLine: (message, error) => messages.push({ message, error }),
        getSelectedReposForBatch: () => Object.keys(state.selectedFilesByRepo),
        getPathsForCommitInRepo() { throw new Error('Commit must not depend on the display cache.'); },
        loadRepoOverviews() { throw new Error('Commit must not start a background overview refresh.'); },
        updateRepoOverviewFromStatus() {},
        hasConflictsForRepos: () => false,
        clearPullBlockedState() {},
        syncStaticUI() {}, updateCommitButtons() {}, clearCommitMessageInput() {},
        ensureGitIdentityOrPrompt: async () => true,
        pullWithAutoStash: async () => { events.push('remote-check'); return { ok: true, pulled }; },
        refreshAfterGitOperation: async () => { events.push('refresh'); },
        withPanelLoader: operation => operation(),
        getAheadCountForRepo: async () => 1,
        setCommitMessage: message => { state.commitMessage = message; },
        generateCommitMessageForSelections: async () => 'Generated message',
        dispatchAutocommitReset() {}, dispatchAutocommitStop() {}
    };
    return { repoPath, state, selection, service, ctx, events, messages, staged, changes, currentStatus };
}

test('commit awaits complete status, ignores lazy display data, then stages, commits and pushes', async () => {
    const f = fixture();
    const started = deferred();
    const response = deferred();
    const originalStatus = f.service.gitStatus;
    f.service.gitStatus = async (path, options) => {
        if (options?.includeAhead) return originalStatus(path, options);
        f.service.gitStatus = originalStatus;
        started.resolve();
        return response.promise;
    };
    const pending = createGitOpsActions(f.ctx).commitSelectedRepos();
    await waitForStatusRequest(started, pending);
    assert.deepEqual(f.events, ['remote-status', 'remote-check']);
    assert.equal(f.state.commitMessage, 'Keep this draft');
    assert.equal(f.state.selectedFilesByRepo[f.repoPath], f.selection);
    // A concurrent UI refresh has no file details; the operation owns its status.
    f.state.repoOverviews = [{ path: f.repoPath, changesLoaded: false }];
    response.resolve(f.currentStatus(f.repoPath));
    await pending;
    assert.deepEqual(f.events, ['remote-status', 'remote-check', 'stage', 'complete-status', 'commit', 'push', 'refresh']);
    assert.match(f.messages.at(-1).message, /committed 1 file.*pushed 1 commit/);
    assert.doesNotMatch(f.messages.at(-1).message, /pulled the latest/);
    assert.deepEqual(f.state.selectedFilesByRepo, {});
    assert.equal(f.state.commitMessage, '');
});

test('commit waits for the staged-status response before executing Git commit', async () => {
    const f = fixture();
    const started = deferred();
    const response = deferred();
    const original = f.service.gitStatus;
    f.service.gitStatus = async (path, options) => {
        if (f.events.includes('stage')) { started.resolve(); return response.promise; }
        return original(path, options);
    };
    const pending = createGitOpsActions(f.ctx).commitSelectedRepos();
    await waitForStatusRequest(started, pending);
    assert.ok(!f.events.includes('commit') && !f.events.includes('push'));
    response.resolve(f.currentStatus(f.repoPath));
    await pending;
    assert.ok(f.events.includes('commit') && f.events.includes('push'));
});

test('selection is captured before remote preparation and cannot expand during loading', async () => {
    const f = fixture({ changed: ['src/app.js', 'unselected.js'] });
    f.ctx.pullWithAutoStash = async () => {
        f.selection.files.add('unselected.js');
        return { ok: true, pulled: false };
    };
    let submitted;
    f.service.gitStageExact = async (path, files) => { submitted = files; f.staged.set(path, files); };
    await createGitOpsActions(f.ctx).commitSelectedRepos();
    assert.deepEqual(submitted, ['src/app.js']);
});

test('folder/all selection uses full status, exclusions and no ignored paths or 800-row UI limit', async () => {
    const changed = Array.from({ length: 1100 }, (_, index) => `src/file-${index}.js`);
    const f = fixture({ changed, chosen: [] });
    f.selection.prefixes.add('*');
    f.selection.excludedFiles.add('src/file-0.js');
    let submitted;
    f.service.gitStageExact = async (path, files) => { submitted = files; f.staged.set(path, files); };
    await createGitOpsActions(f.ctx).commitSelectedRepos();
    assert.equal(submitted.length, 1099);
    assert.ok(!submitted.includes('src/file-0.js') && !submitted.includes('ignored.txt'));
});

test('no selected changes preserves draft and selection without a false success or push', async () => {
    for (const mode of ['commit', 'commitPush']) {
        const f = fixture({ changed: [], mode });
        await createGitOpsActions(f.ctx).commitSelectedRepos();
        assert.ok(!f.events.includes('stage') && !f.events.includes('commit') && !f.events.includes('push'));
        assert.equal(f.state.commitMessage, 'Keep this draft');
        assert.equal(f.state.selectedFilesByRepo[f.repoPath], f.selection);
        assert.match(f.messages.at(-1).message, /No selected changes to commit/);
        assert.doesNotMatch(f.messages.at(-1).message, /finished|pulled the latest/);
    }
});

test('failed or incomplete complete-status response stops before mutation and keeps input', async () => {
    for (const payload of [{ ok: false, error: 'Status failed' }, { ok: true }, { ok: true, status: { staged: [] } }]) {
        const f = fixture();
        const original = f.service.gitStatus;
        f.service.gitStatus = (path, options) => options?.includeAhead ? original(path, options) : payload;
        await createGitOpsActions(f.ctx).commitSelectedRepos();
        assert.equal(f.messages.at(-1).error, true);
        assert.ok(!f.events.includes('stage') && !f.events.includes('commit'));
        assert.equal(f.state.commitMessage, 'Keep this draft');
        assert.equal(f.state.selectedFilesByRepo[f.repoPath], f.selection);
    }
});

test('all selected repositories must finish preparation before the first stage', async () => {
    const f = fixture();
    const second = '/workspace/second';
    f.state.selectedFilesByRepo[second] = createSelectionEntry();
    f.state.selectedFilesByRepo[second].files.add('second.txt');
    f.changes.set(second, ['second.txt']);
    const started = deferred();
    const response = deferred();
    const original = f.service.gitStatus;
    f.service.gitStatus = async (repoPath, options) => {
        if (repoPath === second && !options?.includeAhead) {
            started.resolve();
            return response.promise;
        }
        return original(repoPath, options);
    };
    const pending = createGitOpsActions(f.ctx).commitSelectedRepos();
    await waitForStatusRequest(started, pending);
    assert.ok(!f.events.includes('stage'));
    response.resolve({ ok: false, error: 'Second repository status failed' });
    await pending;
    assert.ok(!f.events.includes('stage') && !f.events.includes('commit') && !f.events.includes('push'));
    assert.equal(f.messages.at(-1).error, true);
    assert.equal(Object.keys(f.state.selectedFilesByRepo).length, 2);
    assert.equal(f.state.commitMessage, 'Keep this draft');
});

test('failed commit or push retains input and does not report successful completion', async () => {
    for (const operation of ['gitCommit', 'gitPush']) {
        const f = fixture();
        f.service[operation] = async () => { throw new Error('Operation failed'); };
        await createGitOpsActions(f.ctx).commitSelectedRepos();
        assert.equal(f.messages.at(-1).error, true);
        assert.doesNotMatch(f.messages.at(-1).message, /finished/);
        assert.equal(f.state.commitMessage, 'Keep this draft');
        assert.equal(f.state.selectedFilesByRepo[f.repoPath], f.selection);
    }
});

test('closing the panel during complete status never resumes stage/commit/push', async () => {
    const f = fixture();
    let active = true;
    f.ctx.isActive = () => active;
    const original = f.service.gitStatus;
    f.service.gitStatus = async (path, options) => {
        if (!options?.includeAhead) active = false;
        return original(path, options);
    };
    await createGitOpsActions(f.ctx).commitSelectedRepos();
    assert.ok(!f.events.includes('stage') && !f.events.includes('commit') && !f.events.includes('push'));
});

test('partial batch clears only committed repositories and keeps the remaining draft', async () => {
    const f = fixture();
    const second = '/workspace/second';
    f.state.selectedFilesByRepo[second] = createSelectionEntry();
    f.state.selectedFilesByRepo[second].files.add('unchanged.txt');
    await createGitOpsActions(f.ctx).commitSelectedRepos();
    assert.deepEqual(Object.keys(f.state.selectedFilesByRepo), [second]);
    assert.equal(f.state.commitMessage, 'Keep this draft');
    assert.match(f.messages.at(-1).message, /skipped 1 repository/);
});

test('sync also derives its commit selection from awaited status rather than display rows', async () => {
    const f = fixture();
    await createGitOpsActions(f.ctx).syncSelectedRepos();
    assert.ok(f.events.includes('stage') && f.events.includes('commit') && f.events.includes('push'));
    assert.match(f.messages.at(-1).message, /Sync finished.*committed 1 file/);
    assert.doesNotMatch(f.messages.at(-1).message, /pulled the latest/);
});

test('pull accounting counts executed pulls, not fetch-only checks or merge completion', async () => {
    for (const pulled of [false, true]) {
        const f = fixture({ pulled });
        const result = await createGitOpsActions(f.ctx).pullRepos([f.repoPath]);
        assert.equal(result.pulledRepos, pulled ? 1 : 0);
    }
    const f = fixture();
    f.service.gitStatus = async () => ({ ...f.currentStatus(f.repoPath), mergeInProgress: true });
    const merge = await createGitOpsActions(f.ctx).pullRepos([f.repoPath]);
    assert.equal(merge.pulledRepos, 0);
    assert.deepEqual(merge.completedMergeRepos, [f.repoPath]);
});

test('the panel pull adapter retains the structured no-pull outcome', async () => {
    const source = (await fs.readFile(new URL('../../IDE-plugins/git-tool-button/components/git-panel/git-panel-actions-autostash.js', import.meta.url), 'utf8'))
        .replace(/^import[\s\S]*?from [^;]+;\n/gm, '')
        .replace('export function createAutoStashActions', 'function createAutoStashActions');
    const result = { ok: true, pulled: false, reason: 'up_to_date' };
    const factory = vm.runInNewContext(`${source}\ncreateAutoStashActions;`, {
        pullWithAutoStashFlow: async () => result,
        requestPullStashConsent() {}
    });
    const actions = factory({ setStatusLine() {} });
    assert.equal(await actions.pullWithAutoStash('/workspace/repo'), result);
});
