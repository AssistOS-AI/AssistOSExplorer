import test, { beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ensureSeedData } from '../lib/bootstrap.mjs';
import { getStore, resetStoreForTests } from '../lib/store.mjs';
import { prepareNewAccount } from '../lib/setup.mjs';
import { deriveUsernameFromEmail, getUserById, updateUser } from '../lib/users.mjs';
import { completeGoogleIdentity, GOOGLE_ISSUER } from '../lib/externalIdentities.mjs';
import { loginWithInitialPassword } from '../lib/auth/initialPassword.mjs';
import { createLoginRequest, getLoginRequest, prepareSsoHandoff } from '../lib/sso.mjs';
import { runTool } from '../tools/registry.mjs';
import { newBrowserProof, resetAuthLimitsForTests, signUpDirect, signUpWithPassword } from './helpers/setup.mjs';

const USERNAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{2,63}$/;
let folder, environment;

beforeEach(async () => {
    environment = { ...process.env };
    folder = await mkdtemp(join(tmpdir(), 'userpersisto-username-derivation-'));
    process.env.PERSISTENCE_FOLDER = folder;
    process.env.USERPERSISTO_SETTINGS_KEY = 'username-derivation-fixture-settings';
    process.env.USERPERSISTO_AUTH_METHODS = 'google,emailCode,password';
    process.env.USERPERSISTO_SELF_REGISTRATION_ENABLED = 'true';
    resetAuthLimitsForTests();
    await ensureSeedData();
});

afterEach(async () => {
    await resetStoreForTests().catch(() => {});
    await rm(folder, { recursive: true, force: true });
    for (const name of Object.keys(process.env)) if (!Object.hasOwn(environment, name)) delete process.env[name];
    Object.assign(process.env, environment);
});

test('derivation follows the sanitize, pad, collision and reserved-name rules', () => {
    const taken = new Set();
    assert.equal(deriveUsernameFromEmail('alice@x.com', taken), 'alice');
    assert.equal(deriveUsernameFromEmail('Alice.B+qa@x.com', taken), 'alice.b');
    assert.equal(deriveUsernameFromEmail('ab@x.com', taken), 'ab-user');
    assert.equal(deriveUsernameFromEmail('__@x.com', taken), 'user');
    assert.equal(deriveUsernameFromEmail('alice@y.com', taken), 'alice-2');
    assert.equal(deriveUsernameFromEmail('alice@z.com', taken), 'alice-3');
    assert.equal(deriveUsernameFromEmail('+tag@x.com', new Set()), 'user');
    assert.equal(deriveUsernameFromEmail('a/b c@x.com', new Set()), 'a-b-c');
    // Collision matching is case-insensitive because the taken set is lowercase.
    assert.equal(deriveUsernameFromEmail('Bob@x.com', new Set(['bob'])), 'bob-2');
});

test('reserved names are skipped by derivation', () => {
    assert.equal(deriveUsernameFromEmail('admin@x.com', new Set()), 'admin-2');
    assert.equal(deriveUsernameFromEmail('ADMIN@x.com', new Set(['admin-2'])), 'admin-3');
    assert.equal(deriveUsernameFromEmail('admin+ops@x.com', new Set()), 'admin-2');
});

test('long local parts stay within 64 characters and match the username rule, with and without a suffix', () => {
    const email = `${'a'.repeat(70)}@x.com`;
    const taken = new Set();
    const first = deriveUsernameFromEmail(email, taken);
    assert.equal(first.length, 64);
    assert.match(first, USERNAME_RE);
    const second = deriveUsernameFromEmail(email, taken);
    assert.equal(second.length, 64);
    assert.match(second, USERNAME_RE);
    assert.notEqual(second, first);
    assert.ok(second.endsWith('-2'));
    const dotted = deriveUsernameFromEmail(`${'a'.repeat(62)}.b.c@x.com`, new Set());
    assert.match(dotted, USERNAME_RE);
    assert.ok(dotted.length <= 64);
});

test('every account creation path assigns a derived username and an explicit username wins', async () => {
    const request = await createLoginRequest({ redirectUri: 'http://127.0.0.1/auth/callback' });
    const owner = await loginWithInitialPassword({
        parent: { flow: 'sso', id: request.providerState, expiresAt: Date.parse(request.expiresAt) },
        browserProof: newBrowserProof(),
        email: 'Owner+setup@Example.test',
        password: 'admin',
        validateParent: () => getLoginRequest(request.providerState),
        prepareHandoff: () => prepareSsoHandoff(request.providerState),
    });
    assert.equal((await getUserById(owner.user.id)).username, 'owner');

    const verified = await signUpWithPassword('alice@example.test');
    assert.equal((await getUserById(verified.user.id)).username, 'alice');
    const direct = await signUpDirect('alice@other.test');
    assert.equal((await getUserById(direct.user.id)).username, 'alice-2');
    const google = await completeGoogleIdentity({
        identity: { issuer: GOOGLE_ISSUER, subject: 'derivation-google', email: 'gina@gmail.com', emailVerified: true },
        transactionId: 'derivation-google-transaction',
    });
    assert.equal((await getUserById(google.user.id)).username, 'gina');

    // A derived name that is already used by a user-chosen name is skipped.
    await updateUser(google.user.id, { username: 'Chosen.Name' }, { actorId: google.user.id });
    const stage = await prepareNewAccount({ email: 'chosen.name@example.test', emailVerified: true, method: 'passwordSignup' });
    const derived = await stage();
    assert.equal(derived.user.username, 'chosen.name-2');

    const explicit = await prepareNewAccount({ email: 'kept@example.test', username: 'Explicit.Name', emailVerified: true, method: 'passwordSignup' });
    assert.equal((await explicit()).user.username, 'Explicit.Name');
});

test('profile and administrator updates reject reserved usernames and accept ordinary ones', async () => {
    const owner = await signUpWithPassword('owner@example.test');
    const member = await signUpWithPassword('member@example.test');
    for (const username of ['admin', 'Admin', 'ADMIN', ' admin ', 'a:b', 'user:abc']) {
        await assert.rejects(runTool('userpersisto_profile_update', { username }, { actorUserId: member.user.id }),
            { code: 'reserved_username' }, username);
        await assert.rejects(updateUser(member.user.id, { username }, { actorId: owner.user.id }),
            { code: 'reserved_username' }, username);
    }
    assert.equal((await getUserById(member.user.id)).username, 'member');
    await runTool('userpersisto_profile_update', { username: 'member.renamed' }, { actorUserId: member.user.id });
    assert.equal((await getUserById(member.user.id)).username, 'member.renamed');
});

test('an account that already stores a reserved username can still save other fields while echoing it', async () => {
    const owner = await signUpWithPassword('owner@example.test');
    const legacy = await signUpWithPassword('legacy@example.test');
    const other = await signUpWithPassword('other@example.test');
    // Seed the pre-reservation state directly in the store.
    await (await getStore()).updateUser(legacy.user.id, { username: 'admin' });
    const echoed = await updateUser(legacy.user.id, { username: 'admin', displayName: 'Legacy' }, { actorId: owner.user.id });
    assert.deepEqual([echoed.username, echoed.displayName], ['admin', 'Legacy']);
    const blocked = await updateUser(legacy.user.id, { username: 'admin', status: 'blocked' }, { actorId: owner.user.id });
    assert.deepEqual([blocked.username, blocked.status], ['admin', 'blocked']);
    // Renaming anyone else to a reserved value is still rejected.
    for (const username of ['admin', 'Admin']) {
        await assert.rejects(updateUser(other.user.id, { username }, { actorId: owner.user.id }), { code: 'reserved_username' });
    }
    assert.equal((await getUserById(other.user.id)).username, 'other');
});
