import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { controlledGoogleProvider, CookieBrowser } from './helpers/googleProvider.mjs';
import { createRouterSigner } from './helpers/router-fixture.mjs';
import { ensureSeedData } from '../lib/bootstrap.mjs';
import { createUser, getUserByEmail } from '../lib/users.mjs';
import { getStore, resetStoreForTests } from '../lib/store.mjs';
import { updateAuthPolicy } from '../lib/policy.mjs';
import { createLoginRequest } from '../lib/sso.mjs';
import { consumeOperationGrant } from '../lib/auth/operationGrants.mjs';
import { startService } from '../service/index.mjs';

async function fixture(run) {
    const env = { ...process.env };
    const folder = await mkdtemp(join(tmpdir(), 'google-reauth-'));
    const provider = await controlledGoogleProvider();
    let server;
    try {
        process.env.PERSISTENCE_FOLDER = folder;
        process.env.USERPERSISTO_SETTINGS_KEY = 'controlled-reauth-settings';
        process.env.USERPERSISTO_GOOGLE_CLIENT_ID = 'controlled-google-client';
        process.env.USERPERSISTO_GOOGLE_CLIENT_SECRET = 'controlled-google-secret';
        delete process.env.USERPERSISTO_AUTH_METHODS;
        delete process.env.USERPERSISTO_ADMIN_PASSWORD;
        const sign = await createRouterSigner();
        await ensureSeedData();
        server = startService({ port: 0, host: '127.0.0.1' }, { google: { protocol: provider.protocol } });
        if (!server.listening) await once(server, 'listening');
        const base = `http://127.0.0.1:${server.address().port}`;
        process.env.USERPERSISTO_GOOGLE_REDIRECT_URI = `${base}/service/auth/google/callback`;
        process.env.USERPERSISTO_ALLOWED_REDIRECT_ORIGINS = base;
        await updateAuthPolicy({ enabledAuthMethods: ['google', 'passkey', 'totp'] });
        const browser = new CookieBrowser();
        const parent = await createLoginRequest({ redirectUri: `${base}/auth/callback` });
        const start = await (await browser.json(`${base}/service/auth/google/start`, { requestId: parent.providerState, state: 'router-reauth-fixture' })).json();
        const callback = await browser.fetch(await provider.approve(start.authorizationUrl));
        assert.equal(callback.status, 303);
        assert.equal((await browser.fetch(new URL(callback.headers.get('location'), base))).status, 303);
        const user = await getUserByEmail(provider.state.email);
        assert.ok(user);
        const request = async (path, body = {}, { actor = user.id, client = browser, headers = {}, unsigned = false } = {}) => {
            const route = `/service/dashboard/api/${path}`;
            const raw = JSON.stringify(body);
            const response = await client.fetch(`${base}${route}`, { method: 'POST', body: raw,
                headers: { ...(unsigned ? { origin: base, 'content-type': 'application/json',
                    'x-forwarded-proto': 'http', 'x-forwarded-host': new URL(base).host }
                    : sign({ method: 'POST', path: route, rawBody: raw, userId: actor, origin: base })), ...headers } });
            return { status: response.status, data: await response.json() };
        };
        const begin = async (operation = 'totp.enroll') => {
            const result = await request('reauth/start', { operation, method: 'google' });
            assert.equal(result.status, 200, JSON.stringify(result.data));
            return { ...result.data, operation };
        };
        const approve = async (flow) => {
            provider.state.claims = { auth_time: Math.floor(Date.now() / 1000) };
            const response = await browser.fetch(await provider.approve(flow.authorizationUrl));
            assert.equal(response.status, 303, await response.clone().text());
            assert.equal(response.headers.get('location'), '/service/auth/google/confirmation');
        };
        await run({ provider, browser, base, user, request, begin, approve });
    } finally {
        if (server?.listening) { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); }
        await resetStoreForTests();
        await provider.close();
        await rm(folder, { recursive: true, force: true });
        for (const key of Object.keys(process.env)) if (!Object.hasOwn(env, key)) delete process.env[key];
        Object.assign(process.env, env);
    }
}

test('Google-only accounts confirm enrollment with their linked identity without email delivery or a login handoff', async () => {
    await fixture(async ({ begin, approve, request, user }) => {
        const store = await getStore();
        const before = (await store.select('ssoAuthCode')).objects.length;
        const flow = await begin();
        const args = { transaction: flow.transaction, operation: flow.operation };
        assert.deepEqual((await request('reauth/google/complete', args)).data, { ok: true, pending: true });
        await approve(flow);
        const result = await request('reauth/google/complete', args);
        assert.equal(result.status, 200, JSON.stringify(result.data));
        assert.match(result.data.grant, /^[\w-]{43}$/);
        assert.equal(result.data.operation, 'totp.enroll');
        assert.equal((await store.select('ssoAuthCode')).objects.length, before, 'confirmation issues no login handoff');
        assert.equal((await store.select('externalIdentity')).objects.length, 1);
        assert.equal((await request('reauth/google/complete', args)).status, 400, 'completion is one-use');
        const started = await request('auth/totp/start', { grant: result.data.grant });
        assert.equal(started.status, 200, JSON.stringify(started.data));
        assert.match(started.data.secret, /^[A-Z2-7]+$/);
        await assert.rejects(consumeOperationGrant({ userId: user.id, operation: 'totp.enroll', grant: result.data.grant }), { code: 'operation_grant_required' });
    });
});

test('Google confirmation requires signed actor, browser proof, exact operation and existing bound subject', async () => {
    await fixture(async ({ begin, approve, request, provider }) => {
        assert.equal((await request('reauth/start', { method: 'google', operation: 'totp.enroll' }, { unsigned: true })).status, 401);
        assert.equal((await request('reauth/start', { method: 'google', operation: 'totp.enroll' }, { headers: { origin: 'https://wrong.example' } })).status, 403);
        assert.equal((await request('reauth/verify', { method: 'google', operation: 'totp.enroll' })).status, 409, 'the ordinary proof API cannot bypass Google');
        const flow = await begin();
        const args = { transaction: flow.transaction, operation: flow.operation };
        assert.equal((await request('reauth/google/complete', args, { client: new CookieBrowser() })).status, 400);
        assert.equal((await request('reauth/google/complete', { ...args, operation: 'passkey.register' })).status, 403);
        const other = await createUser({ email: 'different@example.test', roles: ['user'] });
        assert.equal((await request('reauth/google/complete', args, { actor: other.id })).status, 403);
        provider.state.subject = 'different-google-subject';
        await approve(flow);
        const rejected = await request('reauth/google/complete', args);
        assert.equal(rejected.status, 401);
        assert.equal(rejected.data.error, 'google_account_mismatch');
        assert.equal((await (await getStore()).select('externalIdentity')).objects.length, 1, 'no collision linking in confirmation');
    });
});

test('Google confirmation cancellation, stale generation and missing provider freshness cannot grant enrollment', async () => {
    await fixture(async ({ begin, approve, request, browser, provider, user }) => {
        const cancelled = await begin();
        assert.equal((await request('reauth/cancel', { ...cancelled, method: 'google' })).status, 200);
        assert.equal((await browser.fetch(await provider.approve(cancelled.authorizationUrl))).status, 400);
        const stale = await begin();
        await approve(stale);
        await (await getStore()).updateUser(user.id, { authGeneration: user.authGeneration + 1 });
        assert.equal((await request('reauth/google/complete', stale)).status, 409);
        const missing = await begin();
        provider.state.claims = {};
        const response = await browser.fetch(await provider.approve(missing.authorizationUrl));
        assert.equal(response.headers.get('location'), '/service/auth/google/confirmation?notice=recent-authentication-required');
        assert.equal((await request('reauth/google/complete', missing)).status, 400);
        assert.equal((await (await getStore()).select('authChallenge', { purpose: 'operation-grant' })).objects.length, 0);
    });
});
