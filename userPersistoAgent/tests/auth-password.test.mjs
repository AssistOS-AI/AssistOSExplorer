import test, { afterEach, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { createHash, randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ensureSeedData } from '../lib/bootstrap.mjs';
import { createUser, getUserById, getUserRoles, authGenerationOf } from '../lib/users.mjs';
import { getInstallationSetup, prepareNewAccount } from '../lib/setup.mjs';
import { getStore, flush, resetStoreForTests } from '../lib/store.mjs';
import { wizardConfiguration } from '../lib/auth/wizardConfig.mjs';
import { getEnabledAuthMethods, getDefaultAuthMethod } from '../lib/auth/methods.mjs';
import { getProfile } from '../lib/authorization.mjs';
import { getAuthPolicy, updateAuthPolicy, usableSignInMethods } from '../lib/policy.mjs';
import { startReauthentication, completeReauthentication, consumeOperationGrant } from '../lib/auth/operationGrants.mjs';
import * as setup from './helpers/setup.mjs';

let folder;
const password = randomBytes(32).toString('base64url');

beforeEach(async () => {
    folder = await mkdtemp(join(tmpdir(), 'userpersisto-retired-password-'));
    process.env.PERSISTENCE_FOLDER = folder;
    process.env.USERPERSISTO_SETTINGS_KEY = 'test-settings-key';
    // An obsolete deployment variable must have no effect, even when set.
    process.env.USERPERSISTO_ADMIN_PASSWORD = password;
    delete process.env.USERPERSISTO_AUTH_METHODS;
    setup.resetAuthLimitsForTests();
    await ensureSeedData();
});

afterEach(async () => {
    await resetStoreForTests().catch(() => {});
    await rm(folder, { recursive: true, force: true });
    delete process.env.USERPERSISTO_ADMIN_PASSWORD;
    delete process.env.USERPERSISTO_AUTH_METHODS;
});

test('a retired administrator password cannot advertise sign-in or claim installation setup', async () => {
    assert.deepEqual(await getEnabledAuthMethods(), ['emailCode', 'passkey', 'totp', 'google']);
    assert.equal(await getDefaultAuthMethod(), 'emailCode');
    const configuration = await wizardConfiguration({ emailAvailable: true });
    assert.equal(Object.hasOwn(configuration, 'adminPassword'), false);
    assert.equal((await getInstallationSetup()).complete, false);
    assert.equal((await (await getStore()).select('user')).totalCount, 0);
    assert.equal(await (await getStore()).getSystemSettingByKey('auth.adminPassword.state'), undefined);
    await assert.rejects(prepareNewAccount({ email: '', method: 'adminPassword' }), { code: 'invalid_setup_method' });
    await assert.rejects(createUser({ email: '', roles: ['admin'], allowEmptyEmail: true }), { code: 'invalid_email' });
    const owner = await setup.registerWithEmailCode('owner@example.test');
    assert.deepEqual(owner.roles, ['admin']);
    assert.equal((await getInstallationSetup()).method, 'emailCode');
});

test('stored password setup claims stay closed without granting a later signup administrator access', async () => {
    const store = await getStore();
    const record = await store.createSystemSetting({ key: 'installation.setup', value: {
        complete: true, initialAdministratorId: 'USER.1', method: 'adminPassword', completedAt: new Date().toISOString(),
    } });
    await flush();
    await resetStoreForTests();
    assert.equal((await getInstallationSetup()).complete, true);
    assert.equal((await getInstallationSetup()).method, '');
    const member = await setup.registerWithEmailCode('later@example.test');
    assert.equal(member.initialAdministrator, false);
    assert.deepEqual(await getUserRoles(member.user.id), ['selfRegistered']);
    await (await getStore()).updateSystemSetting(record.id, { value: { complete: false, method: 'unsupported' } });
    await flush();
    await resetStoreForTests();
    assert.equal((await getInstallationSetup()).complete, true, 'malformed existing setup also fails closed');
    const later = await setup.registerWithEmailCode('later-again@example.test');
    assert.deepEqual(later.roles, ['selfRegistered']);
});

test('stored password state and credentials never count as a usable administrator sign-in method', async () => {
    const { user } = await setup.registerWithEmailCode('owner@example.test');
    const store = await getStore();
    await store.createSystemSetting({ key: 'auth.adminPassword.state', value: { passwordHash: 'obsolete-verifier', version: 'old-version' } });
    await store.createAuthMethod({ key: `${user.id}:adminPassword`, userId: user.id, type: 'adminPassword', enabled: true, credential: { verifier: 'obsolete' } });
    await flush();
    const profile = await getProfile(user.id);
    assert.equal(profile.authMethods.some((method) => method.type === 'adminPassword'), false);
    assert.equal(profile.reauthenticationMethods.includes('adminPassword'), false);
    assert.deepEqual(await usableSignInMethods(user, { emailAvailable: false }), []);
    await assert.rejects(updateAuthPolicy({ enabledAuthMethods: ['passkey'] }, {
        actorId: user.id, emailStatus: async () => ({ available: false }),
    }), { code: 'administrator_auth_method_required' });
    await assert.rejects(updateAuthPolicy({ enabledAuthMethods: ['adminPassword'] }, {
        actorId: user.id, emailStatus: async () => ({ available: true }),
    }), { code: 'invalid_auth_method' });
    assert.equal((await getAuthPolicy()).enabledAuthMethods.includes('emailCode'), true);
    for (const action of [startReauthentication, completeReauthentication]) {
        await assert.rejects(action({ userId: user.id, operation: 'passkey.register', method: 'adminPassword', password }),
            { code: 'reauthentication_unavailable' });
    }
});

test('a saved operation grant authenticated with the retired password cannot authorize enrollment', async () => {
    const { user } = await setup.registerWithEmailCode('owner@example.test');
    const store = await getStore();
    const grant = randomBytes(32).toString('base64url');
    const challengeId = `grant:${createHash('sha256').update(`userpersisto:operation-grant:${grant}`).digest('hex')}`;
    await store.createAuthChallenge({
        challengeId,
        subject: user.id,
        purpose: 'operation-grant',
        codeHash: '',
        expiresAt: new Date(Date.now() + 60000).toISOString(),
        attempts: 0,
        correlationId: JSON.stringify({ operation: 'passkey.register', method: 'adminPassword', generation: authGenerationOf(user) }),
    });
    await flush();
    await resetStoreForTests();
    await assert.rejects(consumeOperationGrant({ userId: user.id, operation: 'passkey.register', grant }), { code: 'operation_grant_required' });
    await resetStoreForTests();
    assert.equal(await (await getStore()).getAuthChallengeByChallengeId(challengeId), undefined);
    assert.equal(authGenerationOf(await getUserById(user.id)), authGenerationOf(user));
});

test('a retired method environment override never restores password authentication', async () => {
    process.env.USERPERSISTO_AUTH_METHODS = 'adminPassword,emailCode';
    assert.deepEqual((await getAuthPolicy()).enabledAuthMethods, ['emailCode']);
    process.env.USERPERSISTO_AUTH_METHODS = 'adminPassword';
    assert.equal((await getAuthPolicy()).enabledAuthMethods.includes('adminPassword'), false);
    assert.equal(Object.hasOwn(await wizardConfiguration(), 'adminPassword'), false);
});
