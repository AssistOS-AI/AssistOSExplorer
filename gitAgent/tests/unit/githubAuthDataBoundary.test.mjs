import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

import { getGithubAuthStateFilePath, getGithubAuthStatus } from '../../lib/github-auth.mjs';

const authInfo = { user: { id: 'storage-test', roles: ['guest'] } };
const policyViolation = { code: 'PLOINKY_AGENT_DATA_POLICY_VIOLATION', statusCode: 422 };

async function createFixture(t) {
    const fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'git-auth-boundary-'));
    t.after(() => fs.rm(fixtureRoot, { recursive: true, force: true }));
    const workspaceRoot = path.join(fixtureRoot, 'workspace');
    const outsideRoot = path.join(fixtureRoot, 'outside');
    await fs.mkdir(workspaceRoot);
    await fs.mkdir(outsideRoot);
    return { workspaceRoot, outsideRoot, statePath: getGithubAuthStateFilePath(workspaceRoot, authInfo) };
}

for (const segments of [['.data'], ['.data', 'agents', 'gitAgent'], ['.data', 'agents', 'gitAgent', 'github-auth']]) {
    test(`Git auth rejects a symlink at ${segments.join('/')} without creating outside state`, async (t) => {
        const { workspaceRoot, outsideRoot } = await createFixture(t);
        const link = path.join(workspaceRoot, ...segments);
        await fs.mkdir(path.dirname(link), { recursive: true });
        await fs.writeFile(path.join(outsideRoot, 'sentinel'), 'untouched');
        await fs.symlink(outsideRoot, link);

        await assert.rejects(getGithubAuthStatus({ workspaceRoot, authInfo }), policyViolation);

        assert.deepEqual(await fs.readdir(outsideRoot), ['sentinel']);
        assert.equal(await fs.readFile(path.join(outsideRoot, 'sentinel'), 'utf8'), 'untouched');
        assert.equal((await fs.lstat(link)).isSymbolicLink(), true);
    });
}

for (const temporary of [false, true]) {
    test(`Git auth rejects a symlinked ${temporary ? 'temporary' : 'state'} file without replacing it`, async (t) => {
        const { workspaceRoot, outsideRoot, statePath } = await createFixture(t);
        const nonce = '6e6d493c-661c-4510-8383-cdbe6f7cd7d7';
        if (temporary) t.mock.method(crypto, 'randomUUID', () => nonce);
        const linkPath = temporary ? `${statePath}.${process.pid}.${nonce}.tmp` : statePath;
        const sentinel = path.join(outsideRoot, 'sentinel.json');
        const contents = JSON.stringify({ pending: { userCode: 'outside' }, connection: null });
        await fs.mkdir(path.dirname(statePath), { recursive: true });
        await fs.writeFile(sentinel, contents);
        await fs.symlink(sentinel, linkPath);

        await assert.rejects(getGithubAuthStatus({ workspaceRoot, authInfo }), policyViolation);

        assert.equal(await fs.readFile(sentinel, 'utf8'), contents);
        assert.equal((await fs.lstat(linkPath)).isSymbolicLink(), true);
        assert.deepEqual(await fs.readdir(outsideRoot), ['sentinel.json']);
    });
}

test('Git auth revalidates its data root after successful use and never consults retired state', async (t) => {
    const { workspaceRoot, outsideRoot, statePath } = await createFixture(t);
    const legacyRoot = path.join(workspaceRoot, '.ploinky', 'state');
    const legacyFile = path.join(legacyRoot, path.basename(statePath));
    await fs.mkdir(legacyRoot, { recursive: true });
    await fs.writeFile(legacyFile, 'retired auth state must stay untouched');

    const first = await getGithubAuthStatus({ workspaceRoot, authInfo });
    const second = await getGithubAuthStatus({ workspaceRoot, authInfo });
    assert.equal(first.ok, true);
    assert.deepEqual(first, second);
    assert.equal(first.pending, null);
    assert.equal(first.connected, false);
    const originalState = await fs.readFile(statePath, 'utf8');
    const movedData = path.join(outsideRoot, 'moved-data');
    await fs.rename(path.join(workspaceRoot, '.data'), movedData);
    await fs.symlink(movedData, path.join(workspaceRoot, '.data'));

    await assert.rejects(getGithubAuthStatus({ workspaceRoot, authInfo }), policyViolation);

    assert.equal(await fs.readFile(path.join(movedData, 'agents', 'gitAgent', 'github-auth', path.basename(statePath)), 'utf8'), originalState);
    assert.equal(await fs.readFile(legacyFile, 'utf8'), 'retired auth state must stay untouched');
    assert.deepEqual(await fs.readdir(legacyRoot), [path.basename(statePath)]);
});

test('Git auth uses independent temporary files for simultaneous status requests', async (t) => {
    const { workspaceRoot, statePath } = await createFixture(t);
    const statuses = await Promise.allSettled(Array.from({ length: 12 }, () => getGithubAuthStatus({ workspaceRoot, authInfo })));

    assert.deepEqual(statuses.filter((status) => status.status !== 'fulfilled'), []);
    assert.equal(statuses.every((status) => status.value.ok), true);
    assert.equal(JSON.parse(await fs.readFile(statePath, 'utf8')).pending, null);
    assert.deepEqual(await fs.readdir(path.dirname(statePath)), [path.basename(statePath)]);
});
