import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { createExecutionKeeper } from '../../server/execution/keeperClient.mjs';
import { toLedgerIdentity } from '../../server/execution/keeperFrames.mjs';
import { createProcView } from '../../server/execution/procView.mjs';
import { createWalker, recoverGeneration } from '../../server/execution/recoveryWalk.mjs';
import { createExecutionLedger } from '../../server/execution/resourceLedger.mjs';
import { deriveLocator } from '../../server/execution/resourceLocators.mjs';
import { admitRequest, makeTempDir, openStore, readyRobot, syntheticContext } from '../helpers/synthetic.mjs';
import { VALID_START } from './helpers/endpointRig.mjs';
import { createFakeKeeperHost, createFakeWorld } from './helpers/fakeKeeperProcess.mjs';

// The keeper client wired to the REAL S1 store (temporary database), the REAL resource ledger and the REAL recovery walk,
// with the production procView over a FAKE /proc and a FAKE keeper process (keeper wire contract delta AC-5, AC-6, AC-7,
// AC-18 and R1). Unit evidence only: the fake keeper creates no namespace, pty or mount; G1 proves the kernel side.

const TEST_LIMITS = Object.freeze({ requestDeadlineMs: 1500, createDeadlineMs: 1500, keeperExitWaitMs: 150, pingIntervalMs: 200, helloDeadlineMs: 5000 });
const TEST_VIEW_LIMITS = Object.freeze({ rootLeaseRenewMs: 100, rootLeaseTtlMs: 1000, rootRevokeGraceMs: 100, rootRevokeVerifyMs: 100 });
const sortKeys = (value) => (Array.isArray(value) ? value.map(sortKeys)
    : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortKeys(value[key])])) : value);
const canonical = (value) => JSON.stringify(sortKeys(value));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const realClock = Object.freeze({ now: () => performance.now(), sleep });
const handleToId = (handle) => Buffer.from(handle, 'hex').toString('base64url');
const newId = () => crypto.randomBytes(16).toString('base64url');

async function waitFor(condition, timeoutMs = 3000) {
    const until = Date.now() + timeoutMs;
    while (Date.now() < until) { if (condition()) return true; await sleep(10); }
    return condition();
}

async function rig(t, { host: hostOptions = {}, limits = {}, releaseDeadlineMs = 1000, pollMs = 20, grants = 0, delegated = true } = {}) {
    const world = createFakeWorld(t);
    const host = await createFakeKeeperHost(t, world, hostOptions);
    const dir = makeTempDir(t);
    let store = openStore(dir);
    t.after(() => { try { store.close(); } catch { /* closed */ } });
    const context = syntheticContext();
    const robotId = readyRobot(store, context);
    const admitted = store.admit(context, admitRequest(robotId, {}, context));
    store.transitionAttempt({ executionId: admitted.executionId, attemptId: admitted.attemptId, expectedState: 'queued', nextState: 'running' });
    // The production wiring of the two resolvers (R1.1): S1's own records, read at each call.
    const keeperRecord = (blocker) => store.getResource({ resourceId: blocker.locator.keeper });
    const identityForLocator = (kind, locator) => {
        const found = store.listUnsettledResources().find((blocker) => blocker.kind === kind && canonical(blocker.locator) === canonical(locator));
        if (!found) throw new Error('no blocker for this locator');
        return found.identity;
    };
    const view = createProcView({
        procRoot: world.procRoot, signal: world.signal, statfs: world.statfs, runtimeRoot: world.runtimeRoot, cgroupSubtree: delegated ? world.cgroupSubtree : null,
        identityForLocator, keeperRecord, containerDevpts: '/dev'
    });
    const walker = createWalker({ view, clock: realClock, releaseDeadlineMs, pollMs, keeperRecord });
    const grantRoots = Array.from({ length: grants }, (_, index) => world.openDir(t, `grant${index}`));
    const losses = [];
    const client = createExecutionKeeper({
        executable: host.executable, scope: 'execution', runtimeRoot: world.runtimeRoot, cgroupSubtree: delegated ? world.cgroupSubtree : null, view,
        grantRoots: grantRoots.map(({ fd, identity }) => ({ fd, identity })), limits: { ...TEST_LIMITS, ...limits }, viewLimits: TEST_VIEW_LIMITS,
        verifyGrant: async () => ({ state: 'bound' }), onInfrastructureLoss: (reason) => losses.push(reason)
    });
    const layout = { runtimeDir: world.runtimeRoot, cgroupSubtree: delegated ? world.cgroupSubtree : null };
    const ledger = createExecutionLedger({
        state: store, context, robotId, executionId: admitted.executionId, attemptId: admitted.attemptId, referenceId: admitted.reference.id,
        layout, keeper: client, walker, clock: realClock
    });
    t.after(() => { try { host.latest()?.kill(); } catch { /* gone */ } });
    const out = { world, host, store: () => store, view, walker, client, ledger, losses, admitted, layout, keeperRecord, grantRoots };
    out.blocker = (resourceId) => store.listUnsettledResources().find((entry) => entry.resourceId === resourceId) ?? store.getResource({ resourceId });
    out.reopen = () => { store.close(); store = openStore(dir, { create: false }); return store; };
    // A blocker reserved and committed in S1 directly, with an identity from toLedgerIdentity: the walk-time type check
    // of procView in isolation (N-C), with no keeper and no client verification in the way.
    out.direct = (kind, wire, { processBearing = false } = {}) => {
        const locator = { ...deriveLocator(kind, crypto.randomBytes(16).toString('hex'), layout), keeper: newId() };
        const { resourceId } = store.reserveResource({ kind, locator, robotId, executionId: admitted.executionId, attemptId: admitted.attemptId, processBearing });
        store.commitResource({ resourceId, identity: toLedgerIdentity(kind, wire) });
        return store.getResource({ resourceId });
    };
    return out;
}

const endpointSpec = (netns) => ({ netns, config: { limits: { maxProcesses: 8 }, streamDirectory: '/run/endpoint/streams', relays: [] } });
const workloadSpec = (netns, process = 1) => ({ role: 'workload', process, request: { ...VALID_START }, streams: { stdout: '/run/endpoint/streams/a' }, netns });
const mountSpec = (grant) => ({ grantId: 'proj', rootSlot: 8, expectedRootIdentity: grant.identity, access: 'write', descriptorCap: 1024, rlimitNofile: 4096 });

test('a ledger layout that disagrees with the client subtree stays quarantined', async (t) => {
    const r = await rig(t, { releaseDeadlineMs: 100 });
    await r.ledger.startKeeper();
    r.layout.cgroupSubtree = `${r.world.cgroupSubtree}-other`;
    fs.mkdirSync(r.layout.cgroupSubtree);
    await assert.rejects(r.ledger.publish({ kind: 'cgroup' }), (error) => error.code === 'bad_request');
    assert.equal(r.host.latest().frames.some(({ frame }) => frame.op === 'create' && frame.kind === 'cgroup'), false);
    const blocker = r.store().listUnsettledResources().find((entry) => entry.kind === 'cgroup');
    assert.ok(blocker);
    await r.ledger.endExecution({ classification: 'failed' });
    assert.equal(r.blocker(blocker.resourceId).state, 'quarantined');
});

test('undelegated publish reserves nothing', async (t) => {
    const r = await rig(t, { delegated: false });
    await r.ledger.startKeeper();
    await assert.rejects(r.ledger.publish({ kind: 'cgroup' }), /cgroupSubtree must be a normalized absolute path/u);
    assert.equal(r.store().listUnsettledResources().some((entry) => entry.kind === 'cgroup'), false);
    assert.equal(r.host.latest().frames.some(({ frame }) => frame.op === 'create' && frame.kind === 'cgroup'), false);
});

test('recovery quarantines a cgroup blocker under the previous subtree', async (t) => {
    const r = await rig(t, { releaseDeadlineMs: 100 });
    await r.ledger.startKeeper();
    const made = await r.ledger.publish({ kind: 'cgroup' });
    r.host.latest().onEof();
    assert.equal(await waitFor(() => r.host.latest().gone), true);
    const next = `${r.world.cgroupSubtree}-next`;
    fs.mkdirSync(next);
    const store = r.reopen();
    const keeperRecord = (blocker) => store.getResource({ resourceId: blocker.locator.keeper });
    const view = createProcView({ procRoot: r.world.procRoot, signal: r.world.signal, runtimeRoot: r.world.runtimeRoot, cgroupSubtree: next,
        statfs: () => ({ type: 0x63677270 }), keeperRecord });
    const walker = createWalker({ view, clock: realClock, releaseDeadlineMs: 100, pollMs: 20, keeperRecord });
    const recovered = await recoverGeneration({ state: store, walker });
    assert.equal(recovered.outcomes.find((entry) => entry.kind === 'cgroup').outcome, 'quarantined');
    assert.equal(store.getResource({ resourceId: made.resourceId }).state, 'quarantined');
});

// ---- AC-5 -------------------------------------------------------------------------------------------------------------

test('commit before gate', async (t) => {
    const seen = [];
    let store = null;
    const r = await rig(t, {
        grants: 1,
        host: {
            // Synchronous at the moment the keeper receives the frame; its reply follows only after this returns.
            onRequest: (frame) => {
                if (frame.op === 'commit_keeper') {
                    const keeper = store().listUnsettledResources().find((entry) => entry.kind === 'keeper');
                    seen.push({ kind: 'keeper', resourceId: keeper.resourceId, state: keeper.state });
                }
                return undefined;
            },
            onCommitReceived: (frame) => {
                if (frame.resource.startsWith('m')) {
                    const found = store().listUnsettledResources().find((entry) => entry.identity?.resource === frame.resource);
                    seen.push({ kind: 'mount', resourceId: found?.resourceId ?? null, state: found?.state ?? 'not committed' });
                    return;
                }
                const resourceId = handleToId(frame.resource);
                seen.push({ kind: store().getResource({ resourceId }).kind, resourceId, state: store().getResource({ resourceId }).state });
            }
        }
    });
    store = r.store;
    // Publication errors are collected, not thrown, so that the ordering assertion below is the one that decides.
    const errors = [];
    const publish = async (request) => { try { return await r.ledger.publish(request); } catch (error) { errors.push(`${request.kind}: ${error.code ?? error.message}`); return null; } };
    await publish({ kind: 'keeper' });
    await publish({ kind: 'runtime-dir' });
    await publish({ kind: 'cgroup' });
    const netns = await publish({ kind: 'netns' });
    await publish({ kind: 'pty', spec: { cols: 80, rows: 24 } });
    await publish({ kind: 'mount', spec: mountSpec(r.grantRoots[0]) });
    await publish({ kind: 'endpoint', spec: endpointSpec(netns?.handle ?? 'f'.repeat(32)) });
    await publish({ kind: 'process-tree', spec: workloadSpec(netns?.handle ?? 'f'.repeat(32)) });
    for (const observed of seen) {
        assert.equal(observed.state, 'committed', `${observed.kind}: S1 shows the identity committed before the keeper receives its commit`);
    }
    assert.deepEqual(errors, []);
    assert.deepEqual(seen.map((entry) => entry.kind), ['keeper', 'runtime-dir', 'cgroup', 'netns', 'pty', 'mount', 'endpoint', 'process-tree']);
    assert.deepEqual(r.losses, []);
});

// ---- AC-6 -------------------------------------------------------------------------------------------------------------

test('identity round trip per kind', async (t) => {
    await t.test('keeper', async (sub) => {
        const r = await rig(sub);
        const keeper = await r.ledger.startKeeper();
        const blocker = r.blocker(keeper.resourceId);
        assert.equal(r.walker.prove(blocker).absent, false);
        r.world.removeProcess(keeper.identity.pid);
        assert.equal(r.walker.prove(blocker).absent, true);
    });
    await t.test('endpoint and process-tree through the client', async (sub) => {
        const r = await rig(sub);
        await r.ledger.startKeeper();
        const netns = await r.ledger.publish({ kind: 'netns' });
        for (const [kind, spec] of [['endpoint', endpointSpec(netns.handle)], ['process-tree', workloadSpec(netns.handle)]]) {
            const published = await r.ledger.publish({ kind, spec });
            const blocker = r.blocker(published.resourceId);
            assert.equal(r.walker.prove(blocker).absent, false, kind);
            r.world.removeProcess(published.identity.pid);
            assert.equal(r.walker.prove(blocker).absent, true, kind);
        }
    });
    await t.test('process-tree: double-forked member', async (sub) => {
        const r = await rig(sub);
        const pidNs = r.world.newInode();
        const blocker = r.direct('process-tree', { pid: 400001, startTime: '1001', pidNs }, { processBearing: true });
        // The init is gone; a double-forked member with another pid stays in the same PID namespace.
        r.world.writeProcess({ pid: 400002, ppid: 1, startTime: '1002', pidNs, cmdline: ['/bin/daemon'] });
        assert.equal(r.walker.prove(blocker).absent, false);
        r.world.removeProcess(400002);
        assert.equal(r.walker.prove(blocker).absent, true);
    });
    await t.test('netns through the client', async (sub) => {
        const r = await rig(sub);
        await r.ledger.startKeeper();
        const netns = await r.ledger.publish({ kind: 'netns' });
        const blocker = r.blocker(netns.resourceId);
        assert.equal(r.walker.prove(blocker).absent, false);
        const entry = r.host.latest().handleFor('netns');
        r.world.removeFd(r.host.latest().pid, entry.fd);
        assert.equal(r.walker.prove(blocker).absent, true);
    });
    await t.test('netns: fd-link holder only', async (sub) => {
        const r = await rig(sub);
        const netNs = r.world.newInode();
        const blocker = r.direct('netns', { netNs });
        // A holder that is not a member (its own ns/net is the supervisor's): only the descriptor link names the inode.
        r.world.writeProcess({ pid: 400010, ppid: 1, startTime: '1010', cmdline: ['/bin/holder'] });
        r.world.addFd(400010, 9, `net:[${netNs}]`);
        assert.equal(r.walker.prove(blocker).absent, false);
        r.world.removeFd(400010, 9);
        assert.equal(r.walker.prove(blocker).absent, true);
    });
    await t.test('netns: nsfs mount only', async (sub) => {
        const r = await rig(sub);
        const netNs = r.world.newInode();
        const blocker = r.direct('netns', { netNs });
        r.world.appendSelfMount(`60 22 0:4 net:[${netNs}] /run/netns/x rw - nsfs nsfs rw\n`);
        assert.equal(r.walker.prove(blocker).absent, false);
        r.world.writeSelfMountinfo('22 1 0:21 / / rw - apfs /dev/root rw\n');
        assert.equal(r.walker.prove(blocker).absent, true);
    });
    await t.test('runtime-dir and cgroup through the client', async (sub) => {
        const r = await rig(sub);
        await r.ledger.startKeeper();
        for (const kind of ['runtime-dir', 'cgroup']) {
            const published = await r.ledger.publish({ kind });
            const blocker = r.blocker(published.resourceId);
            assert.equal(r.walker.prove(blocker).absent, false, kind);
            fs.rmSync(published.identity.path, { recursive: true });
            assert.equal(r.walker.prove(blocker).absent, true, kind);
        }
    });
    await t.test('pty, committed, through the client', async (sub) => {
        const r = await rig(sub);
        await r.ledger.startKeeper();
        const pty = await r.ledger.publish({ kind: 'pty', spec: { cols: 80, rows: 24 } });
        const blocker = r.blocker(pty.resourceId);
        assert.equal(r.walker.prove(blocker).absent, false);
        r.world.removeFd(r.host.latest().pid, r.host.latest().handleFor('pty').fd);
        assert.equal(r.walker.prove(blocker).absent, true);
    });
    await t.test('mount through the client', async (sub) => {
        const r = await rig(sub, { grants: 1 });
        await r.ledger.startKeeper();
        await r.ledger.publish({ kind: 'runtime-dir' });
        const mount = await r.ledger.publish({ kind: 'mount', spec: mountSpec(r.grantRoots[0]) });
        const blocker = r.blocker(mount.resourceId);
        assert.equal(typeof blocker.identity.mountId, 'number');
        assert.equal(r.walker.prove(blocker).absent, false, 'mountinfo line plus the mnt:[N] holders');
        const keeper = r.host.latest();
        r.world.removeProcess(mount.identity.fileServer.pid);
        r.world.removeFd(keeper.pid, keeper.mntFd);
        assert.equal(r.walker.prove(blocker).absent, true);
    });
    await t.test('mount: mountinfo line only', async (sub) => {
        const r = await rig(sub, { grants: 1 });
        await r.ledger.startKeeper();
        await r.ledger.publish({ kind: 'runtime-dir' });
        const mount = await r.ledger.publish({ kind: 'mount', spec: mountSpec(r.grantRoots[0]) });
        const blocker = r.blocker(mount.resourceId);
        const keeper = r.host.latest();
        r.world.removeProcess(mount.identity.fileServer.pid);
        r.world.removeFd(keeper.pid, keeper.mntFd);
        // No namespace holder is left; only the mount itself is still visible, by mount ID and mountpoint.
        r.world.appendSelfMount(`${mount.identity.mountId} 22 0:91 / ${mount.identity.mountpoint} rw - fuse.rw-view rw-view rw\n`);
        assert.equal(r.walker.prove(blocker).absent, false);
        r.world.writeSelfMountinfo('22 1 0:21 / / rw - apfs /dev/root rw\n');
        assert.equal(r.walker.prove(blocker).absent, true);
    });
});

// ---- AC-7 (R1.5, corrected per N-F) -----------------------------------------------------------------------------------

test('hung keeper', { timeout: 3 * (500 + 300 + 1000) }, async (t) => {
    const REQUEST_DEADLINE = 500;
    const RELEASE_DEADLINE = 300;
    const r = await rig(t, {
        limits: { requestDeadlineMs: REQUEST_DEADLINE, createDeadlineMs: 1500, keeperExitWaitMs: 100 },
        releaseDeadlineMs: RELEASE_DEADLINE, pollMs: 20,
        host: { onRequest: (frame) => (frame.op === 'end_process_trees' ? 'ignore' : undefined) }
    });
    await r.ledger.startKeeper();
    await r.ledger.publish({ kind: 'runtime-dir' });
    const netns = await r.ledger.publish({ kind: 'netns' });
    await r.ledger.publish({ kind: 'endpoint', spec: endpointSpec(netns.handle) });
    const treeA = await r.ledger.publish({ kind: 'process-tree', spec: workloadSpec(netns.handle, 1) });
    const treeB = await r.ledger.publish({ kind: 'process-tree', spec: workloadSpec(netns.handle, 2) });
    // Process-tree B is a stuck workload: it ignores SIGKILL and survives the keeper. It stays a member of the execution
    // network namespace, so that namespace cannot be proven absent either (N-F).
    r.world.stubborn.add(treeB.identity.pid);
    r.world.keepOnKeeperExit.add(treeB.identity.pid);
    // Instrumentation: when each walk starts and ends, and how fast each client action rejects after the violation.
    const walks = [];
    const realWalk = r.walker.walk;
    r.walker.walk = async (blocker, options) => {
        const entry = { kind: blocker.kind, started: performance.now() };
        walks.push(entry);
        try { return await realWalk(blocker, options); } finally { entry.ended = performance.now(); }
    };
    const actionTimes = [];
    for (const name of ['endEndpoint', 'releaseEgress', 'releaseViews', 'removeRuntime']) {
        const real = r.client[name];
        r.client[name] = async () => {
            const started = performance.now();
            try { return await real(); } finally { actionTimes.push({ name, ms: performance.now() - started }); }
        };
    }
    const began = performance.now();
    const ended = await r.ledger.endExecution({ classification: 'failed' });
    const total = performance.now() - began;
    const outcomes = Object.fromEntries(ended.releaseLog.map((entry) => [entry.resourceId, entry.outcome]));
    assert.deepEqual(ended.releaseLog.map((entry) => entry.step), [2, 2, 3, 4, 6, 6]);
    assert.deepEqual(ended.releaseLog.map((entry) => entry.kind), ['process-tree', 'process-tree', 'endpoint', 'netns', 'runtime-dir', 'keeper']);
    assert.equal(outcomes[treeB.resourceId], 'quarantined');
    assert.equal(outcomes[netns.resourceId], 'quarantined', 'B is still a member of the network namespace');
    assert.deepEqual(ended.releaseLog.filter((entry) => ![treeB.resourceId, netns.resourceId].includes(entry.resourceId)).map((entry) => [entry.kind, entry.outcome]),
        [['process-tree', 'released'], ['endpoint', 'released'], ['runtime-dir', 'released'], ['keeper', 'released']]);
    assert.equal(outcomes[treeA.resourceId], 'released');
    assert.ok(walks[0].started - began <= REQUEST_DEADLINE + 150, `the step-2 walk starts ${Math.round(walks[0].started - began)} ms after endExecution began`);
    const stepStarts = new Map();
    for (const walk of walks) if (!stepStarts.has(walk.kind)) stepStarts.set(walk.kind, walk);
    for (const kind of ['endpoint', 'netns', 'runtime-dir', 'keeper']) {
        const walk = stepStarts.get(kind);
        assert.ok(walk.ended - walk.started <= RELEASE_DEADLINE + 150, `${kind} walk took ${Math.round(walk.ended - walk.started)} ms`);
    }
    assert.deepEqual(actionTimes.map((entry) => entry.name), ['endEndpoint', 'releaseEgress', 'releaseViews', 'removeRuntime']);
    for (const { name, ms } of actionTimes) assert.ok(ms <= 50, `${name} after the timeout violation rejected in ${ms.toFixed(1)} ms`);
    assert.deepEqual(r.losses, ['keeper_timeout:end_process_trees']);
    assert.ok(total <= REQUEST_DEADLINE + RELEASE_DEADLINE + 1000, `endExecution finished in ${Math.round(total)} ms`);
    assert.ok(r.world.signals.every((signal) => signal.pid >= 200000), 'only fake pids were signalled');
});

// ---- AC-18 ------------------------------------------------------------------------------------------------------------

test('pty held by the keeper is not released', async (t) => {
    await t.test('(a) uncommitted', async (sub) => {
        let ptyHandle = null;
        const r = await rig(sub, {
            releaseDeadlineMs: 300,
            host: {
                stuck: true,
                onRequest: (frame) => {
                    if (frame.op === 'create' && frame.kind === 'pty') { ptyHandle = frame.resource; return { failure: 'setup_failed' }; }
                    // A keeper that ignores teardown: every end step answered, nothing done, and no exit.
                    if (['end_process_trees', 'end_endpoint', 'release_egress', 'release_views', 'remove_runtime'].includes(frame.op)) return { value: {} };
                    return undefined;
                }
            }
        });
        await r.ledger.startKeeper();
        await assert.rejects(r.ledger.publish({ kind: 'pty', spec: { cols: 80, rows: 24 } }), (error) => error.code === 'setup_failed');
        const releaseState = r.store().getResource({ resourceId: handleToId(ptyHandle) }).state;
        assert.equal(releaseState, 'reserved');
        const ended = await r.ledger.endExecution({ classification: 'failed' });
        const kinds = ended.releaseLog.map((entry) => entry.kind);
        const ptyEntry = ended.releaseLog.find((entry) => entry.kind === 'pty');
        assert.ok(kinds.indexOf('pty') > kinds.indexOf('keeper'), `the uncommitted pty is walked after the keeper: ${kinds}`);
        assert.equal(ptyEntry.step, 6);
        assert.equal(ptyEntry.outcome, 'quarantined');
        assert.equal(ended.releaseLog.find((entry) => entry.kind === 'keeper').outcome, 'quarantined');
    });
    await t.test('(b) committed', async (sub) => {
        const r = await rig(sub, {
            releaseDeadlineMs: 300,
            // The keeper answers end_process_trees and keeps its descriptor on the pty.
            host: { onRequest: (frame) => (frame.op === 'end_process_trees' ? { value: {} } : undefined) }
        });
        await r.ledger.startKeeper();
        const pty = await r.ledger.publish({ kind: 'pty', spec: { cols: 80, rows: 24 } });
        const ended = await r.ledger.endExecution({ classification: 'failed' });
        const entry = ended.releaseLog.find((logged) => logged.resourceId === pty.resourceId);
        assert.equal(entry.step, 2);
        const outcome = entry.outcome;
        assert.equal(outcome, 'quarantined');
    });
});

// ---- custody ----------------------------------------------------------------------------------------------------------

test('no release on a keeper\'s word: a keeper that answers every end step ok but leaves everything is quarantined with it', async (t) => {
    const r = await rig(t, {
        releaseDeadlineMs: 250,
        host: {
            stuck: true,
            onRequest: (frame) => (['end_process_trees', 'end_endpoint', 'release_egress', 'release_views', 'remove_runtime', 'abort_uncommitted'].includes(frame.op) ? { value: {} } : undefined)
        }
    });
    await r.ledger.startKeeper();
    await r.ledger.publish({ kind: 'runtime-dir' });
    const netns = await r.ledger.publish({ kind: 'netns' });
    await r.ledger.publish({ kind: 'pty', spec: { cols: 80, rows: 24 } });
    await r.ledger.publish({ kind: 'endpoint', spec: endpointSpec(netns.handle) });
    const tree = await r.ledger.publish({ kind: 'process-tree', spec: workloadSpec(netns.handle) });
    const endpoint = r.store().listUnsettledResources().find((entry) => entry.kind === 'endpoint');
    for (const pid of [tree.identity.pid, endpoint.identity.pid]) { r.world.stubborn.add(pid); r.world.keepOnKeeperExit.add(pid); }
    const ended = await r.ledger.endExecution({ classification: 'failed' });
    const keeper = r.host.latest();
    for (const op of ['end_process_trees', 'end_endpoint', 'release_egress', 'remove_runtime']) assert.ok(keeper.replies.some((reply) => keeper.frames.find((entry) => entry.frame.id === reply.id)?.frame.op === op && reply.ok), `${op} answered ok`);
    const byKind = Object.fromEntries(ended.releaseLog.map((entry) => [entry.kind, entry.outcome]));
    // The supervisor removes the runtime directory itself and proves it gone; everything that only the keeper could end
    // stays quarantined, whatever the keeper answered.
    assert.deepEqual(byKind, { 'process-tree': 'quarantined', pty: 'quarantined', endpoint: 'quarantined', netns: 'quarantined', 'runtime-dir': 'released', keeper: 'quarantined' });
});

test('stop_timeout never releases a ledger entry (R2.2, A3): the tree stays committed and present, and only the walk decides', async (t) => {
    await t.test('the process survives: quarantined', async (sub) => { await stopTimeoutCase(sub, { survives: true }); });
    await t.test('the process is gone: released only on the walk\'s own proof', async (sub) => { await stopTimeoutCase(sub, { survives: false }); });
});

async function stopTimeoutCase(t, { survives }) {
    const r = await rig(t, { releaseDeadlineMs: 250, host: { onRequest: (frame) => (frame.op === 'stop' ? { failure: 'stop_timeout' } : undefined) } });
    await r.ledger.startKeeper();
    await r.ledger.publish({ kind: 'runtime-dir' });
    const netns = await r.ledger.publish({ kind: 'netns' });
    const provider = r.client.providerKeeper(r.ledger, { netnsHandle: netns.handle });
    await provider.start({ process: 1, request: { ...VALID_START }, streams: { stdout: '/run/endpoint/streams/a' } });
    const tree = r.store().listUnsettledResources().find((entry) => entry.kind === 'process-tree');
    r.world.stubborn.add(tree.identity.pid);
    r.world.keepOnKeeperExit.add(tree.identity.pid);
    await assert.rejects(provider.stop({ process: 1, graceMs: 0 }), (error) => error.code === 'stop_timeout');
    assert.equal(r.store().getResource({ resourceId: tree.resourceId }).state, 'committed', 'stop_timeout settles nothing');
    assert.equal(r.walker.prove(r.blocker(tree.resourceId)).absent, false);
    // The keeper's later exit event is accepted, but it is a keeper claim: absence is proven only through /proc.
    if (!survives) { r.world.stubborn.delete(tree.identity.pid); r.world.removeProcess(tree.identity.pid); }
    r.host.latest().emit({ event: 'exit', resource: r.host.latest().handleFor('process-tree').handle, code: null, signal: 'SIGKILL' });
    await sleep(100);
    assert.deepEqual(r.losses, []);
    assert.equal(r.store().getResource({ resourceId: tree.resourceId }).state, 'committed', 'neither the timeout nor the exit settled it');
    const ended = await r.ledger.endExecution({ classification: 'failed' });
    const outcome = ended.releaseLog.find((entry) => entry.resourceId === tree.resourceId).outcome;
    assert.equal(outcome, survives ? 'quarantined' : 'released');
    if (!survives) assert.equal(r.world.exists(tree.identity.pid), false, 'released only with the process absent from /proc');
}

test('proc_unreadable fails closed: the end path rejects and records no release', async (t) => {
    const r = await rig(t, { releaseDeadlineMs: 300 });
    await r.ledger.startKeeper();
    await r.ledger.publish({ kind: 'netns' });
    const before = r.store().listUnsettledResources().length;
    // An entry whose stat cannot be read (EISDIR, as AppArmor's EACCES would be): unreadable, never "absent".
    fs.mkdirSync(path.join(r.world.procRoot, '400100', 'stat'), { recursive: true });
    await assert.rejects(r.ledger.endExecution({ classification: 'failed' }), (error) => error.code === 'proc_unreadable');
    const after = r.store().listUnsettledResources();
    assert.equal(after.length, before, 'no blocker was settled');
    assert.equal(r.store().getReference(syntheticContext(), { referenceId: r.admitted.reference.id }).result, null, 'no result was published');
});

test('a healthy keeper: the end path releases everything in the fixed order through the supervisor\'s own view', async (t) => {
    const r = await rig(t);
    await r.ledger.startKeeper();
    await r.ledger.publish({ kind: 'runtime-dir' });
    await r.ledger.publish({ kind: 'cgroup' });
    const netns = await r.ledger.publish({ kind: 'netns' });
    await r.ledger.publish({ kind: 'endpoint', spec: endpointSpec(netns.handle) });
    await r.ledger.publish({ kind: 'process-tree', spec: workloadSpec(netns.handle) });
    await r.ledger.publish({ kind: 'pty', spec: { cols: 80, rows: 24 } });
    const ended = await r.ledger.endExecution({ classification: 'completed', outputText: 'done' });
    assert.deepEqual(ended.releaseLog.map((entry) => [entry.step, entry.kind, entry.outcome]), [
        [2, 'process-tree', 'released'], [2, 'pty', 'released'], [3, 'endpoint', 'released'], [4, 'netns', 'released'],
        [6, 'runtime-dir', 'released'], [6, 'cgroup', 'released'], [6, 'keeper', 'released']
    ]);
    assert.equal(ended.reference.state, 'completed');
    assert.deepEqual(r.store().listUnsettledResources(), []);
    assert.deepEqual(r.losses, []);
});

test('failure mapping: an uncommitted namespace stays reserved while the keeper lives; a committed process whose gate failed is released only on the supervisor\'s own kill and proof', async (t) => {
    let refusedTree = null;
    const r = await rig(t, {
        releaseDeadlineMs: 300,
        host: {
            onRequest: (frame, keeper) => {
                if (frame.op === 'create' && frame.kind === 'netns') return { refused: 'cgroup_not_delegated' };
                // The workload's gate stage exists, then its commit is refused (gate_closed): S1 holds the identity.
                if (frame.op === 'commit' && keeper.handles.get(frame.resource)?.kind === 'process-tree') { refusedTree = frame.resource; return { refused: 'gate_closed' }; }
                return undefined;
            }
        }
    });
    await r.ledger.startKeeper();
    await r.ledger.publish({ kind: 'runtime-dir' });
    await assert.rejects(r.ledger.publish({ kind: 'netns' }), (error) => error.code === 'cgroup_not_delegated');
    assert.deepEqual(r.store().listUnsettledResources().filter((entry) => entry.kind === 'netns').map((entry) => entry.state), ['reserved'], 'an uncommitted namespace waits for the keeper');
    await assert.rejects(r.ledger.publish({ kind: 'process-tree', spec: { role: 'orchestration', script: '/opt/o/main.mjs', args: [], env: {}, netns: null } }), (error) => error.code === 'gate_release_failed');
    // S1 held the identity, so the walk judged it by tuple: released only because /proc no longer shows that pid
    // (the abort request is not the proof; a stage that survived it would have been killed or left unsettled).
    const tree = r.store().getResource({ resourceId: handleToId(refusedTree) });
    assert.notEqual(tree.identity, null);
    assert.equal(tree.state, 'released');
    assert.equal(r.world.exists(tree.identity.pid), false);
    assert.ok(r.world.signals.every((signal) => signal.pid >= 200000));
    assert.equal(r.client.alive(), true);
});

test('supervisor death: the keeper tears down on EOF, and generation recovery walks every blocker with the production view', async (t) => {
    const r = await rig(t, { releaseDeadlineMs: 600 });
    await r.ledger.startKeeper();
    await r.ledger.publish({ kind: 'runtime-dir' });
    const netns = await r.ledger.publish({ kind: 'netns' });
    await r.ledger.publish({ kind: 'process-tree', spec: workloadSpec(netns.handle) });
    const keeper = r.host.latest();
    // The keeper reads EOF on fd 3 (its supervisor is gone): it tears everything down and exits.
    keeper.onEof();
    assert.equal(await waitFor(() => keeper.gone, 3000), true);
    const store = r.reopen();
    const keeperRecord = (blocker) => store.getResource({ resourceId: blocker.locator.keeper });
    const view = createProcView({ procRoot: r.world.procRoot, signal: r.world.signal, statfs: r.world.statfs, runtimeRoot: r.world.runtimeRoot, cgroupSubtree: r.world.cgroupSubtree, keeperRecord, identityForLocator: () => { throw new Error('unused'); } });
    const walker = createWalker({ view, clock: realClock, releaseDeadlineMs: 600, pollMs: 20, keeperRecord });
    const recovered = await recoverGeneration({ state: store, walker });
    assert.deepEqual(recovered.outcomes.map((entry) => [entry.kind, entry.outcome]), [['keeper', 'released'], ['process-tree', 'released'], ['netns', 'released'], ['runtime-dir', 'released']]);
});
