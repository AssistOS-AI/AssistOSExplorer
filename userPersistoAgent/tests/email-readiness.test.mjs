import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { ensureSeedData } from '../lib/bootstrap.mjs';
import { getAuthPolicy, updateAuthPolicy, usableSignInMethods } from '../lib/policy.mjs';
import { wizardConfiguration } from '../lib/auth/wizardConfig.mjs';
import { getUserById } from '../lib/users.mjs';
import { createLoginRequest } from '../lib/sso.mjs';
import { resetStoreForTests } from '../lib/store.mjs';
import { withPersistenceScope } from '../lib/persistence-scope.mjs';
import { startService } from '../service/index.mjs';
import { CookieBrowser } from './helpers/googleProvider.mjs';
import { createRouterSigner } from './helpers/router-fixture.mjs';
import * as setup from './helpers/setup.mjs';

async function fixture(run) {
    const environment = { ...process.env };
    const folder = await mkdtemp(join(tmpdir(), 'userpersisto-email-readiness-'));
    process.env.PERSISTENCE_FOLDER = folder;
    process.env.USERPERSISTO_SETTINGS_KEY = 'readiness-fixture-key';
    for (const name of ['USERPERSISTO_ADMIN_PASSWORD', 'USERPERSISTO_AUTH_METHODS', 'USERPERSISTO_SELF_REGISTRATION_ENABLED',
        'USERPERSISTO_GOOGLE_CLIENT_ID', 'USERPERSISTO_GOOGLE_CLIENT_SECRET', 'USERPERSISTO_GOOGLE_REDIRECT_URI']) delete process.env[name];
    setup.resetAuthLimitsForTests();
    const servers = [];
    try {
        await ensureSeedData();
        const start = async (options) => {
            const server = startService({ port: 0, host: '127.0.0.1' }, options);
            servers.push(server);
            if (!server.listening) await once(server, 'listening');
            return `http://127.0.0.1:${server.address().port}`;
        };
        await run({ start });
    } finally {
        for (const server of servers) {
            server.closeAllConnections();
            await new Promise((resolve) => server.close(resolve));
        }
        await resetStoreForTests();
        await rm(folder, { recursive: true, force: true });
        for (const name of Object.keys(process.env)) if (!Object.hasOwn(environment, name)) delete process.env[name];
        Object.assign(process.env, environment);
    }
}

test('policy cannot strand an email-only administrator when EmailAgent is unavailable; its probe runs outside persistence', { timeout: 10_000 }, () => fixture(async () => {
    const account = await setup.registerWithEmailCode('owner@example.test');
    const user = await getUserById(account.user.id);
    assert.deepEqual(await usableSignInMethods(user, { emailAvailable: false }), []);
    assert.deepEqual(await usableSignInMethods(user, { emailAvailable: true }), ['emailCode']);
    const original = await getAuthPolicy();
    await assert.rejects(updateAuthPolicy({ selfRegistrationEnabled: false }, { emailStatus: async () => ({ available: false }) }),
        { code: 'administrator_auth_method_required' });
    assert.deepEqual(await getAuthPolicy(), original, 'a rejected guard cannot partially save the policy');
    let probes = 0;
    await updateAuthPolicy({ selfRegistrationEnabled: false }, { emailStatus: async () => {
        probes += 1;
        return withPersistenceScope(async () => ({ available: true }));
    } });
    assert.equal(probes, 1, 'one readiness probe per save, not one per administrator');
    assert.equal((await getAuthPolicy()).selfRegistrationEnabled, false);
}));

test('public SSO and signed-in account surfaces hide unavailable email and reject sending without consuming a grant', () => fixture(async ({ start }) => {
    const { user } = await setup.registerWithEmailCode('member@example.test');
    const sign = await createRouterSigner();
    let available = false;
    let sends = 0;
    const base = await start({ emailStatus: async () => ({ available }), deliverEmail: async () => { sends += 1; return { delivered: true, providerMessageId: 'fixture' }; } });
    const request = await createLoginRequest({ redirectUri: `${base}/auth/callback` });
    const browser = new CookieBrowser();
    const post = (path, body = {}) => browser.json(`${base}/service/auth/${path}`, { requestId: request.providerState, ...body });
    const config = await (await post('attempt')).json();
    assert.equal(config.methods.emailCode, false);
    assert.equal(config.registration, false);
    const discovered = await (await post('discover', { email: user.email })).json();
    assert.deepEqual(discovered, { ok: true, exists: true, methods: { emailCode: false, passkey: false, totp: false } });
    assert.equal((await post('email-code/start', { email: user.email, purpose: 'login' })).status, 404);
    assert.equal((await (await fetch(`${base}/service/auth/methods`)).json()).methods.includes('emailCode'), false);
    const profilePath = '/service/dashboard/api/profile';
    const profile = await (await fetch(`${base}${profilePath}`, { headers: sign({ method: 'GET', path: profilePath, userId: user.id }) })).json();
    assert.equal(profile.profile.reauthenticationMethods.includes('emailCode'), false);
    assert.equal(profile.profile.authMethods.some((method) => method.type === 'emailCode'), false);
    assert.equal(profile.profile.allowedAuthMethods.includes('emailCode'), false);
    const startPath = '/service/dashboard/api/reauth/start';
    const body = JSON.stringify({ method: 'emailCode', operation: 'totp.enroll' });
    const denied = await fetch(`${base}${startPath}`, { method: 'POST', body, headers: sign({ method: 'POST', path: startPath, rawBody: body, userId: user.id }) });
    assert.equal(denied.status, 409);
    assert.equal(sends, 0, 'readiness and denials never send a probe email');

    available = true;
    assert.equal((await (await post('attempt')).json()).methods.emailCode, true);
    assert.equal((await post('email-code/start', { email: user.email, purpose: 'login' })).status, 200);
    assert.equal(sends, 1, 'a real requested code is sent when the provider is configured');
}));

test('default production status fails closed without an EmailAgent client, while explicit delivery fixtures remain usable', () => fixture(async ({ start }) => {
    const production = await start();
    const unavailable = await (await fetch(`${production}/service/auth/setup`)).json();
    assert.equal(unavailable.methods.emailCode, false);
    assert.equal(unavailable.registration, false);
    assert.equal((await wizardConfiguration()).methods.emailCode, false, 'a caller without a readiness result cannot advertise email');
    const controlled = await start({ deliverEmail: async () => ({ delivered: true, providerMessageId: 'fixture' }) });
    const configured = await (await fetch(`${controlled}/service/auth/setup`)).json();
    assert.equal(configured.methods.emailCode, true);
    assert.equal(configured.registration, true);
}));
