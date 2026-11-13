import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.PERSISTENCE_FOLDER = mkdtempSync(join(tmpdir(), 'userpersisto-credits-'));
process.env.USERPERSISTO_SETTINGS_KEY = 'test-settings-key';

const { ensureSeedData } = await import('../lib/bootstrap.mjs');
const { createUser } = await import('../lib/users.mjs');
const credits = await import('../lib/credits.mjs');
const { getStore, flush, resetStoreForTests } = await import('../lib/store.mjs');

after(async () => {
    await resetStoreForTests();
});

test('grant -> reserve -> commit/release cycle with immutable ledger', async () => {
    await ensureSeedData();
    const user = await createUser({ email: 'cr@x.com', displayName: 'CR', roles: ['user'] });

    await credits.grant({ userId: user.id, amount: 100, reason: 'welcome', referenceId: 'grant:welcome', actorId: 'system' });
    assert.deepEqual(await credits.getBalance(user.id), { balance: 100, reservedBalance: 0 });

    await credits.reserve({ userId: user.id, amount: 30, reason: 'job-1', referenceId: 'job-1' });
    assert.deepEqual(await credits.getBalance(user.id), { balance: 70, reservedBalance: 30 });

    await credits.commit({ userId: user.id, amount: 30, referenceId: 'job-1' });
    await credits.reserve({ userId: user.id, amount: 10, reason: 'job-2', referenceId: 'job-2' });
    await credits.release({ userId: user.id, amount: 10, referenceId: 'job-2' });
    assert.deepEqual(await credits.getBalance(user.id), { balance: 70, reservedBalance: 0 });

    await credits.refund({ userId: user.id, amount: 5, reason: 'goodwill', referenceId: 'job-1', actorId: 'admin-1' });
    const { balance } = await credits.getBalance(user.id);
    assert.equal(balance, 75);

    const { entries, totalCount } = await credits.ledger({ userId: user.id });
    assert.equal(totalCount, 6);
    const derivedBalance = entries.reduce((acc, tx) => {
        if (['grant', 'purchase', 'refund', 'release'].includes(tx.type)) return acc + tx.amount;
        if (tx.type === 'reserve') return acc - tx.amount;
        return acc;
    }, 0);
    const derivedReserved = entries.reduce((acc, tx) => {
        if (tx.type === 'reserve') return acc + tx.amount;
        if (tx.type === 'spend' || tx.type === 'release') return acc - tx.amount;
        return acc;
    }, 0);
    assert.deepEqual({ balance: derivedBalance, reservedBalance: derivedReserved }, await credits.getBalance(user.id));
    assert.ok(entries.every((tx) => tx.createdAt && tx.txId));
});

test('overdraw and over-commit are rejected', async () => {
    const user = await createUser({ email: 'cr2@x.com', displayName: 'CR2', roles: ['user'] });
    await credits.grant({ userId: user.id, amount: 10, reason: 'seed', referenceId: 'grant:seed', actorId: 'system' });
    await assert.rejects(() => credits.reserve({ userId: user.id, amount: 11, reason: 'x', referenceId: 'r' }), /insufficient/i);
    await credits.reserve({ userId: user.id, amount: 10, reason: 'x', referenceId: 'r' });
    await assert.rejects(() => credits.commit({ userId: user.id, amount: 11, referenceId: 'r' }), /insufficient/i);
});

test('concurrent retries with one reference create exactly one transaction', async () => {
    const user = await createUser({ email: 'idem@x.com', displayName: 'Idempotent', roles: ['user'] });
    const outcomes = await Promise.all(Array.from({ length: 20 }, () => credits.grant({
        userId: user.id,
        amount: 7,
        reason: 'concurrent grant',
        referenceId: 'grant:idem-1',
        actorId: 'system',
    })));
    assert.equal(outcomes.filter((outcome) => outcome.idempotent === false).length, 1);
    assert.equal((await credits.getBalance(user.id)).balance, 7);
    assert.equal((await credits.ledger({ userId: user.id })).totalCount, 1);
    await assert.rejects(
        () => credits.grant({ userId: user.id, amount: 8, referenceId: 'grant:idem-1' }),
        /different transaction data/i
    );
});

test('balance and ledger queries reject unknown users without creating accounts', async () => {
    await assert.rejects(
        () => credits.getBalance('missing-user'),
        (error) => error?.code === 'user_not_found'
    );
    await assert.rejects(
        () => credits.ledger({ userId: 'missing-user' }),
        (error) => error?.code === 'user_not_found'
    );
});

test('every credit mutation requires a stable business reference', async () => {
    const user = await createUser({ email: 'reference@x.com', roles: ['user'] });
    await assert.rejects(
        () => credits.grant({ userId: user.id, amount: 1 }),
        (error) => error?.code === 'reference_id_required'
    );
    await assert.rejects(
        () => credits.adminAdjust({ userId: user.id, amount: 1 }),
        (error) => error?.code === 'reference_id_required'
    );
});

test('different users concurrently reserve and release the same reference independently', async () => {
    const users = await Promise.all(['scope-a', 'scope-b'].map((name) => createUser({ email: `${name}@example.test`, roles: ['user'] })));
    await Promise.all(users.map((user) => credits.grant({ userId: user.id, amount: 20, referenceId: 'same-grant' })));
    const outcomes = await Promise.all(users.map((user) => credits.reserve({ userId: user.id, amount: 7, referenceId: 'same-job' })));
    assert.ok(outcomes.every((outcome) => !outcome.idempotent));
    await resetStoreForTests();
    for (const user of users) assert.deepEqual(await credits.getBalance(user.id), { balance: 13, reservedBalance: 7 });
    await Promise.all(users.map((user) => credits.release({ userId: user.id, amount: 7, referenceId: 'same-job' })));
    for (const user of users) assert.deepEqual(await credits.getBalance(user.id), { balance: 20, reservedBalance: 0 });
});

test('reservation projections rebuild from their journal without reopening terminal reservations', async () => {
    const [owner, stranded] = await Promise.all(['projection-owner', 'projection-missing'].map((name) => createUser({ email: `${name}@example.test`, roles: ['user'] })));
    for (const user of [owner, stranded]) {
        await credits.grant({ userId: user.id, amount: 20, referenceId: 'seed' });
        await credits.reserve({ userId: user.id, amount: 7, referenceId: 'shared-reference' });
    }
    let store = await getStore();
    const ownerReservation = (await store.getCreditReservationsObjectsByUserId(owner.id))[0];
    await store.deleteCreditReservation(ownerReservation.id);
    const strandedReservation = (await store.getCreditReservationsObjectsByUserId(stranded.id))[0];
    await store.deleteCreditReservation(strandedReservation.id);
    await flush();
    await resetStoreForTests();

    assert.equal((await credits.reserve({ userId: stranded.id, amount: 7, referenceId: 'shared-reference' })).idempotent, true);
    await credits.release({ userId: stranded.id, amount: 7, referenceId: 'shared-reference' });
    await credits.commit({ userId: owner.id, amount: 7, referenceId: 'shared-reference' });
    assert.deepEqual(await credits.getBalance(stranded.id), { balance: 20, reservedBalance: 0 });
    assert.deepEqual(await credits.getBalance(owner.id), { balance: 13, reservedBalance: 0 });

    store = await getStore();
    await store.deleteCreditReservation((await store.getCreditReservationsObjectsByUserId(stranded.id))[0].id);
    await flush();
    await resetStoreForTests();
    await credits.reserve({ userId: stranded.id, amount: 7, referenceId: 'shared-reference' });
    store = await getStore();
    assert.equal((await store.getCreditReservationsObjectsByUserId(stranded.id))[0].status, 'released');
    await assert.rejects(credits.commit({ userId: stranded.id, amount: 7, referenceId: 'shared-reference' }));
    assert.equal((await credits.ledger({ userId: stranded.id })).totalCount, 3);
});

test('expiring rewards are spent first and a late refund preserves the original expiry', async (t) => {
    const user = await createUser({ email: 'expiring@x.com', displayName: 'Expiry', roles: ['user'] });
    const before = new Date('2030-01-01T00:00:00.000Z');
    const afterExpiry = new Date('2030-02-02T00:00:00.000Z');
    t.mock.timers.enable({ apis: ['Date'], now: before });
    const userId = user.id;
    await credits.applyPurchase({ userId, amount: 20, referenceId: 'paid' });
    const award = { userId, amount: 12, referenceId: 'reward', expiresAt: '2030-02-01T00:00:00.000Z' };
    await credits.grant(award);
    const reservation = { userId, amount: 7, referenceId: 'edition-one' };
    await credits.reserve(reservation);
    await credits.commit(reservation);
    assert.deepEqual(await credits.getBalance(userId, { includeExpiring: true }), {
        balance: 25, reservedBalance: 0, expiring: [{ amount: 5, expiresAt: award.expiresAt }],
    });
    t.mock.timers.setTime(afterExpiry.getTime());
    const {getProfile} = await import('../lib/authorization.mjs');
    assert.deepEqual((await getProfile(userId)).credits, { balance: 20, reservedBalance: 0 });
    assert.deepEqual(await credits.getBalance(userId), { balance: 20, reservedBalance: 0 });
    await credits.refundSpend(reservation);
    assert.equal((await credits.refundSpend(reservation)).idempotent, true);
    assert.deepEqual(await credits.getBalance(userId), { balance: 20, reservedBalance: 0 });
    const { entries } = await credits.ledger({ userId });
    assert.deepEqual(entries.filter(entry=>entry.type==='expire').map(entry=>entry.amount), [7,5]);
    assert.equal((await credits.grant(award)).idempotent, true);
});
