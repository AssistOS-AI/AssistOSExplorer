import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { createHash, generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import { registerHooks } from 'node:module';
import * as oidcClient from 'openid-client';
import { startService } from '../service/index.mjs';
import { ensureSeedData } from '../lib/bootstrap.mjs';
import * as setup from './helpers/setup.mjs';
import { updateAuthPolicy } from '../lib/policy.mjs';
import { createOidcClient } from '../lib/oidc/clients.mjs';
import { resetOidcProviderForTests } from '../lib/oidc/provider.mjs';
import { getStore, flush, resetStoreForTests, setStoreFaultInjectorForTests } from '../lib/store.mjs';
import { readOidcDocument, writeOidcDocument } from '../lib/oidc/adapter.mjs';
import { getOrCreateOidcKeys } from '../lib/oidc/secrets.mjs';
import { getInstallationSetup } from '../lib/setup.mjs';
import { getUserByEmail, getUserRoles } from '../lib/users.mjs';
import { completeReauthentication } from '../lib/auth/operationGrants.mjs';
import { setAccountPassword } from '../lib/auth/passwordManagement.mjs';
import { setKdfObserverForTests } from '../lib/auth/password.mjs';
import * as totp from '../lib/auth/totp.mjs';
import { completeGoogleIdentity, inspectGoogleIdentity } from '../lib/externalIdentities.mjs';

const redirectUri = 'https://methods-client.example.test/callback';
const mailCapture = Symbol.for('userpersisto.oidc-methods.test-mail');
globalThis[mailCapture] = [];
const transportUrl = `data:text/javascript,${encodeURIComponent(`
export function createAgentClient(agent) {
    if (agent !== 'emailAgent') throw new Error('Unexpected test agent');
    return {
        async callTool(name, payload) {
            if (name === 'email_auth_code_status') return { available: true };
            if (name === 'email_send_password_reset') {
                globalThis[Symbol.for('userpersisto.oidc-methods.test-mail')].push(structuredClone(payload));
                return { ok: true, providerMessageId: 'disposable-reset-message' };
            }
            if (name !== 'email_send_auth_code') throw new Error('Unexpected test tool');
            globalThis[Symbol.for('userpersisto.oidc-methods.test-mail')].push(structuredClone(payload));
            return { ok: true, providerMessageId: 'disposable-test-message' };
        },
        async close() {},
    };
}`)}`;
const hooks = registerHooks({
    resolve(specifier, context, nextResolve) {
        if (specifier === '/Agent/client/AgentMcpClient.mjs') return { url: transportUrl, shortCircuit: true };
        return nextResolve(specifier, context);
    },
});
after(() => {
    hooks.deregister();
    delete globalThis[mailCapture];
});

class Browser {
    cookies = new Map();
    async fetch(url, options = {}) {
        const path = new URL(url).pathname;
        const cookie = [...this.cookies].filter(([, value]) => path.startsWith(value.path)).map(([name, value]) => `${name}=${value.value}`).join('; ');
        const response = await fetch(url, { ...options, redirect: 'manual', headers: { cookie, ...options.headers } });
        for (const header of response.headers.getSetCookie()) {
            const [pair, ...attributes] = header.split(';');
            const index = pair.indexOf('=');
            const name = pair.slice(0, index);
            if (attributes.some((value) => /^\s*max-age=0$/i.test(value))) this.cookies.delete(name);
            else this.cookies.set(name, { value: pair.slice(index + 1), path: attributes.find((value) => /^\s*path=/i.test(value))?.trim().slice(5) || '/' });
        }
        return response;
    }
    post(url, body, origin = new URL(url).origin) {
        return this.fetch(url, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', origin }, body: new URLSearchParams(body) });
    }
}

async function fixture(methods, fn) {
    const previousEnvironment = { ...process.env };
    const folder = await mkdtemp(join(tmpdir(), 'userpersisto-oidc-methods-'));
    process.env.PERSISTENCE_FOLDER = folder;
    process.env.USERPERSISTO_SETTINGS_KEY = 'disposable-oidc-methods-settings-key';
    delete process.env.USERPERSISTO_AUTH_METHODS;
    delete process.env.USERPERSISTO_ALLOWED_REDIRECT_ORIGINS;
    globalThis[mailCapture].length = 0;
    setup.resetAuthLimitsForTests();
    let server;
    try {
        await ensureSeedData();
        process.env.USERPERSISTO_GOOGLE_CLIENT_ID = 'methods-google-client';
        process.env.USERPERSISTO_GOOGLE_REDIRECT_URI = 'http://127.0.0.1/service/auth/google/callback';
        const { user: owner } = await completeGoogleIdentity({ identity: { issuer: 'https://accounts.google.com', subject: 'methods-owner',
            email: 'methods-owner@gmail.com', emailVerified: true } });
        const { user, password } = await setup.signUpWithPassword('methods-member@example.test');
        await updateAuthPolicy({ enabledAuthMethods: [...new Set([...methods, 'google'])] }, { actorId: owner.id });
        server = startService({ port: 0, host: '127.0.0.1' });
        if (!server.listening) await once(server, 'listening');
        const origin = `http://127.0.0.1:${server.address().port}`;
        const issuer = `${origin}/service/oidc`;
        process.env.USERPERSISTO_OIDC_ISSUER = issuer;
        await createOidcClient({ client_id: 'methods-client', redirect_uris: [redirectUri], token_endpoint_auth_method: 'none', scope: 'openid email' }, { actorId: owner.id });
        const config = await oidcClient.discovery(new URL(issuer), 'methods-client', undefined, oidcClient.None(), { execute: [oidcClient.allowInsecureRequests, oidcClient.enableNonRepudiationChecks] });
        await fn({ user, owner, origin, issuer, config, password });
    } finally {
        if (server?.listening) await new Promise((resolve) => server.close(resolve));
        resetOidcProviderForTests();
        await resetStoreForTests();
        for (const name of Object.keys(process.env)) if (!Object.hasOwn(previousEnvironment, name)) delete process.env[name];
        Object.assign(process.env, previousEnvironment);
        await rm(folder, { recursive: true, force: true });
    }
}

async function initialPasswordFixture(fn) {
    const previousEnvironment = { ...process.env };
    const folder = await mkdtemp(join(tmpdir(), 'userpersisto-oidc-initial-password-'));
    process.env.PERSISTENCE_FOLDER = folder;
    process.env.USERPERSISTO_SETTINGS_KEY = 'disposable-initial-password-settings-key';
    for (const name of ['USERPERSISTO_AUTH_METHODS', 'USERPERSISTO_ALLOWED_REDIRECT_ORIGINS', 'USERPERSISTO_SELF_REGISTRATION_ENABLED',
        'USERPERSISTO_SIGNUP_EMAIL_VERIFICATION_REQUIRED']) delete process.env[name];
    globalThis[mailCapture].length = 0;
    setup.resetAuthLimitsForTests();
    let server;
    try {
        await ensureSeedData();
        server = startService({ port: 0, host: '127.0.0.1' }, { emailStatus: async () => ({ available: false }) });
        if (!server.listening) await once(server, 'listening');
        const issuer = `http://127.0.0.1:${server.address().port}/service/oidc`;
        process.env.USERPERSISTO_OIDC_ISSUER = issuer;
        // An operator-provisioned public client does not claim installation setup.
        await getOrCreateOidcKeys();
        const now = new Date().toISOString();
        await writeOidcDocument('Client', 'methods-client', { enabled: true, createdAt: now, updatedAt: now, metadata: {
            client_id: 'methods-client', client_name: 'methods-client', application_type: 'web', subject_type: 'public', redirect_uris: [redirectUri],
            post_logout_redirect_uris: [], token_endpoint_auth_method: 'none', grant_types: ['authorization_code'], response_types: ['code'],
            scope: 'openid email', id_token_signed_response_alg: 'RS256',
        } });
        const config = await oidcClient.discovery(new URL(issuer), 'methods-client', undefined, oidcClient.None(), {
            execute: [oidcClient.allowInsecureRequests, oidcClient.enableNonRepudiationChecks],
        });
        await fn({ config });
    } finally {
        setStoreFaultInjectorForTests(null);
        if (server?.listening) await new Promise((resolve) => server.close(resolve));
        resetOidcProviderForTests();
        await resetStoreForTests();
        for (const name of Object.keys(process.env)) if (!Object.hasOwn(previousEnvironment, name)) delete process.env[name];
        Object.assign(process.env, previousEnvironment);
        await rm(folder, { recursive: true, force: true });
    }
}

function csrfFrom(html) {
    const match = html.match(/name="csrf" value="([^"]+)"/);
    assert.ok(match, html);
    return match[1];
}

async function begin(config) {
    const browser = new Browser();
    const verifier = oidcClient.randomPKCECodeVerifier();
    const nonce = oidcClient.randomNonce();
    const state = oidcClient.randomState();
    const authorizationUrl = oidcClient.buildAuthorizationUrl(config, { redirect_uri: redirectUri, response_type: 'code', scope: 'openid email', prompt: 'consent',
        state, nonce, code_challenge_method: 'S256', code_challenge: await oidcClient.calculatePKCECodeChallenge(verifier) });
    const initiated = await browser.fetch(authorizationUrl);
    assert.equal(initiated.status, 303, await initiated.clone().text());
    const location = initiated.headers.get('location');
    const page = await browser.fetch(location);
    assert.equal(page.status, 200, await page.clone().text());
    return { browser, location, csrf: csrfFrom(await page.text()), verifier, nonce, state };
}

async function finish(config, flow, submitted, user) {
    assert.equal(submitted.status, 303, await submitted.clone().text());
    let location = submitted.headers.get('location');
    for (let step = 0; step < 8; step += 1) {
        if (location.startsWith(redirectUri)) {
            const tokens = await oidcClient.authorizationCodeGrant(config, new URL(location), { expectedNonce: flow.nonce, expectedState: flow.state, pkceCodeVerifier: flow.verifier });
            assert.equal(tokens.claims().sub, user.id);
            const info = await oidcClient.fetchUserInfo(config, tokens.access_token, user.id);
            assert.equal(info.email, user.email);
            return tokens;
        }
        const page = await flow.browser.fetch(location);
        if ([302, 303].includes(page.status)) { location = page.headers.get('location'); continue; }
        assert.equal(page.status, 200, await page.clone().text());
        const html = await page.text();
        assert.match(html, /Allow access\?/);
        const confirmed = await flow.browser.post(`${location}/confirm`, { csrf: csrfFrom(html) });
        assert.equal(confirmed.status, 303, await confirmed.clone().text());
        location = confirmed.headers.get('location');
    }
    assert.fail('OIDC consent did not reach the client callback.');
}

test('TOTP interaction verifies an enrolled authenticator and rejects CSRF and token replay', async () => fixture(['totp'], async ({ config, user }) => {
    const enrollment = await totp.setupStart({ userId: user.id });
    const token = totp.generateToken(enrollment.secret);
    assert.equal((await totp.setupVerify({ userId: user.id, token, setupId: enrollment.setupId })).ok, true);
    const flow = await begin(config);
    const invalidCsrf = await flow.browser.post(`${flow.location}/totp`, { csrf: 'wrong', email: user.email, token });
    assert.equal(invalidCsrf.status, 403);
    await finish(config, flow, await flow.browser.post(`${flow.location}/totp`, { csrf: flow.csrf, email: user.email, token }), user);
    const replayFlow = await begin(config);
    const replay = await replayFlow.browser.post(`${replayFlow.location}/totp`, { csrf: replayFlow.csrf, email: user.email, token });
    assert.equal(replay.status, 400);
    assert.match(await replay.text(), /Unable to sign in/);
}));

test('email-code interaction delivers through EmailAgent and binds verification to its browser transaction', async () => fixture(['emailCode'], async ({ config, user, owner }) => {
    const flow = await begin(config);
    assert.equal((await flow.browser.post(`${flow.location}/email-start`, { csrf: flow.csrf, email: user.email })).status, 400, 'purpose is required');
    const sent = await flow.browser.post(`${flow.location}/email-start`, { csrf: flow.csrf, email: user.email, purpose: 'login' });
    assert.equal(sent.status, 200, await sent.clone().text());
    assert.equal(globalThis[mailCapture].length, 1);
    const { code, correlationId, to } = globalThis[mailCapture][0];
    assert.equal(to, user.email);
    assert.match(correlationId, /^oidc-attempt:[a-f0-9]{16}:1$/);
    assert.ok(!correlationId.includes(flow.location.split('/').at(-1)), 'the interaction id is not disclosed to the mail provider');
    assert.match(code, /^\d{6}$/);
    assert.equal((await sent.text()).includes(code), false);
    const otherFlow = await begin(config);
    const misplaced = await otherFlow.browser.post(`${otherFlow.location}/email-verify`, { csrf: otherFlow.csrf, code });
    assert.equal(misplaced.status, 400);
    assert.match(await misplaced.text(), /Unable to sign in/);
    const stolen = await new Browser().post(`${flow.location}/email-verify`, { csrf: flow.csrf, code });
    assert.equal(stolen.status, 400);
    await updateAuthPolicy({ enabledAuthMethods: ['google'] }, { actorId: owner.id });
    const disabled = await flow.browser.post(`${flow.location}/email-verify`, { csrf: flow.csrf, code });
    assert.equal(disabled.status, 400);
    assert.deepEqual(interactionConfig(await disabled.text()).failure, {
        action: 'email-verify', code: 'auth_method_disabled', message: 'This sign-in method is not available.',
    });
    await updateAuthPolicy({ enabledAuthMethods: ['emailCode'] }, { actorId: owner.id });
    const refusedReplay = await flow.browser.post(`${flow.location}/email-verify`, { csrf: flow.csrf, code });
    assert.equal(interactionConfig(await refusedReplay.text()).failure.code, 'attempt_invalid');
    assert.equal((await flow.browser.post(`${flow.location}/email-start`, { csrf: flow.csrf, email: user.email, purpose: 'login' })).status, 200);
    await finish(config, flow, await flow.browser.post(`${flow.location}/email-verify`, { csrf: flow.csrf, code: globalThis[mailCapture].at(-1).code }), user);
    const logged = (await (await getStore()).select('emailLog')).objects.filter((entry) => entry.providerMessageId === 'disposable-test-message');
    assert.equal(logged.length, 2);
    assert.equal(logged[0].result, 'accepted');
}));

test('passkey interaction verifies a real P-256 assertion and rejects another interaction challenge', async () => fixture(['passkey'], async ({ config, user, origin }) => {
    const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const credentialId = randomBytes(24).toString('base64url');
    // A previously enrolled authenticator: only its public key is persisted.
    await (await getStore()).createAuthMethod({ key: `${user.id}:passkey:${credentialId}`, userId: user.id, type: 'passkey', enabled: true,
        credential: { credentialId, publicKeyJwk: publicKey.export({ format: 'jwk' }), alg: -7, counter: 0, transports: ['internal'] } });
    await flush();
    const flow = await begin(config);
    const optionsResponse = await flow.browser.post(`${flow.location}/passkey-options`, { csrf: flow.csrf, email: user.email });
    assert.equal(optionsResponse.status, 200);
    const options = await optionsResponse.json();
    assert.equal(options.ok, true);
    assert.equal(options.publicKey.allowCredentials[0].id, credentialId);
    const authenticatorData = Buffer.alloc(37);
    createHash('sha256').update(new URL(origin).hostname).digest().copy(authenticatorData);
    authenticatorData[32] = 0x05;
    authenticatorData.writeUInt32BE(1, 33);
    const clientDataJSON = Buffer.from(JSON.stringify({ type: 'webauthn.get', challenge: options.publicKey.challenge, origin }));
    const signature = sign('sha256', Buffer.concat([authenticatorData, createHash('sha256').update(clientDataJSON).digest()]), privateKey);
    const assertion = JSON.stringify({ id: credentialId, rawId: credentialId, type: 'public-key', response: {
        clientDataJSON: clientDataJSON.toString('base64url'), authenticatorData: authenticatorData.toString('base64url'), signature: signature.toString('base64url'),
    } });
    const otherFlow = await begin(config);
    const otherOptions = await otherFlow.browser.post(`${otherFlow.location}/passkey-options`, { csrf: otherFlow.csrf, email: user.email });
    assert.equal((await otherOptions.json()).ok, true);
    const misplaced = await otherFlow.browser.post(`${otherFlow.location}/passkey-verify`, { csrf: otherFlow.csrf, assertion });
    assert.equal(misplaced.status, 400);
    assert.match(await misplaced.text(), /Unable to sign in/);
    const stolen = await new Browser().post(`${flow.location}/passkey-verify`, { csrf: flow.csrf, assertion });
    assert.equal(stolen.status, 400);
    await finish(config, flow, await flow.browser.post(`${flow.location}/passkey-verify`, { csrf: flow.csrf, assertion }), user);
    const method = await (await getStore()).getAuthMethodByKey(`${user.id}:passkey:${credentialId}`);
    assert.equal(method.credential.counter, 1);
}));

test('disabled methods reject direct interaction POSTs before challenge creation', async () => fixture([], async ({ config, user }) => {
    const flow = await begin(config);
    const nativeActions = new Set(['totp', 'email-verify', 'passkey-verify', 'password-login', 'signup-create', 'signup-verify']);
    for (const action of ['totp', 'email-start', 'email-verify', 'passkey-options', 'passkey-verify', 'password-login', 'password-forgot', 'signup-start', 'signup-create', 'signup-resend', 'signup-email', 'signup-verify']) {
        const response = await flow.browser.post(`${flow.location}/${action}`, { csrf: flow.csrf, email: user.email, token: '000000', code: '000000', assertion: '{}',
            password: 'a password guess value', passwordConfirmation: 'a password guess value' });
        assert.equal(response.status, 400, action);
        if (nativeActions.has(action)) {
            const rendered = interactionConfig(await response.text());
            assert.equal(rendered.failure.action, action);
            assert.equal(rendered.methods.password, false);
        } else assert.deepEqual(await response.json(), { error: 'access_denied' });
    }
    assert.equal(globalThis[mailCapture].length, 0);
    assert.equal((await (await getStore()).select('authChallenge')).objects.length, 0);
}));

test('OIDC password-forgot emails a fragment link for an existing password account and answers uniformly', () => fixture(['password'], async ({ config, user }) => {
    const flow = await begin(config);
    const sent = await flow.browser.post(`${flow.location}/password-forgot`, { csrf: flow.csrf, email: user.email });
    assert.equal(sent.status, 200, await sent.clone().text());
    assert.deepEqual(await sent.json(), { ok: true });
    assert.equal(globalThis[mailCapture].length, 1);
    const captured = globalThis[mailCapture][0];
    assert.equal(captured.to, user.email);
    assert.equal(captured.expiresInMinutes, 30);
    assert.match(captured.resetUrl, /^http:\/\/127\.0\.0\.1:\d+\/service\/auth\/reset\.html#token=[A-Za-z0-9_-]{43}$/);
    assert.equal((await (await flow.browser.post(`${flow.location}/attempt`, { csrf: flow.csrf })).json()).passwordReset, true);
    globalThis[mailCapture].length = 0;
    const unknown = await flow.browser.post(`${flow.location}/password-forgot`, { csrf: flow.csrf, email: 'nobody@example.test' });
    assert.deepEqual([unknown.status, await unknown.json(), globalThis[mailCapture].length], [200, { ok: true }, 0]);
}));

function interactionConfig(html) {
    return JSON.parse(html.match(/<script type="application\/json" id="userpersisto-wizard-config">([^<]+)<\/script>/)[1]);
}

test('disabling password during OIDC signup returns to the wizard and erases the verified pending signup', async () => fixture(['password'], async ({ config, owner }) => {
    const flow = await begin(config);
    const email = 'policy-change-signup@example.test';
    const password = setup.newTestPassword();
    const started = await flow.browser.post(`${flow.location}/signup-start`, { csrf: flow.csrf, email, password, passwordConfirmation: password });
    assert.equal(started.status, 200, await started.clone().text());
    const code = globalThis[mailCapture].at(-1).code;
    await updateAuthPolicy({ enabledAuthMethods: ['google'] }, { actorId: owner.id });
    const refused = await flow.browser.post(`${flow.location}/signup-verify`, { csrf: flow.csrf, code });
    assert.equal(refused.status, 400);
    assert.match(refused.headers.get('content-type'), /text\/html/);
    const rendered = interactionConfig(await refused.text());
    assert.deepEqual([rendered.failure.action, rendered.failure.code, rendered.email], ['signup-verify', 'auth_method_disabled', email]);
    const resumed = await (await flow.browser.post(`${flow.location}/attempt`, { csrf: flow.csrf })).json();
    assert.equal(resumed.attempt.signupPending, false);
    assert.equal(resumed.attempt.challenge, null);
    assert.equal(await getUserByEmail(email), null);
    await updateAuthPolicy({ enabledAuthMethods: ['password', 'google'] }, { actorId: owner.id });
    const retry = await flow.browser.post(`${flow.location}/signup-verify`, { csrf: flow.csrf, code });
    assert.equal(interactionConfig(await retry.text()).failure.code, 'signup_restart_required');
    assert.equal(await getUserByEmail(email), null);
}));

// The interaction result's `amr` is persisted on the browser's engine session;
// ID tokens carry only the configured claims.
async function sessionAmr(browser) {
    const sessionId = browser.cookies.get('up_oidc_session')?.value;
    assert.ok(sessionId, 'the browser holds an engine session');
    return (await readOidcDocument('Session', sessionId))?.amr;
}

async function consentTokens(config, flow, submitted, subject) {
    assert.equal(submitted.status, 303, await submitted.clone().text());
    let location = submitted.headers.get('location');
    for (let step = 0; step < 8 && !location.startsWith(redirectUri); step += 1) {
        const page = await flow.browser.fetch(location);
        if ([302, 303].includes(page.status)) { location = page.headers.get('location'); continue; }
        const html = await page.text();
        assert.match(html, /Allow access\?/, 'signing in never approves application scopes');
        location = (await flow.browser.post(`${location}/confirm`, { csrf: csrfFrom(html) })).headers.get('location');
    }
    const tokens = await oidcClient.authorizationCodeGrant(config, new URL(location), { expectedNonce: flow.nonce, expectedState: flow.state, pkceCodeVerifier: flow.verifier });
    assert.equal(tokens.claims().sub, subject);
    return tokens;
}

test('password login completes natively with pwd, re-renders failures without secrets and no administrator action exists', async () => fixture(['password', 'emailCode'], async ({ config, owner, user, password }) => {
    const flow = await begin(config);
    const retired = await flow.browser.post(`${flow.location}/admin-login`, { csrf: flow.csrf, password: 'admin' });
    assert.deepEqual([retired.status, await retired.json()], [400, { error: 'invalid_request' }]);
    for (const [email, guess] of [[owner.email, 'admin'], [user.email, 'not the member password'], ['nobody@example.test', password]]) {
        const refused = await flow.browser.post(`${flow.location}/password-login`, { csrf: flow.csrf, email, password: guess });
        assert.equal(refused.status, 400);
        const html = await refused.text();
        assert.equal(html.includes(guess), false, 'the attempted password is never rendered');
        const rendered = interactionConfig(html);
        assert.deepEqual([rendered.failure.action, rendered.failure.code, rendered.email], ['password-login', 'authentication_failed', email]);
    }
    const tokens = await consentTokens(config, flow, await flow.browser.post(`${flow.location}/password-login`, { csrf: flow.csrf, email: user.email, password }), user.id);
    assert.deepEqual(await sessionAmr(flow.browser), ['pwd']);
    const info = await oidcClient.fetchUserInfo(config, tokens.access_token, user.id);
    assert.equal(info.email, user.email);
    // A password change advances the generation and revokes stored OIDC artifacts.
    const { grant } = await completeReauthentication({ userId: user.id, operation: 'password.set', method: 'password', password });
    const replacement = setup.newTestPassword();
    assert.deepEqual(await setAccountPassword({ userId: user.id, grant, password: replacement, passwordConfirmation: replacement }), { ok: true, changed: true });
    await assert.rejects(oidcClient.fetchUserInfo(config, tokens.access_token, user.id));
    const next = await begin(config);
    const old = await next.browser.post(`${next.location}/password-login`, { csrf: next.csrf, email: user.email, password });
    assert.equal(old.status, 400);
    await consentTokens(config, next, await next.browser.post(`${next.location}/password-login`, { csrf: next.csrf, email: user.email, password: replacement }), user.id);
}));

test('OIDC first-install password login needs no email delivery and keeps the mailbox unverified', () => initialPasswordFixture(async ({ config }) => {
    await updateAuthPolicy({ signupEmailVerificationRequired: true }, { emailStatus: async () => ({ available: true }) });
    const email = 'oidc-initial-owner@gmail.com';
    const flow = await begin(config);
    const page = interactionConfig(await (await flow.browser.fetch(flow.location)).text());
    assert.deepEqual([page.setupComplete, page.initialPasswordSetup, page.signup.email], [false, true, false]);
    const body = { csrf: flow.csrf, email, password: 'admin' };
    const foreign = await flow.browser.post(`${flow.location}/password-login`, body, 'https://unrelated.example.test');
    assert.equal(foreign.status, 403);
    assert.equal((await flow.browser.post(`${flow.location}/password-login`, { ...body, csrf: 'invalid' })).status, 403);
    process.env.USERPERSISTO_AUTH_METHODS = 'google';
    const disabled = await flow.browser.post(`${flow.location}/password-login`, body);
    assert.equal(interactionConfig(await disabled.text()).failure.code, 'auth_method_disabled');
    assert.equal(await getUserByEmail(email), null);
    delete process.env.USERPERSISTO_AUTH_METHODS;
    for (const password of ['ADMIN', ' admin', 'admin ', 'ａｄｍｉｎ', setup.newTestPassword()]) {
        const refused = await flow.browser.post(`${flow.location}/password-login`, { ...body, password });
        assert.equal(refused.status, 400);
        assert.equal(await getUserByEmail(email), null);
    }
    const submitted = await flow.browser.post(`${flow.location}/password-login`, body);
    const created = await getUserByEmail(email);
    assert.ok(created);
    assert.deepEqual(await getUserRoles(created.id), ['admin']);
    assert.equal(created.emailVerifiedAt, '');
    assert.equal((await getInstallationSetup()).initialAdministratorId, created.id);
    assert.equal(globalThis[mailCapture].length, 0);
    const tokens = await consentTokens(config, flow, submitted, created.id);
    assert.deepEqual(await sessionAmr(flow.browser), ['pwd']);
    const info = await oidcClient.fetchUserInfo(config, tokens.access_token, created.id);
    assert.deepEqual([info.email, info.email_verified], [email, false]);
    const collision = await inspectGoogleIdentity({ issuer: 'https://accounts.google.com', subject: 'initial-owner-google', email, emailVerified: true });
    assert.equal(collision.kind, 'collision');
    assert.deepEqual(collision.eligibleMethods, ['password'], 'the unproven email cannot authorize a Google link');
    const later = await begin(config);
    const current = interactionConfig(await (await later.browser.fetch(later.location)).text());
    assert.deepEqual([current.setupComplete, current.initialPasswordSetup], [true, false]);
    await consentTokens(config, later, await later.browser.post(`${later.location}/password-login`, { csrf: later.csrf, email, password: 'admin' }), created.id);
    const other = await begin(config);
    assert.equal((await other.browser.post(`${other.location}/password-login`, { csrf: other.csrf, email: 'another@example.test', password: 'admin' })).status, 400);
    assert.equal(await getUserByEmail('another@example.test'), null);
    assert.equal((await (await getStore()).select('user')).objects.length, 1);
}));

test('OIDC default policy advertises password signup without email delivery', () => initialPasswordFixture(async ({ config }) => {
    const flow = await begin(config);
    const page = interactionConfig(await (await flow.browser.fetch(flow.location)).text());
    assert.deepEqual([page.setupComplete, page.initialPasswordSetup, page.signup.email, page.signup.verification, page.passwordReset],
        [false, true, true, 'none', false]);
}));

test('OIDC initial-password completion replays only for its browser after the local commit', () => initialPasswordFixture(async ({ config }) => {
    const email = 'oidc-initial-retry@example.test';
    const flow = await begin(config);
    let injected = false;
    setStoreFaultInjectorForTests(async (phase, name, args) => {
        if (!injected && phase === 'before' && ['updateOidcRecord', 'createOidcRecord'].includes(name) && args.at(-1)?.model === 'Interaction') {
            injected = true;
            throw new Error('injected initial-password interaction result failure');
        }
    });
    const interrupted = await flow.browser.post(`${flow.location}/password-login`, { csrf: flow.csrf, email, password: 'admin' });
    setStoreFaultInjectorForTests(null);
    assert.equal(injected, true);
    assert.ok(interrupted.status >= 500);
    const created = await getUserByEmail(email);
    assert.ok(created);
    assert.equal(created.emailVerifiedAt, '');
    const foreign = await new Browser().post(`${flow.location}/password-login`, { csrf: flow.csrf, email, password: 'admin' });
    assert.ok(foreign.status >= 400 && foreign.status < 500);
    let kdfRuns = 0;
    setKdfObserverForTests(() => { kdfRuns += 1; });
    const resumed = await flow.browser.post(`${flow.location}/password-login`, { csrf: flow.csrf, email, password: 'admin' });
    setKdfObserverForTests(null);
    assert.equal(kdfRuns, 0, 'same-browser completion replays instead of verifying or creating another account');
    const repeated = await flow.browser.fetch(flow.location);
    assert.equal(repeated.status, 303, 'a committed interaction retains its normal resume redirect');
    await consentTokens(config, flow, resumed, created.id);
    assert.equal((await (await getStore()).select('user')).objects.length, 1);
    assert.equal(globalThis[mailCapture].length, 0);
}));

test('OIDC native signup-create creates the first administrator without mail and finishes the interaction', () => initialPasswordFixture(async ({ config }) => {
    const flow = await begin(config);
    const email = 'oidc-signup-create@example.test';
    const password = setup.newTestPassword();
    const refused = await flow.browser.post(`${flow.location}/signup-create`, { csrf: flow.csrf, email, password, passwordConfirmation: `${password} other` });
    assert.equal(refused.status, 400);
    const rendered = interactionConfig(await refused.text());
    assert.deepEqual([rendered.failure.action, rendered.failure.code, rendered.email], ['signup-create', 'password_mismatch', email]);
    assert.equal(await getUserByEmail(email), null);
    const submitted = await flow.browser.post(`${flow.location}/signup-create`, { csrf: flow.csrf, email, password, passwordConfirmation: password });
    const created = await getUserByEmail(email);
    assert.ok(created);
    assert.equal(created.emailVerifiedAt, '');
    assert.deepEqual(await getUserRoles(created.id), ['admin']);
    assert.deepEqual([(await getInstallationSetup()).method, (await getInstallationSetup()).initialAdministratorId], ['passwordSignup', created.id]);
    assert.equal(globalThis[mailCapture].length, 0, 'direct OIDC signup never asks EmailAgent for a code');
    const tokens = await consentTokens(config, flow, submitted, created.id);
    assert.deepEqual(await sessionAmr(flow.browser), ['pwd']);
    const info = await oidcClient.fetchUserInfo(config, tokens.access_token, created.id);
    assert.deepEqual([info.email, info.email_verified], [email, false]);
}));

test('OIDC signup-create spends the discovery budget of its interaction and renders rate_limited once it is spent', () => initialPasswordFixture(async ({ config }) => {
    const email = 'oidc-signup-create-budget@example.test';
    const password = setup.newTestPassword();
    const owner = await begin(config);
    await owner.browser.post(`${owner.location}/signup-create`, { csrf: owner.csrf, email, password, passwordConfirmation: password });
    assert.ok(await getUserByEmail(email));

    const flow = await begin(config);
    const body = { csrf: flow.csrf, email, password, passwordConfirmation: password };
    for (let index = 0; index < 20; index += 1) {
        const refused = interactionConfig(await (await flow.browser.post(`${flow.location}/signup-create`, body)).text());
        assert.deepEqual([refused.failure.action, refused.failure.code], ['signup-create', 'account_exists']);
    }
    const limited = interactionConfig(await (await flow.browser.post(`${flow.location}/signup-create`, body)).text());
    assert.deepEqual([limited.failure.action, limited.failure.code], ['signup-create', 'rate_limited']);
    assert.equal((await (await getStore()).select('user')).objects.length, 1);
}));

test('OIDC signup-create replays across its two boundaries for the same browser only', () => initialPasswordFixture(async ({ config }) => {
    const email = 'oidc-signup-create-replay@example.test';
    const password = setup.newTestPassword();
    const flow = await begin(config);
    let injected = false;
    setStoreFaultInjectorForTests(async (phase, name, args) => {
        if (!injected && phase === 'before' && ['updateOidcRecord', 'createOidcRecord'].includes(name) && args.at(-1)?.model === 'Interaction') {
            injected = true;
            throw new Error('injected signup-create interaction result failure');
        }
    });
    const body = { csrf: flow.csrf, email, password, passwordConfirmation: password };
    const interrupted = await flow.browser.post(`${flow.location}/signup-create`, body);
    setStoreFaultInjectorForTests(null);
    assert.equal(injected, true);
    assert.ok(interrupted.status >= 500);
    const created = await getUserByEmail(email);
    assert.ok(created);
    assert.equal(created.emailVerifiedAt, '');
    const foreign = await new Browser().post(`${flow.location}/signup-create`, body);
    assert.ok(foreign.status >= 400 && foreign.status < 500);
    assert.equal((await (await getStore()).select('user')).objects.length, 1);
    let kdfRuns = 0;
    setKdfObserverForTests(() => { kdfRuns += 1; });
    const resumed = await flow.browser.post(`${flow.location}/signup-create`, body);
    setKdfObserverForTests(null);
    assert.equal(kdfRuns, 0, 'same-browser completion replays instead of hashing or creating another account');
    const repeated = await flow.browser.fetch(flow.location);
    assert.equal(repeated.status, 303, 'a committed interaction retains its normal resume redirect');
    await consentTokens(config, flow, resumed, created.id);
    assert.equal((await (await getStore()).select('user')).objects.length, 1);
    assert.equal(globalThis[mailCapture].length, 0);
}));

test('the first administrator claims an unclaimed installation through OIDC signup across two persistence boundaries', async () => {
    const previousEnvironment = { ...process.env };
    const folder = await mkdtemp(join(tmpdir(), 'userpersisto-oidc-signup-'));
    process.env.PERSISTENCE_FOLDER = folder;
    process.env.USERPERSISTO_SETTINGS_KEY = 'disposable-oidc-signup-settings-key';
    for (const name of ['USERPERSISTO_AUTH_METHODS', 'USERPERSISTO_ALLOWED_REDIRECT_ORIGINS', 'USERPERSISTO_SELF_REGISTRATION_ENABLED']) delete process.env[name];
    globalThis[mailCapture].length = 0;
    setup.resetAuthLimitsForTests();
    let server;
    try {
        await ensureSeedData();
        server = startService({ port: 0, host: '127.0.0.1' });
        if (!server.listening) await once(server, 'listening');
        const issuer = `http://127.0.0.1:${server.address().port}/service/oidc`;
        process.env.USERPERSISTO_OIDC_ISSUER = issuer;
        // An operator-provisioned public client; no account exists yet.
        await getOrCreateOidcKeys();
        const now = new Date().toISOString();
        await writeOidcDocument('Client', 'methods-client', { enabled: true, createdAt: now, updatedAt: now, metadata: {
            client_id: 'methods-client', client_name: 'methods-client', application_type: 'web', subject_type: 'public', redirect_uris: [redirectUri],
            post_logout_redirect_uris: [], token_endpoint_auth_method: 'none', grant_types: ['authorization_code'], response_types: ['code'],
            scope: 'openid email', id_token_signed_response_alg: 'RS256' } });
        const config = await oidcClient.discovery(new URL(issuer), 'methods-client', undefined, oidcClient.None(), { execute: [oidcClient.allowInsecureRequests, oidcClient.enableNonRepudiationChecks] });
        const flow = await begin(config);
        const page = interactionConfig(await (await flow.browser.fetch(flow.location)).text());
        assert.deepEqual([page.setupComplete, page.signup.email, page.methods.password], [false, true, true]);
        const password = setup.newTestPassword();
        const staged = await flow.browser.post(`${flow.location}/signup-start`, { csrf: flow.csrf, email: 'oidc-owner@example.test', password, passwordConfirmation: password });
        assert.equal(staged.status, 200, await staged.clone().text());
        const stagedBody = await staged.json();
        assert.deepEqual([stagedBody.challenge.purpose, stagedBody.challenge.delivery], ['register', 'accepted']);
        assert.equal(globalThis[mailCapture].at(-1).purpose, 'signup-verification');
        assert.equal(await getUserByEmail('oidc-owner@example.test'), null);
        const code = globalThis[mailCapture].at(-1).code;
        // A wrong code re-renders on the verification step without the code.
        const wrong = await flow.browser.post(`${flow.location}/signup-verify`, { csrf: flow.csrf, code: code === '000000' ? '111111' : '000000' });
        assert.equal(wrong.status, 400);
        const wrongHtml = await wrong.text();
        assert.deepEqual([interactionConfig(wrongHtml).failure.action, interactionConfig(wrongHtml).failure.code], ['signup-verify', 'code_invalid']);
        // Stop between the local commit and the engine's interaction result.
        let injected = false;
        setStoreFaultInjectorForTests(async (phase, name, args) => {
            if (!injected && phase === 'before' && ['updateOidcRecord', 'createOidcRecord'].includes(name) && args.at(-1)?.model === 'Interaction') {
                injected = true;
                throw new Error('injected interaction result write failure');
            }
        });
        const interrupted = await flow.browser.post(`${flow.location}/signup-verify`, { csrf: flow.csrf, code });
        setStoreFaultInjectorForTests(null);
        assert.equal(injected, true);
        assert.ok(interrupted.status >= 500, `the interrupted finish reports failure: ${interrupted.status}`);
        const created = await getUserByEmail('oidc-owner@example.test');
        assert.ok(created, 'the first boundary committed the account');
        assert.deepEqual(await getUserRoles(created.id), ['admin']);
        assert.deepEqual([(await getInstallationSetup()).initialAdministratorId, (await getInstallationSetup()).method], [created.id, 'passwordSignup']);
        // Another browser cannot resume; the same browser does without a new code.
        const foreign = await new Browser().post(`${flow.location}/signup-verify`, { csrf: flow.csrf, code });
        assert.ok(foreign.status >= 400 && foreign.status < 500);
        const tokens = await consentTokens(config, flow, await flow.browser.post(`${flow.location}/signup-verify`, { csrf: flow.csrf, code: '000000' }), created.id);
        assert.deepEqual(await sessionAmr(flow.browser), ['emailCode']);
        const info = await oidcClient.fetchUserInfo(config, tokens.access_token, created.id);
        assert.deepEqual([info.email, info.email_verified], ['oidc-owner@example.test', true]);
        // The chosen password signs the new administrator in afterwards.
        const later = await begin(config);
        await consentTokens(config, later, await later.browser.post(`${later.location}/password-login`, { csrf: later.csrf, email: 'oidc-owner@example.test', password }), created.id);
    } finally {
        setStoreFaultInjectorForTests(null);
        if (server?.listening) await new Promise((resolve) => server.close(resolve));
        resetOidcProviderForTests();
        await resetStoreForTests();
        for (const name of Object.keys(process.env)) if (!Object.hasOwn(previousEnvironment, name)) delete process.env[name];
        Object.assign(process.env, previousEnvironment);
        await rm(folder, { recursive: true, force: true });
    }
});
