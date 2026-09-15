import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.PERSISTENCE_FOLDER = mkdtempSync(join(tmpdir(), 'userpersisto-store-'));

const { getStore, resetStoreForTests, flush } = await import('../lib/store.mjs');

test('schema declares document models with unique indexes and groupings', async () => {
    const store = await getStore();
    const user = await store.createUser({ email: 'a@b.com', displayName: 'A', status: 'active', source: 'admin', createdAt: new Date().toISOString() });
    assert.ok(user.id);
    const byEmail = await store.getUserByEmail('a@b.com');
    assert.equal(byEmail.id, user.id);

    // unique index enforced
    await assert.rejects(() => store.createUser({ email: 'a@b.com', displayName: 'dup' }));

    const role = await store.createRole({ name: 'admin', description: 'Administrators', priority: 1 });
    await store.createUserRole({ key: `${user.id}:${role.id}`, userId: user.id, roleId: role.id });
    const links = await store.getUserRolesObjectsByUserId(user.id);
    assert.equal(links.length, 1);
    assert.equal(links[0].roleId, role.id);

    const tx = await store.createCreditTx({ txId: 'tx-1', userId: user.id, type: 'grant', amount: 10, reason: 'seed', referenceId: '', createdAt: new Date().toISOString() });
    assert.equal(tx.txId, 'tx-1');
    const history = await store.getCreditHistoryObjectsByUserId(user.id);
    assert.equal(history.length, 1);

    await flush();
    await resetStoreForTests();
});
