import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { RoboFlowService } from '../server/roboflow/roboflow-service.mjs';
import { classifyPhase } from '../server/roboflow/worker-reconciliation.mjs';
import { phaseOriginId, workerBindingFor } from '../server/worker-coordinator/flow-origins.mjs';
import { WorkerError, stopOperationId } from '../server/worker-coordinator/worker-client.mjs';
import { isOriginId } from '../server/worker-coordinator/identities.mjs';

// RoboFlow after a RoboTeam restart with the worker configured (plan section 9, decision M-5): the
// worker is asked about every unfinished phase by its deterministic origin before anything changes.
const task = (id) => ({ id, name: id, prompt: `Execute ${id}`, executionType: 'terminal', skillsets: [] });
const linear = { id: 'linear', name: 'Linear', description: 'a then b', entryTaskId: 'a', tasks: [task('a'), task('b')], edges: [{ id: 'a-b', sourceTaskId: 'a', targetTaskId: 'b' }] };
const tick = () => new Promise((resolve) => setTimeout(resolve, 1));

function runtimeManagerFor(started) {
    return { resolveCwd: async (value) => value, guiBusy: () => false, stopTask() {},
        startTask(robot, type, request) { started.push({ robot, type, request, taskId: request.runtimeTaskId }); return { taskId: request.runtimeTaskId, state: 'queued' }; } };
}

async function open(root, started, extra = {}) {
    const robots = [{ id: 'default-id', name: 'default', codingAgents: ['codex'] }];
    const robotStore = { list: async () => robots, getByName: async (name) => robots.find((robot) => robot.name === name), get: async (id) => robots.find((robot) => robot.id === id) };
    const service = new RoboFlowService({ robotStore, runtimeManager: runtimeManagerFor(started), databaseFile: path.join(root, 'roboflow.sqlite'),
        workflowsDirectory: path.join(root, 'old'), random: () => 0.99, discoverSkillsets: async () => ({ skillsets: [], diagnostics: [] }),
        skillsets: { repositoriesClient: { listRepositories: async () => [{ name: 'DocumentationSkills', source: root, origin: 'local' }] }, start: async (robot, input, enqueue) => enqueue(robot) },
        ...extra });
    await service.initialize();
    await service.presetReady;
    return service;
}

// A flow whose first phase is running when RoboTeam goes down.
async function interrupted(t) {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'roboflow-worker-')));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const before = [];
    const first = await open(root, before);
    await first.createWorkflow(linear);
    const flow = await first.startFlow({ workflowTypeId: 'linear', folder: root, objective: 'Work' });
    first.onRuntimeTaskEvent({ kind: 'state', taskId: before[0].taskId, state: 'running' });
    while (first.chains.size) await Promise.allSettled(first.chains.values());
    const phase = (await first.store.get(flow.id)).instances[0];
    assert.equal(phase.state, 'running');
    await first.close();
    return { root, flowId: flow.id, phase, runtimeTaskId: before[0].taskId };
}

function fakeWorker(answers) {
    const calls = { lookup: [], read: [] };
    return { calls,
        async lookup(origin, auth) {
            calls.lookup.push({ origin, auth });
            const answer = typeof answers.lookup === 'function' ? answers.lookup(calls.lookup.length) : answers.lookup;
            if (answer instanceof Error) throw answer;
            return answer;
        },
        async control(referenceId, body, auth) { (calls.control ||= []).push({ referenceId, body, auth }); return { outcome: 'accepted' }; },
        async read(referenceId, auth) {
            calls.read.push({ referenceId, auth });
            const answer = typeof answers.read === 'function' ? answers.read(calls.read.length) : answers.read;
            if (answer instanceof Error) throw answer;
            return answer;
        } };
}

async function reconcile(t, setup, worker) {
    const after = [];
    const service = await open(setup.root, after, { workerMode: true, workerClient: worker, workerSleep: tick, workerReconcileMs: 1 });
    t.after(() => service.close());
    await service.reconciliation;
    while (service.chains.size) await Promise.allSettled(service.chains.values());
    return { service, after, flow: await service.store.get(setup.flowId) };
}

const ACCEPTED = { referenceId: 'r'.repeat(22), state: 'running', originRequestId: 'x' };

test('a phase that finished while RoboTeam was down is committed and its successor is dispatched once', async (t) => {
    const setup = await interrupted(t);
    const worker = fakeWorker({ lookup: ACCEPTED, read: { state: 'completed', result: { status: 'completed', outputText: 'Done while down' } } });
    const { flow, after } = await reconcile(t, setup, worker);
    assert.equal(flow.instances.length, 2);
    assert.equal(flow.instances[0].state, 'completed');
    assert.equal(flow.instances[1].taskId, 'b');
    assert.equal(flow.status, 'running');
    assert.equal(after.length, 1, 'exactly one successor dispatched');
    assert.equal(after[0].request.workflowInstanceId, flow.instances[1].id);
    // The worker was asked by the phase's deterministic origin and the flow binding, with no user grant.
    assert.deepEqual(worker.calls.lookup, [{ origin: phaseOriginId({ flowId: setup.flowId, instanceId: setup.phase.id, runtimeTaskId: setup.runtimeTaskId }), auth: { bindingId: setup.flowId } }]);
    assert.deepEqual(worker.calls.read, [{ referenceId: ACCEPTED.referenceId, auth: { bindingId: setup.flowId } }]);
});

test('an unknown outcome changes nothing and dispatches nothing; the answer that follows is applied once', async (t) => {
    const setup = await interrupted(t);
    const unknown = new WorkerError('worker_reply_unknown', 503);
    let asked = 0;
    const worker = fakeWorker({ lookup: (count) => { asked = count; return count < 3 ? unknown : ACCEPTED; },
        read: { state: 'completed', result: { status: 'completed', outputText: 'Late' } } });
    const observed = [];
    const after = [];
    // Reconciliation is held at its first sleep until the service exists, so every later pause is observed.
    let service;
    let release;
    const ready = new Promise((resolve) => { release = resolve; });
    service = await open(setup.root, after, { workerMode: true, workerClient: worker, workerReconcileMs: 1,
        workerSleep: async () => { await ready; observed.push((await service.store.get(setup.flowId)).instances.map((instance) => instance.state)); await tick(); } });
    t.after(() => service.close());
    release();
    await service.reconciliation;
    while (service.chains.size) await Promise.allSettled(service.chains.values());
    assert.ok(asked >= 3);
    assert.ok(observed.length >= 2);
    for (const states of observed) assert.deepEqual(states, ['running'], 'not reset to paused and no successor while the outcome is unknown');
    assert.equal((await service.store.get(setup.flowId)).instances[0].state, 'completed');
    assert.equal(after.length, 1);
});

test('termination_unverified is a phase failure: no successor, and the recorded reason is kept', async (t) => {
    const setup = await interrupted(t);
    const worker = fakeWorker({ lookup: ACCEPTED, read: { state: 'failed', result: { status: 'failed', reason: 'termination_unverified', outputText: 'partial output' } } });
    const { flow, after } = await reconcile(t, setup, worker);
    assert.equal(flow.instances.length, 1);
    assert.equal(flow.instances[0].state, 'failed');
    assert.match(flow.instances[0].error, /termination_unverified/);
    assert.equal(flow.status, 'failed');
    assert.equal(after.length, 0);
});

test('a phase the worker never admitted is paused as before; a running one is followed until it ends', async (t) => {
    const never = await interrupted(t);
    const { flow, after } = await reconcile(t, never, fakeWorker({ lookup: null }));
    assert.equal(flow.instances[0].state, 'paused');
    assert.equal(flow.instances[0].error, 'interrupted by service restart');
    assert.equal(after.length, 0);

    const running = await interrupted(t);
    const worker = fakeWorker({ lookup: ACCEPTED, read: (count) => (count < 3 ? { state: 'running' } : { state: 'completed', result: { status: 'completed', outputText: 'Ended' } }) });
    const followed = await reconcile(t, running, worker);
    assert.equal(worker.calls.read.length, 3, 'followed while running');
    assert.equal(followed.flow.instances[0].state, 'completed');
    assert.equal(followed.after.length, 1);

    const stopped = await interrupted(t);
    const cancelled = await reconcile(t, stopped, fakeWorker({ lookup: ACCEPTED, read: { state: 'cancelled', result: { status: 'cancelled', outputText: '' } } }));
    assert.equal(cancelled.flow.instances[0].state, 'paused');
    assert.equal(cancelled.after.length, 0);
});

test('without the worker the restart behavior is unchanged: unfinished phases are paused', async (t) => {
    const setup = await interrupted(t);
    const after = [];
    const service = await open(setup.root, after, { workerMode: false });
    t.after(() => service.close());
    const flow = await service.store.get(setup.flowId);
    assert.equal(flow.instances[0].state, 'paused');
    assert.equal(flow.instances[0].error, 'interrupted by service restart');
});

test('classification reads the worker by origin and binding and maps every state', async () => {
    const flow = { id: `flow_${'ab'.repeat(12)}` };
    const instance = { id: 'inv_1', runtimeTaskId: 'task-1' };
    const decide = (answers) => classifyPhase({ client: fakeWorker(answers), flow, instance });
    assert.equal((await decide({ lookup: null })).action, 'never_admitted');
    assert.equal((await decide({ lookup: new WorkerError('worker_unreachable', 503) })).action, 'unknown');
    assert.equal((await decide({ lookup: ACCEPTED, read: new WorkerError('forbidden', 403) })).action, 'unknown');
    for (const state of ['queued', 'running', 'stopping']) assert.equal((await decide({ lookup: ACCEPTED, read: { state } })).action, 'running', state);
    assert.equal((await decide({ lookup: ACCEPTED, read: { state: 'mystery' } })).action, 'unknown');
    const failed = await decide({ lookup: ACCEPTED, read: { state: 'failed', result: { reason: 'termination_unverified', outputText: 'x' } } });
    assert.equal(failed.terminationUnverified, true);
    assert.equal(failed.event.state, 'failed');
    const done = await decide({ lookup: ACCEPTED, read: { state: 'completed', result: { outputText: 'ok' } } });
    assert.deepEqual(done.event, { kind: 'terminal', taskId: 'task-1', state: 'completed', result: 'ok', error: null });
});

test('phase origins are deterministic per attempt and canonical origin IDs', () => {
    const flowId = `flow_${'ab'.repeat(12)}`;
    const origin = phaseOriginId({ flowId, instanceId: 'inv_1', runtimeTaskId: 'task-1' });
    assert.equal(isOriginId(origin), true);
    assert.equal(phaseOriginId({ flowId, instanceId: 'inv_1', runtimeTaskId: 'task-1' }), origin);
    for (const other of [{ flowId: `flow_${'cd'.repeat(12)}` }, { instanceId: 'inv_2' }, { runtimeTaskId: 'task-2' }]) {
        assert.notEqual(phaseOriginId({ flowId, instanceId: 'inv_1', runtimeTaskId: 'task-1', ...other }), origin);
    }
    assert.throws(() => phaseOriginId({ flowId, instanceId: '', runtimeTaskId: 'task-1' }), TypeError);
    assert.deepEqual(workerBindingFor({ workflowRunId: flowId, workflowInstanceId: 'inv_1' }, 'task-1'), { bindingId: flowId, originRequestId: origin });
    assert.equal(workerBindingFor({ workflowRunId: 'not-a-flow', workflowInstanceId: 'inv_1' }, 'task-1'), null);
    assert.equal(workerBindingFor({}, 'task-1'), null);
});


test('the request that starts a flow registers its binding before the first phase is admitted; a failure fails the flow', async (t) => {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'roboflow-before-')));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const started = [];
    const service = await open(root, started);
    t.after(() => service.close());
    await service.createWorkflow(linear);
    const order = [];
    const flow = await service.startFlow({ workflowTypeId: 'linear', folder: root, objective: 'Work' },
        { beforeDispatch: (created) => { order.push(['register', created.id, started.length]); } });
    assert.deepEqual(order, [['register', flow.id, 0]], 'registered while nothing had been dispatched');
    assert.equal(started.length, 1);

    await assert.rejects(service.startFlow({ workflowTypeId: 'linear', folder: root, objective: 'Work' },
        { beforeDispatch: () => { throw Object.assign(new Error('forbidden'), { statusCode: 403 }); } }), (error) => error.statusCode === 403);
    assert.equal(started.length, 1, 'no phase was dispatched for the refused flow');
    const failed = (await service.store.list()).find((item) => item.id !== flow.id);
    assert.equal(failed.status, 'failed');
    assert.match(failed.error, /could not be registered with the worker: forbidden/);
});

test('cancelling or pausing a flow stops its worker phase with the coordinator identity and the binding, no user grant', async (t) => {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'roboflow-stop-')));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const started = [];
    const worker = fakeWorker({ lookup: ACCEPTED, read: { state: 'running' } });
    const service = await open(root, started, { workerMode: true, workerClient: worker, workerSleep: tick, workerReconcileMs: 1 });
    t.after(() => service.close());
    await service.createWorkflow(linear);
    const flow = await service.startFlow({ workflowTypeId: 'linear', folder: root, objective: 'Work' });
    service.onRuntimeTaskEvent({ kind: 'state', taskId: started[0].taskId, state: 'running' });
    while (service.chains.size) await Promise.allSettled(service.chains.values());
    await service.pauseFlow(flow.id);
    const phase = (await service.store.get(flow.id)).instances[0];
    assert.equal(phase.state, 'paused');
    assert.deepEqual(worker.calls.control, [{ referenceId: ACCEPTED.referenceId, body: { operationId: stopOperationId(ACCEPTED.referenceId), op: 'stop' }, auth: { bindingId: flow.id } }]);
    assert.deepEqual(worker.calls.lookup.at(-1).auth, { bindingId: flow.id });

    // A phase the worker never admitted needs no stop.
    const never = fakeWorker({ lookup: null });
    const rootTwo = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'roboflow-stop2-')));
    t.after(() => fs.rm(rootTwo, { recursive: true, force: true }));
    const other = await open(rootTwo, [], { workerMode: true, workerClient: never, workerSleep: tick });
    t.after(() => other.close());
    await other.createWorkflow(linear);
    const second = await other.startFlow({ workflowTypeId: 'linear', folder: rootTwo, objective: 'Work' });
    await other.pauseFlow(second.id);
    assert.equal(never.calls.lookup.length >= 1, true);
    assert.equal(never.calls.control, undefined);
});

test('a phase the worker stopped for inactivity or its maximum duration while RoboTeam was down fails the flow in plain words, with no successor and no retry', async (t) => {
    const cases = [
        // The worker's real shape: the end reason lives in result.data (only termination_unverified is top-level).
        [{ data: { reason: 'inactive_timeout', minutes: 20 } }, 'Stopped: no activity from the model for 20 minutes'],
        [{ data: { reason: 'deadline_exceeded' } }, 'Stopped: the task exceeded its maximum duration'],
    ];
    for (const [fields, message] of cases) {
        const setup = await interrupted(t);
        const worker = fakeWorker({ lookup: ACCEPTED, read: { state: 'failed', result: { status: 'failed', outputText: 'partial', ...fields } } });
        const { flow, after } = await reconcile(t, setup, worker);
        assert.equal(flow.instances.length, 1);
        assert.equal(flow.instances[0].state, 'failed');
        assert.equal(flow.instances[0].error, message);
        assert.equal(flow.status, 'failed');
        assert.equal(after.length, 0, 'no successor and no re-dispatch of the same phase');
        assert.equal(worker.calls.read.length, 1, 'the result was read once and never asked again');
    }
    const decision = await classifyPhase({ client: fakeWorker({ lookup: ACCEPTED, read: { state: 'failed', result: { data: { reason: 'inactive_timeout', minutes: 20 }, outputText: '' } } }), flow: { id: `flow_${'ab'.repeat(12)}` }, instance: { id: 'inv_1', runtimeTaskId: 'task-1' } });
    assert.equal(decision.event.error, 'Stopped: no activity from the model for 20 minutes');
    assert.equal(decision.terminationUnverified, false);
});
