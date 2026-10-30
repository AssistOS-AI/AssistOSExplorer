import assert from 'node:assert/strict';
import test from 'node:test';

import { createWalker, recoverGeneration, walkOrder } from '../../server/execution/recoveryWalk.mjs';
import { InjectedCrash, RELEASE_DEADLINE_MS, createLedgerRig, crashAt, publishAll } from './helpers/ledgerRig.mjs';

// MODEL CHECKS of the section 5.5 recovery walk, over a fake /proc, a fake mountinfo and a model keeper. Never A40 or G1
// evidence: no process, namespace or mount here is real.

// Runs the full publication until the injected crash, then loses the supervisor and recovers in a new generation.
async function crashAndRecover(t, { point, kind, nth = 1, keeperOptions = { ignoresEof: true }, leakGates = true, before, withGui = false }) {
    const rig = await createLedgerRig(t, { keeperOptions, faults: crashAt(point, kind, nth) });
    const ledger = rig.ledger();
    const publish = async () => {
        await publishAll(ledger);
        if (withGui) { await ledger.publish({ kind: 'gui-container' }); await ledger.publish({ kind: 'gui-view', extra: { grant: 'g1' } }); }
    };
    await assert.rejects(publish(), (error) => error instanceof InjectedCrash);
    rig.pre = rig.store.listUnsettledResources();
    before?.(rig);
    rig.restartSupervisor({ leakGates });
    rig.recovery = await rig.recover();
    return rig;
}
const outcomeOf = (rig, kind, nth = 0) => rig.recovery.outcomes.filter((entry) => entry.kind === kind)[nth]?.outcome;
const EMPTY = { processes: [], namespaces: [], mounts: [], runtimeDirs: [], cgroups: [], nftTables: [], veths: [], ptys: [], guiContainers: [] };

test('MODEL CHECK recovery: an uncommitted process-bearing resource that still exists is found by its marker alone, killed and released', async (t) => {
    // Crash after create, before commit: the endpoint is gated with the marker in argv; the gate descriptor leaked, so
    // end-of-file never reaches it, and the keeper survives the supervisor too.
    const rig = await crashAndRecover(t, { point: 'afterCreate', kind: 'endpoint' });
    const endpoint = rig.pre.find((entry) => entry.kind === 'endpoint');
    assert.deepEqual([endpoint.state, endpoint.identity], ['reserved', null], 'it was never committed');
    assert.ok(rig.world.everSpawned().find((entry) => entry.role === 'endpoint').marker === endpoint.locator.marker);
    assert.equal(outcomeOf(rig, 'endpoint'), 'released');
    assert.equal(outcomeOf(rig, 'keeper'), 'released');
    assert.deepEqual(rig.world.residue(), EMPTY);
    assert.deepEqual(rig.violations, [], 'it never ran its final exec');
    assert.equal(rig.events.includes('execute:endpoint:committed'), false);
});

test('MODEL CHECK recovery: a gated helper that outlives its keeper is found by the marker in argv and killed by that alone', async (t) => {
    // The helper asked for no parent-death signal and holds the leaked gate, so neither the keeper's death nor
    // end-of-file ends it: only the marker walk can.
    const rig = await crashAndRecover(t, {
        point: 'afterCreate', kind: 'endpoint',
        before: (r) => { r.world.everSpawned().find((entry) => entry.role === 'endpoint').pdeathsig = false; }
    });
    const endpoint = rig.world.everSpawned().find((entry) => entry.role === 'endpoint');
    assert.equal(endpoint.state, 'dead');
    assert.equal(endpoint.executed, false);
    assert.equal(outcomeOf(rig, 'endpoint'), 'released');
    assert.equal(rig.recovery.outcomes.filter((entry) => entry.outcome === 'quarantined').length, 0);
    assert.deepEqual(rig.world.residue(), EMPTY);

    // Negative control: with no marker walk the same helper would survive. A walker that ignores the marker finds none.
    const control = await createLedgerRig(t, { keeperOptions: { ignoresEof: true }, faults: crashAt('afterCreate', 'endpoint') });
    await assert.rejects(publishAll(control.ledger()), (error) => error instanceof InjectedCrash);
    const helper = control.world.everSpawned().find((entry) => entry.role === 'endpoint');
    helper.pdeathsig = false;
    const blocker = control.store.listUnsettledResources().find((entry) => entry.kind === 'endpoint');
    control.keeper.crash(); // the helper has no parent-death signal and survives; the keeper is gone
    assert.equal(control.walker().prove({ ...blocker, locator: { ...blocker.locator, marker: 'not-the-marker' } }, {}).absent, true, 'a wrong marker finds nothing');
    assert.equal(control.walker().prove(blocker, {}).absent, false, 'the right marker finds the helper');
});

test('MODEL CHECK recovery: a crash before commit after which nothing survives ends released through the marker check, not quarantined (R3-1)', async (t) => {
    // The default keeper reacts to the closed channel and the gate reaches end-of-file: nothing survives at all.
    const rig = await crashAndRecover(t, { point: 'afterCreate', kind: 'process-tree', keeperOptions: {}, leakGates: false });
    assert.deepEqual(rig.world.residue(), EMPTY);
    const tree = rig.pre.find((entry) => entry.kind === 'process-tree');
    assert.deepEqual([tree.state, tree.identity], ['reserved', null]);
    assert.equal(outcomeOf(rig, 'process-tree'), 'released');
    assert.equal(rig.recovery.outcomes.filter((entry) => entry.outcome === 'quarantined').length, 0, 'no permanent quarantine');
    assert.deepEqual(rig.recovery.completed, { generationId: rig.recovery.generationId, recovered: true });
});

test('MODEL CHECK recovery: a crash right after reserve finds nothing created, and the blocker is released without waiting', async (t) => {
    for (const kind of ['keeper', 'runtime-dir', 'netns', 'endpoint']) {
        const rig = await createLedgerRig(t, { faults: crashAt('afterReserve', kind) });
        const ledger = rig.ledger();
        await assert.rejects(publishAll(ledger), (error) => error instanceof InjectedCrash);
        const before = rig.clock.now();
        rig.restartSupervisor();
        const recovery = await rig.recover();
        assert.ok(recovery.outcomes.every((entry) => entry.outcome === 'released'), kind);
        assert.equal(rig.clock.now(), before, `${kind}: proof of absence needed no waiting`);
        assert.deepEqual(rig.world.residue(), EMPTY);
    }
});

test('MODEL CHECK recovery: an uncommitted object named by its locator is found and removed by the locator alone', async (t) => {
    for (const kind of ['runtime-dir', 'cgroup', 'nft-table', 'veth']) {
        const rig = await crashAndRecover(t, { point: 'afterCreate', kind });
        const blocker = rig.pre.find((entry) => entry.kind === kind);
        assert.equal(blocker.identity, null, kind);
        assert.equal(outcomeOf(rig, kind), 'released', kind);
        assert.deepEqual(rig.world.residue(), EMPTY, kind);
    }
});

test('MODEL CHECK recovery: a committed process is found by identity, and a double-forked descendant by the recorded namespace inode', async (t) => {
    const rig = await createLedgerRig(t, { keeperOptions: { ignoresEof: true }, faults: crashAt('afterGateRelease', 'process-tree', 2) });
    const ledger = rig.ledger();
    await assert.rejects(publishAll(ledger), (error) => error instanceof InjectedCrash);
    const tree = rig.store.listUnsettledResources().filter((entry) => entry.kind === 'process-tree')[1];
    // A grandchild that left the tree's parent chain (setsid, double fork): same PID namespace, parent 1, no parent-death signal.
    const stray = rig.world.spawn({ ppid: 1, cmdline: ['/bin/sleep', '1000'], pidNs: undefined, role: 'stray', pdeathsig: false });
    stray.pidNs = tree.identity.pidNs;
    const probe = rig.walker().prove(tree, {});
    assert.equal(probe.absent, false);
    assert.ok(probe.holders.some((holder) => holder.pid === stray.pid), 'the stray is a member of the recorded namespace');
    rig.restartSupervisor({ leakGates: true });
    const recovery = await rig.recover();
    assert.equal(stray.state, 'dead');
    assert.ok(recovery.outcomes.every((entry) => entry.outcome === 'released'));
    assert.deepEqual(rig.world.residue(), EMPTY);
});

test('MODEL CHECK recovery: a process that cannot be killed is quarantined after the deadline, recovery still completes, and the attempt fails termination_unverified', async (t) => {
    const rig = await crashAndRecover(t, { point: 'afterGateRelease', kind: 'pty', keeperOptions: { ignoresEof: true, stuckTrees: true }, leakGates: true });
    const begun = rig.clock.now();
    void begun;
    assert.deepEqual(rig.recovery.outcomes.filter((entry) => entry.kind === 'process-tree').map((entry) => entry.outcome), ['quarantined', 'quarantined']);
    assert.equal(rig.recovery.completed.recovered, true, 'a quarantined blocker settles the recovery');
    const reference = rig.reference();
    assert.deepEqual([reference.state, reference.result.reason, reference.result.classification, reference.result.cleanup], ['failed', 'termination_unverified', 'interrupted', 'quarantined']);
    const quarantined = rig.recovery.published.filter((entry) => entry.outcome === 'quarantined');
    assert.equal(quarantined.length >= 2, true);
    assert.equal(rig.recovery.published.at(-1).resultPublished, true);
    assert.deepEqual(rig.recovery.published.slice(0, -1).map((entry) => entry.resultPublished), Array(rig.recovery.published.length - 1).fill(false), 'the result is published only by the last settlement');
});

test('MODEL CHECK recovery: a network namespace held by a process nobody recorded, or by an nsfs bind, cannot be proven gone and is quarantined', async (t) => {
    const held = await createLedgerRig(t, { keeperOptions: { ignoresEof: true }, faults: crashAt('afterGateRelease', 'pty') });
    await assert.rejects(publishAll(held.ledger()), (error) => error instanceof InjectedCrash);
    const netns = held.store.listUnsettledResources().find((entry) => entry.kind === 'netns').identity.netNs;
    const rogue = held.world.spawn({ ppid: 1, cmdline: ['/usr/bin/unrecorded'], netNs: netns, role: 'rogue', pdeathsig: false });
    held.restartSupervisor({ leakGates: true });
    const recovery = await held.recover();
    assert.equal(recovery.outcomes.find((entry) => entry.kind === 'netns').outcome, 'quarantined');
    assert.equal(rogue.state, 'running', 'recovery kills only what it recorded');
    assert.equal(recovery.outcomes.find((entry) => entry.kind === 'process-tree').outcome, 'released');

    const bound = await createLedgerRig(t, { keeperOptions: { ignoresEof: true }, faults: crashAt('afterGateRelease', 'pty') });
    await assert.rejects(publishAll(bound.ledger()), (error) => error instanceof InjectedCrash);
    const inode = bound.store.listUnsettledResources().find((entry) => entry.kind === 'netns').identity.netNs;
    bound.world.bindNamespace(inode);
    const unsettled = bound.store.listUnsettledResources().find((entry) => entry.kind === 'netns');
    bound.restartSupervisor({ leakGates: true });
    const second = await bound.recover();
    assert.equal(second.outcomes.find((entry) => entry.kind === 'netns').outcome, 'quarantined');
    const probe = bound.walker().prove(unsettled, {});
    assert.deepEqual(probe.holders.map((holder) => holder.via), ['nsfs-mount']);
});

test('MODEL CHECK recovery: committed and uncommitted mounts are found through mountinfo and unmounted', async (t) => {
    const committed = await crashAndRecover(t, { point: 'afterGateRelease', kind: 'mount' });
    assert.equal(committed.recovery.outcomes.find((entry) => entry.kind === 'mount').outcome, 'released');
    assert.deepEqual(committed.world.mounts(), []);
    const uncommitted = await crashAndRecover(t, { point: 'afterCreate', kind: 'mount' });
    assert.equal(uncommitted.pre.find((entry) => entry.kind === 'mount').identity, null);
    assert.equal(uncommitted.recovery.outcomes.find((entry) => entry.kind === 'mount').outcome, 'released');
    assert.deepEqual(uncommitted.world.residue(), EMPTY);
});

test('MODEL CHECK recovery: an uncommitted process-bearing resource is absent only when the keeper\'s identity is absent too', async (t) => {
    const rig = await createLedgerRig(t, { keeperOptions: { ignoresEof: true }, faults: crashAt('afterReserve', 'endpoint') });
    await assert.rejects(publishAll(rig.ledger()), (error) => error instanceof InjectedCrash);
    const all = rig.store.listUnsettledResources();
    const endpoint = all.find((entry) => entry.kind === 'endpoint');
    const walker = rig.walker();
    assert.equal(endpoint.identity, null);
    // No process carries the marker, but the keeper is alive: not proven.
    assert.equal(walker.prove(endpoint, {}).absent, false);
    // The keeper gone (or already settled): proven.
    rig.keeper.crash();
    assert.equal(walker.prove(endpoint, {}).absent, true);
    assert.equal(walker.prove(endpoint, {}).absent, true);
});

test('MODEL CHECK recovery: the walk goes keeper, endpoint, process trees, PTYs, egress, namespaces, mounts, then directories', () => {
    const kinds = ['cgroup', 'mount', 'netns', 'runtime-dir', 'process-tree', 'nft-table', 'endpoint', 'veth', 'pty', 'keeper', 'gui-container', 'gui-view', 'mystery'];
    assert.deepEqual(walkOrder(kinds.map((kind) => ({ kind }))).map((entry) => entry.kind),
        ['keeper', 'endpoint', 'process-tree', 'pty', 'veth', 'nft-table', 'netns', 'mount', 'runtime-dir', 'cgroup', 'gui-view', 'gui-container', 'mystery']);
});

test('MODEL CHECK recovery: the walker needs explicit positive deadlines and cannot prove a kind it does not know', () => {
    const view = { listProcesses: () => [], listMounts: () => [], exists: () => false };
    assert.throws(() => createWalker({ view, clock: {}, releaseDeadlineMs: 0, pollMs: 10, sandboxRecord: () => null }), TypeError);
    assert.throws(() => createWalker({ view, clock: {}, releaseDeadlineMs: 10, pollMs: -1, sandboxRecord: () => null }), TypeError);
    const walker = createWalker({ view, clock: {}, releaseDeadlineMs: 10, pollMs: 5, sandboxRecord: () => null });
    assert.equal(walker.prove({ kind: 'mystery', locator: {}, identity: null }).absent, false);
    assert.ok(RELEASE_DEADLINE_MS > 0);
});

test('MODEL CHECK recovery: a retained GUI resource of a lost generation is walked and settled like any other (open question for the restart policy)', async (t) => {
    const rig = await createLedgerRig(t, { keeperOptions: { ignoresEof: true } });
    const ledger = rig.ledger();
    await publishAll(ledger);
    await ledger.publish({ kind: 'gui-container' });
    await ledger.endExecution({ classification: 'completed', retainGui: true });
    assert.equal(rig.blockers().length, 1);
    rig.restartSupervisor({ leakGates: true });
    const recovery = await rig.recover();
    assert.deepEqual(recovery.outcomes.map((entry) => [entry.kind, entry.outcome]), [['gui-container', 'released']]);
    assert.deepEqual(rig.world.residue().guiContainers, []);
});

test('MODEL CHECK recovery: GUI views and containers live in the container\'s own namespaces and are found through mountinfo and by locator, committed or not', async (t) => {
    for (const point of ['afterCreate', 'afterGateRelease']) {
        const rig = await crashAndRecover(t, { point, kind: 'gui-view', withGui: true });
        const view = rig.pre.find((entry) => entry.kind === 'gui-view');
        assert.equal(view.identity === null, point === 'afterCreate');
        assert.ok(rig.world.mounts().length === 0, 'the host-namespace mount was removed by the walk, not by a namespace dying');
        assert.equal(outcomeOf(rig, 'gui-view'), 'released', point);
        assert.equal(outcomeOf(rig, 'gui-container'), 'released', point);
        assert.deepEqual(rig.world.residue(), EMPTY, point);
    }
    // Negative control: a view that stays mounted cannot be proven gone.
    const rig = await createLedgerRig(t, { keeperOptions: { ignoresEof: true }, faults: crashAt('afterGateRelease', 'gui-view') });
    const ledger = rig.ledger();
    await assert.rejects((async () => { await publishAll(ledger); await ledger.publish({ kind: 'gui-view' }); })(), (error) => error instanceof InjectedCrash);
    const blocker = rig.store.listUnsettledResources().find((entry) => entry.kind === 'gui-view');
    const view = { ...rig.world.view, unmount: () => false };
    const stubborn = createWalker({ view, clock: rig.clock, releaseDeadlineMs: 1000, pollMs: 100, sandboxRecord: () => null });
    assert.equal(await stubborn.walk(blocker, {}), 'quarantined');
});

// R1 (probes quarantinedKeeper, P1a to P1c): a keeper that cannot be killed is quarantined, and it is still running.
// Absence of an uncommitted dependent is judged from the keeper's own record against /proc, not from whether its blocker
// is still unsettled, so every uncommitted process, namespace and mount reservation is quarantined with it.
const stuckKeeper = { ignoresEof: true };
async function crashWithStuckKeeper(t, { point, kind }) {
    const rig = await createLedgerRig(t, { keeperOptions: stuckKeeper, faults: crashAt(point, kind) });
    await assert.rejects(publishAll(rig.ledger()), (error) => error instanceof InjectedCrash);
    rig.world.process(rig.keeper.pid).unkillable = true; // stuck in an uninterruptible wait
    return rig;
}

for (const [point, kind] of [['afterReserve', 'endpoint'], ['afterCreate', 'endpoint'], ['afterReserve', 'process-tree'], ['afterCreate', 'process-tree'],
    ['afterReserve', 'netns'], ['afterCreate', 'netns'], ['afterReserve', 'mount'], ['afterCreate', 'mount']]) {
    test(`MODEL CHECK recovery: with an unkillable keeper, an uncommitted ${kind} (${point}) is quarantined, never released`, async (t) => {
        const rig = await crashWithStuckKeeper(t, { point, kind });
        rig.restartSupervisor({ leakGates: true });
        const recovery = await rig.recover();
        assert.equal(rig.keeper.alive(), true, 'the keeper is still running');
        rig.recovery = recovery;
        assert.equal(outcomeOf(rig, 'keeper'), 'quarantined');
        assert.equal(outcomeOf(rig, kind), 'quarantined', `${kind} depends on a keeper that is still there`);
        assert.deepEqual(rig.violations, [], 'nothing was recorded released while it existed');
        assert.equal(recovery.completed.recovered, true, 'a quarantined blocker settles the recovery');
        assert.equal(rig.reference().result.cleanup, 'quarantined');
    });
}

test('MODEL CHECK recovery: the keeper\'s record is found again after a crash during recovery, so its quarantine still governs its dependents', async (t) => {
    const rig = await crashWithStuckKeeper(t, { point: 'afterCreate', kind: 'netns' });
    rig.restartSupervisor({ leakGates: true });
    // First recovery: crashes right after the keeper was settled (quarantined). The keeper is no longer unsettled.
    let settled = 0;
    const first = {
        get generationId() { return rig.store.generationId; },
        beginGenerationRecovery: (generation) => rig.store.beginGenerationRecovery(generation),
        listUnsettledResources: () => rig.store.listUnsettledResources(),
        completeGenerationRecovery: (generation) => rig.store.completeGenerationRecovery(generation),
        settleResource: (request) => {
            const outcome = rig.store.settleResource(request);
            if (++settled === 1) throw new InjectedCrash('duringRecovery', 'keeper');
            return outcome;
        }
    };
    await assert.rejects(recoverGeneration({ state: first, walker: rig.walker() }), (error) => error instanceof InjectedCrash);
    assert.equal(rig.store.listUnsettledResources().some((entry) => entry.kind === 'keeper'), false, 'the quarantined keeper dropped out of the unsettled list');
    rig.restartSupervisor({ leakGates: true });
    const second = await rig.recover();
    assert.equal(second.outcomes.find((entry) => entry.kind === 'netns').outcome, 'quarantined');
    assert.deepEqual(rig.violations, []);
    assert.equal(rig.keeper.alive(), true);
});

test('MODEL CHECK recovery: an uncommitted dependent of a keeper that is really gone is still released', async (t) => {
    // Control: the same crash points with a killable keeper end released, so the quarantines above come from the keeper.
    for (const [point, kind] of [['afterReserve', 'endpoint'], ['afterCreate', 'netns'], ['afterCreate', 'mount']]) {
        const rig = await crashAndRecover(t, { point, kind });
        assert.equal(outcomeOf(rig, kind), 'released', `${kind} ${point}`);
        assert.equal(outcomeOf(rig, 'keeper'), 'released');
        assert.deepEqual(rig.world.residue(), EMPTY);
    }
});

// N1 (probe sandboxRecordDefault): a missing or unreadable keeper record must never read as an absent keeper.
test('MODEL CHECK recovery: sandboxRecord is required, and a record that is missing or unreadable makes an uncommitted dependent unprovable', async (t) => {
    const rig = await createLedgerRig(t);
    const ledger = rig.ledger({ faults: crashAt('afterCreate', 'netns') });
    await ledger.startKeeper();
    await assert.rejects(ledger.publish({ kind: 'netns' }), (error) => error instanceof InjectedCrash);
    const netns = rig.store.listUnsettledResources().find((entry) => entry.kind === 'netns');
    assert.ok(netns.locator.keeper, 'the dependent names its keeper');
    const options = { view: rig.world.view, clock: rig.clock, releaseDeadlineMs: RELEASE_DEADLINE_MS, pollMs: 250 };
    // No default: the probe's bare walker cannot be built.
    assert.throws(() => createWalker(options), { name: 'TypeError', message: 'sandboxRecord is required' });
    assert.throws(() => createWalker({ ...options, sandboxRecord: 'x' }), TypeError);
    // Wired to the store, the live keeper keeps the namespace unproven.
    assert.equal(rig.keeper.alive(), true);
    assert.equal(rig.world.namespaceExists(rig.keeper.model.netns[0]), true);
    assert.equal(rig.walker().prove(netns).absent, false);
    // Every way the record can fail to be read is unprovable, whether or not the keeper is really there.
    const broken = {
        'throws': () => { throw new Error('store unavailable'); },
        'returns nothing': () => undefined,
        'returns null': () => null,
        'returns a non-record': () => ({ state: 'released' })
    };
    for (const [name, sandboxRecord] of Object.entries(broken)) {
        const walker = createWalker({ ...options, sandboxRecord });
        assert.equal(walker.prove(netns).absent, false, `${name}: uncommitted netns`);
        assert.deepEqual(walker.prove(netns).holders, [{ via: 'sandbox-record-unavailable' }], name);
        const endpoint = { kind: 'endpoint', identity: null, locator: { marker: 'no-such-marker', keeper: netns.locator.keeper } };
        assert.equal(walker.prove(endpoint).absent, false, `${name}: uncommitted process-bearing`);
    }
    // Even with the keeper really gone, an unreadable record is not an absent keeper.
    rig.keeper.crash();
    assert.equal(createWalker({ ...options, sandboxRecord: broken.throws }).prove(netns).absent, false);
    assert.equal(rig.walker().prove(netns).absent, true, 'with a readable record and the keeper gone it is proven');
    // A blocker that names no keeper has none to wait for, and sandboxRecord is not consulted.
    const none = createWalker({ ...options, sandboxRecord: () => { throw new Error('must not be called'); } });
    assert.equal(none.prove({ kind: 'runtime-dir', identity: null, locator: { path: '/x' } }).absent, true);
    assert.equal(none.prove({ kind: 'endpoint', identity: null, locator: { marker: 'm' } }).absent, true);
});

test('MODEL CHECK recovery: an execution whose keeper record cannot be read ends with its uncommitted dependents quarantined, not released', async (t) => {
    const rig = await createLedgerRig(t);
    const unreadable = createWalker({ view: rig.world.view, clock: rig.clock, releaseDeadlineMs: RELEASE_DEADLINE_MS, pollMs: 250, sandboxRecord: () => { throw new Error('store unavailable'); } });
    const ledger = rig.ledger({ walker: unreadable, faults: crashAt('afterCreate', 'netns') });
    await assert.rejects(publishAll(ledger), (error) => error instanceof InjectedCrash);
    const ended = await ledger.endExecution({ classification: 'failed' });
    assert.equal(ended.releaseLog.find((entry) => entry.kind === 'keeper').outcome, 'released', 'the keeper itself needs no record');
    assert.equal(ended.releaseLog.find((entry) => entry.kind === 'netns').outcome, 'quarantined');
    assert.deepEqual(rig.violations, []);
    assert.equal(ended.reference.result.cleanup, 'quarantined');
});
