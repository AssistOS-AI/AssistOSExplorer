import test, { beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { ensureSeedData } from '../lib/bootstrap.mjs';
import { getStore, resetStoreForTests } from '../lib/store.mjs';
import { getInstallationSetup } from '../lib/setup.mjs';
import { getUserById } from '../lib/users.mjs';
import { createLoginRequest, consumeAuthCode } from '../lib/sso.mjs';
import { updateAuthPolicy } from '../lib/policy.mjs';
import { setKdfObserverForTests } from '../lib/auth/password.mjs';
import { startService } from '../service/index.mjs';
import { CookieBrowser } from './helpers/googleProvider.mjs';
import { resetAuthLimitsForTests } from './helpers/setup.mjs';

let folder, environment, server, base, deliveries, hashes;

beforeEach(async () => {
    environment = { ...process.env };
    folder = await mkdtemp(join(tmpdir(), 'userpersisto-initial-password-http-'));
    process.env.PERSISTENCE_FOLDER = folder;
    process.env.USERPERSISTO_SETTINGS_KEY = 'initial-password-http-fixture-settings';
    delete process.env.USERPERSISTO_AUTH_METHODS;
    delete process.env.USERPERSISTO_SELF_REGISTRATION_ENABLED;
    delete process.env.USERPERSISTO_SIGNUP_EMAIL_VERIFICATION_REQUIRED;
    resetAuthLimitsForTests();
    await ensureSeedData();
    deliveries = 0;
    hashes = 0;
    setKdfObserverForTests(({ purpose }) => { if (purpose === 'hash') hashes += 1; });
    server = startService({ port: 0, host: '127.0.0.1' }, {
        emailStatus: async () => ({ available: false }),
        deliverEmail: async () => { deliveries += 1; throw new Error('Email is unavailable in this fixture.'); },
    });
    if (!server.listening) await once(server, 'listening');
    base = `http://127.0.0.1:${server.address().port}`;
});

afterEach(async () => {
    setKdfObserverForTests(null);
    if (server?.listening) { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); }
    await resetStoreForTests().catch(() => {});
    await rm(folder, { recursive: true, force: true });
    for (const name of Object.keys(process.env)) if (!Object.hasOwn(environment, name)) delete process.env[name];
    Object.assign(process.env, environment);
});

async function request() {
    return (await createLoginRequest({ redirectUri: `${base}/auth/callback` })).providerState;
}

async function login(browser, body = {}, requestId = undefined, origin = base) {
    const id = requestId || await request();
    const submitted = { requestId: id, state: 'initial-router-state', email: 'owner@example.test', password: 'admin', ...body };
    const response = await browser.json(`${base}/service/auth/password/login`, submitted, origin);
    return { status: response.status, body: await response.json(), requestId: id };
}

test('fresh SSO setup works without email delivery and produces an administrator session with an unverified email', async () => {
    await updateAuthPolicy({ signupEmailVerificationRequired: true }, { emailStatus: async () => ({ available: true }) });
    const browser = new CookieBrowser();
    const id = await request();
    const opened = await browser.json(`${base}/service/auth/attempt`, { requestId: id, state: 'initial-router-state' });
    assert.equal(opened.status, 200);
    const configuration = await opened.json();
    assert.equal(configuration.initialPasswordSetup, true);
    assert.equal(configuration.signup.email, false, 'ordinary signup still requires email delivery');
    assert.equal(configuration.signup.verification, 'required');
    const result = await login(browser, { email: ' First.Owner@Example.test ' }, id);
    assert.equal(result.status, 200, JSON.stringify(result.body));
    assert.deepEqual(Object.keys(result.body).sort(), ['code', 'ok', 'redirectUri', 'state']);
    assert.equal(result.body.redirectUri, `${base}/auth/callback`);
    assert.equal(result.body.state, 'initial-router-state');
    const signedIn = await consumeAuthCode({ providerState: id, code: result.body.code });
    assert.deepEqual(signedIn.roles, ['admin']);
    assert.equal(signedIn.user.email, 'first.owner@example.test');
    assert.equal(signedIn.user.emailVerifiedAt, '');
    assert.equal(signedIn.capabilities.includes('explorer.access'), true);
    assert.equal((await getInstallationSetup()).method, 'initialPassword');
    assert.equal(hashes, 1);
    assert.equal(deliveries, 0);
    assert.equal((await (await getStore()).select('emailLog')).totalCount, 0);
    const laterConfiguration = await (await browser.fetch(`${base}/service/auth/setup`)).json();
    assert.equal(laterConfiguration.initialPasswordSetup, false);
    const denied = await login(new CookieBrowser(), { email: 'second-owner@example.test' });
    assert.deepEqual([denied.status, denied.body.error], [401, 'authentication_failed']);
    const normal = await login(new CookieBrowser(), { email: signedIn.user.email });
    assert.equal(normal.status, 200);
    assert.equal((await consumeAuthCode({ providerState: normal.requestId, code: normal.body.code })).user.id, signedIn.user.id);
    assert.equal(hashes, 1, 'ordinary subsequent login never creates or hashes a second credential');
    assert.equal(deliveries, 0);
});

test('default policy advertises password signup without email delivery while first-owner setup is unchanged', async () => {
    const browser = new CookieBrowser();
    const id = await request();
    const opened = await browser.json(`${base}/service/auth/attempt`, { requestId: id, state: 'initial-router-state' });
    assert.equal(opened.status, 200);
    const configuration = await opened.json();
    assert.deepEqual([configuration.initialPasswordSetup, configuration.signup.email, configuration.signup.verification, configuration.passwordReset],
        [true, true, 'none', false]);
    assert.equal(deliveries, 0);
});

test('initial handoff replay survives restart only for the initiating browser, same email and exact password while unconsumed', async () => {
    const browser = new CookieBrowser();
    const first = await login(browser);
    assert.equal(first.status, 200);
    await resetStoreForTests();
    const replay = await login(browser, {}, first.requestId);
    assert.equal(replay.status, 200, JSON.stringify(replay.body));
    assert.equal(replay.body.replayed, true);
    assert.equal(replay.body.code, first.body.code);
    const loaded = await browser.json(`${base}/service/auth/attempt`, { requestId: first.requestId, state: 'initial-router-state' });
    const loadedBody = await loaded.json();
    assert.equal(loadedBody.completed, true);
    assert.equal(loadedBody.handoff.code, first.body.code);
    assert.equal((await login(new CookieBrowser(), {}, first.requestId)).status, 400);
    for (const changed of [{ email: 'other@example.test' }, { password: 'Admin' }, { password: 'ａｄｍｉｎ' }, { password: ' admin' }]) {
        const refused = await login(browser, changed, first.requestId);
        assert.deepEqual([refused.status, refused.body.error], [400, 'login_request_invalid']);
    }
    assert.equal((await (await getStore()).select('ssoAuthCode')).totalCount, 1, 'replay never issues a new code');
    assert.equal((await (await getStore()).select('user')).totalCount, 1);
    const owner = await consumeAuthCode({ providerState: first.requestId, code: first.body.code });
    assert.equal((await getUserById(owner.user.id)).emailVerifiedAt, '');
    const consumed = await login(browser, {}, first.requestId);
    assert.deepEqual([consumed.status, consumed.body.error], [400, 'login_request_invalid']);
    const consumedAttempt = await browser.json(`${base}/service/auth/attempt`, { requestId: first.requestId, state: 'initial-router-state' });
    assert.equal(consumedAttempt.status, 400);
    assert.equal(deliveries, 0);
});

test('a blocked initial account cannot recover its still-unconsumed handoff through replay', async () => {
    const browser = new CookieBrowser();
    const created = await login(browser);
    const setup = await getInstallationSetup();
    await (await getStore()).updateUser(setup.initialAdministratorId, { status: 'blocked' });
    const replay = await login(browser, {}, created.requestId);
    assert.deepEqual([replay.status, replay.body.error], [400, 'login_request_invalid']);
    const other = await login(new CookieBrowser(), { email: 'new-owner@example.test' });
    assert.deepEqual([other.status, other.body.error], [401, 'authentication_failed']);
    assert.equal((await (await getStore()).select('user')).totalCount, 1);
    assert.equal((await getInstallationSetup()).complete, true);
});

test('raw password variants and malformed presentation never claim initial setup over HTTP', async () => {
    for (const [index, password] of ['Admin', 'admin ', ' admin', 'ａｄｍｉｎ', '', 42].entries()) {
        const result = await login(new CookieBrowser(), { email: `variant-${index}@example.test`, password });
        assert.deepEqual([result.status, result.body.error], [401, 'authentication_failed']);
    }
    const invalid = await login(new CookieBrowser(), { email: 'not-an-email' });
    assert.deepEqual([invalid.status, invalid.body.error], [401, 'authentication_failed']);
    assert.equal((await getInstallationSetup()).complete, false);
    assert.equal((await (await getStore()).select('user')).totalCount, 0);
    assert.equal(hashes, 0);
    assert.equal(deliveries, 0);
});

test('origin, live parent and password policy remain mandatory for initial creation', async () => {
    await updateAuthPolicy({ enabledAuthMethods: ['emailCode'] }, { emailStatus: async () => ({ available: true }) });
    const disabled = await login(new CookieBrowser());
    assert.deepEqual([disabled.status, disabled.body.error], [404, 'auth_method_disabled']);
    await updateAuthPolicy({ enabledAuthMethods: ['password', 'emailCode'] }, { emailStatus: async () => ({ available: true }) });
    const absent = await login(new CookieBrowser(), {}, 'missing-request');
    assert.deepEqual([absent.status, absent.body.error], [400, 'login_request_invalid']);
    const id = await request();
    const store = await getStore();
    const record = await store.getSsoLoginRequestByProviderState(id);
    await store.updateSsoLoginRequest(record.id, { expiresAt: new Date(Date.now() - 1_000).toISOString() });
    const expired = await login(new CookieBrowser(), {}, id);
    assert.deepEqual([expired.status, expired.body.error], [400, 'login_request_expired']);
    for (const origin of ['https://foreign.example', 'null']) {
        const refused = await login(new CookieBrowser(), {}, undefined, origin);
        assert.deepEqual([refused.status, refused.body.error], [403, 'invalid_origin']);
    }
    assert.equal(hashes, 0);
    assert.equal(deliveries, 0);
    assert.equal((await getInstallationSetup()).complete, false);
});
