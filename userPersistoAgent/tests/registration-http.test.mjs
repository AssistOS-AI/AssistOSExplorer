import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { ensureSeedData } from '../lib/bootstrap.mjs';
import { getUserByEmail } from '../lib/users.mjs';
import { getInstallationSetup } from '../lib/setup.mjs';
import { createLoginRequest, consumeAuthCode } from '../lib/sso.mjs';
import { getStore, resetStoreForTests } from '../lib/store.mjs';
import { startService } from '../service/index.mjs';
import { CookieBrowser } from './helpers/googleProvider.mjs';
import * as setup from './helpers/setup.mjs';

async function fixture(fn) {
    const folder = await mkdtemp(join(tmpdir(), 'userpersisto-register-http-'));
    process.env.PERSISTENCE_FOLDER = folder;
    process.env.USERPERSISTO_SETTINGS_KEY = 'test-settings-key';
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
        setup.clearAdministratorPassword();
        if (server?.listening) { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); }
        await resetStoreForTests();
        await rm(folder, { recursive: true, force: true });
    }
}

test('retired password routes are gone and malformed bodies fail before any setup decision', () => fixture(async ({ base }) => {
    for (const route of ['register', 'password/login', 'totp/setup']) {
        const response = await fetch(`${base}/service/auth/${route}`, { method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ email: 'owner@example.test', password: 'long-enough-password' }) });
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

test('HTTP email registration claims the first administrator through the browser-bound attempt', () => fixture(async ({ base, mail, post }) => {
    const request = await createLoginRequest({ redirectUri: `${base}/auth/callback` });
    const browser = new CookieBrowser();
    const attempt = await post(browser, 'attempt', { requestId: request.providerState, state: 'router-core-state' });
    assert.equal(attempt.status, 200);
    const cookie = attempt.headers.getSetCookie().find((value) => value.startsWith('up_browser='));
    assert.match(cookie, /HttpOnly/);
    assert.match(cookie, /SameSite=Strict/);
    assert.match(cookie, /Path=\/service\//);
    const state = await attempt.json();
    assert.equal(state.setupComplete, false);
    assert.equal(state.registration, true);
    assert.equal(state.adminPassword, false);
    assert.ok(state.expiresAt > Date.now());
    const discovered = await (await post(browser, 'discover', { requestId: request.providerState, email: 'owner@example.test' })).json();
    assert.deepEqual([discovered.exists, discovered.methods], [false, { emailCode: false, passkey: false, totp: false }]);
    const started = await post(browser, 'email-code/start', { requestId: request.providerState, email: 'owner@example.test', purpose: 'register' });
    assert.equal(started.status, 200, await started.clone().text());
    const body = await started.json();
    assert.equal(body.challenge.delivery, 'accepted');
    assert.equal(JSON.stringify(body).includes(mail.at(-1).code), false);
    assert.equal(await getUserByEmail('owner@example.test'), null, 'no account before proof');
    // Another browser holding the code cannot use this attempt.
    const stolen = await post(new CookieBrowser(), 'email-code/verify', { requestId: request.providerState, state: 'router-core-state', code: mail.at(-1).code });
    assert.equal(stolen.status, 400);
    const verified = await post(browser, 'email-code/verify', { requestId: request.providerState, state: 'router-core-state', code: mail.at(-1).code });
    assert.equal(verified.status, 200, await verified.clone().text());
    const completion = await verified.json();
    assert.equal(completion.initialAdministrator, true);
    assert.equal(completion.state, 'router-core-state');
    assert.equal(completion.redirectUri, `${base}/auth/callback`);
    // A lost response replays the same unconsumed handoff to the same browser only.
    const replay = await (await post(browser, 'email-code/verify', { requestId: request.providerState, state: 'router-core-state', code: '000000' })).json();
    assert.equal(replay.code, completion.code);
    assert.equal(replay.replayed, true);
    assert.equal((await post(new CookieBrowser(), 'email-code/verify', { requestId: request.providerState, state: 'router-core-state', code: mail.at(-1).code })).status, 400);
    const consumed = await consumeAuthCode({ providerState: request.providerState, code: completion.code });
    assert.deepEqual(consumed.roles, ['admin']);
    assert.equal((await getInstallationSetup()).initialAdministratorId, consumed.user.id);
    const afterConsumption = await post(browser, 'email-code/verify', { requestId: request.providerState, state: 'router-core-state', code: '000000' });
    assert.equal(afterConsumption.status, 400);
    assert.equal((await afterConsumption.json()).error, 'login_request_invalid');
}));

test('dead, expired or cross-origin requests are client errors and create nothing', () => fixture(async ({ base, post, mail }) => {
    const browser = new CookieBrowser();
    for (const requestId of ['not-a-live-request', '']) {
        const response = await post(browser, 'email-code/start', { requestId, email: 'ghost@example.test', purpose: 'register' });
        assert.equal(response.status, 400);
        assert.equal((await response.json()).error, 'login_request_invalid');
    }
    const expiring = await createLoginRequest({ redirectUri: `${base}/auth/callback` });
    const store = await getStore();
    const record = await store.getSsoLoginRequestByProviderState(expiring.providerState);
    await store.updateSsoLoginRequest(record.id, { expiresAt: new Date(Date.now() - 1000).toISOString() });
    const expired = await post(browser, 'attempt', { requestId: expiring.providerState });
    assert.equal(expired.status, 400);
    assert.equal((await expired.json()).error, 'login_request_expired');
    const live = await createLoginRequest({ redirectUri: `${base}/auth/callback` });
    for (const origin of ['https://foreign.example', 'null']) {
        const foreign = await post(browser, 'email-code/start', { requestId: live.providerState, email: 'ghost@example.test', purpose: 'register' }, { origin });
        assert.equal(foreign.status, 403);
    }
    assert.equal(mail.length, 0);
    assert.equal(await getUserByEmail('ghost@example.test'), null);
    assert.equal((await getInstallationSetup()).complete, false);
}));

test('administrator password sign-in uses the Router rate-source partition and hides when unconfigured', () => fixture(async ({ base, post }) => {
    const request = await createLoginRequest({ redirectUri: `${base}/auth/callback` });
    const browser = new CookieBrowser();
    const unavailable = await post(browser, 'admin/login', { requestId: request.providerState, password: 'not-configured-password' });
    assert.equal(unavailable.status, 404);
    assert.equal((await unavailable.json()).error, 'admin_password_unavailable');
    const password = setup.configureAdministratorPassword();
    assert.equal((await (await post(browser, 'attempt', { requestId: request.providerState })).json()).adminPassword, true);
    const attacker = { 'x-ploinky-rate-source': 'e'.repeat(64) };
    for (let index = 0; index < 5; index += 1) {
        const response = await post(browser, 'admin/login', { requestId: request.providerState, password: `wrong-password-${index}` }, attacker);
        assert.equal(response.status, 401);
    }
    const limited = await post(browser, 'admin/login', { requestId: request.providerState, password }, attacker);
    assert.equal(limited.status, 429);
    assert.ok(Number(limited.headers.get('retry-after')) > 0);
    const owner = await post(browser, 'admin/login', { requestId: request.providerState, state: 'core', password, contactEmail: 'ops@example.test' }, { 'x-ploinky-rate-source': 'f'.repeat(64) });
    assert.equal(owner.status, 200, await owner.clone().text());
    const completion = await owner.json();
    assert.equal(completion.initialAdministrator, true);
    const consumed = await consumeAuthCode({ providerState: request.providerState, code: completion.code });
    assert.equal(consumed.user.username, 'administrator');
    assert.equal(consumed.user.email, '');
    assert.deepEqual(consumed.roles, ['admin']);
}));
