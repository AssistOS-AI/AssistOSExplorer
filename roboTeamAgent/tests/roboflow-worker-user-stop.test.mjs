import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { RoboFlowService } from '../server/roboflow/roboflow-service.mjs';
import { stopOperationId } from '../server/worker-coordinator/worker-client.mjs';
import { phaseOriginId } from '../server/worker-coordinator/flow-origins.mjs';

// A user's pause, terminate and live message of a RoboFlow phase are worker controls (decisions M-12 (b), M-40): they carry the
// requesting user's own grant, never the flow binding. A system-initiated stop (flow failure) keeps the coordinator identity and
// the binding. A user stop that does not reach the worker is told to that user.
const REFERENCE = 'r'.repeat(22);
const task = (id) => ({ id, name: id, prompt: `Execute ${id}`, executionType: 'terminal', skillsets: [] });
const graph = { id: 'stopping', name: 'Stopping', description: 'one phase', entryTaskId: 'a', tasks: [task('a')], edges: [] };

// The worker records a phase's origin under the binding row (`binding:<flowId>`): a lookup finds it only with that binding. An
// owner-context lookup (a grant) searches the user's own row and never finds it; a control needs the user's grant.
const bindingOnly = (admitted) => async (origin, auth) => (auth?.bindingId && admitted.has(`${auth.bindingId}\n${origin}`) ? { referenceId: REFERENCE } : null);

async function fixture(t, { lookup = null, root: given = null, admittedOrigins = new Set(), control = null, workerState = { value: 'running' } } = {}) {
    const root = given || await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'roboflow-user-stop-')));
    if (!given) t.after(() => fs.rm(root, { recursive: true, force: true }));
    const admitted = admittedOrigins;
    const finder = lookup || bindingOnly(admitted);
    const stops = [];
    const messages = [];
    const started = [];
    const calls = { lookup: [], control: [] };
    const robots = [{ id: 'default-id', name: 'default', codingAgents: ['codex'] }];
    const runtimeManager = { resolveCwd: async (value) => value, guiBusy: () => false,
        stopTask(robot, type, taskId, options) { stops.push({ taskId, options }); return { state: 'completed' }; },
        sendTaskMessage(robot, taskId, prompt, options) { messages.push({ taskId, prompt, options }); return { delivery: 'delivered' }; },
        startTask(robot, type, request) { started.push(request.runtimeTaskId); return { taskId: request.runtimeTaskId, state: 'queued' }; },
        resumeTask(robot, taskId, prompt, options = {}) { started.push(options.runtimeTaskId); return { taskId: options.runtimeTaskId, state: 'queued' }; } };
    let service;
    // The restart reconciliation (which begins with `sleep(0)`) is parked, so it neither answers nor adds calls of its own to what these tests count.
    const parked = [];
    const workerClient = {
        async lookup(origin, auth) { calls.lookup.push({ origin, auth }); return finder(origin, auth); },
        async control(referenceId, body, auth) { calls.control.push({ referenceId, body, auth, flowStatus: (await service.store.list())[0]?.status }); if (control) await control(auth); return {}; },
        async read() { return { state: workerState.value, result: {} }; },
    };
    service = new RoboFlowService({ robotStore: { list: async () => robots, getByName: async (name) => robots.find((robot) => robot.name === name), get: async (id) => robots.find((robot) => robot.id === id) },
        runtimeManager, databaseFile: path.join(root, 'roboflow.sqlite'), workflowsDirectory: path.join(root, 'old'), random: () => 0.99,
        discoverSkillsets: async () => ({ skillsets: [], diagnostics: [] }),
        skillsets: { repositoriesClient: { listRepositories: async () => [{ name: 'DocumentationSkills', source: root, origin: 'local' }] }, start: async (robot, input, enqueue) => enqueue(robot) },
        workerMode: true, workerClient, workerSleep: (ms) => new Promise((resolve) => { if (ms === 0) parked.push(resolve); else setTimeout(resolve, 1); }) });
    await service.initialize();
    await service.presetReady;
    let closed = false;
    const close = async () => { if (closed) return; closed = true; parked.splice(0).forEach((resolve) => resolve()); await service.close(); };
    t.after(close);
    if (!given) await service.createWorkflow(graph);
    const start = async () => {
        const flow = await service.startFlow({ workflowTypeId: 'stopping', folder: root, objective: 'Work', ownerPrincipal: 'user:alice' });
        const instance = (await service.getFlow(flow.id)).instances[0];
        admitted.add(`${flow.id}\n${phaseOriginId({ flowId: flow.id, instanceId: instance.id, runtimeTaskId: instance.runtimeTaskId })}`);
        return { flow, instance };
    };
    return { service, stops, messages, calls, start, root, admitted, close, workerState, started };
}
// The requester a route passes down: the flow's owner (alice) unless said otherwise.
const asUser = (grant, extra = {}) => ({ grant, principal: 'user:alice', admin: false, undelivered: [], ...extra });
const authsOf = (calls) => [calls.lookup.map((call) => call.auth), calls.control.map((call) => call.auth)];

test('a user pause finds the phase with the binding, stops it with the request\'s own grant, and the task child gets the same grant', async (t) => {
    const f = await fixture(t);
    const { flow } = await f.start();
    const user = asUser('h.e30.PAUSEGRANT');
    await f.service.pauseFlow(flow.id, user);
    assert.equal(f.stops.length, 1);
    assert.deepEqual(f.stops[0].options, { userInitiated: true, ownerGrant: 'h.e30.PAUSEGRANT' });
    assert.deepEqual(authsOf(f.calls), [[{ bindingId: flow.id }], [{ grant: 'h.e30.PAUSEGRANT' }]], 'found with the binding, stopped with the user\'s own grant');
    assert.equal(f.calls.control[0].body.op, 'stop');
    assert.equal(f.calls.control[0].body.operationId, stopOperationId(REFERENCE));
    assert.deepEqual(user.undelivered, []);
});

test('a user terminate (and its child flows) carry the grant too; a system failure keeps the binding and no user mark', async (t) => {
    const f = await fixture(t);
    const { flow } = await f.start();
    await f.service.terminateFlow(flow.id, asUser('h.e30.TERMGRANT'));
    assert.deepEqual(f.stops.at(-1).options, { userInitiated: true, ownerGrant: 'h.e30.TERMGRANT' });
    assert.deepEqual(authsOf(f.calls), [[{ bindingId: flow.id }], [{ grant: 'h.e30.TERMGRANT' }]]);

    const g = await fixture(t);
    const { flow: second } = await g.start();
    await g.service._fail(second.id, 'The flow failed', 'failed');
    assert.equal(g.stops[0].options, undefined, 'a system stop carries no user mark and no grant');
    assert.deepEqual(authsOf(g.calls), [[{ bindingId: second.id }], [{ bindingId: second.id }]]);
});

test('a stop the worker did not accept changes nothing: 409 with the notice, the phase stays running, and a later terminal settles it', async (t) => {
    const f = await fixture(t, { control: async () => { throw Object.assign(new Error('forbidden'), { code: 'forbidden' }); } });
    const { flow, instance } = await f.start();
    const user = asUser('h.e30.REFUSED');
    await assert.rejects(f.service.pauseFlow(flow.id, user), (error) => error.statusCode === 409
        && /^Stop not delivered: the worker needs your fresh authorization\. The task may still be running; press stop again\.$/.test(error.message));
    assert.deepEqual(user.undelivered.map((entry) => entry.code), ['forbidden']);
    const after = await f.service.getFlow(flow.id);
    assert.notEqual(after.status, 'paused');
    assert.equal(after.instances[0].state, instance.state, 'the phase is exactly as it was and is still followed');
    assert.equal(f.stops.length, 0, 'the phase\'s task child was not told to stop either');
    // The same for terminate: the irreversible gate is not persisted.
    await assert.rejects(f.service.terminateFlow(flow.id, asUser('h.e30.REFUSED2')), (error) => error.statusCode === 409);
    assert.notEqual((await f.service.getFlow(flow.id)).status, 'terminated');
    // Transport failures and a phase the worker lost are not delivered either.
    const lost = await fixture(t, { lookup: async () => null });
    const started = await lost.start();
    await lost.service.store.update(started.flow.id, (current) => { current.instances[0].startedAt = new Date().toISOString(); });
    await assert.rejects(lost.service.pauseFlow(started.flow.id, asUser('h.e30.LOST')), (error) => error.statusCode === 409 && /worker_phase_not_found/.test(error.message));
    assert.notEqual((await lost.service.getFlow(started.flow.id)).status, 'paused');
    // The worker later reports the phase terminal: reconciliation/the runtime event settles it as before.
    f.service.onRuntimeTaskEvent({ kind: 'terminal', taskId: instance.runtimeTaskId ?? (await f.service.store.get(flow.id)).instances[0].runtimeTaskId, state: 'paused', error: 'Task cancelled on the worker.' });
    while (f.service.chains.size) await Promise.allSettled(f.service.chains.values());
    assert.equal((await f.service.getFlow(flow.id)).instances[0].state, 'paused');
});

test('only the flow\'s owner or an administrator changes its state: a stranger gets 403 and nothing changes, no worker call is made', async (t) => {
    const f = await fixture(t);
    const { flow, instance } = await f.start();
    const stranger = asUser('h.e30.STRANGER', { principal: 'user:victor' });
    for (const call of [() => f.service.pauseFlow(flow.id, stranger), () => f.service.terminateFlow(flow.id, stranger), () => f.service.pauseInstance(flow.id, instance.id, stranger)]) {
        await assert.rejects(call(), (error) => error.statusCode === 403);
    }
    assert.equal(f.calls.lookup.length, 0);
    assert.equal(f.calls.control.length, 0);
    assert.equal(f.stops.length, 0);
    assert.notEqual((await f.service.getFlow(flow.id)).status, 'paused');
    // The owner is not the only one allowed: an administrator is, with their own grant.
    const admin = asUser('h.e30.ADMIN', { principal: 'user:root', admin: true });
    assert.equal((await f.service.pauseFlow(flow.id, admin)).status, 'paused');
    assert.deepEqual(f.calls.control.map((call) => call.auth), [{ grant: 'h.e30.ADMIN' }]);
    // A message is the owner's alone, as at the worker.
    const g = await fixture(t);
    const second = await g.start();
    await assert.rejects(g.service.messageInstance(second.flow.id, second.instance.id, 'hi', asUser('h.e30.ADM', { principal: 'user:root', admin: true })), (error) => error.statusCode === 403);
    assert.equal(g.messages.length, 0);
});

test('a phase is not continued while the worker may still be running its previous attempt', async (t) => {
    const f = await fixture(t);
    const { flow, instance } = await f.start();
    await f.service.store.update(flow.id, (current) => { current.instances[0].startedAt = new Date().toISOString(); });
    const paused = await f.service.pauseFlow(flow.id, asUser('h.e30.OWNER'));
    assert.equal(paused.status, 'paused');
    f.started.length = 0;
    // The worker still reports it running (a system stop that was not delivered, a stop that was not confirmed).
    f.workerState.value = 'running';
    await assert.rejects(f.service.resumeInstance(flow.id, instance.id, 'go on'), (error) => error.statusCode === 409 && /still running on the worker/.test(error.message));
    await assert.rejects(f.service.resumeFlow(flow.id), (error) => /still running on the worker/.test(error.message));
    assert.deepEqual(f.started, [], 'no second attempt was dispatched into the same project');
    // The worker cannot answer: not a yes either.
    f.workerState.value = 'weird';
    await assert.rejects(f.service.resumeInstance(flow.id, instance.id, 'go on'), (error) => error.statusCode === 409);
    // Once the worker reports it ended, the continuation goes ahead.
    f.workerState.value = 'cancelled';
    await f.service.resumeInstance(flow.id, instance.id, 'go on');
    assert.equal(f.started.length, 1);
});

test('a live message of a running phase carries the messaging request\'s own grant', async (t) => {
    const f = await fixture(t);
    const { flow, instance } = await f.start();
    await f.service.messageInstance(flow.id, instance.id, 'also check the logs', asUser('h.e30.MSGGRANT'));
    assert.deepEqual(f.messages[0].options, { ownerGrant: 'h.e30.MSGGRANT' });
    await f.service.messageInstance(flow.id, instance.id, 'and again');
    assert.equal(f.messages[1].options, undefined);
});

test('after a restart there is no task child: the pause still stops the worker execution with the user\'s grant, and the flow is paused only after the worker accepted', async (t) => {
    const first = await fixture(t);
    const { flow } = await first.start();
    await first.close();
    // A new RoboTeam process over the same data: its runtime manager knows no task, so only the worker can still be stopped.
    const second = await fixture(t, { root: first.root, admittedOrigins: first.admitted });
    assert.notEqual((await second.service.getFlow(flow.id)).status, 'paused');
    const user = asUser('h.e30.AFTERRESTART');
    const paused = await second.service.pauseFlow(flow.id, user);
    assert.deepEqual(second.calls.lookup.map((call) => call.auth), [{ bindingId: flow.id }], 'the phase is found by its binding');
    assert.equal(second.calls.control.length, 1, 'the stop was sent although no task child exists');
    assert.deepEqual(second.calls.control[0].auth, { grant: 'h.e30.AFTERRESTART' });
    assert.equal(second.calls.control[0].body.op, 'stop');
    assert.notEqual(second.calls.control[0].flowStatus, 'paused', 'not shown as paused before the worker was asked');
    assert.equal(paused.status, 'paused');
    assert.deepEqual(user.undelivered, []);
});

test('a lookup that finds nothing for a phase that had started is reported as not delivered; for one that never started it is nothing to stop', async (t) => {
    const f = await fixture(t, { lookup: async () => null });
    const { flow, instance } = await f.start();
    const idle = asUser('h.e30.IDLE');
    await f.service._stopWorkerPhase(await f.service.store.get(flow.id), instance, idle);
    assert.deepEqual(idle.undelivered, [], 'the phase was never admitted by the worker and never started: nothing to stop');
    await f.service.store.update(flow.id, (current) => { current.instances[0].startedAt = new Date().toISOString(); });
    const started = asUser('h.e30.STARTED');
    const current = await f.service.store.get(flow.id);
    await f.service._stopWorkerPhase(current, current.instances[0], started);
    assert.deepEqual(started.undelivered, [{ instanceId: instance.id, code: 'worker_phase_not_found' }]);
    assert.equal(f.calls.control.length, 0);
});
