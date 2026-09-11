import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { createRouterSigner } from './helpers/router-fixture.mjs';
import * as setup from './helpers/setup.mjs';
import { ensureSeedData } from '../lib/bootstrap.mjs';
import { getUserByEmail, getUserById } from '../lib/users.mjs';
import { resetStoreForTests } from '../lib/store.mjs';
import { generateToken } from '../lib/auth/totp.mjs';
import { syncAdministratorPasswordState } from '../lib/auth/adminPassword.mjs';
import PersistoOidcAdapter, { writeOidcDocument } from '../lib/oidc/adapter.mjs';
import { getOrCreateOidcKeys } from '../lib/oidc/secrets.mjs';
import { startService } from '../service/index.mjs';

let folder, server, base, sign;
const ORIGIN = 'https://account.example.test';
const PROFILE = '/service/dashboard/api/profile';
const mail = [];

before(async () => {
    folder = await mkdtemp(join(tmpdir(), 'userpersisto-lifecycle-'));
    process.env.PERSISTENCE_FOLDER = folder;
    process.env.USERPERSISTO_SETTINGS_KEY = 'test-lifecycle-settings';
    process.env.USERPERSISTO_RUNTIME_SECRET = 'test-lifecycle-runtime-secret';
    process.env.USERPERSISTO_ALLOWED_REDIRECT_ORIGINS = ORIGIN;
    sign = await createRouterSigner();
    await ensureSeedData();
    server = startService({ port: 0, host: '127.0.0.1' }, { deliverEmail: async (message) => {
        mail.push(message);
        return { delivered: true, providerMessageId: 'fixture' };
    } });
    if (!server.listening) await once(server, 'listening');
    base = `http://127.0.0.1:${server.address().port}`;
});

beforeEach(() => setup.resetAuthLimitsForTests());

after(async () => {
    setup.clearAdministratorPassword();
    if (server?.listening) await new Promise((resolve) => server.close(resolve));
    await resetStoreForTests();
    delete process.env.USERPERSISTO_RUNTIME_SECRET;
    delete process.env.USERPERSISTO_ALLOWED_REDIRECT_ORIGINS;
    if (folder) await rm(folder, { recursive: true, force: true });
});

async function request(path, { method = 'POST', body = {}, userId }) {
    const raw = method === 'POST' ? JSON.stringify(body) : '';
    const response = await fetch(`${base}${path}`, {
        method,
        headers: sign({ method, path, rawBody: raw, userId, origin: ORIGIN }),
        ...(method === 'POST' ? { body: raw } : {}),
    });
    return { status: response.status, data: await response.json() };
}

const profileOf = async (userId) => (await request(PROFILE, { method: 'GET', userId })).data.profile;

async function emailGrant(userId, operation) {
    setup.resetAuthLimitsForTests();
    const started = await request('/service/dashboard/api/reauth/start', { userId, body: { operation, method: 'emailCode' } });
    assert.equal(started.status, 200, JSON.stringify(started.data));
    assert.equal(started.data.challenge.delivery, 'accepted');
    assert.equal(JSON.stringify(started.data).includes(mail.at(-1).code), false, 'the code is only delivered by email');
    const verified = await request('/service/dashboard/api/reauth/verify', { userId, body: { operation, method: 'emailCode', code: mail.at(-1).code } });
    assert.equal(verified.status, 200, JSON.stringify(verified.data));
    return verified.data.grant;
}

async function runtime(path, body) {
    const response = await fetch(`${base}/service/runtime/${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-userpersisto-runtime-secret': process.env.USERPERSISTO_RUNTIME_SECRET },
        body: JSON.stringify(body),
    });
    return { status: response.status, data: await response.json() };
}

test('the email-less administrator proves a contact address before it can sign in by email or enroll', async () => {
    const password = setup.configureAdministratorPassword();
    const claimed = await setup.claimAdministrator(password, { contactEmail: 'ops@example.test' });
    const admin = claimed.user;
    assert.equal(claimed.initialAdministrator, true);
    assert.equal(admin.email, '');
    // The unverified contact address is no sign-in or discovery authority.
    assert.equal(await getUserByEmail('ops@example.test'), null);
    let profile = await profileOf(admin.id);
    assert.deepEqual(profile.contact, { email: 'ops@example.test', verified: false, pending: false });
    assert.equal(profile.emailVerified, false);
    assert.deepEqual(profile.reauthenticationMethods, ['adminPassword']);
    await assert.rejects(setup.signInWithEmailCode('ops@example.test', { purpose: 'login' }), { code: 'account_not_found' });

    // Passkey and authenticator sign-in are reached through a sign-in email.
    for (const operation of ['totp.enroll', 'passkey.register']) {
        const refused = await request('/service/dashboard/api/reauth/start', { userId: admin.id, body: { operation, method: 'adminPassword' } });
        assert.deepEqual([refused.status, refused.data.error], [409, 'verified_email_required'], operation);
    }
    const noGrant = await request('/service/dashboard/api/contact/start', { userId: admin.id, body: { email: 'ops@example.test' } });
    assert.deepEqual([noGrant.status, noGrant.data.error], [403, 'operation_grant_required']);
    const wrong = await request('/service/dashboard/api/reauth/verify', { userId: admin.id,
        body: { operation: 'contact.verify', method: 'adminPassword', password: 'not-the-configured-value' } });
    assert.equal(wrong.status, 401);
    const granted = await request('/service/dashboard/api/reauth/verify', { userId: admin.id,
        body: { operation: 'contact.verify', method: 'adminPassword', password } });
    assert.equal(granted.status, 200, JSON.stringify(granted.data));
    const { grant } = granted.data;

    // Predictable refusals do not spend the grant; an address in use is refused.
    const member = await setup.registerWithEmailCode('member@example.test');
    assert.deepEqual(member.roles, ['selfRegistered']);
    const taken = await request('/service/dashboard/api/contact/start', { userId: admin.id, body: { email: 'member@example.test', grant } });
    assert.deepEqual([taken.status, taken.data.error], [409, 'email_taken']);
    const started = await request('/service/dashboard/api/contact/start', { userId: admin.id, body: { email: ' Ops@Example.test ', grant } });
    assert.equal(started.status, 200, JSON.stringify(started.data));
    assert.equal(started.data.challenge.delivery, 'accepted');
    assert.equal(mail.at(-1).to, 'ops@example.test');
    assert.equal((await profileOf(admin.id)).contact.pending, true);
    const reused = await request('/service/dashboard/api/contact/start', { userId: admin.id, body: { email: 'ops@example.test', grant } });
    assert.equal(reused.status, 403, 'the grant is single use');
    const early = await request('/service/dashboard/api/contact/start', { userId: admin.id, body: { email: 'ops@example.test', resend: true } });
    assert.deepEqual([early.status, early.data.error], [429, 'resend_too_soon']);
    const bad = await request('/service/dashboard/api/contact/verify', { userId: admin.id, body: { code: '000000' } });
    assert.deepEqual([bad.status, bad.data.error, bad.data.attemptsRemaining], [400, 'code_invalid', 4]);
    const verified = await request('/service/dashboard/api/contact/verify', { userId: admin.id, body: { code: mail.at(-1).code } });
    assert.deepEqual(verified.data, { ok: true, email: 'ops@example.test' });

    const updated = await getUserById(admin.id);
    assert.equal(updated.email, 'ops@example.test');
    assert.ok(updated.emailVerifiedAt);
    assert.equal(updated.authGeneration, 0, 'adding a mailbox replaces nothing');
    assert.equal((await getUserByEmail('ops@example.test')).id, admin.id);
    profile = await profileOf(admin.id);
    assert.equal(profile.emailVerified, true);
    assert.deepEqual(profile.reauthenticationMethods, ['emailCode', 'adminPassword']);
    assert.ok(profile.authMethods.some((method) => method.type === 'emailCode'));

    // The verified mailbox now signs in, and a second verification cannot replace it.
    const login = await setup.signInWithEmailCode('ops@example.test', { purpose: 'login' });
    assert.equal(login.user.id, admin.id);
    const noReplacement = await request('/service/dashboard/api/reauth/start', { userId: admin.id, body: { operation: 'contact.verify', method: 'emailCode' } });
    assert.deepEqual([noReplacement.status, noReplacement.data.error], [409, 'sign_in_email_exists'], 'no grant is offered for an impossible operation');
    const replace = await request('/service/dashboard/api/contact/start', { userId: admin.id, body: { email: 'other@example.test', grant: 'G'.repeat(43) } });
    assert.deepEqual([replace.status, replace.data.error], [409, 'sign_in_email_exists']);

    // Optional enrollment is now available after fresh re-authentication.
    const totpStart = await request('/service/dashboard/api/auth/totp/start', { userId: admin.id, body: { grant: await emailGrant(admin.id, 'totp.enroll') } });
    assert.equal(totpStart.status, 200, JSON.stringify(totpStart.data));
});

test('TOTP replacement keeps the old authenticator until proven, then revokes older sessions, OIDC state and grants', async () => {
    const registered = await setup.registerWithEmailCode('rotate@example.test');
    const userId = registered.user.id;
    const first = (await request('/service/dashboard/api/auth/totp/start', { userId, body: { grant: await emailGrant(userId, 'totp.enroll') } })).data;
    const enrolled = await request('/service/dashboard/api/auth/totp/verify', { userId, body: { token: generateToken(first.secret), setupId: first.setupId } });
    assert.deepEqual(enrolled.data, { ok: true, replaced: false });
    assert.equal((await runtime('sso-user', { userId, generation: 0 })).status, 200);

    // Stored OIDC state for the account, and a grant issued before the change.
    await getOrCreateOidcKeys();
    await writeOidcDocument('Client', 'lifecycle-client', { enabled: true, metadata: { client_id: 'lifecycle-client' } });
    await new PersistoOidcAdapter('Grant').upsert('lifecycle-grant', { jti: 'lifecycle-grant', clientId: 'lifecycle-client', accountId: userId }, 3600);
    await new PersistoOidcAdapter('Session').upsert('lifecycle-session', { uid: 'lifecycle-session-uid', accountId: userId, authorizations: { 'lifecycle-client': { grantId: 'lifecycle-grant' } } }, 3600);
    const staleGrant = await emailGrant(userId, 'passkey.register');

    // Re-authentication with the enrolled authenticator authorizes its replacement.
    const totpGrant = await request('/service/dashboard/api/reauth/verify', { userId,
        body: { operation: 'totp.enroll', method: 'totp', token: generateToken(first.secret) } });
    assert.equal(totpGrant.status, 200, JSON.stringify(totpGrant.data));
    const replacement = (await request('/service/dashboard/api/auth/totp/start', { userId, body: { grant: totpGrant.data.grant } })).data;
    assert.equal((await getUserById(userId)).authGeneration, 0, 'staging a replacement changes nothing yet');
    const replaced = await request('/service/dashboard/api/auth/totp/verify', { userId, body: { token: generateToken(replacement.secret), setupId: replacement.setupId } });
    assert.deepEqual(replaced.data, { ok: true, replaced: true });
    assert.equal((await getUserById(userId)).authGeneration, 1);

    const revoked = await runtime('sso-user', { userId, generation: 0 });
    assert.deepEqual([revoked.status, revoked.data.error], [401, 'session_revoked']);
    assert.equal((await runtime('sso-user', { userId, generation: 1 })).status, 200);
    assert.equal(await new PersistoOidcAdapter('Session').find('lifecycle-session'), undefined);
    assert.equal(await new PersistoOidcAdapter('Grant').find('lifecycle-grant'), undefined);
    const stale = await request('/service/dashboard/api/auth/passkey/options', { userId, body: { grant: staleGrant } });
    assert.deepEqual([stale.status, stale.data.error], [403, 'operation_grant_required']);
});

test('rotating the configured administrator password voids an administrator grant issued with the old value', async () => {
    const password = setup.configureAdministratorPassword();
    await syncAdministratorPasswordState();
    const admin = await getUserByEmail('ops@example.test');
    const granted = await request('/service/dashboard/api/reauth/verify', { userId: admin.id,
        body: { operation: 'totp.enroll', method: 'adminPassword', password } });
    assert.equal(granted.status, 200, JSON.stringify(granted.data));
    const generation = (await getUserById(admin.id)).authGeneration;
    setup.configureAdministratorPassword();
    await syncAdministratorPasswordState();
    assert.equal((await getUserById(admin.id)).authGeneration, generation + 1);
    const refused = await request('/service/dashboard/api/auth/totp/start', { userId: admin.id, body: { grant: granted.data.grant } });
    assert.deepEqual([refused.status, refused.data.error], [403, 'operation_grant_required']);
    const oldValue = await request('/service/dashboard/api/reauth/verify', { userId: admin.id,
        body: { operation: 'totp.enroll', method: 'adminPassword', password } });
    assert.equal(oldValue.status, 401);
});

test('a non-designated account never re-authenticates with the administrator password', async () => {
    const password = setup.configureAdministratorPassword();
    const member = await getUserByEmail('member@example.test');
    assert.deepEqual((await profileOf(member.id)).reauthenticationMethods, ['emailCode']);
    const refused = await request('/service/dashboard/api/reauth/verify', { userId: member.id,
        body: { operation: 'totp.enroll', method: 'adminPassword', password } });
    assert.deepEqual([refused.status, refused.data.error], [409, 'reauthentication_unavailable']);
});
