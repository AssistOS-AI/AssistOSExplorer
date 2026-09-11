import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.PERSISTENCE_FOLDER = mkdtempSync(join(tmpdir(), 'userpersisto-identity-'));
process.env.USERPERSISTO_SETTINGS_KEY = 'test-settings-key';
process.env.USERPERSISTO_DEV_BOOTSTRAP = 'true';

const bootstrap = await import('../lib/bootstrap.mjs');
const { ensureSeedData } = bootstrap;
const { getInstallationSetup } = await import('../lib/setup.mjs');
const users = await import('../lib/users.mjs');
const authz = await import('../lib/authorization.mjs');
const { resetStoreForTests } = await import('../lib/store.mjs');

after(async () => {
    await resetStoreForTests();
});

test('seed roles and capabilities match the product document', async () => {
    await ensureSeedData();
    const u = await users.createUser({ email: 'u1@x.com', displayName: 'U1', source: 'admin', roles: ['user'] });
    assert.deepEqual(await users.getUserRoles(u.id), ['user']);
    const caps = await authz.getUserCapabilities(u.id);
    assert.ok(caps.includes('explorer.access'));
    assert.ok(!caps.includes('admin.users.manage'));

    const decision = await authz.authorizeCapability({ userId: u.id, capability: 'admin.users.manage' });
    assert.equal(decision.allowed, false);

    await users.setUserRoles(u.id, ['admin']);
    const adminCaps = await authz.getUserCapabilities(u.id);
    assert.ok(adminCaps.includes('admin.users.manage'));
    assert.ok(adminCaps.includes('explorer.access'));
});

test('selfRegistered users lack explorer.access', async () => {
    const sr = await users.createUser({ email: 'sr@x.com', displayName: 'SR', source: 'self-registration', roles: ['selfRegistered'] });
    const caps = await authz.getUserCapabilities(sr.id);
    assert.deepEqual(caps.sort(), ['selfregistered.dashboard.access']);
});

test('no account is seeded, even with the development flag: setup waits for the first completed sign-in', async () => {
    assert.equal(typeof bootstrap.ensureDevAdmin, 'undefined');
    await ensureSeedData();
    assert.equal(await users.getUserByEmail('admin@dev.local'), null);
    assert.equal((await getInstallationSetup()).complete, false);
});

test('profile aggregates identity', async () => {
    const u = await users.getUserByEmail('u1@x.com');
    const profile = await authz.getProfile(u.id);
    assert.equal(profile.user.email, 'u1@x.com');
    assert.deepEqual(profile.roles, ['admin']);
    assert.equal(typeof profile.credits.balance, 'number');
});
