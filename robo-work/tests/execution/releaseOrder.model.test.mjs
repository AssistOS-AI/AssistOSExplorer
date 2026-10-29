import assert from 'node:assert/strict';
import test from 'node:test';

import { RELEASE_STEPS } from '../../server/execution/resourceLedger.mjs';
import { POLL_MS, RELEASE_DEADLINE_MS, createLedgerRig, publishAll } from './helpers/ledgerRig.mjs';

// MODEL CHECKS of the section 5.5 end path (steps 1 to 8), quarantine and publication. Never A40 or G1 evidence.

// A pass-through to the S1 handle that records whether a terminal result exists at each step of the end path.
function observed(rig) {
    const log = [];
    const store = rig.store;
    const published = () => rig.reference().result !== null;
    const state = {
        listUnsettledResources: () => store.listUnsettledResources(),
        reserveResource: (request) => store.reserveResource(request),
        commitResource: (request) => store.commitResource(request),
        getReference: (context, request) => store.getReference(context, request),
        beginAttemptEnd: (context, request) => {
            const outcome = store.beginAttemptEnd(context, request);
            const reference = rig.reference();
            log.push({ at: 'beginAttemptEnd', refState: reference.state, cleanup: reference.cleanup, resultPublished: published() });
            return outcome;
        },
        settleResource: (request) => {
            const outcome = store.settleResource(request);
            log.push({ at: 'settle', outcome: request.outcome, resultPublished: published() });
            return outcome;
        },
        retainResource: (request) => {
            const outcome = store.retainResource(request);
            log.push({ at: 'retain', resultPublished: published() });
            return outcome;
        }
    };
    return { state, log };
}

const kindsOf = (log) => log.map((entry) => entry.kind);

test('MODEL CHECK release order: steps 1 to 8 run in the fixed order and every resource is proven absent', async (t) => {
    const rig = await createLedgerRig(t);
    const { state, log } = observed(rig);
    const ledger = rig.ledger({ state });
    await publishAll(ledger);
    assert.equal(rig.reference().state, 'running');
    const ended = await ledger.endExecution({ classification: 'completed', outputText: 'done', data: { n: 1 } });
    // Step 1: the classification is recorded, the reference is non-terminal and shows no result.
    assert.deepEqual(log[0], { at: 'beginAttemptEnd', refState: 'stopping', cleanup: 'pending', resultPublished: false });
    // Steps 2 to 7, by the step number of each settlement.
    const steps = ended.releaseLog.map((entry) => entry.step);
    assert.deepEqual(steps, [...steps].sort((a, b) => a - b), 'steps never go backwards');
    assert.deepEqual(kindsOf(ended.releaseLog), ['process-tree', 'process-tree', 'pty', 'endpoint', 'veth', 'nft-table', 'netns', 'mount', 'runtime-dir', 'cgroup', 'keeper']);
    assert.deepEqual(ended.releaseLog.map((entry) => entry.step), [2, 2, 2, 3, 4, 4, 4, 5, 6, 6, 6]);
    assert.ok(ended.releaseLog.every((entry) => entry.outcome === 'released'));
    assert.deepEqual(RELEASE_STEPS.map((entry) => entry.step), [2, 3, 4, 5, 6, 7]);
    // Step 8: the result is published by the settlement of the LAST blocker, never earlier.
    const settles = log.filter((entry) => entry.at === 'settle');
    assert.equal(settles.length, 11);
    assert.deepEqual(settles.slice(0, -1).map((entry) => entry.resultPublished), Array(10).fill(false));
    assert.equal(settles.at(-1).resultPublished, true);
    assert.deepEqual([ended.reference.state, ended.reference.cleanup, ended.reference.result.cleanup, ended.reference.result.outputText], ['completed', 'released', 'released', 'done']);
    assert.deepEqual(rig.world.residue(), { processes: [], namespaces: [], mounts: [], runtimeDirs: [], cgroups: [], nftTables: [], veths: [], ptys: [], guiContainers: [] });
    assert.deepEqual(rig.blockers(), []);
    assert.deepEqual(rig.violations, []);
});

test('MODEL CHECK release order: the keeper gives up the network namespace at step 4, after the endpoint has ended (R3-5)', async (t) => {
    const rig = await createLedgerRig(t);
    const ledger = rig.ledger();
    const published = await publishAll(ledger);
    const netns = published.find((entry) => entry.kind === 'netns').identity.netNs;
    const mntns = published.find((entry) => entry.kind === 'mount').identity.mntNs;
    const holders = (inode) => rig.world.view.listProcesses().filter((entry) => entry.fdNs.includes(inode)).map((entry) => entry.pid);
    const keeperPid = rig.keeper.pid;
    const seen = {};
    const real = { egress: rig.keeper.releaseEgress.bind(rig.keeper), views: rig.keeper.releaseViews.bind(rig.keeper), endpoint: rig.keeper.endEndpoint.bind(rig.keeper) };
    rig.keeper.endEndpoint = async () => { seen.beforeEndpoint = { endpointAlive: rig.world.alive().some((entry) => entry.role === 'endpoint'), netnsHeld: holders(netns) }; await real.endpoint(); };
    rig.keeper.releaseEgress = async () => {
        seen.beforeEgress = { endpointAlive: rig.world.alive().some((entry) => entry.role === 'endpoint'), netnsHeld: holders(netns), mntnsHeld: holders(mntns) };
        await real.egress();
        seen.afterEgress = { netnsExists: rig.world.namespaceExists(netns), mntnsHeld: holders(mntns) };
    };
    rig.keeper.releaseViews = async () => { await real.views(); seen.afterViews = { mntnsExists: rig.world.namespaceExists(mntns) }; };
    await ledger.endExecution({ classification: 'completed' });
    assert.deepEqual(seen.beforeEndpoint.netnsHeld, [keeperPid], 'the keeper holds the namespace while the endpoint is still a member');
    assert.equal(seen.beforeEgress.endpointAlive, false, 'the endpoint (the only other member) ended at step 3');
    assert.deepEqual(seen.beforeEgress.netnsHeld, [keeperPid]);
    assert.deepEqual(seen.beforeEgress.mntnsHeld, [keeperPid], 'the mount namespace is still held at step 4');
    assert.equal(seen.afterEgress.netnsExists, false, 'the network namespace vanished at step 4');
    assert.deepEqual(seen.afterEgress.mntnsHeld, [keeperPid]);
    assert.equal(seen.afterViews.mntnsExists, false, 'the mount namespace vanished at step 5');
});

test('MODEL CHECK release order, negative control: a keeper that keeps its namespace descriptors cannot be verified and the namespaces are quarantined', async (t) => {
    const rig = await createLedgerRig(t, { keeperOptions: { forgetNetnsFd: true, forgetMntnsFd: true } });
    const { state, log } = observed(rig);
    const ledger = rig.ledger({ state });
    await publishAll(ledger);
    const started = rig.clock.now();
    const ended = await ledger.endExecution({ classification: 'completed' });
    const outcome = (kind) => ended.releaseLog.find((entry) => entry.kind === kind).outcome;
    assert.equal(outcome('netns'), 'quarantined');
    assert.equal(outcome('mount'), 'quarantined');
    // The other resources are not held hostage by the unprovable ones.
    for (const kind of ['process-tree', 'endpoint', 'veth', 'nft-table', 'runtime-dir', 'cgroup', 'keeper']) assert.equal(outcome(kind), 'released', kind);
    // Quarantine is decided at the release deadline, not before it and not by waiting for ever.
    assert.ok(rig.clock.now() - started >= 2 * RELEASE_DEADLINE_MS, 'each unproven resource waited out the deadline');
    assert.ok(rig.clock.now() - started < 2 * RELEASE_DEADLINE_MS + 3 * POLL_MS * 2);
    assert.deepEqual([ended.reference.state, ended.reference.cleanup, ended.reference.result.cleanup], ['completed', 'quarantined', 'quarantined']);
    assert.equal(log.filter((entry) => entry.at === 'settle').at(-1).resultPublished, true);
});

test('MODEL CHECK release order: a process tree that cannot be proven gone is quarantined, and the attempt fails with termination_unverified', async (t) => {
    const rig = await createLedgerRig(t, { keeperOptions: { stuckTrees: true } });
    const ledger = rig.ledger();
    await publishAll(ledger);
    const started = rig.clock.now();
    const ended = await ledger.endExecution({ classification: 'completed', outputText: 'kept', data: { k: 1 } });
    const trees = ended.releaseLog.filter((entry) => entry.kind === 'process-tree');
    assert.deepEqual(trees.map((entry) => entry.outcome), ['quarantined', 'quarantined']);
    assert.ok(rig.clock.now() - started >= RELEASE_DEADLINE_MS);
    const { result } = ended.reference;
    assert.deepEqual([result.status, result.reason, result.classification, result.cleanup], ['failed', 'termination_unverified', 'completed', 'quarantined']);
    assert.deepEqual([result.outputText, result.data], ['kept', { k: 1 }], 'the recorded output is kept');
    // The network namespace still has the stuck trees as members, so it cannot be proven gone either. Everything that
    // does not depend on them is released and proven absent.
    const outcomes = Object.fromEntries(ended.releaseLog.map((entry) => [entry.kind, entry.outcome]));
    assert.equal(outcomes.netns, 'quarantined');
    for (const kind of ['pty', 'endpoint', 'veth', 'nft-table', 'mount', 'runtime-dir', 'cgroup', 'keeper']) assert.equal(outcomes[kind], 'released', kind);
    // The two trees share step 2 and wait one deadline together; the network namespace waits its own at step 4.
    assert.ok(rig.clock.now() - started >= 2 * RELEASE_DEADLINE_MS && rig.clock.now() - started < 3 * RELEASE_DEADLINE_MS, `waited ${rig.clock.now() - started} ms`);
});

test('MODEL CHECK release order: a tree that takes a while to die is released if proven within the deadline, quarantined if not', async (t) => {
    const slow = await createLedgerRig(t, { keeperOptions: { slowTrees: 1200 } });
    const slowLedger = slow.ledger();
    await publishAll(slowLedger);
    const begun = slow.clock.now();
    const withinDeadline = await slowLedger.endExecution({ classification: 'completed' });
    assert.ok(withinDeadline.releaseLog.every((entry) => entry.outcome === 'released'));
    assert.ok(slow.clock.now() - begun >= 1200 && slow.clock.now() - begun < RELEASE_DEADLINE_MS);

    const tooSlow = await createLedgerRig(t, { keeperOptions: { slowTrees: 9 * 1000 } });
    const tooSlowLedger = tooSlow.ledger();
    await publishAll(tooSlowLedger);
    const late = await tooSlowLedger.endExecution({ classification: 'completed' });
    assert.deepEqual(late.releaseLog.filter((entry) => entry.kind === 'process-tree').map((entry) => entry.outcome), ['quarantined', 'quarantined']);
});

test('MODEL CHECK release order: after take-control a retained GUI is transferred to the robot, not released, and does not delay the result', async (t) => {
    const rig = await createLedgerRig(t);
    const { state, log } = observed(rig);
    const ledger = rig.ledger({ state });
    await publishAll(ledger);
    const container = await ledger.publish({ kind: 'gui-container' });
    const view = await ledger.publish({ kind: 'gui-view', extra: { grant: 'g1' } });
    const ended = await ledger.endExecution({ classification: 'completed', retainGui: true });
    assert.deepEqual(ended.releaseLog.filter((entry) => entry.step === 7).map((entry) => [entry.kind, entry.outcome]), [['gui-view', 'retained'], ['gui-container', 'retained']]);
    for (const entry of [container, view]) {
        const record = rig.store.getResource({ resourceId: entry.resourceId });
        assert.deepEqual([record.retained, record.state], [true, 'committed'], 'transferred, not settled');
    }
    // The GUI objects are still there: nothing removed them.
    assert.deepEqual(rig.world.residue().guiContainers.length, 1);
    assert.ok(rig.world.residue().mounts.some((mountpoint) => mountpoint.includes('/gui/')));
    // The attempt's result is published without waiting for them, and the retained records keep blocking deletion.
    assert.equal(ended.reference.result.cleanup, 'released');
    assert.equal(log.filter((entry) => entry.at === 'retain').length, 2);
    assert.deepEqual(rig.blockers().map((entry) => entry.kind).sort(), ['gui-container', 'gui-view']);
    assert.deepEqual(rig.blockers().map((entry) => entry.retained), [true, true]);
});

test('MODEL CHECK release order: without take-control the GUI resources are released and removed at step 7', async (t) => {
    const rig = await createLedgerRig(t);
    const ledger = rig.ledger();
    await publishAll(ledger);
    await ledger.publish({ kind: 'gui-container' });
    await ledger.publish({ kind: 'gui-view' });
    const ended = await ledger.endExecution({ classification: 'completed' });
    assert.deepEqual(ended.releaseLog.filter((entry) => entry.step === 7).map((entry) => [entry.kind, entry.outcome]), [['gui-view', 'released'], ['gui-container', 'released']]);
    assert.deepEqual(rig.world.residue().guiContainers, []);
    assert.deepEqual(rig.blockers(), []);
});

test('MODEL CHECK release order: with the keeper lost, the end path proves and forces by identity and the attempt still ends in order', async (t) => {
    const rig = await createLedgerRig(t, { keeperOptions: { ignoresEof: true } });
    const ledger = rig.ledger();
    await publishAll(ledger);
    rig.keeper.crash();
    assert.equal(rig.keeper.alive(), false);
    const ended = await ledger.endExecution({ classification: 'failed', outputText: 'infrastructure loss' });
    assert.ok(ended.releaseLog.every((entry) => entry.outcome === 'released'), JSON.stringify(ended.releaseLog));
    assert.deepEqual(kindsOf(ended.releaseLog).at(-1), 'keeper');
    assert.deepEqual(rig.world.residue(), { processes: [], namespaces: [], mounts: [], runtimeDirs: [], cgroups: [], nftTables: [], veths: [], ptys: [], guiContainers: [] });
    assert.deepEqual([ended.reference.state, ended.reference.result.cleanup], ['failed', 'released']);
});

test('MODEL CHECK release order: a kind no step names is walked last and, being unprovable, quarantined', async (t) => {
    const rig = await createLedgerRig(t);
    const ledger = rig.ledger();
    await publishAll(ledger);
    rig.store.reserveResource({ kind: 'mystery', locator: { thing: 1 }, robotId: rig.robotId, executionId: rig.admitted.executionId, attemptId: rig.admitted.attemptId });
    const ended = await ledger.endExecution({ classification: 'completed' });
    assert.deepEqual(ended.releaseLog.at(-1).kind, 'mystery');
    assert.equal(ended.releaseLog.at(-1).outcome, 'quarantined');
    assert.equal(ended.reference.result.cleanup, 'quarantined');
});

// A keeper's answer is a request, never a proof (probes keeperWord, P2a, P2c). An uncommitted process, namespace or mount
// is proven absent only after the keeper's own process is verified absent, so such blockers are settled after step 6.
function crashAfterCreate(rig, kind) {
    return rig.ledger({ faults: { afterCreate: (info) => { if (info.kind === kind) throw Object.assign(new Error('crash'), { injectedCrash: true }); } } });
}

test('MODEL CHECK release order: a healthy keeper is asked to abandon exactly the uncommitted creations, and the blockers settle after the keeper has exited', async (t) => {
    const rig = await createLedgerRig(t);
    const ledger = crashAfterCreate(rig, 'netns');
    await assert.rejects(publishAll(ledger), (error) => error.injectedCrash === true);
    const asked = [];
    const real = rig.keeper.abortUncommitted.bind(rig.keeper);
    rig.keeper.abortUncommitted = async (ids) => { asked.push(ids); await real(ids); };
    const uncommitted = rig.blockers().filter((entry) => entry.identity === null).map((entry) => entry.resourceId);
    const ended = await ledger.endExecution({ classification: 'failed' });
    assert.deepEqual(asked, [uncommitted]);
    assert.equal(uncommitted.length, 1);
    assert.ok(ended.releaseLog.every((entry) => entry.outcome === 'released'));
    const order = ended.releaseLog.map((entry) => entry.kind);
    assert.ok(order.indexOf('netns') > order.indexOf('keeper'), 'the uncommitted namespace is settled after the keeper');
    assert.deepEqual(rig.violations, []);
});

for (const kind of ['netns', 'mount']) {
    test(`MODEL CHECK release order: a keeper that lies about aborting an uncommitted ${kind} is not believed`, async (t) => {
        // The keeper acknowledges the abort, does nothing, keeps its descriptors, and never exits: the namespace still
        // exists, the keeper is still there, and the reservation must be quarantined, not recorded released.
        const rig = await createLedgerRig(t, { keeperOptions: { [kind === 'netns' ? 'forgetNetnsFd' : 'forgetMntnsFd']: true, neverExits: true } });
        const ledger = crashAfterCreate(rig, kind);
        await assert.rejects(publishAll(ledger), (error) => error.injectedCrash === true);
        rig.keeper.abortUncommitted = async () => {};
        rig.world.process(rig.keeper.pid).unkillable = true; // stuck: the supervisor cannot remove it either
        const inode = kind === 'netns' ? rig.keeper.model.netns[0] : rig.keeper.model.mntns[0];
        const ended = await ledger.endExecution({ classification: 'failed' });
        assert.equal(rig.world.namespaceExists(inode), true, 'still there');
        assert.equal(ended.releaseLog.find((entry) => entry.kind === 'keeper').outcome, 'quarantined', 'a keeper that stays is quarantined');
        assert.equal(ended.releaseLog.find((entry) => entry.kind === kind).outcome, 'quarantined');
        assert.deepEqual(rig.violations, [], 'nothing was recorded released while it existed');
        assert.equal(ended.reference.result.cleanup, 'quarantined');
    });

    test(`MODEL CHECK release order: a lying keeper that does exit leaves the uncommitted ${kind} released only because it really went`, async (t) => {
        const rig = await createLedgerRig(t, { keeperOptions: { [kind === 'netns' ? 'forgetNetnsFd' : 'forgetMntnsFd']: true } });
        const ledger = crashAfterCreate(rig, kind);
        await assert.rejects(publishAll(ledger), (error) => error.injectedCrash === true);
        rig.keeper.abortUncommitted = async () => {};
        const inode = kind === 'netns' ? rig.keeper.model.netns[0] : rig.keeper.model.mntns[0];
        const ended = await ledger.endExecution({ classification: 'failed' });
        assert.equal(rig.world.namespaceExists(inode), false, 'it vanished with the keeper');
        assert.ok(ended.releaseLog.every((entry) => entry.outcome === 'released'));
        assert.deepEqual(rig.violations, []);
    });
}

test('MODEL CHECK release order: with retention decided, completion retains the GUI; without it the GUI is released (section 5.5: after take-control or completion)', async (t) => {
    for (const [retainGui, expected] of [[true, 'retained'], [false, 'released']]) {
        const rig = await createLedgerRig(t);
        const ledger = rig.ledger();
        await publishAll(ledger);
        await ledger.publish({ kind: 'gui-container' });
        const ended = await ledger.endExecution({ classification: 'completed', retainGui });
        assert.equal(ended.releaseLog.find((entry) => entry.kind === 'gui-container').outcome, expected);
        assert.equal(rig.world.residue().guiContainers.length, expected === 'retained' ? 1 : 0);
        assert.equal(ended.reference.state, 'completed');
    }
});
