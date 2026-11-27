import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getStore, resetStoreForTests, setStoreFaultInjectorForTests } from '../lib/store.mjs';
import { createUser, updateUser, getUserById, getUserRoles } from '../lib/users.mjs';

let folder;
async function fixture() {
    folder = await mkdtemp(join(tmpdir(), 'user-combined-update-'));
    process.env.PERSISTENCE_FOLDER = folder;
    const store = await getStore();
    for (const name of ['admin', 'user', 'reviewer']) await store.createRole({ name });
    return createUser({ email: 'member@example.test', displayName: 'Original', roles: ['user'] });
}

afterEach(async () => {
    setStoreFaultInjectorForTests(null);
    await resetStoreForTests();
    if (folder) await rm(folder, { recursive: true, force: true });
});

test('one save persists details, status and roles together across restart', async () => {
    const user = await fixture();
    const saved = await updateUser(user.id, { username: 'reviewer', displayName: 'Updated', status: 'blocked', roles: ['reviewer'] });
    assert.equal(saved.displayName, 'Updated');
    assert.deepEqual(saved.roles, ['reviewer']);
    await resetStoreForTests();
    assert.equal((await getUserById(user.id)).status, 'blocked');
    assert.equal((await getUserById(user.id)).username, 'reviewer');
    assert.deepEqual(await getUserRoles(user.id), ['reviewer']);
});

test('invalid roles or details never apply the other half of the edit', async () => {
    const user = await fixture();
    for (const roles of [[], ['unknown']]) {
        await assert.rejects(updateUser(user.id, { displayName: 'Unwanted', roles }));
        assert.equal((await getUserById(user.id)).displayName, 'Original');
    }
    await assert.rejects(updateUser(user.id, { username: '!', roles: ['reviewer'] }));
    assert.deepEqual(await getUserRoles(user.id), ['user']);
});

test('a combined save preserves the last active administrator', async () => {
    await fixture();
    const admin = await createUser({ email: 'admin@example.test', roles: ['admin'] });
    for (const patch of [{ status: 'blocked', roles: ['admin'] }, { roles: ['user'] }]) {
        await assert.rejects(updateUser(admin.id, { displayName: 'Unwanted', ...patch }), { code: 'last_admin_required' });
        assert.equal((await getUserById(admin.id)).displayName, '');
        assert.equal((await getUserById(admin.id)).status, 'active');
        assert.deepEqual(await getUserRoles(admin.id), ['admin']);
    }
});

test('storage failure cannot persist a partial combined edit', async () => {
    const user = await fixture();
    setStoreFaultInjectorForTests((phase, name) => {
        if (phase === 'after' && name === 'createUserRole') throw new Error('write failed');
    });
    await assert.rejects(updateUser(user.id, { displayName: 'Unwanted', roles: ['reviewer'] }));
    setStoreFaultInjectorForTests(null);
    await resetStoreForTests();
    assert.equal((await getUserById(user.id)).displayName, 'Original');
    assert.deepEqual(await getUserRoles(user.id), ['user']);
});
