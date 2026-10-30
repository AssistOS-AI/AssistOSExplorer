import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { RoboFlowService } from '../server/roboflow/roboflow-service.mjs';
import { ensureFlowRobots, prepareFlowStart } from '../server/worker-coordinator/grant-actions.mjs';
import { createRobotProvisioner, desiredConfiguration } from '../server/worker-coordinator/robot-provisioning.mjs';
import { WorkerError } from '../server/worker-coordinator/worker-client.mjs';
import { bindOperationId } from '../server/worker-coordinator/identities.mjs';

// Flow start with the worker (decisions M-13, F8): the request that starts a root flow registers its binding and prepares every
// robot its phases may use, with its own grant, before the first phase; a phase on the coordinator alone cannot configure a robot.
const FLOW = `flow_${'ab'.repeat(12)}`;
const GRANT = 'h.e30.STARTGRANT';
const response = (status, json) => ({ outcome: 'response', status, refusal: null, json });
const task = (id, extras = {}) => ({ id, name: id, prompt: `Execute ${id}`, executionType: 'terminal', skillsets: [], ...extras });
const linear = { id: 'linear', name: 'Linear', description: 'a then b', entryTaskId: 'a', tasks: [task('a'), task('b')], edges: [{ id: 'a-b', sourceTaskId: 'a', targetTaskId: 'b' }] };

test('the starting request registers the binding, then prepares each robot the flow may use, in that order and with its own grant', async () => {
    const order = [];
    const hop = { call: async (operation, body, options) => { order.push(['hop', operation, options.grant]); return response(200, { bindingId: FLOW }); } };
    const provisioner = { ensureReady: async (robot, auth) => { order.push(['ensure', robot.name, auth.grant]); } };
    const robots = [{ id: 'a-1', name: 'Alpha' }, { id: 'b-2', name: 'Beta' }];
    const outcome = await prepareFlowStart({ hop, provisioner, roboflow: { flowRobots: async () => robots }, flow: { id: FLOW }, grant: GRANT });
    assert.deepEqual(order, [['hop', 'bindings', GRANT], ['ensure', 'Alpha', GRANT], ['ensure', 'Beta', GRANT]]);
    assert.deepEqual(outcome, { registered: true, robots: ['a-1', 'b-2'] });
    // A child flow derives its binding from its parent and needs nothing here.
    order.length = 0;
    assert.deepEqual(await prepareFlowStart({ hop, provisioner, roboflow: { flowRobots: async () => robots }, flow: { id: FLOW, parentFlowId: `flow_${'cd'.repeat(12)}` }, grant: GRANT }), { registered: false, robots: [] });
    assert.deepEqual(order, []);
});

test('a robot that cannot be prepared stops the flow start with a message naming it; no grant prepares nothing', async () => {
    const provisioner = { ensureReady: async (robot) => { if (robot.name === 'Beta') throw new WorkerError('worker_robot_not_ready', 503); } };
    const robots = [{ id: 'a-1', name: 'Alpha' }, { id: 'b-2', name: 'Beta' }];
    await assert.rejects(ensureFlowRobots({ provisioner, robots, grant: GRANT }), (error) => error.statusCode === 503 && /Robot "Beta" could not be prepared on the worker \(worker_robot_not_ready\)/.test(error.message));
    await assert.rejects(ensureFlowRobots({ provisioner, robots, grant: null }), (error) => error.statusCode === 403);
    assert.deepEqual(await ensureFlowRobots({ provisioner, robots: [], grant: null }), []);
});

test('with the real provisioner a stale robot is reconfigured at flow start, so its phases find it current', async () => {
    const robot = { id: 'default-ab12cd', name: 'default', codingAgents: ['opencode'], worker: { robotId: 'AAAAAAAAAAAAAAAAAAAAAA' } };
    // The worker holds the configuration from before the M-26 default-model change.
    const stale = { robotId: 'AAAAAAAAAAAAAAAAAAAAAA', lifecycle: 'ready', revision: 2, configuration: { backend: 'opencode', settings: { codingAgents: ['opencode'] } }, preparing: false, ready: true };
    let current = stale;
    const calls = [];
    const client = {
        async getRobot() { return current; },
        async configure(body, auth) { calls.push({ body, auth }); current = { ...stale, revision: 3, configuration: body.configuration }; return {}; },
    };
    const provisioner = createRobotProvisioner({ client, robotStore: {}, sleep: async () => {} });
    await ensureFlowRobots({ provisioner, robots: [robot], grant: GRANT });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].body.expectedRevision, 2);
    assert.deepEqual(calls[0].body.configuration, desiredConfiguration(robot));
    assert.equal(calls[0].body.configuration.settings.modelSource, 'default');
    assert.deepEqual(calls[0].auth, { grant: GRANT });
    // The phase itself, on the coordinator alone and now current, needs no configure.
    calls.length = 0;
    await provisioner.ensureReady(robot, {});
    assert.deepEqual(calls, []);
});

test('a phase that still finds the robot stale fails with a message for the user, not an opaque exit', async () => {
    const robot = { id: 'default-ab12cd', name: 'Helper', codingAgents: ['codex'], worker: { robotId: 'AAAAAAAAAAAAAAAAAAAAAA' } };
    const client = { async getRobot() { return { robotId: 'AAAAAAAAAAAAAAAAAAAAAA', lifecycle: 'ready', revision: 2, configuration: { backend: 'codex', settings: { codingAgents: ['codex'], model: 'old' } }, preparing: false, ready: true }; } };
    const provisioner = createRobotProvisioner({ client, robotStore: {}, sleep: async () => {} });
    await assert.rejects(provisioner.ensureReady(robot, { bindingId: FLOW }),
        (error) => error.code === 'worker_robot_stale' && error.message === 'worker_robot_stale: Robot "Helper"\'s configuration changed; open the robot or start the flow again to update it.');
    await assert.rejects(provisioner.ensureReady({ ...robot, worker: undefined }, { bindingId: FLOW }), (error) => error.code === 'worker_robot_not_provisioned' && /Robot "Helper" is not set up on the worker/.test(error.message));
});

// ---- the real service: robots are prepared before the first dispatch, and only the ones the flow can use ----
test('RoboFlow names the robots its phases may use, and the start prepares them before the first phase is dispatched', async (t) => {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'roboflow-start-')));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const started = [];
    const robots = [{ id: 'one-111111', name: 'one', codingAgents: ['codex'] }, { id: 'two-222222', name: 'two', codingAgents: ['claude'] }];
    const runtimeManager = { resolveCwd: async (value) => value, guiBusy: () => false, stopTask() {},
        startTask(robot, type, request) { started.push({ robot, request }); return { taskId: request.runtimeTaskId, state: 'queued' }; } };
    const service = new RoboFlowService({ robotStore: { list: async () => robots, getByName: async (name) => robots.find((robot) => robot.name === name), get: async (id) => robots.find((robot) => robot.id === id) },
        runtimeManager, databaseFile: path.join(root, 'roboflow.sqlite'), workflowsDirectory: path.join(root, 'old'), random: () => 0.99,
        discoverSkillsets: async () => ({ skillsets: [], diagnostics: [] }),
        skillsets: { repositoriesClient: { listRepositories: async () => [{ name: 'DocumentationSkills', source: root, origin: 'local' }] }, start: async (robot, input, enqueue) => enqueue(robot) } });
    await service.initialize();
    await service.presetReady;
    t.after(() => service.close());
    await service.createWorkflow(linear);
    const prepared = [];
    const flow = await service.startFlow({ workflowTypeId: 'linear', folder: root, objective: 'Work' }, { beforeDispatch: async (created) => {
        assert.equal(started.length, 0, 'nothing is dispatched yet');
        for (const robot of await service.flowRobots(created)) prepared.push(robot.name);
    } });
    assert.deepEqual(prepared.sort(), ['one', 'two']);
    assert.equal(started.length, 1);
    // The default workflow runs on the default robot alone.
    const defaultFlow = { graph: { kind: 'default', tasks: [task('a')] }, executionType: 'terminal' };
    assert.deepEqual((await service.flowRobots(defaultFlow)).map((robot) => robot.name), []);
    assert.equal(flow.status, 'running');
});

test('every reconciliation decision is logged with the flow and phase', async (t) => {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'roboflow-log-')));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const robots = [{ id: 'default-id', name: 'default', codingAgents: ['codex'] }];
    const make = (started, extra = {}) => new RoboFlowService({ robotStore: { list: async () => robots, getByName: async (name) => robots.find((robot) => robot.name === name), get: async (id) => robots.find((robot) => robot.id === id) },
        runtimeManager: { resolveCwd: async (value) => value, guiBusy: () => false, stopTask() {}, startTask(robot, type, request) { started.push(request.runtimeTaskId); return { taskId: request.runtimeTaskId, state: 'queued' }; } },
        databaseFile: path.join(root, 'roboflow.sqlite'), workflowsDirectory: path.join(root, 'old'), random: () => 0.99,
        discoverSkillsets: async () => ({ skillsets: [], diagnostics: [] }),
        skillsets: { repositoriesClient: { listRepositories: async () => [{ name: 'DocumentationSkills', source: root, origin: 'local' }] }, start: async (robot, input, enqueue) => enqueue(robot) }, ...extra });
    const first = make([]);
    await first.initialize(); await first.presetReady;
    await first.createWorkflow(linear);
    const flow = await first.startFlow({ workflowTypeId: 'linear', folder: root, objective: 'Work' });
    first.onRuntimeTaskEvent({ kind: 'state', taskId: (await first.store.get(flow.id)).instances[0].runtimeTaskId, state: 'running' });
    while (first.chains.size) await Promise.allSettled(first.chains.values());
    const phase = (await first.store.get(flow.id)).instances[0];
    await first.close();
    const lines = [];
    let reads = 0;
    const worker = { async lookup() { return { referenceId: 'r'.repeat(22), state: 'running', originRequestId: 'x' }; },
        async read() { reads += 1; return reads < 3 ? { state: 'running' } : { state: 'completed', result: { outputText: 'Done' } }; }, async control() { return {}; } };
    const second = make([], { workerMode: true, workerClient: worker, workerReconcileMs: 1, workerSleep: () => new Promise((resolve) => setTimeout(resolve, 1)), log: (line) => lines.push(line) });
    await second.initialize();
    t.after(() => second.close());
    await second.reconciliation;
    while (second.chains.size) await Promise.allSettled(second.chains.values());
    assert.deepEqual(lines, [`[roboflow] reconcile flow=${flow.id} phase=${phase.id} decision=running`, `[roboflow] reconcile flow=${flow.id} phase=${phase.id} decision=finished:completed`],
        'a running phase is logged once when first seen, then the decision that ended it');
});
