import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getStore, flush, resetStoreForTests } from '../lib/store.mjs';
import { credentialVersion } from '../lib/auth/credentialVersion.mjs';
import { ensureSeedData } from '../lib/bootstrap.mjs';
import { createUser, getUserById, getUserByEmail, getUserRoles, updateUser, setUserRoles, listUsers } from '../lib/users.mjs';
import { getInstallationSetup } from '../lib/setup.mjs';
import { completeGoogleIdentity, inspectGoogleIdentity, googleIdentityKey, mailboxVersion, GOOGLE_ISSUER } from '../lib/externalIdentities.mjs';
import { verifyAdministratorPassword } from '../lib/auth/adminPassword.mjs';
import * as setup from './helpers/setup.mjs';

let folder;
const transactionId = 'fixture-transaction';
const identity = (subject = 'google-subject', email = 'member@gmail.com', extra = {}) => ({ issuer: GOOGLE_ISSUER, subject, email, emailVerified: true, ...extra });

async function proof(user, method = 'emailCode') {
    const now = Date.now();
    const result = { transactionId, userId: user.id, email: user.email, method, authenticatedAt: now, confirmedAt: now };
    if (method === 'emailCode' || method === 'googleAuthoritative') result.credentialVersion = mailboxVersion(await getUserById(user.id));
    else if (method === 'passkey' || method === 'totp') {
        result.credentialKey = `${user.id}:${method}`;
        result.credentialVersion = credentialVersion(method, (await (await getStore()).getAuthMethodByKey(result.credentialKey)).credential);
    } else if (method === 'adminPassword') {
        result.credentialVersion = (await verifyAdministratorPassword({ password: process.env.USERPERSISTO_ADMIN_PASSWORD, rateSource: 'a'.repeat(64) })).credentialVersion;
    }
    return result;
}

async function fixture({ claimed = true } = {}) {
    folder = await mkdtemp(join(tmpdir(), 'userpersisto-google-identities-'));
    process.env.PERSISTENCE_FOLDER = folder;
    process.env.USERPERSISTO_SETTINGS_KEY = 'test-settings-key';
    process.env.USERPERSISTO_AUTH_METHODS = 'google,passkey,totp,emailCode';
    process.env.USERPERSISTO_SELF_REGISTRATION_ENABLED = 'true';
    setup.resetAuthLimitsForTests();
    await ensureSeedData();
    if (claimed) {
        const password = setup.configureAdministratorPassword();
        return (await setup.claimAdministrator(password)).user;
    }
    setup.clearAdministratorPassword();
    return null;
}

afterEach(async () => {
    await resetStoreForTests().catch(() => {});
    if (folder) await rm(folder, { recursive: true, force: true });
    setup.clearAdministratorPassword();
    for (const name of ['USERPERSISTO_AUTH_METHODS', 'USERPERSISTO_SELF_REGISTRATION_ENABLED']) delete process.env[name];
});

test('the first completed Google sign-in claims setup; later Google users receive exactly selfRegistered', async () => {
    await fixture({ claimed: false });
    // Non-authoritative addresses still need the mailbox proof, even for the owner.
    const thirdParty = identity('owner-third-party', 'owner@example.test');
    await assert.rejects(completeGoogleIdentity({ identity: thirdParty, transactionId }), { code: 'google_mailbox_proof_required' });
    assert.equal((await getInstallationSetup()).complete, false);
    const owner = await completeGoogleIdentity({ identity: identity('owner-subject', 'owner@gmail.com'), transactionId });
    assert.deepEqual([owner.created, owner.initialAdministrator, owner.roles], [true, true, ['admin']]);
    const record = await getInstallationSetup();
    assert.deepEqual([record.initialAdministratorId, record.method], [owner.user.id, 'google']);
    const later = await completeGoogleIdentity({ identity: identity(), transactionId });
    assert.deepEqual([later.roles, later.initialAdministrator], [['selfRegistered'], false]);
    assert.equal(later.user.source, 'google-self-registration');
    assert.ok(later.user.emailVerifiedAt);
    assert.equal(Object.hasOwn(await getUserById(later.user.id), 'passwordHash'), false);
    await setUserRoles(later.user.id, ['user']);
    await updateUser(later.user.id, { displayName: 'Kept name', username: 'kept-user' });
    process.env.USERPERSISTO_SELF_REGISTRATION_ENABLED = 'false';
    const returning = await completeGoogleIdentity({ identity: identity('google-subject', 'changed@example.test'), transactionId: 'new-attempt' });
    assert.equal(returning.user.id, later.user.id);
    assert.equal(returning.user.email, 'member@gmail.com', 'a changed Google address never rewrites the local email');
    assert.equal(returning.user.displayName, 'Kept name');
    assert.deepEqual(returning.roles, ['user']);
    const listing = await listUsers({ includeRoleCounts: true });
    assert.equal(listing.users.some((user) => 'subject' in user || 'identityKey' in user || 'payload' in user), false);
});

test('mailbox proofs never link an unverified, disabled or stale local mailbox', async () => {
    await fixture();
    const unverified = await createUser({ email: 'victim@gmail.com', roles: ['user'] });
    const external = identity('victim-subject', unverified.email);
    assert.deepEqual((await inspectGoogleIdentity(external)).eligibleMethods, []);
    for (const method of ['emailCode', 'googleAuthoritative']) {
        await assert.rejects(completeGoogleIdentity({ identity: external, transactionId, linkProof: await proof(unverified, method),
            mailboxProof: { transactionId, email: unverified.email, verifiedAt: Date.now() } }), { code: 'google_link_authentication_required' });
    }
    const verified = await createUser({ email: 'verified@gmail.com', roles: ['user'], emailVerified: true });
    const verifiedIdentity = identity('verified-subject', verified.email);
    assert.deepEqual((await inspectGoogleIdentity(verifiedIdentity)).eligibleMethods, ['emailCode', 'googleAuthoritative']);
    const stale = await proof(verified, 'emailCode');
    const store = await getStore();
    await store.updateUser(verified.id, { authGeneration: 1 });
    await flush();
    await assert.rejects(completeGoogleIdentity({ identity: verifiedIdentity, transactionId, linkProof: stale }), { code: 'google_link_authentication_required' });
    process.env.USERPERSISTO_AUTH_METHODS = 'google,passkey,totp';
    assert.deepEqual((await inspectGoogleIdentity(verifiedIdentity)).eligibleMethods, []);
    await assert.rejects(completeGoogleIdentity({ identity: verifiedIdentity, transactionId, linkProof: await proof(verified, 'emailCode') }), { code: 'google_link_authentication_required' });
    assert.equal(await store.getExternalIdentityByIdentityKey(googleIdentityKey(external)), undefined);
    assert.equal(await store.getExternalIdentityByIdentityKey(googleIdentityKey(verifiedIdentity)), undefined);
});

test('the authoritative shortcut requires Gmail or a matching Workspace domain', async () => {
    await fixture();
    const workspace = await createUser({ email: 'person@workspace.test', roles: ['user'], emailVerified: true });
    const nonAuthoritative = identity('workspace-person', workspace.email);
    assert.deepEqual((await inspectGoogleIdentity(nonAuthoritative)).eligibleMethods, ['emailCode']);
    await assert.rejects(completeGoogleIdentity({ identity: nonAuthoritative, transactionId, linkProof: await proof(workspace, 'googleAuthoritative') }),
        { code: 'google_link_authentication_required' });
    const authoritative = identity('workspace-person', workspace.email, { hostedDomain: 'workspace.test' });
    assert.deepEqual((await inspectGoogleIdentity(authoritative)).eligibleMethods, ['emailCode', 'googleAuthoritative']);
    const linked = await completeGoogleIdentity({ identity: authoritative, transactionId, linkProof: await proof(workspace, 'googleAuthoritative') });
    assert.equal(linked.user.id, workspace.id);
    assert.equal(linked.linked, true);
});

test('fresh email-code, passkey, TOTP and administrator-password proofs with confirmation preserve roles and credentials', async () => {
    const owner = await fixture();
    const store = await getStore();
    for (const method of ['emailCode', 'passkey', 'totp']) {
        const user = await createUser({ email: `${method}@gmail.com`, roles: ['admin', 'user'], emailVerified: method === 'emailCode' });
        if (method !== 'emailCode') await store.createAuthMethod({ key: `${user.id}:${method}`, userId: user.id, type: method, enabled: true, credential: { fixture: true } });
        await flush();
        const original = await getUserById(user.id);
        const result = await completeGoogleIdentity({ identity: identity(method, user.email), transactionId, linkProof: await proof(user, method) });
        assert.equal(result.user.id, user.id);
        assert.deepEqual(result.roles, ['admin', 'user']);
        assert.deepEqual(await getUserById(user.id), { ...original, updatedAt: (await getUserById(user.id)).updatedAt });
    }
    // The administrator-password proof covers the designated administrator only.
    const member = await createUser({ email: 'member-admin-proof@gmail.com', roles: ['user'] });
    const memberIdentity = identity('member-admin-proof', member.email);
    assert.equal((await inspectGoogleIdentity(memberIdentity)).eligibleMethods.includes('adminPassword'), false);
    await assert.rejects(completeGoogleIdentity({ identity: memberIdentity, transactionId, linkProof: { ...(await proof(owner, 'adminPassword')), userId: member.id, email: member.email } }),
        { code: 'google_link_authentication_required' });
    assert.deepEqual(await getUserRoles(member.id), ['user']);
});

test('collision proofs reject changed targets, disabled credentials, stale authentication and absent confirmation', async () => {
    await fixture();
    const user = await createUser({ email: 'collision@gmail.com', roles: ['user'], emailVerified: true });
    const external = identity('collision', user.email);
    const valid = await proof(user);
    for (const patch of [{ method: 'password' }, { method: 'passkey' }, { credentialVersion: undefined }, { credentialVersion: 'wrong' }, { confirmedAt: undefined },
        { authenticatedAt: Date.now() - 120001 }, { userId: 'another-user' }, { transactionId: 'other-attempt' }]) {
        await assert.rejects(completeGoogleIdentity({ identity: external, transactionId, linkProof: { ...valid, ...patch } }), {
            code: patch.userId ? 'google_collision_changed' : 'google_link_authentication_required',
        });
    }
    process.env.USERPERSISTO_AUTH_METHODS = 'google';
    await assert.rejects(completeGoogleIdentity({ identity: external, transactionId, linkProof: valid }), { code: 'google_link_authentication_required' });
    process.env.USERPERSISTO_AUTH_METHODS = 'google,emailCode';
    // A concurrent address change (only possible through verified contact
    // replacement) invalidates the retained collision target.
    const store = await getStore();
    await store.setEmailForUser(user.id, 'changed@gmail.com');
    await flush();
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
    await createUser({ email: external.email, roles: ['user'] });
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

test('concurrent first Google completions create exactly one administrator', async () => {
    await fixture({ claimed: false });
    const results = await Promise.all(['one', 'two', 'three'].map((subject) => completeGoogleIdentity({ identity: identity(subject, `${subject}@gmail.com`), transactionId })));
    assert.equal(results.filter((entry) => entry.initialAdministrator).length, 1);
    assert.equal(results.filter((entry) => entry.roles.includes('admin')).length, 1);
    assert.equal(results.filter((entry) => entry.roles.includes('selfRegistered')).length, 2);
    assert.equal((await getInstallationSetup()).initialAdministratorId, results.find((entry) => entry.initialAdministrator).user.id);
});

test('registration policy, role safety, active status and parent are rechecked before mutation', async () => {
    await fixture();
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
    for (const capability of ['explorer.access', 'admin.users.manage']) {
        const permission = await store.getPermissionByCapability(capability);
        await store.createRolePermission({ key: `${role.id}:${permission.id}`, roleId: role.id, permissionId: permission.id });
        await flush();
        await assert.rejects(completeGoogleIdentity({ identity: identity(`unsafe-${capability}`, `${capability}@gmail.com`), transactionId }), { code: 'registration_role_must_be_restricted' });
        assert.equal(await getUserByEmail(`${capability}@gmail.com`), null);
        await store.deleteRolePermission(`${role.id}:${permission.id}`);
        await flush();
    }
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
