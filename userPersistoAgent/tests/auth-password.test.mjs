import test, { after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.PERSISTENCE_FOLDER = mkdtempSync(join(tmpdir(), 'userpersisto-admin-password-'));
process.env.USERPERSISTO_SETTINGS_KEY = 'test-settings-key';

const { ensureSeedData } = await import('../lib/bootstrap.mjs');
const { getUserById, getUserRoles, setUserRoles, updateUser, createUser } = await import('../lib/users.mjs');
const { getInstallationSetup } = await import('../lib/setup.mjs');
const { getStore, flush, resetStoreForTests } = await import('../lib/store.mjs');
const admin = await import('../lib/auth/adminPassword.mjs');
const { wizardConfiguration } = await import('../lib/auth/wizardConfig.mjs');
const { getEnabledAuthMethods, getDefaultAuthMethod } = await import('../lib/auth/methods.mjs');
const setup = await import('./helpers/setup.mjs');

const SOURCE_A = 'a'.repeat(64);
const SOURCE_B = 'b'.repeat(64);

after(async () => {
    await resetStoreForTests();
});

beforeEach(async () => {
    await resetStoreForTests();
    process.env.PERSISTENCE_FOLDER = mkdtempSync(join(tmpdir(), 'userpersisto-admin-password-'));
    setup.clearAdministratorPassword();
    setup.resetAuthLimitsForTests();
    await ensureSeedData();
});

function snapshotText(folder) {
    let text = '';
    const walk = (path) => {
        for (const entry of readdirSync(path)) {
            const full = join(path, entry);
            if (statSync(full).isDirectory()) walk(full);
            else text += readFileSync(full, 'utf8');
        }
    };
    walk(folder);
    return text;
}

test('passwordless methods are the default and an absent or short password leaves the action unavailable', async () => {
    assert.deepEqual(await getEnabledAuthMethods(), ['emailCode', 'passkey', 'totp']);
    assert.equal(await getDefaultAuthMethod(), 'emailCode');
    assert.equal((await wizardConfiguration()).adminPassword, false);
    await assert.rejects(setup.claimAdministrator('anything-at-all-12'), { code: 'admin_password_unavailable' });
    process.env.USERPERSISTO_ADMIN_PASSWORD = 'too-short';
    admin.resetAdministratorPasswordForTests();
    assert.equal((await wizardConfiguration()).adminPassword, false);
    await assert.rejects(setup.claimAdministrator('too-short'), { code: 'admin_password_unavailable' });
    assert.equal((await getInstallationSetup()).complete, false);
});

test('before setup the configured password creates only the dedicated email-less administrator', async () => {
    const password = setup.configureAdministratorPassword();
    assert.equal((await wizardConfiguration()).adminPassword, true);
    await assert.rejects(setup.claimAdministrator(`${password}-wrong`), { code: 'authentication_failed' });
    assert.equal((await getInstallationSetup()).complete, false);
    await assert.rejects(setup.claimAdministrator(password, { contactEmail: 'not-an-email' }), { code: 'invalid_email' });
    assert.equal((await getInstallationSetup()).complete, false);
    const claimed = await setup.claimAdministrator(password, { contactEmail: 'Operator@Example.test' });
    assert.equal(claimed.initialAdministrator, true);
    assert.deepEqual(claimed.roles, ['admin']);
    const user = await getUserById(claimed.user.id);
    assert.equal(user.email, '', 'no fabricated deliverable email');
    assert.equal(user.username, 'administrator');
    assert.equal(user.contactEmail, 'operator@example.test');
    assert.equal(user.emailVerifiedAt, '', 'contact information stays unverified');
    const record = await getInstallationSetup();
    assert.deepEqual([record.complete, record.initialAdministratorId, record.method], [true, user.id, 'adminPassword']);
    const again = await setup.claimAdministrator(password, { contactEmail: 'other@example.test' });
    assert.equal(again.user.id, user.id);
    assert.equal(again.created, false);
    assert.equal((await getUserById(user.id)).contactEmail, 'operator@example.test');
    // The verifier is a scrypt hash; the configured value never reaches storage.
    await flush();
    const stored = snapshotText(process.env.PERSISTENCE_FOLDER);
    assert.ok(!stored.includes(password));
    assert.match(stored, /scrypt\$16384\$8\$1\$/);
});

test('after email setup the password signs into the designated administrator only', async () => {
    const owner = await setup.registerWithEmailCode('owner@example.test');
    const member = await setup.registerWithEmailCode('member@example.test');
    const password = setup.configureAdministratorPassword();
    const signedIn = await setup.claimAdministrator(password, { contactEmail: 'member@example.test' });
    assert.equal(signedIn.user.id, owner.user.id);
    assert.deepEqual(await getUserRoles(member.user.id), ['selfRegistered']);
    assert.equal(await admin.administratorPasswordUsableFor(owner.user.id), true);
    assert.equal(await admin.administratorPasswordUsableFor(member.user.id), false);
    // Another administrator never receives this path.
    const second = await createUser({ email: 'second-admin@example.test', roles: ['admin'], emailVerified: true });
    assert.equal(await admin.administratorPasswordUsableFor(second.id), false);
    // Demotion, blocking and deletion of the designated administrator end it.
    await setUserRoles(owner.user.id, ['user'], { actorId: second.id });
    await assert.rejects(setup.claimAdministrator(password), { code: 'authentication_failed' });
    await setUserRoles(owner.user.id, ['admin'], { actorId: second.id });
    assert.equal((await setup.claimAdministrator(password)).user.id, owner.user.id);
    await updateUser(owner.user.id, { status: 'blocked' }, { actorId: second.id });
    await assert.rejects(setup.claimAdministrator(password), { code: 'authentication_failed' });
    await (await getStore()).deleteUser(owner.user.id);
    await assert.rejects(setup.claimAdministrator(password), { code: 'authentication_failed' });
    assert.deepEqual(await getUserRoles(member.user.id), ['selfRegistered']);
    assert.equal((await getInstallationSetup()).initialAdministratorId, owner.user.id);
});

test('guessing limits hold per trusted source and globally, before any account exists and across restarts', async () => {
    const password = setup.configureAdministratorPassword();
    const wrong = () => `wrong-${randomBytes(9).toString('base64url')}`;
    for (let index = 0; index < 5; index += 1) {
        await assert.rejects(admin.verifyAdministratorPassword({ password: wrong(), rateSource: SOURCE_A }), { code: 'authentication_failed' });
    }
    await assert.rejects(admin.verifyAdministratorPassword({ password, rateSource: SOURCE_A }), (error) => error.code === 'rate_limited' && error.retryAfter > 0);
    assert.ok((await admin.verifyAdministratorPassword({ password, rateSource: SOURCE_B })).credentialVersion);
    // Shorter or oversized candidates are refused without hashing or spending budget.
    await assert.rejects(admin.verifyAdministratorPassword({ password: 'short', rateSource: SOURCE_B }), { code: 'authentication_failed' });
    await assert.rejects(admin.verifyAdministratorPassword({ password: 'x'.repeat(1025), rateSource: SOURCE_B }), { code: 'authentication_failed' });
    // The durable global budget spans fresh sources and process restarts.
    let spent = 5;
    for (let source = 0; spent < 30; source += 1) {
        const rateSource = source.toString(16).padStart(64, 'c');
        for (let index = 0; index < 5 && spent < 30; index += 1, spent += 1) {
            await assert.rejects(admin.verifyAdministratorPassword({ password: wrong(), rateSource }), { code: 'authentication_failed' });
        }
    }
    await resetStoreForTests();
    setup.resetAuthLimitsForTests();
    await assert.rejects(admin.verifyAdministratorPassword({ password, rateSource: 'd'.repeat(64) }), { code: 'rate_limited' });
    await assert.rejects(setup.claimAdministrator(password), { code: 'rate_limited' });
    assert.equal((await getInstallationSetup()).complete, false);
});

test('requests without a trusted source share one bucket', async () => {
    const password = setup.configureAdministratorPassword();
    for (let index = 0; index < 5; index += 1) {
        await assert.rejects(admin.verifyAdministratorPassword({ password: `untrusted-${index}-guess`, rateSource: 'forged-header' }), { code: 'authentication_failed' });
    }
    await assert.rejects(admin.verifyAdministratorPassword({ password }), { code: 'rate_limited' });
    assert.ok((await admin.verifyAdministratorPassword({ password, rateSource: SOURCE_A })).credentialVersion);
});

test('rotating or removing the configured password invalidates retained proofs and advances the administrator generation', async () => {
    const first = setup.configureAdministratorPassword();
    const claimed = await setup.claimAdministrator(first);
    const store = await getStore();
    const proof = await admin.verifyAdministratorPassword({ password: first, rateSource: SOURCE_A });
    assert.equal(await admin.assertAdministratorPasswordProof(store, { userId: claimed.user.id, credentialVersion: proof.credentialVersion }), true);
    const generation = (await getUserById(claimed.user.id)).authGeneration;
    const second = setup.configureAdministratorPassword();
    await admin.syncAdministratorPasswordState();
    assert.equal(await admin.assertAdministratorPasswordProof(store, { userId: claimed.user.id, credentialVersion: proof.credentialVersion }), false);
    assert.equal((await getUserById(claimed.user.id)).authGeneration, generation + 1);
    await assert.rejects(setup.claimAdministrator(first), { code: 'authentication_failed' });
    assert.equal((await setup.claimAdministrator(second)).user.id, claimed.user.id);
    setup.clearAdministratorPassword();
    await admin.syncAdministratorPasswordState();
    assert.equal((await getUserById(claimed.user.id)).authGeneration, generation + 2);
    assert.equal(await admin.administratorPasswordUsableFor(claimed.user.id), false);
    await assert.rejects(setup.claimAdministrator(second), { code: 'admin_password_unavailable' });
});
