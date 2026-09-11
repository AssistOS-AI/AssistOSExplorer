import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import * as client from 'openid-client';
import { startService } from '../service/index.mjs';
import { ensureSeedData } from '../lib/bootstrap.mjs';
import { updateUser, setUserRoles, getUserByEmail, getUserRoles } from '../lib/users.mjs';
import { getInstallationSetup } from '../lib/setup.mjs';
import * as setup from './helpers/setup.mjs';
import { createOidcClient, updateOidcClient, rotateOidcClientSecret } from '../lib/oidc/clients.mjs';
import { resetOidcProviderForTests } from '../lib/oidc/provider.mjs';
import { getStore, resetStoreForTests } from '../lib/store.mjs';
import { updateAuthPolicy } from '../lib/policy.mjs';

const redirect = 'https://client.example.test/callback';
// Construction-time delivery capture: the real email transport is never used.
const mail = [];

class Browser {
    cookies = new Map();
    async fetch(url, options = {}) {
        const path = new URL(url).pathname;
        const cookies = [...this.cookies].filter(([, c]) => path.startsWith(c.path)).map(([name, c]) => `${name}=${c.value}`).join('; ');
        const response = await fetch(url, { ...options, redirect: 'manual', headers: { cookie: cookies, ...options.headers } });
        for (const raw of response.headers.getSetCookie()) {
            const [pair, ...attrs] = raw.split(';');
            const split = pair.indexOf('=');
            const name = pair.slice(0, split);
            const expiry = attrs.find((attr) => /^\s*expires=/i.test(attr));
            if (attrs.some((attr) => /^\s*max-age=0$/i.test(attr)) || (expiry && Date.parse(expiry.trim().slice(8)) < Date.now())) this.cookies.delete(name);
            else this.cookies.set(name, { value: pair.slice(split + 1), path: attrs.find((attr) => /^\s*path=/i.test(attr))?.trim().slice(5) || '/' });
        }
        return response;
    }
    post(url, body, origin = new URL(url).origin) {
        return this.fetch(url, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', origin }, body: new URLSearchParams(body) });
    }
}

async function fixture(fn) {
    const folder = await mkdtemp(join(tmpdir(), 'userpersisto-oidc-http-'));
    process.env.PERSISTENCE_FOLDER = folder;
    process.env.USERPERSISTO_SETTINGS_KEY = 'disposable-oidc-test-encryption-key';
    delete process.env.USERPERSISTO_AUTH_METHODS;
    delete process.env.USERPERSISTO_SELF_REGISTRATION_ENABLED;
    setup.resetAuthLimitsForTests();
    mail.length = 0;
    let server;
    try {
        await ensureSeedData();
        setup.configureAdministratorPassword();
        const { user: owner } = await setup.registerWithEmailCode('owner@example.test');
        const { user } = await setup.registerWithEmailCode('member@example.test');
        server = startService({ port: 0, host: '127.0.0.1' }, { deliverEmail: async (message) => { mail.push(message); return { delivered: true, providerMessageId: 'fixture' }; } });
        if (!server.listening) await once(server, 'listening');
        const base = `http://127.0.0.1:${server.address().port}`;
        const issuer = `${base}/service/oidc`;
        process.env.USERPERSISTO_OIDC_ISSUER = issuer;
        const admin = { actorId: owner.id };
        const metadata = { client_id: 'test-client', redirect_uris: [redirect], post_logout_redirect_uris: ['https://client.example.test/logged-out'],
            token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'], scope: 'openid profile email offline_access roles capabilities' };
        await createOidcClient(metadata, admin);
        const config = await client.discovery(new URL(issuer), metadata.client_id, undefined, client.None(), { execute: [client.allowInsecureRequests, client.enableNonRepudiationChecks] });
        await fn({ folder, issuer, base, owner, user, admin, config, metadata });
    } finally {
        if (server?.listening) await new Promise((resolve) => server.close(resolve));
        resetOidcProviderForTests();
        await resetStoreForTests();
        setup.clearAdministratorPassword();
        delete process.env.USERPERSISTO_OIDC_ISSUER;
        await rm(folder, { recursive: true, force: true });
    }
}

function csrf(html) {
    const result = html.match(/name="csrf" value="([^"]+)"/);
    assert.ok(result, html);
    return result[1];
}

async function begin(config, { scope = 'openid profile email offline_access roles capabilities', ...params } = {}, browser = new Browser()) {
    const verifier = client.randomPKCECodeVerifier();
    const nonce = client.randomNonce();
    const state = client.randomState();
    const url = client.buildAuthorizationUrl(config, { redirect_uri: redirect, scope, state, nonce, prompt: 'consent',
        code_challenge: await client.calculatePKCECodeChallenge(verifier), code_challenge_method: 'S256', ...params });
    const response = await browser.fetch(url);
    assert.equal(response.status, 303, await response.clone().text());
    return { browser, verifier, nonce, state, location: response.headers.get('location') };
}

function wizardConfig(html) {
    const match = html.match(/<script type="application\/json" id="userpersisto-wizard-config">([^<]+)<\/script>/);
    assert.ok(match, html);
    return JSON.parse(match[1]);
}

// Drives the wizard's own endpoints: JSON attempt/email-start, then the native
// email-verify form POST that ends in the engine redirect.
async function emailSignIn(browser, location, html, email, purpose) {
    const token = csrf(html);
    const attempt = await browser.post(`${location}/attempt`, { csrf: token });
    assert.equal(attempt.status, 200, await attempt.clone().text());
    const started = await browser.post(`${location}/email-start`, { csrf: token, email, purpose });
    assert.equal(started.status, 200, await started.clone().text());
    return browser.post(`${location}/email-verify`, { csrf: token, code: mail.at(-1).code });
}

test('credential rotation revokes a completed login before the browser resumes OIDC', async () => fixture(async ({ config, owner }) => {
    const { syncAdministratorPasswordState } = await import('../lib/auth/adminPassword.mjs');
    await syncAdministratorPasswordState();
    const flow = await begin(config);
    const page = await flow.browser.fetch(flow.location);
    const submitted = await emailSignIn(flow.browser, flow.location, await page.text(), owner.email, 'login');
    assert.equal(submitted.status, 303, await submitted.clone().text());
    const resume = submitted.headers.get('location');
    setup.configureAdministratorPassword();
    await syncAdministratorPasswordState();
    const replay = await flow.browser.fetch(resume);
    assert.ok(replay.status >= 400, `stale resume unexpectedly returned ${replay.status}: ${await replay.clone().text()}`);
    const revisit = await flow.browser.fetch(flow.location);
    assert.ok(revisit.status >= 400, 'the completed interaction cannot resurrect the login');
    const fresh = await begin(config, {}, flow.browser);
    assert.match(await (await fresh.browser.fetch(fresh.location)).text(), /userpersisto-wizard-config/);
}));

async function complete(flow, email = 'member@example.test', { purpose = 'login', allow = true } = {}) {
    let location = flow.location;
    for (let step = 0; step < 10; step++) {
        if (location.startsWith(redirect)) return new URL(location);
        const response = await flow.browser.fetch(location);
        if (response.status === 303 || response.status === 302) { location = response.headers.get('location'); continue; }
        assert.equal(response.status, 200, await response.clone().text());
        const body = await response.text();
        const consent = body.includes('Allow access?');
        const submission = consent
            ? await flow.browser.post(`${location}/${allow ? 'confirm' : 'abort'}`, { csrf: csrf(body) })
            : await emailSignIn(flow.browser, location, body, email, purpose);
        assert.equal(submission.status, 303, await submission.clone().text());
        location = submission.headers.get('location');
    }
    throw new Error('Authorization did not finish');
}

async function tokensFor(config, options, browser) {
    const flow = await begin(config, options, browser);
    const callback = await complete(flow);
    const tokens = await client.authorizationCodeGrant(config, callback, { pkceCodeVerifier: flow.verifier, expectedNonce: flow.nonce, expectedState: flow.state });
    return { ...flow, callback, tokens };
}

test('independent OIDC client discovers, authenticates with PKCE, verifies RS256/JWKS, fetches claims and rotates refresh tokens across restart', async () => fixture(async ({ config, user, issuer }) => {
    const metadata = config.serverMetadata();
    assert.equal(metadata.issuer, issuer);
    assert.equal(metadata.authorization_endpoint, `${issuer}/authorize`);
    assert.deepEqual(metadata.response_types_supported, ['code']);
    assert.deepEqual(metadata.code_challenge_methods_supported, ['S256']);
    const { tokens } = await tokensFor(config);
    assert.equal(tokens.token_type, 'bearer');
    assert.ok(tokens.refresh_token);
    assert.equal(tokens.claims().sub, user.id);
    assert.equal(tokens.claims().aud, 'test-client');
    const jwks = await (await fetch(metadata.jwks_uri)).json();
    assert.equal(jwks.keys[0].alg, 'RS256');
    assert.equal(jwks.keys[0].d, undefined);
    const info = await client.fetchUserInfo(config, tokens.access_token, user.id);
    assert.equal(info.email, 'member@example.test');
    assert.equal(info.email_verified, true);
    assert.deepEqual(info.roles, ['selfRegistered']);
    assert.deepEqual(info.capabilities, ['selfregistered.dashboard.access']);
    assert.equal(info.passwordHash, undefined);
    resetOidcProviderForTests();
    await resetStoreForTests();
    assert.deepEqual(await (await fetch(metadata.jwks_uri)).json(), jwks);
    const refreshed = await client.refreshTokenGrant(config, tokens.refresh_token);
    assert.notEqual(refreshed.refresh_token, tokens.refresh_token);
    await assert.rejects(client.refreshTokenGrant(config, tokens.refresh_token));
    await assert.rejects(client.refreshTokenGrant(config, refreshed.refresh_token));
    await assert.rejects(client.fetchUserInfo(config, refreshed.access_token, user.id));
}));

test('browser binding, exact origin, CSRF token, consent denial, prompt none and scope filtering', async () => fixture(async ({ config, user }) => {
    const flow = await begin(config, { scope: 'openid' });
    const stolen = await new Browser().fetch(flow.location);
    assert.ok(stolen.status >= 400);
    const loginPage = await flow.browser.fetch(flow.location);
    // no-referrer makes Chromium's same-origin form POST send Origin:null,
    // which correctly fails our interaction CSRF check.
    assert.equal(loginPage.headers.get('referrer-policy'), 'same-origin');
    assert.match(loginPage.headers.get('content-security-policy'), /form-action 'self' https:\/\/client\.example\.test;/);
    const form = await loginPage.text();
    for (const action of ['attempt', 'email-start', 'email-verify', 'admin-login']) {
        assert.equal((await flow.browser.post(`${flow.location}/${action}`, { email: user.email, purpose: 'login', csrf: csrf(form) }, 'https://evil.example')).status, 403);
        assert.equal((await flow.browser.post(`${flow.location}/${action}`, { email: user.email, purpose: 'login', csrf: 'wrong' })).status, 403);
    }
    assert.equal(mail.length, 0, 'rejected requests never send mail');
    const callback = await complete(flow);
    const tokens = await client.authorizationCodeGrant(config, callback, { pkceCodeVerifier: flow.verifier, expectedState: flow.state, expectedNonce: flow.nonce });
    assert.deepEqual(await client.fetchUserInfo(config, tokens.access_token, user.id), { sub: user.id });
    assert.equal(tokens.refresh_token, undefined);
    const denied = await begin(config, { prompt: 'consent' }, flow.browser);
    assert.equal((await complete(denied, user.email, { allow: false })).searchParams.get('error'), 'access_denied');
    const anonymous = await new Browser().fetch(client.buildAuthorizationUrl(config, { redirect_uri: redirect, scope: 'openid', prompt: 'none', code_challenge: await client.calculatePKCECodeChallenge(client.randomPKCECodeVerifier()), code_challenge_method: 'S256' }));
    assert.equal(new URL(anonymous.headers.get('location')).searchParams.get('error'), 'login_required');
}));

test('invalid redirect, implicit flow and missing/plain PKCE fail before login; wrong verifier cannot redeem', async () => fixture(async ({ config, issuer }) => {
    for (const params of [
        { redirect_uri: 'https://evil.example/cb', code_challenge: 'a'.repeat(43), code_challenge_method: 'S256' },
        { response_type: 'token', code_challenge: 'a'.repeat(43), code_challenge_method: 'S256' },
        {},
        { code_challenge: 'a'.repeat(43), code_challenge_method: 'plain' },
    ]) {
        const url = client.buildAuthorizationUrl(config, { redirect_uri: redirect, scope: 'openid', ...params });
        if (params.response_type) url.searchParams.set('response_type', params.response_type);
        const response = await fetch(url, { redirect: 'manual' });
        const target = response.headers.get('location') && new URL(response.headers.get('location'));
        assert.ok(response.status >= 400 || target?.searchParams.has('error') || new URLSearchParams(target?.hash.slice(1)).has('error'), JSON.stringify({ params, status: response.status, location: response.headers.get('location') }));
        assert.ok(!String(response.headers.get('location')).includes('evil.example'));
    }
    const flow = await begin(config);
    const callback = await complete(flow);
    const response = await fetch(`${issuer}/token`, { method: 'POST', body: new URLSearchParams({ grant_type: 'authorization_code', client_id: 'test-client', code: callback.searchParams.get('code'), redirect_uri: redirect, code_verifier: 'a'.repeat(43) }) });
    assert.equal((await response.json()).error, 'invalid_grant');
    const tokens = await client.authorizationCodeGrant(config, callback, { pkceCodeVerifier: flow.verifier, expectedState: flow.state, expectedNonce: flow.nonce });
    assert.ok(tokens.access_token);
    await assert.rejects(client.authorizationCodeGrant(config, callback, { pkceCodeVerifier: flow.verifier, expectedState: flow.state, expectedNonce: flow.nonce }));
}));

test('concurrent authorization-code redemption has exactly one success', async () => fixture(async ({ config, issuer }) => {
    const flow = await begin(config);
    const callback = await complete(flow);
    const body = { grant_type: 'authorization_code', client_id: 'test-client', code: callback.searchParams.get('code'), redirect_uri: redirect, code_verifier: flow.verifier };
    const replies = await Promise.all(Array.from({ length: 5 }, () => fetch(`${issuer}/token`, { method: 'POST', body: new URLSearchParams(body) })));
    assert.equal(replies.filter((reply) => reply.status === 200).length, 1);
    assert.ok(replies.every((reply) => reply.status === 200 || reply.status === 400), JSON.stringify(replies.map((reply) => reply.status)));
}));

test('current user roles and blocking affect UserInfo, refresh and existing SSO sessions', async () => fixture(async ({ config, user, admin }) => {
    const flow = await tokensFor(config);
    await setUserRoles(user.id, ['user'], admin);
    const promoted = await client.fetchUserInfo(config, flow.tokens.access_token, user.id);
    assert.deepEqual(promoted.roles, ['user']);
    assert.ok(promoted.capabilities.includes('explorer.access'));
    await setUserRoles(user.id, ['selfRegistered'], admin);
    const restricted = await client.fetchUserInfo(config, flow.tokens.access_token, user.id);
    assert.deepEqual(restricted.roles, ['selfRegistered']);
    assert.deepEqual(restricted.capabilities, ['selfregistered.dashboard.access']);
    await updateUser(user.id, { status: 'blocked' }, admin);
    await assert.rejects(client.fetchUserInfo(config, flow.tokens.access_token, user.id));
    await assert.rejects(client.refreshTokenGrant(config, flow.tokens.refresh_token));
    const next = await begin(config, { scope: 'openid', prompt: 'none' }, flow.browser);
    assert.equal(new URL(next.location).searchParams.get('error'), 'login_required');
}));

test('concurrent refresh reuse revokes the grant and never leaves a usable successor', async () => fixture(async ({ config, issuer, user }) => {
    const { tokens } = await tokensFor(config);
    const body = { grant_type: 'refresh_token', client_id: 'test-client', refresh_token: tokens.refresh_token };
    const responses = await Promise.all(Array.from({ length: 4 }, () => fetch(`${issuer}/token`, { method: 'POST', body: new URLSearchParams(body) })));
    assert.equal(responses.filter((response) => response.status === 200).length, 1);
    assert.ok(responses.every((response) => response.status === 200 || response.status === 400));
    const successor = await responses.find((response) => response.status === 200).json();
    await assert.rejects(client.refreshTokenGrant(config, successor.refresh_token));
    await assert.rejects(client.fetchUserInfo(config, successor.access_token, user.id));
}));

test('RP logout confirms sign-out, checks CSRF, returns state and clears the browser session and non-offline grant', async () => fixture(async ({ config, issuer, user }) => {
    const flow = await tokensFor(config, { scope: 'openid' });
    const url = new URL(`${issuer}/logout`);
    url.searchParams.set('id_token_hint', flow.tokens.id_token);
    url.searchParams.set('post_logout_redirect_uri', 'https://client.example.test/logged-out');
    url.searchParams.set('state', 'logout-state');
    const response = await flow.browser.fetch(url);
    assert.equal(response.status, 200);
    const html = await response.text();
    assert.ok(!html.includes('Stay signed in'));
    assert.ok(html.includes('name="logout" value="yes"'));
    const action = html.match(/id="op.logoutForm" method="post" action="([^"]+)"/)[1];
    const xsrf = html.match(/name="xsrf" value="([^"]+)"/)[1];
    const denied = await flow.browser.post(action, { xsrf: 'wrong', logout: 'yes' });
    assert.equal(denied.status, 400);
    await client.fetchUserInfo(config, flow.tokens.access_token, user.id);
    const signedOut = await flow.browser.post(action, { xsrf, logout: 'yes' });
    assert.equal(signedOut.status, 303);
    assert.equal(signedOut.headers.get('location'), 'https://client.example.test/logged-out?state=logout-state');
    await assert.rejects(client.fetchUserInfo(config, flow.tokens.access_token, user.id));
    const next = await begin(config, { scope: 'openid', prompt: 'none' }, flow.browser);
    assert.equal(new URL(next.location).searchParams.get('error'), 'login_required');
}));

test('confidential machine clients use client credentials, authenticated introspection, revocation and secret rotation', async () => fixture(async ({ issuer, admin }) => {
    const machine = await createOidcClient({ client_id: 'machine-client', grant_types: ['client_credentials'], scope: 'api' }, admin);
    const config = await client.discovery(new URL(issuer), 'machine-client', undefined, client.ClientSecretBasic(machine.client_secret), { execute: [client.allowInsecureRequests] });
    const token = await client.clientCredentialsGrant(config, { scope: 'api' });
    assert.ok(token.access_token);
    assert.equal(token.id_token, undefined);
    assert.equal(token.refresh_token, undefined);
    assert.equal((await client.tokenIntrospection(config, token.access_token)).active, true);
    await client.tokenRevocation(config, token.access_token);
    assert.equal((await client.tokenIntrospection(config, token.access_token)).active, false);
    await assert.rejects(client.clientCredentialsGrant(config, { scope: 'openid' }));
    await rotateOidcClientSecret('machine-client', admin);
    await assert.rejects(client.clientCredentialsGrant(config, { scope: 'api' }));
}));

test('client disabling revokes existing grants and public browser token/UserInfo CORS rejects unrelated origins', async () => fixture(async ({ config, user, issuer, admin }) => {
    const { tokens } = await tokensFor(config);
    const allowed = await fetch(`${issuer}/userinfo`, { headers: { authorization: `Bearer ${tokens.access_token}`, origin: 'https://client.example.test' } });
    assert.equal(allowed.headers.get('access-control-allow-origin'), 'https://client.example.test');
    const rejected = await fetch(`${issuer}/userinfo`, { headers: { authorization: `Bearer ${tokens.access_token}`, origin: 'https://evil.example' } });
    assert.equal(rejected.headers.get('access-control-allow-origin'), null);
    await updateOidcClient('test-client', { enabled: false }, admin);
    await assert.rejects(client.fetchUserInfo(config, tokens.access_token, user.id));
    await assert.rejects(client.refreshTokenGrant(config, tokens.refresh_token));
}));

test('OIDC registration uses normal user policy and disabled methods cannot bypass it', async () => fixture(async ({ config, admin }) => {
    const flow = await begin(config, { screen_hint: 'signup' });
    const registrationPage = await flow.browser.fetch(flow.location);
    const registrationHtml = await registrationPage.text();
    assert.match(registrationHtml, /<h1 tabindex="-1">Create your account<\/h1>/);
    const shell = wizardConfig(registrationHtml);
    assert.deepEqual([shell.screenHint, shell.setupComplete, shell.registration, shell.client.name], ['signup', true, true, 'test-client']);
    assert.equal(shell.csrf, csrf(registrationHtml));
    const callback = await complete(flow, 'new-oidc@example.test', { purpose: 'register' });
    const token = await client.authorizationCodeGrant(config, callback, { pkceCodeVerifier: flow.verifier, expectedState: flow.state, expectedNonce: flow.nonce });
    const registered = await client.fetchUserInfo(config, token.access_token, token.claims().sub);
    assert.deepEqual(registered.roles, ['selfRegistered']);
    assert.deepEqual(registered.capabilities, ['selfregistered.dashboard.access']);
    assert.equal(registered.email_verified, true);
    await updateAuthPolicy({ enabledAuthMethods: ['totp'] }, admin);
    const next = await begin(config, { screen_hint: 'signup' });
    const body = await (await next.browser.fetch(next.location)).text();
    const restricted = wizardConfig(body);
    assert.deepEqual(restricted.methods, { emailCode: false, passkey: false, totp: true, google: false });
    assert.equal(restricted.registration, false);
    const denied = await next.browser.post(`${next.location}/email-start`, { csrf: csrf(body), email: 'blocked-signup@example.test', purpose: 'register' });
    assert.equal(denied.status, 400);
    assert.deepEqual(await denied.json(), { error: 'access_denied' });
    for (const retired of ['login', 'register']) {
        assert.equal((await next.browser.post(`${next.location}/${retired}`, { email: 'owner@example.test', password: 'guess-password', csrf: csrf(body) })).status, 400);
    }
}));

test('signup hint retains existing sign-in and consent; failed codes re-render the wizard with a readable error', async () => fixture(async ({ config, owner, user }) => {
    for (const email of [owner.email, user.email]) {
        const flow = await begin(config, { screen_hint: 'signup' });
        const body = await (await flow.browser.fetch(flow.location)).text();
        const token = csrf(body);
        assert.equal((await flow.browser.post(`${flow.location}/attempt`, { csrf: token })).status, 200);
        const discovered = await (await flow.browser.post(`${flow.location}/discover`, { csrf: token, email })).json();
        assert.deepEqual([discovered.exists, discovered.methods.emailCode], [true, true]);
        const conflict = await flow.browser.post(`${flow.location}/email-start`, { csrf: token, email, purpose: 'register' });
        assert.equal(conflict.status, 409);
        assert.equal((await conflict.json()).error, 'account_exists');
        assert.equal((await flow.browser.post(`${flow.location}/email-start`, { csrf: token, email, purpose: 'login' })).status, 200);
        const wrong = mail.at(-1).code === '000000' ? '111111' : '000000';
        const failed = await flow.browser.post(`${flow.location}/email-verify`, { csrf: token, code: wrong });
        assert.equal(failed.status, 400);
        const failedHtml = await failed.text();
        assert.match(failedHtml, /Unable to sign in/);
        const failure = wizardConfig(failedHtml).failure;
        assert.deepEqual([failure.code, failure.attemptsRemaining, failure.action], ['code_invalid', 4, 'email-verify']);
        assert.equal(wizardConfig(failedHtml).email, email, 'the re-rendered wizard names the attempted address');
        assert.ok(!failedHtml.includes(mail.at(-1).code));
        const submitted = await flow.browser.post(`${flow.location}/email-verify`, { csrf: token, code: mail.at(-1).code });
        assert.equal(submitted.status, 303, await submitted.clone().text());
        // A reload after a lost response resumes the committed result instead of signing in again.
        const reloaded = await flow.browser.fetch(flow.location);
        assert.equal(reloaded.status, 303);
        assert.equal(reloaded.headers.get('location'), submitted.headers.get('location'));
        const callback = await complete({ ...flow, location: submitted.headers.get('location') }, email);
        const tokens = await client.authorizationCodeGrant(config, callback, { pkceCodeVerifier: flow.verifier, expectedState: flow.state, expectedNonce: flow.nonce });
        assert.ok(tokens.access_token);
        const returning = await begin(config, { screen_hint: 'signup' }, flow.browser);
        const consent = await returning.browser.fetch(returning.location);
        assert.match(await consent.text(), /<h1>Allow access\?<\/h1>/);
        assert.equal((await complete(returning, email, { allow: false })).searchParams.get('error'), 'access_denied');
    }
}));

test('a late same-email account during OIDC registration re-renders the wizard as a collision for that address', async () => fixture(async ({ config }) => {
    const flow = await begin(config, { screen_hint: 'signup' });
    const body = await (await flow.browser.fetch(flow.location)).text();
    const token = csrf(body);
    assert.equal((await flow.browser.post(`${flow.location}/attempt`, { csrf: token })).status, 200);
    assert.equal((await flow.browser.post(`${flow.location}/email-start`, { csrf: token, email: 'late@example.test', purpose: 'register' })).status, 200);
    const pendingCode = mail.at(-1).code;
    await setup.registerWithEmailCode('late@example.test');
    const collided = await flow.browser.post(`${flow.location}/email-verify`, { csrf: token, code: pendingCode });
    assert.equal(collided.status, 400);
    const rendered = wizardConfig(await collided.text());
    assert.deepEqual([rendered.failure.code, rendered.failure.action, rendered.email], ['account_exists', 'email-verify', 'late@example.test']);
}));

test('absent or unknown signup hints preserve sign-in-first, and signup policy is rechecked after rendering', async () => fixture(async ({ config, admin }) => {
    for (const params of [{}, { screen_hint: 'login' }, { screen_hint: '<script>signup</script>' }]) {
        const flow = await begin(config, params);
        const html = await (await flow.browser.fetch(flow.location)).text();
        assert.match(html, /<h1 tabindex="-1">Sign in<\/h1>/);
        assert.equal(wizardConfig(html).screenHint, '');
        assert.ok(!html.includes('<script>signup</script>'));
    }
    const flow = await begin(config, { screen_hint: 'signup' });
    const body = await (await flow.browser.fetch(flow.location)).text();
    await updateAuthPolicy({ selfRegistrationEnabled: false }, admin);
    const failed = await flow.browser.post(`${flow.location}/email-start`, { csrf: csrf(body), email: 'disabled@example.test', purpose: 'register' });
    assert.equal(failed.status, 403);
    assert.equal((await failed.json()).error, 'registration_disabled');
    assert.equal(await getUserByEmail('disabled@example.test'), null);
    const next = await begin(config, { screen_hint: 'signup' });
    assert.equal(wizardConfig(await (await next.browser.fetch(next.location)).text()).registration, false);
}));

test('setup stays claimed when every account is removed: OIDC signup then creates only selfRegistered', async () => fixture(async ({ config, owner, user }) => {
    const store = await getStore();
    await store.deleteUser(owner.id);
    await store.deleteUser(user.id);
    assert.equal((await getInstallationSetup()).complete, true);
    const flow = await begin(config, { screen_hint: 'signup' });
    const body = await (await flow.browser.fetch(flow.location)).text();
    assert.equal(wizardConfig(body).setupComplete, true);
    const callback = await complete({ ...flow }, 'public-owner@example.test', { purpose: 'register' });
    const tokens = await client.authorizationCodeGrant(config, callback, { pkceCodeVerifier: flow.verifier, expectedState: flow.state, expectedNonce: flow.nonce });
    const created = await getUserByEmail('public-owner@example.test');
    assert.equal(tokens.claims().sub, created.id);
    assert.deepEqual(await getUserRoles(created.id), ['selfRegistered']);
    assert.equal((await getInstallationSetup()).initialAdministratorId, owner.id);
}));
