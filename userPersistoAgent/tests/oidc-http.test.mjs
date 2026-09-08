import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import * as client from 'openid-client';
import { startService } from '../service/index.mjs';
import { ensureSeedData } from '../lib/bootstrap.mjs';
import { registerUser, updateUser, setUserRoles, getSetupStatus, getUserByEmail } from '../lib/users.mjs';
import { createOidcClient, updateOidcClient, rotateOidcClientSecret } from '../lib/oidc/clients.mjs';
import { resetOidcProviderForTests } from '../lib/oidc/provider.mjs';
import { getStore, resetStoreForTests } from '../lib/store.mjs';
import { updateAuthPolicy } from '../lib/policy.mjs';

const password = 'correct-oidc-test-password';
const redirect = 'https://client.example.test/callback';

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
    let server;
    try {
        await ensureSeedData();
        const { user: owner } = await registerUser({ email: 'owner@example.test', password });
        const { user } = await registerUser({ email: 'member@example.test', password });
        server = startService({ port: 0, host: '127.0.0.1' });
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

async function complete(flow, email = 'member@example.test', { action = 'login', allow = true } = {}) {
    let location = flow.location;
    for (let step = 0; step < 10; step++) {
        if (location.startsWith(redirect)) return new URL(location);
        const response = await flow.browser.fetch(location);
        if (response.status === 303 || response.status === 302) { location = response.headers.get('location'); continue; }
        assert.equal(response.status, 200, await response.clone().text());
        const body = await response.text();
        const consent = body.includes('Allow access?');
        const submission = await flow.browser.post(`${location}/${consent ? allow ? 'confirm' : 'abort' : action}`, {
            csrf: csrf(body), ...(consent ? {} : { email, password }),
        });
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
    assert.equal(info.email_verified, false);
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
    assert.equal((await flow.browser.post(`${flow.location}/login`, { email: user.email, password, csrf: csrf(form) }, 'https://evil.example')).status, 403);
    assert.equal((await flow.browser.post(`${flow.location}/login`, { email: user.email, password, csrf: 'wrong' })).status, 403);
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

test('OIDC registration uses normal user policy and disabled methods cannot bypass it', async () => fixture(async ({ config, owner, admin }) => {
    const flow = await begin(config, { screen_hint: 'signup' });
    const registrationPage = await flow.browser.fetch(flow.location);
    const registrationHtml = await registrationPage.text();
    assert.match(registrationHtml, /<h1>Create your account<\/h1>/);
    assert.ok(registrationHtml.indexOf('/register"') < registrationHtml.indexOf('/login"'));
    assert.match(registrationHtml, /<summary>Already registered\? Sign in<\/summary>/);
    const callback = await complete(flow, 'new-oidc@example.test', { action: 'register' });
    const token = await client.authorizationCodeGrant(config, callback, { pkceCodeVerifier: flow.verifier, expectedState: flow.state, expectedNonce: flow.nonce });
    const registered = await client.fetchUserInfo(config, token.access_token, token.claims().sub);
    assert.deepEqual(registered.roles, ['selfRegistered']);
    assert.deepEqual(registered.capabilities, ['selfregistered.dashboard.access']);
    await updateAuthPolicy({ enabledAuthMethods: ['totp'] }, admin);
    const next = await begin(config, { screen_hint: 'signup' });
    const body = await (await next.browser.fetch(next.location)).text();
    assert.ok(!body.includes('/login"'));
    assert.ok(!body.includes('/register"'));
    assert.match(body, /<h1>Sign in<\/h1>/);
    assert.equal((await next.browser.post(`${next.location}/login`, { email: owner.email, password, csrf: csrf(body) })).status, 400);
}));

test('signup hint retains existing sign-in and consent; retry errors show the attempted form', async () => fixture(async ({ config, owner, user }) => {
    for (const email of [owner.email, user.email]) {
        const flow = await begin(config, { screen_hint: 'signup' });
        const body = await (await flow.browser.fetch(flow.location)).text();
        const failed = await flow.browser.post(`${flow.location}/login`, { email, password: 'invalid-password', csrf: csrf(body) });
        assert.equal(failed.status, 400);
        const failedHtml = await failed.text();
        assert.match(failedHtml, /<h1>Sign in<\/h1>/);
        assert.ok(failedHtml.indexOf('/login"') < failedHtml.indexOf('/register"'));
        const callback = await complete(flow, email);
        const tokens = await client.authorizationCodeGrant(config, callback, { pkceCodeVerifier: flow.verifier, expectedState: flow.state, expectedNonce: flow.nonce });
        assert.ok(tokens.access_token);
        const returning = await begin(config, { screen_hint: 'signup' }, flow.browser);
        const consent = await returning.browser.fetch(returning.location);
        assert.match(await consent.text(), /<h1>Allow access\?<\/h1>/);
        assert.equal((await complete(returning, email, { allow: false })).searchParams.get('error'), 'access_denied');
    }
    const registration = await begin(config, { screen_hint: 'signup' });
    const body = await (await registration.browser.fetch(registration.location)).text();
    const failed = await registration.browser.post(`${registration.location}/register`, { email: 'invalid', password, csrf: csrf(body) });
    assert.equal(failed.status, 400);
    const failedHtml = await failed.text();
    assert.match(failedHtml, /<h1>Create your account<\/h1>/);
    assert.match(failedHtml, /Unable to create an account/);
    assert.equal(await getUserByEmail('invalid'), null);
}));

test('absent or unknown signup hints preserve sign-in-first, and signup policy is rechecked after rendering', async () => fixture(async ({ config, admin }) => {
    for (const params of [{}, { screen_hint: 'login' }, { screen_hint: '<script>signup</script>' }]) {
        const flow = await begin(config, params);
        const html = await (await flow.browser.fetch(flow.location)).text();
        assert.match(html, /<h1>Sign in<\/h1>/);
        assert.ok(html.indexOf('/login"') < html.indexOf('/register"'));
        assert.ok(!html.includes('<script>signup</script>'));
    }
    const flow = await begin(config, { screen_hint: 'signup' });
    const body = await (await flow.browser.fetch(flow.location)).text();
    await updateAuthPolicy({ selfRegistrationEnabled: false }, admin);
    const failed = await flow.browser.post(`${flow.location}/register`, { email: 'disabled@example.test', password, csrf: csrf(body) });
    assert.equal(failed.status, 400);
    assert.ok(!(await failed.text()).includes('/register"'));
    assert.equal(await getUserByEmail('disabled@example.test'), null);
    const next = await begin(config, { screen_hint: 'signup' });
    const html = await (await next.browser.fetch(next.location)).text();
    assert.match(html, /<h1>Sign in<\/h1>/);
    assert.ok(!html.includes('/register"'));
}));

test('OIDC registration cannot create an initial administrator when client metadata survives an empty user store', async () => fixture(async ({ config, owner, user }) => {
    const store = await getStore();
    await store.deleteUser(owner.id);
    await store.deleteUser(user.id);
    assert.equal((await getSetupStatus()).needsInitialAdmin, true);
    const flow = await begin(config, { screen_hint: 'signup' });
    const body = await (await flow.browser.fetch(flow.location)).text();
    assert.ok(!body.includes('/register"'));
    const failed = await flow.browser.post(`${flow.location}/register`, { email: 'public-owner@example.test', password, csrf: csrf(body), allowInitialAdmin: 'true' });
    assert.equal(failed.status, 400);
    assert.equal((await getSetupStatus()).userCount, 0);
    assert.equal(await getUserByEmail('public-owner@example.test'), null);
    const setup = await registerUser({ email: 'setup-owner@example.test', password });
    assert.equal(setup.firstUser, true);
    assert.deepEqual(setup.roles, ['admin']);
}));
