import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { ensureSeedData } from '../lib/bootstrap.mjs';
import { getUserByEmail, getUserRoles } from '../lib/users.mjs';
import { getInstallationSetup } from '../lib/setup.mjs';
import { consumeAuthCode, createLoginRequest } from '../lib/sso.mjs';
import { getStore, resetStoreForTests } from '../lib/store.mjs';
import { updateAuthPolicy } from '../lib/policy.mjs';
import { startService } from '../service/index.mjs';
import { CookieBrowser } from './helpers/googleProvider.mjs';
import * as setup from './helpers/setup.mjs';

async function fixture(fn) {
    const environment = { ...process.env };
    const folder = await mkdtemp(join(tmpdir(), 'userpersisto-signup-direct-http-'));
    process.env.PERSISTENCE_FOLDER = folder;
    process.env.USERPERSISTO_SETTINGS_KEY = 'signup-direct-http-settings-key';
    for (const name of ['USERPERSISTO_AUTH_METHODS', 'USERPERSISTO_SELF_REGISTRATION_ENABLED', 'USERPERSISTO_DEV_BOOTSTRAP',
        'USERPERSISTO_SIGNUP_EMAIL_VERIFICATION_REQUIRED']) delete process.env[name];
    setup.resetAuthLimitsForTests();
    let server;
    try {
        await ensureSeedData();
        // No deliverEmail seam and no emailStatus override: the service probes the
        // real EmailAgent readiness and must find it unavailable in tests.
        server = startService({ port: 0, host: '127.0.0.1' });
        if (!server.listening) await once(server, 'listening');
        const base = `http://127.0.0.1:${server.address().port}`;
        const flow = async () => {
            const request = await createLoginRequest({ redirectUri: `${base}/auth/callback` });
            const browser = new CookieBrowser();
            const post = async (path, body = {}, headers = {}) => {
                const response = await browser.fetch(`${base}/service/auth/${path}`, {
                    method: 'POST', headers: { 'content-type': 'application/json', origin: base, ...headers },
                    body: JSON.stringify({ requestId: request.providerState, state: 'direct-http', ...body }),
                });
                const text = await response.text();
                return { status: response.status, body: JSON.parse(text), text, headers: response.headers };
            };
            return { request, browser, post };
        };
        await fn({ base, flow });
    } finally {
        if (server?.listening) { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); }
        await resetStoreForTests();
        await rm(folder, { recursive: true, force: true });
        for (const name of Object.keys(process.env)) if (!Object.hasOwn(environment, name)) delete process.env[name];
        Object.assign(process.env, environment);
    }
}

test('the direct signup route creates the account, signs the browser in and replays a lost response for that browser only', () => fixture(async ({ base, flow }) => {
    const first = await flow();
    const email = 'direct-http-owner@example.test';
    const password = setup.newTestPassword();
    const configuration = await first.post('attempt');
    assert.deepEqual([configuration.status, configuration.body.signup.email, configuration.body.signup.verification, configuration.body.passwordReset],
        [200, true, 'none', false]);
    const created = await first.post('signup/create', { email, password, passwordConfirmation: password });
    assert.deepEqual([created.status, created.body.state, created.body.redirectUri, created.body.created, created.body.initialAdministrator],
        [200, 'direct-http', `${base}/auth/callback`, true, true]);
    assert.equal(created.text.includes(password), false);
    const user = await getUserByEmail(email);
    assert.ok(user);
    assert.equal(user.emailVerifiedAt, '');
    assert.deepEqual(await getUserRoles(user.id), ['admin']);
    assert.deepEqual([(await getInstallationSetup()).method, (await getInstallationSetup()).initialAdministratorId], ['passwordSignup', user.id]);
    assert.equal((await (await getStore()).select('emailLog')).totalCount, 0, 'direct signup sends no mail');

    // The handoff consumed the login request; the same browser replays its own
    // completion while the code is still live, and a foreign browser cannot.
    const replay = await first.post('signup/create', { email, password, passwordConfirmation: password });
    assert.deepEqual([replay.status, replay.body.replayed, replay.body.code], [200, true, created.body.code]);
    const strangerBrowser = new CookieBrowser();
    const stranger = await strangerBrowser.json(`${base}/service/auth/signup/create`, {
        requestId: first.request.providerState, state: 'direct-http', email, password, passwordConfirmation: password,
    }, base);
    assert.equal(stranger.status, 400);
    assert.equal((await getUserByEmail(email)).id, user.id, 'the foreign browser creates nothing');
    assert.equal((await consumeAuthCode({ providerState: first.request.providerState, code: created.body.code })).user.id, user.id);

    const second = await flow();
    const memberEmail = 'direct-http-member@example.test';
    const memberPassword = setup.newTestPassword();
    const member = await second.post('signup/create', { email: memberEmail, password: memberPassword, passwordConfirmation: memberPassword });
    assert.deepEqual([member.status, member.body.created, member.body.initialAdministrator], [200, true, false]);
    const memberUser = await getUserByEmail(memberEmail);
    assert.deepEqual(await getUserRoles(memberUser.id), ['selfRegistered']);
    assert.equal((await (await getStore()).select('emailLog')).totalCount, 0);
}));

test('the direct signup route refuses policy, duplicate, cross-origin and malformed requests with typed errors', () => fixture(async ({ flow }) => {
    // A verified administrator keeps its emailCode fallback, so the policy can
    // cycle through disabling password without stranding anyone.
    const owner = await setup.signUpWithPassword('verified-http-owner@example.test');
    const firstPassword = setup.newTestPassword();
    const duplicate = await flow();
    const repeated = await duplicate.post('signup/create', { email: owner.user.email, password: firstPassword, passwordConfirmation: firstPassword });
    assert.deepEqual([repeated.status, repeated.body.error], [409, 'account_exists']);

    await updateAuthPolicy({ signupEmailVerificationRequired: true }, { emailStatus: async () => ({ available: true }) });
    const required = await flow();
    const refused = await required.post('signup/create', { email: 'direct-http-required@example.test', password: firstPassword, passwordConfirmation: firstPassword });
    assert.deepEqual([refused.status, refused.body.error], [409, 'signup_verification_required']);
    await updateAuthPolicy({ signupEmailVerificationRequired: false }, { emailStatus: async () => ({ available: true }) });

    await updateAuthPolicy({ enabledAuthMethods: ['emailCode'] }, { emailStatus: async () => ({ available: true }) });
    const disabled = await flow();
    const method = await disabled.post('signup/create', { email: 'direct-http-disabled@example.test', password: firstPassword, passwordConfirmation: firstPassword });
    assert.deepEqual([method.status, method.body.error], [404, 'auth_method_disabled']);
    await updateAuthPolicy({ enabledAuthMethods: ['password', 'emailCode', 'passkey', 'totp', 'google'] }, { emailStatus: async () => ({ available: true }) });

    const spoofed = await flow();
    const crossOrigin = await spoofed.post('signup/create', { email: 'direct-http-missing@example.test', password: firstPassword, passwordConfirmation: firstPassword },
        { origin: 'https://evil.example' });
    assert.deepEqual([crossOrigin.status, crossOrigin.body.error], [403, 'invalid_origin']);
    const unknown = await spoofed.post('signup/create', { requestId: 'not-a-request', email: 'direct-http-missing@example.test',
        password: firstPassword, passwordConfirmation: firstPassword });
    assert.deepEqual([unknown.status, unknown.body.error], [400, 'login_request_invalid']);
    assert.equal(await getUserByEmail('direct-http-missing@example.test'), null);
}));

test('the direct signup route spends the discovery budget and answers 429 with Retry-After once it is spent', () => fixture(async ({ flow }) => {
    const owner = await setup.signUpWithPassword('budget-http-owner@example.test');
    const password = setup.newTestPassword();
    const probe = await flow();
    const outcomes = {};
    let limited;
    for (let index = 0; index < 25; index += 1) {
        const response = await probe.post('signup/create', { email: owner.user.email, password, passwordConfirmation: password });
        const key = `${response.status}:${response.body.error || ''}`;
        outcomes[key] = (outcomes[key] || 0) + 1;
        if (response.status === 429) limited = response;
    }
    assert.deepEqual(outcomes, { '409:account_exists': 20, '429:rate_limited': 5 });
    assert.ok(Number(limited.headers.get('retry-after')) > 0);
    assert.equal(limited.body.retryAfter, Number(limited.headers.get('retry-after')));

    const fresh = await flow();
    const again = await fresh.post('signup/create', { email: owner.user.email, password, passwordConfirmation: password });
    assert.deepEqual([again.status, again.body.error], [409, 'account_exists']);
    const newcomer = await fresh.post('signup/create', { email: 'budget-http-newcomer@example.test', password, passwordConfirmation: password });
    assert.equal(newcomer.status, 200);
}));
