import test, { beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ensureSeedData } from '../lib/bootstrap.mjs';
import { getStore, flush, resetStoreForTests, setStoreFaultInjectorForTests } from '../lib/store.mjs';
import { getInstallationSetup } from '../lib/setup.mjs';
import { getUserById, getUserRoles } from '../lib/users.mjs';
import { updateAuthPolicy } from '../lib/policy.mjs';
import { createLoginRequest, getLoginRequest, prepareSsoHandoff, consumeAuthCode } from '../lib/sso.mjs';
import { completeGoogleIdentity, GOOGLE_ISSUER } from '../lib/externalIdentities.mjs';
import { initialPasswordSetupAvailable, loginWithInitialPassword } from '../lib/auth/initialPassword.mjs';
import { readPasswordCredential, loginWithUserPassword } from '../lib/auth/userPassword.mjs';
import { hashSecret, verifySecret, setKdfObserverForTests } from '../lib/auth/password.mjs';
import { startSignup, completeSignup } from '../lib/auth/signup.mjs';
import { readAttempt } from '../lib/auth/emailAttempts.mjs';
import { newBrowserProof, newTestPassword, resetAuthLimitsForTests, signUpWithPassword } from './helpers/setup.mjs';

let folder, environment;
const settle = () => new Promise((resolve) => setImmediate(resolve));
const outcome = (promise) => promise.then((value) => ({ value }), (error) => ({ error }));

beforeEach(async () => {
    environment = { ...process.env };
    folder = await mkdtemp(join(tmpdir(), 'userpersisto-initial-password-'));
    process.env.PERSISTENCE_FOLDER = folder;
    process.env.USERPERSISTO_SETTINGS_KEY = 'initial-password-fixture-settings';
    delete process.env.USERPERSISTO_AUTH_METHODS;
    delete process.env.USERPERSISTO_SELF_REGISTRATION_ENABLED;
    resetAuthLimitsForTests();
    await ensureSeedData();
});

afterEach(async () => {
    setStoreFaultInjectorForTests();
    setKdfObserverForTests(null);
    await resetStoreForTests().catch(() => {});
    await rm(folder, { recursive: true, force: true });
    for (const name of Object.keys(process.env)) if (!Object.hasOwn(environment, name)) delete process.env[name];
    Object.assign(process.env, environment);
});

async function options(email = 'owner@example.test', extra = {}) {
    const request = await createLoginRequest({ redirectUri: 'http://127.0.0.1/auth/callback' });
    return {
        parent: { flow: 'sso', id: request.providerState, expiresAt: Date.parse(request.expiresAt) },
        browserProof: newBrowserProof(),
        email,
        password: 'admin',
        validateParent: () => getLoginRequest(request.providerState),
        prepareHandoff: () => prepareSsoHandoff(request.providerState),
        ...extra,
    };
}

async function assertNoAccount() {
    const store = await getStore();
    assert.equal((await getInstallationSetup()).complete, false);
    for (const type of ['user', 'authMethod', 'ssoAuthCode', 'userRole']) {
        assert.equal((await store.select(type)).totalCount, 0, type);
    }
}

test('only literal admin can create the first account; variants and invalid emails leave setup untouched', async () => {
    for (const [index, candidate] of ['Admin', 'ADMIN', ' admin', 'admin ', 'ａｄｍｉｎ', 'admin\n', 'administrator', '', null, 42].entries()) {
        await assert.rejects(loginWithInitialPassword(await options(`variant-${index}@example.test`, { password: candidate })), { code: 'authentication_failed' });
        await assertNoAccount();
    }
    await assert.rejects(loginWithInitialPassword(await options('not-an-email')), { code: 'authentication_failed' });
    await assertNoAccount();
});

test('initial login atomically stores its own password and unverified email with administrator role and SSO handoff', async () => {
    const input = await options(' Owner@Example.test ');
    const completed = await loginWithInitialPassword(input);
    assert.equal(completed.initialAdministrator, true);
    assert.equal(completed.created, true);
    assert.deepEqual(completed.roles, ['admin']);
    const user = await getUserById(completed.user.id);
    assert.equal(user.email, 'owner@example.test');
    assert.equal(user.emailVerifiedAt, '');
    assert.equal(user.authGeneration, 0);
    const credential = await readPasswordCredential(await getStore(), user.id);
    assert.equal(credential.usable, true);
    assert.equal(await verifySecret('admin', credential.hash), true);
    assert.equal(Object.hasOwn(credential.record, 'password'), false);
    assert.equal(Object.hasOwn(credential.record.credential, 'hash'), false, 'the verifier is encrypted at rest');
    assert.deepEqual([(await getInstallationSetup()).method, (await getInstallationSetup()).initialAdministratorId], ['initialPassword', user.id]);
    const attempt = await readAttempt(input);
    assert.equal(attempt.status, 'completed');
    assert.equal(attempt.challenge, null);
    assert.equal(attempt.signup, null);
    assert.equal(attempt.completion.method, 'initialPassword');
    assert.equal(attempt.completion.email, user.email);
    assert.equal((await consumeAuthCode({ providerState: input.parent.id, code: completed.handoff.code })).user.id, user.id);
    await assert.rejects(consumeAuthCode({ providerState: input.parent.id, code: completed.handoff.code }), { code: 'auth_code_consumed' });
    assert.equal(await initialPasswordSetupAvailable(), false);
    const ordinary = await loginWithInitialPassword(await options(user.email));
    assert.equal(ordinary.user.id, user.id);
    assert.equal(ordinary.created, undefined, 'subsequent authentication uses the ordinary account credential');
    assert.equal((await loginWithUserPassword({ email: user.email, password: 'admin' })).user.id, user.id);
    await assert.rejects(loginWithInitialPassword(await options('another@example.test')), { code: 'authentication_failed' });
    assert.equal((await (await getStore()).select('user')).totalCount, 1);
});

test('claimed setup never reopens after restart or deletion of every account', async () => {
    const input = await options();
    const owner = await loginWithInitialPassword(input);
    await resetStoreForTests();
    resetAuthLimitsForTests();
    assert.equal(await initialPasswordSetupAvailable(), false);
    assert.equal((await loginWithInitialPassword(await options())).user.id, owner.user.id);
    await (await getStore()).deleteUser(owner.user.id);
    await flush();
    await resetStoreForTests();
    assert.equal((await (await getStore()).select('user')).totalCount, 0);
    assert.equal(await initialPasswordSetupAvailable(), false);
    await assert.rejects(loginWithInitialPassword(await options('replacement@example.test')), { code: 'authentication_failed' });
    assert.equal((await getInstallationSetup()).initialAdministratorId, owner.user.id);
    assert.equal((await (await getStore()).select('user')).totalCount, 0);
});

test('ordinary verified signup and Google registration remain restricted after initial-password setup', async () => {
    const owner = await loginWithInitialPassword(await options());
    const signedUp = await signUpWithPassword('later-signup@example.test');
    const google = await completeGoogleIdentity({ identity: {
        issuer: GOOGLE_ISSUER, subject: 'later-google-user', email: 'later-google@gmail.com', emailVerified: true,
    } });
    for (const created of [signedUp, google]) {
        assert.equal(created.initialAdministrator, false);
        assert.deepEqual(created.roles, ['selfRegistered']);
        assert.ok((await getUserById(created.user.id)).emailVerifiedAt);
    }
    assert.equal((await getInstallationSetup()).initialAdministratorId, owner.user.id);
    assert.equal((await getUserById(owner.user.id)).emailVerifiedAt, '');
    assert.equal((await (await getStore()).select('user')).totalCount, 3);
});

test('two concurrent bootstrap attempts create exactly one administrator', async () => {
    const inputs = [await options('first@example.test'), await options('second@example.test')];
    const occupied = Promise.withResolvers();
    const release = Promise.withResolvers();
    let hashes = 0;
    setKdfObserverForTests(async ({ purpose }) => {
        if (purpose === 'hash') { if (++hashes === 2) occupied.resolve(); await release.promise; }
    });
    const attempts = inputs.map((input) => outcome(loginWithInitialPassword(input)));
    await occupied.promise;
    release.resolve();
    const results = await Promise.all(attempts);
    assert.equal(results.filter((result) => result.value?.created).length, 1);
    assert.equal(results.filter((result) => result.error?.code === 'authentication_failed').length, 1);
    const users = (await (await getStore()).select('user')).objects;
    assert.equal(users.length, 1);
    assert.deepEqual(await getUserRoles(users[0].id), ['admin']);
    assert.equal((await (await getStore()).select('ssoAuthCode')).totalCount, 1);
});

for (const contender of ['google', 'verified-signup']) {
    test(`a racing ${contender} completion wins setup without being replaced by the pending initial password`, async () => {
        let completeContender;
        if (contender === 'google') completeContender = () => completeGoogleIdentity({
            identity: { issuer: GOOGLE_ISSUER, subject: 'initial-race-google', email: 'google-owner@gmail.com', emailVerified: true },
        });
        else {
            const input = await options('verified-owner@example.test');
            let code;
            const password = newTestPassword();
            await startSignup({ ...input, password, passwordConfirmation: password,
                deliver: async (message) => { code = message.code; return { delivered: true }; } });
            completeContender = () => completeSignup({ ...input, code });
        }
        const input = await options('initial-contender@example.test');
        const entered = Promise.withResolvers();
        const release = Promise.withResolvers();
        setKdfObserverForTests(async ({ purpose }) => { if (purpose === 'hash') { entered.resolve(); await release.promise; } });
        const pending = outcome(loginWithInitialPassword(input));
        await entered.promise;
        const winner = await completeContender();
        release.resolve();
        assert.equal((await pending).error?.code, 'authentication_failed');
        assert.equal((await getInstallationSetup()).initialAdministratorId, winner.user.id);
        assert.equal((await (await getStore()).select('user')).totalCount, 1);
        assert.deepEqual(await getUserRoles(winner.user.id), ['admin']);
    });
}

test('queue admission and final completion both recheck parent and password policy', async () => {
    for (const phase of ['queued', 'hashing']) for (const change of ['policy', 'parent']) {
        const input = await options(`${phase}-${change}@example.test`);
        let alive = true;
        const observed = Promise.withResolvers();
        const release = Promise.withResolvers();
        const occupied = Promise.withResolvers();
        let hashes = 0;
        input.validateParent = async () => {
            observed.resolve();
            if (!alive) throw Object.assign(new Error('Parent expired.'), { code: 'login_request_expired', statusCode: 400 });
            await getLoginRequest(input.parent.id);
        };
        setKdfObserverForTests(async ({ purpose }) => {
            if (purpose !== 'hash') return;
            hashes += 1;
            if (phase === 'hashing' || hashes === 2) occupied.resolve();
            await release.promise;
        });
        const blockers = phase === 'queued' ? [hashSecret('first queue blocker'), hashSecret('second queue blocker')] : [];
        if (blockers.length) await occupied.promise;
        const pending = outcome(loginWithInitialPassword(input));
        if (phase === 'hashing') await occupied.promise;
        else { await observed.promise; await settle(); }
        if (change === 'parent') alive = false;
        else await updateAuthPolicy({ enabledAuthMethods: ['emailCode'] }, { emailStatus: async () => ({ available: true }) });
        release.resolve();
        await Promise.all(blockers);
        assert.equal((await pending).error?.code, change === 'parent' ? 'login_request_expired' : 'authentication_failed', `${phase}:${change}`);
        assert.equal(hashes, phase === 'queued' ? 2 : 1, 'queued invalidation prevents the bootstrap KDF');
        await assertNoAccount();
        await updateAuthPolicy({ enabledAuthMethods: ['password', 'emailCode', 'google'] }, { emailStatus: async () => ({ available: true }) });
    }
});

test('a fault in the atomic initial commit leaves no account, credential, completion or handoff after restart', async () => {
    for (const failedOperation of ['createSystemSetting', 'createAuthMethod', 'createSsoAuthCode', 'createAuthAttempt']) {
        const input = await options(`${failedOperation.toLowerCase()}@example.test`);
        setStoreFaultInjectorForTests(async (phase, name, args) => {
            if (phase === 'before' && name === failedOperation
                && (name !== 'createSystemSetting' || args[0]?.key === 'installation.setup')) throw new Error('Injected initial commit failure.');
        });
        await assert.rejects(loginWithInitialPassword(input));
        await assert.rejects(getInstallationSetup(), { code: 'persistence_unavailable' });
        setStoreFaultInjectorForTests();
        await resetStoreForTests().catch(() => {});
        await assertNoAccount();
        assert.equal((await readAttempt(input)).status, 'active');
        assert.equal((await (await getStore()).select('authAttempt')).totalCount, 0);
    }
    const owner = await loginWithInitialPassword(await options('successful-retry@example.test'));
    assert.equal(owner.initialAdministrator, true);
});
