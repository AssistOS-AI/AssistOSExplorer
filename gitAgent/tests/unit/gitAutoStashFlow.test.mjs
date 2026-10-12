import assert from 'node:assert/strict';
import test from 'node:test';

import { pullWithAutoStashFlow } from '../../IDE-plugins/git-tool-button/utils/git-auto-stash-flow.js';

function localChangesStatus() {
    return {
        branch: 'main',
        upstream: 'origin/main',
        behind: 1,
        status: {
            staged: [],
            unstaged: [{ path: 'src/app.js' }],
            untracked: [],
            conflicted: []
        }
    };
}

test('auto-pull restores its stash before returning a pull error', async () => {
    const events = [];
    const result = await pullWithAutoStashFlow({
        service: {
            async gitStatus() {
                events.push('status');
                return localChangesStatus();
            },
            async gitFetch() {
                events.push('fetch');
                return { ok: true };
            },
            async gitStash() {
                events.push('stash');
                return { ok: true, created: true, ref: 'stash@{0}' };
            }
        },
        repoPath: '/workspace/repo',
        async confirmStash() {
            events.push('consent');
            return true;
        },
        async gitPullWithToken() {
            events.push('pull');
            throw new Error('provider unavailable');
        },
        async restoreStash(repoPath, stashRef) {
            events.push(`restore:${repoPath}:${stashRef}`);
            return { ok: true, conflicts: false };
        }
    });

    events.push('returned');
    assert.deepEqual(events, [
        'status',
        'fetch',
        'status',
        'consent',
        'status',
        'stash',
        'pull',
        'restore:/workspace/repo:stash@{0}',
        'returned'
    ]);
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'pull_error');
    assert.equal(result.rollback.ok, true);
});

test('a failed stash restore takes precedence over the original pull error', async () => {
    const result = await pullWithAutoStashFlow({
        service: {
            async gitStatus() {
                return localChangesStatus();
            },
            async gitFetch() { return { ok: true }; },
            async gitStash() {
                return { ok: true, created: true, ref: 'stash@{3}' };
            }
        },
        repoPath: '/workspace/repo',
        confirmStash: async () => true,
        async gitPullWithToken() {
            throw new Error('authentication failed');
        },
        async restoreStash() {
            return { ok: false, conflicts: true, message: 'Conflicts after restoring stashed changes.' };
        }
    });

    assert.equal(result.ok, false);
    assert.equal(result.reason, 'restore_failed');
    assert.equal(result.message, 'Conflicts after restoring stashed changes.');
    assert.equal(result.originalReason, 'auth');
    assert.equal(result.stashCreated, true);
    assert.equal(result.stashRef, 'stash@{3}');
    assert.equal(result.conflicts, true);
});

function createFlowFixture({ behind = 1, dirty = true, upstream = 'origin/main' } = {}) {
    const events = [];
    const status = localChangesStatus();
    status.behind = behind;
    status.upstream = upstream;
    if (!dirty) status.status.unstaged = [];
    const options = {
        repoPath: '/workspace/repo',
        service: {
            async gitStatus() { events.push('status'); return status; },
            async gitFetch() { events.push('fetch'); return { ok: true }; },
            async gitStash() { events.push('stash'); return { ok: true, created: true, ref: 'stash@{0}' }; }
        },
        async confirmStash(details) { events.push('consent'); assert.equal(details.behind, behind); return true; },
        async gitPullWithToken() { events.push('pull'); },
        async restoreStash() { events.push('restore'); return { ok: true }; }
    };
    return { events, status, options };
}

test('no incoming remote commits leaves dirty files and staging untouched', async () => {
    const fixture = createFlowFixture({ behind: 0 });
    const result = await pullWithAutoStashFlow(fixture.options);
    assert.equal(result.reason, 'up_to_date');
    assert.deepEqual(fixture.events, ['status', 'fetch', 'status']);
});

test('an incoming update with dirty files requires fresh explicit consent', async () => {
    const fixture = createFlowFixture();
    const result = await pullWithAutoStashFlow(fixture.options);
    assert.equal(result.ok, true);
    assert.deepEqual(fixture.events, ['status', 'fetch', 'status', 'consent', 'status', 'stash', 'pull', 'restore']);
});

test('abort and absent consent never stash or pull', async () => {
    for (const confirmStash of [undefined, async () => false, async () => 'stash']) {
        const fixture = createFlowFixture();
        fixture.options.confirmStash = confirmStash;
        const result = await pullWithAutoStashFlow(fixture.options);
        assert.equal(result.reason, 'aborted');
        assert.deepEqual(fixture.events, ['status', 'fetch', 'status']);
    }
});

test('a clean repository pulls incoming commits without stash or a dialog', async () => {
    const fixture = createFlowFixture({ dirty: false });
    assert.equal((await pullWithAutoStashFlow(fixture.options)).ok, true);
    assert.deepEqual(fixture.events, ['status', 'fetch', 'status', 'pull']);
});

test('no upstream does not fetch, pull or ask to stash', async () => {
    const fixture = createFlowFixture({ upstream: null });
    assert.equal((await pullWithAutoStashFlow(fixture.options)).reason, 'no_upstream');
    assert.deepEqual(fixture.events, ['status']);
});

test('unreachable remote and unknown incoming count fail closed', async () => {
    for (const mode of ['fetch', 'count']) {
        const fixture = createFlowFixture();
        if (mode === 'fetch') fixture.options.service.gitFetch = async () => { throw new Error('remote unavailable'); };
        else fixture.status.behind = null;
        const result = await pullWithAutoStashFlow(fixture.options);
        assert.equal(result.ok, false);
        assert.equal(result.reason, 'remote_check_failed');
        assert.ok(!fixture.events.includes('consent'));
        assert.ok(!fixture.events.includes('stash'));
        assert.ok(!fixture.events.includes('pull'));
    }
});

test('switching branches or closing the panel while approving never stashes', async () => {
    for (const mode of ['branch', 'closed']) {
        const fixture = createFlowFixture();
        let active = true;
        fixture.options.isActive = () => active;
        fixture.options.confirmStash = async () => {
            if (mode === 'branch') fixture.status.branch = 'different';
            else active = false;
            return true;
        };
        assert.equal((await pullWithAutoStashFlow(fixture.options)).ok, false);
        assert.ok(!fixture.events.includes('stash'));
        assert.ok(!fixture.events.includes('pull'));
    }
});

test('a stash failure stops before pull', async () => {
    const fixture = createFlowFixture();
    fixture.options.service.gitStash = async () => ({ ok: true, created: false });
    assert.equal((await pullWithAutoStashFlow(fixture.options)).reason, 'stash_failed');
    assert.ok(!fixture.events.includes('pull'));
});
