import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { ensureSeedData } from '../lib/bootstrap.mjs';
import { getUserById } from '../lib/users.mjs';
import { createLoginRequest } from '../lib/sso.mjs';
import { commitStagedPersistence, getStore, resetStoreForTests } from '../lib/store.mjs';
import { withPersistenceScope } from '../lib/persistence-scope.mjs';
import { loginWithUserPassword } from '../lib/auth/userPassword.mjs';
import { startService } from '../service/index.mjs';
import { CookieBrowser } from './helpers/googleProvider.mjs';
import * as setup from './helpers/setup.mjs';

const TOKEN = /#token=([A-Za-z0-9_-]{43})$/;

async function fixture(fn, { emailAvailable = true } = {}) {
    const environment = { ...process.env };
    const folder = await mkdtemp(join(tmpdir(), 'userpersisto-password-reset-http-'));
    process.env.PERSISTENCE_FOLDER = folder;
    process.env.USERPERSISTO_SETTINGS_KEY = 'password-reset-http-settings-key';
    for (const name of ['USERPERSISTO_AUTH_METHODS', 'USERPERSISTO_SELF_REGISTRATION_ENABLED', 'USERPERSISTO_DEV_BOOTSTRAP',
        'USERPERSISTO_SIGNUP_EMAIL_VERIFICATION_REQUIRED']) delete process.env[name];
    setup.resetAuthLimitsForTests();
    const mail = [];
    let server;
    try {
        await ensureSeedData();
        server = startService({ port: 0, host: '127.0.0.1' }, {
            emailStatus: async () => ({ available: emailAvailable }),
            deliverEmail: async (message) => { mail.push(message); return { delivered: true, providerMessageId: 'code-fixture' }; },
            deliverPasswordReset: async (message) => { mail.push(message); return { delivered: true, providerMessageId: 'reset-fixture' }; },
        });
        if (!server.listening) await once(server, 'listening');
        const base = `http://127.0.0.1:${server.address().port}`;
        const flow = async ({ redirectUri = `${base}/auth/callback` } = {}) => {
            const request = await createLoginRequest({ redirectUri });
            const browser = new CookieBrowser();
            const post = async (path, body = {}, origin = base) => {
                const response = await browser.fetch(`${base}/service/auth/${path}`, {
                    method: 'POST', headers: { 'content-type': 'application/json', origin },
                    body: JSON.stringify({ requestId: request.providerState, ...body }),
                });
                const text = await response.text();
                return { status: response.status, body: JSON.parse(text), text, headers: response.headers };
            };
            return { request, browser, post };
        };
        const parentless = async (path, body, origin = base) => {
            const response = await fetch(`${base}/service/auth/${path}`, {
                method: 'POST', headers: { 'content-type': 'application/json', origin }, body: JSON.stringify(body),
            });
            const text = await response.text();
            return { status: response.status, body: JSON.parse(text), text, headers: response.headers };
        };
        await fn({ base, flow, parentless, mail, server });
    } finally {
        if (server?.listening) { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); }
        await resetStoreForTests();
        await rm(folder, { recursive: true, force: true });
        for (const name of Object.keys(process.env)) if (!Object.hasOwn(environment, name)) delete process.env[name];
        Object.assign(process.env, environment);
    }
}

function resetTokenOf(message) {
    const match = TOKEN.exec(String(message?.resetUrl || ''));
    assert.ok(match, `a fragment token is present in ${message?.resetUrl}`);
    return match[1];
}

test('the SSO forgot route emails a fragment link on the validated origin and answers uniformly', () => fixture(async ({ base, flow, mail }) => {
    await setup.signUpWithPassword('forgot-owner@example.test');
    const owner = await flow();
    const refused = await owner.post('password/forgot', { email: 'forgot-owner@example.test' }, 'https://evil.example');
    assert.deepEqual([refused.status, refused.body.error], [403, 'invalid_origin']);
    const sent = await owner.post('password/forgot', { email: 'forgot-owner@example.test' });
    assert.deepEqual([sent.status, sent.body], [200, { ok: true }]);
    assert.equal(mail.length, 1);
    assert.equal(mail[0].to, 'forgot-owner@example.test');
    assert.equal(mail[0].expiresInMinutes, 30);
    assert.match(mail[0].resetUrl, new RegExp(`^${base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/service/auth/reset\\.html#token=`));
    resetTokenOf(mail[0]);
    const unknown = await owner.post('password/forgot', { email: 'unknown-forgot@example.test' });
    assert.deepEqual([unknown.status, unknown.body, mail.length], [200, { ok: true }, 1]);

    // The emailed origin must equal the origin this request is served from.
    const foreign = await flow({ redirectUri: 'http://127.0.0.1:1/auth/callback' });
    const mismatch = await foreign.post('password/forgot', { email: 'forgot-owner@example.test' });
    assert.deepEqual([mismatch.status, mismatch.body.error, mail.length], [403, 'invalid_origin', 1]);
}));

test('the SSO forgot route refuses when delivery is unavailable', () => fixture(async ({ flow, mail }) => {
    await setup.signUpWithPassword('no-mail-owner@example.test');
    const { post } = await flow();
    const refused = await post('password/forgot', { email: 'no-mail-owner@example.test' });
    assert.deepEqual([refused.status, refused.body.error, mail.length], [409, 'password_reset_unavailable', 0]);
}, { emailAvailable: false }));

test('the parentless status and reset routes complete the flow without a parent, cookie or session', () => fixture(async ({ flow, parentless, mail }) => {
    const account = await setup.signUpDirect('parentless-owner@example.test');
    const { post } = await flow();
    assert.equal((await post('password/forgot', { email: 'parentless-owner@example.test' })).status, 200);
    const token = resetTokenOf(mail.at(-1));

    const inspected = await parentless('password/reset/status', { token });
    assert.equal(inspected.status, 200);
    assert.equal(inspected.body.email, 'parentless-owner@example.test');
    assert.ok(inspected.body.expiresAt > Date.now());
    assert.deepEqual(inspected.body.passwordPolicy, { minLength: 1, maxLength: 128, maxRawLength: 1024, normalization: 'NFKC' });
    assert.equal(inspected.headers.get('set-cookie'), null, 'inspection issues no cookie');

    const mismatch = await parentless('password/reset', { token, password: setup.newTestPassword(), passwordConfirmation: 'something else entirely' });
    assert.deepEqual([mismatch.status, mismatch.body.error], [400, 'password_mismatch']);
    const replacement = setup.newTestPassword();
    const completed = await parentless('password/reset', { token, password: replacement, passwordConfirmation: replacement });
    assert.deepEqual([completed.status, completed.body], [200, { ok: true }]);
    assert.equal(completed.headers.get('set-cookie'), null, 'completion issues no cookie');
    assert.equal(JSON.stringify(completed.body).includes(replacement), false);
    const updated = await getUserById(account.user.id);
    assert.ok(updated.emailVerifiedAt, 'the emailed link verified the mailbox');
    assert.equal(updated.authGeneration, 1);
    await assert.rejects(loginWithUserPassword({ email: account.user.email, password: account.password }), { code: 'authentication_failed' });
    assert.equal((await loginWithUserPassword({ email: account.user.email, password: replacement })).user.id, account.user.id);

    const reused = await parentless('password/reset', { token, password: setup.newTestPassword(), passwordConfirmation: replacement });
    assert.deepEqual([reused.status, reused.body.error], [400, 'reset_link_invalid']);

    const forged = await parentless('password/reset/status', { token }, 'https://evil.example');
    assert.deepEqual([forged.status, forged.body.error], [403, 'invalid_origin']);
    const forgedReset = await parentless('password/reset', { token, password: replacement, passwordConfirmation: replacement }, 'https://evil.example');
    assert.deepEqual([forgedReset.status, forgedReset.body.error], [403, 'invalid_origin']);
}));

test('the reset page is served as a static page with no-referrer and no-store', () => fixture(async ({ base }) => {
    const response = await fetch(`${base}/service/auth/reset.html`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), /text\/html/);
    assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
    assert.equal(response.headers.get('cache-control'), 'no-store');
    const html = await response.text();
    assert.match(html, /<main id="auth_content"/);
    assert.match(html, /reset-main\.js/);
    const missing = await fetch(`${base}/service/auth/not-a-real-page.js`);
    assert.equal(missing.status, 404);
}));

test('six concurrent resets with one expired link all answer 400 and the service keeps working', () => fixture(async ({ base, flow, parentless, mail, server }) => {
    const account = await setup.signUpDirect('expired-http@example.test');
    const { post } = await flow();
    assert.equal((await post('password/forgot', { email: 'expired-http@example.test' })).status, 200);
    const token = resetTokenOf(mail.at(-1));
    const store = await getStore();
    const [record] = (await store.select('authChallenge', { purpose: 'password-reset' })).objects;
    await commitStagedPersistence(() => store.updateAuthChallenge(record.id, { expiresAt: new Date(Date.now() - 1000).toISOString() }));

    // Hold every store access until all six requests are queued, so each one
    // observes the expired record before any of them cleans it up.
    const release = Promise.withResolvers();
    const held = withPersistenceScope(() => release.promise);
    let arrived = 0;
    const allArrived = Promise.withResolvers();
    const count = () => { arrived += 1; if (arrived === 6) allArrived.resolve(); };
    server.on('request', count);
    const replacement = setup.newTestPassword();
    const pending = Promise.all(Array.from({ length: 6 }, () =>
        parentless('password/reset', { token, password: replacement, passwordConfirmation: replacement })));
    await allArrived.promise;
    server.off('request', count);
    await new Promise((resolve) => setTimeout(resolve, 100));
    release.resolve();
    await held;
    const responses = await pending;
    assert.deepEqual(responses.map((response) => [response.status, response.body.error]), Array(6).fill([400, 'reset_link_invalid']));

    const status = await fetch(`${base}/service/auth/setup`);
    assert.equal(status.status, 200);
    assert.equal((await loginWithUserPassword({ email: account.user.email, password: account.password })).user.id, account.user.id);
}));
