import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { ensureSeedData } from '../lib/bootstrap.mjs';
import { getUserByEmail, listUsers } from '../lib/users.mjs';
import { getInstallationSetup } from '../lib/setup.mjs';
import { createLoginRequest, consumeAuthCode } from '../lib/sso.mjs';
import { getStore, resetStoreForTests } from '../lib/store.mjs';
import { updateAuthPolicy } from '../lib/policy.mjs';
import { setKdfObserverForTests } from '../lib/auth/password.mjs';
import { loginWithUserPassword } from '../lib/auth/userPassword.mjs';
import { startService } from '../service/index.mjs';
import { CookieBrowser } from './helpers/googleProvider.mjs';
import * as setup from './helpers/setup.mjs';

async function fixture(fn) {
    const environment = { ...process.env };
    const folder = await mkdtemp(join(tmpdir(), 'userpersisto-signup-http-'));
    process.env.PERSISTENCE_FOLDER = folder;
    process.env.USERPERSISTO_SETTINGS_KEY = 'signup-http-settings-key';
    for (const name of ['USERPERSISTO_AUTH_METHODS', 'USERPERSISTO_SELF_REGISTRATION_ENABLED', 'USERPERSISTO_DEV_BOOTSTRAP']) delete process.env[name];
    setup.resetAuthLimitsForTests();
    const mail = [];
    // Delivery outcome is chosen per message by the test: accepted, failed or a thrown transport error.
    let outcome = 'accepted';
    let server;
    try {
        await ensureSeedData();
        server = startService({ port: 0, host: '127.0.0.1' }, { deliverEmail: async (message) => {
            mail.push(message);
            if (outcome === 'unknown') throw new Error('transport closed');
            return outcome === 'failed' ? { delivered: false } : { delivered: true, providerMessageId: 'signup-http-fixture' };
        } });
        if (!server.listening) await once(server, 'listening');
        const base = `http://127.0.0.1:${server.address().port}`;
        const flow = async ({ expiresInMs } = {}) => {
            const request = await createLoginRequest({ redirectUri: `${base}/auth/callback` });
            if (expiresInMs) {
                const store = await getStore();
                const record = await store.getSsoLoginRequestByProviderState(request.providerState);
                await store.updateSsoLoginRequest(record.id, { expiresAt: new Date(Date.now() + expiresInMs).toISOString() });
            }
            const browser = new CookieBrowser();
            const post = async (path, body = {}, headers = {}) => {
                const response = await browser.fetch(`${base}/service/auth/${path}`, {
                    method: 'POST', headers: { 'content-type': 'application/json', origin: base, ...headers },
                    body: JSON.stringify({ requestId: request.providerState, state: 'signup-http', ...body }),
                });
                const text = await response.text();
                return { status: response.status, body: JSON.parse(text), text, headers: response.headers };
            };
            return { request, browser, post };
        };
        await fn({ base, mail, flow, deliver: (value) => { outcome = value; } });
    } finally {
        setKdfObserverForTests(null);
        if (server?.listening) { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); }
        await resetStoreForTests();
        await rm(folder, { recursive: true, force: true });
        for (const name of Object.keys(process.env)) if (!Object.hasOwn(environment, name)) delete process.env[name];
        Object.assign(process.env, environment);
    }
}

function withClock(offsetMs, operation) {
    const realNow = Date.now;
    Date.now = () => realNow() + offsetMs;
    return Promise.resolve().then(operation).finally(() => { Date.now = realNow; });
}

const secret = () => setup.newTestPassword();

test('signup routes validate transport, bounds and passwords before staging anything', () => fixture(async ({ base, mail, flow }) => {
    const { post, browser, request } = await flow();
    const password = secret();
    const refusals = [
        [{ email: 'bad-address', password, passwordConfirmation: password }, 400, 'invalid_email'],
        [{ email: `${'a'.repeat(315)}@x.test`, password, passwordConfirmation: password }, 400, 'invalid_request'],
        [{ email: 'owner@example.test', password, passwordConfirmation: `${password}x` }, 400, 'password_mismatch'],
        [{ email: 'owner@example.test', password: 'short password', passwordConfirmation: 'short password' }, 400, 'invalid_password', 'too_short'],
        [{ email: 'owner@example.test', password: 'p'.repeat(1025), passwordConfirmation: 'p'.repeat(1025) }, 400, 'invalid_password', 'too_long'],
        [{ email: 'owner@example.test', password: 'owner@example.test', passwordConfirmation: 'owner@example.test' }, 400, 'invalid_password', 'equals_email'],
        [{ email: 'owner@example.test', password: 42, passwordConfirmation: 42 }, 400, 'invalid_password', 'too_short'],
        [{ email: 'owner@example.test', password: 'tab\tseparated password', passwordConfirmation: 'tab\tseparated password' }, 400, 'invalid_password', 'invalid_characters'],
    ];
    for (const [body, status, error, reason] of refusals) {
        const response = await post('signup/start', body);
        assert.deepEqual([response.status, response.body.error, response.body.reason], [status, error, reason], JSON.stringify(body).slice(0, 80));
        assert.equal(response.text.includes(String(body.password)), false, 'refusals never echo a password');
    }
    const oversized = await browser.fetch(`${base}/service/auth/signup/start`, { method: 'POST', headers: { 'content-type': 'application/json', origin: base },
        body: JSON.stringify({ requestId: request.providerState, email: 'owner@example.test', password: 'x'.repeat(70_000) }) });
    assert.equal(oversized.status, 413);
    const malformed = await browser.fetch(`${base}/service/auth/signup/start`, { method: 'POST', headers: { 'content-type': 'application/json', origin: base }, body: '{' });
    assert.deepEqual([malformed.status, (await malformed.json()).error], [400, 'invalid_json']);
    const fresh = await flow();
    for (const path of ['signup/resend', 'signup/email', 'signup/verify']) {
        // Without a browser proof there is no attempt to address.
        const unbound = await fresh.post(path, { email: 'owner@example.test', code: '123456' });
        assert.deepEqual([unbound.status, unbound.body.error], [400, 'attempt_invalid'], path);
        // A proven browser with nothing staged must choose a password first.
        const unstaged = await post(path, { email: 'owner@example.test', code: '123456' });
        assert.deepEqual([unstaged.status, unstaged.body.error], [409, 'signup_restart_required'], path);
    }
    assert.equal(mail.length, 0);
    assert.equal((await listUsers()).totalCount, 0);
    assert.equal((await getStore().then((store) => store.select('authAttempt'))).objects.length, 0, 'nothing was staged');
}));

test('R6 over HTTP: a failed delivery keeps the staged verifier and Send again needs no password', () => fixture(async ({ mail, flow, deliver }) => {
    let hashes = 0;
    setKdfObserverForTests(({ purpose }) => { if (purpose === 'hash') hashes += 1; });
    const { post, request } = await flow();
    const password = secret();
    deliver('failed');
    const staged = await post('signup/start', { email: 'retry@example.test', password, passwordConfirmation: password });
    assert.equal(staged.status, 200, staged.text);
    assert.equal(staged.body.challenge.delivery, 'failed');
    assert.ok(staged.body.challenge.resendAt <= Date.now());
    assert.equal(staged.headers.getSetCookie().some((cookie) => cookie.startsWith('up_browser=') && /HttpOnly/.test(cookie) && /SameSite=Strict/.test(cookie)), true);
    const refusedCode = await post('signup/verify', { code: mail.at(-1).code });
    assert.deepEqual([refusedCode.status, refusedCode.body.error], [409, 'attempt_invalid'], 'an undelivered code is not accepted');
    const resumed = await post('attempt');
    assert.deepEqual([resumed.body.attempt.signupPending, resumed.body.attempt.challenge.delivery], [true, 'failed']);
    deliver('unknown');
    const unknown = await post('signup/resend');
    assert.deepEqual([unknown.status, unknown.body.challenge.delivery], [200, 'unknown']);
    const tooSoon = await post('signup/resend');
    assert.deepEqual([tooSoon.status, tooSoon.body.error], [429, 'resend_too_soon']);
    assert.ok(tooSoon.body.retryAfter > 0 && tooSoon.headers.get('retry-after'));
    deliver('accepted');
    const again = await withClock(61_000, () => post('signup/resend'));
    assert.deepEqual([again.status, again.body.challenge.delivery], [200, 'accepted']);
    assert.equal(hashes, 1, 'exactly one KDF across the retries');
    const verified = await withClock(61_000, () => post('signup/verify', { code: mail.at(-1).code }));
    assert.equal(verified.status, 200, verified.text);
    assert.deepEqual([verified.body.created, verified.body.initialAdministrator], [true, true]);
    const consumed = await consumeAuthCode({ providerState: request.providerState, code: verified.body.code });
    assert.equal((await loginWithUserPassword({ email: 'retry@example.test', password })).user.id, consumed.user.id);
}));

test('change email keeps the verifier, refuses an owned address and a cancelled signup must choose its password again', () => fixture(async ({ mail, flow }) => {
    const owner = await setup.signUpWithPassword('owner@example.test');
    const { post } = await flow();
    const password = secret();
    assert.equal((await post('signup/start', { email: 'typo@example.tset', password, passwordConfirmation: password })).status, 200);
    const owned = await post('signup/email', { email: owner.user.email });
    assert.deepEqual([owned.status, owned.body.error], [409, 'account_exists']);
    assert.deepEqual([(await post('signup/email', { email: 'not-an-address' })).body.error], ['invalid_email']);
    const changed = await post('signup/email', { email: 'fixed@example.test', password: 'ignored even if sent', passwordConfirmation: 'ignored' });
    assert.deepEqual([changed.status, changed.body.challenge.email, mail.at(-1).to], [200, 'fixed@example.test', 'fixed@example.test']);
    const cancelled = await post('attempt/cancel');
    assert.deepEqual([cancelled.status, cancelled.body.status], [200, 'cancelled']);
    for (const path of ['signup/resend', 'signup/email', 'signup/verify']) {
        const restart = await post(path, { email: 'fixed@example.test', code: mail.at(-1).code });
        assert.deepEqual([restart.status, restart.body.error], [409, 'signup_restart_required'], path);
    }
    assert.equal(await getUserByEmail('fixed@example.test'), null);
    const restarted = await post('signup/start', { email: 'fixed@example.test', password, passwordConfirmation: password });
    assert.equal(restarted.status, 200);
    const verified = await post('signup/verify', { code: mail.at(-1).code });
    assert.deepEqual([verified.status, verified.body.initialAdministrator], [200, false]);
}));

test('the send cap, registration policy and method policy refuse signup with specific codes', () => fixture(async ({ mail, flow }) => {
    const owner = await setup.signUpWithPassword('owner@example.test');
    const capped = await flow({ expiresInMs: 10 * 60_000 });
    const password = secret();
    assert.equal((await capped.post('signup/start', { email: 'capped@example.test', password, passwordConfirmation: password })).status, 200);
    for (let send = 1; send < 5; send += 1) {
        assert.equal((await withClock(61_000 * send, () => capped.post('signup/resend'))).status, 200);
    }
    const limit = await withClock(61_000 * 5, () => capped.post('signup/resend'));
    assert.deepEqual([limit.status, limit.body.error, limit.body.reason], [429, 'rate_limited', 'send_limit']);
    assert.equal(mail.filter((message) => message.to === 'capped@example.test').length, 5);

    await updateAuthPolicy({ selfRegistrationEnabled: false }, { actorId: owner.user.id, emailStatus: async () => ({ available: true }) });
    const closed = await flow();
    const disabled = await closed.post('signup/start', { email: 'closed@example.test', password, passwordConfirmation: password });
    assert.deepEqual([disabled.status, disabled.body.error], [403, 'registration_disabled']);
    const existing = await closed.post('signup/start', { email: owner.user.email, password, passwordConfirmation: password });
    assert.deepEqual([existing.status, existing.body.error], [403, 'registration_disabled'], 'closed registration discloses no ownership');
    await updateAuthPolicy({ selfRegistrationEnabled: true, enabledAuthMethods: ['emailCode', 'google'] }, { actorId: owner.user.id, emailStatus: async () => ({ available: true }) });
    const noPasswords = await flow();
    const method = await noPasswords.post('signup/start', { email: 'no-passwords@example.test', password, passwordConfirmation: password });
    assert.deepEqual([method.status, method.body.error], [404, 'auth_method_disabled']);
}));

test('a parent expiring while the password is chosen or the code is awaited ends the signup', () => fixture(async ({ mail, flow }) => {
    const password = secret();
    // S5: the parent expires before Create account is submitted.
    const choosing = await flow({ expiresInMs: 30_000 });
    assert.equal((await choosing.post('attempt')).status, 200);
    const late = await withClock(31_000, () => choosing.post('signup/start', { email: 'late@example.test', password, passwordConfirmation: password }));
    assert.deepEqual([late.status, late.body.error], [400, 'login_request_expired']);
    // S6: the parent expires while the code is awaited.
    const waiting = await flow({ expiresInMs: 30_000 });
    const staged = await waiting.post('signup/start', { email: 'waiting@example.test', password, passwordConfirmation: password });
    assert.ok(staged.body.challenge.expiresAt <= Date.now() + 30_000, 'the code never outlives its parent');
    for (const path of ['signup/verify', 'signup/resend', 'signup/email']) {
        const expired = await withClock(31_000, () => waiting.post(path, { code: mail.at(-1).code, email: 'other@example.test' }));
        assert.deepEqual([expired.status, expired.body.error], [400, 'login_request_expired'], path);
    }
    assert.equal(await getUserByEmail('waiting@example.test'), null);
    assert.equal((await getInstallationSetup()).complete, false);
}));

test('the per-source signup KDF budget refuses before hashing', () => fixture(async ({ flow }) => {
    let hashes = 0;
    setKdfObserverForTests(({ purpose }) => { if (purpose === 'hash') hashes += 1; });
    const rateSource = { 'x-ploinky-rate-source': 'd'.repeat(64) };
    for (let index = 0; index < 10; index += 1) {
        const password = secret();
        const { post } = await flow();
        assert.equal((await post('signup/start', { email: `budget-${index}@example.test`, password, passwordConfirmation: password }, rateSource)).status, 200);
    }
    assert.equal(hashes, 10);
    const password = secret();
    const refused = await (await flow()).post('signup/start', { email: 'budget-10@example.test', password, passwordConfirmation: password }, rateSource);
    assert.deepEqual([refused.status, refused.body.error], [429, 'rate_limited']);
    assert.equal(hashes, 10);
    const otherSource = await (await flow()).post('signup/start', { email: 'budget-other@example.test', password, passwordConfirmation: password }, { 'x-ploinky-rate-source': 'e'.repeat(64) });
    assert.equal(otherSource.status, 200);
}));
