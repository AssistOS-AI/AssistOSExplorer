import test, { after, afterEach, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.PERSISTENCE_FOLDER = mkdtempSync(join(tmpdir(), 'userpersisto-signup-'));
process.env.USERPERSISTO_SETTINGS_KEY = 'signup-test-settings-key';
delete process.env.USERPERSISTO_AUTH_METHODS;
delete process.env.USERPERSISTO_SELF_REGISTRATION_ENABLED;

const { ensureSeedData } = await import('../lib/bootstrap.mjs');
const { createUser, getUserByEmail, getUserRoles, listUsers } = await import('../lib/users.mjs');
const { getInstallationSetup } = await import('../lib/setup.mjs');
const { getStore, flush, resetStoreForTests } = await import('../lib/store.mjs');
const { createLoginRequest, prepareSsoHandoff, consumeAuthCode } = await import('../lib/sso.mjs');
const { updateAuthPolicy } = await import('../lib/policy.mjs');
const { encryptOidcPayload } = await import('../lib/oidc/secrets.mjs');
const { completeGoogleIdentity, GOOGLE_ISSUER } = await import('../lib/externalIdentities.mjs');
const attempts = await import('../lib/auth/emailAttempts.mjs');
const signIn = await import('../lib/auth/signIn.mjs');
const signup = await import('../lib/auth/signup.mjs');
const password = await import('../lib/auth/password.mjs');
const { loginWithUserPassword } = await import('../lib/auth/userPassword.mjs');
const setup = await import('./helpers/setup.mjs');

let hashes = 0;

beforeEach(async () => {
    await resetStoreForTests();
    process.env.PERSISTENCE_FOLDER = mkdtempSync(join(tmpdir(), 'userpersisto-signup-'));
    delete process.env.USERPERSISTO_SELF_REGISTRATION_ENABLED;
    setup.resetAuthLimitsForTests();
    hashes = 0;
    password.setKdfObserverForTests(({ purpose }) => { if (purpose === 'hash') hashes += 1; });
    await ensureSeedData();
});

afterEach(() => password.resetKdfForTests());
after(async () => { await resetStoreForTests(); });

async function parent({ expiresInMs } = {}) {
    const request = await createLoginRequest({ redirectUri: 'http://127.0.0.1/auth/callback' });
    let expiresAt = Date.parse(request.expiresAt);
    if (expiresInMs) {
        const store = await getStore();
        const record = await store.getSsoLoginRequestByProviderState(request.providerState);
        expiresAt = Date.now() + expiresInMs;
        await store.updateSsoLoginRequest(record.id, { expiresAt: new Date(expiresAt).toISOString() });
    }
    return { flow: 'sso', id: request.providerState, expiresAt };
}

function mailbox(outcome = () => ({ delivered: true, providerMessageId: 'fixture' })) {
    const messages = [];
    const deliver = async (message) => { messages.push(message); return outcome(message); };
    return { messages, deliver, last: () => messages.at(-1) };
}

function wrong(code) {
    return code === '000000' ? '111111' : '000000';
}

function withClock(offsetMs, operation) {
    const realNow = Date.now;
    Date.now = () => realNow() + offsetMs;
    return Promise.resolve().then(operation).finally(() => { Date.now = realNow; });
}

function outcome(promise) {
    return promise.then((value) => ({ ok: true, value }), (error) => ({ ok: false, code: error.code, reason: error.reason }));
}

function snapshotText() {
    let text = '';
    const walk = (path) => {
        for (const entry of readdirSync(path)) {
            const full = join(path, entry);
            if (statSync(full).isDirectory()) walk(full);
            else text += readFileSync(full, 'utf8');
        }
    };
    walk(process.env.PERSISTENCE_FOLDER);
    return text;
}

const start = (context, browserProof, { email, secret, deliver, confirmation = secret }) => signup.startSignup({
    parent: context, browserProof, email, password: secret, passwordConfirmation: confirmation, deliver,
});
const complete = (context, browserProof, code) => signup.completeSignup({ parent: context, browserProof, code, prepareHandoff: () => prepareSsoHandoff(context.id) });
const status = (context, browserProof) => signIn.attemptStatus({ parent: context, browserProof });
const digest = (value) => createHash('sha256').update(value).digest('hex');

async function claimOwner() {
    return setup.signUpWithPassword('owner@example.test');
}

test('staging creates no account, role, setup claim, handoff or credential and keeps only encrypted data', async () => {
    const context = await parent();
    const browser = setup.newBrowserProof();
    const mail = mailbox();
    const secret = setup.newTestPassword();
    const started = await start(context, browser, { email: 'Pending.Owner@example.test', secret, deliver: mail.deliver });
    assert.deepEqual(Object.keys(started.challenge).sort(), ['attemptsRemaining', 'delivery', 'email', 'expired', 'expiresAt', 'purpose', 'resendAt']);
    assert.equal(started.challenge.purpose, 'register');
    assert.equal(started.challenge.delivery, 'accepted');
    assert.equal(mail.last().to, 'pending.owner@example.test');
    assert.equal(mail.last().purpose, 'signup-verification');
    assert.equal(await getUserByEmail('pending.owner@example.test'), null);
    assert.equal((await getInstallationSetup()).complete, false);
    const store = await getStore();
    for (const type of ['user', 'userRole', 'authMethod', 'ssoAuthCode', 'externalIdentity']) {
        assert.equal((await store.select(type)).objects.length, 0, type);
    }
    assert.equal((await status(context, browser)).signupPending, true);
    await flush();
    const text = snapshotText();
    for (const hidden of [secret, mail.last().code, 'pending.owner@example.test', 'scrypt$']) assert.equal(text.includes(hidden), false, hidden);
    // Discovery never sees a pending signup.
    assert.equal((await signIn.discoverAccount({ parent: context, email: 'pending.owner@example.test' })).exists, false);
});

test('the attempt format has one version, lookup namespace and encryption context', async () => {
    const context = await parent();
    const browser = setup.newBrowserProof();
    await start(context, browser, { email: 'format@example.test', secret: setup.newTestPassword(), deliver: mailbox().deliver });
    const store = await getStore();
    const [record] = (await store.select('authAttempt')).objects;
    const key = digest(JSON.stringify(['userpersisto:auth-attempt:v2', 'sso', context.id, digest(browser)]));
    assert.deepEqual([record.version, record.attemptKey, record.status, record.expiresAt], [2, key, 'active', context.expiresAt]);
    const payload = JSON.parse(JSON.stringify(record.payload));
    for (const [patch, label] of [[{ version: 1 }, 'version'],
        [{ payload: encryptOidcPayload({ status: 'active', flow: 'sso', parentId: context.id }, `userpersisto:auth-attempt:1:${key}`) }, 'context']]) {
        await store.updateAuthAttempt(record.id, patch);
        await flush();
        await assert.rejects(attempts.readAttempt({ parent: context, browserProof: browser }), { code: 'attempt_invalid' }, label);
        await store.updateAuthAttempt(record.id, { version: 2, payload });
        await flush();
    }
    assert.equal((await status(context, browser)).signupPending, true);
});

test('a record under the former namespace is never found or decrypted and is removed by the bounded sweep', async () => {
    const context = await parent();
    const browser = setup.newBrowserProof();
    const store = await getStore();
    const legacyKey = digest(JSON.stringify(['userpersisto:auth-attempt:v1', 'sso', context.id, digest(browser)]));
    await store.createAuthAttempt({ attemptKey: legacyKey, status: 'active', expiresAt: Date.now() + 1_000, version: 1,
        payload: encryptOidcPayload({ status: 'active', flow: 'sso', parentId: context.id, email: 'legacy@example.test', purpose: 'register',
            generation: 1, failures: 0, sends: 1, challenge: { codeHash: 'x', sentAt: Date.now(), expiresAt: Date.now() + 1_000, delivery: 'accepted' } },
        `userpersisto:auth-attempt:1:${legacyKey}`) });
    await flush();
    const payload = await attempts.readAttempt({ parent: context, browserProof: browser });
    assert.deepEqual([payload.email, payload.challenge, payload.signup, payload.generation], ['', null, null, 0], 'the old record is not the current attempt');
    await withClock(2_000, () => attempts.readAttempt({ parent: context, browserProof: browser }));
    assert.equal(await store.getAuthAttemptByAttemptKey(legacyKey), undefined);
});

test('a pending signup and a pending login code survive a genuine restart and then complete', async () => {
    await claimOwner();
    const member = await createUser({ email: 'returning@example.test', roles: ['user'], emailVerified: true });
    const context = await parent();
    const signupBrowser = setup.newBrowserProof();
    const loginBrowser = setup.newBrowserProof();
    const mail = mailbox();
    const secret = setup.newTestPassword();
    await start(context, signupBrowser, { email: 'restart@example.test', secret, deliver: mail.deliver });
    const signupCode = mail.last().code;
    await signIn.startEmailSignIn({ parent: context, browserProof: loginBrowser, email: member.email, purpose: 'login', deliver: mail.deliver });
    const loginCode = mail.last().code;
    await resetStoreForTests();
    setup.resetAuthLimitsForTests();
    assert.equal((await status(context, signupBrowser)).signupPending, true);
    const created = await signup.completeSignup({ parent: context, browserProof: signupBrowser, code: signupCode });
    assert.equal(created.created, true);
    const context2 = { ...context };
    const signedIn = await signIn.completeEmailSignIn({ parent: context2, browserProof: loginBrowser, code: loginCode });
    assert.equal(signedIn.user.id, member.id);
    assert.equal((await loginWithUserPassword({ email: 'restart@example.test', password: secret })).user.id, created.user.id);
});

test('a code is bound to its attempt, generation and staged verifier, never to another signup', async () => {
    await claimOwner();
    const victim = await parent();
    const attacker = await parent();
    const victimBrowser = setup.newBrowserProof();
    const attackerBrowser = setup.newBrowserProof();
    const mail = mailbox();
    const victimSecret = setup.newTestPassword();
    const attackerSecret = setup.newTestPassword();
    await start(attacker, attackerBrowser, { email: 'mailbox-owner@example.test', secret: attackerSecret, deliver: mail.deliver });
    const attackerCode = mail.last().code;
    await start(victim, victimBrowser, { email: 'mailbox-owner@example.test', secret: victimSecret, deliver: mail.deliver });
    const victimCode = mail.last().code;
    // The mailbox owner's code cannot finish the other person's pending signup.
    if (victimCode !== attackerCode) await assert.rejects(complete(attacker, attackerBrowser, victimCode), { code: 'code_invalid' });
    // Another browser on either parent has no pending signup of its own.
    await assert.rejects(complete(victim, attackerBrowser, victimCode), { code: 'signup_restart_required' });
    await assert.rejects(complete(attacker, victimBrowser, victimCode), { code: 'signup_restart_required' });
    const created = await complete(victim, victimBrowser, victimCode);
    assert.equal(created.user.email, 'mailbox-owner@example.test');
    assert.equal((await outcome(loginWithUserPassword({ email: 'mailbox-owner@example.test', password: attackerSecret }))).code, 'authentication_failed');
    assert.equal((await loginWithUserPassword({ email: 'mailbox-owner@example.test', password: victimSecret })).user.id, created.user.id);
    // The attacker's own verified code now meets the existing account and never activates its password.
    await assert.rejects(complete(attacker, attackerBrowser, attackerCode), { code: 'account_exists' });
    assert.equal((await status(attacker, attackerBrowser)).signupPending, false);
    assert.equal((await loginWithUserPassword({ email: 'mailbox-owner@example.test', password: victimSecret })).user.id, created.user.id);
});

test('resend keeps the verifier, honours the cooldown, invalidates earlier codes and stops at the send cap', async () => {
    const context = await parent({ expiresInMs: 10 * 60_000 });
    const browser = setup.newBrowserProof();
    const mail = mailbox();
    const secret = setup.newTestPassword();
    await start(context, browser, { email: 'resend@example.test', secret, deliver: mail.deliver });
    const first = mail.last().code;
    await assert.rejects(signup.resendSignup({ parent: context, browserProof: browser, deliver: mail.deliver }), { code: 'resend_too_soon' });
    const codes = [first];
    for (let send = 2; send <= 5; send += 1) {
        const resent = await withClock(61_000 * (send - 1), () => signup.resendSignup({ parent: context, browserProof: browser, deliver: mail.deliver }));
        assert.equal(resent.challenge.delivery, 'accepted');
        codes.push(mail.last().code);
    }
    const capped = await withClock(61_000 * 5, () => outcome(signup.resendSignup({ parent: context, browserProof: browser, deliver: mail.deliver })));
    assert.deepEqual(capped, { ok: false, code: 'rate_limited', reason: 'send_limit' });
    assert.equal(hashes, 1, 'retries never hash again');
    const latest = codes.at(-1);
    for (const earlier of codes.slice(0, -1)) if (earlier !== latest) await assert.rejects(withClock(61_000 * 4, () => complete(context, browser, earlier)), { code: 'code_invalid' });
    const created = await withClock(61_000 * 4, () => complete(context, browser, latest));
    assert.equal((await loginWithUserPassword({ email: 'resend@example.test', password: secret })).user.id, created.user.id);
});

test('change email keeps the verifier, invalidates the old address and never asks for the password again', async () => {
    const context = await parent();
    const browser = setup.newBrowserProof();
    const mail = mailbox();
    const secret = setup.newTestPassword();
    await start(context, browser, { email: 'typo@example.tset', secret, deliver: mail.deliver });
    const oldCode = mail.last().code;
    const changed = await signup.changeSignupEmail({ parent: context, browserProof: browser, email: 'fixed@example.test', deliver: mail.deliver });
    assert.equal(changed.challenge.email, 'fixed@example.test');
    assert.equal(mail.last().to, 'fixed@example.test');
    assert.equal(mail.last().purpose, 'signup-verification');
    const newCode = mail.last().code;
    if (oldCode !== newCode) await assert.rejects(complete(context, browser, oldCode), { code: 'code_invalid' });
    const created = await complete(context, browser, newCode);
    assert.equal(created.user.email, 'fixed@example.test');
    assert.equal(await getUserByEmail('typo@example.tset'), null);
    assert.equal(hashes, 1);
    assert.equal((await loginWithUserPassword({ email: 'fixed@example.test', password: secret })).user.id, created.user.id);
});

test('changing email to an address equal to the chosen password succeeds without an extra hash', async () => {
    for (const secret of ['destination@example.test', 'Mixed.Destination@Example.test']) {
        const context = await parent();
        const browser = setup.newBrowserProof();
        const mail = mailbox();
        const originalEmail = secret === secret.toLowerCase() ? 'original-lower@example.test' : 'original-mixed@example.test';
        const before = hashes;
        await start(context, browser, { email: originalEmail, secret, deliver: mail.deliver });
        const staged = await attempts.readAttempt({ parent: context, browserProof: browser });
        assert.equal(Object.hasOwn(staged.signup, 'emailComparisonVerifier'), false, 'no email-comparison verifier is staged');
        assert.equal(hashes - before, 1, 'only the chosen password is hashed');
        const changed = await signup.changeSignupEmail({ parent: context, browserProof: browser, email: secret.toLowerCase(), deliver: mail.deliver });
        assert.equal(changed.challenge.email, secret.toLowerCase());
        assert.equal(mail.last().to, secret.toLowerCase());
        assert.equal(hashes - before, 1, 'changing the email to match the password never hashes it again');
        const created = await complete(context, browser, mail.last().code);
        assert.equal(created.user.email, secret.toLowerCase());
        assert.equal((await loginWithUserPassword({ email: secret.toLowerCase(), password: secret })).user.id, created.user.id);
    }
});

test('signup revalidates its parent and policy when a global KDF slot becomes available', async () => {
    const owner = await claimOwner();
    for (const change of ['parent', 'policy']) {
        const context = await parent();
        const browser = setup.newBrowserProof();
        const mail = mailbox();
        const occupied = Promise.withResolvers();
        const release = Promise.withResolvers();
        const parentChecked = Promise.withResolvers();
        let evaluations = 0;
        let parentAlive = true;
        password.setKdfObserverForTests(async () => {
            if (++evaluations === 2) occupied.resolve();
            await release.promise;
        });
        const running = [password.hashSecret('first occupied slot'), password.hashSecret('second occupied slot')];
        await occupied.promise;
        const secret = setup.newTestPassword();
        const pending = outcome(signup.startSignup({ parent: context, browserProof: browser, email: `queued-${change}@example.test`,
            password: secret, passwordConfirmation: secret, deliver: mail.deliver, validateParent: async () => {
                parentChecked.resolve();
                if (!parentAlive) throw Object.assign(new Error('Expired request.'), { code: 'login_request_expired', statusCode: 400 });
            } }));
        await parentChecked.promise;
        await new Promise((resolve) => setImmediate(resolve));
        if (change === 'parent') parentAlive = false;
        else await updateAuthPolicy({ enabledAuthMethods: ['emailCode'] }, { actorId: owner.user.id, emailStatus: async () => ({ available: true }) });
        release.resolve();
        await Promise.all(running);
        assert.equal((await pending).code, change === 'parent' ? 'login_request_expired' : 'auth_method_disabled');
        assert.equal(evaluations, 2, 'the invalidated signup never performs its own KDF');
        assert.equal((await status(context, browser)).signupPending, false);
        assert.equal(mail.messages.length, 0);
        await updateAuthPolicy({ enabledAuthMethods: ['password', 'emailCode'] }, { actorId: owner.user.id, emailStatus: async () => ({ available: true }) });
    }
});

test('choosing another password restages the verifier and invalidates the previous code', async () => {
    const context = await parent();
    const browser = setup.newBrowserProof();
    const mail = mailbox();
    const firstSecret = setup.newTestPassword();
    const secondSecret = setup.newTestPassword();
    await start(context, browser, { email: 'twice@example.test', secret: firstSecret, deliver: mail.deliver });
    const firstCode = mail.last().code;
    await withClock(61_000, () => start(context, browser, { email: 'twice@example.test', secret: secondSecret, deliver: mail.deliver }));
    const secondCode = mail.last().code;
    await assert.rejects(complete(context, browser, firstCode), (error) => ['code_invalid'].includes(error.code) || firstCode === secondCode);
    const created = await complete(context, browser, secondCode);
    assert.equal((await outcome(loginWithUserPassword({ email: 'twice@example.test', password: firstSecret }))).code, 'authentication_failed');
    assert.equal((await loginWithUserPassword({ email: 'twice@example.test', password: secondSecret })).user.id, created.user.id);
});

test('cancel, a login code, five wrong codes and expiry end the staged verifier', async () => {
    await claimOwner();
    const existing = await createUser({ email: 'existing@example.test', roles: ['user'], emailVerified: true });
    const mail = mailbox();
    // Cancel erases the verifier; retries then require a new password.
    let context = await parent();
    let browser = setup.newBrowserProof();
    await start(context, browser, { email: 'cancel@example.test', secret: setup.newTestPassword(), deliver: mail.deliver });
    const cancelledCode = mail.last().code;
    assert.deepEqual(await signIn.cancelSignIn({ parent: context, browserProof: browser }), { status: 'cancelled' });
    assert.equal((await status(context, browser)).signupPending, false);
    await assert.rejects(signup.resendSignup({ parent: context, browserProof: browser, deliver: mail.deliver }), { code: 'signup_restart_required' });
    await assert.rejects(signup.changeSignupEmail({ parent: context, browserProof: browser, email: 'other@example.test', deliver: mail.deliver }), { code: 'signup_restart_required' });
    await assert.rejects(complete(context, browser, cancelledCode), { code: 'signup_restart_required' });
    // A login code in the same attempt replaces the pending signup.
    await start(context, browser, { email: 'switch@example.test', secret: setup.newTestPassword(), deliver: mail.deliver });
    await signIn.startEmailSignIn({ parent: context, browserProof: browser, email: existing.email, purpose: 'login', deliver: mail.deliver });
    assert.equal((await status(context, browser)).signupPending, false);
    await assert.rejects(complete(context, browser, mail.last().code), { code: 'signup_restart_required' });
    const signedIn = await signIn.completeEmailSignIn({ parent: context, browserProof: browser, code: mail.last().code, prepareHandoff: () => prepareSsoHandoff(context.id) });
    assert.equal(signedIn.user.id, existing.id, 'the login code still signs the existing account in');
    // Five wrong codes lock the attempt and erase the verifier.
    context = await parent();
    browser = setup.newBrowserProof();
    await start(context, browser, { email: 'locked@example.test', secret: setup.newTestPassword(), deliver: mail.deliver });
    const right = mail.last().code;
    for (let failure = 1; failure <= 4; failure += 1) {
        await assert.rejects(complete(context, browser, wrong(right)), (error) => error.code === 'code_invalid' && error.attemptsRemaining === 5 - failure);
    }
    await assert.rejects(complete(context, browser, wrong(right)), { code: 'too_many_attempts' });
    assert.deepEqual([(await status(context, browser)).signupPending, (await status(context, browser)).locked], [false, true]);
    await assert.rejects(complete(context, browser, right), { code: 'too_many_attempts' });
    await assert.rejects(signup.resendSignup({ parent: context, browserProof: browser, deliver: mail.deliver }), { code: 'too_many_attempts' });
    assert.equal(await getUserByEmail('locked@example.test'), null);
    // The parent deadline ends the staging.
    context = await parent({ expiresInMs: 20_000 });
    browser = setup.newBrowserProof();
    const started = await start(context, browser, { email: 'deadline@example.test', secret: setup.newTestPassword(), deliver: mail.deliver });
    assert.equal(started.challenge.expiresAt, context.expiresAt);
    await withClock(21_000, async () => {
        await assert.rejects(complete(context, browser, mail.last().code), { code: 'attempt_expired' });
        await assert.rejects(signup.resendSignup({ parent: context, browserProof: browser, deliver: mail.deliver }), { code: 'attempt_expired' });
    });
    assert.equal(await getUserByEmail('deadline@example.test'), null);
});

test('R6: a failed delivery after staging answers with the challenge and Send again reuses the verifier', async () => {
    const context = await parent();
    const browser = setup.newBrowserProof();
    let fail = true;
    const mail = mailbox(() => (fail ? { delivered: false } : { delivered: true, providerMessageId: 'fixture' }));
    const secret = setup.newTestPassword();
    const lines = [];
    const originalWarn = console.warn;
    console.warn = (...parts) => lines.push(parts.join(' '));
    let started;
    try {
        started = await start(context, browser, { email: 'send-again@example.test', secret, deliver: mail.deliver });
    } finally {
        console.warn = originalWarn;
    }
    assert.equal(started.challenge.delivery, 'failed');
    assert.ok(started.challenge.resendAt <= Date.now(), 'Send again is available at once');
    const described = await status(context, browser);
    assert.deepEqual([described.signupPending, described.challenge.delivery], [true, 'failed']);
    await assert.rejects(complete(context, browser, mail.last().code), { code: 'attempt_invalid' }, 'an undelivered code is not accepted');
    fail = false;
    const again = await signup.resendSignup({ parent: context, browserProof: browser, deliver: mail.deliver });
    assert.equal(again.challenge.delivery, 'accepted');
    assert.equal(mail.messages.length, 2);
    assert.equal(hashes, 1, 'exactly one KDF across the retries');
    await flush();
    assert.equal(snapshotText().includes(secret), false);
    assert.equal(lines.some((line) => line.includes(secret)), false);
    const created = await complete(context, browser, mail.last().code);
    assert.equal((await loginWithUserPassword({ email: 'send-again@example.test', password: secret })).user.id, created.user.id);
    const log = (await (await getStore()).select('emailLog')).objects;
    assert.deepEqual(log.map((entry) => [entry.template, entry.result]), [['signup-verification', 'failed'], ['signup-verification', 'accepted']]);
});

test('an unknown delivery outcome keeps the code usable and an interrupted delivery resumes as send-failed after restart', async () => {
    const context = await parent();
    const browser = setup.newBrowserProof();
    const unknown = mailbox(() => { throw new Error('transport closed'); });
    const secret = setup.newTestPassword();
    const started = await start(context, browser, { email: 'unknown@example.test', secret, deliver: unknown.deliver });
    assert.equal(started.challenge.delivery, 'unknown');
    assert.ok(started.challenge.resendAt > Date.now(), 'the cooldown applies after an unknown outcome');
    assert.equal((await complete(context, browser, unknown.last().code)).created, true);

    // A process stop between staging and recording the outcome leaves `pending`.
    const interrupted = await parent();
    const interruptedBrowser = setup.newBrowserProof();
    const verifier = await password.hashSecret('an interrupted signup password');
    await attempts.issueChallenge({ parent: interrupted, browserProof: interruptedBrowser, email: 'interrupted@example.test', purpose: 'register',
        signup: { verifier }, precheck: null });
    await resetStoreForTests();
    setup.resetAuthLimitsForTests();
    const resumed = await status(interrupted, interruptedBrowser);
    assert.deepEqual([resumed.signupPending, resumed.challenge.delivery, resumed.challenge.resendAt <= Date.now()], [true, 'pending', true]);
    const mail = mailbox();
    const retried = await signup.resendSignup({ parent: interrupted, browserProof: interruptedBrowser, deliver: mail.deliver });
    assert.equal(retried.challenge.delivery, 'accepted');
    const created = await signup.completeSignup({ parent: interrupted, browserProof: interruptedBrowser, code: mail.last().code });
    assert.equal((await loginWithUserPassword({ email: 'interrupted@example.test', password: 'an interrupted signup password' })).user.id, created.user.id);
});

test('refusals before staging keep nothing and predictable ones run no KDF', async () => {
    const owner = await claimOwner();
    hashes = 0;
    const context = await parent();
    const browser = setup.newBrowserProof();
    const mail = mailbox();
    const secret = setup.newTestPassword();
    const cases = [
        [{ email: 'bad-address', secret }, 'invalid_email'],
        [{ email: 'mismatch@example.test', secret, confirmation: `${secret}!` }, 'password_mismatch'],
        [{ email: 'short@example.test', secret: '' }, 'invalid_password'],
        [{ email: owner.user.email, secret }, 'account_exists'],
    ];
    for (const [input, code] of cases) {
        assert.equal((await outcome(start(context, browser, { ...input, deliver: mail.deliver }))).code, code);
    }
    await updateAuthPolicy({ selfRegistrationEnabled: false }, { actorId: owner.user.id, emailStatus: async () => ({ available: true }) });
    assert.equal((await outcome(start(context, browser, { email: 'closed@example.test', secret, deliver: mail.deliver }))).code, 'registration_disabled');
    await updateAuthPolicy({ selfRegistrationEnabled: true, enabledAuthMethods: ['emailCode', 'google'] }, { actorId: owner.user.id, emailStatus: async () => ({ available: true }) });
    assert.equal((await outcome(start(context, browser, { email: 'disabled@example.test', secret, deliver: mail.deliver }))).code, 'auth_method_disabled');
    assert.equal(hashes, 0);
    assert.equal(mail.messages.length, 0);
    assert.equal((await attempts.readAttempt({ parent: context, browserProof: browser })).signup, null);
    await assert.rejects(signup.resendSignup({ parent: context, browserProof: browser, deliver: mail.deliver }), { code: 'signup_restart_required' });
    assert.equal((await listUsers()).totalCount, 1);
});

test('registration closing or the method being disabled mid-flow refuses completion and erases the verifier', async () => {
    const owner = await claimOwner();
    for (const change of ['registration', 'method']) {
        const context = await parent();
        const browser = setup.newBrowserProof();
        const mail = mailbox();
        await start(context, browser, { email: `mid-flow-${change}@example.test`, secret: setup.newTestPassword(), deliver: mail.deliver });
        const policy = change === 'registration' ? { selfRegistrationEnabled: false } : { enabledAuthMethods: ['emailCode', 'google'] };
        await updateAuthPolicy(policy, { actorId: owner.user.id, emailStatus: async () => ({ available: true }) });
        await assert.rejects(complete(context, browser, mail.last().code), { code: change === 'registration' ? 'registration_disabled' : 'auth_method_disabled' });
        assert.equal((await status(context, browser)).signupPending, false);
        await assert.rejects(complete(context, browser, mail.last().code), { code: 'signup_restart_required' });
        assert.equal(await getUserByEmail(`mid-flow-${change}@example.test`), null);
        await updateAuthPolicy({ selfRegistrationEnabled: true, enabledAuthMethods: ['password', 'emailCode', 'google'] },
            { actorId: owner.user.id, emailStatus: async () => ({ available: true }) });
    }
});

test('the first verified signup claims the only administrator and later ones are selfRegistered', async () => {
    const first = await setup.signUpWithPassword('first@example.test');
    assert.deepEqual([first.created, first.initialAdministrator, first.roles], [true, true, ['admin']]);
    const record = await getInstallationSetup();
    assert.deepEqual([record.complete, record.initialAdministratorId, record.method], [true, first.user.id, 'passwordSignup']);
    const later = await setup.signUpWithPassword('later@example.test');
    assert.deepEqual([later.initialAdministrator, later.roles], [false, ['selfRegistered']]);
    assert.ok((await getUserByEmail('later@example.test')).emailVerifiedAt);
    const consumed = await consumeAuthCode({ providerState: later.request.providerState, code: later.handoff.code });
    assert.deepEqual(consumed.capabilities, ['selfregistered.dashboard.access']);
    const audit = (await (await getStore()).select('auditEvent', {}, { start: 0, pageSize: 100 })).objects.filter((event) => event.action === 'auth.password.register');
    assert.deepEqual(audit.map((event) => event.actorId).sort(), [first.user.id, later.user.id].sort());
});

test('concurrent same-email completions and a racing Google registration create exactly one account and administrator', async () => {
    const mail = mailbox();
    const contexts = [await parent(), await parent()];
    const browsers = [setup.newBrowserProof(), setup.newBrowserProof()];
    const codes = [];
    for (const index of [0, 1]) {
        await start(contexts[index], browsers[index], { email: 'race@example.test', secret: setup.newTestPassword(), deliver: mail.deliver });
        codes.push(mail.last().code);
    }
    const google = { issuer: GOOGLE_ISSUER, subject: 'racing-google-owner', email: 'google-owner@gmail.com', emailVerified: true };
    const results = await Promise.allSettled([
        complete(contexts[0], browsers[0], codes[0]),
        complete(contexts[1], browsers[1], codes[1]),
        completeGoogleIdentity({ identity: google, transactionId: 'racing-google' }),
    ]);
    const fulfilled = results.filter((result) => result.status === 'fulfilled').map((result) => result.value);
    assert.equal(fulfilled.length, 2);
    assert.deepEqual(results.filter((result) => result.status === 'rejected').map((result) => result.reason.code), ['account_exists']);
    assert.equal(fulfilled.filter((result) => result.initialAdministrator).length, 1);
    const administrators = (await listUsers({ pageSize: 10 })).users.filter((user) => user.roles.includes('admin'));
    assert.equal(administrators.length, 1);
    assert.equal((await getInstallationSetup()).initialAdministratorId, administrators[0].id);
    assert.equal((await listUsers({ search: 'race@' })).totalCount, 1);
    const store = await getStore();
    assert.equal((await store.select('authMethod')).objects.filter((method) => method.type === 'password').length, 1);
});

test('a completed signup replays its handoff only to the same browser and parent', async () => {
    const context = await parent();
    const browser = setup.newBrowserProof();
    const mail = mailbox();
    await start(context, browser, { email: 'replay@example.test', secret: setup.newTestPassword(), deliver: mail.deliver });
    const done = await complete(context, browser, mail.last().code);
    const replay = await complete(context, browser, '000000');
    assert.deepEqual([replay.replayed, replay.handoff.code, replay.user.id], [true, done.handoff.code, done.user.id]);
    await assert.rejects(complete(context, setup.newBrowserProof(), mail.last().code), { code: 'signup_restart_required' });
    const other = await parent();
    await assert.rejects(complete(other, browser, mail.last().code), { code: 'signup_restart_required' });
    assert.deepEqual(await signIn.cancelSignIn({ parent: context, browserProof: browser }), { status: 'completed' });
    assert.equal((await getUserRoles(done.user.id)).length, 1);
});
