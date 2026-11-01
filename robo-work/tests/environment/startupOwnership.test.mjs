import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import { createDispatcher } from '../../server/runtime/dispatcher.mjs';
import { createExecutionFactory } from '../../server/runtime/executionFactory.mjs';
import { createExecutionLedger } from '../../server/execution/resourceLedger.mjs';
import { createWalker } from '../../server/execution/recoveryWalk.mjs';
import { createExecutionChannels } from '../../server/runtime/channels.mjs';
import { createModelChannel } from '../../server/runtime/modelChannel.mjs';
import { S6_LIMITS, WORKSPACE, admitRequest, makeTempDir, newId, openStore, readyRobot, syntheticContext } from '../helpers/synthetic.mjs';
import { shortTempDirectory, removeDirectory } from '../execution/helpers/topology.mjs';

const waitFor = async (predicate) => {
    const deadline = Date.now() + 3000;
    while (!predicate()) { assert.ok(Date.now() < deadline, 'bounded startup ownership wait'); await new Promise((resolve) => setTimeout(resolve, 5)); }
};
const connects = (socketPath) => new Promise((resolve) => {
    const socket = net.connect(socketPath);
    socket.once('connect', () => { socket.destroy(); resolve(true); });
    socket.once('error', () => { socket.destroy(); resolve(false); });
});
const upstream = { request: async () => ({ ok: true, status: 200, json: { data: [{ id: 'fixture-model' }] } }) };

async function exerciseStop(t, kind, { closeFails = false } = {}) {
    const root = makeTempDir(t); const store = openStore(root, { limits: S6_LIMITS });
    const runtimeBase = shortTempDirectory('rw-r4'); t.after(() => removeDirectory(runtimeBase));
    const robotOwnerId = `workspace:${WORKSPACE}`;
    const owner = syntheticContext({ originNamespace: 'coordinator:fixtures', originKey: 'owner:user:alice', ownerId: 'user:alice', scope: 'owner', robotOwnerId });
    const bindingId = 'flow_0123456789abcdef01234567';
    store.registerBinding(owner, { operationId: newId(), bindingId, kind: 'flow' });
    const context = syntheticContext({ originNamespace: 'coordinator:fixtures', originKey: `binding:${bindingId}`, ownerId: 'user:alice', scope: 'background', robotOwnerId });
    const robotId = readyRobot(store, syntheticContext({ robotOwnerId }));
    const specification = { version: 2, prompt: 'x', displayText: 'x', permissions: 'full-access', sessionId: 'fixture-session', turnId: 'fixture-turn',
        environment: 'fixtures/env', ...(kind === 'channels' ? { workflowExecution: true } : { codingAgent: 'opencode', model: 'soul-gateway/fixture-model' }) };
    const admission = store.admit(context, admitRequest(robotId, { specification }, context));
    const dirs = { home: path.join(root, 'home'), sessions: path.join(root, 'sessions'), configDir: path.join(root, 'config') };
    for (const directory of Object.values(dirs)) fs.mkdirSync(directory);
    let runtime = null; let ledger; let pinReleased = false; let actualHandle; let releaseCreation; let allocationSignal; let channelClosed = false; let prompts = 0;
    const stdin = new PassThrough(); stdin.on('data', () => { prompts += 1; });
    const supervisor = {
        get runtimeDir() { return runtime; }, controlStreams: { stdin, stdout: new PassThrough(), stderr: new PassThrough() },
        alive: () => true, async prepareEnvironment() {}, async exit() {},
        async create({ kind: resourceKind, locator }) {
            if (resourceKind === 'keeper') return { identity: { pid: 999999, startTime: '1' }, gate: { commit: async () => true, abort: async () => {} } };
            assert.equal(resourceKind, 'runtime-dir', 'cancelled startup cannot allocate a network or process');
            runtime = locator.path; fs.mkdirSync(runtime, { recursive: true });
            for (const name of ['channels', 'model']) fs.mkdirSync(path.join(runtime, name));
            return { identity: { path: runtime, dev: '1', ino: '1' }, gate: null };
        },
        async abortUncommitted() {}, async endProcessTrees() {}, async endEndpoint() {}, async releaseEgress() {}, async releaseViews() {},
        async removeRuntime() { if (runtime) fs.rmSync(runtime, { recursive: true, force: true }); },
    };
    const view = { process: () => null, listProcesses: () => [], listMounts: () => [], cgroupContext: () => ({ dev: '1', ino: '1', namespace: '1' }),
        exists: (resourceKind, locator) => resourceKind === 'runtime-dir' ? fs.existsSync(locator.path) : false,
        remove: (resourceKind, locator) => { if (resourceKind === 'runtime-dir') fs.rmSync(locator.path, { recursive: true, force: true }); return true; }, kill: () => false };
    const clock = { now: Date.now, sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)) };
    const walker = createWalker({ view, clock, releaseDeadlineMs: 100, pollMs: 5, sandboxRecord: () => null });
    const deferHandle = async (options, create) => {
        allocationSignal = options.signal;
        actualHandle = await create(options);
        await new Promise((resolve) => { releaseCreation = resolve; });
        return { ...actualHandle, async close() {
            if (closeFails) throw new Error('fixture unknown close');
            await actualHandle.close(); channelClosed = true;
        } };
    };
    const factory = createExecutionFactory({ store, robots: { root, paths: () => dirs }, launcher: {}, view, walker, clock, workspaceRoot: '/ws',
        runtimeDir: runtimeBase, serverDir: '/fixture/server', alaRoot: '/fixture/ala', cgroupSubtree: '/fixture/cgroup', modelUpstream: upstream,
        environments: { async prepare() { return { imageId: `sha256:${'a'.repeat(64)}`, imageEnv: {}, contract: { tools: { node: process.execPath }, caBundle: '/fixture/ca/ca-bundle.crt' }, release() { pinReleased = true; } }; }, async gc() {} },
        deps: {
            createExecutionSupervisor: () => supervisor,
            createExecutionLedger: (options) => { ledger = createExecutionLedger(options); return ledger; },
            imageBinds: () => ({ roBinds: [], symlinks: [] }), readManagedConfig: () => ({}),
            createExecutionChannels: (options) => deferHandle(options, createExecutionChannels),
            createModelChannel: (options) => deferHandle(options, createModelChannel),
        },
    });
    const logs = [];
    const dispatcher = createDispatcher({ store, workspaceId: WORKSPACE, workspaceRoot: '/ws', factory,
        options: { pollMs: 5, controlPollMs: 5, inactivityTimeoutMs: 5000, maxAttemptMs: 10000 }, log: (event, fields) => logs.push({ event, ...fields }) });
    const read = () => store.observeReference(context, { referenceId: admission.reference.id });
    let observed;
    try {
        dispatcher.start(); await waitFor(() => releaseCreation);
        const socketPath = path.join(runtime, kind === 'channels' ? 'channels/task-failure.sock' : 'model/model.sock');
        assert.equal(await connects(socketPath), true, 'the actual allocator has a live Unix server before yielding its handle');
        store.controlReference(context, { referenceId: admission.reference.id, operationId: newId(), op: 'stop' });
        await waitFor(() => store.takePendingControls({ executionId: admission.executionId, attemptId: admission.attemptId }).length === 0);
        await new Promise((resolve) => setTimeout(resolve, 20));
        const before = { pinReleased, ledgerClosed: ledger.closed, state: read().state, aborted: allocationSignal?.aborted === true };
        releaseCreation();
        await waitFor(() => closeFails ? logs.some((entry) => entry.event === 'end_failed') : read().state === 'cancelled');
        await dispatcher.close();
        observed = { before, pinReleased, channelClosed, accepts: await connects(socketPath), state: read().state, cleanup: read().result?.cleanup, prompts };
    } finally {
        releaseCreation?.();
        await dispatcher.close(); await actualHandle?.close();
        for (const stream of Object.values(supervisor.controlStreams)) stream.destroy();
        store.close();
    }
    return observed;
}

for (const kind of ['channels', 'model']) {
    test(`startup ownership: stop drains deferred ${kind} allocation and closes its real late server before releasing the pin`, async (t) => {
        const observed = await exerciseStop(t, kind);
        assert.equal(observed.before.pinReleased, false, 'pending allocators retain the attempt image pin');
        assert.equal(observed.before.ledgerClosed, false, 'cleanup cannot complete ahead of non-ledger startup ownership');
        assert.notEqual(observed.before.state, 'cancelled'); assert.equal(observed.before.aborted, true);
        assert.equal(observed.channelClosed, true); assert.equal(observed.accepts, false);
        assert.equal(observed.pinReleased, true); assert.equal(observed.state, 'cancelled'); assert.equal(observed.cleanup, 'released'); assert.equal(observed.prompts, 0);
    });
}

test('startup ownership: an unknown close keeps the pin and cannot publish clean ledger cleanup', async (t) => {
    const observed = await exerciseStop(t, 'channels', { closeFails: true });
    assert.equal(observed.pinReleased, false); assert.equal(observed.channelClosed, false);
    assert.equal(observed.accepts, true, 'unknown live closure is not treated as a released resource');
    assert.notEqual(observed.cleanup, 'released'); assert.notEqual(observed.state, 'cancelled'); assert.equal(observed.prompts, 0);
});

test('actual channel and model allocators close partially-created servers before rejecting', async (t) => {
    const root = makeTempDir(t);
    const channels = path.join(root, 'channels'); fs.mkdirSync(channels); fs.writeFileSync(path.join(channels, 'task-failure'), 'block compatibility directory');
    await assert.rejects(createExecutionChannels({ directory: channels, taskFailure: async () => ({}) }));
    assert.equal(await connects(path.join(channels, 'task-failure.sock')), false);
    const model = path.join(root, 'model'); const config = path.join(root, 'config'); fs.mkdirSync(model); fs.mkdirSync(config);
    fs.writeFileSync(path.join(config, 'opencode.json'), 'block exclusive config write');
    await assert.rejects(createModelChannel({ socketDirectory: model, configDirectory: config, allowed: 'fixture-model', upstream }), { reason: 'model_channel_unavailable' });
    assert.equal(await connects(path.join(model, 'model.sock')), false);
});
