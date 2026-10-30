import assert from 'node:assert/strict';
import test from 'node:test';

import { createExecutionLedger } from '../../server/execution/resourceLedger.mjs';
import { createWalker } from '../../server/execution/recoveryWalk.mjs';
import { LIMITS, WORKSPACE, admitRequest, makeTempDir, openStore, readyRobot, syntheticContext } from '../helpers/synthetic.mjs';

// Reviewer risk after 8e80acf9 ("a workload whose exit is observed is released and unpinned at once"): the supervisor then forgets that
// workload (`trees.delete`, `workloads.delete`), so the end path's `endProcessTrees` no longer touches it. Its ledger row, published
// through ledger.publish at the workload's start, must still settle `released` at the end path. It does: the ledger never learns
// about the early release; step 2 walks every unsettled process-tree row through the walker, which proves absence from /proc
// (identity pid + start time, then every member of the recorded PID namespace). Here the walker's view has no process at all.
const ROBOTS = `workspace:${WORKSPACE}`;
const LIMITS_X = Object.freeze({ ...LIMITS, admissions: 16, receipts: 128 });

test('rows of workloads that finished early (unknown to the supervisor) settle released at the end path, and the attempt publishes cleanup released', async (t) => {
    const store = openStore(makeTempDir(t), { limits: LIMITS_X });
    t.after(() => store.close());
    const robotId = readyRobot(store, syntheticContext({ robotOwnerId: ROBOTS, scope: 'scope-robots' }));
    const alice = syntheticContext({ originNamespace: 'coordinator:agent:fixtures/roboteam', originKey: 'owner:user:alice', ownerId: 'user:alice', scope: 'scope-co-alice', robotOwnerId: ROBOTS });
    const admitted = store.admit(alice, admitRequest(robotId, {}, alice));
    store.transitionAttempt({ executionId: admitted.executionId, attemptId: admitted.attemptId, expectedState: 'queued', nextState: 'running' });

    const adapter = syntheticContext({ scope: 'scope-adapter' });
    const clock = { now: () => Date.now(), sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)) };
    const view = { listProcesses: () => [], listMounts: () => [], exists: () => false, kill: () => false, remove: () => true, unmount: () => false };
    const walker = createWalker({ view, clock, releaseDeadlineMs: 500, pollMs: 5, sandboxRecord: (blocker) => store.getResource({ resourceId: blocker.locator.keeper }) });
    let counter = 0;
    const identities = {
        keeper: () => ({ pid: 100, startTime: '1' }), 'runtime-dir': () => ({ path: '/rt', dev: '1', ino: '1' }),
        'process-tree': () => { counter += 1; return { pid: 1000 + counter, startTime: String(counter), pidNs: `pid${counter}`, mntNs: `mnt${counter}`, netNs: 'net', stageMntNs: `stage${counter}`, init: { pid: 2000 + counter, startTime: '5' } }; }
    };
    const calls = [];
    // The supervisor's side: it has already released and forgotten every workload, so each end step is a no-op for them.
    const sandbox = {
        create: async ({ kind }) => ({ identity: identities[kind](), gate: null, handle: null }),
        alive: () => true, abortUncommitted: async () => {},
        endProcessTrees: async () => { calls.push('endProcessTrees'); }, endEndpoint: async () => {}, releaseEgress: async () => {},
        releaseViews: async () => {}, removeRuntime: async () => { calls.push('removeRuntime'); }, exit: async () => {}
    };
    const ledger = createExecutionLedger({
        state: store, context: adapter, robotId, executionId: admitted.executionId, attemptId: admitted.attemptId, referenceId: null,
        layout: { runtimeDir: '/rt-root', cgroupSubtree: '/cg' }, sandbox, walker, clock
    });
    await ledger.startKeeper();
    await ledger.publish({ kind: 'runtime-dir' });
    for (let workload = 0; workload < 3; workload += 1) await ledger.publish({ kind: 'process-tree', spec: { role: 'workload' } });
    assert.equal(store.listUnsettledResources().filter((entry) => entry.kind === 'process-tree').length, 3, 'committed rows stay unsettled until the end path');

    const ended = await ledger.endExecution({ classification: 'completed', outputText: 'ok' });
    assert.deepEqual(store.listUnsettledResources(), [], 'nothing is left unsettled');
    assert.deepEqual(ended.releaseLog.filter((entry) => entry.kind === 'process-tree').map((entry) => entry.outcome), ['released', 'released', 'released']);
    assert.deepEqual(store.observeReference(alice, { referenceId: admitted.reference.id }).result, { status: 'completed', cleanup: 'released', outputText: 'ok', data: null });
});
