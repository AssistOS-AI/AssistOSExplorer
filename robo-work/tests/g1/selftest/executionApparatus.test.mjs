import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Duplex, PassThrough } from 'node:stream';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { createExecutionApparatus } from '../lib/executionApparatus.mjs';
import { createProcView } from '../../../server/execution/procView.mjs';
import { createExecutionKeeper } from '../../../server/execution/keeperClient.mjs';
import { createSupervisorEndpointServer } from '../../../server/execution/supervisorEndpointServer.mjs';
import { createControlStreamReader } from '../../../server/execution/controlStreamReader.mjs';
import { createModelKeeper } from '../../execution/helpers/modelKeeper.mjs';
import { createModelClock, createModelWorld } from '../../execution/helpers/modelWorld.mjs';
import { admitRequest, makeTempDir, openStore, readyRobot, syntheticContext } from '../../helpers/synthetic.mjs';

// These checks use a real durable store/ledger/walker and real endpoint/control readers, with a synthetic kernel and
// keeper. No native process, namespace, cgroup or signal is used. They establish composition only, never G1 acceptance.
const deferred = () => {
    let resolve;
    const promise = new Promise((done) => { resolve = done; });
    return { promise, resolve };
};
const tick = () => new Promise((resolve) => setImmediate(resolve));

function rig(t, { faults = {}, delayCreate, commitFailure, keeperOptions = {}, onRecord = async () => {}, limits = {} } = {}) {
    const dir = makeTempDir(t);
    const context = syntheticContext();
    let store = openStore(dir);
    const handles = [store];
    t.after(() => { for (const handle of handles) { try { handle.close(); } catch { /* closed by recovery */ } } });
    const robotId = readyRobot(store, context);
    const admitted = store.admit(context, admitRequest(robotId, {}, context));
    store.transitionAttempt({ executionId: admitted.executionId, attemptId: admitted.attemptId, expectedState: 'queued', nextState: 'running' });
    const clock = createModelClock();
    const world = createModelWorld({ clock });
    const model = createModelKeeper(world, keeperOptions);
    const events = [];
    const requests = [];
    const socket = new Duplex({ read() {}, write(chunk, encoding, callback) { callback(); } });
    const streams = { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough() };
    t.after(() => { socket.destroy(); for (const stream of Object.values(streams)) stream.destroy(); });
    let keeperConfig;
    let procConfig;
    let provider;
    let endpointConfig;
    let reopenCount = 0;
    let ends = 0;
    let ledgerState = store;
    const state = new Proxy(store, {
        get(target, name) {
            if (name === 'commitResource') return (request) => {
                const kind = target.getResource({ resourceId: request.resourceId }).kind;
                events.push(`commit:${kind}`);
                if (kind === commitFailure) throw new Error('injected durable commit failure');
                return target.commitResource(request);
            };
            if (name === 'reserveResource') return (request) => {
                events.push(`reserve:${request.kind}`);
                return target.reserveResource(request);
            };
            if (name === 'beginAttemptEnd') return (...args) => { ends += 1; return target.beginAttemptEnd(...args); };
            const value = Reflect.get(target, name, target);
            return typeof value === 'function' ? value.bind(target) : value;
        },
    });
    world.onExecute((entry) => {
        assert.equal(ledgerState.getResource({ resourceId: entry.marker }).state, 'committed');
        events.push(`execute:${entry.role}`);
    });
    const options = {
        state, context, synthetic: true,
        reopenState: () => {
            reopenCount += 1;
            store = openStore(dir, { create: false });
            ledgerState = store;
            handles.push(store);
            return store;
        },
        admission: { robotId, executionId: admitted.executionId, attemptId: admitted.attemptId, referenceId: admitted.reference.id,
            inventory: [{ name: 'codex', version: 'synthetic' }], streamDirectory: `${dir}/runtime/streams` },
        layout: { runtimeDir: `${dir}/runtime`, cgroupSubtree: null },
        home: { fd: 100, identity: { dev: '1', ino: '2' } },
        orchestrationRoot: '/fixture', orchestration: { script: '/fixture/main.mjs', args: [], env: {} },
        limits: { releaseDeadlineMs: 100, pollMs: 10, publicationDrainMs: 1000, ...limits },
        clock, faults, onRecord, validateRecord: () => null,
        adapters: {
            createProcView(config) { procConfig = config; return { ...world.view, cgroupSubtree: null }; },
            createExecutionKeeper(config) {
                keeperConfig = config;
                return {
                    ...model,
                    endpointSocket: socket, controlStreams: streams,
                    async create(request) {
                        requests.push(structuredClone(request));
                        events.push(`create:${request.kind}`);
                        const created = await model.create(request);
                        await delayCreate?.(request, created);
                        return { ...created, handle: `handle-${request.resourceId}`, gate: created.gate && {
                            commit: async () => { events.push(`gate:${request.kind}`); return created.gate.commit(); },
                            abort: async () => { events.push(`abort:${request.kind}`); return created.gate.abort(); },
                        } };
                    },
                    providerKeeper(ledger, { netnsHandle }) {
                        events.push('attach:provider');
                        // Reuse the actual provider adapter. Its start() only calls the supplied ledger; this separate
                        // client is never spawned and never sends requests to the OS or a keeper channel.
                        const client = createExecutionKeeper({ ...config, view: {
                            ...config.view, process: world.process, registerKeeperChild: () => () => {},
                        } });
                        provider = { ledger, netnsHandle, adapter: client.providerKeeper(ledger, { netnsHandle }) };
                        return provider.adapter;
                    },
                    stats: () => ({ synthetic: true }),
                };
            },
            createSupervisorEndpointServer(config) {
                events.push('attach:endpoint');
                endpointConfig = config;
                return createSupervisorEndpointServer(config);
            },
            createControlStreamReader(config) { events.push('attach:control'); return createControlStreamReader(config); },
        },
    };
    return {
        options, events, requests, world, socket, streams, context, admitted,
        get state() { return store; }, get ends() { return ends; }, get reopenCount() { return reopenCount; },
        get keeperConfig() { return keeperConfig; }, get procConfig() { return procConfig; }, get provider() { return provider; },
        get endpointConfig() { return endpointConfig; },
    };
}

test('publication order uses real durable barriers, one null-subtree view, and provider ledger', async (t) => {
    const r = rig(t);
    const apparatus = createExecutionApparatus(r.options);
    const started = apparatus.start();
    assert.equal(apparatus.start(), started);
    assert.equal((await started).phase, 'running');
    const kinds = ['keeper', 'runtime-dir', 'netns', 'endpoint', 'process-tree'];
    assert.deepEqual(r.events.filter((event) => /^(reserve|create|commit|gate):/.test(event)), kinds.flatMap((kind) =>
        ['reserve', 'create', 'commit', ...(['keeper', 'endpoint', 'process-tree'].includes(kind) ? ['gate'] : [])].map((step) => `${step}:${kind}`)));
    assert.equal(r.keeperConfig.view.cgroupSubtree, null);
    assert.equal(r.keeperConfig.cgroupSubtree, null);
    assert.equal(r.procConfig.cgroupSubtree, null);
    assert.equal(r.keeperConfig.runtimeRoot, r.procConfig.runtimeRoot);
    assert.equal(r.keeperConfig.ala, true);
    assert.deepEqual(r.keeperConfig.grantRoots, []);
    assert.ok(r.events.indexOf('attach:provider') < r.events.indexOf('create:endpoint'));
    assert.ok(r.events.indexOf('attach:endpoint') < r.events.indexOf('attach:control'));
    assert.ok(r.events.indexOf('attach:control') < r.events.indexOf('create:endpoint'));
    assert.deepEqual(r.endpointConfig.admission.grants, []);
    assert.deepEqual(r.endpointConfig.admission.networkModes, ['none']);
    assert.deepEqual(r.endpointConfig.admission.inventory, r.options.admission.inventory);
    const orchestration = r.requests.find((entry) => entry.kind === 'process-tree').spec;
    assert.equal(orchestration.netns, null);
    assert.deepEqual(orchestration.env, { NODE_CHANNEL_FD: '3', NODE_CHANNEL_SERIALIZATION_MODE: 'json' });
    assert.equal(r.keeperConfig.env, undefined, 'final environment is not a keeper setup environment');
    const netns = r.state.listUnsettledResources().find((entry) => entry.kind === 'netns');
    assert.equal(r.provider.netnsHandle, `handle-${netns.resourceId}`);
    await r.provider.adapter.start({ process: 1, request: { executable: 'codex' }, streams: { stdin: '/synthetic/stream' } });
    const workload = r.requests.at(-1).spec;
    assert.equal(workload.role, 'workload');
    assert.equal(workload.netns, r.provider.netnsHandle);
    assert.deepEqual(r.events.filter((event) => /^(reserve|create|commit|gate):/.test(event)).slice(-4),
        ['reserve:process-tree', 'create:process-tree', 'commit:process-tree', 'gate:process-tree']);
    const stopped = apparatus.end({ classification: 'completed' });
    assert.equal(apparatus.end(), stopped);
    await stopped;
    assert.equal(r.ends, 1);
    assert.equal(r.state.listUnsettledResources().length, 0);
    assert.throws(() => r.provider.ledger.publish({ kind: 'process-tree' }), { code: 'execution_ending' });
    assert.equal(r.world.alive().filter((entry) => entry.pid !== 1).length, 0);
    await assert.rejects(apparatus.start(), { code: 'execution_ending' });
});

test('failed durable commit aborts the gated stage and never executes it', async (t) => {
    const r = rig(t, { commitFailure: 'endpoint' });
    const apparatus = createExecutionApparatus(r.options);
    await assert.rejects(apparatus.start(), /injected durable commit failure/);
    assert.ok(r.events.includes('abort:endpoint'));
    assert.ok(!r.events.includes('gate:endpoint'));
    assert.ok(!r.events.includes('create:process-tree'));
    assert.equal(r.ends, 1);
    assert.equal(r.state.listUnsettledResources().length, 0);
});

test('concurrent infrastructure, endpoint and control loss enter one end path', async (t) => {
    const r = rig(t);
    const apparatus = createExecutionApparatus(r.options);
    await apparatus.start();
    r.streams.stdout.write('not-json\n');
    r.keeperConfig.onInfrastructureLoss('keeper_lost');
    r.socket.destroy();
    const ended = apparatus.end();
    await ended;
    await tick();
    r.keeperConfig.onInfrastructureLoss('late_keeper_lost');
    assert.equal(apparatus.end(), ended);
    assert.equal(r.ends, 1);
    assert.equal(apparatus.diagnostics().phase, 'ended');
    assert.equal(apparatus.diagnostics().endReason, 'control_stream_violation');
});

for (const hook of ['afterReserve', 'afterCreate', 'afterCommit', 'afterGateRelease']) {
    test(`cancellation at ${hook} fences late continuation`, async (t) => {
        let apparatus;
        let ending;
        const r = rig(t, { faults: { [hook]: ({ kind }) => {
            if (kind === 'endpoint') ending = apparatus.end();
        } } });
        apparatus = createExecutionApparatus(r.options);
        await assert.rejects(apparatus.start(), { code: 'execution_ending' });
        await ending;
        assert.equal(r.ends, 1);
        assert.ok(!r.events.includes('create:process-tree'));
        if (hook !== 'afterGateRelease') assert.ok(!r.events.includes('gate:endpoint'));
        assert.equal(r.state.listUnsettledResources().length, 0);
    });
}

test('late create is aborted; teardown waits before proving and settling absence', async (t) => {
    const reached = deferred();
    const resume = deferred();
    const r = rig(t, { delayCreate: async ({ kind }) => {
        if (kind === 'endpoint') { reached.resolve(); await resume.promise; }
    } });
    const apparatus = createExecutionApparatus(r.options);
    const starting = apparatus.start();
    const rejected = assert.rejects(starting, { code: 'execution_ending' });
    await reached.promise;
    const ending = apparatus.end();
    await tick();
    assert.equal(r.ends, 0);
    assert.ok(r.state.listUnsettledResources().some((entry) => entry.kind === 'endpoint'));
    resume.resolve();
    await Promise.all([rejected, ending]);
    assert.ok(r.events.includes('abort:endpoint'));
    assert.ok(!r.events.includes('commit:endpoint'));
    assert.equal(r.ends, 1);
    assert.equal(r.state.listUnsettledResources().length, 0);
});

test('a stuck publication fails bounded teardown without settling its ownership', async (t) => {
    const reached = deferred();
    const resume = deferred();
    const r = rig(t, { limits: { publicationDrainMs: 20 }, delayCreate: async ({ kind }) => {
        if (kind === 'endpoint') { reached.resolve(); await resume.promise; }
    } });
    const apparatus = createExecutionApparatus(r.options);
    const starting = apparatus.start();
    const rejected = assert.rejects(starting, { code: 'publication_drain_timeout' });
    await reached.promise;
    await assert.rejects(apparatus.end(), { code: 'publication_drain_timeout' });
    assert.equal(r.ends, 0);
    assert.equal(apparatus.diagnostics().endFailed, true);
    assert.ok(r.state.listUnsettledResources().length > 0);
    resume.resolve();
    await rejected;
    assert.ok(!r.events.includes('gate:endpoint'));
});

test('control callback failure ends once and late record delivery cannot restart admission', async (t) => {
    const reached = deferred();
    const resume = deferred();
    let records = 0;
    const r = rig(t, { onRecord: async () => { records += 1; reached.resolve(); await resume.promise; throw new Error('synthetic'); } });
    const apparatus = createExecutionApparatus(r.options);
    await apparatus.start();
    r.streams.stdout.write('{}\n');
    await reached.promise;
    await apparatus.end();
    resume.resolve();
    await tick();
    assert.equal(records, 1);
    assert.equal(r.ends, 1);
    assert.equal(apparatus.diagnostics().phase, 'ended');
});

test('a surviving process is quarantined by the real walker despite completed teardown requests', async (t) => {
    const r = rig(t, { keeperOptions: { stuckTrees: true } });
    const apparatus = createExecutionApparatus(r.options);
    await apparatus.start();
    const result = await apparatus.end({ classification: 'completed' });
    assert.equal(result.reference.result.reason, 'termination_unverified');
    assert.equal(result.reference.result.cleanup, 'quarantined');
    assert.ok(result.releaseLog.some((entry) => entry.kind === 'process-tree' && entry.outcome === 'quarantined'));
    assert.ok(r.world.alive().some((entry) => entry.role === 'tree'));
});

test('control delivery failure while running initiates the failure path', async (t) => {
    const r = rig(t, { onRecord: async () => { throw new Error('synthetic delivery failure'); } });
    const apparatus = createExecutionApparatus(r.options);
    await apparatus.start();
    r.streams.stdout.write('{}\n');
    await tick();
    await apparatus.end();
    assert.equal(r.ends, 1);
    assert.equal(apparatus.diagnostics().endReason, 'control_record_failed');
});

test('recovery reopens the durable store and delegates generation recovery with recorded ownership', async (t) => {
    const r = rig(t, { faults: { afterCreate: ({ kind }) => {
        if (kind === 'endpoint') throw Object.assign(new Error('supervisor crash'), { injectedCrash: true });
    } } });
    const crashed = createExecutionApparatus(r.options);
    await assert.rejects(crashed.start(), /supervisor crash/);
    assert.equal(r.ends, 0);
    const blockers = r.state.listUnsettledResources();
    assert.ok(blockers.some((entry) => entry.kind === 'endpoint' && entry.identity === null));
    const generation = r.state.generationId;
    r.world.crashSupervisor();
    const replacement = createExecutionApparatus(r.options);
    const recovery = replacement.recover();
    assert.equal(replacement.recover(), recovery);
    const result = await recovery;
    assert.equal(r.reopenCount, 1);
    assert.equal(result.priorGenerationId, generation);
    assert.notEqual(result.generationId, generation);
    assert.deepEqual(new Set(result.outcomes.map((entry) => entry.resourceId)), new Set(blockers.map((entry) => entry.resourceId)));
    assert.ok(result.outcomes.every((entry) => entry.outcome === 'released'));
    assert.equal(r.state.listUnsettledResources().length, 0);
    assert.equal(r.state.getReference(r.context, { referenceId: r.admitted.reference.id }).result.status, 'interrupted');
    await assert.rejects(replacement.start(), { code: 'execution_ending' });
});

test('missing required configuration fails before constructing adapters or reserving resources', (t) => {
    const r = rig(t);
    const mutations = [
        { synthetic: false }, { reopenState: null }, { context: null }, { admission: {} }, { home: null },
        { layout: { ...r.options.layout, cgroupSubtree: '/sys/fs/cgroup' } }, { orchestration: null },
        { limits: { ...r.options.limits, releaseDeadlineMs: 0 } }, { onRecord: null }, { validateRecord: null },
    ];
    for (const mutation of mutations) {
        let effects = 0;
        assert.throws(() => createExecutionApparatus({ ...r.options, ...mutation, adapters: {
            createProcView() { effects += 1; throw new Error('unexpected construction'); },
        } }), TypeError);
        assert.equal(effects, 0);
        assert.equal(r.state.listUnsettledResources().length, 0);
    }
});

test('recovery refuses a different durable store before rolling its generation', async (t) => {
    const r = rig(t);
    const foreign = openStore(makeTempDir(t));
    t.after(() => foreign.close());
    const generation = foreign.generationId;
    const apparatus = createExecutionApparatus({ ...r.options, reopenState: () => foreign });
    await assert.rejects(apparatus.recover());
    assert.equal(foreign.generationId, generation);
    assert.equal(apparatus.diagnostics().phase, 'recovery_failed');
    await assert.rejects(apparatus.end(), { code: 'execution_ending' });
});

test('default real procView and keeper construct without spawning; fake proc needs an explicit signal', async (t) => {
    const r = rig(t);
    const procRoot = path.join(r.options.layout.runtimeDir, 'fake-proc');
    fs.mkdirSync(procRoot, { recursive: true });
    assert.throws(() => createExecutionApparatus({ ...r.options, adapters: {}, procOptions: { procRoot } }), /explicit signal/);
    const apparatus = createExecutionApparatus({ ...r.options, adapters: {}, procOptions: { procRoot, signal: () => { throw new Error('unexpected signal'); } } });
    assert.equal(apparatus.diagnostics().keeper.spawned, false);
    assert.equal(createProcView({ procRoot, signal: () => false }).cgroupSubtree, null);
    await apparatus.end();
    assert.equal(r.ends, 1);
});

test('production server modules have no apparatus dependency', () => {
    const root = fileURLToPath(new URL('../../../server/', import.meta.url));
    const files = fs.readdirSync(root, { recursive: true }).filter((name) => /\.(mjs|cjs|js)$/.test(name));
    assert.ok(files.length > 0);
    for (const name of files) assert.doesNotMatch(fs.readFileSync(path.join(root, name), 'utf8'), /executionApparatus|tests\/g1/,
        `Production dependency from ${name}`);
});
