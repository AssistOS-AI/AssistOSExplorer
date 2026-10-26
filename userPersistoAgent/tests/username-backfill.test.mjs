import test, { beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ensureSeedData } from '../lib/bootstrap.mjs';
import { flush, getStore, resetStoreForTests, setStoreFaultInjectorForTests } from '../lib/store.mjs';
import { backfillUsernames, createUser, getUserById, updateUser } from '../lib/users.mjs';

let folder, environment;

beforeEach(async () => {
    environment = { ...process.env };
    folder = await mkdtemp(join(tmpdir(), 'userpersisto-username-backfill-'));
    process.env.PERSISTENCE_FOLDER = folder;
    process.env.USERPERSISTO_SETTINGS_KEY = 'username-backfill-fixture-settings';
    await ensureSeedData();
});

afterEach(async () => {
    await resetStoreForTests().catch(() => {});
    await rm(folder, { recursive: true, force: true });
    for (const name of Object.keys(process.env)) if (!Object.hasOwn(environment, name)) delete process.env[name];
    Object.assign(process.env, environment);
});

// A legacy account without a mailbox cannot be created through the domain API.
async function createEmaillessUser() {
    const store = await getStore();
    const timestamp = new Date().toISOString();
    const user = await store.createUser({
        email: '', username: '', displayName: '', contactEmail: '', status: 'active', source: 'legacy',
        createdAt: timestamp, updatedAt: timestamp, emailVerifiedAt: '', authGeneration: 0, loginAttempts: 0, lastLoginAttempt: '',
    });
    await flush();
    return user;
}

test('backfill fills empty usernames once, keeps chosen and cleared ones and skips accounts without email', async () => {
    const first = await createUser({ email: 'first@example.test', roles: ['user'] });
    const second = await createUser({ email: 'First@other.test', roles: ['user'] });
    const chosen = await createUser({ email: 'third@example.test', username: 'Chosen.Name', roles: ['user'] });
    const taken = await createUser({ email: 'chosen.name@example.test', roles: ['user'] });
    const noEmail = await createEmaillessUser();

    const run = await backfillUsernames();
    assert.deepEqual([run.skipped, run.updated, run.failed], [false, 3, 0]);
    assert.equal((await getUserById(first.id)).username, 'first');
    assert.equal((await getUserById(second.id)).username, 'first-2');
    assert.equal((await getUserById(chosen.id)).username, 'Chosen.Name');
    assert.equal((await getUserById(taken.id)).username, 'chosen.name-2');
    assert.equal((await getUserById(noEmail.id)).username, '');
    assert.ok(await (await getStore()).getSystemSettingByKey('users.usernameBackfill'));

    // A name cleared after the backfill stays cleared on the next start.
    await updateUser(first.id, { username: '' }, { actorId: first.id });
    const again = await backfillUsernames();
    assert.deepEqual([again.skipped, again.updated], [true, 0]);
    assert.equal((await getUserById(first.id)).username, '');
});

test('a per-user failure is logged with id and code only, never throws, and leaves the marker unset for a retry', async () => {
    const good = await createUser({ email: 'good@example.test', roles: ['user'] });
    const bad = await createUser({ email: 'secret.person@example.test', roles: ['user'] });
    const store = await getStore();
    setStoreFaultInjectorForTests(async (phase, name, args) => {
        if (phase === 'before' && name === 'updateUser' && args[0] === bad.id) {
            throw Object.assign(new Error('forced failure for secret.person@example.test'), { code: 'forced_failure' });
        }
    });
    const logged = [];
    const realError = console.error;
    console.error = (...args) => { logged.push(args.join(' ')); };
    let run;
    try {
        run = await backfillUsernames();
    } finally {
        console.error = realError;
        setStoreFaultInjectorForTests();
    }
    assert.deepEqual([run.updated, run.failed], [1, 1]);
    assert.equal((await getUserById(good.id)).username, 'good');
    assert.equal((await getUserById(bad.id)).username, '');
    assert.ok(!(await store.getSystemSettingByKey('users.usernameBackfill')));
    assert.equal(logged.length, 1);
    assert.match(logged[0], new RegExp(`${bad.id}.*forced_failure`));
    assert.doesNotMatch(logged[0], /secret\.person|@/);

    const retry = await backfillUsernames();
    assert.deepEqual([retry.skipped, retry.updated, retry.failed], [false, 1, 0]);
    assert.equal((await getUserById(bad.id)).username, 'secret.person');
    assert.ok(await store.getSystemSettingByKey('users.usernameBackfill'));
});

test('a username_taken failure is re-derived once with the next suffix', async () => {
    const user = await createUser({ email: 'dup@example.test', roles: ['user'] });
    let failures = 0;
    setStoreFaultInjectorForTests(async (phase, name, args) => {
        if (phase === 'before' && name === 'updateUser' && args[0] === user.id && failures++ === 0) {
            throw Object.assign(new Error('taken'), { code: 'username_taken' });
        }
    });
    let run;
    try {
        run = await backfillUsernames();
    } finally {
        setStoreFaultInjectorForTests();
    }
    assert.deepEqual([run.updated, run.failed], [1, 0]);
    assert.equal((await getUserById(user.id)).username, 'dup-2');
    assert.ok(await (await getStore()).getSystemSettingByKey('users.usernameBackfill'));
});
