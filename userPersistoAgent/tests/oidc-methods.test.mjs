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
import { getStore, flush, resetStoreForTests } from '../lib/store.mjs';
import * as totp from '../lib/auth/totp.mjs';

const redirectUri = 'https://methods-client.example.test/callback';
const mailCapture = Symbol.for('userpersisto.oidc-methods.test-mail');
globalThis[mailCapture] = [];
const transportUrl = `data:text/javascript,${encodeURIComponent(`
export function createAgentClient(agent) {
    if (agent !== 'emailAgent') throw new Error('Unexpected test agent');
    return {
        async callTool(name, payload) {
            if (name === 'email_auth_code_status') return { available: true };
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
        // The configured administrator password keeps the owner signed-in-capable
        // whatever sign-in methods a test disables.
        setup.configureAdministratorPassword();
        const { user: owner } = await setup.registerWithEmailCode('methods-owner@example.test');
        const { user } = await setup.registerWithEmailCode('methods-member@example.test');
        await updateAuthPolicy({ enabledAuthMethods: methods.length ? methods : ['google'] }, { actorId: owner.id });
        server = startService({ port: 0, host: '127.0.0.1' });
        if (!server.listening) await once(server, 'listening');
        const origin = `http://127.0.0.1:${server.address().port}`;
        const issuer = `${origin}/service/oidc`;
        process.env.USERPERSISTO_OIDC_ISSUER = issuer;
        await createOidcClient({ client_id: 'methods-client', redirect_uris: [redirectUri], token_endpoint_auth_method: 'none', scope: 'openid email' }, { actorId: owner.id });
        const config = await oidcClient.discovery(new URL(issuer), 'methods-client', undefined, oidcClient.None(), { execute: [oidcClient.allowInsecureRequests, oidcClient.enableNonRepudiationChecks] });
        await fn({ user, owner, origin, issuer, config });
    } finally {
        if (server?.listening) await new Promise((resolve) => server.close(resolve));
        resetOidcProviderForTests();
        await resetStoreForTests();
        setup.clearAdministratorPassword();
        delete process.env.USERPERSISTO_OIDC_ISSUER;
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
    assert.deepEqual(await disabled.json(), { error: 'access_denied' });
    await updateAuthPolicy({ enabledAuthMethods: ['emailCode'] }, { actorId: owner.id });
    await finish(config, flow, await flow.browser.post(`${flow.location}/email-verify`, { csrf: flow.csrf, code }), user);
    const logged = (await (await getStore()).select('emailLog')).objects.filter((entry) => entry.providerMessageId === 'disposable-test-message');
    assert.equal(logged.length, 1);
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
    for (const action of ['totp', 'email-start', 'email-verify', 'passkey-options', 'passkey-verify']) {
        const response = await flow.browser.post(`${flow.location}/${action}`, { csrf: flow.csrf, email: user.email, token: '000000', code: '000000', assertion: '{}' });
        assert.equal(response.status, 400, action);
        assert.deepEqual(await response.json(), { error: 'access_denied' });
    }
    assert.equal(globalThis[mailCapture].length, 0);
    assert.equal((await (await getStore()).select('authChallenge')).objects.length, 0);
}));

test('administrator sign-in completes through the interaction and the email-less administrator has no email claim', async () => {
    const folder = await mkdtemp(join(tmpdir(), 'userpersisto-oidc-admin-'));
    process.env.PERSISTENCE_FOLDER = folder;
    process.env.USERPERSISTO_SETTINGS_KEY = 'disposable-oidc-admin-settings-key';
    delete process.env.USERPERSISTO_AUTH_METHODS;
    setup.resetAuthLimitsForTests();
    let server;
    try {
        await ensureSeedData();
        const password = setup.configureAdministratorPassword();
        const { user: administrator } = await setup.claimAdministrator(password);
        assert.equal(administrator.email, '');
        server = startService({ port: 0, host: '127.0.0.1' });
        if (!server.listening) await once(server, 'listening');
        const issuer = `http://127.0.0.1:${server.address().port}/service/oidc`;
        process.env.USERPERSISTO_OIDC_ISSUER = issuer;
        await createOidcClient({ client_id: 'methods-client', redirect_uris: [redirectUri], token_endpoint_auth_method: 'none', scope: 'openid email' }, { actorId: administrator.id });
        const config = await oidcClient.discovery(new URL(issuer), 'methods-client', undefined, oidcClient.None(), { execute: [oidcClient.allowInsecureRequests, oidcClient.enableNonRepudiationChecks] });
        const flow = await begin(config);
        const wrong = await flow.browser.post(`${flow.location}/admin-login`, { csrf: flow.csrf, password: 'not-the-configured-value' });
        assert.equal(wrong.status, 400);
        assert.match(await wrong.text(), /data-server-failure/);
        const submitted = await flow.browser.post(`${flow.location}/admin-login`, { csrf: flow.csrf, password });
        assert.equal(submitted.status, 303, await submitted.clone().text());
        let location = submitted.headers.get('location');
        for (let step = 0; step < 8 && !location.startsWith(redirectUri); step += 1) {
            const page = await flow.browser.fetch(location);
            if ([302, 303].includes(page.status)) { location = page.headers.get('location'); continue; }
            const html = await page.text();
            assert.match(html, /Allow access\?/, 'administrator sign-in never approves application scopes');
            location = (await flow.browser.post(`${location}/confirm`, { csrf: csrfFrom(html) })).headers.get('location');
        }
        const tokens = await oidcClient.authorizationCodeGrant(config, new URL(location), { expectedNonce: flow.nonce, expectedState: flow.state, pkceCodeVerifier: flow.verifier });
        assert.equal(tokens.claims().sub, administrator.id);
        assert.equal(Object.hasOwn(tokens.claims(), 'email'), false);
        const info = await oidcClient.fetchUserInfo(config, tokens.access_token, administrator.id);
        assert.equal(Object.hasOwn(info, 'email'), false, 'an empty sign-in email is not published as a claim');
        assert.equal(Object.hasOwn(info, 'email_verified'), false);
    } finally {
        if (server?.listening) await new Promise((resolve) => server.close(resolve));
        resetOidcProviderForTests();
        await resetStoreForTests();
        setup.clearAdministratorPassword();
        delete process.env.USERPERSISTO_OIDC_ISSUER;
        await rm(folder, { recursive: true, force: true });
    }
});
