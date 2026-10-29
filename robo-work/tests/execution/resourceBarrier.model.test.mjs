import assert from 'node:assert/strict';
import test from 'node:test';

import { LedgerError } from '../../server/execution/resourceLedger.mjs';
import { KeeperRefusal } from './helpers/modelKeeper.mjs';
import { InjectedCrash, createLedgerRig, crashAt, publishAll } from './helpers/ledgerRig.mjs';
import { expectCode } from '../helpers/synthetic.mjs';

// MODEL CHECKS of the section 5.5 publication barrier (Reserve, Create gated, Commit, gate release). They run the real
// S1 store, the real gate protocol and the real ledger against a model keeper and a model kernel. They are never A40 or
// G1 evidence: no kernel, namespace, signal or real gate pipe is involved.

// Records, per resource, where each barrier phase happens relative to the others and to the final exec.
function tracing(rig) {
    const events = [];
    const faults = {};
    for (const name of ['afterReserve', 'afterCreate', 'afterCommit', 'afterGateRelease']) {
        faults[name] = (info) => {
            const state = rig.store.getResource({ resourceId: info.resourceId });
            const process = rig.world.everSpawned().find((entry) => entry.marker === info.resourceId);
            events.push({ phase: name, kind: info.kind, state: state.state, identity: state.identity, executed: process?.executed ?? null, argv: process ? [...process.cmdline] : null, resourceId: info.resourceId });
            rig.events.push(`${name}:${info.kind}`);
        };
    }
    return { events, faults };
}

test('MODEL CHECK barrier: Reserve, Create gated, Commit, then gate release, with no final exec before the commit', async (t) => {
    const rig = await createLedgerRig(t);
    const { events, faults } = tracing(rig);
    const ledger = rig.ledger({ faults });
    await ledger.publish({ kind: 'keeper' });
    const keeper = events.filter((entry) => entry.kind === 'keeper');
    assert.deepEqual(keeper.map((entry) => entry.phase), ['afterReserve', 'afterCreate', 'afterCommit', 'afterGateRelease']);
    assert.deepEqual(keeper.map((entry) => entry.state), ['reserved', 'reserved', 'committed', 'committed']);
    assert.deepEqual(keeper.map((entry) => entry.executed), [null, false, false, true], 'the keeper runs its final exec only after the commit');
    assert.equal(keeper[1].identity, null, 'no identity is recorded before the commit');
    assert.ok(keeper[2].identity.pid > 0 && keeper[2].identity.startTime > 0, 'the commit wrote the identity tuple');
    // While gated, the reservation ID is in argv; after the final exec it is gone.
    const marker = keeper[0].resourceId;
    assert.ok(keeper[1].argv.includes(marker) && keeper[2].argv.includes(marker));
    assert.equal(keeper[3].argv.includes(marker), false);
    // The execution happened between the commit and the end of the gate release.
    const order = rig.events.filter((entry) => entry.includes('keeper'));
    assert.deepEqual(order, ['afterReserve:keeper', 'afterCreate:keeper', 'afterCommit:keeper', 'execute:keeper:committed', 'afterGateRelease:keeper']);
    assert.deepEqual(rig.violations, []);
});

test('MODEL CHECK barrier: a process-bearing reservation carries its reservation ID as the marker, other resources carry none', async (t) => {
    const rig = await createLedgerRig(t);
    const ledger = rig.ledger();
    const published = await publishAll(ledger);
    for (const entry of published) {
        const record = rig.store.getResource({ resourceId: entry.resourceId });
        if (['keeper', 'endpoint', 'process-tree'].includes(entry.kind)) {
            assert.equal(record.processBearing, true, entry.kind);
            assert.equal(record.locator.marker, entry.resourceId, `${entry.kind}: the marker is the reservation ID`);
        } else {
            assert.equal(record.processBearing, false, entry.kind);
            assert.equal('marker' in record.locator, false, entry.kind);
        }
        assert.equal(record.state, 'committed');
        assert.ok(Object.keys(record.identity).length > 0, `${entry.kind} has an identity tuple`);
    }
    assert.deepEqual(rig.violations, []);
});

test('MODEL CHECK barrier: the keeper is committed and released before anything else is reserved or created (R3-1)', async (t) => {
    const rig = await createLedgerRig(t);
    // The ledger refuses to publish anything else first, and records nothing for the refusal.
    const early = rig.ledger();
    await assert.rejects(early.publish({ kind: 'runtime-dir' }), (error) => error instanceof LedgerError && error.code === 'keeper_not_committed');
    assert.deepEqual(rig.blockers(), []);
    // While the keeper is committed but its gate is not yet released, the ledger still refuses.
    let attempted = null;
    const ledger = rig.ledger({
        faults: {
            afterCommit: async (info) => {
                if (info.kind !== 'keeper') return;
                attempted = await ledger.publish({ kind: 'runtime-dir' }).then(() => 'published', (error) => error.code);
            }
        }
    });
    await ledger.publish({ kind: 'keeper' });
    assert.equal(attempted, 'keeper_not_committed');
    // The model keeper enforces the same rule on its own: it creates nothing before its gate is committed.
    const fresh = await createLedgerRig(t);
    const gated = await fresh.keeper.create({ kind: 'keeper', resourceId: 'k', marker: 'k', locator: {} });
    await assert.rejects(fresh.keeper.create({ kind: 'runtime-dir', resourceId: 'r', marker: null, locator: { path: '/x' } }), (error) => error instanceof KeeperRefusal && error.code === 'keeper_not_released');
    await gated.gate.abort();
    // A second keeper in one execution is refused.
    await ledger.publish({ kind: 'runtime-dir' });
    await assert.rejects(ledger.publish({ kind: 'keeper' }), (error) => error.code === 'keeper_exists');
});

test('MODEL CHECK barrier: the identity is written once, at commit, and cannot be replaced', async (t) => {
    const rig = await createLedgerRig(t);
    const ledger = rig.ledger();
    const keeper = await ledger.publish({ kind: 'keeper' });
    const before = rig.store.getResource({ resourceId: keeper.resourceId }).identity;
    expectCode(assert, () => rig.store.commitResource({ resourceId: keeper.resourceId, identity: { pid: 1, startTime: 2 } }), 'operation_conflict');
    assert.deepEqual(rig.store.getResource({ resourceId: keeper.resourceId }).identity, before);
});

test('MODEL CHECK barrier: a commit that fails closes the gate, the helper aborts before its final exec, and the blocker stays unsettled until the keeper is proven gone', async (t) => {
    const rig = await createLedgerRig(t);
    const ledger = rig.ledger();
    await ledger.publish({ kind: 'keeper' });
    const real = rig.keeper.create.bind(rig.keeper);
    rig.keeper.create = async (request) => {
        const made = await real(request);
        return request.kind === 'endpoint' ? { ...made, identity: {} } : made; // S1 refuses an empty identity tuple
    };
    await assert.rejects(ledger.publish({ kind: 'endpoint' }), (error) => error.code === 'invalid_request');
    const endpoint = rig.world.everSpawned().find((entry) => entry.role === 'endpoint');
    assert.equal(endpoint.executed, false, 'the endpoint never ran its final exec');
    assert.equal(endpoint.state, 'dead', 'end-of-file on its gate aborted it');
    // Section 5.5: an uncommitted process-bearing reservation is absent only when its marker is gone AND the keeper's
    // identity is absent. The keeper is alive, so nothing is recorded released yet; the end path settles it.
    assert.deepEqual(rig.blockers().filter((entry) => entry.kind === 'endpoint').map((entry) => entry.state), ['reserved']);
    const ended = await ledger.endExecution({ classification: 'failed' });
    assert.ok(ended.releaseLog.every((entry) => entry.outcome === 'released'));
    assert.equal(ended.releaseLog.at(-1).kind, 'endpoint', 'settled after the keeper (step 6)');
    assert.deepEqual(rig.blockers(), []);
    assert.deepEqual(rig.violations, []);
});

test('MODEL CHECK barrier: a creation that fails after the process exists is found by its marker, killed, and settled once the keeper is gone', async (t) => {
    const rig = await createLedgerRig(t);
    const ledger = rig.ledger();
    await ledger.publish({ kind: 'keeper' });
    const real = rig.keeper.create.bind(rig.keeper);
    rig.keeper.create = async (request) => {
        const made = await real(request);
        if (request.kind === 'process-tree') throw new Error('keeper channel broke after the fork');
        return made;
    };
    await assert.rejects(ledger.publish({ kind: 'process-tree' }), /keeper channel broke/u);
    const tree = rig.world.everSpawned().find((entry) => entry.role === 'tree');
    assert.deepEqual([tree.executed, tree.state], [false, 'dead']);
    assert.equal(rig.blockers().filter((entry) => entry.kind === 'process-tree').length, 1, 'not recorded released on the strength of a live keeper');
    const ended = await ledger.endExecution({ classification: 'failed' });
    assert.ok(ended.releaseLog.every((entry) => entry.outcome === 'released'));
    assert.deepEqual(rig.blockers(), []);
    assert.deepEqual(rig.violations, []);
});

// Model of probes commitFails / P2b: the keeper created a namespace or mount, and the commit then failed. The reservation
// must never be recorded released while the namespace exists, and the model's truth hook must see every release.
for (const kind of ['netns', 'mount']) {
    test(`MODEL CHECK barrier: a commit that fails for a ${kind} is not recorded released while the keeper (whose abort does nothing) still holds it`, async (t) => {
        const rig = await createLedgerRig(t);
        const store = rig.store;
        const state = new Proxy(store, {
            get(target, name) {
                if (name === 'commitResource') {
                    return (request) => {
                        if (target.getResource({ resourceId: request.resourceId }).kind === kind) throw Object.assign(new Error('refused'), { code: 'operation_conflict' });
                        return target.commitResource(request);
                    };
                }
                const value = target[name];
                return typeof value === 'function' ? value.bind(target) : value;
            }
        });
        const ledger = rig.ledger({ state });
        for (const prerequisite of ['keeper', 'runtime-dir']) await ledger.publish({ kind: prerequisite });
        // A keeper whose abort does nothing (the probes' lying keeper): the namespace is still held when the commit fails.
        rig.keeper.abortUncommitted = async () => {};
        await assert.rejects(ledger.publish({ kind }), (error) => error.code === 'operation_conflict');
        const inode = kind === 'netns' ? rig.keeper.model.netns.at(-1) : rig.keeper.model.mntns.at(-1);
        assert.equal(rig.world.namespaceExists(inode), true, 'the keeper still holds it');
        assert.deepEqual(rig.blockers().filter((entry) => entry.kind === kind).map((entry) => entry.state), ['reserved'], 'left unsettled for the end path');
        assert.deepEqual(rig.violations, []);
        const ended = await ledger.endExecution({ classification: 'failed' });
        assert.equal(ended.releaseLog.find((entry) => entry.kind === kind).outcome, 'released');
        assert.equal(rig.world.namespaceExists(inode), false, 'released only after the keeper exited');
        assert.ok(ended.releaseLog.findIndex((entry) => entry.kind === kind) > ended.releaseLog.findIndex((entry) => entry.kind === 'keeper'), 'settled after the keeper');
        assert.deepEqual(rig.violations, []);
    });
}

test('MODEL CHECK barrier: a failed creation of a locator-named object is released at once, through the same hook the truth check watches', async (t) => {
    const rig = await createLedgerRig(t);
    const seen = [];
    const ledger = rig.ledger({ faults: { afterRelease: (info) => seen.push([info.kind, info.outcome]) } });
    await ledger.publish({ kind: 'keeper' });
    const real = rig.keeper.create.bind(rig.keeper);
    rig.keeper.create = async (request) => {
        const made = await real(request);
        return request.kind === 'runtime-dir' ? { ...made, identity: {} } : made;
    };
    await assert.rejects(ledger.publish({ kind: 'runtime-dir' }), (error) => error.code === 'invalid_request');
    assert.deepEqual(seen, [['runtime-dir', 'released']], 'the release went through afterRelease');
    assert.deepEqual(rig.blockers().filter((entry) => entry.kind === 'runtime-dir'), []);
    assert.equal(rig.world.residue().runtimeDirs.length, 0, 'the object was removed');
    // Negative control: a keeper whose abort does nothing leaves the object, so the release cannot be proven and is not recorded.
    const stubborn = await createLedgerRig(t);
    stubborn.keeper.abortUncommitted = async () => {};
    stubborn.world.view.remove = () => false;
    const second = stubborn.ledger();
    await second.publish({ kind: 'keeper' });
    const made = stubborn.keeper.create.bind(stubborn.keeper);
    stubborn.keeper.create = async (request) => {
        const result = await made(request);
        return request.kind === 'runtime-dir' ? { ...result, identity: {} } : result;
    };
    await assert.rejects(second.publish({ kind: 'runtime-dir' }), () => true);
    assert.equal(stubborn.blockers().filter((entry) => entry.kind === 'runtime-dir').length, 1, 'left unsettled, not recorded released');
    assert.deepEqual(stubborn.violations, []);
});

test('MODEL CHECK barrier: a supervisor lost after create and before commit leaves a gated process that aborts on end-of-file, never one that runs', async (t) => {
    const rig = await createLedgerRig(t, { keeperOptions: { ignoresEof: true } });
    const ledger = rig.ledger({ faults: crashAt('afterCreate', 'endpoint') });
    await ledger.publish({ kind: 'keeper' });
    await assert.rejects(ledger.publish({ kind: 'endpoint' }), (error) => error instanceof InjectedCrash);
    const endpoint = rig.world.everSpawned().find((entry) => entry.role === 'endpoint');
    assert.equal(endpoint.state, 'gated');
    rig.world.crashSupervisor();
    assert.deepEqual([endpoint.state, endpoint.executed], ['dead', false]);
    assert.deepEqual(rig.violations, []);
    assert.equal(rig.events.some((entry) => entry === 'execute:endpoint:committed'), false);
});

test('MODEL CHECK barrier: admission closes at the first step of the end path, and S1 refuses a new reservation too', async (t) => {
    const rig = await createLedgerRig(t);
    const ledger = rig.ledger();
    await publishAll(ledger);
    await ledger.endExecution({ classification: 'completed' });
    await assert.rejects(ledger.publish({ kind: 'runtime-dir' }), (error) => error.code === 'execution_ending');
    expectCode(assert, () => rig.store.reserveResource({
        kind: 'runtime-dir', locator: { path: '/late' }, robotId: rig.robotId, executionId: rig.admitted.executionId, attemptId: rig.admitted.attemptId
    }), 'operation_conflict');
});

// Negative control: the invariant checker must be able to fail. A gate released before the commit (the defect the
// barrier exists to prevent) is reported as a workload that executed while its reservation was only reserved.
test('MODEL CHECK barrier, negative control: releasing the gate before the commit is detected as a workload executing uncommitted', async (t) => {
    const rig = await createLedgerRig(t);
    const ledger = rig.ledger();
    await ledger.publish({ kind: 'keeper' });
    const { resourceId, locator } = rig.store.reserveResource({ kind: 'endpoint', locator: { role: 'endpoint', id: 'x'.repeat(32) }, processBearing: true, robotId: rig.robotId, executionId: rig.admitted.executionId, attemptId: rig.admitted.attemptId });
    const made = await rig.keeper.create({ kind: 'endpoint', resourceId, marker: locator.marker, locator });
    await made.gate.commit(); // wrong: before commitResource
    assert.equal(rig.violations.length, 1);
    assert.match(rig.violations[0], /endpoint executed while its reservation was reserved/u);
});

for (const kind of ['netns', 'mount']) {
    test(`MODEL CHECK barrier: with an honest keeper a failed ${kind} commit is aborted, but is still not recorded released until the keeper is proven absent`, async (t) => {
        const rig = await createLedgerRig(t);
        const ledger = rig.ledger();
        for (const prerequisite of ['keeper', 'runtime-dir']) await ledger.publish({ kind: prerequisite });
        const real = rig.keeper.create.bind(rig.keeper);
        rig.keeper.create = async (request) => {
            const made = await real(request);
            return request.kind === kind ? { ...made, identity: {} } : made;
        };
        await assert.rejects(ledger.publish({ kind }), (error) => error.code === 'invalid_request');
        const inode = kind === 'netns' ? rig.keeper.model.netns.at(-1) : rig.keeper.model.mntns.at(-1);
        assert.equal(rig.world.namespaceExists(inode), false, 'the keeper abandoned it');
        assert.deepEqual(rig.blockers().filter((entry) => entry.kind === kind).map((entry) => entry.state), ['reserved'], 'its word is not a proof: the keeper itself is still there');
        const ended = await ledger.endExecution({ classification: 'failed' });
        assert.ok(ended.releaseLog.every((entry) => entry.outcome === 'released'));
        assert.deepEqual(rig.violations, []);
    });
}
