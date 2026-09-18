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
import { startService } from '../service/index.mjs';
import { CookieBrowser } from './helpers/googleProvider.mjs';
import * as setup from './helpers/setup.mjs';

async function fixture(fn) {
    const environment = { ...process.env };
    const folder = await mkdtemp(join(tmpdir(), 'userpersisto-register-http-'));
    process.env.PERSISTENCE_FOLDER = folder;
    process.env.USERPERSISTO_SETTINGS_KEY = 'test-settings-key';
    for (const name of ['USERPERSISTO_AUTH_METHODS', 'USERPERSISTO_SELF_REGISTRATION_ENABLED', 'USERPERSISTO_SIGNUP_EMAIL_VERIFICATION_REQUIRED']) delete process.env[name];
    setup.resetAuthLimitsForTests();
    const mail = [];
    let server;
    try {
        await ensureSeedData();
        server = startService({ port: 0, host: '127.0.0.1' }, { deliverEmail: async (message) => { mail.push(message); return { delivered: true, providerMessageId: 'fixture' }; } });
        if (!server.listening) await once(server, 'listening');
        const base = `http://127.0.0.1:${server.address().port}`;
        const post = (browser, path, body, headers = {}) => browser.fetch(`${base}/service/auth/${path}`, {
            method: 'POST', headers: { 'content-type': 'application/json', origin: base, ...headers }, body: JSON.stringify(body),
        });
        await fn({ base, mail, post });
    } finally {
        if (server?.listening) { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); }
        await resetStoreForTests();
        await rm(folder, { recursive: true, force: true });
        for (const name of Object.keys(process.env)) if (!Object.hasOwn(environment, name)) delete process.env[name];
        Object.assign(process.env, environment);
    }
}

test('retired administrator and registration routes are gone and malformed bodies fail before any setup decision', () => fixture(async ({ base }) => {
    for (const route of ['register', 'admin/login', 'totp/setup']) {
        const response = await fetch(`${base}/service/auth/${route}`, { method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ email: 'owner@example.test', password: 'admin' }) });
        assert.equal(response.status, 404, route);
        assert.equal((await response.json()).error, 'not_found');
    }
    for (const payload of [null, [], 'credentials', 42, true]) {
        const response = await fetch(`${base}/service/auth/attempt`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) });
        assert.equal(response.status, 400);
        assert.equal((await response.json()).error, 'invalid_json');
    }
    assert.equal((await getInstallationSetup()).complete, false);
}));

test('unclaimed setup rejects arbitrary passwords and ignores the retired password override', () => fixture(async ({ base, post }) => {
    process.env.USERPERSISTO_ADMIN_PASSWORD = 'fixture-retired-variable-value';
    const request = await createLoginRequest({ redirectUri: `${base}/auth/callback` });
    const browser = new CookieBrowser();
    const attempt = await (await post(browser, 'attempt', { requestId: request.providerState })).json();
    for (const retired of ['adminPassword', 'googleOnly']) assert.equal(Object.hasOwn(attempt, retired), false, retired);
    for (const email of ['owner@example.test', 'admin@example.test', 'administrator@example.test']) {
        for (const password of ['ADMIN', process.env.USERPERSISTO_ADMIN_PASSWORD, '']) {
            const refused = await post(browser, 'password/login', { requestId: request.providerState, state: 'x', email, password });
            assert.deepEqual([refused.status, await refused.json()], [401, { ok: false, error: 'authentication_failed' }]);
        }
    }
    const legacy = await post(browser, 'email-code/start', { requestId: request.providerState, email: 'owner@example.test', purpose: 'register' });
    assert.deepEqual([legacy.status, (await legacy.json()).error], [400, 'invalid_request'], 'email codes never register');
    assert.equal((await getInstallationSetup()).complete, false);
    assert.equal((await listUsers()).totalCount, 0);
    assert.equal((await (await getStore()).select('ssoAuthCode')).objects.length, 0);
}));

test('HTTP signup claims the first administrator through the browser-bound attempt and signs in automatically', () => fixture(async ({ base, mail, post }) => {
    await updateAuthPolicy({ signupEmailVerificationRequired: true }, { emailStatus: async () => ({ available: true }) });
    const request = await createLoginRequest({ redirectUri: `${base}/auth/callback` });
    const browser = new CookieBrowser();
    const attempt = await post(browser, 'attempt', { requestId: request.providerState, state: 'router-core-state' });
    assert.equal(attempt.status, 200);
    const cookie = attempt.headers.getSetCookie().find((value) => value.startsWith('up_browser='));
    assert.match(cookie, /HttpOnly/);
    assert.match(cookie, /SameSite=Strict/);
    assert.match(cookie, /Path=\/service\//);
    const state = await attempt.json();
    assert.deepEqual([state.setupComplete, state.registration, state.signup, state.methods.password], [false, true, { email: true, verification: 'required', google: true }, true]);
    assert.deepEqual(state.passwordPolicy, { minLength: 1, maxLength: 128, maxRawLength: 1024, normalization: 'NFKC' });
    assert.ok(state.expiresAt > Date.now());
    const discovered = await (await post(browser, 'discover', { requestId: request.providerState, email: 'owner@example.test' })).json();
    assert.deepEqual([discovered.exists, discovered.methods], [false, { password: false, emailCode: false, passkey: false, totp: false }]);
    const password = setup.newTestPassword();
    const started = await post(browser, 'signup/start', { requestId: request.providerState, email: 'owner@example.test', password, passwordConfirmation: password });
    assert.equal(started.status, 200, await started.clone().text());
    const text = await started.text();
    const body = JSON.parse(text);
    assert.deepEqual([body.challenge.purpose, body.challenge.delivery, body.challenge.email], ['register', 'accepted', 'owner@example.test']);
    assert.equal(text.includes(mail.at(-1).code), false);
    assert.equal(text.includes(password), false);
    assert.equal(mail.at(-1).purpose, 'signup-verification');
    assert.equal(await getUserByEmail('owner@example.test'), null, 'no account before proof');
    const resumed = await (await post(browser, 'attempt', { requestId: request.providerState })).json();
    assert.deepEqual([resumed.attempt.signupPending, resumed.attempt.challenge.purpose], [true, 'register']);
    // Another browser holding the code cannot use this attempt.
    const stolen = await post(new CookieBrowser(), 'signup/verify', { requestId: request.providerState, state: 'router-core-state', code: mail.at(-1).code });
    assert.equal(stolen.status, 400);
    const verified = await post(browser, 'signup/verify', { requestId: request.providerState, state: 'router-core-state', code: mail.at(-1).code });
    assert.equal(verified.status, 200, await verified.clone().text());
    const completion = await verified.json();
    assert.deepEqual([completion.created, completion.initialAdministrator, completion.state, completion.redirectUri],
        [true, true, 'router-core-state', `${base}/auth/callback`]);
    // A lost response replays the same unconsumed handoff to the same browser only.
    const replay = await (await post(browser, 'signup/verify', { requestId: request.providerState, state: 'router-core-state', code: '000000' })).json();
    assert.deepEqual([replay.code, replay.replayed], [completion.code, true]);
    assert.equal((await post(new CookieBrowser(), 'signup/verify', { requestId: request.providerState, state: 'router-core-state', code: mail.at(-1).code })).status, 400);
    const consumed = await consumeAuthCode({ providerState: request.providerState, code: completion.code });
    assert.deepEqual(consumed.roles, ['admin']);
    const record = await getInstallationSetup();
    assert.deepEqual([record.initialAdministratorId, record.method], [consumed.user.id, 'passwordSignup']);
    const afterConsumption = await post(browser, 'signup/verify', { requestId: request.providerState, state: 'router-core-state', code: '000000' });
    assert.equal(afterConsumption.status, 400);
    assert.equal((await afterConsumption.json()).error, 'login_request_invalid');
    // The chosen password now signs the administrator in without any code.
    const next = await createLoginRequest({ redirectUri: `${base}/auth/callback` });
    const sentBefore = mail.length;
    const login = await post(new CookieBrowser(), 'password/login', { requestId: next.providerState, state: 'next-state', email: 'OWNER@example.test', password });
    assert.equal(login.status, 200, await login.clone().text());
    const signedIn = await login.json();
    assert.deepEqual([signedIn.state, signedIn.redirectUri], ['next-state', `${base}/auth/callback`]);
    assert.equal((await consumeAuthCode({ providerState: next.providerState, code: signedIn.code })).user.id, consumed.user.id);
    assert.equal(mail.length, sentBefore, 'password login never sends a code');
}));

test('dead, expired or cross-origin requests are client errors and create nothing', () => fixture(async ({ base, post, mail }) => {
    const browser = new CookieBrowser();
    const password = setup.newTestPassword();
    const body = (requestId) => ({ requestId, email: 'ghost@example.test', password, passwordConfirmation: password });
    for (const requestId of ['not-a-live-request', '']) {
        for (const path of ['signup/start', 'password/login']) {
            const response = await post(browser, path, body(requestId));
            assert.equal(response.status, 400, path);
            assert.equal((await response.json()).error, 'login_request_invalid');
        }
    }
    const expiring = await createLoginRequest({ redirectUri: `${base}/auth/callback` });
    const store = await getStore();
    const record = await store.getSsoLoginRequestByProviderState(expiring.providerState);
    await store.updateSsoLoginRequest(record.id, { expiresAt: new Date(Date.now() - 1000).toISOString() });
    for (const path of ['attempt', 'signup/start', 'signup/verify', 'password/login']) {
        const expired = await post(browser, path, body(expiring.providerState));
        assert.equal(expired.status, 400, path);
        assert.equal((await expired.json()).error, 'login_request_expired');
    }
    const live = await createLoginRequest({ redirectUri: `${base}/auth/callback` });
    for (const origin of ['https://foreign.example', 'null']) {
        for (const path of ['signup/start', 'signup/resend', 'signup/email', 'signup/verify', 'password/login']) {
            const foreign = await post(browser, path, body(live.providerState), { origin });
            assert.deepEqual([foreign.status, (await foreign.json()).error], [403, 'invalid_origin'], `${origin} ${path}`);
        }
    }
    assert.equal(mail.length, 0);
    assert.equal(await getUserByEmail('ghost@example.test'), null);
    assert.equal((await getInstallationSetup()).complete, false);
}));
