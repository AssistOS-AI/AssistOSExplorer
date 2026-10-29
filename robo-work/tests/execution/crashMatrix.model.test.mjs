import assert from 'node:assert/strict';
import test from 'node:test';

import { InjectedCrash, createLedgerRig, publishAll } from './helpers/ledgerRig.mjs';

// MODEL CHECK of the A40 crash matrix (section 5.5 first checkpoint, A40 Revision 9): loss of the supervisor, of the
// keeper or of the endpoint after reserve, after create before commit, after commit before gate release, and after
// release. This is a MODEL: the kernel, the namespaces, the real gate pipe and the real crash of a process are not
// involved, so it is NEVER A40 or G1 evidence. It checks that the ledger, the walker and the S1 store together give the
// outcomes A40 expects, in a model that enforces the kernel rules section 5.5 relies on.
//
// Expected, in every cell: no workload executes before its commit; no process survives and no object is left in the
// model; every recorded resource is found through its locator or identity and released (quarantine is for resources the
// model makes unprovable, and none is here); recovery completes; the terminal result is published only after the last
// settlement.

const EMPTY = { processes: [], namespaces: [], mounts: [], runtimeDirs: [], cgroups: [], nftTables: [], veths: [], ptys: [], guiContainers: [] };
const PUBLISH_POINTS = ['afterReserve', 'afterCreate', 'afterCommit', 'afterGateRelease'];
const PUBLISH_KINDS = ['keeper', 'endpoint', 'process-tree', 'netns', 'mount', 'runtime-dir'];
const RELEASE_KINDS = ['process-tree', 'endpoint', 'netns', 'mount', 'runtime-dir', 'keeper'];
// supervisor: the keeper reacts to the closed channel. supervisor-keeper-survives: it does not, and the gate descriptors
// leaked too, so recovery has to find and kill everything itself. keeper, endpoint: the supervisor lives and ends the
// execution on infrastructure loss.
const LOSSES = ['supervisor', 'supervisor-keeper-survives', 'keeper', 'endpoint'];

async function run(t, { loss, point, kind }) {
    const keeperOptions = loss === 'supervisor-keeper-survives' ? { ignoresEof: true } : {};
    const recorded = [];
    let seen = 0;
    const faults = {};
    for (const name of [...PUBLISH_POINTS, 'afterRelease']) {
        faults[name] = (info) => {
            if (name === 'afterReserve') recorded.push(info.resourceId);
            if (name === point && info.kind === kind && ++seen === 1) throw new InjectedCrash(name, info.kind);
        };
    }
    const rig = await createLedgerRig(t, { keeperOptions, faults });
    const ledger = rig.ledger();
    let crashed = false;
    try {
        await publishAll(ledger);
        if (point === 'afterRelease') await ledger.endExecution({ classification: 'completed', outputText: 'finished', data: { ok: true } });
    } catch (error) {
        if (!(error instanceof InjectedCrash)) throw error;
        crashed = true;
    }
    assert.equal(crashed, true, `the crash point ${point}:${kind} was reached`);
    const lastReleased = point === 'afterRelease' && kind === 'keeper';
    const before = rig.reference();
    assert.equal(before.result !== null, lastReleased, 'before any recovery the result is published only if the last blocker was already settled');

    let published = [];
    if (loss === 'supervisor' || loss === 'supervisor-keeper-survives') {
        rig.restartSupervisor({ leakGates: loss === 'supervisor-keeper-survives' });
        const recovery = await rig.recover();
        published = recovery.published;
        assert.equal(recovery.completed.recovered, true, 'recovery completes');
    } else {
        if (loss === 'keeper') rig.keeper.crash(); else rig.keeper.crashEndpoint();
        await ledger.endExecution({ classification: 'failed', outputText: 'infrastructure loss', resume: point === 'afterRelease' });
    }

    // No workload executed before its commit.
    assert.deepEqual(rig.violations, []);
    // No survivor and no object in the model.
    assert.deepEqual(rig.world.residue(), EMPTY);
    // Every recorded resource was settled, and none was left quarantined.
    assert.deepEqual(rig.blockers(), []);
    assert.ok(recorded.length > 0);
    for (const resourceId of recorded) assert.equal(rig.store.getResource({ resourceId }).state, 'released', `${resourceId} released`);
    // The result is terminal, with its cleanup released, and publication followed the last settlement.
    const after = rig.reference();
    assert.notEqual(after.result, null);
    assert.equal(after.result.cleanup, 'released');
    const expectedStatus = point === 'afterRelease' ? 'completed' : (loss === 'supervisor' || loss === 'supervisor-keeper-survives' ? 'interrupted' : 'failed');
    assert.equal(after.result.status, expectedStatus);
    if (point === 'afterRelease') assert.deepEqual([after.result.outputText, after.result.data], ['finished', { ok: true }], 'the recorded output survives the loss');
    if (published.length > 0) {
        assert.equal(published.at(-1).resultPublished, true);
        assert.deepEqual(published.slice(0, -1).filter((entry) => entry.resultPublished), [], 'no result before the last settlement');
    }
}

for (const loss of LOSSES) {
    for (const point of PUBLISH_POINTS) {
        for (const kind of PUBLISH_KINDS) {
            test(`MODEL CHECK A40 matrix (not A40 evidence): ${loss} loss ${point} ${kind}`, (t) => run(t, { loss, point, kind }));
        }
    }
    for (const kind of RELEASE_KINDS) {
        test(`MODEL CHECK A40 matrix (not A40 evidence): ${loss} loss afterRelease ${kind}`, (t) => run(t, { loss, point: 'afterRelease', kind }));
    }
}
