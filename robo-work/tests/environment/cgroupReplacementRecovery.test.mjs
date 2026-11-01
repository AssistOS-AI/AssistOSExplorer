import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { loadCgroupRecoveryProof } from '../../server/execution/cgroupRecoveryProof.mjs';
import { createRecoveryView } from '../../server/sandbox/executionSupervisor.mjs';
import { createWalker, walkOrder } from '../../server/execution/recoveryWalk.mjs';
import { startWorker } from '../../server/main.mjs';
import { createExecutionFactory } from '../../server/runtime/executionFactory.mjs';
import { UNAVAILABLE_AUTH } from '../../server/terminal/terminalAuth.mjs';
import { makeTempDir, openStore } from '../helpers/synthetic.mjs';

const WORKLOADS = '/run/ploinky/cgroup/workloads';
const PRINCIPAL = 'agent:fixtures/robo-work';
const hash = (value) => crypto.createHash('sha256').update(value).digest('hex');
const child = (digit) => `${WORKLOADS}/x-${digit.repeat(32)}`;
const locatorContext = (context) => ({ dev: context.workloads.dev, ino: context.workloads.ino, namespace: context.workerCgroupNamespace });

function physical(index) {
    const containerId = String(index).repeat(64);
    const nativePath = `/fixture/agents/${containerId}`;
    return { containerId, box: { cgroupNamespace: '500', pidNamespace: '501', markerIdentity: { dev: '31', ino: '32' } },
        nativeRoot: { path: nativePath, dev: '31', ino: String(100 + index) },
        workloads: { nativePath: `${nativePath}/workloads`, workerPath: WORKLOADS, dev: '31', ino: String(200 + index) },
        workerCgroupNamespace: String(300 + index), workerPidNamespace: String(400 + index) };
}
const [A, B, C] = [1, 2, 3].map(physical);
const tuple = (context) => ({ containerName: `fixture-${context.containerId[0]}`, containerId: context.containerId,
    instanceId: `instance-${context.containerId[0]}`, enableGeneration: `generation-${context.containerId[0]}` });

function fixture(t) {
    const root = makeTempDir(t);
    const runtimeWorkspace = path.join(root, 'runtime-workspace'); const workerWorkspace = path.join(root, 'worker-override');
    fs.mkdirSync(runtimeWorkspace); fs.mkdirSync(workerWorkspace);
    const env = { PLOINKY_CGROUP_SUBTREE: WORKLOADS, PLOINKY_CGROUP_RECOVERY_FILE: '/run/ploinky/cgroup-recovery/receipt.json',
        PLOINKY_WORKSPACE_ROOT: runtimeWorkspace, ROBO_WORK_WORKSPACE_ROOT: workerWorkspace, PLOINKY_AGENT_ID: PRINCIPAL,
        PLOINKY_AGENT_INSTANCE_ID: 'instance-3', PLOINKY_AGENT_ENABLE_GENERATION: 'generation-3' };
    return { root, env };
}

// Synthetic authenticated-reader output only. The runtime-owned B module owns cryptographic, filesystem and kernel
// verification. These A-side tests exercise its fixed result contract and the real worker state/walker consumer.
function receipt(env, current = C, prior = [A, B]) {
    const transactionId = crypto.randomUUID();
    return { payload: { schema: 'ploinky.cgroup-recovery.v1', transactionId, deliveryId: crypto.randomUUID(),
        owner: { workspacePathHash: hash(fs.realpathSync(env.PLOINKY_WORKSPACE_ROOT)), principal: PRINCIPAL, logicalRegistration: 'fixtures/robo-work', alias: 'robo-work' },
        recipient: { ...tuple(current), context: structuredClone(current) },
        priorContexts: prior.map((context) => ({ predecessor: tuple(context), context: structuredClone(context),
            proof: { kind: 'exact-engine-and-native-root-absence', transactionId } })) },
        identity: { dev: '31', ino: '777', size: 2000 }, envelopeSha256: 'a'.repeat(64) };
}

async function proof(env, result = receipt(env)) {
    return loadCgroupRecoveryProof({ env, reader: async (options) => { assert.equal(options.env, env); return result; } });
}

test('receipt consumer binds canonical runtime workspace independently of worker overrides and snapshots exact prior contexts', async (t) => {
    const { root, env } = fixture(t);
    const alias = path.join(root, 'runtime-alias'); fs.symlinkSync(env.PLOINKY_WORKSPACE_ROOT, alias);
    env.PLOINKY_WORKSPACE_ROOT = alias;
    const result = receipt(env);
    const proves = await proof(env, result);
    assert.equal(Object.isFrozen(proves), true);
    const old = { path: child('a'), context: locatorContext(A) };
    assert.equal(proves(old), true); assert.equal(proves({ path: child('b'), context: locatorContext(B) }), true);
    assert.equal(proves({ path: child('a'), context: locatorContext(C) }), false, 'current children never acquire prior authority');
    for (const pathValue of [`${child('a')}\n`, `${child('a')}/x`, '/custom/x-' + 'a'.repeat(32), child('a').replace('/workloads/', '/workloads//'), child('a').replace(/a$/u, 'A')]) {
        assert.equal(proves({ path: pathValue, context: locatorContext(A) }), false);
    }
    for (const change of [{ dev: '32' }, { ino: '999' }, { namespace: 'cgroup:[301]' }, { namespace: '0301' }, { namespace: '301\n' }, { namespace: '0' }, { namespace: '18446744073709551616' }]) {
        assert.equal(proves({ ...old, context: { ...old.context, ...change } }), false);
    }
    result.payload.priorContexts[0].context.workloads.ino = '999';
    assert.equal(proves(old), true, 'the reader result cannot mutate an already-built predicate');
    result.payload.owner.workspacePathHash = hash(fs.realpathSync(env.ROBO_WORK_WORKSPACE_ROOT));
    await assert.rejects(proof(env, result), { code: 'PLOINKY_CGROUP_RECOVERY_INVALID' });
});

test('required reader is independent of recovery-file presence and Environment selector; standalone mode never loads it', async (t) => {
    const { env } = fixture(t);
    for (const override of ['/custom/delegation', '', '/not/../valid']) {
        const configured = { ...env, ROBO_WORK_CGROUP_SUBTREE: override };
        const proves = await proof(configured);
        assert.equal(proves({ path: child('a'), context: locatorContext(A) }), true);
        const missing = { ...configured }; delete missing.PLOINKY_CGROUP_RECOVERY_FILE;
        let read = false;
        await assert.rejects(loadCgroupRecoveryProof({ env: missing, reader: () => { read = true; throw new Error('private malformed receipt details'); } }),
            (error) => error.code === 'PLOINKY_CGROUP_RECOVERY_INVALID' && !error.message.includes('private'));
        assert.equal(read, true, 'absence of the env variable cannot skip mandatory authentication');
    }
    const standalone = { ...env }; delete standalone.PLOINKY_CGROUP_SUBTREE;
    assert.equal(await loadCgroupRecoveryProof({ env: standalone, reader: () => { assert.fail('standalone must preserve its existing recovery'); } }), null);
    const currentInPrior = receipt(env, C, [C]);
    assert.equal((await proof(env, currentInPrior))({ path: child('a'), context: locatorContext(C) }), false);
    assert.equal((await proof(env, receipt(env, C, [])))({ path: child('a'), context: locatorContext(A) }), false, 'initial delivery grants no prior absence');
    const badCurrent = receipt(env); badCurrent.payload.recipient.context.workerCgroupNamespace = 'cgroup:[303]';
    await assert.rejects(proof(env, badCurrent), { code: 'PLOINKY_CGROUP_RECOVERY_INVALID' });
});

test('real WorkerState/walker repeated A→B→C crashes retain prior-generation rows and preserve same-named current children', async (t) => {
    for (const partialSettlement of [false, true]) {
        const { root, env } = fixture(t); const dir = path.join(root, 'state'); fs.mkdirSync(dir);
        let state = openStore(dir);
        const reserve = (store, context, digit) => {
            const locator = { path: child(digit), context: locatorContext(context) };
            const row = store.reserveResource({ kind: 'cgroup', locator });
            store.commitResource({ resourceId: row.resourceId, identity: { path: locator.path, dev: '31', ino: '999' } });
            return row.resourceId;
        };
        const a1 = reserve(state, A, 'a'); const a2 = reserve(state, A, 'b');
        state.close(); state = openStore(dir, { create: false });
        const bRecovery = state.beginGenerationRecovery(state.generationId);
        const currentChildren = new Set([child('a'), child('b'), child('c')]); const removals = [];
        const base = { listProcesses: () => [], listMounts: () => [], exists: () => true, remove: (kind, locator) => { removals.push({ kind, locator }); return false; }, kill: () => false, unmount: () => false };
        const walkerFor = (proves) => {
            let now = 0;
            return createWalker({ view: createRecoveryView(base, { provesPriorCgroupAbsent: proves }), clock: { now: () => now, sleep: async (ms) => { now += ms; } },
                releaseDeadlineMs: 20, pollMs: 5, sandboxRecord: () => null });
        };
        const bEnv = { ...env, PLOINKY_AGENT_INSTANCE_ID: tuple(B).instanceId, PLOINKY_AGENT_ENABLE_GENERATION: tuple(B).enableGeneration };
        const bReceipt = receipt(bEnv, B, [A]);
        const bProof = await proof(bEnv, bReceipt);
        if (partialSettlement) {
            const blocker = bRecovery.unsettledBlockers.find((row) => row.resourceId === a1);
            state.settleResource({ resourceId: a1, generationId: blocker.generationId, outcome: await walkerFor(bProof).walk(blocker) });
        }
        const b1 = reserve(state, B, 'c');
        state.close(); state = openStore(dir, { create: false });
        try {
            const started = state.beginGenerationRecovery(state.generationId);
            const cReceipt = receipt(env, C, [A, B]);
            cReceipt.payload.priorContexts[0] = structuredClone(bReceipt.payload.priorContexts[0]);
            const cProof = await proof(env, cReceipt);
            const pending = started.unsettledBlockers;
            assert.equal(pending.some((row) => row.resourceId === a2), true, 'the oldest unfinished generation survives a second crash');
            assert.equal(pending.some((row) => row.resourceId === b1), true);
            assert.equal(pending.some((row) => row.resourceId === a1), !partialSettlement, 'partial progress is durable, not an acknowledgement of all history');
            const old = pending.find((row) => row.resourceId === a2);
            assert.equal(await walkerFor(null).walk(old), 'quarantined', 'no-receipt context mismatch remains conservative');
            removals.length = 0;
            for (const blocker of walkOrder(pending)) {
                const outcome = await walkerFor(cProof).walk(blocker, { recovery: true, executionRecords: pending });
                assert.equal(outcome, 'released'); state.settleResource({ resourceId: blocker.resourceId, generationId: blocker.generationId, outcome });
            }
            assert.equal(state.completeGenerationRecovery(started.generationId).recovered, true);
            for (const resourceId of [a1, a2, b1]) assert.equal(state.getResource({ resourceId }).state, 'released');
            assert.equal(state.listUnsettledResources().length, 0);
            assert.deepEqual(removals, [], 'prior proofs must never remove a same-named current physical child');
            assert.equal(createRecoveryView(base, { provesPriorCgroupAbsent: cProof }).remove('cgroup', old.locator), true);
            assert.deepEqual(removals, [], 'explicit removal of a proven old cgroup is a no-op too');
            assert.deepEqual([...currentChildren], [child('a'), child('b'), child('c')]);
            const current = { kind: 'cgroup', locator: { path: child('a'), context: locatorContext(C) }, identity: { path: child('a') } };
            assert.equal(await walkerFor(cProof).walk(current), 'quarantined');
            assert.equal(currentChildren.has(child('a')), true);
        } finally { state.close(); }
    }
});

test('receipt scope cannot release lingering non-cgroup resources or alter their removal checks', async (t) => {
    const { env } = fixture(t); const proves = await proof(env); let proofCalls = 0;
    const held = { pid: 100, ppid: 1, startTime: '1', pidNs: '700', mntNs: '701', netNs: '702', fdNs: [], cmdline: [] };
    const base = { listProcesses: () => [held], listMounts: () => [{ mountId: 7, mountpoint: '/held', mntNs: '701' }],
        exists: () => true, remove: () => false, kill: () => false, unmount: () => false };
    const view = createRecoveryView(base, { provesPriorCgroupAbsent: (locator) => { proofCalls += 1; return proves(locator); },
        exists: () => true, runSync: () => ({ status: 1, stdout: '' }) });
    const records = [
        { kind: 'process-tree', locator: {}, identity: { pid: 100, startTime: '1', pidNs: '700', init: { pid: 100, startTime: '1' } } },
        { kind: 'mount', locator: {}, identity: { mntNs: '701', mountId: 7, mountpoint: '/held' } },
        { kind: 'env-rootfs', locator: {}, identity: null }, { kind: 'netns', locator: { netns: 'a'.repeat(32) }, identity: null },
        { kind: 'runtime-dir', locator: { path: '/held' }, identity: null },
    ];
    for (const record of records) {
        let now = 0;
        const walker = createWalker({ view, clock: { now: () => now, sleep: async (ms) => { now += ms; } }, releaseDeadlineMs: 20, pollMs: 5, sandboxRecord: () => null });
        assert.equal(await walker.walk(record), 'quarantined', record.kind);
    }
    assert.equal(proofCalls, 0);
});

function bootEnv(root, runtimeEnv) {
    return { ...runtimeEnv, PLOINKY_AGENT_SECRET: crypto.randomBytes(32).toString('hex'), ROBO_WORK_DATA_DIR: path.join(root, 'data'),
        PORT: '0', ROBO_WORK_PROVIDER_PORT: '0', ROBO_WORK_COORDINATOR_HOST: '127.0.0.1' };
}
function bootOverrides(reader, recover) {
    return { cgroupRecoveryReader: reader, recover, preflight: { ok: false, reason: 'synthetic', masks: [], missing: [] }, alaRoot: null,
        signalSource: new EventEmitter(), terminalAuth: UNAVAILABLE_AUTH, log: () => {}, podman: { initialize() {}, available: false, close() {} },
        environments: { list: async () => [], gc: async () => {}, recoverOrphans: async () => {}, close() {} } };
}
const getStatus = (port) => new Promise((resolve, reject) => {
    const request = http.get({ host: '127.0.0.1', port, path: '/' }, (response) => { response.resume(); response.once('end', () => resolve(response.statusCode)); });
    request.once('error', reject);
});

test('bootstrap authenticates before generation recovery under default, custom and invalid/null Environment overrides', async (t) => {
    for (const override of [undefined, '/custom/delegation', '', '/invalid/../subtree']) {
        const { root, env: runtimeEnv } = fixture(t); const env = bootEnv(root, runtimeEnv);
        if (override !== undefined) env.ROBO_WORK_CGROUP_SUBTREE = override;
        const events = [];
        const worker = await startWorker({ env, overrides: bootOverrides(async ({ env: received }) => {
            assert.equal(received, env); events.push('authenticated'); return receipt(env);
        }, async (store) => { events.push('generation'); const started = store.beginGenerationRecovery(store.generationId); store.completeGenerationRecovery(started.generationId); }) });
        try {
            assert.deepEqual(events, ['authenticated', 'generation']);
            assert.equal(worker.recovered, true);
            assert.equal(worker.config.cgroupSubtree, override === undefined ? WORKLOADS : override === '/custom/delegation' ? override : null);
            assert.equal(await getStatus(worker.coordinatorPort), 404, 'ordinary worker listener remains available with an authentic receipt');
            if (worker.config.cgroupSubtree === null) {
                const logs = [];
                const factory = createExecutionFactory({ store: {}, robots: { root }, launcher: {}, view: { cgroupContext: () => null }, walker: {}, clock: {},
                    workspaceRoot: env.ROBO_WORK_WORKSPACE_ROOT, runtimeDir: path.join(root, 'runtime'), serverDir: '/fixture/server', alaRoot: '/fixture/ala',
                    cgroupSubtree: null, environments: { gc: async () => {}, prepare: () => assert.fail('invalid override cannot acquire an image') },
                    log: (event, fields) => logs.push({ event, ...fields }) });
                await assert.rejects(factory.open({ item: {}, plan: { environment: 'fixtures/env' }, context: {} }), { reason: 'environment_unavailable' });
                assert.ok(logs.some((entry) => entry.reason === 'limits_unavailable'));
            }
        } finally { await worker.close(); }
    }
});

test('missing or invalid required receipt refuses bootstrap before any state rollover, independently of Environment override', async (t) => {
    for (const override of [undefined, '/custom/delegation', '', '/invalid/../subtree']) {
        for (const missing of [true, false]) {
            const { root, env: runtimeEnv } = fixture(t); const env = bootEnv(root, runtimeEnv);
            if (override !== undefined) env.ROBO_WORK_CGROUP_SUBTREE = override;
            if (missing) delete env.PLOINKY_CGROUP_RECOVERY_FILE;
            let recovered = false; let read = false;
            let unexpectedWorker = null;
            try {
                await assert.rejects(startWorker({ env, overrides: bootOverrides(() => { read = true; throw new Error(missing ? 'missing delivery' : 'invalid signature'); },
                    async () => { recovered = true; }) }).then((worker) => { unexpectedWorker = worker; return worker; }), { code: 'PLOINKY_CGROUP_RECOVERY_INVALID' });
            } finally { await unexpectedWorker?.close(); }
            assert.equal(read, true); assert.equal(recovered, false); assert.equal(fs.existsSync(env.ROBO_WORK_DATA_DIR), false);
        }
    }
});
