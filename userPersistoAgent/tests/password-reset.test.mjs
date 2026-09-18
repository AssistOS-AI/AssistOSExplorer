import test, { beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ensureSeedData } from '../lib/bootstrap.mjs';
import { commitStagedPersistence, getStore, resetStoreForTests, setStoreFaultInjectorForTests } from '../lib/store.mjs';
import { serializePersisted } from '../lib/serial.mjs';
import { updateUser, getUserById, stageAuthGenerationIncrement } from '../lib/users.mjs';
import { createUser } from '../lib/users.mjs';
import { updateAuthPolicy } from '../lib/policy.mjs';
import { loginWithUserPassword } from '../lib/auth/userPassword.mjs';
import { hashSecret, setKdfObserverForTests } from '../lib/auth/password.mjs';
import { stagePasswordCredential } from '../lib/auth/userPassword.mjs';
import { stageCredentialGenerationAdvance } from '../lib/auth/generation.mjs';
import { completePasswordReset, inspectPasswordReset, requestPasswordReset, RESET_TOKEN_TTL_MS } from '../lib/auth/passwordReset.mjs';
import { sendPasswordResetEmail } from '../lib/email-agent-client.mjs';
import { newTestPassword, resetAuthLimitsForTests, signUpDirect, signUpWithPassword } from './helpers/setup.mjs';

const BASE = 'http://127.0.0.1:7000/service/auth/reset.html';
const TOKEN = /#token=([A-Za-z0-9_-]{43})$/;
let folder, environment;

beforeEach(async () => {
    environment = { ...process.env };
    folder = await mkdtemp(join(tmpdir(), 'userpersisto-password-reset-'));
    process.env.PERSISTENCE_FOLDER = folder;
    process.env.USERPERSISTO_SETTINGS_KEY = 'password-reset-fixture-settings';
    for (const name of ['USERPERSISTO_AUTH_METHODS', 'USERPERSISTO_SELF_REGISTRATION_ENABLED', 'USERPERSISTO_SIGNUP_EMAIL_VERIFICATION_REQUIRED',
        'USERPERSISTO_DEV_BOOTSTRAP']) delete process.env[name];
    resetAuthLimitsForTests();
    await ensureSeedData();
});

afterEach(async () => {
    setKdfObserverForTests(null);
    setStoreFaultInjectorForTests(null);
    await resetStoreForTests().catch(() => {});
    await rm(folder, { recursive: true, force: true });
    for (const name of Object.keys(process.env)) if (!Object.hasOwn(environment, name)) delete process.env[name];
    Object.assign(process.env, environment);
});

function capture() {
    const messages = [];
    return {
        messages,
        deliver: async (message) => { messages.push(message); return { delivered: true, providerMessageId: 'reset-fixture' }; },
    };
}

function parent() {
    return { flow: 'sso', id: 'reset-parent', expiresAt: Date.now() + 60_000 };
}

async function request(email, { deliver, rateSource = '', emailAvailable = true, resetBaseUrl = BASE } = {}) {
    const mail = capture();
    const result = await requestPasswordReset({ parent: parent(), email, rateSource, emailAvailable, resetBaseUrl, deliver: deliver || mail.deliver });
    return { result, mail };
}

function tokenOf(message) {
    const match = TOKEN.exec(String(message?.resetUrl || ''));
    assert.ok(match, `a fragment token is present in ${message?.resetUrl}`);
    return match[1];
}

async function resetRecords() {
    return (await (await getStore()).select('authChallenge', { purpose: 'password-reset' })).objects;
}

function assertNoSecret(serialized, token, password) {
    assert.equal(serialized.includes(token), false, 'the token never reaches durable storage or logs');
    if (password) assert.equal(serialized.includes(password), false, 'the password never reaches durable storage or logs');
}

test('an eligible request mails one fragment link, stores only its digest and logs the address digest', async () => {
    const account = await signUpDirect('reset-owner@example.test');
    const { result, mail } = await request(' Reset-Owner@Example.test ');
    assert.deepEqual(result, { ok: true });
    assert.equal(mail.messages.length, 1);
    const [message] = mail.messages;
    assert.equal(message.to, 'reset-owner@example.test');
    assert.equal(message.expiresInMinutes, RESET_TOKEN_TTL_MS / 60_000);
    assert.match(message.resetUrl, /^http:\/\/127\.0\.0\.1:7000\/service\/auth\/reset\.html#token=/);
    const token = tokenOf(message);

    const records = await resetRecords();
    assert.equal(records.length, 1);
    assert.equal(records[0].subject, account.user.id);
    assert.match(records[0].challengeId, /^reset:[a-f0-9]{64}$/);
    const meta = JSON.parse(records[0].correlationId);
    assert.equal(meta.email, 'reset-owner@example.test');
    assert.equal(meta.generation, 0);
    assert.equal(typeof meta.credentialVersion, 'string');
    assert.deepEqual(meta.flow, 'sso');
    const store = await getStore();
    const emailLog = (await store.select('emailLog')).objects;
    assert.equal(emailLog.length, 1);
    assert.equal(emailLog[0].template, 'password-reset');
    assert.equal(emailLog[0].result, 'accepted');
    assert.notEqual(emailLog[0].toEmailHash, 'reset-owner@example.test');
    const audits = (await store.select('auditEvent', { action: 'auth.password.reset.request' })).objects;
    assert.equal(audits.length, 1);

    const inspected = await inspectPasswordReset({ token });
    assert.equal(inspected.email, 'reset-owner@example.test');
    assert.ok(inspected.expiresAt > Date.now() && inspected.expiresAt <= Date.now() + RESET_TOKEN_TTL_MS);
    assert.deepEqual(inspected.passwordPolicy, { minLength: 15, maxLength: 128, maxRawLength: 1024, normalization: 'NFKC' });
    assert.equal((await resetRecords()).length, 1, 'inspection consumes nothing');
    assertNoSecret(JSON.stringify(await Promise.all(['authChallenge', 'emailLog'].map(async (type) => (await store.select(type)).objects))), token);
});

test('a newer request supersedes the previous link and inspection refuses the old one', async () => {
    await signUpDirect('supersede@example.test');
    const first = await request('supersede@example.test');
    const firstToken = tokenOf(first.mail.messages.at(-1));
    const second = await request('supersede@example.test');
    const secondToken = tokenOf(second.mail.messages.at(-1));
    assert.notEqual(firstToken, secondToken);
    assert.equal((await resetRecords()).length, 1, 'one live token per account');
    await assert.rejects(inspectPasswordReset({ token: firstToken }), { code: 'reset_link_invalid' });
    assert.equal((await inspectPasswordReset({ token: secondToken })).email, 'supersede@example.test');
});

test('ineligible addresses get the uniform success answer without mail while every request spends the send budget', async () => {
    await signUpWithPassword('verified-owner@example.test');
    const blocked = await createUser({ email: 'blocked-reset@example.test', roles: ['user'], emailVerified: true });
    await updateUser(blocked.id, { status: 'blocked' }, { actorId: 'fixture-admin' });
    await createUser({ email: 'passwordless-reset@example.test', emailVerified: true });
    for (const email of ['unknown-reset@example.test', 'blocked-reset@example.test', 'passwordless-reset@example.test']) {
        const { result, mail } = await request(email);
        assert.deepEqual(result, { ok: true }, email);
        assert.equal(mail.messages.length, 0, email);
    }
    assert.equal((await resetRecords()).length, 0);
    // The budget is spent for ineligible probes exactly like a send: five per
    // address and window, then the sixth request is refused.
    const source = 'c'.repeat(64);
    for (let index = 0; index < 5; index += 1) {
        const { result } = await request('budget-probe@example.test', { rateSource: source });
        assert.deepEqual(result, { ok: true });
    }
    await assert.rejects(request('budget-probe@example.test', { rateSource: source }), { code: 'rate_limited' });
});

test('request refusals are typed before any budget or mail work', async () => {
    await signUpDirect('refusal@example.test');
    await assert.rejects(request('not-an-email'), { code: 'invalid_email' });
    await assert.rejects(request('refusal@example.test', { emailAvailable: false }), { code: 'password_reset_unavailable', statusCode: 409 });
    process.env.USERPERSISTO_AUTH_METHODS = 'emailCode';
    try {
        await assert.rejects(request('refusal@example.test'), { code: 'auth_method_disabled', statusCode: 404 });
    } finally {
        delete process.env.USERPERSISTO_AUTH_METHODS;
    }
});

test('delivery outcomes stay honest and only the exact development flag prints the link', async () => {
    await signUpDirect('delivery@example.test');
    const failed = capture();
    await assert.rejects(request('delivery@example.test', { deliver: async () => ({ delivered: false }) }), { code: 'delivery_failed', statusCode: 502 });
    assert.equal((await resetRecords()).length, 0, 'a known provider failure deletes the just-issued record');
    assert.equal((await (await getStore()).select('emailLog')).objects.at(-1).result, 'failed');
    assert.equal((await resetRecords()).length, 0);
    assert.equal(failed.messages.length, 0);

    resetAuthLimitsForTests();
    const unknown = await request('delivery@example.test', { deliver: async () => { throw new Error('transport closed'); } });
    assert.deepEqual(unknown.result, { ok: true });
    assert.equal((await resetRecords()).length, 1, 'an unknown transport outcome keeps the record for a retry');
    assert.equal((await (await getStore()).select('emailLog')).objects.at(-1).result, 'unknown');

    const warnings = [];
    const originalWarn = console.warn;
    console.warn = (...parts) => { warnings.push(parts.join(' ')); };
    try {
        for (const value of [undefined, 'TRUE', '1', ' false ']) {
            if (value === undefined) delete process.env.USERPERSISTO_DEV_BOOTSTRAP;
            else process.env.USERPERSISTO_DEV_BOOTSTRAP = value;
            resetAuthLimitsForTests();
            await assert.rejects(request('delivery@example.test', { deliver: async () => ({ delivered: false }) }), { code: 'delivery_failed' });
        }
        resetAuthLimitsForTests();
        process.env.USERPERSISTO_DEV_BOOTSTRAP = 'true';
        const development = await request('delivery@example.test', { deliver: async () => ({ delivered: false }) });
        assert.deepEqual(development.result, { ok: true });
        assert.ok(warnings.at(-1).startsWith('[userPersisto] DEVELOPMENT password reset link for delivery@example.test: '));
        assert.equal((await resetRecords()).length, 1);
        assert.equal((await (await getStore()).select('emailLog')).objects.at(-1).result, 'development-log');
    } finally {
        console.warn = originalWarn;
    }
});

test('completing a reset replaces the password, verifies the mailbox, advances the generation and clears the failure throttle', async () => {
    const account = await signUpDirect('complete-owner@example.test');
    await assert.rejects(loginWithUserPassword({ email: account.user.email, password: 'definitely wrong password' }), { code: 'authentication_failed' });
    assert.equal((await (await getStore()).select('authThrottle')).totalCount, 1, 'the failed login left a throttle record');

    const { mail } = await request('complete-owner@example.test');
    const token = tokenOf(mail.messages.at(-1));
    const replacement = newTestPassword();
    assert.deepEqual(await completePasswordReset({ token, password: replacement, passwordConfirmation: replacement }), { ok: true });
    const updated = await getUserById(account.user.id);
    assert.ok(updated.emailVerifiedAt, 'following the emailed link proves the mailbox');
    assert.equal(updated.contactEmail, account.user.email);
    assert.equal(updated.authGeneration, 1);
    assert.equal((await resetRecords()).length, 0, 'every reset record of the account is consumed');
    assert.equal((await (await getStore()).select('authThrottle')).totalCount, 0, 'the address failure throttle is cleared');
    await assert.rejects(loginWithUserPassword({ email: account.user.email, password: account.password }), { code: 'authentication_failed' });
    assert.equal((await loginWithUserPassword({ email: account.user.email, password: replacement })).user.id, account.user.id);
    const audits = (await (await getStore()).select('auditEvent', { action: 'auth.password.reset' })).objects;
    assert.equal(audits.length, 1);
    assertNoSecret(JSON.stringify(await (await getStore()).select('auditEvent', {}, { start: 0, pageSize: 500 })), token, replacement);
});

test('invalid, expired, used, superseded, rebound and refused links all answer one message', async () => {
    const account = await signUpDirect('invalid-links@example.test');
    let hashes = 0;
    setKdfObserverForTests(() => { hashes += 1; });
    await assert.rejects(completePasswordReset({ token: '', password: newTestPassword(), passwordConfirmation: newTestPassword() }), { code: 'reset_link_invalid' });
    await assert.rejects(completePasswordReset({ token: 'x'.repeat(43), password: newTestPassword(), passwordConfirmation: newTestPassword() }), { code: 'reset_link_invalid' });
    assert.equal(hashes, 0, 'a malformed or unknown token never reaches the KDF');
    setKdfObserverForTests(null);

    resetAuthLimitsForTests();
    const expired = await request('invalid-links@example.test');
    const expiredToken = tokenOf(expired.mail.messages.at(-1));
    const record = (await resetRecords())[0];
    await (await getStore()).updateAuthChallenge(record.id, { expiresAt: new Date(Date.now() - 1000).toISOString() });
    await assert.rejects(completePasswordReset({ token: expiredToken, password: newTestPassword(), passwordConfirmation: newTestPassword() }), { code: 'reset_link_invalid' });
    assert.equal((await resetRecords()).length, 0, 'a stale record is deleted on completion');

    resetAuthLimitsForTests();
    const used = await request('invalid-links@example.test');
    const usedToken = tokenOf(used.mail.messages.at(-1));
    const first = newTestPassword();
    assert.deepEqual(await completePasswordReset({ token: usedToken, password: first, passwordConfirmation: first }), { ok: true });
    await assert.rejects(completePasswordReset({ token: usedToken, password: newTestPassword(), passwordConfirmation: newTestPassword() }), { code: 'reset_link_invalid' });

    resetAuthLimitsForTests();
    const superseded = await request('invalid-links@example.test');
    const oldToken = tokenOf(superseded.mail.messages.at(-1));
    resetAuthLimitsForTests();
    const winning = await request('invalid-links@example.test');
    const winningToken = tokenOf(winning.mail.messages.at(-1));
    await assert.rejects(completePasswordReset({ token: oldToken, password: newTestPassword(), passwordConfirmation: newTestPassword() }), { code: 'reset_link_invalid' });
    const rebound = newTestPassword();
    assert.deepEqual(await completePasswordReset({ token: winningToken, password: rebound, passwordConfirmation: rebound }), { ok: true });

    // A changed credential version makes the recorded proof stale.
    resetAuthLimitsForTests();
    const changed = await request('invalid-links@example.test');
    const changedToken = tokenOf(changed.mail.messages.at(-1));
    const verifier = await hashSecret('externally replaced credential value');
    await serializePersisted('users', async () => {
        const store = await getStore();
        await commitStagedPersistence(() => stagePasswordCredential(store, { userId: account.user.id, verifier }));
    });
    await assert.rejects(completePasswordReset({ token: changedToken, password: newTestPassword(), passwordConfirmation: newTestPassword() }), { code: 'reset_link_invalid' });
    assert.equal((await resetRecords()).length, 0, 'a rebound record is stale and deleted');

    // A blocked account refuses without deleting its link.
    resetAuthLimitsForTests();
    const blocked = await request('invalid-links@example.test');
    const blockedToken = tokenOf(blocked.mail.messages.at(-1));
    await createUser({ email: 'spare-admin@example.test', roles: ['admin'], emailVerified: true });
    await updateUser(account.user.id, { status: 'blocked' }, { actorId: 'fixture-admin' });
    await assert.rejects(completePasswordReset({ token: blockedToken, password: newTestPassword(), passwordConfirmation: newTestPassword() }), { code: 'reset_link_invalid' });
    assert.equal((await resetRecords()).length, 1, 'a blocked account refuses without deleting the record');
    await updateUser(account.user.id, { status: 'active' }, { actorId: 'fixture-admin' });

    // A disabled password method refuses without deleting its link.
    process.env.USERPERSISTO_AUTH_METHODS = 'emailCode';
    try {
        await assert.rejects(completePasswordReset({ token: blockedToken, password: newTestPassword(), passwordConfirmation: newTestPassword() }), { code: 'reset_link_invalid' });
        assert.equal((await resetRecords()).length, 1, 'a disabled method refuses without deleting the record');
    } finally {
        delete process.env.USERPERSISTO_AUTH_METHODS;
    }
});

test('input refusals keep the link usable and two concurrent completions write once', async () => {
    const account = await signUpDirect('concurrent-reset@example.test');
    const { mail } = await request('concurrent-reset@example.test');
    const token = tokenOf(mail.messages.at(-1));
    const chosen = newTestPassword();
    await assert.rejects(completePasswordReset({ token, password: 'short', passwordConfirmation: 'short' }), { code: 'invalid_password', reason: 'too_short' });
    await assert.rejects(completePasswordReset({ token, password: chosen, passwordConfirmation: `${chosen} other` }), { code: 'password_mismatch' });
    assert.equal((await resetRecords()).length, 1, 'input refusals never touch the token');
    assert.deepEqual(await inspectPasswordReset({ token }).then((value) => value.email), 'concurrent-reset@example.test');

    const first = newTestPassword();
    const second = newTestPassword();
    const hold = Promise.withResolvers();
    let entered = 0;
    setKdfObserverForTests(async ({ purpose }) => {
        if (purpose !== 'hash') return;
        entered += 1;
        if (entered === 2) hold.resolve();
        await hold.promise;
    });
    const outcomes = await Promise.allSettled([
        completePasswordReset({ token, password: first, passwordConfirmation: first }),
        completePasswordReset({ token, password: second, passwordConfirmation: second }),
    ]);
    setKdfObserverForTests(null);
    assert.equal(outcomes.filter((outcome) => outcome.status === 'fulfilled').length, 1);
    assert.equal(outcomes.filter((outcome) => outcome.reason?.code === 'reset_link_invalid').length, 1);
    assert.equal((await resetRecords()).length, 0);
    const updated = await getUserById(account.user.id);
    assert.equal(updated.authGeneration, 1, 'exactly one completion advanced the generation');
    const matches = await Promise.all([first, second].map(async (candidate) => {
        try { await loginWithUserPassword({ email: account.user.email, password: candidate }); return true; } catch { return false; }
    }));
    assert.equal(matches.filter(Boolean).length, 1, 'exactly one of the two submitted passwords is usable');
});

test('the per-source status budget bounds lookups for one source without affecting another', async () => {
    const token = 'A'.repeat(43);
    const source = 'd'.repeat(64);
    for (let index = 0; index < 20; index += 1) {
        await assert.rejects(inspectPasswordReset({ token, rateSource: source }), { code: 'reset_link_invalid' });
    }
    await assert.rejects(inspectPasswordReset({ token, rateSource: source }), { code: 'rate_limited' });
    await assert.rejects(inspectPasswordReset({ token, rateSource: 'e'.repeat(64) }), { code: 'reset_link_invalid' });
});

test('a reset with a stale generation is refused and cleaned, and the snapshot and logs never hold the token or password', async () => {
    const account = await signUpDirect('generation-reset@example.test');
    const { mail } = await request('generation-reset@example.test');
    const token = tokenOf(mail.messages.at(-1));
    await serializePersisted('users', async () => { await stageCredentialGenerationAdvance(account.user.id); });
    const chosen = newTestPassword();
    await assert.rejects(completePasswordReset({ token, password: chosen, passwordConfirmation: chosen }), { code: 'reset_link_invalid' });
    assert.equal((await resetRecords()).length, 0, 'a generation mismatch is stale and deleted');
    const store = await getStore();
    const snapshot = JSON.stringify(await Promise.all(['user', 'authMethod', 'authChallenge', 'emailLog', 'auditEvent', 'authThrottle', 'systemSetting']
        .map(async (type) => (await store.select(type)).objects)));
    assertNoSecret(snapshot, token, chosen);
});

async function assertConcurrentCompletionsLeaveStoreUsable(concurrency, email, invalidate) {
    const account = await signUpDirect(email);
    const { mail } = await request(email);
    const token = tokenOf(mail.messages.at(-1));
    await invalidate(account);
    const chosen = newTestPassword();
    const outcomes = await Promise.allSettled(Array.from({ length: concurrency }, () =>
        completePasswordReset({ token, password: chosen, passwordConfirmation: chosen })));
    assert.deepEqual(outcomes.map((outcome) => [outcome.reason?.code, outcome.reason?.statusCode]), Array(concurrency).fill(['reset_link_invalid', 400]));
    assert.equal((await resetRecords()).length, 0);

    resetAuthLimitsForTests();
    const next = await request(email);
    const nextToken = tokenOf(next.mail.messages.at(-1));
    const replacement = newTestPassword();
    assert.deepEqual(await completePasswordReset({ token: nextToken, password: replacement, passwordConfirmation: replacement }), { ok: true });
    assert.equal((await loginWithUserPassword({ email, password: replacement })).user.id, account.user.id);
}

for (const concurrency of [3, 6]) {
    test(`${concurrency} concurrent completions of one expired link all refuse and leave the store usable`, () =>
        assertConcurrentCompletionsLeaveStoreUsable(concurrency, 'expired-concurrent@example.test', async () => {
            const store = await getStore();
            const [record] = await resetRecords();
            await commitStagedPersistence(() => store.updateAuthChallenge(record.id, { expiresAt: new Date(Date.now() - 1000).toISOString() }));
        }));

    test(`${concurrency} concurrent completions of one stale link all refuse and leave the store usable`, () =>
        assertConcurrentCompletionsLeaveStoreUsable(concurrency, 'stale-concurrent@example.test', async (account) => {
            await serializePersisted('users', () => commitStagedPersistence(() => stageAuthGenerationIncrement(account.user.id)));
        }));
}

test('a delivery that fails after a newer request superseded its record answers delivery_failed and leaves the store usable', async () => {
    await signUpDirect('superseded-delivery@example.test');
    const held = Promise.withResolvers();
    const entered = Promise.withResolvers();
    const slow = request('superseded-delivery@example.test', {
        deliver: async () => { entered.resolve(); await held.promise; return { delivered: false }; },
    });
    await entered.promise;
    resetAuthLimitsForTests();
    const newer = await request('superseded-delivery@example.test');
    held.resolve();
    await assert.rejects(slow, { code: 'delivery_failed', statusCode: 502 });
    assert.equal((await resetRecords()).length, 1, 'the newer link survives the older failed delivery');
    const replacement = newTestPassword();
    const token = tokenOf(newer.mail.messages.at(-1));
    assert.deepEqual(await completePasswordReset({ token, password: replacement, passwordConfirmation: replacement }), { ok: true });
});

test('the reset email log row is committed with the request, and a failure to write it does not fail an accepted delivery', async () => {
    await signUpDirect('email-log@example.test');
    const { result } = await request('email-log@example.test');
    assert.deepEqual(result, { ok: true });
    const snapshot = JSON.parse(JSON.parse(await readFile(join(folder, '.userpersisto.snapshot.json'), 'utf8')).payload);
    assert.equal(Object.values(snapshot).filter((object) => object?.template === 'password-reset').length, 1,
        'the row is durable without waiting for an unrelated commit');

    resetAuthLimitsForTests();
    setStoreFaultInjectorForTests(async (phase, name) => {
        if (phase === 'before' && name === 'createEmailLog') throw new Error('injected email log failure');
    });
    const failing = await request('email-log@example.test');
    assert.deepEqual(failing.result, { ok: true });
    assert.equal(failing.mail.messages.length, 1);
});

test('a Router that has not registered the reset tool answers delivery_failed and keeps no record', async () => {
    await signUpDirect('router-denied@example.test');
    const denied = async () => ({
        callTool: async () => { throw Object.assign(new Error('Access denied'), { code: -32003, data: { code: 'AGENT_POLICY_DENIED' } }); },
        close: async () => {},
    });
    await assert.rejects(request('router-denied@example.test', { deliver: (message) => sendPasswordResetEmail(message, { createClient: denied }) }),
        { code: 'delivery_failed', statusCode: 502 });
    assert.equal((await resetRecords()).length, 0);
    assert.equal((await (await getStore()).select('emailLog')).objects.at(-1).result, 'failed');
});
