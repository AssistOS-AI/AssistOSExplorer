import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startService } from '../service/index.mjs';
import { createProvider } from '../runtime/index.mjs';
import { ensureSeedData } from '../lib/bootstrap.mjs';
import { getStore, resetStoreForTests } from '../lib/store.mjs';
import { updateAuthPolicy } from '../lib/policy.mjs';
import { getCanonicalLoginOrigin } from '../lib/auth/canonicalLoginOrigin.mjs';
import { controlledGoogleProvider, CookieBrowser } from './helpers/googleProvider.mjs';

async function fixture(fn) {
    const env = { ...process.env };
    const folder = await mkdtemp(join(tmpdir(), 'canonical-login-'));
    const google = await controlledGoogleProvider();
    let server;
    try {
        process.env.PERSISTENCE_FOLDER = folder;
        process.env.USERPERSISTO_SETTINGS_KEY = 'canonical-login-test-settings';
        process.env.USERPERSISTO_RUNTIME_SECRET = 'canonical-login-test-runtime';
        process.env.USERPERSISTO_GOOGLE_CLIENT_ID = 'controlled-google-client';
        delete process.env.USERPERSISTO_AUTH_METHODS;
        delete process.env.USERPERSISTO_ALLOWED_REDIRECT_ORIGINS;
        await ensureSeedData();
        await updateAuthPolicy({ enabledAuthMethods: ['emailCode', 'google'] });
        server = startService({ port: 0, host: '127.0.0.1' }, { google: { protocol: google.protocol } });
        if (!server.listening) await once(server, 'listening');
        const base = `http://127.0.0.1:${server.address().port}`;
        const alias = `http://localhost:${server.address().port}`;
        process.env.USERPERSISTO_GOOGLE_REDIRECT_URI = `${base}/service/auth/google/callback`;
        const provider = createProvider({ getConfig: async () => ({
            routerBaseUrl: base, runtimePath: '/service/runtime', loginPath: '/service/auth/',
            runtimeSecret: process.env.USERPERSISTO_RUNTIME_SECRET,
        }) });
        const requests = async () => (await (await getStore()).select('ssoLoginRequest')).objects;
        await fn({ base, alias, provider, requests, google });
    } finally {
        if (server?.listening) {
            server.closeAllConnections();
            await new Promise(resolve => server.close(resolve));
        }
        await google.close();
        await resetStoreForTests();
        for (const key of Object.keys(process.env)) if (!Object.hasOwn(env, key)) delete process.env[key];
        Object.assign(process.env, env);
        await rm(folder, { recursive: true, force: true });
    }
}

test('loopback restart creates no provider state and the fresh canonical login starts Google', () => fixture(async ({ base, alias, provider, requests }) => {
    const restart = await provider.sso_begin_login({ redirectUri: `${alias}/auth/callback`, supportsCanonicalLoginOrigin: true });
    assert.deepEqual(restart, { canonicalLoginOrigin: base });
    assert.equal((await requests()).length, 0);
    const login = await provider.sso_begin_login({ redirectUri: `${base}/auth/callback`, supportsCanonicalLoginOrigin: true });
    assert.equal(new URL(login.authorizationUrl).origin, base);
    assert.equal((await requests()).length, 1);
    assert.equal((await requests())[0].redirectUri, `${base}/auth/callback`);
    const browser = new CookieBrowser();
    const response = await browser.json(`${base}/service/auth/google/start`, { requestId: login.providerState, state: 'fresh-router-state' });
    assert.equal(response.status, 200, await response.clone().text());
    const result = await response.json();
    const authorization = new URL(result.authorizationUrl);
    assert.equal(authorization.origin, base);
    assert.equal(authorization.pathname, '/service/auth/google/sign-in');
    assert.equal(authorization.searchParams.get('transaction'), result.transaction);
    assert.equal((await browser.fetch(authorization)).status, 200);
    assert.ok(response.headers.get('set-cookie')?.includes('up_google_'));
    // The convenience redirect does not relax the Google Origin/CSRF boundary.
    const wrongOrigin = await fetch(`${base}/service/auth/google/start`, { method: 'POST',
        headers: { 'content-type': 'application/json', origin: alias },
        body: JSON.stringify({ requestId: login.providerState, state: 'fresh-router-state' }) });
    assert.equal(wrongOrigin.status, 403);
    assert.equal(wrongOrigin.headers.get('set-cookie'), null);
}));

test('old routers retain same-origin login behavior without negotiating the extension', () => fixture(async ({ alias, provider, requests }) => {
    for (const supported of [undefined, false, 'true']) {
        const login = await provider.sso_begin_login({ redirectUri: `${alias}/auth/callback`, supportsCanonicalLoginOrigin: supported });
        assert.equal(new URL(login.authorizationUrl).origin, alias);
        assert.ok(login.providerState);
        assert.equal(Object.hasOwn(login, 'canonicalLoginOrigin'), false);
    }
    assert.equal((await requests()).length, 3);
}));

test('origin negotiation remains private and cannot set cookies or create requests anonymously', () => fixture(async ({ base, alias, requests }) => {
    const response = await fetch(`${base}/service/runtime/sso-login-request`, { method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ redirectUri: `${alias}/auth/callback`, supportsCanonicalLoginOrigin: true }) });
    assert.equal(response.status, 401);
    assert.equal((await response.json()).ok, false);
    assert.equal(response.headers.get('set-cookie'), null);
    assert.equal((await requests()).length, 0);
}));

test('canonical selection requires ready Google configuration and exact loopback scheme/port', () => fixture(async ({ base, alias }) => {
    const callback = `${alias}/auth/callback`;
    assert.equal(await getCanonicalLoginOrigin(callback), base);
    assert.equal(await getCanonicalLoginOrigin(`${base}/auth/callback`), null);
    const port = new URL(base).port;
    assert.equal(await getCanonicalLoginOrigin(`http://[::1]:${port}/auth/callback`), base);
    for (const uri of [`https://localhost:${port}/auth/callback`, 'http://localhost:1/auth/callback',
        `${alias}/other`, `${callback}?next=/`, `${callback}#fragment`]) {
        assert.equal(await getCanonicalLoginOrigin(uri), null, uri);
    }
    for (const uri of ['https://untrusted.example/auth/callback', 'http://localhost.attacker.example/auth/callback',
        `${alias.replace('://', '://user:password@')}/auth/callback`, 'javascript:alert(1)']) {
        await assert.rejects(getCanonicalLoginOrigin(uri), undefined, uri);
    }
    await updateAuthPolicy({ allowedRedirectOrigins: ['https://workspace.example.test'] });
    assert.equal(await getCanonicalLoginOrigin('https://workspace.example.test/auth/callback'), null);
    process.env.USERPERSISTO_GOOGLE_REDIRECT_URI = 'https://workspace.example.test/service/auth/google/callback';
    assert.equal(await getCanonicalLoginOrigin(callback), null, 'never redirect a local browser to a public deployment');
    process.env.USERPERSISTO_GOOGLE_REDIRECT_URI = `${base}/service/auth/google/callback`;
    delete process.env.USERPERSISTO_GOOGLE_CLIENT_ID;
    assert.equal(await getCanonicalLoginOrigin(callback), null, 'incomplete Google must not change other login methods');
    process.env.USERPERSISTO_GOOGLE_CLIENT_ID = 'controlled-google-client';
    await updateAuthPolicy({ enabledAuthMethods: ['emailCode'] });
    assert.equal(await getCanonicalLoginOrigin(callback), null, 'disabled Google must not canonicalize');
}));
