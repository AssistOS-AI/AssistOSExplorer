import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { createRouterSigner } from './helpers/router-fixture.mjs';
import * as setup from './helpers/setup.mjs';
import { ensureSeedData } from '../lib/bootstrap.mjs';
import { createUser, getUserByEmail, getUserById } from '../lib/users.mjs';
import { resetStoreForTests } from '../lib/store.mjs';
import { generateToken, setupStart, setupVerify } from '../lib/auth/totp.mjs';
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

test('an account with an unverified mailbox uses its enrolled authenticator before confirming that mailbox', async () => {
    await setup.registerWithEmailCode('owner@example.test');
    const account = await createUser({ email: 'ops@example.test', emailVerified: false, source: 'fixture' });
    // This internal fixture represents an existing credential with an unverified
    // mailbox. Public enrollment still requires a verified sign-in address.
    const enrollment = await setupStart({ userId: account.id });
    const token = generateToken(enrollment.secret);
    assert.equal((await setupVerify({ userId: account.id, token, setupId: enrollment.setupId })).ok, true);
    let profile = await profileOf(account.id);
    assert.equal(profile.emailVerified, false);
    assert.deepEqual(profile.reauthenticationMethods, ['totp']);
    for (const operation of ['totp.enroll', 'passkey.register']) {
        const refused = await request('/service/dashboard/api/reauth/start', { userId: account.id, body: { operation, method: 'totp' } });
        assert.deepEqual([refused.status, refused.data.error], [409, 'verified_email_required'], operation);
    }
    const noGrant = await request('/service/dashboard/api/contact/start', { userId: account.id, body: { email: account.email } });
    assert.deepEqual([noGrant.status, noGrant.data.error], [403, 'operation_grant_required']);
    const granted = await request('/service/dashboard/api/reauth/verify', { userId: account.id,
        body: { operation: 'contact.verify', method: 'totp', token } });
    assert.equal(granted.status, 200, JSON.stringify(granted.data));
    const { grant } = granted.data;
    const member = await setup.registerWithEmailCode('member@example.test');
    assert.deepEqual(member.roles, ['selfRegistered']);
    const replacement = await request('/service/dashboard/api/contact/start', { userId: account.id, body: { email: member.user.email, grant } });
    assert.deepEqual([replacement.status, replacement.data.error], [400, 'email_change_unsupported']);
    const started = await request('/service/dashboard/api/contact/start', { userId: account.id, body: { email: ' Ops@Example.test ', grant } });
    assert.equal(started.status, 200, JSON.stringify(started.data));
    assert.equal(started.data.challenge.delivery, 'accepted');
    assert.equal(mail.at(-1).to, account.email);
    assert.equal((await profileOf(account.id)).contact.pending, true);
    const reused = await request('/service/dashboard/api/contact/start', { userId: account.id, body: { email: account.email, grant } });
    assert.equal(reused.status, 403, 'the grant is single use');
    const early = await request('/service/dashboard/api/contact/start', { userId: account.id, body: { email: account.email, resend: true } });
    assert.deepEqual([early.status, early.data.error], [429, 'resend_too_soon']);
    const wrongCode = mail.at(-1).code === '000000' ? '000001' : '000000';
    const bad = await request('/service/dashboard/api/contact/verify', { userId: account.id, body: { code: wrongCode } });
    assert.deepEqual([bad.status, bad.data.error, bad.data.attemptsRemaining], [400, 'code_invalid', 4]);
    const verified = await request('/service/dashboard/api/contact/verify', { userId: account.id, body: { code: mail.at(-1).code } });
    assert.deepEqual(verified.data, { ok: true, email: account.email });
    const updated = await getUserById(account.id);
    assert.ok(updated.emailVerifiedAt);
    assert.equal(updated.authGeneration, 0, 'adding a mailbox replaces nothing');
    assert.equal((await getUserByEmail(account.email)).id, account.id);
    profile = await profileOf(account.id);
    assert.equal(profile.emailVerified, true);
    assert.deepEqual(profile.reauthenticationMethods, ['emailCode', 'totp']);
    const login = await setup.signInWithEmailCode(account.email, { purpose: 'login' });
    assert.equal(login.user.id, account.id);
    const noReplacement = await request('/service/dashboard/api/reauth/start', { userId: account.id, body: { operation: 'contact.verify', method: 'emailCode' } });
    assert.deepEqual([noReplacement.status, noReplacement.data.error], [409, 'sign_in_email_exists']);
    const replace = await request('/service/dashboard/api/contact/start', { userId: account.id, body: { email: 'other@example.test', grant: 'G'.repeat(43) } });
    assert.deepEqual([replace.status, replace.data.error], [409, 'sign_in_email_exists']);
    const totpStart = await request('/service/dashboard/api/auth/totp/start', { userId: account.id, body: { grant: await emailGrant(account.id, 'totp.enroll') } });
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

test('retired password reauthentication is refused for administrators and ordinary accounts', async () => {
    for (const email of ['owner@example.test', 'member@example.test']) {
        const user = await getUserByEmail(email);
        assert.equal((await profileOf(user.id)).reauthenticationMethods.includes('adminPassword'), false);
        for (const method of ['adminPassword', 'password']) {
            for (const action of ['start', 'verify']) {
                const refused = await request('/service/dashboard/api/reauth/' + action, { userId: user.id,
                    body: { operation: 'totp.enroll', method, password: 'retired-secret' } });
                assert.deepEqual([refused.status, refused.data.error], [409, 'reauthentication_unavailable']);
                assert.equal(refused.data.grant, undefined);
            }
        }
    }
});

test('an account may prove the unverified address it already carries, and any other address is an unsupported change', async () => {
    // No public path creates this shape today; the internal helper does, and the
    // refusal order is what decides whether such an account can ever recover.
    const legacy = await createUser({ email: 'legacy@example.test', displayName: 'Legacy', emailVerified: false, source: 'fixture' });
    assert.equal((await getUserById(legacy.id)).emailVerifiedAt, '');
    assert.equal((await profileOf(legacy.id)).emailVerified, false);

    // Its own address is not a collision, so the request reaches the grant check.
    const own = await request('/service/dashboard/api/contact/start', { userId: legacy.id, body: { email: 'legacy@example.test' } });
    assert.deepEqual([own.status, own.data.error], [403, 'operation_grant_required']);
    // Any other address is a replacement, which this version does not support,
    // and that refusal discloses nothing about whether the address is in use.
    for (const email of ['member@example.test', 'elsewhere@example.test']) {
        const other = await request('/service/dashboard/api/contact/start', { userId: legacy.id, body: { email } });
        assert.deepEqual([other.status, other.data.error], [400, 'email_change_unsupported'], email);
    }
});
