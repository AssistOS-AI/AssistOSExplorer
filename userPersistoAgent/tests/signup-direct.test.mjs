import test, { beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ensureSeedData } from '../lib/bootstrap.mjs';
import { flush, getStore, resetStoreForTests, setStoreFaultInjectorForTests } from '../lib/store.mjs';
import { getInstallationSetup } from '../lib/setup.mjs';
import { getUserById, getUserRoles } from '../lib/users.mjs';
import { updateAuthPolicy } from '../lib/policy.mjs';
import { consumeAuthCode, createLoginRequest, getLoginRequest, prepareSsoHandoff } from '../lib/sso.mjs';
import { completeSignup, createSignupAccount, startSignup } from '../lib/auth/signup.mjs';
import { readAttempt } from '../lib/auth/emailAttempts.mjs';
import { loginWithUserPassword, readPasswordCredential } from '../lib/auth/userPassword.mjs';
import { hashSecret, setKdfObserverForTests, verifySecret } from '../lib/auth/password.mjs';
import { completeGoogleIdentity, GOOGLE_ISSUER } from '../lib/externalIdentities.mjs';
import { newBrowserProof, newTestPassword, resetAuthLimitsForTests, signUpWithPassword } from './helpers/setup.mjs';

let folder, environment;
const settle = () => new Promise((resolve) => setImmediate(resolve));
const outcome = (promise) => promise.then((value) => ({ value }), (error) => ({ error }));

beforeEach(async () => {
    environment = { ...process.env };
    folder = await mkdtemp(join(tmpdir(), 'userpersisto-signup-direct-'));
    process.env.PERSISTENCE_FOLDER = folder;
    process.env.USERPERSISTO_SETTINGS_KEY = 'signup-direct-fixture-settings';
    for (const name of ['USERPERSISTO_AUTH_METHODS', 'USERPERSISTO_SELF_REGISTRATION_ENABLED', 'USERPERSISTO_SIGNUP_EMAIL_VERIFICATION_REQUIRED']) {
        delete process.env[name];
    }
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

async function options(email = 'direct@example.test', extra = {}) {
    const password = extra.password ?? newTestPassword();
    const request = await createLoginRequest({ redirectUri: 'http://127.0.0.1/auth/callback' });
    return {
        parent: { flow: 'sso', id: request.providerState, expiresAt: Date.parse(request.expiresAt) },
        browserProof: newBrowserProof(),
        email,
        password,
        passwordConfirmation: password,
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

test('direct signup creates the first administrator with an unverified mailbox, a usable password and an SSO handoff', async () => {
    const input = await options(' Owner@Example.test ');
    const completed = await createSignupAccount(input);
    assert.equal(completed.created, true);
    assert.equal(completed.initialAdministrator, true);
    assert.deepEqual(completed.roles, ['admin']);
    assert.equal(completed.handoff.redirectUri, 'http://127.0.0.1/auth/callback');
    const user = await getUserById(completed.user.id);
    assert.equal(user.email, 'owner@example.test');
    assert.equal(user.emailVerifiedAt, '', 'direct signup never claims a verified mailbox');
    const credential = await readPasswordCredential(await getStore(), user.id);
    assert.equal(credential.usable, true);
    assert.equal(await verifySecret(input.password, credential.hash), true);
    assert.equal(Object.hasOwn(credential.record.credential, 'hash'), false, 'the verifier is encrypted at rest');
    const attempt = await readAttempt(input);
    assert.deepEqual([attempt.status, attempt.completion.method, attempt.completion.email], ['completed', 'passwordSignup', user.email]);
    assert.deepEqual([(await getInstallationSetup()).method, (await getInstallationSetup()).initialAdministratorId], ['passwordSignup', user.id]);
    assert.equal((await (await getStore()).select('emailLog')).totalCount, 0, 'no mail is sent or logged');
    assert.equal((await consumeAuthCode({ providerState: input.parent.id, code: completed.handoff.code })).user.id, user.id);

    const memberInput = await options('member@example.test');
    const member = await createSignupAccount(memberInput);
    assert.equal(member.initialAdministrator, false);
    assert.deepEqual(member.roles, ['selfRegistered']);
    assert.equal((await getUserById(member.user.id)).emailVerifiedAt, '');
    assert.equal((await loginWithUserPassword({ email: user.email, password: input.password })).user.id, user.id);
    assert.equal((await loginWithUserPassword({ email: member.user.email, password: memberInput.password })).user.id, member.user.id);
    assert.equal((await (await getStore()).select('user')).totalCount, 2);
});

test('direct signup refusals are typed and leave no account', async () => {
    const owner = await signUpWithPassword('verified-owner@example.test');
    const logged = (await (await getStore()).select('emailLog')).totalCount;
    await assert.rejects(createSignupAccount(await options(owner.user.email)), { code: 'account_exists', statusCode: 409 });

    await updateAuthPolicy({ signupEmailVerificationRequired: true }, { emailStatus: async () => ({ available: true }) });
    await assert.rejects(createSignupAccount(await options('required@example.test')), { code: 'signup_verification_required', statusCode: 409 });
    await updateAuthPolicy({ signupEmailVerificationRequired: false }, { emailStatus: async () => ({ available: true }) });

    await updateAuthPolicy({ selfRegistrationEnabled: false }, { emailStatus: async () => ({ available: true }) });
    await assert.rejects(createSignupAccount(await options('closed@example.test')), { code: 'registration_disabled', statusCode: 403 });
    await updateAuthPolicy({ selfRegistrationEnabled: true }, { emailStatus: async () => ({ available: true }) });

    await updateAuthPolicy({ enabledAuthMethods: ['emailCode'] }, { emailStatus: async () => ({ available: true }) });
    await assert.rejects(createSignupAccount(await options('disabled@example.test')), { code: 'auth_method_disabled', statusCode: 404 });
    await assert.rejects(createSignupAccount(await options('not-an-email')), { code: 'invalid_email' }, 'the address is validated before the policy');

    assert.equal((await (await getStore()).select('user')).totalCount, 1);
    assert.equal((await (await getStore()).select('emailLog')).totalCount, logged, 'direct refusals never send or log mail');
});

test('creation rules reject before any durable write and before the parent is consulted', async () => {
    const base = await options('rules@example.test');
    const expiredParent = { ...base.parent, expiresAt: Date.now() - 1000 };
    for (const [input, code, reason] of [
        [{ ...base, password: '', passwordConfirmation: '', parent: expiredParent }, 'invalid_password', 'too_short'],
        [{ ...base, passwordConfirmation: `${base.password} other`, parent: expiredParent }, 'password_mismatch', undefined],
    ]) {
        const error = await outcome(createSignupAccount(input));
        assert.equal(error.error?.code, code);
        assert.equal(error.error?.reason, reason);
    }
    await assertNoAccount();
    // A short non-empty password and a password equal to the email address are
    // both accepted now that the strength and email-comparison rules are gone.
    const short = await options('short-rules@example.test', { password: 'abc', passwordConfirmation: 'abc' });
    assert.equal((await createSignupAccount(short)).created, true);
    const equalsEmail = await options('equals-rules@example.test', { password: 'equals-rules@example.test', passwordConfirmation: 'equals-rules@example.test' });
    assert.equal((await createSignupAccount(equalsEmail)).created, true);
});

test('a lost response replays the same completion to the same browser only', async () => {
    // The SSO route deletes the login request with the handoff, so domain replay
    // is observed here on a parent that stays live; the route-level replay is
    // covered in signup-direct-http.test.mjs.
    const input = await options('replay@example.test', { prepareHandoff: null, validateParent: async () => {} });
    const first = await createSignupAccount(input);
    const replay = await createSignupAccount(input);
    assert.equal(replay.replayed, true);
    assert.equal(replay.user.id, first.user.id);
    assert.equal(replay.handoff, null);
    const foreign = await outcome(createSignupAccount({ ...input, browserProof: newBrowserProof() }));
    assert.equal(foreign.error?.code, 'account_exists');
    const store = await getStore();
    assert.equal((await store.select('user')).totalCount, 1);
    assert.equal((await store.select('authMethod')).totalCount, 1);
    assert.equal((await store.select('ssoAuthCode')).totalCount, 0);
});

test('two concurrent direct signups create exactly one administrator', async () => {
    const inputs = [await options('first-direct@example.test'), await options('second-direct@example.test')];
    const occupied = Promise.withResolvers();
    const release = Promise.withResolvers();
    let hashes = 0;
    setKdfObserverForTests(async ({ purpose }) => {
        if (purpose === 'hash' && ++hashes === 2) { occupied.resolve(); await release.promise; }
    });
    const attempts = inputs.map((input) => outcome(createSignupAccount(input)));
    await occupied.promise;
    release.resolve();
    const results = await Promise.all(attempts);
    assert.equal(results.filter((result) => result.value?.created).length, 2);
    const users = (await (await getStore()).select('user')).objects;
    assert.equal(users.length, 2);
    const admin = await Promise.all(users.map(async (user) => (await getUserRoles(user.id)).includes('admin')));
    assert.equal(admin.filter(Boolean).length, 1);
    const administrator = users[admin.indexOf(true)];
    assert.equal((await getInstallationSetup()).initialAdministratorId, administrator.id);
});

for (const contender of ['google', 'verified-signup']) {
    test(`a racing ${contender} completion wins setup while direct signup is mid-hash`, async () => {
        let completeContender;
        if (contender === 'google') completeContender = () => completeGoogleIdentity({
            identity: { issuer: GOOGLE_ISSUER, subject: 'direct-race-google', email: 'google-owner@gmail.com', emailVerified: true },
        });
        else {
            const verified = await options('verified-owner@example.test');
            let code;
            await startSignup({ ...verified, deliver: async (message) => { code = message.code; return { delivered: true }; } });
            completeContender = () => completeSignup({ ...verified, code });
        }
        const input = await options('direct-contender@example.test');
        const entered = Promise.withResolvers();
        const release = Promise.withResolvers();
        setKdfObserverForTests(async ({ purpose }) => { if (purpose === 'hash') { entered.resolve(); await release.promise; } });
        const pending = outcome(createSignupAccount(input));
        await entered.promise;
        const winner = await completeContender();
        release.resolve();
        const result = await pending;
        assert.equal(result.value?.created, true, JSON.stringify(result.error));
        assert.equal((await getInstallationSetup()).initialAdministratorId, winner.user.id);
        const users = (await (await getStore()).select('user')).objects;
        assert.equal(users.length, 2);
        const contenderUser = users.find((user) => user.id !== winner.user.id);
        assert.deepEqual(await getUserRoles(contenderUser.id), ['selfRegistered']);
        assert.deepEqual(await getUserRoles(winner.user.id), ['admin']);
    });
}

test('queue admission and final completion recheck the parent and the verification policy', async () => {
    for (const phase of ['queued', 'hashing']) for (const change of ['policy', 'parent']) {
        const input = await options(`direct-${phase}-${change}@example.test`);
        let alive = true;
        const observed = Promise.withResolvers();
        observed.hashes = 0;
        const release = Promise.withResolvers();
        const occupied = Promise.withResolvers();
        input.validateParent = async () => {
            observed.resolve();
            if (!alive) throw Object.assign(new Error('Parent expired.'), { code: 'login_request_expired', statusCode: 400 });
            await getLoginRequest(input.parent.id);
        };
        setKdfObserverForTests(async ({ purpose }) => {
            if (purpose !== 'hash') return;
            if (phase === 'hashing') { occupied.resolve(); await release.promise; return; }
            if (++observed.hashes === 2) { occupied.resolve(); await release.promise; }
        });
        const blockers = phase === 'queued' ? [hashSecret('first queue blocker'), hashSecret('second queue blocker')] : [];
        if (blockers.length) await occupied.promise;
        const pending = outcome(createSignupAccount(input));
        if (phase === 'hashing') await occupied.promise;
        else { await observed.promise; await settle(); }
        if (change === 'parent') alive = false;
        else await updateAuthPolicy({ signupEmailVerificationRequired: true }, { emailStatus: async () => ({ available: true }) });
        release.resolve();
        await Promise.all(blockers);
        assert.equal((await pending).error?.code, change === 'parent' ? 'login_request_expired' : 'signup_verification_required', `${phase}:${change}`);
        await assertNoAccount();
        await updateAuthPolicy({ signupEmailVerificationRequired: false }, { emailStatus: async () => ({ available: true }) });
    }
});

test('a fault in the atomic direct commit leaves no account, credential, completion or handoff after restart', async () => {
    for (const failedOperation of ['createUser', 'createUserRole', 'createSystemSetting', 'createAuthMethod', 'createSsoAuthCode', 'createAuthAttempt']) {
        const input = await options(`${failedOperation.toLowerCase()}@example.test`);
        setStoreFaultInjectorForTests(async (phase, name, args) => {
            if (phase === 'before' && name === failedOperation
                && (name !== 'createSystemSetting' || args[0]?.key === 'installation.setup')) throw new Error('Injected direct commit failure.');
        });
        await assert.rejects(createSignupAccount(input));
        setStoreFaultInjectorForTests();
        await resetStoreForTests().catch(() => {});
        await assertNoAccount();
        assert.equal((await readAttempt(input)).status, 'active');
        assert.equal((await (await getStore()).select('authAttempt')).totalCount, 0);
    }
    const owner = await createSignupAccount(await options('successful-retry@example.test'));
    assert.equal(owner.initialAdministrator, true);
    assert.equal((await (await getStore()).select('authAttempt')).totalCount, 1);
});

test('the per-source direct signup hashing budget refuses the eleventh attempt in the window', async () => {
    const source = 'a'.repeat(64);
    const accounts = [];
    for (let index = 0; index < 10; index += 1) {
        accounts.push(await createSignupAccount(await options(`budget-${index}@example.test`, { rateSource: source })));
    }
    assert.equal(accounts.length, 10);
    await assert.rejects(createSignupAccount(await options('budget-over@example.test', { rateSource: source })), { code: 'rate_limited' });
    const other = await createSignupAccount(await options('budget-other@example.test', { rateSource: 'b'.repeat(64) }));
    assert.equal(other.created, true);
    assert.equal((await (await getStore()).select('user')).totalCount, 11);
});

test('every direct signup call spends the discovery budget of its parent', async () => {
    const owner = await signUpWithPassword('existing-owner@example.test');
    const probe = await options(owner.user.email);
    for (let index = 0; index < 20; index += 1) {
        await assert.rejects(createSignupAccount({ ...probe, browserProof: newBrowserProof() }), { code: 'account_exists', statusCode: 409 });
    }
    const limited = await outcome(createSignupAccount({ ...probe, browserProof: newBrowserProof() }));
    assert.equal(limited.error?.code, 'rate_limited');
    assert.equal(limited.error?.statusCode, 429);
    assert.ok(Number.isSafeInteger(limited.error?.retryAfter) && limited.error.retryAfter > 0);
    await assert.rejects(createSignupAccount(await options(owner.user.email)), { code: 'account_exists' }, 'a fresh parent from the same source is not limited');

    // A successful signup consumes one unit of its parent like any refusal.
    const shared = await options(owner.user.email, { validateParent: undefined, prepareHandoff: undefined });
    for (let index = 0; index < 19; index += 1) {
        await assert.rejects(createSignupAccount({ ...shared, browserProof: newBrowserProof() }), { code: 'account_exists' });
    }
    const created = await createSignupAccount({ ...shared, email: 'budget-newcomer@example.test', browserProof: newBrowserProof() });
    assert.equal(created.created, true);
    await assert.rejects(createSignupAccount({ ...shared, browserProof: newBrowserProof() }), { code: 'rate_limited', statusCode: 429 });
});
