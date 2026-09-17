import test, { beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ensureSeedData } from '../lib/bootstrap.mjs';
import { getStore, flush, resetStoreForTests, commitStagedPersistence } from '../lib/store.mjs';
import { getInstallationSetup, prepareNewAccount } from '../lib/setup.mjs';
import { serialize } from '../lib/serial.mjs';
import { withPersistenceScope } from '../lib/persistence-scope.mjs';
import { createUser, getUserById, getUserRoles, setUserRoles, updateUser } from '../lib/users.mjs';
import { getProfile } from '../lib/authorization.mjs';
import { usableSignInMethods, updateAuthPolicy } from '../lib/policy.mjs';
import { wizardConfiguration } from '../lib/auth/wizardConfig.mjs';
import * as admin from '../lib/auth/adminPassword.mjs';
import { verifyPassword } from '../lib/auth/password.mjs';
import { completeReauthentication, consumeOperationGrant } from '../lib/auth/operationGrants.mjs';
import { startContactVerification, completeContactVerification } from '../lib/auth/contactVerification.mjs';
import { inspectGoogleIdentity, completeGoogleIdentity, GOOGLE_ISSUER } from '../lib/externalIdentities.mjs';
import PersistoOidcAdapter, { writeOidcDocument } from '../lib/oidc/adapter.mjs';
import { getOrCreateOidcKeys } from '../lib/oidc/secrets.mjs';
import * as setup from './helpers/setup.mjs';

let folder;
const SOURCE_A = 'a'.repeat(64);
const SOURCE_B = 'b'.repeat(64);
const claim = (password = 'admin', extra = {}) => admin.completeAdministratorPassword({ password, rateSource: SOURCE_A, ...extra });

beforeEach(async () => {
    folder = await mkdtemp(join(tmpdir(), 'userpersisto-restored-admin-'));
    process.env.PERSISTENCE_FOLDER = folder;
    process.env.USERPERSISTO_SETTINGS_KEY = 'test-restored-admin-settings';
    delete process.env.USERPERSISTO_ADMIN_PASSWORD;
    delete process.env.USERPERSISTO_AUTH_METHODS;
    admin.resetAdministratorPasswordForTests();
    setup.resetAuthLimitsForTests();
    await ensureSeedData();
});

afterEach(async () => {
    await resetStoreForTests();
    await rm(folder, { recursive: true, force: true });
    delete process.env.USERPERSISTO_ADMIN_PASSWORD;
    delete process.env.USERPERSISTO_AUTH_METHODS;
});

test('new setup offers admin by default, creates an email-less administrator, and persists only its verifier', async () => {
    assert.equal((await wizardConfiguration()).adminPassword, true);
    assert.equal((await getInstallationSetup()).complete, false);
    await assert.rejects(claim('wrong'), { code: 'authentication_failed' });
    await assert.rejects(claim('admin', { contactEmail: 'invalid-address' }), { code: 'invalid_email' });
    assert.equal((await getInstallationSetup()).complete, false);
    const result = await claim('admin', { contactEmail: 'Operator@Example.test' });
    assert.deepEqual(result.roles, ['admin']);
    assert.equal(result.initialAdministrator, true);
    const user = await getUserById(result.user.id);
    assert.equal(user.email, '');
    assert.equal(user.emailVerifiedAt, '');
    assert.equal(user.contactEmail, 'operator@example.test');
    assert.equal((await getInstallationSetup()).method, 'adminPassword');
    const state = (await (await getStore()).getSystemSettingByKey('auth.adminPassword.state')).value;
    assert.equal(state.defaultPassword, true);
    assert.equal(Object.hasOwn(state, 'password'), false);
    assert.match(state.passwordHash, /^scrypt\$16384\$8\$1\$/);
    assert.equal(verifyPassword('admin', state.passwordHash), true);
    await resetStoreForTests();
    admin.resetAdministratorPasswordForTests();
    await admin.syncAdministratorPasswordState();
    assert.equal((await wizardConfiguration()).adminPassword, true);
    assert.equal((await claim()).user.id, user.id);
    assert.equal((await getUserById(user.id)).authGeneration, 0, 'restart preserves the credential version');
    assert.equal((await (await getStore()).select('user')).totalCount, 1);
});

test('opening a new installation then claiming it with email never enables the default for that owner', async () => {
    await admin.syncAdministratorPasswordState();
    assert.equal((await wizardConfiguration()).adminPassword, true);
    const owner = await setup.registerWithEmailCode('email-owner@example.test');
    assert.equal((await wizardConfiguration()).adminPassword, false);
    await assert.rejects(claim(), { code: 'admin_password_unavailable' });
    assert.equal((await getUserById(owner.user.id)).authGeneration, 0, 'discarding an unused default does not revoke email sessions');
    await resetStoreForTests();
    admin.resetAdministratorPasswordForTests();
    assert.equal((await wizardConfiguration()).adminPassword, false);
    assert.equal(await admin.administratorPasswordUsableFor(owner.user.id), false);
});

test('previously claimed stores and historical explicit-password state do not acquire a default password', async () => {
    const owner = await setup.registerWithEmailCode('existing@example.test');
    assert.equal((await wizardConfiguration()).adminPassword, false);
    await assert.rejects(claim(), { code: 'admin_password_unavailable' });
    const store = await getStore();
    const record = await store.getSystemSettingByKey('installation.setup');
    await store.updateSystemSetting(record.id, { value: { ...record.value, method: 'adminPassword' } });
    await store.createSystemSetting({ key: 'auth.adminPassword.state', value: { passwordHash: 'historical-verifier', version: 'historical-version' } });
    await flush();
    await resetStoreForTests();
    assert.equal((await wizardConfiguration()).adminPassword, false);
    assert.equal(await admin.administratorPasswordUsableFor(owner.user.id), false);
    await assert.rejects(claim(), { code: 'admin_password_unavailable' });
});

test('an explicit empty or invalid setting disables new-installation default sign-in', async () => {
    for (const value of ['', 'four']) {
        process.env.USERPERSISTO_ADMIN_PASSWORD = value;
        assert.equal((await wizardConfiguration()).adminPassword, false);
        await assert.rejects(claim(), { code: 'admin_password_unavailable' });
        assert.equal((await getInstallationSetup()).complete, false);
    }
});

test('an explicit configured password overrides admin and remains limited to the designated owner', async () => {
    const owner = await setup.registerWithEmailCode('owner@example.test');
    const member = await setup.registerWithEmailCode('member@example.test');
    process.env.USERPERSISTO_ADMIN_PASSWORD = randomBytes(24).toString('base64url');
    await assert.rejects(claim(), { code: 'authentication_failed' });
    assert.equal((await claim(process.env.USERPERSISTO_ADMIN_PASSWORD, { contactEmail: member.user.email })).user.id, owner.user.id);
    assert.deepEqual(await getUserRoles(member.user.id), ['selfRegistered']);
    assert.equal(await admin.administratorPasswordUsableFor(member.user.id), false);
    const second = await createUser({ email: 'other-admin@example.test', roles: ['admin'], emailVerified: true });
    assert.equal(await admin.administratorPasswordUsableFor(second.id), false);
    await setUserRoles(owner.user.id, ['user'], { actorId: second.id });
    await assert.rejects(claim(process.env.USERPERSISTO_ADMIN_PASSWORD), { code: 'authentication_failed' });
    await setUserRoles(owner.user.id, ['admin'], { actorId: second.id });
    await updateUser(owner.user.id, { status: 'blocked' }, { actorId: second.id });
    await assert.rejects(claim(process.env.USERPERSISTO_ADMIN_PASSWORD), { code: 'authentication_failed' });
    await (await getStore()).deleteUser(owner.user.id);
    await assert.rejects(claim(process.env.USERPERSISTO_ADMIN_PASSWORD), { code: 'authentication_failed' });
    assert.equal((await getInstallationSetup()).initialAdministratorId, owner.user.id);
});

test('concurrent first password sign-ins create one administrator and reject an expired parent', async () => {
    const rejected = Object.assign(new Error('expired'), { code: 'login_request_expired' });
    await assert.rejects(claim('admin', { validateParent: async () => { throw rejected; } }), { code: 'login_request_expired' });
    assert.equal((await getInstallationSetup()).complete, false);
    const results = await Promise.all([claim(), claim()]);
    assert.equal(results[0].user.id, results[1].user.id);
    assert.equal(results.filter((result) => result.initialAdministrator).length, 1);
    assert.equal((await (await getStore()).select('user')).totalCount, 1);
});

test('a verified default password loses authority when another setup method commits first', async () => {
    await admin.syncAdministratorPasswordState();
    const locked = Promise.withResolvers();
    const release = Promise.withResolvers();
    const emailCompletion = serialize('users', async () => {
        locked.resolve();
        await release.promise;
        // Model the verified email completion already holding the users lock.
        return withPersistenceScope(async () => {
            const stage = await prepareNewAccount({ email: 'race-owner@example.test', emailVerified: true, method: 'emailCode' });
            return commitStagedPersistence(stage);
        });
    });
    await locked.promise;
    const starting = Promise.withResolvers();
    const passwordCompletion = claim('admin', { validateParent: async () => { starting.resolve(); } });
    const refused = assert.rejects(passwordCompletion, { code: 'authentication_failed' });
    await starting.promise;
    // The later verification shares the credential lock, so its completion
    // establishes that the first proof was verified before email claims setup.
    await admin.verifyAdministratorPassword({ password: 'admin', rateSource: SOURCE_B });
    release.resolve();
    const owner = await emailCompletion;
    await refused;
    assert.equal((await getInstallationSetup()).initialAdministratorId, owner.user.id);
    assert.equal((await (await getStore()).select('user')).totalCount, 1);
    assert.equal((await wizardConfiguration()).adminPassword, false);
});

test('source and durable global guessing limits cover the five-character default across restart', async () => {
    for (let attempt = 0; attempt < 5; attempt += 1) {
        await assert.rejects(admin.verifyAdministratorPassword({ password: 'wrong', rateSource: SOURCE_A }), { code: 'authentication_failed' });
    }
    await assert.rejects(admin.verifyAdministratorPassword({ password: 'admin', rateSource: SOURCE_A }), (error) => error.code === 'rate_limited' && error.retryAfter > 0);
    assert.ok((await admin.verifyAdministratorPassword({ password: 'admin', rateSource: SOURCE_B })).credentialVersion);
    for (let source = 0; source < 5; source += 1) {
        for (let attempt = 0; attempt < 5; attempt += 1) {
            await assert.rejects(admin.verifyAdministratorPassword({ password: 'wrong', rateSource: source.toString(16).padStart(64, 'c') }), { code: 'authentication_failed' });
        }
    }
    await resetStoreForTests();
    admin.resetAdministratorPasswordForTests();
    await assert.rejects(admin.verifyAdministratorPassword({ password: 'admin', rateSource: 'd'.repeat(64) }), { code: 'rate_limited' });
    assert.equal((await getInstallationSetup()).complete, false);
});

test('password confirmation verifies contact email before passkey or authenticator enrollment', async () => {
    const { user } = await claim('admin', { contactEmail: 'contact@example.test' });
    const profile = await getProfile(user.id);
    assert.deepEqual(profile.reauthenticationMethods, ['adminPassword']);
    assert.equal(profile.authMethods.some((method) => method.type === 'adminPassword'), true);
    assert.deepEqual(await usableSignInMethods(await getUserById(user.id)), ['adminPassword']);
    await updateAuthPolicy({ enabledAuthMethods: ['passkey'] }, { emailStatus: async () => ({ available: false }) });
    await assert.rejects(completeReauthentication({ userId: user.id, operation: 'passkey.register', method: 'adminPassword', password: 'admin' }), { code: 'verified_email_required' });
    const proof = await completeReauthentication({ userId: user.id, operation: 'contact.verify', method: 'adminPassword', password: 'admin' });
    let delivered;
    await startContactVerification({ userId: user.id, email: 'contact@example.test', grant: proof.grant,
        deliver: async (message) => { delivered = message; return { delivered: true, providerMessageId: 'fixture' }; } });
    await completeContactVerification({ userId: user.id, code: delivered.code });
    assert.ok((await getUserById(user.id)).emailVerifiedAt);
    const enrolled = await completeReauthentication({ userId: user.id, operation: 'passkey.register', method: 'adminPassword', password: 'admin' });
    assert.equal((await consumeOperationGrant({ userId: user.id, operation: 'passkey.register', grant: enrolled.grant })).user.id, user.id);
    await assert.rejects(consumeOperationGrant({ userId: user.id, operation: 'passkey.register', grant: enrolled.grant }), { code: 'operation_grant_required' });
});

test('rotation revokes retained proofs, grants, and OIDC state; removing the override does not restore admin', async () => {
    const { user } = await claim();
    const proof = await admin.verifyAdministratorPassword({ password: 'admin' });
    const grant = await completeReauthentication({ userId: user.id, operation: 'contact.verify', method: 'adminPassword', password: 'admin' });
    await getOrCreateOidcKeys();
    await writeOidcDocument('Client', 'rotate-client', { enabled: true, metadata: { client_id: 'rotate-client' } });
    await new PersistoOidcAdapter('Grant').upsert('rotate-grant', { jti: 'rotate-grant', clientId: 'rotate-client', accountId: user.id }, 3600);
    await new PersistoOidcAdapter('Session').upsert('rotate-session', { uid: 'rotate-session-uid', accountId: user.id,
        authorizations: { 'rotate-client': { grantId: 'rotate-grant' } } }, 3600);
    process.env.USERPERSISTO_ADMIN_PASSWORD = randomBytes(24).toString('base64url');
    await admin.syncAdministratorPasswordState();
    assert.equal((await getUserById(user.id)).authGeneration, 1);
    assert.equal(await admin.assertAdministratorPasswordProof(await getStore(), { userId: user.id, credentialVersion: proof.credentialVersion }), false);
    await assert.rejects(consumeOperationGrant({ userId: user.id, operation: 'contact.verify', grant: grant.grant }), { code: 'operation_grant_required' });
    assert.equal(await new PersistoOidcAdapter('Grant').find('rotate-grant'), undefined);
    assert.equal(await new PersistoOidcAdapter('Session').find('rotate-session'), undefined);
    await assert.rejects(claim(), { code: 'authentication_failed' });
    assert.equal((await claim(process.env.USERPERSISTO_ADMIN_PASSWORD)).user.id, user.id);
    delete process.env.USERPERSISTO_ADMIN_PASSWORD;
    await admin.syncAdministratorPasswordState();
    assert.equal((await getUserById(user.id)).authGeneration, 2);
    assert.equal((await wizardConfiguration()).adminPassword, false);
    await assert.rejects(claim(), { code: 'admin_password_unavailable' });
});

test('Google linking accepts a fresh administrator proof and rejects it after password rotation', async () => {
    const { user } = await setup.registerWithEmailCode('owner@example.test');
    process.env.USERPERSISTO_ADMIN_PASSWORD = 'admin';
    const identity = { issuer: GOOGLE_ISSUER, subject: 'restored-password-subject', email: user.email, emailVerified: true };
    const resolution = await inspectGoogleIdentity(identity);
    assert.equal(resolution.eligibleMethods.includes('adminPassword'), true);
    const verified = await admin.verifyAdministratorPassword({ password: 'admin' });
    const proof = { userId: user.id, email: user.email, method: 'adminPassword', transactionId: 'password-link-transaction',
        credentialVersion: verified.credentialVersion, authenticatedAt: Date.now(), confirmedAt: Date.now() };
    process.env.USERPERSISTO_ADMIN_PASSWORD = 'changed-password';
    await admin.syncAdministratorPasswordState();
    await assert.rejects(completeGoogleIdentity({ identity, transactionId: proof.transactionId, linkProof: proof }), { code: 'google_link_authentication_required' });
    const current = await admin.verifyAdministratorPassword({ password: 'changed-password' });
    const linked = await completeGoogleIdentity({ identity, transactionId: proof.transactionId,
        linkProof: { ...proof, credentialVersion: current.credentialVersion, authenticatedAt: Date.now(), confirmedAt: Date.now() } });
    assert.equal(linked.user.id, user.id);
});
