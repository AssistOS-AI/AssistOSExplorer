import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ensureSeedData } from '../lib/bootstrap.mjs';
import { getStore, resetStoreForTests } from '../lib/store.mjs';
import { listUsers, setUserRoles } from '../lib/users.mjs';

test('user search filters before pagination, counts globally, and preserves private fields', async () => {
    const folder = await mkdtemp(join(tmpdir(), 'userpersisto-search-'));
    process.env.PERSISTENCE_FOLDER = folder;
    process.env.USERPERSISTO_SETTINGS_KEY = 'test-user-search-settings';
    try {
        await ensureSeedData();
        const store = await getStore();
        const roles = Object.fromEntries(await Promise.all(['admin', 'user', 'selfRegistered'].map(async name =>
            [name, await store.getRoleByName(name)])));
        const users = [];
        for (let index = 0; index < 603; index++) {
            const user = await store.createUser({
                email: `reader-${index}@example.test`, username: `handle-${index}`,
                displayName: index === 600 ? 'Ștefan Late Reader' : `Reader ${index}`,
                status: 'active', createdAt: new Date(index * 1000).toISOString(),
                passwordHash: 'private-hash', loginAttempts: 7, lastLoginAttempt: 'private-time',
            });
            const names = index === 0 ? ['admin'] : index === 602 ? ['user', 'selfRegistered'] : ['selfRegistered'];
            for (const name of names) {
                await store.createUserRole({ key: `${user.id}:${roles[name].id}`, userId: user.id, roleId: roles[name].id });
            }
            users.push(user);
        }
        const defaults = await listUsers({ excludeOnlyRole: 'selfRegistered', includeRoleCounts: true });
        assert.deepEqual(defaults.users.map(user => user.id), [users[0].id, users[602].id]);
        assert.equal(defaults.totalCount, 2);
        assert.equal(defaults.singleRoleCounts.selfRegistered, 601);
        for (const search of [' READER-600@EXAMPLE.TEST ', 'HANDLE-600', 'ȘTEFAN', users[600].id]) {
            const result = await listUsers({ search, includeRoleCounts: true });
            assert.deepEqual(result.users.map(user => user.id), [users[600].id], search);
            assert.equal(result.totalCount, 1);
            assert.equal(result.singleRoleCounts.selfRegistered, 601);
            for (const key of ['passwordHash', 'loginAttempts', 'lastLoginAttempt']) {
                assert.equal(Object.hasOwn(result.users[0], key), false);
            }
        }
        const page = await listUsers({ search: 'reader-60', start: 2, pageSize: 2 });
        assert.equal(page.totalCount, 4);
        assert.deepEqual(page.users.map(user => user.id), [users[601].id, users[602].id]);
        assert.equal(Object.hasOwn(page, 'singleRoleCounts'), false);
        const absent = await listUsers({ search: 'missing', includeRoleCounts: true });
        assert.deepEqual(absent.users, []);
        assert.equal(absent.totalCount, 0);
        assert.equal(absent.singleRoleCounts.selfRegistered, 601);
        assert.deepEqual((await listUsers({ search: 'reader-600', start: 1 })).users, []);
        assert.equal((await listUsers()).totalCount, 603);
        await setUserRoles(users[600].id, ['user']);
        const promoted = await listUsers({ excludeOnlyRole: 'selfRegistered', includeRoleCounts: true });
        assert.equal(promoted.totalCount, 3);
        assert.equal(promoted.singleRoleCounts.selfRegistered, 600);
        for (const filters of [{ search: null }, { search: 'x'.repeat(201) }, { excludeOnlyRole: 'x'.repeat(129) }, { includeRoleCounts: 'true' }]) {
            await assert.rejects(listUsers(filters), error => error.code === 'invalid_user_filter');
        }
    } finally {
        await resetStoreForTests();
        await rm(folder, { recursive: true, force: true });
    }
});
