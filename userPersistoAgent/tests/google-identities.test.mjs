import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getStore, flush, resetStoreForTests } from '../lib/store.mjs';
import { credentialVersion } from '../lib/auth/credentialVersion.mjs';
import { ensureSeedData } from '../lib/bootstrap.mjs';
import { createUser, getUserById, getUserByEmail, getUserRoles, updateUser, setUserRoles, registerUser, listUsers } from '../lib/users.mjs';
import { completeGoogleIdentity, inspectGoogleIdentity, googleIdentityKey, GOOGLE_ISSUER } from '../lib/externalIdentities.mjs';

let folder;
const transactionId = 'fixture-transaction';
const identity = (subject = 'google-subject', email = 'member@gmail.com') => ({ issuer: GOOGLE_ISSUER, subject, email, emailVerified: true });
async function proof(user, method = 'password') {
    const result = { transactionId, userId: user.id, email: user.email, method, authenticatedAt: Date.now(), confirmedAt: Date.now() };
    if (method === 'password') result.credentialVersion = credentialVersion(method, (await getUserById(user.id)).passwordHash);
    else if (method === 'passkey' || method === 'totp') {
        result.credentialKey = user.id + ':' + method;
        result.credentialVersion = credentialVersion(method, (await (await getStore()).getAuthMethodByKey(result.credentialKey)).credential);
    }
    return result;
}

async function fixture({ owner = true } = {}) {
    folder = await mkdtemp(join(tmpdir(), 'userpersisto-google-identities-'));
    process.env.PERSISTENCE_FOLDER = folder;
    process.env.USERPERSISTO_AUTH_METHODS = 'password,google,passkey,totp,emailCode';
    process.env.USERPERSISTO_SELF_REGISTRATION_ENABLED = 'true';
    process.env.USERPERSISTO_DEFAULT_REGISTRATION_ROLE = 'user';
    await ensureSeedData();
    if (owner) await createUser({ email: 'owner@example.test', roles: ['admin'], password: 'owner-password' });
}

afterEach(async () => {
    await resetStoreForTests().catch(() => {});
    if (folder) await rm(folder, { recursive: true, force: true });
    for (const name of ['USERPERSISTO_AUTH_METHODS', 'USERPERSISTO_SELF_REGISTRATION_ENABLED', 'USERPERSISTO_DEFAULT_REGISTRATION_ROLE']) delete process.env[name];
});

test('new Google users receive exactly selfRegistered without a password or profile overwrite', async () => {
    await fixture();
    const result = await completeGoogleIdentity({ identity: identity(), transactionId });
    assert.deepEqual(result.roles, ['selfRegistered']);
    assert.equal(result.created, true);
    assert.equal(result.user.source, 'google-self-registration');
    assert.equal(result.user.username, '');
    assert.ok(result.user.emailVerifiedAt);
    assert.equal((await getUserById(result.user.id)).passwordHash, '');
    await setUserRoles(result.user.id, ['user']);
    await updateUser(result.user.id, { displayName: 'Kept name', username: 'kept-user' });
    process.env.USERPERSISTO_SELF_REGISTRATION_ENABLED = 'false';
    const returning = await completeGoogleIdentity({ identity: identity('google-subject', 'changed@example.test'), transactionId: 'new-attempt' });
    assert.equal(returning.user.id, result.user.id);
    assert.equal(returning.user.email, 'member@gmail.com');
    assert.equal(returning.user.displayName, 'Kept name');
    assert.deepEqual(returning.roles, ['user']);
    assert.equal(returning.created, false);
    const listing = await listUsers({ includeRoleCounts: true });
    assert.equal(listing.users.some((user) => 'subject' in user || 'identityKey' in user || 'payload' in user), false);
    assert.equal(listing.singleRoleCounts.user, 1);
});

test('email-only proof cannot link an attacker-created account, even with historical verification', async () => {
    await fixture();
    for (const emailVerified of [false, true]) {
        const user = await createUser({ email: `victim-${emailVerified}@gmail.com`, password: 'attacker-password', roles: ['user'], emailVerified });
        const external = identity(`subject-${emailVerified}`, user.email);
        assert.deepEqual((await inspectGoogleIdentity(external)).eligibleMethods, ['password']);
        for (const linkProof of [undefined, await proof(user, 'emailCode')]) {
            await assert.rejects(completeGoogleIdentity({
                identity: external, transactionId, linkProof,
                mailboxProof: { transactionId, email: user.email, verifiedAt: Date.now() },
            }), { code: 'google_link_authentication_required' });
        }
        assert.equal(await (await getStore()).getExternalIdentityByIdentityKey(googleIdentityKey(external)), undefined);
        assert.deepEqual(await getUserRoles(user.id), ['user']);
    }
});

test('fresh existing password, passkey and TOTP proofs plus confirmation preserve roles and credentials', async () => {
    await fixture();
    const store = await getStore();
    for (const method of ['password', 'passkey', 'totp']) {
        const user = await createUser({ email: `${method}@gmail.com`, password: method === 'password' ? 'existing-password' : '', roles: ['admin', 'user'] });
        if (method !== 'password') await store.createAuthMethod({ key: `${user.id}:${method}`, userId: user.id, type: method, enabled: true, credential: { fixture: true } });
        await flush();
        const original = await getUserById(user.id);
        const credentialProof = await proof(user, method);
        if (method !== 'password') credentialProof.credentialKey = `${user.id}:${method}`;
        const result = await completeGoogleIdentity({ identity: identity(method, user.email), transactionId, linkProof: credentialProof });
        assert.equal(result.user.id, user.id);
        assert.deepEqual(result.roles, ['admin', 'user']);
        assert.equal((await getUserById(user.id)).passwordHash, original.passwordHash);
    }
});

test('collision proofs reject changed targets, disabled credentials, stale authentication and absent confirmation', async () => {
    await fixture();
    const user = await createUser({ email: 'collision@gmail.com', password: 'existing-password', roles: ['user'], emailVerified: true });
    const external = identity('collision', user.email);
    const valid = await proof(user);
    for (const patch of [{ method: 'emailCode' }, { credentialVersion: undefined }, { credentialVersion: 'wrong' }, { confirmedAt: undefined }, { authenticatedAt: Date.now() - 120001 }, { userId: 'another-user' }, { transactionId: 'other-attempt' }]) {
        await assert.rejects(completeGoogleIdentity({ identity: external, transactionId, linkProof: { ...valid, ...patch } }), {
            code: patch.userId ? 'google_collision_changed' : 'google_link_authentication_required',
        });
    }
    process.env.USERPERSISTO_AUTH_METHODS = 'google';
    await assert.rejects(completeGoogleIdentity({ identity: external, transactionId, linkProof: valid }), { code: 'google_link_authentication_required' });
    process.env.USERPERSISTO_AUTH_METHODS = 'google,password';
    await updateUser(user.id, { email: 'changed@gmail.com' });
    assert.equal((await getUserById(user.id)).emailVerifiedAt, '');
    await assert.rejects(completeGoogleIdentity({ identity: external, transactionId, linkProof: valid }), { code: 'google_collision_changed' });
    await assert.rejects(inspectGoogleIdentity(external, { collisionTarget: { userId: user.id, email: user.email } }), { code: 'google_collision_changed' });
    assert.equal(await getUserByEmail('collision@gmail.com'), null);
});

test('third-party new-user mailbox proof is fresh, transaction-bound and cannot upgrade a late collision', async () => {
    await fixture();
    const external = identity('third-party', 'third-party@example.test');
    assert.equal((await inspectGoogleIdentity(external)).mailboxProofRequired, true);
    for (const mailboxProof of [undefined, { transactionId: 'wrong', email: external.email, verifiedAt: Date.now() }, { transactionId, email: external.email, verifiedAt: Date.now() - 120001 }]) {
        await assert.rejects(completeGoogleIdentity({ identity: external, transactionId, mailboxProof }), { code: 'google_mailbox_proof_required' });
        assert.equal(await getUserByEmail(external.email), null);
    }
    await createUser({ email: external.email, password: 'attacker-password', roles: ['user'] });
    await assert.rejects(completeGoogleIdentity({ identity: external, transactionId, mailboxProof: { transactionId, email: external.email, verifiedAt: Date.now() } }), { code: 'google_link_authentication_required' });
    const other = identity('third-party-new', 'new@example.test');
    const created = await completeGoogleIdentity({ identity: other, transactionId, mailboxProof: { transactionId, email: other.email, verifiedAt: Date.now() } });
    assert.equal(created.created, true);
    assert.equal((await inspectGoogleIdentity({ ...identity('workspace', 'person@workspace.test'), hostedDomain: 'workspace.test' })).mailboxProofRequired, false);
});

test('concurrent subject and email resolution never duplicates users or replaces identity ownership', async () => {
    await fixture();
    const same = await Promise.all(Array.from({ length: 6 }, () => completeGoogleIdentity({ identity: identity(), transactionId })));
    assert.equal(new Set(same.map((entry) => entry.user.id)).size, 1);
    assert.equal(same.filter((entry) => entry.created).length, 1);
    const results = await Promise.allSettled(['a', 'b'].map((subject) => completeGoogleIdentity({ identity: identity(subject, 'parallel@gmail.com'), transactionId })));
    assert.equal(results.filter((entry) => entry.status === 'fulfilled').length, 1);
    assert.equal(results.find((entry) => entry.status === 'rejected').reason.code, 'google_identity_already_linked');
    const user = await getUserByEmail('parallel@gmail.com');
    await assert.rejects(completeGoogleIdentity({ identity: identity('different', user.email), transactionId, linkProof: await proof(user) }), { code: 'google_identity_already_linked' });
});

test('setup, registration policy, role safety, active status and parent are rechecked before mutation', async () => {
    await fixture({ owner: false });
    await assert.rejects(completeGoogleIdentity({ identity: identity(), transactionId }), { code: 'initial_setup_required' });
    await registerUser({ email: 'initial-owner@example.test', password: 'owner-password' });
    process.env.USERPERSISTO_SELF_REGISTRATION_ENABLED = 'false';
    await assert.rejects(completeGoogleIdentity({ identity: identity(), transactionId }), { code: 'registration_disabled' });
    process.env.USERPERSISTO_SELF_REGISTRATION_ENABLED = 'true';
    await assert.rejects(completeGoogleIdentity({ identity: identity(), transactionId, validateParent: () => { throw new Error('parent-expired'); } }), /parent-expired/);
    assert.equal(await getUserByEmail('member@gmail.com'), null);
    const created = await completeGoogleIdentity({ identity: identity(), transactionId });
    await updateUser(created.user.id, { status: 'blocked' });
    await assert.rejects(completeGoogleIdentity({ identity: identity(), transactionId }), { code: 'user_blocked' });
    const store = await getStore();
    const role = await store.getRoleByName('selfRegistered');
    const permission = await store.getPermissionByCapability('admin.users.manage');
    await store.createRolePermission({ key: `${role.id}:${permission.id}`, roleId: role.id, permissionId: permission.id });
    await flush();
    await assert.rejects(completeGoogleIdentity({ identity: identity('unsafe-role', 'other@gmail.com'), transactionId }), { code: 'registration_role_must_be_non_admin' });
    assert.equal(await getUserByEmail('other@gmail.com'), null);
});

test('immutable subject comparison is case-sensitive and local binding survives restart', async () => {
    await fixture();
    assert.notEqual(googleIdentityKey(identity('Subject')), googleIdentityKey(identity('subject')));
    await assert.rejects(async () => completeGoogleIdentity({ identity: { ...identity(), issuer: 'accounts.google.com' }, transactionId }), { code: 'google_identity_invalid' });
    const created = await completeGoogleIdentity({ identity: identity(), transactionId });
    await resetStoreForTests();
    const returning = await completeGoogleIdentity({ identity: identity(), transactionId: 'after-restart' });
    assert.equal(returning.user.id, created.user.id);
    assert.equal(returning.created, false);
});
