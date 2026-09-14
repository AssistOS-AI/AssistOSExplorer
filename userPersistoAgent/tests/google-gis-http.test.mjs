import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateKeyPair, exportJWK, createLocalJWKSet, SignJWT } from 'jose';
import { createGoogleProtocol, getGoogleStatus, GOOGLE_LOCAL_CLIENT_ID } from '../lib/auth/google.mjs';
import { startService } from '../service/index.mjs';
import { ensureSeedData } from '../lib/bootstrap.mjs';
import { getStore, resetStoreForTests } from '../lib/store.mjs';
import { createLoginRequest, consumeAuthCode } from '../lib/sso.mjs';
import { getUserByEmail, getUserRoles } from '../lib/users.mjs';
import { getInstallationSetup } from '../lib/setup.mjs';
import { CookieBrowser } from './helpers/googleProvider.mjs';

async function fixture(run) {
    const previous = { ...process.env };
    const folder = await mkdtemp(join(tmpdir(), 'google-gis-http-'));
    const keys = await generateKeyPair('RS256');
    const jwk = await exportJWK(keys.publicKey);
    const localKeys = createLocalJWKSet({ keys: [{ ...jwk, kid: 'gis-http', alg: 'RS256' }] });
    let gate;
    let verifyStarted;
    let server;
    let verifications = 0;
    try {
        for (const key of Object.keys(process.env)) if (key.startsWith('USERPERSISTO_GOOGLE_')) delete process.env[key];
        process.env.PERSISTENCE_FOLDER = folder;
        process.env.USERPERSISTO_SETTINGS_KEY = 'isolated-gis-http-settings';
        delete process.env.USERPERSISTO_AUTH_METHODS;
        delete process.env.USERPERSISTO_SELF_REGISTRATION_ENABLED;
        delete process.env.USERPERSISTO_OIDC_ISSUER;
        await ensureSeedData();
        const defaults = await getGoogleStatus();
        const protocol = createGoogleProtocol({ jwks: async (...args) => {
            verifications += 1;
            verifyStarted?.();
            if (gate) await gate;
            return localKeys(...args);
        } });
        server = startService({ port: 0, host: '127.0.0.1' }, { google: { protocol } });
        if (!server.listening) await once(server, 'listening');
        const base = `http://127.0.0.1:${server.address().port}`;
        process.env.USERPERSISTO_GOOGLE_CLIENT_ID = 'gis-http-client';
        process.env.USERPERSISTO_GOOGLE_REDIRECT_URI = `${base}/service/auth/google/callback`;
        const begin = async (browser = new CookieBrowser()) => {
            const request = await createLoginRequest({ redirectUri: `${base}/auth/callback` });
            const response = await browser.json(`${base}/service/auth/google/start`, { requestId: request.providerState, state: 'outer-router-state' });
            assert.equal(response.status, 200, await response.clone().text());
            const start = await response.json();
            const page = await browser.fetch(start.authorizationUrl);
            assert.equal(page.status, 200, await page.clone().text());
            const html = await page.text();
            const config = JSON.parse(html.match(/<script id="google-sign-in-config" type="application\/json">([^<]+)<\/script>/)[1]);
            return { browser, request, start, page, config, html };
        };
        const sign = async (flow, claims = {}, key = keys.privateKey) => {
            const now = Math.floor(Date.now() / 1000);
            return new SignJWT({ iss: 'https://accounts.google.com', sub: 'gis-http-subject', aud: 'gis-http-client',
                nonce: flow.config.nonce, iat: now, exp: now + 300, email: 'gis-http@gmail.com', email_verified: true, ...claims })
                .setProtectedHeader({ alg: 'RS256', kid: 'gis-http' }).sign(key);
        };
        const submit = async (flow, credential, browser = flow.browser, origin = base) => browser.json(new URL(flow.config.credentialUrl, base), {
            transaction: flow.start.transaction, credential,
        }, origin);
        await run({ base, defaults, begin, sign, submit, verifications: () => verifications,
            holdVerification() {
                let release;
                gate = new Promise(resolve => { release = resolve; });
                const started = new Promise(resolve => { verifyStarted = resolve; });
                return { release, started };
            } });
    } finally {
        if (server?.listening) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
        await resetStoreForTests();
        for (const key of Object.keys(process.env)) if (!Object.hasOwn(previous, key)) delete process.env[key];
        Object.assign(process.env, previous);
        await rm(folder, { recursive: true, force: true });
    }
}

test('fresh local Google configuration needs only installation-generated key, no shared secret', () => fixture(async ({ defaults, begin, base }) => {
    assert.equal(defaults.configured, true);
    assert.equal(defaults.available, true);
    assert.equal(defaults.clientId, GOOGLE_LOCAL_CLIENT_ID);
    assert.equal(defaults.configurationSource, 'local-default');
    assert.deepEqual(defaults.missing, []);
    const flow = await begin();
    assert.equal(new URL(flow.start.authorizationUrl).origin, base);
    assert.equal(flow.page.headers.get('cache-control'), 'no-store');
    assert.equal(flow.page.headers.get('x-frame-options'), 'DENY');
    assert.equal(flow.page.headers.get('cross-origin-opener-policy'), 'same-origin-allow-popups');
    assert.match(flow.page.headers.get('content-security-policy'), /script-src 'self' https:\/\/accounts.google.com\/gsi\/client/);
    assert.equal(flow.config.clientId, 'gis-http-client');
    assert.match(flow.config.nonce, /^[A-Za-z0-9_-]{43}$/);
    assert.doesNotMatch(flow.html, /client_secret|clientSecret|access_token|id_token/);
    const asset = await flow.browser.fetch(`${base}/service/auth/google-sign-in.mjs`);
    assert.equal(asset.status, 200);
    assert.match(asset.headers.get('content-type'), /javascript/);
    assert.match(await asset.text(), /accounts\.google\.com\/gsi\/client/);
}));

test('GIS verification preserves the ordinary first-administrator and one-use Router handoff', () => fixture(async ({ begin, sign, submit, base }) => {
    const flow = await begin();
    const credential = await sign(flow);
    const response = await submit(flow, credential);
    assert.equal(response.status, 200, await response.clone().text());
    const verified = await response.json();
    assert.match(verified.redirectUrl, /^\/service\/auth\/google\/resume\/[a-f0-9]{64}$/);
    assert.equal(await getUserByEmail('gis-http@gmail.com'), null, 'token verification alone creates no account');
    assert.equal((await submit(flow, credential)).status, 400, 'credential replay cannot reverify');
    const store = await getStore();
    assert.equal(JSON.stringify((await store.select('googleAuthTransaction')).objects).includes(credential), false);
    const resumed = await flow.browser.fetch(new URL(verified.redirectUrl, base));
    assert.equal(resumed.status, 303, await resumed.clone().text());
    const callback = new URL(resumed.headers.get('location'), base);
    assert.equal(callback.searchParams.get('state'), 'outer-router-state');
    const user = await getUserByEmail('gis-http@gmail.com');
    assert.deepEqual(await getUserRoles(user.id), ['admin']);
    assert.equal((await getInstallationSetup()).complete, true);
    const code = callback.searchParams.get('code');
    const handoff = { providerState: flow.request.providerState, code };
    await consumeAuthCode(handoff);
    await assert.rejects(consumeAuthCode(handoff));
    assert.equal((await flow.browser.fetch(new URL(verified.redirectUrl, base))).status, 400);
}));

test('GIS requires the matching browser, exact Origin and JSON body before verifying a credential', () => fixture(async ({ begin, sign, submit, base, verifications }) => {
    const flow = await begin();
    const credential = await sign(flow);
    assert.equal((await new CookieBrowser().fetch(flow.start.authorizationUrl)).status, 400);
    assert.equal((await submit(flow, credential, new CookieBrowser())).status, 400);
    assert.equal((await submit(flow, credential, flow.browser, 'https://attacker.example')).status, 403);
    const endpoint = new URL(flow.config.credentialUrl, base);
    assert.equal((await flow.browser.post(endpoint, { transaction: flow.start.transaction, credential })).status, 403);
    const array = await flow.browser.json(endpoint, []);
    assert.equal(array.status, 400);
    assert.equal((await flow.browser.json(endpoint, { transaction: flow.start.transaction, credential, clientId: 'attacker' })).status, 400);
    assert.equal((await flow.browser.json(endpoint, { transaction: flow.start.transaction, credential: 'x'.repeat(16385) })).status, 400);
    assert.equal(verifications(), 0);
    assert.equal((await submit(flow, credential)).status, 200, 'rejected foreign requests cannot consume the valid attempt');
}));

test('wrong nonce and forged signature terminally fail GIS attempts without identity side effects', () => fixture(async ({ begin, sign, submit }) => {
    for (const variant of ['nonce', 'signature']) {
        const flow = await begin();
        const key = variant === 'signature' ? (await generateKeyPair('RS256')).privateKey : undefined;
        const credential = await sign(flow, variant === 'nonce' ? { nonce: 'other-attempt' } : {}, key);
        const response = await submit(flow, credential);
        assert.equal(response.status, 400);
        assert.deepEqual(await response.json(), { ok: false, error: 'google_authentication_failed' });
        assert.equal((await submit(flow, await sign(flow))).status, 400);
        assert.equal(await getUserByEmail('gis-http@gmail.com'), null);
    }
}));

test('cancelling while GIS verification is pending prevents late success and replay', () => fixture(async ({ begin, sign, submit, base, holdVerification }) => {
    const flow = await begin();
    const credential = await sign(flow);
    const held = holdVerification();
    const pending = submit(flow, credential);
    try {
        await held.started;
        const cancelled = await flow.browser.json(new URL(flow.config.cancelUrl, base), { transaction: flow.start.transaction });
        assert.equal(cancelled.status, 200);
        assert.match((await cancelled.json()).redirectUrl, /notice=google-cancelled/);
    } finally { held.release(); }
    const late = await pending;
    assert.equal(late.status, 400);
    assert.equal((await submit(flow, credential)).status, 400);
    assert.equal(await getUserByEmail('gis-http@gmail.com'), null);
}));

test('simultaneous GIS submissions consume one attempt exactly once', () => fixture(async ({ begin, sign, submit, verifications }) => {
    const flow = await begin();
    const credential = await sign(flow);
    const responses = await Promise.all([submit(flow, credential), submit(flow, credential)]);
    assert.deepEqual(responses.map(response => response.status).sort(), [200, 400]);
    assert.equal(verifications(), 1);
    assert.equal(await getUserByEmail('gis-http@gmail.com'), null);
}));
