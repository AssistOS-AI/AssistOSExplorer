import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { AsyncResource } from 'node:async_hooks';
import { generateKeyPairSync, randomBytes, createHash, sign } from 'node:crypto';
import * as oidc from 'openid-client';
import { controlledGoogleProvider, CookieBrowser, csrf } from './helpers/googleProvider.mjs';
import { startService } from '../service/index.mjs';
import { ensureSeedData } from '../lib/bootstrap.mjs';
import { registerUser, getUserByEmail, getUserRoles, updateUser } from '../lib/users.mjs';
import { getStore, flush, resetStoreForTests, setStoreFaultInjectorForTests } from '../lib/store.mjs';
import { updateAuthPolicy } from '../lib/policy.mjs';
import { createLoginRequest, consumeAuthCode } from '../lib/sso.mjs';
import { createOidcClient } from '../lib/oidc/clients.mjs';
import { resetOidcProviderForTests } from '../lib/oidc/provider.mjs';
import { getGoogleStatus } from '../lib/auth/google.mjs';
import { verifyEmailCode, hashCode } from '../lib/auth/email-code.mjs';
import { setupStart, setupVerify, generateToken } from '../lib/auth/totp.mjs';
import { loginVerify as verifyPasskey } from '../lib/auth/passkey.mjs';
import { setPassword, loginWithPassword } from '../lib/auth/password.mjs';
import { hashGoogleState } from '../lib/auth/googleTransactions.mjs';
import { withPersistenceScope } from '../lib/persistence-scope.mjs';

async function fixture(fn) {
    const provider = await controlledGoogleProvider();
    const folder = await mkdtemp(join(tmpdir(), 'google-http-'));
    const env = { ...process.env };
    let server;
    let mail;
    try {
        process.env.PERSISTENCE_FOLDER = folder;
        process.env.USERPERSISTO_SETTINGS_KEY = 'controlled-settings-key';
        process.env.USERPERSISTO_GOOGLE_CLIENT_ID = 'controlled-google-client';
        process.env.USERPERSISTO_GOOGLE_CLIENT_SECRET = 'controlled-google-secret';
        delete process.env.USERPERSISTO_AUTH_METHODS;
        delete process.env.USERPERSISTO_SELF_REGISTRATION_ENABLED;
        await ensureSeedData();
        const { user: owner } = await registerUser({ email: 'owner@example.test', password: 'controlled-password' });
        server = startService({ port: 0, host: '127.0.0.1' }, { google: { protocol: provider.protocol, deliverEmail: async (payload) => { mail = payload; return { delivered: true }; } } });
        if (!server.listening) await once(server, 'listening');
        const base = `http://127.0.0.1:${server.address().port}`;
        process.env.USERPERSISTO_GOOGLE_REDIRECT_URI = `${base}/service/auth/google/callback`;
        process.env.USERPERSISTO_OIDC_ISSUER = `${base}/service/oidc`;
        await updateAuthPolicy({ enabledAuthMethods: ['password', 'google'], defaultRegistrationRole: 'user' });
        const begin = async (browser = new CookieBrowser(), state = 'distinct-router-core-state') => {
            const request = await createLoginRequest({ redirectUri: `${base}/auth/callback` });
            const response = await browser.json(`${base}/service/auth/google/start`, { requestId: request.providerState, state });
            assert.equal(response.status, 200, await response.clone().text());
            const start = await response.json();
            return { browser, request, start, state };
        };
        const callback = async (flow) => {
            const url = await provider.approve(flow.start.authorizationUrl);
            const response = await flow.browser.fetch(url);
            assert.equal(response.status, 303, await response.clone().text());
            return { url, resume: new URL(response.headers.get('location'), base).href };
        };
        const beginOidc = async () => {
            const clientId = `controlled-${randomBytes(8).toString('hex')}`;
            await createOidcClient({ client_id: clientId, client_name: 'Controlled application',
                redirect_uris: ['https://client.example.test/callback'], token_endpoint_auth_method: 'none',
                grant_types: ['authorization_code'], scope: 'openid email roles' }, { actorId: owner.id });
            const config = await oidc.discovery(new URL(`${base}/service/oidc`), clientId, undefined, oidc.None(), { execute: [oidc.allowInsecureRequests] });
            const authorization = oidc.buildAuthorizationUrl(config, { redirect_uri: 'https://client.example.test/callback',
                scope: 'openid email roles', state: oidc.randomState(), nonce: oidc.randomNonce(),
                code_challenge: await oidc.calculatePKCECodeChallenge(oidc.randomPKCECodeVerifier()), code_challenge_method: 'S256' });
            const browser = new CookieBrowser();
            const response = await browser.fetch(authorization);
            const interaction = new URL(response.headers.get('location'), base).href;
            const html = await (await browser.fetch(interaction)).text();
            const started = await browser.post(`${interaction}/google`, { csrf: csrf(html) });
            assert.equal(started.status, 200);
            return { browser, start: await started.json() };
        };
        await fn({ provider, base, folder, owner, begin, beginOidc, callback, mail: () => mail });
    } finally {
        setStoreFaultInjectorForTests();
        if (server?.listening) { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); }
        resetOidcProviderForTests();
        await resetStoreForTests();
        for (const name of Object.keys(process.env)) if (!Object.hasOwn(env, name)) delete process.env[name];
        Object.assign(process.env, env);
        await provider.close();
        await rm(folder, { recursive: true, force: true });
    }
}

for (const method of ['password', 'totp']) {
    test(`replacing ${method} after reauthentication invalidates pending Google link confirmation`, () => fixture(async ({ owner, provider, begin, callback }) => {
        let token;
        if (method === 'totp') {
            await updateAuthPolicy({ enabledAuthMethods: ['password', 'google', 'totp'] });
            const setup = await setupStart({ userId: owner.id });
            token = generateToken(setup.secret);
            assert.equal((await setupVerify({ userId: owner.id, token })).ok, true);
        }
        provider.state.email = owner.email;
        const flow = await begin();
        const returned = await callback(flow);
        let html = await (await flow.browser.fetch(returned.resume)).text();
        html = await (await flow.browser.post(`${returned.resume}/authenticate`, {
            csrf: csrf(html), method, password: 'controlled-password', token,
        })).text();
        assert.match(html, /Link Google and continue/);
        if (method === 'password') {
            await setPassword({ userId: owner.id, newPassword: 'replacement-password' });
            assert.equal((await loginWithPassword(owner.email, 'controlled-password')).ok, false);
        } else {
            const replacement = await setupStart({ userId: owner.id });
            assert.equal((await setupVerify({ userId: owner.id, token: generateToken(replacement.secret) })).ok, true);
        }
        const response = await flow.browser.post(`${returned.resume}/confirm-link`, { csrf: csrf(html) });
        assert.equal(response.status, 403);
        assert.equal(response.headers.get('location'), null);
        assert.equal((await (await getStore()).select('externalIdentity')).objects.length, 0);
        assert.equal((await getUserByEmail(owner.email)).id, owner.id);
    }));
}

for (const flowKind of ['explorer', 'oidc']) {
    for (const change of ['disable', 'rotate']) {
        test(`${flowKind} rechecks Google ${change} queued after identity commit before handoff`, () => fixture(async ({ begin, beginOidc, callback, provider }) => {
            const start = flowKind === 'explorer' ? begin : beginOidc;
            const flow = await start();
            const returned = await callback(flow);
            const outside = new AsyncResource('google-configuration-change');
            let changed;
            let completed = false;
            setStoreFaultInjectorForTests((phase, operation, args) => {
                if (phase === 'after' && operation === 'updateGoogleAuthTransaction' && args[1]?.status === 'consumed') {
                    outside.runInAsyncScope(() => {
                        changed = withPersistenceScope(async () => {
                            if (change === 'disable') await updateAuthPolicy({ enabledAuthMethods: ['password'] });
                            else process.env.USERPERSISTO_GOOGLE_CLIENT_SECRET = 'rotated-controlled-secret';
                            completed = true;
                        });
                    });
                }
            });
            const response = await flow.browser.fetch(returned.resume);
            await changed;
            setStoreFaultInjectorForTests();
            outside.emitDestroy();
            assert.equal(completed, true);
            assert.ok([400, 403].includes(response.status), await response.text());
            assert.equal(response.headers.get('location'), null);
            const store = await getStore();
            assert.equal((await store.select('ssoAuthCode')).objects.length, 0);
            const bindings = (await store.select('externalIdentity')).objects;
            assert.equal(bindings.length, 1);
            const user = await getUserByEmail(provider.state.email);
            assert.equal(bindings[0].userId, user.id);
            await updateAuthPolicy({ enabledAuthMethods: ['password', 'google'] });
            process.env.USERPERSISTO_GOOGLE_CLIENT_SECRET = 'controlled-google-secret';
            const retry = await start();
            const resumed = await callback(retry);
            assert.equal((await retry.browser.fetch(resumed.resume)).status, 303);
            assert.equal((await getUserByEmail(provider.state.email)).id, user.id);
            assert.equal((await store.select('externalIdentity')).objects.length, 1);
        }));
    }

    test(`${flowKind} expiry during identity staging denies handoff without poisoning storage`, () => fixture(async ({ begin, beginOidc, callback, provider, owner }) => {
        const start = flowKind === 'explorer' ? begin : beginOidc;
        const flow = await start();
        const returned = await callback(flow);
        const state = new URL(flow.start.authorizationUrl).searchParams.get('state');
        const store = await getStore();
        const transaction = await store.getGoogleAuthTransactionByStateHash(hashGoogleState(state));
        const realNow = Date.now;
        let expired = false;
        let response;
        try {
            setStoreFaultInjectorForTests((phase, operation) => {
                if (phase === 'after' && operation === 'createExternalIdentity') {
                    expired = true;
                    Date.now = () => transaction.expiresAt + 1;
                }
            });
            response = await flow.browser.fetch(returned.resume);
        } finally {
            Date.now = realNow;
            setStoreFaultInjectorForTests();
        }
        assert.equal(expired, true);
        assert.equal(response.status, 400);
        assert.equal(response.headers.get('location'), null);
        assert.equal((await getUserByEmail(owner.email)).id, owner.id);
        assert.equal((await store.select('ssoAuthCode')).objects.length, 0);
        const created = await getUserByEmail(provider.state.email);
        assert.deepEqual(await getUserRoles(created.id), ['selfRegistered']);
        assert.equal((await store.select('externalIdentity')).objects[0].userId, created.id);
        const retry = await start();
        const resumed = await callback(retry);
        assert.equal((await retry.browser.fetch(resumed.resume)).status, 303);
        assert.equal((await getUserByEmail(provider.state.email)).id, created.id);
        assert.equal((await store.select('externalIdentity')).objects.length, 1);
    }));
}

test('Google is disabled/misconfigured safely and public readiness never returns config', () => fixture(async ({ base }) => {
    await updateAuthPolicy({ enabledAuthMethods: ['password'] });
    assert.equal((await getGoogleStatus()).available, false);
    await updateAuthPolicy({ enabledAuthMethods: ['password', 'google'] });
    delete process.env.USERPERSISTO_GOOGLE_CLIENT_SECRET;
    assert.equal((await getGoogleStatus()).available, false);
    const data = await (await fetch(`${base}/service/auth/setup`)).json();
    assert.deepEqual(data.enabledAuthMethods, ['password']);
    assert.equal(data.googleAvailable, false);
    assert.ok(!JSON.stringify(data).includes('controlled-google'));
}));

test('Explorer fresh registration uses selfRegistered and keeps independent core state; callbacks cannot replay', () => fixture(async ({ begin, callback, provider }) => {
    const flow = await begin();
    const returned = await callback(flow);
    const response = await flow.browser.fetch(returned.resume);
    assert.equal(response.status, 303, await response.clone().text());
    const destination = new URL(response.headers.get('location'), returned.resume);
    assert.equal(destination.pathname, '/auth/callback');
    assert.equal(destination.searchParams.get('state'), flow.state);
    const authenticated = await consumeAuthCode({ providerState: flow.request.providerState, code: destination.searchParams.get('code') });
    assert.deepEqual(authenticated.roles, ['selfRegistered']);
    assert.equal((await getUserByEmail(provider.state.email)).passwordHash, '');
    assert.equal((await flow.browser.fetch(returned.url)).status, 400);
    assert.equal((await flow.browser.fetch(returned.resume)).status, 400);
    assert.equal(provider.state.exchanges, 1);
}));

test('missing, copied, duplicate and mismatched callback proof cannot consume the valid attempt', () => fixture(async ({ begin, callback, provider }) => {
    const flow = await begin();
    const url = await provider.approve(flow.start.authorizationUrl);
    assert.equal((await new CookieBrowser().fetch(url)).status, 400);
    const duplicate = new URL(url); duplicate.searchParams.append('state', 'other');
    assert.equal((await flow.browser.fetch(duplicate)).status, 400);
    const both = new URL(url); both.searchParams.set('error', 'bad');
    assert.equal((await flow.browser.fetch(both)).status, 400);
    assert.equal(provider.state.exchanges, 0);
    const response = await flow.browser.fetch(url);
    assert.equal(response.status, 303);
    assert.equal(provider.state.exchanges, 1);
}));

test('Explorer initiation rejects missing/foreign/null Origin, form posts and identity overrides', () => fixture(async ({ base }) => {
    const request = await createLoginRequest({ redirectUri: `${base}/auth/callback` });
    const url = `${base}/service/auth/google/start`;
    const body = { requestId: request.providerState, state: 'core-state' };
    for (const origin of ['', 'null', 'https://foreign.test']) assert.equal((await new CookieBrowser().json(url, body, origin)).status, 403);
    assert.equal((await new CookieBrowser().post(url, body)).status, 403);
    assert.equal((await new CookieBrowser().json(url, { ...body, userId: 'owner', roles: ['admin'] })).status, 400);
    assert.equal((await fetch(url, { method: 'POST', headers: { origin: base, 'content-type': 'application/json' }, body: '{' })).status, 400);
}));

test('collision refuses email proof and requires fresh existing password then separate confirmation', () => fixture(async ({ base, owner, provider, begin, callback }) => {
    provider.state.email = owner.email;
    const flow = await begin();
    const returned = await callback(flow);
    let response = await flow.browser.fetch(returned.resume);
    let html = await response.text();
    assert.match(html, /Link your existing account/);
    assert.ok(!html.includes('name="email"'));
    assert.equal((await flow.browser.post(`${returned.resume}/authenticate`, { csrf: csrf(html), method: 'emailCode', code: '123456' })).status, 400);
    assert.equal((await flow.browser.post(`${returned.resume}/confirm-link`, { csrf: csrf(html) })).status, 400);
    response = await flow.browser.post(`${returned.resume}/authenticate`, { csrf: csrf(html), method: 'password', password: 'controlled-password' });
    html = await response.text();
    assert.match(html, /Link Google and continue/);
    assert.equal((await (await getStore()).select('externalIdentity', {}, { start: 0, pageSize: 10 })).objects.length, 0);
    response = await flow.browser.post(`${returned.resume}/confirm-link`, { csrf: csrf(html) });
    assert.equal(response.status, 303, await response.clone().text());
    assert.deepEqual(await getUserRoles(owner.id), ['admin']);
    provider.state.email = 'changed@gmail.com';
    await updateAuthPolicy({ selfRegistrationEnabled: false });
    const returning = await begin();
    const next = await callback(returning);
    const final = await returning.browser.fetch(next.resume);
    assert.equal(final.status, 303);
    assert.equal(await getUserByEmail('changed@gmail.com'), null);
    assert.equal((await getUserByEmail(owner.email)).id, owner.id);
}));

test('third party registration mailbox proof stays transaction-bound and late collision requires non-email linking', () => fixture(async ({ provider, begin, callback, mail }) => {
    provider.state.email = 'third-party@example.test';
    const flow = await begin();
    const returned = await callback(flow);
    let html = await (await flow.browser.fetch(returned.resume)).text();
    assert.match(html, /Verify your email/);
    assert.equal(await getUserByEmail(provider.state.email), null);
    html = await (await flow.browser.post(`${returned.resume}/send-email-proof`, { csrf: csrf(html) })).text();
    assert.ok(mail().correlationId.startsWith('google-registration-email:'));
    assert.equal((await verifyEmailCode({ challengeId: mail().correlationId, code: mail().code })).ok, false);
    await registerUser({ email: provider.state.email, password: 'attacker-password' });
    const response = await flow.browser.post(`${returned.resume}/verify-email-proof`, { csrf: csrf(html), code: mail().code });
    assert.equal(response.status, 400);
    assert.equal((await (await getStore()).select('externalIdentity', {}, { start: 0, pageSize: 10 })).objects.length, 0);
    html = await (await flow.browser.fetch(returned.resume)).text();
    assert.match(html, /Link your existing account/);
}));

test('new third-party registration requires and consumes its dedicated mailbox proof', () => fixture(async ({ provider, begin, callback, mail }) => {
    provider.state.email = 'new-third-party@example.test';
    const flow = await begin();
    const returned = await callback(flow);
    let html = await (await flow.browser.fetch(returned.resume)).text();
    html = await (await flow.browser.post(`${returned.resume}/send-email-proof`, { csrf: csrf(html) })).text();
    const response = await flow.browser.post(`${returned.resume}/verify-email-proof`, { csrf: csrf(html), code: mail().code });
    assert.equal(response.status, 303, await response.clone().text());
    assert.ok((await getUserByEmail(provider.state.email)).emailVerifiedAt);
}));

test('ordinary email-code verifier rejects another purpose before consuming its challenge', () => fixture(async ({ owner }) => {
    const store = await getStore();
    await store.createAuthChallenge({ challengeId: 'foreign-proof', subject: owner.id, purpose: 'google-registration-email', correlationId: 'other',
        expiresAt: new Date(Date.now() + 60_000).toISOString(), attempts: 0, codeHash: hashCode('123456', 'foreign-proof') });
    assert.equal((await verifyEmailCode({ challengeId: 'foreign-proof', code: '123456' })).ok, false);
    assert.ok(await store.getAuthChallengeByChallengeId('foreign-proof'));
}));

test('two browser attempts retain separate cookies and pending/verified attempts recover after store reopen', () => fixture(async ({ provider, begin, callback }) => {
    const browser = new CookieBrowser();
    const first = await begin(browser, 'first-core');
    const second = await begin(browser, 'second-core');
    assert.equal(browser.cookies.size, 2);
    await resetStoreForTests();
    provider.state.subject = 'first-sub'; provider.state.email = 'first@gmail.com';
    const firstReturn = await callback(first);
    provider.state.subject = 'second-sub'; provider.state.email = 'second@gmail.com';
    const secondReturn = await callback(second);
    await resetStoreForTests();
    for (const [flow, returned] of [[first, firstReturn], [second, secondReturn]]) {
        const response = await browser.fetch(returned.resume);
        assert.equal(response.status, 303, await response.clone().text());
        assert.equal(new URL(response.headers.get('location'), returned.resume).searchParams.get('state'), flow.state);
    }
    assert.equal(browser.cookies.size, 0);
    assert.equal((await (await getStore()).select('externalIdentity')).objects.length, 2);
}));

test('provider denial and browser cancellation cannot produce an identity or replay', () => fixture(async ({ provider, begin, callback }) => {
    provider.state.mode = 'denied';
    const flow = await begin();
    const denied = await provider.approve(flow.start.authorizationUrl);
    const response = await flow.browser.fetch(denied);
    assert.match(await response.text(), /Sign-in cancelled/);
    assert.equal((await flow.browser.fetch(denied)).status, 400);
    assert.equal(provider.state.exchanges, 0);
    provider.state.mode = ''; provider.state.email = 'cancel@example.test';
    const next = await begin();
    const returned = await callback(next);
    const html = await (await next.browser.fetch(returned.resume)).text();
    assert.equal((await next.browser.post(`${returned.resume}/cancel`, { csrf: csrf(html) })).status, 200);
    assert.equal((await next.browser.fetch(returned.resume)).status, 400);
    assert.equal(await getUserByEmail(provider.state.email), null);
}));

test('an ambiguous timed-out token exchange fails once and does not hold persistence or redeem again', () => fixture(async ({ provider, begin }) => {
    let release;
    provider.state.tokenGate = new Promise((resolve) => { release = resolve; });
    try {
        const flow = await begin();
        const returned = await provider.approve(flow.start.authorizationUrl);
        const pending = flow.browser.fetch(returned);
        const deadline = Date.now() + 1000;
        while (!provider.state.exchanges && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
        assert.equal(provider.state.exchanges, 1);
        // This durable operation completes while upstream is still held.
        await updateAuthPolicy({ selfRegistrationEnabled: false });
        const response = await pending;
        assert.equal(response.status, 400);
        release();
        assert.equal((await flow.browser.fetch(returned)).status, 400);
        assert.equal(provider.state.exchanges, 1);
        assert.equal(await getUserByEmail(provider.state.email), null);
    } finally { release(); }
}));

test('configuration, registration policy and parent expiry are rechecked after upstream verification', () => fixture(async ({ provider, begin, callback }) => {
    for (const change of ['configuration', 'registration', 'parent']) {
        provider.state.subject = change; provider.state.email = `${change}@gmail.com`;
        const flow = await begin();
        const returned = await callback(flow);
        if (change === 'configuration') process.env.USERPERSISTO_GOOGLE_CLIENT_SECRET = 'changed';
        if (change === 'registration') await updateAuthPolicy({ selfRegistrationEnabled: false });
        if (change === 'parent') {
            const store = await getStore();
            const request = await store.getSsoLoginRequestByProviderState(flow.request.providerState);
            await store.updateSsoLoginRequest(request.id, { expiresAt: new Date(Date.now() - 1000).toISOString() });
            await flush();
        }
        assert.ok((await flow.browser.fetch(returned.resume)).status >= 400, change);
        assert.equal(await getUserByEmail(provider.state.email), null);
        process.env.USERPERSISTO_GOOGLE_CLIENT_SECRET = 'controlled-google-secret';
        await updateAuthPolicy({ selfRegistrationEnabled: true });
    }
}));

test('blocked collision and a disabled proven method cannot authorize confirmation', () => fixture(async ({ owner, provider, begin, callback }) => {
    provider.state.email = owner.email;
    const flow = await begin();
    const returned = await callback(flow);
    let html = await (await flow.browser.fetch(returned.resume)).text();
    html = await (await flow.browser.post(`${returned.resume}/authenticate`, { csrf: csrf(html), method: 'password', password: 'controlled-password' })).text();
    assert.match(html, /Link Google and continue/);
    process.env.USERPERSISTO_AUTH_METHODS = 'google';
    assert.ok((await flow.browser.post(`${returned.resume}/confirm-link`, { csrf: csrf(html) })).status >= 400);
    delete process.env.USERPERSISTO_AUTH_METHODS;
    const member = await registerUser({ email: 'blocked@example.test', password: 'member-password' });
    provider.state.email = member.user.email; provider.state.subject = 'blocked';
    const blocked = await begin();
    const blockedReturn = await callback(blocked);
    await updateUser(member.user.id, { status: 'blocked' });
    assert.ok((await blocked.browser.fetch(blockedReturn.resume)).status >= 400);
    assert.equal((await (await getStore()).select('externalIdentity')).objects.length, 0);
}));

test('policy cannot leave an unlinked administrator with only Google', () => fixture(async ({ base }) => {
    await assert.rejects(updateAuthPolicy({ enabledAuthMethods: ['google'] }), { code: 'administrator_auth_method_required' });
    assert.deepEqual((await (await fetch(`${base}/service/auth/methods`)).json()).methods, ['password', 'google']);
}));

test('an enrolled TOTP authenticates the collision but still needs explicit linking confirmation', () => fixture(async ({ provider, owner, begin, callback }) => {
    await updateAuthPolicy({ enabledAuthMethods: ['password', 'google', 'totp'] });
    const setup = await setupStart({ userId: owner.id });
    const token = generateToken(setup.secret);
    assert.equal((await setupVerify({ userId: owner.id, token })).ok, true);
    provider.state.email = owner.email;
    const flow = await begin();
    const returned = await callback(flow);
    let html = await (await flow.browser.fetch(returned.resume)).text();
    html = await (await flow.browser.post(`${returned.resume}/authenticate`, { csrf: csrf(html), method: 'totp', token })).text();
    assert.match(html, /Link Google and continue/);
    assert.equal((await (await getStore()).select('externalIdentity')).objects.length, 0);
    assert.equal((await flow.browser.post(`${returned.resume}/confirm-link`, { csrf: csrf(html) })).status, 303);
}));

for (const change of ['counter advanced', 'replaced', 'removed']) {
    test(`real P-256 Google link proof checks its purpose and ${change} credential`, () => fixture(async ({ provider, owner, base, begin, callback }) => {
        await updateAuthPolicy({ enabledAuthMethods: ['password', 'google', 'passkey'] });
        const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
        const credentialId = randomBytes(24).toString('base64url');
        await (await getStore()).createAuthMethod({ key: `${owner.id}:passkey:${credentialId}`, userId: owner.id, type: 'passkey', enabled: true,
            credential: { credentialId, publicKeyJwk: publicKey.export({ format: 'jwk' }), alg: -7, counter: 0, transports: ['internal'] } });
        await flush();
        provider.state.email = owner.email;
        const flow = await begin();
        const returned = await callback(flow);
        let html = await (await flow.browser.fetch(returned.resume)).text();
        const options = await (await flow.browser.post(`${returned.resume}/challenge`, { csrf: csrf(html) })).json();
        const authenticatorData = Buffer.alloc(37);
        createHash('sha256').update(new URL(base).hostname).digest().copy(authenticatorData);
        authenticatorData[32] = 0x01;
        authenticatorData.writeUInt32BE(1, 33);
        const clientDataJSON = Buffer.from(JSON.stringify({ type: 'webauthn.get', challenge: options.publicKey.challenge, origin: base }));
        const signature = sign('sha256', Buffer.concat([authenticatorData, createHash('sha256').update(clientDataJSON).digest()]), privateKey);
        const assertion = { id: credentialId, rawId: credentialId, type: 'public-key', response: {
            clientDataJSON: clientDataJSON.toString('base64url'), authenticatorData: authenticatorData.toString('base64url'), signature: signature.toString('base64url') } };
        assert.equal((await verifyPasskey({ email: owner.email, origin: base, challengeKey: options.challengeKey, assertion })).ok, false);
        html = await (await flow.browser.post(`${returned.resume}/authenticate`, { csrf: csrf(html), method: 'passkey', assertion: JSON.stringify(assertion) })).text();
        assert.match(html, /Link Google and continue/);
        const store = await getStore();
        const enrolled = await store.getAuthMethodByKey(owner.id + ':passkey:' + credentialId);
        if (change === 'replaced') {
            const replacement = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
            await store.updateAuthMethod(enrolled.id, { credential: { ...enrolled.credential, publicKeyJwk: replacement.publicKey.export({ format: 'jwk' }) } });
        } else if (change === 'removed') await store.deleteAuthMethod(enrolled.id);
        else await store.updateAuthMethod(enrolled.id, { credential: { ...enrolled.credential, counter: 2 } });
        await flush();
        const confirmed = await flow.browser.post(returned.resume + '/confirm-link', { csrf: csrf(html) });
        assert.equal(confirmed.status, change === 'counter advanced' ? 303 : 403);
        assert.equal((await store.select('externalIdentity')).objects.length, change === 'counter advanced' ? 1 : 0);
    }));
}

test('downstream OIDC resumes browser interaction, local subject and explicit consent through real engine', () => fixture(async ({ base, owner, provider }) => {
    const issuer = `${base}/service/oidc`;
    await createOidcClient({ client_id: 'controlled-downstream', client_name: 'Controlled application', redirect_uris: ['https://client.example.test/callback'],
        token_endpoint_auth_method: 'none', grant_types: ['authorization_code'], scope: 'openid email roles' }, { actorId: owner.id });
    const config = await oidc.discovery(new URL(issuer), 'controlled-downstream', undefined, oidc.None(), { execute: [oidc.allowInsecureRequests, oidc.enableNonRepudiationChecks] });
    const verifier = oidc.randomPKCECodeVerifier();
    const state = oidc.randomState();
    const nonce = oidc.randomNonce();
    const authorization = oidc.buildAuthorizationUrl(config, { redirect_uri: 'https://client.example.test/callback', scope: 'openid email roles', state, nonce,
        code_challenge: await oidc.calculatePKCECodeChallenge(verifier), code_challenge_method: 'S256' });
    const browser = new CookieBrowser();
    let response = await browser.fetch(authorization);
    const interaction = new URL(response.headers.get('location'), issuer).href;
    const html = await (await browser.fetch(interaction)).text();
    assert.match(html, /Continue with Google/);
    response = await browser.post(`${interaction}/google`, { csrf: csrf(html) });
    assert.equal(response.status, 200, await response.clone().text());
    const upstream = await provider.approve((await response.json()).authorizationUrl);
    response = await browser.fetch(upstream);
    assert.equal(response.status, 303, await response.clone().text());
    const resume = new URL(response.headers.get('location'), base).href;
    assert.ok(resume.includes('/google-resume?transaction='));
    assert.equal((await new CookieBrowser().fetch(resume)).status, 400);
    response = await browser.fetch(resume);
    assert.equal(response.status, 303, await response.clone().text());
    let location = new URL(response.headers.get('location'), base).href;
    for (let count = 0; count < 6; count += 1) {
        response = await browser.fetch(location);
        if (response.status === 200) break;
        assert.equal(response.status, 303);
        location = new URL(response.headers.get('location'), base).href;
    }
    const consent = await response.text();
    assert.match(consent, /Allow access\?/);
    response = await browser.post(`${location}/confirm`, { csrf: csrf(consent) });
    location = new URL(response.headers.get('location'), base).href;
    for (let count = 0; count < 6 && new URL(location).origin === base; count += 1) {
        response = await browser.fetch(location);
        location = new URL(response.headers.get('location'), base).href;
    }
    const tokens = await oidc.authorizationCodeGrant(config, new URL(location), { pkceCodeVerifier: verifier, expectedState: state, expectedNonce: nonce });
    const user = await getUserByEmail(provider.state.email);
    assert.equal(tokens.claims().sub, user.id);
    const info = await oidc.fetchUserInfo(config, tokens.access_token, user.id);
    assert.deepEqual(info.roles, ['selfRegistered']);
    assert.ok(!JSON.stringify(info).includes('controlled-user'));
}));
