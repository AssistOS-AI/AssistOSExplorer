import { createExecutionLedger } from '../../../server/execution/resourceLedger.mjs';
import { createWalker, recoverGeneration } from '../../../server/execution/recoveryWalk.mjs';
import { admitRequest, makeTempDir, openStore, readyRobot, syntheticContext } from '../../helpers/synthetic.mjs';
import { createModelKeeper } from './modelKeeper.mjs';
import { createModelClock, createModelWorld } from './modelWorld.mjs';

// MODEL CHECK rig: the S1 library's real store in a temporary directory (S1's synthetic helpers are imported, read-only),
// the model world and keeper, and the ledger and walker under test. Nothing here is A40 or G1 evidence.

export const LAYOUT = Object.freeze({ runtimeDir: '/run/robo-work/runtime', cgroupSubtree: '/sys/fs/cgroup/robo-work' });
// PROVISIONAL model values (virtual milliseconds). G5 fixes the production release deadline.
export const RELEASE_DEADLINE_MS = 5000;
export const POLL_MS = 250;

export class InjectedCrash extends Error {
    constructor(point, kind) { super(`injected crash ${point} ${kind}`); this.injectedCrash = true; this.point = point; this.kind = kind; }
}

// A hook set that throws an injected crash at one point of one kind (the nth time it is reached).
export function crashAt(point, kind, nth = 1) {
    let seen = 0;
    return { [point]: (info) => { if (info.kind === kind && ++seen === nth) throw new InjectedCrash(point, kind); } };
}

export async function createLedgerRig(t, { keeperOptions = {}, faults = {}, robotAttempt = true } = {}) {
    const dir = makeTempDir(t);
    const rig = { dir, context: syntheticContext(), clock: createModelClock(), violations: [], events: [] };
    rig.world = createModelWorld({ clock: rig.clock });
    rig.keeper = createModelKeeper(rig.world, keeperOptions);
    let store = openStore(dir);
    let closed = false;
    t.after(() => { if (!closed) { try { store.close(); } catch { /* already closed */ } } });
    Object.defineProperty(rig, 'store', { get: () => store });
    rig.robotId = readyRobot(store, rig.context);
    rig.admitted = store.admit(rig.context, admitRequest(rig.robotId, {}, rig.context));
    store.transitionAttempt({ executionId: rig.admitted.executionId, attemptId: rig.admitted.attemptId, expectedState: 'queued', nextState: 'running' });

    // The invariant behind "no workload executes before commit": at the moment a process runs its final exec, its
    // reservation is durably committed in the store.
    rig.world.onExecute((entry) => {
        let state = null;
        try { state = store.getResource({ resourceId: entry.marker }).state; } catch { /* unknown reservation */ }
        rig.events.push(`execute:${entry.role}:${state}`);
        if (state !== 'committed') rig.violations.push(`${entry.role} executed while its reservation was ${state}`);
    });

    // The model's own truth, to compare with what the walker concluded: when a blocker is recorded `released`, the
    // object it names must really be gone from the model at that moment. A walker or ledger that releases on a wrong
    // proof is reported here, whatever the end state of the model turns out to be.
    rig.truth = (resourceId) => {
        const record = store.getResource({ resourceId });
        const alive = rig.world.alive();
        const model = rig.keeper.model;
        const problems = [];
        const check = (condition, text) => { if (!condition) problems.push(`${record.kind} released while ${text}`); };
        if (['keeper', 'endpoint', 'process-tree'].includes(record.kind)) {
            if (record.identity === null) check(!alive.some((entry) => entry.cmdline.includes(record.locator.marker)), 'a process still carried its marker');
            else {
                check(!alive.some((entry) => entry.pid === record.identity.pid && entry.startTime === record.identity.startTime), 'its process was alive');
                if (record.identity.pidNs !== undefined) check(!alive.some((entry) => entry.pidNs === record.identity.pidNs), 'its namespace still had a member');
            }
        } else if (record.kind === 'netns') check(model.netns.every((inode) => !rig.world.namespaceExists(inode)), 'a network namespace existed');
        else if (record.kind === 'mount') check(model.mntns.every((inode) => !rig.world.namespaceExists(inode)) && model.mounts.every((mount) => !rig.world.mounts().some((m) => m.mountId === mount.mountId)), 'a mount or mount namespace existed');
        else if (record.kind === 'veth') check(!rig.world.objects.veth.has(record.locator.host), 'the veth existed');
        else if (record.kind === 'nft-table') check(!rig.world.objects['nft-table'].has(record.locator.table), 'the table existed');
        else if (['runtime-dir', 'cgroup'].includes(record.kind)) check(!rig.world.objects[record.kind].has(record.locator.path), 'the directory existed');
        else if (record.kind === 'pty') check(!rig.world.objects.pty.has(record.locator.pty), 'the pty existed');
        else if (record.kind === 'gui-container') check(!rig.world.objects['gui-container'].has(record.locator.name), 'the container existed');
        rig.violations.push(...problems);
        return problems;
    };
    const withTruth = (hooks) => ({
        ...hooks,
        afterRelease: async (info) => { if (info.outcome === 'released') rig.truth(info.resourceId); await hooks.afterRelease?.(info); }
    });

    // The keeper's own record, found through the reservation ID every dependent carries in its locator, whatever the
    // keeper's release state (a quarantined keeper is still a keeper).
    // A lookup that fails throws: the walker treats an unreadable record as unprovable, never as an absent keeper.
    const sandboxRecord = (blocker) => store.getResource({ resourceId: blocker.locator.keeper });
    rig.walker = () => createWalker({ view: rig.world.view, clock: rig.clock, releaseDeadlineMs: RELEASE_DEADLINE_MS, pollMs: POLL_MS, sandboxRecord });
    rig.ledger = (overrides = {}) => createExecutionLedger({
        state: store, context: rig.context, robotId: rig.robotId, executionId: rig.admitted.executionId, attemptId: rig.admitted.attemptId,
        referenceId: rig.admitted.reference.id, layout: LAYOUT, sandbox: rig.keeper, walker: rig.walker(), clock: rig.clock, ...overrides,
        faults: withTruth(overrides.faults ?? faults)
    });
    rig.reference = () => store.getReference(rig.context, { referenceId: rig.admitted.reference.id });
    rig.blockers = () => rig.store.listUnsettledResources();
    rig.allStates = () => {
        const out = {};
        for (const resource of rig.resourceIds ?? []) out[resource] = store.getResource({ resourceId: resource }).state;
        return out;
    };

    // The supervisor dies and a new one opens the same store. The old handle is dropped without a clean shutdown.
    rig.restartSupervisor = (options) => {
        rig.world.crashSupervisor(options);
        store.close();
        store = openStore(dir, { create: false });
    };

    // Generation recovery with a spy that records, after every settlement, whether a result is already published.
    rig.recover = async () => {
        const published = [];
        // A wrapper, not a prototype copy: the S1 handle keeps its state in private fields.
        const proxy = {
            get generationId() { return store.generationId; },
            beginGenerationRecovery: (generation) => store.beginGenerationRecovery(generation),
            listUnsettledResources: () => store.listUnsettledResources(),
            completeGenerationRecovery: (generation) => store.completeGenerationRecovery(generation),
            settleResource: (request) => {
                const outcome = store.settleResource(request);
                if (request.outcome === 'released') rig.truth(request.resourceId);
                published.push({ resourceId: request.resourceId, outcome: request.outcome, resultPublished: rig.reference().result !== null });
                return outcome;
            }
        };
        const recovered = await recoverGeneration({ state: proxy, walker: rig.walker() });
        return { ...recovered, published };
    };
    return rig;
}

// Publishes the full set of resources of one execution in dependency order. Returns what was published, by kind.
export async function publishAll(ledger) {
    const out = [];
    for (const [kind, extra] of [['keeper'], ['runtime-dir'], ['cgroup'], ['netns'], ['veth'], ['nft-table'], ['mount'], ['endpoint'],
        ['process-tree'], ['process-tree'], ['pty']]) {
        out.push(await ledger.publish({ kind, extra }));
    }
    return out;
}
