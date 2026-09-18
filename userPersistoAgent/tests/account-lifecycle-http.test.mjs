import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { createRouterSigner } from './helpers/router-fixture.mjs';
import * as setup from './helpers/setup.mjs';
import { ensureSeedData } from '../lib/bootstrap.mjs';
import { createUser, getUserByEmail, getUserById, updateUser } from '../lib/users.mjs';
import { commitStagedPersistence, getStore, resetStoreForTests } from '../lib/store.mjs';
import { serializePersisted } from '../lib/serial.mjs';
import { generateToken, setupStart, setupVerify } from '../lib/auth/totp.mjs';
import { setKdfObserverForTests } from '../lib/auth/password.mjs';
import { resetEmailAttemptLimitsForTests } from '../lib/auth/emailAttempts.mjs';
import { loginWithUserPassword } from '../lib/auth/userPassword.mjs';
import { stageCredentialGenerationAdvance } from '../lib/auth/generation.mjs';
import { completeGoogleIdentity, GOOGLE_ISSUER } from '../lib/externalIdentities.mjs';
import PersistoOidcAdapter, { writeOidcDocument } from '../lib/oidc/adapter.mjs';
import { getOrCreateOidcKeys } from '../lib/oidc/secrets.mjs';
import { startService } from '../service/index.mjs';

let folder, server, base, sign;
const ORIGIN = 'https://account.example.test';
const PROFILE = '/service/dashboard/api/profile';
const SET_PASSWORD = '/service/dashboard/api/auth/password/set';
const mail = [];
// Passwords chosen at signup, kept only in this test process.
const passwords = new Map();

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
    // Only the per-address send budget; KDF test seams stay in place.
    resetEmailAttemptLimitsForTests();
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
    const owner = await setup.signUpWithPassword('owner@example.test');
    passwords.set(owner.user.email, owner.password);
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
    const member = await setup.signUpWithPassword('member@example.test');
    passwords.set(member.user.email, member.password);
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
    const login = await setup.signInWithEmailCode(account.email);
    assert.equal(login.user.id, account.id);
    const noReplacement = await request('/service/dashboard/api/reauth/start', { userId: account.id, body: { operation: 'contact.verify', method: 'emailCode' } });
    assert.deepEqual([noReplacement.status, noReplacement.data.error], [409, 'sign_in_email_exists']);
    const replace = await request('/service/dashboard/api/contact/start', { userId: account.id, body: { email: 'other@example.test', grant: 'G'.repeat(43) } });
    assert.deepEqual([replace.status, replace.data.error], [409, 'sign_in_email_exists']);
    const totpStart = await request('/service/dashboard/api/auth/totp/start', { userId: account.id, body: { grant: await emailGrant(account.id, 'totp.enroll') } });
    assert.equal(totpStart.status, 200, JSON.stringify(totpStart.data));
});

test('TOTP replacement keeps the old authenticator until proven, then revokes older sessions, OIDC state and grants', async () => {
    const registered = await setup.signUpWithPassword('rotate@example.test');
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

test('password re-authentication proves each account with its own password and no shared administrator password exists', async () => {
    for (const email of ['owner@example.test', 'member@example.test']) {
        const user = await getUserByEmail(email);
        const methods = (await profileOf(user.id)).reauthenticationMethods;
        assert.equal(methods[0], 'password');
        assert.equal(methods.includes('adminPassword'), false);
        for (const action of ['start', 'verify']) {
            const retired = await request(`/service/dashboard/api/reauth/${action}`, { userId: user.id,
                body: { operation: 'totp.enroll', method: 'adminPassword', password: 'admin' } });
            assert.deepEqual([retired.status, retired.data.error, retired.data.grant], [409, 'reauthentication_unavailable', undefined]);
        }
        for (const guess of ['admin', passwords.get(email === 'owner@example.test' ? 'member@example.test' : 'owner@example.test')]) {
            const refused = await request('/service/dashboard/api/reauth/verify', { userId: user.id, body: { operation: 'totp.enroll', method: 'password', password: guess } });
            assert.deepEqual([refused.status, refused.data.error, refused.data.grant], [401, 'authentication_failed', undefined]);
        }
        const confirmed = await request('/service/dashboard/api/reauth/verify', { userId: user.id,
            body: { operation: 'totp.enroll', method: 'password', password: passwords.get(email) } });
        assert.equal(confirmed.status, 200, JSON.stringify(confirmed.data));
        assert.match(confirmed.data.grant, /^[A-Za-z0-9_-]{43}$/);
    }
    // An account without a password cannot use the method at all.
    const ops = await getUserByEmail('ops@example.test');
    const unavailable = await request('/service/dashboard/api/reauth/verify', { userId: ops.id, body: { operation: 'totp.enroll', method: 'password', password: 'anything at all here' } });
    assert.deepEqual([unavailable.status, unavailable.data.error], [409, 'reauthentication_unavailable']);
});

let googleSubjects = 0;
// A Google-created account has a verified mailbox and no password.
async function googleAccount(email) {
    googleSubjects += 1;
    const { user } = await completeGoogleIdentity({ identity: { issuer: GOOGLE_ISSUER, subject: `lifecycle-google-${googleSubjects}`, email, emailVerified: true } });
    return user;
}

const setPassword = (userId, body) => request(SET_PASSWORD, { userId, body });

function countKdf() {
    const counter = { hashes: 0 };
    setKdfObserverForTests(({ purpose }) => { if (purpose === 'hash') counter.hashes += 1; });
    return counter;
}

test('My Account sets a first password without revoking sessions, then changes it with fresh proof and revokes them', async () => {
    const user = await googleAccount('first-password@gmail.com');
    let profile = await profileOf(user.id);
    assert.deepEqual([profile.enrollments.password, profile.reauthenticationMethods.includes('password')], [{ configured: false }, false]);
    const grant = await emailGrant(user.id, 'password.set');
    const kdf = countKdf();
    const chosen = setup.newTestPassword();
    // Predictable input failures leave the grant unspent and run no KDF.
    for (const [body, error, reason] of [
        [{ grant, password: chosen, passwordConfirmation: `${chosen}!` }, 'password_mismatch', undefined],
        [{ grant, password: '', passwordConfirmation: '' }, 'invalid_password', 'too_short'],
        [{ grant, password: 'x'.repeat(1025), passwordConfirmation: 'x'.repeat(1025) }, 'invalid_password', 'too_long'],
        [{ grant, password: 'x'.repeat(129), passwordConfirmation: 'x'.repeat(129) }, 'invalid_password', 'too_long'],
    ]) {
        const refused = await setPassword(user.id, body);
        assert.deepEqual([refused.status, refused.data.error, refused.data.reason], [400, error, reason]);
    }
    assert.equal(kdf.hashes, 0);
    const first = await setPassword(user.id, { grant, password: chosen, passwordConfirmation: chosen });
    assert.deepEqual([first.status, first.data], [200, { ok: true, changed: false }]);
    assert.equal(kdf.hashes, 1);
    assert.equal((await getUserById(user.id)).authGeneration, 0, 'a first password replaces nothing');
    assert.equal((await runtime('sso-user', { userId: user.id, generation: 0 })).status, 200);
    const reused = await setPassword(user.id, { grant, password: chosen, passwordConfirmation: chosen });
    assert.deepEqual([reused.status, reused.data.error], [403, 'operation_grant_required']);
    assert.equal((await loginWithUserPassword({ email: user.email, password: chosen })).user.id, user.id);
    profile = await profileOf(user.id);
    assert.deepEqual(profile.enrollments.password, { configured: true });
    assert.deepEqual(profile.authMethods.find((method) => method.type === 'password'), { type: 'password', name: 'Password' });
    assert.equal(profile.reauthenticationMethods[0], 'password');
    assert.doesNotMatch(JSON.stringify(profile), /hashEncrypted|scrypt|setAt|"version"/);

    // A change requires fresh proof, advances the generation and revokes stored state.
    await getOrCreateOidcKeys();
    await writeOidcDocument('Client', 'password-client', { enabled: true, metadata: { client_id: 'password-client' } });
    await new PersistoOidcAdapter('Grant').upsert('password-grant', { jti: 'password-grant', clientId: 'password-client', accountId: user.id }, 3600);
    await new PersistoOidcAdapter('Session').upsert('password-session', { uid: 'password-session-uid', accountId: user.id, authorizations: { 'password-client': { grantId: 'password-grant' } } }, 3600);
    const staleGrant = await emailGrant(user.id, 'totp.enroll');
    const proof = await request('/service/dashboard/api/reauth/verify', { userId: user.id, body: { operation: 'password.set', method: 'password', password: chosen } });
    assert.equal(proof.status, 200, JSON.stringify(proof.data));
    const replacement = setup.newTestPassword();
    const changed = await setPassword(user.id, { grant: proof.data.grant, password: replacement, passwordConfirmation: replacement });
    assert.deepEqual([changed.status, changed.data], [200, { ok: true, changed: true }]);
    assert.equal((await getUserById(user.id)).authGeneration, 1);
    assert.deepEqual([(await runtime('sso-user', { userId: user.id, generation: 0 })).data.error], ['session_revoked']);
    assert.equal(await new PersistoOidcAdapter('Session').find('password-session'), undefined);
    assert.equal(await new PersistoOidcAdapter('Grant').find('password-grant'), undefined);
    const stale = await request('/service/dashboard/api/auth/totp/start', { userId: user.id, body: { grant: staleGrant } });
    assert.deepEqual([stale.status, stale.data.error], [403, 'operation_grant_required']);
    await assert.rejects(loginWithUserPassword({ email: user.email, password: chosen }), { code: 'authentication_failed' });
    assert.equal((await loginWithUserPassword({ email: user.email, password: replacement })).user.id, user.id);
    const audit = (await (await getStore()).select('auditEvent', { actorId: user.id }, { start: 0, pageSize: 200 })).objects.map((event) => event.action);
    assert.deepEqual([audit.filter((action) => action === 'auth.password.set').length, audit.filter((action) => action === 'auth.password.change').length], [1, 1]);
    assert.equal(JSON.stringify(await (await getStore()).select('auditEvent', {}, { start: 0, pageSize: 500 })).includes(replacement), false);
});

test('a missing, foreign or invalid grant runs no KDF and never writes a password', async () => {
    const owner = await getUserByEmail('member@example.test');
    const user = await googleAccount('grant-rules@gmail.com');
    const kdf = countKdf();
    const chosen = setup.newTestPassword();
    for (const grant of [undefined, '', 'A'.repeat(43), 'not-a-grant']) {
        const refused = await setPassword(user.id, { grant, password: chosen, passwordConfirmation: chosen });
        assert.deepEqual([refused.status, refused.data.error], [403, 'operation_grant_required']);
    }
    // Another account's valid grant is refused without being touched.
    const foreignGrant = await emailGrant(owner.id, 'password.set');
    const foreign = await setPassword(user.id, { grant: foreignGrant, password: chosen, passwordConfirmation: chosen });
    assert.deepEqual([foreign.status, foreign.data.error], [403, 'operation_grant_required']);
    const ownUse = await setPassword(owner.id, { grant: foreignGrant, password: passwords.get('member@example.test'), passwordConfirmation: passwords.get('member@example.test') });
    assert.deepEqual([ownUse.status, ownUse.data], [200, { ok: true, changed: true }], 'the foreign grant stayed usable by its owner');
    // A grant for another operation is invalid for this one and is deleted on use.
    const otherOperation = await emailGrant(user.id, 'totp.enroll');
    const mismatched = await setPassword(user.id, { grant: otherOperation, password: chosen, passwordConfirmation: chosen });
    assert.deepEqual([mismatched.status, mismatched.data.error], [403, 'operation_grant_required']);
    const spent = await request('/service/dashboard/api/auth/totp/start', { userId: user.id, body: { grant: otherOperation } });
    assert.deepEqual([spent.status, spent.data.error], [403, 'operation_grant_required']);
    assert.equal(kdf.hashes, 1, 'only the owner’s authorized change hashed');
    // Without a verified mailbox, password.set is refused before any grant lookup.
    const unverified = await createUser({ email: 'unverified-password@example.test', emailVerified: false, source: 'fixture' });
    const started = await request('/service/dashboard/api/reauth/start', { userId: unverified.id, body: { operation: 'password.set', method: 'emailCode' } });
    assert.deepEqual([started.status, started.data.error], [409, 'verified_email_required']);
    const direct = await setPassword(unverified.id, { grant: 'A'.repeat(43), password: chosen, passwordConfirmation: chosen });
    assert.deepEqual([direct.status, direct.data.error], [409, 'verified_email_required']);
    // A policy without passwords refuses before spending a valid grant.
    const kept = await emailGrant(user.id, 'password.set');
    process.env.USERPERSISTO_AUTH_METHODS = 'emailCode,passkey,totp,google';
    try {
        const disabled = await setPassword(user.id, { grant: kept, password: chosen, passwordConfirmation: chosen });
        assert.deepEqual([disabled.status, disabled.data.error], [404, 'auth_method_disabled']);
    } finally {
        delete process.env.USERPERSISTO_AUTH_METHODS;
    }
    const usedLater = await setPassword(user.id, { grant: kept, password: chosen, passwordConfirmation: chosen });
    assert.deepEqual([usedLater.status, usedLater.data], [200, { ok: true, changed: false }]);
    assert.equal(kdf.hashes, 2);
});

test('an unverified account that already owns a password changes it, revokes sessions and still cannot enroll other methods', async () => {
    const direct = await setup.signUpDirect('direct-lifecycle@example.test');
    const user = direct.user;
    assert.equal((await getUserById(user.id)).emailVerifiedAt, '');
    const proof = await request('/service/dashboard/api/reauth/verify', { userId: user.id,
        body: { operation: 'password.set', method: 'password', password: direct.password } });
    assert.equal(proof.status, 200, JSON.stringify(proof.data));
    const replacement = setup.newTestPassword();
    const changed = await setPassword(user.id, { grant: proof.data.grant, password: replacement, passwordConfirmation: replacement });
    assert.deepEqual([changed.status, changed.data], [200, { ok: true, changed: true }]);
    const updated = await getUserById(user.id);
    assert.deepEqual([updated.emailVerifiedAt, updated.authGeneration], ['', 1], 'changing the only credential keeps the mailbox unverified but revokes sessions');
    assert.equal((await profileOf(user.id)).emailVerified, false);
    await assert.rejects(loginWithUserPassword({ email: user.email, password: direct.password }), { code: 'authentication_failed' });
    assert.equal((await loginWithUserPassword({ email: user.email, password: replacement })).user.id, user.id);
    for (const operation of ['totp.enroll', 'passkey.register']) {
        const refused = await request('/service/dashboard/api/reauth/start', { userId: user.id,
            body: { operation, method: 'password', password: replacement } });
        assert.deepEqual([refused.status, refused.data.error], [409, 'verified_email_required'], operation);
    }
});

// Holds both requests' hashing until both have passed the read-only checks.
function holdTwoHashes() {
    let entered = 0;
    let release;
    const both = new Promise((resolve) => { release = resolve; });
    setKdfObserverForTests(async ({ purpose }) => {
        if (purpose !== 'hash') return;
        entered += 1;
        if (entered === 2) release();
        await both;
    });
    return () => entered;
}

test('R9: one grant authorizes at most one password mutation, for concurrent first sets and concurrent changes', async () => {
    const user = await googleAccount('concurrent-password@gmail.com');
    const firstGrant = await emailGrant(user.id, 'password.set');
    const passwordsTried = [setup.newTestPassword(), setup.newTestPassword()];
    let entered = holdTwoHashes();
    const firstSets = await Promise.all(passwordsTried.map((secret) => setPassword(user.id, { grant: firstGrant, password: secret, passwordConfirmation: secret })));
    assert.equal(entered(), 2, 'both requests hashed before either committed');
    assert.deepEqual(firstSets.map((result) => result.status).sort(), [200, 403]);
    assert.equal(firstSets.find((result) => result.status === 403).data.error, 'operation_grant_required');
    assert.equal((await getUserById(user.id)).authGeneration, 0, 'the generation did not fence the second first set');
    const winner = passwordsTried[firstSets.findIndex((result) => result.status === 200)];
    const loser = passwordsTried[firstSets.findIndex((result) => result.status === 403)];
    setKdfObserverForTests(null);
    assert.equal((await loginWithUserPassword({ email: user.email, password: winner })).user.id, user.id);
    await assert.rejects(loginWithUserPassword({ email: user.email, password: loser }), { code: 'authentication_failed' });
    const store = await getStore();
    const credentials = (await store.getAuthMethodsObjectsByUserId(user.id)).filter((method) => method.type === 'password');
    assert.equal(credentials.length, 1);

    const proof = await request('/service/dashboard/api/reauth/verify', { userId: user.id, body: { operation: 'password.set', method: 'password', password: winner } });
    assert.equal(proof.status, 200, JSON.stringify(proof.data));
    const changes = [setup.newTestPassword(), setup.newTestPassword()];
    entered = holdTwoHashes();
    const changed = await Promise.all(changes.map((secret) => setPassword(user.id, { grant: proof.data.grant, password: secret, passwordConfirmation: secret })));
    assert.equal(entered(), 2);
    assert.deepEqual(changed.map((result) => result.status).sort(), [200, 403]);
    assert.equal((await getUserById(user.id)).authGeneration, 1, 'exactly one change advanced the generation');
    setKdfObserverForTests(null);
    const changedTo = changes[changed.findIndex((result) => result.status === 200)];
    assert.equal((await loginWithUserPassword({ email: user.email, password: changedTo })).user.id, user.id);
    const again = await setPassword(user.id, { grant: proof.data.grant, password: changedTo, passwordConfirmation: changedTo });
    assert.deepEqual([again.status, again.data.error], [403, 'operation_grant_required'], 'a consumed grant authorizes nothing later');
    const audit = (await store.select('auditEvent', { actorId: user.id }, { start: 0, pageSize: 200 })).objects.map((event) => event.action);
    assert.deepEqual([audit.filter((action) => action === 'auth.password.set').length, audit.filter((action) => action === 'auth.password.change').length], [1, 1]);
});

test('the commit boundary revalidates status, generation and policy after hashing and deletes the grant', async () => {
    const changes = [
        ['status', async (user) => updateUser(user.id, { status: 'blocked' }), 403, 'user_not_active', async (user) => updateUser(user.id, { status: 'active' })],
        ['generation', async (user) => serializePersisted('users', () => commitStagedPersistence(() => stageCredentialGenerationAdvance(user.id))), 403, 'operation_grant_required', async () => {}],
        ['policy', async () => { process.env.USERPERSISTO_AUTH_METHODS = 'emailCode,google'; }, 404, 'auth_method_disabled', async () => { delete process.env.USERPERSISTO_AUTH_METHODS; }],
    ];
    for (const [label, change, status, error, undo] of changes) {
        const user = await googleAccount(`commit-${label}@gmail.com`);
        const grant = await emailGrant(user.id, 'password.set');
        let entered;
        const reached = new Promise((resolve) => { entered = resolve; });
        let release;
        const held = new Promise((resolve) => { release = resolve; });
        setKdfObserverForTests(async ({ purpose }) => { if (purpose === 'hash') { entered(); await held; } });
        const secret = setup.newTestPassword();
        const pending = setPassword(user.id, { grant, password: secret, passwordConfirmation: secret });
        await reached;
        await change(user);
        release();
        const result = await pending;
        setKdfObserverForTests(null);
        await undo(user);
        assert.deepEqual([result.status, result.data.error], [status, error], label);
        assert.equal((await (await getStore()).getAuthMethodByKey(`${user.id}:password`)), undefined, `${label}: no credential written`);
        const retry = await setPassword(user.id, { grant, password: secret, passwordConfirmation: secret });
        assert.deepEqual([retry.status, retry.data.error], [403, 'operation_grant_required'], `${label}: the grant was deleted`);
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
