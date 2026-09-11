import test, { after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.PERSISTENCE_FOLDER = mkdtempSync(join(tmpdir(), 'userpersisto-registration-'));
process.env.USERPERSISTO_SETTINGS_KEY = 'test-settings-key';

const { ensureSeedData } = await import('../lib/bootstrap.mjs');
const { createUser, getUserByEmail, getUserById, getUserRoles, updateUser, listUsers } = await import('../lib/users.mjs');
const { updateAuthPolicy } = await import('../lib/policy.mjs');
const { getUserCapabilities } = await import('../lib/authorization.mjs');
const { getInstallationSetup } = await import('../lib/setup.mjs');
const { getStore, resetStoreForTests } = await import('../lib/store.mjs');
const { completeEmailSignIn, startEmailSignIn } = await import('../lib/auth/signIn.mjs');
const { createLoginRequest, prepareSsoHandoff } = await import('../lib/sso.mjs');
const setup = await import('./helpers/setup.mjs');

after(async () => {
    await resetStoreForTests();
});

async function freshStore() {
    await resetStoreForTests();
    process.env.PERSISTENCE_FOLDER = mkdtempSync(join(tmpdir(), 'userpersisto-registration-'));
    setup.resetAuthLimitsForTests();
    await ensureSeedData();
}

beforeEach(async () => {
    await freshStore();
    setup.clearAdministratorPassword();
    delete process.env.USERPERSISTO_SELF_REGISTRATION_ENABLED;
});

test('requesting a registration code creates no account and does not claim setup', async () => {
    const request = await createLoginRequest({ redirectUri: 'http://127.0.0.1/auth/callback' });
    const parent = { flow: 'sso', id: request.providerState, expiresAt: Date.parse(request.expiresAt) };
    const sent = [];
    await startEmailSignIn({ parent, browserProof: setup.newBrowserProof(), email: 'pending-owner@example.test', purpose: 'register',
        deliver: async (message) => { sent.push(message); return { delivered: true }; } });
    assert.equal(sent.length, 1);
    assert.equal(await getUserByEmail('pending-owner@example.test'), null);
    assert.equal((await getInstallationSetup()).complete, false);
});

test('concurrent mixed-method first completions create exactly one administrator and a durable setup record', async () => {
    const password = setup.configureAdministratorPassword();
    const outcomes = await Promise.all([
        setup.registerWithEmailCode('owner-a@example.test'),
        setup.registerWithEmailCode('owner-b@example.test'),
        setup.claimAdministrator(password),
    ]);
    const initial = outcomes.filter((outcome) => outcome.initialAdministrator);
    assert.equal(initial.length, 1, 'exactly one completion claims setup');
    const record = await getInstallationSetup();
    assert.equal(record.complete, true);
    assert.equal(record.initialAdministratorId, initial[0].user.id);
    const emailAccounts = outcomes.slice(0, 2).map((outcome) => outcome.user.id);
    for (const id of emailAccounts) {
        const roles = await getUserRoles(id);
        assert.ok(roles.length === 1 && ['admin', 'selfRegistered'].includes(roles[0]));
    }
    // The configured password always resolves the committed designated administrator.
    assert.equal(outcomes[2].user.id, record.initialAdministratorId);
    const administrators = [];
    for (const user of (await listUsers({ pageSize: 50 })).users) if (user.roles.includes('admin')) administrators.push(user.id);
    assert.deepEqual(administrators, [record.initialAdministratorId]);
});

test('later public signups receive exactly selfRegistered and no Explorer access', async () => {
    const first = await setup.registerWithEmailCode('first@example.test');
    assert.equal(first.initialAdministrator, true);
    assert.deepEqual(first.roles, ['admin']);
    assert.ok((await getUserCapabilities(first.user.id)).includes('explorer.access'));
    const later = await setup.registerWithEmailCode('later@example.test');
    assert.equal(later.initialAdministrator, false);
    assert.deepEqual(await getUserRoles(later.user.id), ['selfRegistered']);
    assert.deepEqual(await getUserCapabilities(later.user.id), ['selfregistered.dashboard.access']);
    assert.ok((await getUserByEmail('later@example.test')).emailVerifiedAt);
});

test('registration policy governs only later signup and cannot configure another default role', async () => {
    const first = await setup.registerWithEmailCode('policy-owner@example.test');
    await assert.rejects(updateAuthPolicy({ defaultRegistrationRole: 'user' }, { actorId: first.user.id }), { code: 'invalid_policy_field' });
    await assert.rejects(updateAuthPolicy({ enabledAuthMethods: ['password'] }, { actorId: first.user.id }), { code: 'invalid_auth_method' });
    process.env.USERPERSISTO_DEFAULT_REGISTRATION_ROLE = 'user';
    try {
        const later = await setup.registerWithEmailCode('ignores-env@example.test');
        assert.deepEqual(await getUserRoles(later.user.id), ['selfRegistered']);
    } finally { delete process.env.USERPERSISTO_DEFAULT_REGISTRATION_ROLE; }
    await updateAuthPolicy({ selfRegistrationEnabled: false }, { actorId: first.user.id, emailStatus: async () => ({ available: true }) });
    await assert.rejects(setup.registerWithEmailCode('closed@example.test'), { code: 'registration_disabled' });
    assert.equal(await getUserByEmail('closed@example.test'), null);
    // Returning sign-in still works while registration is disabled.
    const returning = await setup.signInWithEmailCode('policy-owner@example.test', { purpose: 'login' });
    assert.equal(returning.user.id, first.user.id);
});

test('a signup started while unclaimed is rechecked against policy when another completion claims first', async () => {
    // Before setup the first-owner path ignores the registration policy.
    process.env.USERPERSISTO_SELF_REGISTRATION_ENABLED = 'false';
    const request = await createLoginRequest({ redirectUri: 'http://127.0.0.1/auth/callback' });
    const parent = { flow: 'sso', id: request.providerState, expiresAt: Date.parse(request.expiresAt) };
    const browserProof = setup.newBrowserProof();
    let pending;
    await startEmailSignIn({ parent, browserProof, email: 'pending-signup@example.test', purpose: 'register',
        deliver: async (message) => { pending = message; return { delivered: true }; } });
    const owner = await setup.registerWithEmailCode('claims-first@example.test');
    assert.equal(owner.initialAdministrator, true);
    // Completion now takes the later-signup path, where registration is disabled.
    await assert.rejects(completeEmailSignIn({ parent, browserProof, code: pending.code, prepareHandoff: () => prepareSsoHandoff(request.providerState) }),
        { code: 'registration_disabled' });
    assert.equal(await getUserByEmail('pending-signup@example.test'), null);
    assert.equal((await getInstallationSetup()).initialAdministratorId, owner.user.id);
});

test('setup remains claimed after the administrator is blocked, demoted or deleted', async () => {
    const first = await setup.registerWithEmailCode('claimed-owner@example.test');
    const store = await getStore();
    await store.deleteUser(first.user.id);
    assert.equal((await getInstallationSetup()).complete, true);
    const next = await setup.registerWithEmailCode('after-removal@example.test');
    assert.equal(next.initialAdministrator, false);
    assert.deepEqual(await getUserRoles(next.user.id), ['selfRegistered']);
    // A restart does not reopen public ownership either.
    await resetStoreForTests();
    assert.equal((await getInstallationSetup()).initialAdministratorId, first.user.id);
    const afterRestart = await setup.registerWithEmailCode('after-restart@example.test');
    assert.deepEqual(await getUserRoles(afterRestart.user.id), ['selfRegistered']);
});

test('internal account creation validates every role before persisting the user', async () => {
    await assert.rejects(
        () => createUser({ email: 'partial@example.com', roles: ['user', 'missing-role'] }),
        (error) => error?.code === 'unknown_role'
    );
    assert.equal(await getUserByEmail('partial@example.com'), null);
});

test('direct sign-in email mutation is refused while other profile updates remain', async () => {
    const member = await createUser({ email: 'before@example.com', roles: ['user'], emailVerified: true });
    await assert.rejects(
        () => updateUser(member.id, { email: 'after@example.com' }, { actorId: 'test-admin' }),
        (error) => error?.code === 'email_change_unsupported'
    );
    assert.equal((await getUserById(member.id)).email, 'before@example.com');
    assert.equal(await getUserByEmail('after@example.com'), null);
    const updated = await updateUser(member.id, { email: 'BEFORE@example.com', displayName: 'Still Here', username: 'still-here' }, { actorId: 'test-admin' });
    assert.equal(updated.displayName, 'Still Here');
    assert.equal(updated.username, 'still-here');
    assert.ok((await getUserById(member.id)).emailVerifiedAt, 'verification is untouched');
});

test('account ids never resolve through the email index or the email-less administrator', async () => {
    const password = setup.configureAdministratorPassword();
    const admin = await setup.claimAdministrator(password);
    assert.equal(admin.user.email, '');
    assert.equal(await getUserById(''), null);
    assert.equal(await getUserById('member@example.test'), null);
    assert.equal(await getUserByEmail(''), null);
    assert.equal((await getUserById(admin.user.id)).id, admin.user.id);
});
