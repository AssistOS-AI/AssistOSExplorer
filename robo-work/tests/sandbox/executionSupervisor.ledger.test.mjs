// The supervisor against the REAL resource ledger, walker and S1 store: the seam contract (create, gate, commit, end steps),
// with the sandboxes, the network and /proc faked. Nothing here is Linux evidence; the live smoke is.
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import test from 'node:test';

import { createExecutionLedger } from '../../server/execution/resourceLedger.mjs';
import { createWalker } from '../../server/execution/recoveryWalk.mjs';
import { createExecutionSupervisor, createRecoveryView, sandboxRecordFor } from '../../server/sandbox/executionSupervisor.mjs';
import { admitRequest, makeTempDir, openStore, readyRobot, syntheticContext } from '../helpers/synthetic.mjs';
import { SUPERVISOR_PID, createFakeView } from './helpers/fakes.mjs';

const clock = () => { let now = 0; return { now: () => now, sleep: async (ms) => { now += ms; } }; };

async function rig(t, { launchHook = null } = {}) {
    const dir = makeTempDir(t);
    const context = syntheticContext();
    const store = openStore(dir);
    t.after(() => { try { store.close(); } catch { /* closed */ } });
    const robotId = readyRobot(store, context);
    const admitted = store.admit(context, admitRequest(robotId, {}, context));
    store.transitionAttempt({ executionId: admitted.executionId, attemptId: admitted.attemptId, expectedState: 'queued', nextState: 'running' });

    const runtimeBase = fs.mkdtempSync(path.join(os.tmpdir(), 'rw-ledger-'));
    t.after(() => fs.rmSync(runtimeBase, { recursive: true, force: true }));
    const view = createFakeView();
    view.listMounts = () => [];
    view.exists = (kind, locator) => (kind === 'runtime-dir' ? fs.existsSync(locator.path) : true);
    view.remove = (kind, locator) => { if (kind === 'runtime-dir') { fs.rmSync(locator.path, { recursive: true, force: true }); return true; } return false; };
    view.kill = ({ pid, startTime }) => { const entry = view.procs.get(pid); if (entry?.startTime === startTime) { view.drop(pid); return true; } return false; };
    view.unmount = () => false;
    const recoveryView = createRecoveryView(view, { runSync: () => ({ status: 0, stdout: '1: lo: <>\n', stderr: '' }), exists: () => false });

    const spawns = [];
    const spawnImpl = (file, args) => {
        const child = new EventEmitter();
        child.pid = 6000 + spawns.length;
        child.stdin = new PassThrough();
        child.kill = () => { view.drop(child.pid); setImmediate(() => child.emit('exit', null, 'SIGKILL')); return true; };
        view.add({ pid: child.pid, ppid: SUPERVISOR_PID, cmdline: ['/bin/sh', '-c', 'x', 'rw-anchor', args.at(-1)] });
        spawns.push(child);
        return child;
    };
    const sandboxes = [];
    const launcher = {
        launch: async (spec) => {
            if (launchHook) await launchHook(spec);
            const pid = 7000 + sandboxes.length * 10;
            const sandbox = {
                role: spec.role, identity: { pid, startTime: String(pid), pidNs: String(900000 + pid), mntNs: '1', netNs: '2', stageMntNs: '3', init: { pid: pid + 1, startTime: '1' } },
                stdio: [new PassThrough(), new PassThrough(), new PassThrough()], channel: new PassThrough(), stops: 0, releases: 0, committed: false,
                gate: { commit: async () => { sandbox.committed = true; return true; }, abort: async () => {} },
                stop: async () => { sandbox.stops += 1; view.drop(pid); return { absent: true, problems: [] }; },
                release: async () => { sandbox.releases += 1; },
                onExit: () => {}, wait: async () => ({ code: 0, signal: null, exitCode: 0 })
            };
            view.add({ pid, startTime: String(pid), cmdline: ['bwrap', spec.marker], pidNs: '1000', mntNs: '2000' });
            sandboxes.push(sandbox);
            return sandbox;
        }
    };
    let networks = 0;
    const network = {
        name: 'rw0123456789abcdef', nsPath: '/run/netns/rw0123456789abcdef', hostVeth: 'rw0123456789h', peerVeth: 'rw0123456789n', table: 'rw_0123456789abcdef', subnet: '10.213.0.0/30',
        setup: async () => { networks += 1; }, release: async () => {}, verifyAbsent: async () => ({ absent: true, problems: [] }), nsInode: () => '4026539999'
    };
    const fd = fs.openSync(runtimeBase, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY);
    t.after(() => fs.closeSync(fd));
    const supervisor = createExecutionSupervisor({
        launcher, view, createNetwork: () => network, spawnImpl, clock: clock(), supervisorPid: SUPERVISOR_PID,
        admission: { inventory: [{ name: 'codex' }], streamDirectory: '/stream' },
        roles: { orchestration: { argv: ['node'], roBinds: [] }, endpoint: { argv: ['node'], roBinds: [] }, workload: { roBinds: [] } },
        home: { path: runtimeBase, fd }, grants: [{ name: 'a', path: '/projects/a', hostPath: runtimeBase, access: 'write', fd }], limits: { killWaitMs: 20 }
    });
    const layout = { runtimeDir: `${runtimeBase}/rt`, cgroupSubtree: null };
    const walker = createWalker({ view: recoveryView, clock: clock(), releaseDeadlineMs: 5000, pollMs: 250, sandboxRecord: sandboxRecordFor(() => store) });
    const ledger = createExecutionLedger({
        state: store, context, robotId, executionId: admitted.executionId, attemptId: admitted.attemptId, referenceId: admitted.reference.id,
        layout, sandbox: supervisor, walker, clock: clock()
    });
    return { store, ledger, supervisor, view, sandboxes, spawns, network, networks: () => networks, layout, admitted, context };
}

async function publishAll(world, { workload = false } = {}) {
    const { ledger } = world;
    await ledger.startKeeper();
    await ledger.publish({ kind: 'runtime-dir' });
    await ledger.publish({ kind: 'netns' });
    await ledger.publish({ kind: 'veth' });
    await ledger.publish({ kind: 'nft-table' });
    await ledger.publish({ kind: 'mount' });
    await ledger.publish({ kind: 'endpoint', spec: { config: {} } });
    await ledger.publish({ kind: 'process-tree', spec: { role: 'orchestration' } });
    if (workload) {
        const request = { processClass: 'run', executable: 'codex', args: [], env: {}, home: '/home/robot', cwd: '/projects/a', folders: [{ path: '/projects/a', access: 'write' }], exclusions: [], network: 'none', requirements: { privateProc: true }, communication: { kind: 'stdio', stdin: 'ignore' } };
        await ledger.publish({ kind: 'process-tree', spec: { role: 'workload', process: 1, request, streams: {} } });
    }
}

test('the real ledger publishes a whole execution through the supervisor: every blocker commits before its gate opens', async (t) => {
    const world = await rig(t);
    await publishAll(world);
    const kinds = world.store.listUnsettledResources().map((entry) => entry.kind).sort();
    assert.deepEqual(kinds, ['endpoint', 'keeper', 'mount', 'netns', 'nft-table', 'process-tree', 'runtime-dir', 'veth']);
    assert.ok(world.store.listUnsettledResources().every((entry) => entry.identity !== null), 'every identity was committed');
    assert.ok(world.sandboxes.every((sandbox) => sandbox.committed), 'every gate was opened');
    const keeper = world.store.listUnsettledResources().find((entry) => entry.kind === 'keeper');
    assert.deepEqual(Object.keys(keeper.identity).sort(), ['pid', 'startTime']);
    const tree = world.store.listUnsettledResources().find((entry) => entry.kind === 'process-tree');
    assert.equal(tree.identity.pidNs, '907010', 'the sandbox pid namespace, not the monitor\'s, is what is recorded');
    assert.equal(tree.locator.keeper, keeper.resourceId);
});

test('the real end path in section 5.5 order releases every blocker, kills the anchor last, and removes the runtime directory', async (t) => {
    const world = await rig(t);
    await publishAll(world, { workload: false });
    const result = await world.ledger.endExecution({ classification: 'completed' });
    assert.deepEqual(world.store.listUnsettledResources(), []);
    assert.ok(result.releaseLog.every((entry) => entry.outcome === 'released'), JSON.stringify(result.releaseLog));
    const order = result.releaseLog.map((entry) => entry.kind);
    assert.ok(order.indexOf('process-tree') < order.indexOf('endpoint') && order.indexOf('endpoint') < order.indexOf('netns') && order.indexOf('netns') < order.indexOf('runtime-dir') && order.indexOf('runtime-dir') < order.indexOf('keeper'), order.join(','));
    assert.ok(world.sandboxes.every((sandbox) => sandbox.stops >= 1 && sandbox.releases >= 1));
    assert.equal(world.supervisor.runtimeDir, null);
    assert.equal(world.supervisor.alive(), false);
});

test('a creation that fails before commit (the launch is refused) leaves nothing unsettled that the end path cannot prove, and aborts through the gate', async (t) => {
    let calls = 0;
    const world = await rig(t, { launchHook: async (spec) => { calls += 1; if (spec.role === 'endpoint') throw Object.assign(new Error('boom'), { code: 'mask_unverified' }); } });
    await world.ledger.startKeeper();
    await world.ledger.publish({ kind: 'runtime-dir' });
    await world.ledger.publish({ kind: 'netns' });
    await assert.rejects(world.ledger.publish({ kind: 'endpoint', spec: { config: {} } }), { code: 'mask_unverified' });
    assert.equal(calls, 1);
    await world.ledger.endExecution({ classification: 'failed' });
    assert.deepEqual(world.store.listUnsettledResources(), []);
});
