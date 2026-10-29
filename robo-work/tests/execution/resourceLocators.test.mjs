import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';

import { RESOURCE_KINDS, deriveLocator, newLocatorId, sha256Hex } from '../../server/execution/resourceLocators.mjs';
import { LAYOUT, createLedgerRig } from './helpers/ledgerRig.mjs';
import { expectCode } from '../helpers/synthetic.mjs';

const ID = '00112233445566778899aabbccddeeff';
// SHA-256("00112233445566778899aabbccddeeff"), computed independently of the module under test.
const DIGEST = '5947d7c33d783f94b3b4c1a96ebc8991ed28f1b069b71e03376cba8caa98a720';

test('MODEL CHECK locators: the section 5.5 derivations, exactly', () => {
    const digest = crypto.createHash('sha256').update(ID).digest('hex');
    assert.equal(sha256Hex(ID), digest);
    assert.equal(digest, DIGEST);
    assert.equal(deriveLocator('nft-table', ID, LAYOUT).table, 'rw_5947d7c33d783f94');
    assert.equal(deriveLocator('veth', ID, LAYOUT).host, 'rw5947d7c33dh');
    assert.deepEqual(deriveLocator('runtime-dir', ID, LAYOUT), { path: `/run/robo-work/runtime/x/${ID}` });
    assert.deepEqual(deriveLocator('cgroup', ID, LAYOUT), { path: `/sys/fs/cgroup/robo-work/x-${ID}` });
    assert.deepEqual(deriveLocator('nft-table', ID, LAYOUT), { table: `rw_${digest.slice(0, 16)}` });
    assert.match(deriveLocator('nft-table', ID, LAYOUT).table, /^rw_[0-9a-f]{16}$/u);
    assert.deepEqual(deriveLocator('veth', ID, LAYOUT), { host: `rw${digest.slice(0, 10)}h`, peer: `rw${digest.slice(0, 10)}n` });
    assert.match(deriveLocator('veth', ID, LAYOUT).host, /^rw[0-9a-f]{10}h$/u);
    assert.deepEqual(deriveLocator('gui-view', ID, LAYOUT, { grant: 'g1' }), { mountpoint: `/run/robo-work/runtime/gui/${ID}/g1` });
    assert.equal(deriveLocator('gui-container', ID, LAYOUT).name, `rw-gui-${ID}`);
    assert.deepEqual(deriveLocator('endpoint', ID, LAYOUT), { role: 'endpoint', id: ID });
});

test('MODEL CHECK locators: a locator needs a known kind, a 128-bit id and normalized layout paths', () => {
    assert.throws(() => deriveLocator('socket', ID, LAYOUT), /Unknown resource kind/u);
    for (const bad of ['', 'ABCDEF', 'x'.repeat(32), ID.slice(1), `${ID}0`]) assert.throws(() => deriveLocator('netns', bad, LAYOUT), /32 lowercase hex/u);
    for (const runtimeDir of ['relative', '/a/../b', '/a/./b', '/a/']) assert.throws(() => deriveLocator('runtime-dir', ID, { ...LAYOUT, runtimeDir }), /normalized absolute/u);
    assert.notEqual(newLocatorId(), newLocatorId());
    for (const kind of RESOURCE_KINDS) assert.ok(deriveLocator(kind, ID, LAYOUT), kind);
});

test('MODEL CHECK locators: the ledger records the derived locator durably, and a retired locator is never reserved twice', async (t) => {
    const rig = await createLedgerRig(t);
    const ids = ['a'.repeat(32), 'b'.repeat(32), 'b'.repeat(32)];
    let next = 0;
    const ledger = rig.ledger({ newLocatorId: () => ids[next++] });
    const keeper = await ledger.publish({ kind: 'keeper' });
    const dir = await ledger.publish({ kind: 'runtime-dir' });
    // Every dependent also records the keeper's reservation ID, so the keeper's record can always be found again.
    const derived = { ...deriveLocator('runtime-dir', ids[1], LAYOUT), keeper: keeper.resourceId };
    assert.deepEqual(rig.store.getResource({ resourceId: dir.resourceId }).locator, derived);
    assert.equal('keeper' in rig.store.getResource({ resourceId: keeper.resourceId }).locator, false);
    // The same id again for the same kind is the same locator, which S1 never reserves twice.
    await assert.rejects(ledger.publish({ kind: 'runtime-dir' }), (error) => error.code === 'operation_conflict');
    // A different kind sharing the id is a different resource.
    assert.doesNotThrow(() => rig.store.reserveResource({ kind: 'cgroup', locator: { ...deriveLocator('cgroup', ids[1], LAYOUT), keeper: keeper.resourceId }, robotId: rig.robotId }));
    expectCode(assert, () => rig.store.reserveResource({ kind: 'runtime-dir', locator: derived, robotId: rig.robotId }), 'operation_conflict');
});
