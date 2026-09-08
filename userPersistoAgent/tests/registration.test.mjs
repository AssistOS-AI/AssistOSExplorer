import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.PERSISTENCE_FOLDER = mkdtempSync(join(tmpdir(), 'userpersisto-registration-'));
process.env.USERPERSISTO_SETTINGS_KEY = 'test-settings-key';

const { ensureSeedData } = await import('../lib/bootstrap.mjs');
const { createUser, getSetupStatus, getUserByEmail, getUserRoles, registerUser, updateUser } = await import('../lib/users.mjs');
const { updateAuthPolicy } = await import('../lib/policy.mjs');
const { getUserCapabilities } = await import('../lib/authorization.mjs');
const { resetStoreForTests } = await import('../lib/store.mjs');

after(async () => {
    await resetStoreForTests();
});

test('external registrations cannot claim an empty installation or override the trusted registration option', async () => {
    await ensureSeedData();
    const attempts = await Promise.allSettled(Array.from({ length: 3 }, (_, index) => registerUser({
        email: `external-${index}@example.com`,
        password: 'external-pass-123',
        allowInitialAdmin: true,
    }, { allowInitialAdmin: false })));
    assert.ok(attempts.every((attempt) => attempt.status === 'rejected'
        && attempt.reason.code === 'initial_setup_required' && attempt.reason.statusCode === 403));
    assert.equal((await getSetupStatus()).userCount, 0);
});

test('concurrent first registrations create exactly one admin and later registrations receive dashboard-only access', async () => {
    await ensureSeedData();
    assert.equal((await getSetupStatus()).needsInitialAdmin, true);

    const firstWave = await Promise.all([
        registerUser({ email: 'owner-a@example.com', password: 'owner-pass-123' }),
        registerUser({ email: 'owner-b@example.com', password: 'owner-pass-123' }),
    ]);
    const firstWaveRoles = await Promise.all(firstWave.map((entry) => getUserRoles(entry.user.id)));
    assert.equal(firstWave.filter((entry) => entry.firstUser).length, 1);
    assert.equal(firstWaveRoles.filter((entry) => entry.includes('admin')).length, 1);
    assert.equal(firstWaveRoles.filter((entry) => entry.includes('selfRegistered')).length, 1);
    assert.ok(firstWave.every((entry) => entry.user.username === ''));
    assert.ok(firstWave.every((entry) => !Object.hasOwn(entry.user, 'passwordHash')));

    const later = await registerUser({ email: 'member@example.com', password: 'member-pass-123', username: 'admin' });
    assert.equal(later.firstUser, false);
    assert.equal(later.user.username, '');
    assert.deepEqual(await getUserRoles(later.user.id), ['selfRegistered']);
    assert.deepEqual(await getUserCapabilities(later.user.id), ['selfregistered.dashboard.access']);
    const owner = firstWave.find((entry) => entry.firstUser);
    assert.ok((await getUserCapabilities(owner.user.id)).includes('explorer.access'));
    assert.equal((await getSetupStatus()).needsInitialAdmin, false);
    assert.equal(Boolean(await getUserByEmail('owner-a@example.com')), true);
    assert.equal(Boolean(await getUserByEmail('owner-b@example.com')), true);
});

test('self-registration policy accepts only an existing non-admin role', async () => {
    await assert.rejects(
        () => updateAuthPolicy({ defaultRegistrationRole: 'admin' }, { actorId: 'test-admin' }),
        (error) => error?.code === 'registration_role_must_be_non_admin'
    );
    await assert.rejects(
        () => updateAuthPolicy({ defaultRegistrationRole: 'missing-role' }, { actorId: 'test-admin' }),
        (error) => error?.code === 'unknown_role'
    );

    await updateAuthPolicy({ defaultRegistrationRole: 'user' }, { actorId: 'test-admin' });
    const registered = await registerUser({ email: 'approved@example.com', password: 'approved-pass-123' });
    assert.deepEqual(await getUserRoles(registered.user.id), ['user']);
    assert.ok((await getUserCapabilities(registered.user.id)).includes('explorer.access'));
});

test('admin creation validates every role before persisting the user', async () => {
    await assert.rejects(
        () => createUser({ email: 'partial@example.com', roles: ['user', 'missing-role'] }),
        (error) => error?.code === 'unknown_role'
    );
    assert.equal(await getUserByEmail('partial@example.com'), null);
});

test('admin can change an email while uniqueness remains enforced', async () => {
    const first = await createUser({ email: 'before@example.com', roles: ['user'] });
    await createUser({ email: 'occupied@example.com', roles: ['user'] });

    const updated = await updateUser(first.id, { email: 'after@example.com' }, { actorId: 'test-admin' });
    assert.equal(updated.email, 'after@example.com');
    assert.equal(await getUserByEmail('before@example.com'), null);
    assert.equal((await getUserByEmail('after@example.com')).id, first.id);
    await assert.rejects(
        () => updateUser(first.id, { email: 'occupied@example.com' }, { actorId: 'test-admin' }),
        (error) => error?.code === 'email_taken'
    );
});
