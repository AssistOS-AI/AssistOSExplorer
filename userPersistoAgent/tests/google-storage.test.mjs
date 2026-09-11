import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { getStore, flush, resetStoreForTests, setStoreFaultInjectorForTests } from '../lib/store.mjs';
import { SNAPSHOT_FILE, createDurableStorage, setDurableStorageFaultInjectorForTests } from '../lib/durable-storage.mjs';
import { TYPES } from '../lib/schema.mjs';
import { ensureSeedData } from '../lib/bootstrap.mjs';
import { createUser, getUserByEmail, getUserRoles } from '../lib/users.mjs';
import { completeGoogleIdentity, GOOGLE_ISSUER } from '../lib/externalIdentities.mjs';
import { createGoogleTransaction, readGoogleTransaction, transitionGoogleTransaction, prepareGoogleTransactionTransition, hashGoogleState } from '../lib/auth/googleTransactions.mjs';

let folder;
const random = () => randomBytes(32).toString('base64url');
const external = { issuer: GOOGLE_ISSUER, subject: 'new-subject', email: 'fresh@gmail.com', emailVerified: true };
const stateOptions = (transaction) => ({ browserProof: transaction.browserProof, configFingerprint: 'configured-client-callback' });

async function fixture() {
    folder = await mkdtemp(join(tmpdir(), 'userpersisto-google-storage-'));
    process.env.PERSISTENCE_FOLDER = folder;
    process.env.USERPERSISTO_SETTINGS_KEY = 'isolated-google-storage-test-key';
    process.env.USERPERSISTO_AUTH_METHODS = 'password,google';
    await ensureSeedData();
    await createUser({ email: 'owner@example.test', roles: ['admin'], password: 'owner-password' });
}

async function transaction({ parentId = random(), expiresAt = Date.now() + 60000 } = {}) {
    const state = random();
    const browserProof = random();
    const record = await createGoogleTransaction({
        state, browserProof, expiresAt, configFingerprint: 'configured-client-callback',
        payload: {
            flow: 'explorer', verifier: random(), nonce: random(), csrf: random(),
            config: { clientId: 'fixture', redirectUri: 'http://127.0.0.1:18080/service/auth/google/callback' },
            parent: { requestId: parentId, state: random(), redirectUri: '/auth/callback', origin: 'http://127.0.0.1:18080', expiresAt },
        },
    });
    return { ...record, state, browserProof };
}

async function verify(transaction) {
    await transitionGoogleTransaction(transaction.handle, stateOptions(transaction), { from: 'pending', to: 'exchanging' });
    return transitionGoogleTransaction(transaction.handle, stateOptions(transaction), { from: 'exchanging', to: 'verified', patch: { identity: external } });
}

afterEach(async () => {
    setStoreFaultInjectorForTests();
    setDurableStorageFaultInjectorForTests();
    await resetStoreForTests().catch(() => {});
    if (folder) await rm(folder, { recursive: true, force: true });
    delete process.env.USERPERSISTO_AUTH_METHODS;
});

test('pending transactions are encrypted, independent of OIDC storage, and browser-bound across restart', async () => {
    await fixture();
    const tx = await transaction();
    const snapshot = await readFile(join(folder, SNAPSHOT_FILE), 'utf8');
    for (const secret of [tx.state, tx.browserProof, tx.payload.verifier, tx.payload.nonce, tx.payload.parent.state]) assert.equal(snapshot.includes(secret), false);
    assert.equal((await (await getStore()).select('oidcRecord')).objects.length, 0);
    await resetStoreForTests();
    const reopened = await readGoogleTransaction(tx.handle, stateOptions(tx));
    assert.equal(reopened.payload.parent.requestId, tx.payload.parent.requestId);
    assert.equal(reopened.expiresAt, tx.expiresAt);
    assert.equal(hashGoogleState(tx.state), tx.handle);
    await assert.rejects(readGoogleTransaction(tx.handle, { ...stateOptions(tx), browserProof: random() }), { code: 'google_transaction_invalid' });
    assert.equal((await readGoogleTransaction(tx.handle, stateOptions(tx))).status, 'pending');
    await assert.rejects(readGoogleTransaction(tx.handle, { ...stateOptions(tx), configFingerprint: 'changed-config' }), { code: 'google_transaction_invalid' });
    assert.equal((await readGoogleTransaction(tx.handle, stateOptions(tx))).status, 'pending');
});

test('exchange claims are one-shot, verified data survives restart and consumed tombstones erase secrets', async () => {
    await fixture();
    const tx = await transaction();
    const claims = await Promise.allSettled([1, 2].map(() => transitionGoogleTransaction(tx.handle, stateOptions(tx), { from: 'pending', to: 'exchanging' })));
    assert.equal(claims.filter((entry) => entry.status === 'fulfilled').length, 1);
    await resetStoreForTests();
    await assert.rejects(transitionGoogleTransaction(tx.handle, stateOptions(tx), { from: 'pending', to: 'exchanging' }), { code: 'google_transaction_invalid' });
    const verified = await transitionGoogleTransaction(tx.handle, stateOptions(tx), { from: 'exchanging', to: 'verified', patch: { identity: external } });
    assert.equal(verified.payload.verifier, undefined);
    assert.equal(verified.payload.nonce, undefined);
    await resetStoreForTests();
    assert.equal((await readGoogleTransaction(tx.handle, stateOptions(tx))).payload.identity.subject, external.subject);
    await transitionGoogleTransaction(tx.handle, stateOptions(tx), { from: 'verified', to: 'consumed' });
    const raw = await (await getStore()).getGoogleAuthTransactionByStateHash(tx.handle);
    assert.equal(raw.payload, '');
    assert.equal(raw.status, 'consumed');
    assert.equal(raw.expiresAt, tx.expiresAt);
    await resetStoreForTests();
    await assert.rejects(readGoogleTransaction(tx.handle, stateOptions(tx)), { code: 'google_transaction_invalid' });
});

test('cancelled attempts cannot consume another tab and bounded expiry removes abandoned records', async () => {
    await fixture();
    const first = await transaction();
    const second = await transaction();
    await assert.rejects(transitionGoogleTransaction(first.handle, stateOptions(second), { from: 'pending', to: 'cancelled' }), { code: 'google_transaction_invalid' });
    await transitionGoogleTransaction(first.handle, stateOptions(first), { from: 'pending', to: 'cancelled' });
    assert.equal((await readGoogleTransaction(second.handle, stateOptions(second))).status, 'pending');
    const raw = await (await getStore()).getGoogleAuthTransactionByStateHash(first.handle);
    await (await getStore()).updateGoogleAuthTransaction(raw.id, { expiresAt: Date.now() - 1 });
    await flush();
    await assert.rejects(readGoogleTransaction(first.handle, stateOptions(first)), { code: 'google_transaction_invalid' });
    assert.equal(await (await getStore()).getGoogleAuthTransactionByStateHash(first.handle), undefined);
});

test('per-parent issuance bound permits three independent tabs and stale encryption keys fail closed', async () => {
    await fixture();
    const parentId = random();
    const attempts = await Promise.allSettled(Array.from({ length: 4 }, () => transaction({ parentId })));
    assert.equal(attempts.filter((entry) => entry.status === 'fulfilled').length, 3);
    assert.equal(attempts.find((entry) => entry.status === 'rejected').reason.code, 'google_transaction_limit');
    const tx = attempts[0].value;
    await resetStoreForTests();
    process.env.USERPERSISTO_SETTINGS_KEY = 'wrong-retained-key';
    await assert.rejects(readGoogleTransaction(tx.handle, stateOptions(tx)), { code: 'oidc_storage_decryption_failed' });
    process.env.USERPERSISTO_SETTINGS_KEY = 'isolated-google-storage-test-key';
    assert.equal((await readGoogleTransaction(tx.handle, stateOptions(tx))).status, 'pending');
});

test('identity completion uses one snapshot for user, role, binding, audit and terminal state', async () => {
    await fixture();
    const tx = await transaction();
    await verify(tx);
    let saves = 0;
    setStoreFaultInjectorForTests((phase, operation) => {
        if (phase === 'before' && operation === 'forceSave') saves += 1;
    });
    const created = await completeGoogleIdentity({
        identity: external, transactionId: tx.handle,
        prepareCompletion: () => prepareGoogleTransactionTransition(tx.handle, stateOptions(tx), { from: 'verified', to: 'consumed' }),
    });
    assert.equal(saves, 1);
    setStoreFaultInjectorForTests();
    const records = Object.values(JSON.parse(JSON.parse(await readFile(join(folder, SNAPSHOT_FILE), 'utf8')).payload));
    assert.ok(records.some((record) => record.id === created.user.id));
    assert.ok(records.some((record) => record.userId === created.user.id && record.roleId));
    assert.ok(records.some((record) => record.userId === created.user.id && record.subject === external.subject));
    assert.ok(records.some((record) => record.target === created.user.id && record.action === 'auth.google.link'));
    assert.ok(records.some((record) => record.stateHash === tx.handle && record.status === 'consumed' && record.payload === ''));
    const returning = await transaction();
    await verify(returning);
    await completeGoogleIdentity({
        identity: external, transactionId: returning.handle,
        prepareCompletion: () => prepareGoogleTransactionTransition(returning.handle, stateOptions(returning), { from: 'verified', to: 'consumed' }),
    });
    await assert.rejects(readGoogleTransaction(returning.handle, stateOptions(returning)), { code: 'google_transaction_invalid' });
});

for (const failurePoint of ['createUser', 'createUserRole', 'createAuditEvent:user.create', 'createExternalIdentity', 'createAuditEvent:auth.google.link', 'updateGoogleAuthTransaction']) {
    test(`staging failure after ${failurePoint} poisons cached access and restart sees no partial identity`, async () => {
        await fixture();
        const tx = await transaction();
        await verify(tx);
        setStoreFaultInjectorForTests((phase, operation, args) => {
            const actual = operation === 'createAuditEvent' ? `${operation}:${args[0].action}` : operation;
            if (phase === 'after' && actual === failurePoint) throw new Error('injected staged-write failure');
        });
        await assert.rejects(completeGoogleIdentity({
            identity: external, transactionId: tx.handle,
            prepareCompletion: () => prepareGoogleTransactionTransition(tx.handle, stateOptions(tx), { from: 'verified', to: 'consumed' }),
        }), { code: 'persistence_unavailable' });
        setStoreFaultInjectorForTests();
        await assert.rejects(getUserByEmail(external.email), { code: 'persistence_unavailable' });
        await assert.rejects(flush(), { code: 'persistence_unavailable' });
        await resetStoreForTests();
        assert.equal(await getUserByEmail(external.email), null);
        assert.equal((await (await getStore()).select('externalIdentity')).objects.length, 0);
        assert.equal((await readGoogleTransaction(tx.handle, stateOptions(tx))).status, 'verified');
    });
}

for (const failurePoint of ['before-snapshot-write', 'before-snapshot-rename', 'after-snapshot-rename']) {
    test(`snapshot failure at ${failurePoint} never acknowledges success and preserves complete-or-absent state`, async () => {
        await fixture();
        const tx = await transaction();
        await verify(tx);
        setDurableStorageFaultInjectorForTests((point) => {
            if (point === failurePoint) throw new Error('injected snapshot failure');
        });
        await assert.rejects(completeGoogleIdentity({
            identity: external, transactionId: tx.handle,
            prepareCompletion: () => prepareGoogleTransactionTransition(tx.handle, stateOptions(tx), { from: 'verified', to: 'consumed' }),
        }), { code: 'persistence_unavailable' });
        setDurableStorageFaultInjectorForTests();
        await assert.rejects(getUserByEmail(external.email), { code: 'persistence_unavailable' });
        await resetStoreForTests();
        const user = await getUserByEmail(external.email);
        if (failurePoint === 'after-snapshot-rename') {
            assert.ok(user);
            assert.deepEqual(await getUserRoles(user.id), ['selfRegistered']);
            assert.equal((await (await getStore()).getExternalIdentitiesObjectsByUserId(user.id)).length, 1);
            await assert.rejects(readGoogleTransaction(tx.handle, stateOptions(tx)), { code: 'google_transaction_invalid' });
            assert.equal((await completeGoogleIdentity({ identity: external, transactionId: 'fresh-attempt' })).user.id, user.id);
        } else {
            assert.equal(user, null);
            assert.equal((await (await getStore()).select('externalIdentity')).objects.length, 0);
            assert.equal((await readGoogleTransaction(tx.handle, stateOptions(tx))).status, 'verified');
        }
    });
}

test('independent child process resumes a durable pending transaction without replacing local users', async () => {
    await fixture();
    const tx = await transaction();
    await resetStoreForTests();
    const script = `
        const { readGoogleTransaction, transitionGoogleTransaction } = await import(${JSON.stringify(new URL('../lib/auth/googleTransactions.mjs', import.meta.url).href)});
        const { resetStoreForTests } = await import(${JSON.stringify(new URL('../lib/store.mjs', import.meta.url).href)});
        const tx = await readGoogleTransaction(${JSON.stringify(tx.handle)}, ${JSON.stringify(stateOptions(tx))});
        if (tx.status !== 'pending') process.exit(2);
        await transitionGoogleTransaction(tx.handle, ${JSON.stringify(stateOptions(tx))}, {from:'pending',to:'exchanging'});
        await resetStoreForTests();
    `;
    const child = spawnSync(process.execPath, ['--input-type=module', '--eval', script], { env: { ...process.env }, encoding: 'utf8', timeout: 10000 });
    assert.equal(child.status, 0, child.stderr);
    assert.equal((await readGoogleTransaction(tx.handle, stateOptions(tx))).status, 'exchanging');
    assert.ok(await getUserByEmail('owner@example.test'));
});

for (const failurePoint of ['after-role-stage', 'after-snapshot-rename']) {
    test(`process exit at ${failurePoint} reopens only an absent or complete identity and terminal transaction`, async () => {
        await fixture();
        const tx = await transaction();
        await verify(tx);
        await resetStoreForTests();
        const script = `
            const { prepareGoogleTransactionTransition } = await import(${JSON.stringify(new URL('../lib/auth/googleTransactions.mjs', import.meta.url).href)});
            const { completeGoogleIdentity } = await import(${JSON.stringify(new URL('../lib/externalIdentities.mjs', import.meta.url).href)});
            const { setStoreFaultInjectorForTests } = await import(${JSON.stringify(new URL('../lib/store.mjs', import.meta.url).href)});
            const { setDurableStorageFaultInjectorForTests } = await import(${JSON.stringify(new URL('../lib/durable-storage.mjs', import.meta.url).href)});
            if (${JSON.stringify(failurePoint)} === 'after-role-stage') {
                setStoreFaultInjectorForTests((phase, operation) => {
                    if (phase === 'after' && operation === 'createUserRole') process.exit(41);
                });
            } else {
                setDurableStorageFaultInjectorForTests((point) => {
                    if (point === 'after-snapshot-rename') process.exit(41);
                });
            }
            await completeGoogleIdentity({
                identity: ${JSON.stringify(external)}, transactionId: ${JSON.stringify(tx.handle)},
                prepareCompletion: () => prepareGoogleTransactionTransition(${JSON.stringify(tx.handle)}, ${JSON.stringify(stateOptions(tx))}, {from:'verified',to:'consumed'}),
            });
            process.exit(2);
        `;
        const child = spawnSync(process.execPath, ['--input-type=module', '--eval', script], { env: { ...process.env }, encoding: 'utf8', timeout: 10000 });
        assert.equal(child.status, 41, child.stderr);
        const user = await getUserByEmail(external.email);
        if (failurePoint === 'after-role-stage') {
            assert.equal(user, null);
            assert.equal((await (await getStore()).select('externalIdentity')).objects.length, 0);
            assert.equal((await readGoogleTransaction(tx.handle, stateOptions(tx))).status, 'verified');
        } else {
            assert.ok(user);
            assert.deepEqual(await getUserRoles(user.id), ['selfRegistered']);
            assert.equal((await (await getStore()).getExternalIdentitiesObjectsByUserId(user.id)).length, 1);
            await assert.rejects(readGoogleTransaction(tx.handle, stateOptions(tx)), { code: 'google_transaction_invalid' });
        }
    });
}

test('a snapshot written before Google types existed initializes new indexes without rewriting local identity', async () => {
    folder = await mkdtemp(join(tmpdir(), 'userpersisto-google-legacy-schema-'));
    process.env.PERSISTENCE_FOLDER = folder;
    const legacy = await createDurableStorage(folder);
    const { initialisePersisto } = createRequire(import.meta.url)('../vendor/Persisto/src/persistence/Persisto.cjs');
    globalThis.$$ ||= {};
    globalThis.$$.throwError ||= async (error) => { throw error; };
    const legacyStore = await initialisePersisto(legacy.storage, { smartLog: async () => {} });
    legacyStore.configureTypes(Object.fromEntries(Object.entries(TYPES).filter(([name]) => !['externalIdentity', 'googleAuthTransaction'].includes(name))));
    await legacyStore.createIndex('user', 'email');
    const original = await legacyStore.createUser({ email: 'legacy@example.test', status: 'active', passwordHash: 'retained-legacy-hash' });
    await legacyStore.forceSave();
    await legacyStore.shutDown();
    const reopened = await getStore();
    assert.deepEqual(await reopened.getUserByEmail(original.email), original);
    assert.equal((await reopened.select('externalIdentity')).objects.length, 0);
    assert.equal((await reopened.select('googleAuthTransaction')).objects.length, 0);
    assert.equal(typeof reopened.getExternalIdentitiesObjectsByUserId, 'function');
    await flush();
    await resetStoreForTests();
    assert.deepEqual(await (await getStore()).getUserByEmail(original.email), original);
});
