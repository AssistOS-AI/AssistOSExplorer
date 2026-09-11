import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ensureSeedData } from '../lib/bootstrap.mjs';
import { getStore, resetStoreForTests, flush } from '../lib/store.mjs';
import { createUser, updateUser } from '../lib/users.mjs';
import { runTool } from '../tools/registry.mjs';
import { googleIdentityKey, GOOGLE_ISSUER } from '../lib/externalIdentities.mjs';

async function fixture(work) {
    const folder = await mkdtemp(join(tmpdir(), 'userpersisto-google-profile-'));
    const saved = Object.fromEntries(Object.entries(process.env).filter(([name]) => name.startsWith('USERPERSISTO_') || name === 'PERSISTENCE_FOLDER'));
    process.env.PERSISTENCE_FOLDER = folder;
    process.env.USERPERSISTO_SETTINGS_KEY = 'isolated-profile-settings-key';
    try {
        await ensureSeedData();
        await work(await getStore());
    } finally {
        await resetStoreForTests();
        for (const name of Object.keys(process.env)) {
            if (name.startsWith('USERPERSISTO_') || name === 'PERSISTENCE_FOLDER') delete process.env[name];
        }
        Object.assign(process.env, saved);
        await rm(folder, { recursive: true, force: true });
    }
}

test('profile projects a linked Google label without exposing identity or transaction state', async () => fixture(async (store) => {
    const user = await createUser({ email: 'linked@gmail.com', roles: ['selfRegistered'] });
    const identity = { issuer: GOOGLE_ISSUER, subject: 'private-subject', userId: user.id };
    await store.createExternalIdentity({ ...identity, identityKey: googleIdentityKey(identity), createdAt: new Date().toISOString(), lastUsedAt: '' });
    await flush();
    const profile = await runTool('userpersisto_profile_get', {}, { actorUserId: user.id });
    assert.deepEqual(profile.authMethods, [{ type: 'google', name: 'Google' }]);
    assert.equal(profile.user.id, user.id);
    assert.deepEqual(profile.roles, ['selfRegistered']);
    assert.doesNotMatch(JSON.stringify(profile), /private-subject|identityKey|googleAuthTransaction|passwordHash/);
}));

test('Google status and policy source require current administrative capability and never return a secret', async () => fixture(async () => {
    const admin = await createUser({ email: 'admin@example.test', roles: ['admin'], password: 'existing-password' });
    const secondAdmin = await createUser({ email: 'backup@example.test', roles: ['admin'], password: 'backup-password' });
    const user = await createUser({ email: 'user@example.test', roles: ['user'] });
    process.env.USERPERSISTO_GOOGLE_CLIENT_ID = 'test-client';
    process.env.USERPERSISTO_GOOGLE_CLIENT_SECRET = 'private-secret-never-project';
    process.env.USERPERSISTO_GOOGLE_REDIRECT_URI = 'http://127.0.0.1:8080/base-agent-additional-server/userPersistoAgent/7000/service/auth/google/callback';
    process.env.USERPERSISTO_AUTH_METHODS = 'password';
    const status = await runTool('userpersisto_google_status', {}, { actorUserId: admin.id });
    assert.equal(status.secretPresent, true);
    assert.equal(status.enabled, false);
    assert.equal(status.available, false);
    assert.doesNotMatch(JSON.stringify(status), /private-secret-never-project/);
    const policy = await runTool('userpersisto_auth_policy_get', {}, { actorUserId: admin.id });
    assert.deepEqual(policy.environmentOverrides, ['USERPERSISTO_AUTH_METHODS']);
    await assert.rejects(() => runTool('userpersisto_google_status', {}, { actorUserId: user.id, actorRoles: ['admin'] }), { code: 'admin_required' });
    await updateUser(admin.id, { status: 'blocked' }, { actorId: secondAdmin.id });
    await assert.rejects(() => runTool('userpersisto_google_status', {}, { actorUserId: admin.id, actorRoles: ['admin'] }), { code: 'invalid_session' });
}));

test('user-list tool forwards global filters and counts without identity fields', async () => fixture(async (store) => {
    const admin = await createUser({ email: 'admin@example.test', roles: ['admin'] });
    const role = await store.getRoleByName('selfRegistered');
    for (let index = 0; index < 601; index++) {
        const user = await store.createUser({ email: `reader-${index}@example.test`, status: 'active', createdAt: new Date(index * 1000).toISOString(), passwordHash: 'private-hash' });
        await store.createUserRole({ key: `${user.id}:${role.id}`, userId: user.id, roleId: role.id });
    }
    await flush();
    const context = { actorUserId: admin.id };
    const defaults = await runTool('userpersisto_user_list', { excludeOnlyRole: 'selfRegistered', includeRoleCounts: true }, context);
    assert.equal(defaults.totalCount, 1);
    assert.equal(defaults.singleRoleCounts.selfRegistered, 601);
    const found = await runTool('userpersisto_user_list', { search: 'reader-600', pageSize: 1, includeRoleCounts: true }, context);
    assert.equal(found.users[0].email, 'reader-600@example.test');
    assert.equal(found.singleRoleCounts.selfRegistered, 601);
    assert.doesNotMatch(JSON.stringify(found), /private-hash|passwordHash|subject|identityKey/);
}));
