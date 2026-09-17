import test, { beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import * as oidc from 'openid-client';
import { ensureSeedData } from '../lib/bootstrap.mjs';
import { getStore, resetStoreForTests } from '../lib/store.mjs';
import { getInstallationSetup } from '../lib/setup.mjs';
import { getUserById } from '../lib/users.mjs';
import { getAuthPolicy, updateAuthPolicy, environmentPolicyOverrides } from '../lib/policy.mjs';
import { getEnabledAuthMethods } from '../lib/auth/methods.mjs';
import { getGoogleStatus } from '../lib/auth/google.mjs';
import { wizardConfiguration } from '../lib/auth/wizardConfig.mjs';
import { googleOnlyAuthentication } from '../lib/auth/production.mjs';
import * as admin from '../lib/auth/adminPassword.mjs';
import { startEmailSignIn, completeEmailSignIn, discoverAccount } from '../lib/auth/signIn.mjs';
import { loginVerify as totpLogin, reauthenticationVerify as totpReauthentication } from '../lib/auth/totp.mjs';
import { loginOptions as passkeyOptions, loginVerify as passkeyLogin } from '../lib/auth/passkey.mjs';
import { completeReauthentication, consumeOperationGrant, reauthenticationMethods } from '../lib/auth/operationGrants.mjs';
import { completeGoogleIdentity, inspectGoogleIdentity, mailboxVersion, GOOGLE_ISSUER } from '../lib/externalIdentities.mjs';
import { createLoginRequest, consumeAuthCode } from '../lib/sso.mjs';
import { createOidcClient } from '../lib/oidc/clients.mjs';
import { resetOidcProviderForTests } from '../lib/oidc/provider.mjs';
import { startService } from '../service/index.mjs';
import { CookieBrowser, controlledGoogleProvider, csrf } from './helpers/googleProvider.mjs';
import * as setup from './helpers/setup.mjs';

let folder, previousEnvironment, server;
const identity = (email = 'owner@gmail.com', subject = 'production-google-owner') => ({ issuer: GOOGLE_ISSUER, subject, email, emailVerified: true });

beforeEach(async () => {
    previousEnvironment = { ...process.env };
    folder = await mkdtemp(join(tmpdir(), 'userpersisto-production-auth-'));
    process.env.PERSISTENCE_FOLDER = folder;
    process.env.USERPERSISTO_SETTINGS_KEY = 'production-auth-fixture-settings';
    for (const name of ['PROD', 'USERPERSISTO_AUTH_METHODS', 'USERPERSISTO_ADMIN_PASSWORD', 'USERPERSISTO_GOOGLE_CLIENT_ID',
        'USERPERSISTO_GOOGLE_REDIRECT_URI', 'USERPERSISTO_ALLOWED_REDIRECT_ORIGINS', 'USERPERSISTO_OIDC_ISSUER']) delete process.env[name];
    admin.resetAdministratorPasswordForTests();
    setup.resetAuthLimitsForTests();
    await ensureSeedData();
});

afterEach(async () => {
    if (server?.listening) {
        server.closeAllConnections();
        await new Promise((resolve) => server.close(resolve));
    }
    server = undefined;
    resetOidcProviderForTests();
    await resetStoreForTests();
    await rm(folder, { recursive: true, force: true });
    for (const name of Object.keys(process.env)) if (!Object.hasOwn(previousEnvironment, name)) delete process.env[name];
    Object.assign(process.env, previousEnvironment);
});

test('any PROD value forces Google alone ahead of saved policy and method overrides', async () => {
    await updateAuthPolicy({ enabledAuthMethods: ['emailCode'] }, { emailStatus: async () => ({ available: true }) });
    process.env.USERPERSISTO_AUTH_METHODS = 'emailCode,passkey,totp';
    process.env.USERPERSISTO_ADMIN_PASSWORD = 'explicit-admin-password';
    for (const value of ['', 'false', '0', 'true', 'production']) {
        process.env.PROD = value;
        assert.equal(googleOnlyAuthentication(), true, JSON.stringify(value));
        assert.deepEqual((await getAuthPolicy()).enabledAuthMethods, ['google']);
        assert.deepEqual(await getEnabledAuthMethods(), ['google']);
        assert.equal(environmentPolicyOverrides().includes('PROD'), true);
        const configuration = await wizardConfiguration({ emailAvailable: true });
        assert.equal(configuration.googleOnly, true);
        assert.deepEqual(configuration.methods, { emailCode: false, passkey: false, totp: false, google: true });
        assert.equal(configuration.adminPassword, false);
        assert.equal((await getGoogleStatus()).policySource, 'production');
        await assert.rejects(admin.verifyAdministratorPassword({ password: 'explicit-admin-password' }), { code: 'admin_password_unavailable' });
    }
    assert.equal(await (await getStore()).getSystemSettingByKey('auth.adminPassword.state'), undefined, 'production never initializes an administrator verifier');
    delete process.env.PROD;
    assert.deepEqual((await getAuthPolicy()).enabledAuthMethods, ['emailCode', 'passkey', 'totp']);
    assert.equal((await wizardConfiguration({ emailAvailable: true })).googleOnly, false);
    assert.equal((await wizardConfiguration()).adminPassword, true);
});

test('production refuses every fallback if Google configuration is unavailable', async () => {
    process.env.PROD = '';
    process.env.USERPERSISTO_GOOGLE_CLIENT_ID = 'explicit-but-incomplete';
    process.env.USERPERSISTO_ADMIN_PASSWORD = 'admin';
    assert.deepEqual(await getEnabledAuthMethods(), []);
    const configuration = await wizardConfiguration({ emailAvailable: true });
    assert.equal(configuration.googleOnly, true);
    assert.equal(configuration.adminPassword, false);
    assert.equal(configuration.registration, false);
    assert.deepEqual(configuration.methods, { emailCode: false, passkey: false, totp: false, google: false });
});

test('entering production suspends the administrator verifier once and preserves default eligibility on return', async () => {
    const { user } = await admin.completeAdministratorPassword({ password: 'admin' });
    const store = await getStore();
    const before = (await store.getSystemSettingByKey('auth.adminPassword.state')).value;
    const proof = await admin.verifyAdministratorPassword({ password: 'admin' });
    process.env.PROD = 'false';
    await admin.syncAdministratorPasswordState();
    const suspended = (await store.getSystemSettingByKey('auth.adminPassword.state')).value;
    assert.equal(suspended.defaultPassword, true);
    assert.equal(suspended.passwordHash, before.passwordHash);
    assert.equal(suspended.productionSuspended, true);
    assert.notEqual(suspended.version, before.version);
    assert.equal((await getUserById(user.id)).authGeneration, 1);
    assert.equal(await admin.assertAdministratorPasswordProof(store, { userId: user.id, credentialVersion: proof.credentialVersion }), false);
    await admin.syncAdministratorPasswordState();
    assert.equal((await getUserById(user.id)).authGeneration, 1);
    await resetStoreForTests();
    admin.resetAdministratorPasswordForTests();
    await admin.syncAdministratorPasswordState();
    assert.equal((await getUserById(user.id)).authGeneration, 1, 'production restart does not revoke twice');
    delete process.env.PROD;
    await admin.syncAdministratorPasswordState();
    assert.equal((await admin.completeAdministratorPassword({ password: 'admin' })).user.id, user.id);
    assert.equal((await getUserById(user.id)).authGeneration, 2);
    assert.equal((await (await getStore()).getSystemSettingByKey('auth.adminPassword.state')).value.defaultPassword, true);
});

test('non-Google domain authentication, pending email proofs, and old local operation grants are refused in production', async () => {
    const { user } = await setup.registerWithEmailCode('local-owner@example.test');
    process.env.USERPERSISTO_ADMIN_PASSWORD = 'admin';
    const grant = await completeReauthentication({ userId: user.id, operation: 'passkey.register', method: 'adminPassword', password: 'admin' });
    const request = await createLoginRequest({ redirectUri: 'http://127.0.0.1/auth/callback' });
    const parent = { flow: 'sso', id: request.providerState, expiresAt: Date.parse(request.expiresAt) };
    const browserProof = setup.newBrowserProof();
    let code;
    await startEmailSignIn({ parent, browserProof, email: user.email, purpose: 'login', deliver: async (message) => {
        code = message.code; return { delivered: true };
    } });
    process.env.PROD = '';
    for (const operation of [
        () => discoverAccount({ parent, email: user.email }),
        () => startEmailSignIn({ parent, browserProof, email: user.email, purpose: 'login' }),
        () => completeEmailSignIn({ parent, browserProof, code }),
        () => totpLogin({ email: user.email, token: '000000' }),
        () => totpReauthentication({ userId: user.id, token: '000000' }),
        () => passkeyOptions({ email: user.email, origin: 'http://127.0.0.1' }),
        () => passkeyLogin({ email: user.email, assertion: {}, origin: 'http://127.0.0.1' }),
    ]) await assert.rejects(operation, { code: 'auth_method_disabled' });
    assert.deepEqual(await reauthenticationMethods(await getUserById(user.id)), []);
    await assert.rejects(completeReauthentication({ userId: user.id, operation: 'passkey.register', method: 'adminPassword', password: 'admin' }),
        { code: 'reauthentication_unavailable' });
    await assert.rejects(consumeOperationGrant({ userId: user.id, operation: 'passkey.register', grant: grant.grant }), { code: 'operation_grant_required' });
});

test('production preserves Google setup and authoritative linking while refusing local collision proofs', async () => {
    const owner = await setup.registerWithEmailCode('owner@gmail.com');
    const thirdParty = await setup.registerWithEmailCode('member@example.test');
    process.env.PROD = '';
    const google = identity();
    assert.deepEqual((await inspectGoogleIdentity(google)).eligibleMethods, ['googleAuthoritative']);
    const proof = { userId: owner.user.id, email: owner.user.email, transactionId: 'production-link',
        authenticatedAt: Date.now(), confirmedAt: Date.now(), credentialVersion: mailboxVersion(await getUserById(owner.user.id)) };
    await assert.rejects(completeGoogleIdentity({ identity: google, transactionId: proof.transactionId,
        linkProof: { ...proof, method: 'emailCode' } }), { code: 'google_link_authentication_required' });
    const linked = await completeGoogleIdentity({ identity: google, transactionId: proof.transactionId,
        linkProof: { ...proof, method: 'googleAuthoritative' } });
    assert.equal(linked.user.id, owner.user.id);
    assert.deepEqual(await reauthenticationMethods(await getUserById(owner.user.id)), ['google']);
    assert.deepEqual((await inspectGoogleIdentity(identity(thirdParty.user.email, 'unlinked-third-party'))).eligibleMethods, []);
    assert.equal((await completeGoogleIdentity({ identity: google })).user.id, owner.user.id);
});

async function startHttp({ protocol } = {}) {
    let emailProbes = 0;
    server = startService({ port: 0, host: '127.0.0.1' }, {
        ...(protocol ? { google: { protocol } } : {}),
        emailStatus: async () => { emailProbes += 1; return { available: true }; },
        deliverEmail: async () => { throw new Error('Production sign-in must not send email'); },
    });
    if (!server.listening) await once(server, 'listening');
    const base = `http://127.0.0.1:${server.address().port}`;
    process.env.USERPERSISTO_GOOGLE_CLIENT_ID = 'controlled-google-client';
    process.env.USERPERSISTO_GOOGLE_REDIRECT_URI = `${base}/service/auth/google/callback`;
    return { base, emailProbes: () => emailProbes };
}

test('production SSO rejects local endpoints and completed-email replay while Google completes real credential verification', async () => {
    const previousProof = setup.newBrowserProof();
    const previous = await setup.registerWithEmailCode('old-owner@example.test', { browserProof: previousProof });
    const provider = await controlledGoogleProvider();
    const { base, emailProbes } = await startHttp({ protocol: provider.protocol });
    process.env.PROD = '';
    const browser = new CookieBrowser();
    const request = await createLoginRequest({ redirectUri: `${base}/auth/callback` });
    const body = { requestId: request.providerState, state: 'production-router-state', email: 'owner@example.test', password: 'admin', token: '000000', code: '000000', purpose: 'login' };
    const opened = await browser.json(`${base}/service/auth/attempt`, body);
    assert.equal(opened.status, 200);
    const configuration = await opened.json();
    assert.equal(configuration.googleOnly, true);
    assert.equal(configuration.methods.google, true);
    assert.equal(configuration.attempt, null);
    assert.equal(emailProbes(), 0);
    for (const path of ['admin/login', 'discover', 'email-code/start', 'email-code/verify', 'totp/verify', 'passkey/options', 'passkey/verify']) {
        const response = await browser.json(`${base}/service/auth/${path}`, body);
        assert.equal(response.status, 404, path);
        assert.equal((await response.json()).error, 'auth_method_disabled', path);
    }
    browser.cookies.set('up_browser', { value: previousProof, path: '/service/' });
    const replay = await browser.json(`${base}/service/auth/attempt`, { requestId: previous.request.providerState, state: 'old' });
    assert.notEqual(replay.status, 200);
    const googleStart = await browser.json(`${base}/service/auth/google/start`, { requestId: request.providerState, state: body.state });
    assert.equal(googleStart.status, 200, await googleStart.clone().text());
    const credential = await provider.credential((await googleStart.json()).authorizationUrl, browser);
    const verified = await browser.json(credential.url, credential.body);
    assert.equal(verified.status, 200, await verified.clone().text());
    const resumed = await browser.fetch(new URL((await verified.json()).redirectUrl, base));
    assert.equal(resumed.status, 303, await resumed.clone().text());
    const callback = new URL(resumed.headers.get('location'), base);
    const authenticated = await consumeAuthCode({ providerState: request.providerState, code: callback.searchParams.get('code') });
    assert.equal(authenticated.user.email, provider.state.email);
    assert.equal((await getInstallationSetup()).initialAdministratorId, previous.user.id);
    await provider.close();
});

test('production OIDC renders Google-only configuration and rejects password, email, passkey, and TOTP form completion', async () => {
    process.env.PROD = '';
    const owner = await completeGoogleIdentity({ identity: identity() });
    const { base, emailProbes } = await startHttp();
    process.env.USERPERSISTO_OIDC_ISSUER = `${base}/service/oidc`;
    const callback = 'https://production-client.example.test/callback';
    await createOidcClient({ client_id: 'production-client', redirect_uris: [callback], token_endpoint_auth_method: 'none', scope: 'openid email' }, { actorId: owner.user.id });
    const config = await oidc.discovery(new URL(process.env.USERPERSISTO_OIDC_ISSUER), 'production-client', undefined, oidc.None(), { execute: [oidc.allowInsecureRequests] });
    const authorization = oidc.buildAuthorizationUrl(config, { redirect_uri: callback, scope: 'openid email', state: oidc.randomState(), nonce: oidc.randomNonce(),
        code_challenge: await oidc.calculatePKCECodeChallenge(oidc.randomPKCECodeVerifier()), code_challenge_method: 'S256' });
    const browser = new CookieBrowser();
    const start = await browser.fetch(authorization);
    assert.equal(start.status, 303);
    const interaction = new URL(start.headers.get('location'), base).href;
    const page = await browser.fetch(interaction);
    const html = await page.text();
    assert.equal(page.status, 200, html);
    assert.match(html, /"googleOnly":true/);
    assert.match(html, /"adminPassword":false/);
    const body = { csrf: csrf(html), email: owner.user.email, password: 'admin', token: '000000', code: '000000', purpose: 'login', assertion: '{}' };
    for (const action of ['admin-login', 'email-start', 'email-verify', 'totp', 'passkey-options', 'passkey-verify', 'discover']) {
        const denied = await browser.post(`${interaction}/${action}`, body);
        assert.ok(denied.status >= 400 && denied.status < 500, `${action}: ${denied.status}`);
        assert.equal(denied.headers.get('location'), null, action);
    }
    const attempt = await browser.post(`${interaction}/attempt`, body);
    assert.equal(attempt.status, 200);
    assert.equal((await attempt.json()).attempt, null);
    assert.equal(emailProbes(), 0);
    assert.equal((await getInstallationSetup()).method, 'google');
});
