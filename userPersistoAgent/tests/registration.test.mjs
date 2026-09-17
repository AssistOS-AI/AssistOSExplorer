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
const { completeSignup, startSignup } = await import('../lib/auth/signup.mjs');
const { loginWithUserPassword } = await import('../lib/auth/userPassword.mjs');
const { createLoginRequest, prepareSsoHandoff } = await import('../lib/sso.mjs');
const { completeGoogleIdentity, GOOGLE_ISSUER } = await import('../lib/externalIdentities.mjs');
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
    delete process.env.USERPERSISTO_SELF_REGISTRATION_ENABLED;
    delete process.env.USERPERSISTO_AUTH_METHODS;
});

async function stagedSignup(email) {
    const request = await createLoginRequest({ redirectUri: 'http://127.0.0.1/auth/callback' });
    const parent = { flow: 'sso', id: request.providerState, expiresAt: Date.parse(request.expiresAt) };
    const browserProof = setup.newBrowserProof();
    const secret = setup.newTestPassword();
    const sent = [];
    await startSignup({ parent, browserProof, email, password: secret, passwordConfirmation: secret,
        deliver: async (message) => { sent.push(message); return { delivered: true }; } });
    return { request, parent, browserProof, sent, secret };
}

test('a pending password signup creates no account and does not claim setup', async () => {
    const pending = await stagedSignup('pending-owner@example.test');
    assert.equal(pending.sent.length, 1);
    assert.equal(await getUserByEmail('pending-owner@example.test'), null);
    assert.equal((await getInstallationSetup()).complete, false);
});

test('concurrent mixed-method first completions create exactly one administrator and a durable setup record', async () => {
    const outcomes = await Promise.all([
        setup.signUpWithPassword('owner-a@example.test'),
        setup.signUpWithPassword('owner-b@example.test'),
        completeGoogleIdentity({
            identity: { issuer: GOOGLE_ISSUER, subject: 'first-google-owner', email: 'owner-c@gmail.com', emailVerified: true },
            transactionId: 'first-google-completion',
        }),
    ]);
    const initial = outcomes.filter((outcome) => outcome.initialAdministrator);
    assert.equal(initial.length, 1, 'exactly one completion claims setup');
    const record = await getInstallationSetup();
    assert.equal(record.complete, true);
    assert.equal(record.initialAdministratorId, initial[0].user.id);
    for (const { user: { id } } of outcomes) {
        const roles = await getUserRoles(id);
        assert.ok(roles.length === 1 && ['admin', 'selfRegistered'].includes(roles[0]));
    }
    assert.equal(new Set(outcomes.map((outcome) => outcome.user.id)).size, 3);
    const administrators = [];
    for (const user of (await listUsers({ pageSize: 50 })).users) if (user.roles.includes('admin')) administrators.push(user.id);
    assert.deepEqual(administrators, [record.initialAdministratorId]);
});

test('later public signups receive exactly selfRegistered and no Explorer access', async () => {
    const first = await setup.signUpWithPassword('first@example.test');
    assert.equal(first.initialAdministrator, true);
    assert.deepEqual(first.roles, ['admin']);
    assert.ok((await getUserCapabilities(first.user.id)).includes('explorer.access'));
    const later = await setup.signUpWithPassword('later@example.test');
    assert.equal(later.initialAdministrator, false);
    assert.deepEqual(await getUserRoles(later.user.id), ['selfRegistered']);
    assert.deepEqual(await getUserCapabilities(later.user.id), ['selfregistered.dashboard.access']);
    assert.ok((await getUserByEmail('later@example.test')).emailVerifiedAt);
});

test('registration policy governs only later signup and cannot configure another default role', async () => {
    const first = await setup.signUpWithPassword('policy-owner@example.test');
    await assert.rejects(updateAuthPolicy({ defaultRegistrationRole: 'user' }, { actorId: first.user.id }), { code: 'invalid_policy_field' });
    // `password` is an ordinary policy method; retired names are not.
    for (const retired of ['adminPassword', 'passwordless']) {
        await assert.rejects(updateAuthPolicy({ enabledAuthMethods: [retired] }, { actorId: first.user.id }), { code: 'invalid_auth_method' });
    }
    const passwordOnly = await updateAuthPolicy({ enabledAuthMethods: ['password'] }, { actorId: first.user.id, emailStatus: async () => ({ available: false }) });
    assert.deepEqual(passwordOnly.enabledAuthMethods, ['password']);
    await updateAuthPolicy({ enabledAuthMethods: ['password', 'emailCode', 'passkey', 'totp', 'google'] }, { actorId: first.user.id, emailStatus: async () => ({ available: true }) });
    process.env.USERPERSISTO_DEFAULT_REGISTRATION_ROLE = 'user';
    try {
        const later = await setup.signUpWithPassword('ignores-env@example.test');
        assert.deepEqual(await getUserRoles(later.user.id), ['selfRegistered']);
    } finally { delete process.env.USERPERSISTO_DEFAULT_REGISTRATION_ROLE; }
    await updateAuthPolicy({ selfRegistrationEnabled: false }, { actorId: first.user.id, emailStatus: async () => ({ available: true }) });
    await assert.rejects(setup.signUpWithPassword('closed@example.test'), { code: 'registration_disabled' });
    assert.equal(await getUserByEmail('closed@example.test'), null);
    // Returning sign-in still works while registration is disabled.
    const returning = await setup.signInWithEmailCode('policy-owner@example.test');
    assert.equal(returning.user.id, first.user.id);
    assert.equal((await loginWithUserPassword({ email: 'policy-owner@example.test', password: first.password })).user.id, first.user.id);
});

test('a signup started while unclaimed is rechecked against policy when another completion claims first', async () => {
    // Before setup the first-owner path ignores the registration policy.
    process.env.USERPERSISTO_SELF_REGISTRATION_ENABLED = 'false';
    const pending = await stagedSignup('pending-signup@example.test');
    const owner = await setup.signUpWithPassword('claims-first@example.test');
    assert.equal(owner.initialAdministrator, true);
    // Completion now takes the later-signup path, where registration is disabled.
    await assert.rejects(completeSignup({ parent: pending.parent, browserProof: pending.browserProof, code: pending.sent.at(-1).code,
        prepareHandoff: () => prepareSsoHandoff(pending.request.providerState) }), { code: 'registration_disabled' });
    assert.equal(await getUserByEmail('pending-signup@example.test'), null);
    assert.equal((await getInstallationSetup()).initialAdministratorId, owner.user.id);
});

test('setup remains claimed after the administrator is blocked, demoted or deleted', async () => {
    const first = await setup.signUpWithPassword('claimed-owner@example.test');
    const store = await getStore();
    await store.deleteUser(first.user.id);
    assert.equal((await getInstallationSetup()).complete, true);
    const next = await setup.signUpWithPassword('after-removal@example.test');
    assert.equal(next.initialAdministrator, false);
    assert.deepEqual(await getUserRoles(next.user.id), ['selfRegistered']);
    // A restart does not reopen public ownership either.
    await resetStoreForTests();
    assert.equal((await getInstallationSetup()).initialAdministratorId, first.user.id);
    const afterRestart = await setup.signUpWithPassword('after-restart@example.test');
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

test('account ids never resolve through the email index or an empty value', async () => {
    const admin = await setup.signUpWithPassword('owner@example.test');
    assert.equal(await getUserById(''), null);
    assert.equal(await getUserById(admin.user.email), null);
    assert.equal(await getUserByEmail(''), null);
    assert.equal((await getUserById(admin.user.id)).id, admin.user.id);
});
