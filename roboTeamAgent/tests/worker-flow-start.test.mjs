import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { RoboFlowService } from '../server/roboflow/roboflow-service.mjs';
import { ensureFlowRobots, flowStartNotice, prepareFlowStart } from '../server/worker-coordinator/grant-actions.mjs';
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
    assert.deepEqual(outcome, { registered: true, robots: ['a-1', 'b-2'], notice: null });
    // A child flow derives its binding from its parent and needs nothing here.
    order.length = 0;
    assert.deepEqual(await prepareFlowStart({ hop, provisioner, roboflow: { flowRobots: async () => robots }, flow: { id: FLOW, parentFlowId: `flow_${'cd'.repeat(12)}` }, grant: GRANT }), { registered: false, robots: [], notice: null });
    assert.deepEqual(order, []);
});

test('every robot that cannot be prepared is named, with its code and a short reason; the others are still prepared; no grant prepares nothing', async () => {
    const tried = [];
    const failing = { Beta: 'worker_robot_not_ready', Delta: 'worker_robot_failed', Echo: 'some_unlisted_code' };
    const provisioner = { ensureReady: async (robot) => { tried.push(robot.name); if (failing[robot.name]) throw new WorkerError(failing[robot.name], 503); } };
    const robots = ['Alpha', 'Beta', 'Gamma', 'Delta', 'Echo'].map((name, index) => ({ id: `r-${index}`, name }));
    await assert.rejects(ensureFlowRobots({ provisioner, robots, grant: GRANT }), (error) => {
        assert.equal(error.statusCode, 503);
        assert.match(error.message, /^These 3 robots could not be prepared on the worker: /);
        assert.match(error.message, /"Beta" \(worker_robot_not_ready: it did not become ready in time\)/);
        assert.match(error.message, /"Delta" \(worker_robot_failed: its preparation failed on the worker\)/);
        assert.match(error.message, /"Echo" \(some_unlisted_code\)/, 'a code without a known reason is still named');
        assert.equal(error.message.includes('Alpha') || error.message.includes('Gamma'), false, 'ready robots are not blamed');
        assert.match(error.message, /fix them or deselect them/);
        assert.deepEqual(error.failures, [{ robot: 'Beta', code: 'worker_robot_not_ready' }, { robot: 'Delta', code: 'worker_robot_failed' }, { robot: 'Echo', code: 'some_unlisted_code' }]);
        return true;
    });
    assert.deepEqual(tried, ['Alpha', 'Beta', 'Gamma', 'Delta', 'Echo'], 'every robot was tried, not just up to the first failure');
    // One failure reads in the singular.
    await assert.rejects(ensureFlowRobots({ provisioner: { ensureReady: async () => { throw new WorkerError('worker_robot_stale', 409); } }, robots: [robots[0]], grant: GRANT }),
        (error) => /^This robot could not be prepared on the worker: "Alpha" \(worker_robot_stale: its configuration differs and could not be updated\)\. Open the robot, fix it or deselect it/.test(error.message));
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
        (error) => error.code === 'worker_robot_stale' && error.message === 'worker_robot_stale: Ask an administrator to open robot "Helper" to update it.');
    await assert.rejects(provisioner.ensureReady({ ...robot, worker: undefined }, { bindingId: FLOW }),
        (error) => error.code === 'worker_robot_not_provisioned' && error.message === 'worker_robot_not_provisioned: Ask an administrator to open robot "Helper" to set it up.');
    // A caller with a grant who is not an administrator is refused by the worker; the message is the same, not a bare `forbidden`.
    const refusing = { ...client, async configure() { throw new WorkerError('forbidden', 403); }, async provision() { throw new WorkerError('forbidden', 403); } };
    const asUser = createRobotProvisioner({ client: refusing, robotStore: {}, sleep: async () => {} });
    await assert.rejects(asUser.ensureReady(robot, { grant: GRANT }), (error) => error.message === 'worker_robot_stale: Ask an administrator to open robot "Helper" to update it.');
    await assert.rejects(asUser.ensureReady({ ...robot, worker: undefined }, { grant: GRANT }), (error) => error.code === 'worker_robot_not_provisioned' && /Ask an administrator to open robot "Helper"/.test(error.message));
});

// ---- decision M-32: who starts the flow decides what is prepared ----
function inspecting(views) {
    const calls = [];
    const client = {
        async getRobot(robotId, auth) { calls.push(['getRobot', robotId, auth]); const view = views[robotId]; if (view instanceof Error) throw view; return view; },
        async configure(body) { calls.push(['configure', body]); return {}; },
        async provision(body) { calls.push(['provision', body]); return {}; },
    };
    return { provisioner: createRobotProvisioner({ client, robotStore: { withRobot: async () => { calls.push(['record']); } }, sleep: async () => {} }), calls };
}
const viewFor = (robot, overrides = {}) => ({ robotId: robot.worker.robotId, lifecycle: 'ready', revision: 2, configuration: desiredConfiguration(robot), preparing: false, ready: true, ...overrides });

test('a start by someone who is not an administrator attempts no preparation, succeeds, and returns an informational notice', async () => {
    const current = { id: 'ok-1', name: 'Fine', codingAgents: ['codex'], worker: { robotId: 'AAAAAAAAAAAAAAAAAAAAAA' } };
    const stale = { id: 'st-2', name: 'Stale', codingAgents: ['opencode'], worker: { robotId: 'BBBBBBBBBBBBBBBBBBBBBA' } };
    const fresh = { id: 'nw-3', name: 'Brand new', codingAgents: ['codex'] };
    const failed = { id: 'fl-4', name: 'Broken', codingAgents: ['codex'], worker: { robotId: 'CCCCCCCCCCCCCCCCCCCCCA' } };
    const gone = { id: 'gn-5', name: 'Gone', codingAgents: ['codex'], worker: { robotId: 'DDDDDDDDDDDDDDDDDDDDDA' } };
    const down = { id: 'dn-6', name: 'Unasked', codingAgents: ['codex'], worker: { robotId: 'EEEEEEEEEEEEEEEEEEEEEA' } };
    const f = inspecting({
        [current.worker.robotId]: viewFor(current),
        [stale.worker.robotId]: viewFor(stale, { configuration: { backend: 'opencode', settings: { codingAgents: ['opencode'] } } }),
        [failed.worker.robotId]: viewFor(failed, { lifecycle: 'failed', ready: false }),
        [gone.worker.robotId]: new WorkerError('not_found', 404),
        [down.worker.robotId]: new WorkerError('worker_unreachable', 503),
    });
    const hop = { call: async () => response(200, { bindingId: FLOW }) };
    const outcome = await prepareFlowStart({ hop, provisioner: f.provisioner, roboflow: { flowRobots: async () => [current, stale, fresh, failed, gone, down] }, flow: { id: FLOW }, grant: GRANT, admin: false });
    // Nothing that needs an administrator was attempted.
    assert.equal(f.calls.some(([call]) => call === 'configure' || call === 'provision' || call === 'record'), false);
    assert.equal(outcome.registered, true, 'the start itself went ahead');
    assert.deepEqual(outcome.notice.robots.map(({ robot, code }) => [robot, code]), [
        ['Stale', 'worker_robot_stale'], ['Brand new', 'worker_robot_not_provisioned'], ['Broken', 'worker_robot_failed'],
        ['Gone', 'worker_robot_missing'], ['Unasked', 'worker_coordinator_unavailable']]);
    assert.match(outcome.notice.message, /^The workflow was started, but these robots need an administrator before its phases can run: /);
    assert.match(outcome.notice.message, /"Stale" \(worker_robot_stale: its configuration changed and needs an update\)/);
    assert.match(outcome.notice.message, /Ask an administrator to open each to update it/);
    assert.equal(outcome.notice.message.includes('Fine'), false, 'a ready robot is not listed');
    // All ready: no notice at all.
    const ready = await prepareFlowStart({ hop, provisioner: inspecting({ [current.worker.robotId]: viewFor(current) }).provisioner, roboflow: { flowRobots: async () => [current] }, flow: { id: FLOW }, grant: GRANT, admin: false });
    assert.equal(ready.notice, null);
    // A robot still being prepared is not a problem: its phase waits for it.
    const preparing = await prepareFlowStart({ hop, provisioner: inspecting({ [stale.worker.robotId]: viewFor(stale, { preparing: true, ready: false, configuration: null }) }).provisioner, roboflow: { flowRobots: async () => [stale] }, flow: { id: FLOW }, grant: GRANT, admin: false });
    assert.equal(preparing.notice, null);
    assert.equal(flowStartNotice([{ robot: 'Solo', code: 'worker_robot_stale', reason: 'r' }]).message.startsWith('The workflow was started, but this robot needs an administrator'), true);
});

test('the administrator\'s start is unchanged: every usable robot is prepared and a failure is refused naming each', async () => {
    const stale = { id: 'st-2', name: 'Stale', codingAgents: ['opencode'], worker: { robotId: 'BBBBBBBBBBBBBBBBBBBBBA' } };
    let configured = false;
    const client = {
        async getRobot() { return configured ? viewFor(stale) : viewFor(stale, { configuration: { backend: 'opencode', settings: { codingAgents: ['opencode'] } } }); },
        async configure(body, auth) { configured = true; client.last = { body, auth }; return {}; },
    };
    const hop = { call: async () => response(200, { bindingId: FLOW }) };
    const outcome = await prepareFlowStart({ hop, provisioner: createRobotProvisioner({ client, robotStore: {}, sleep: async () => {} }), roboflow: { flowRobots: async () => [stale] }, flow: { id: FLOW }, grant: GRANT, admin: true });
    assert.deepEqual(outcome, { registered: true, robots: ['st-2'], notice: null });
    assert.deepEqual(client.last.auth, { grant: GRANT });
    const omitted = await prepareFlowStart({ hop, provisioner: createRobotProvisioner({ client, robotStore: {}, sleep: async () => {} }), roboflow: { flowRobots: async () => [stale] }, flow: { id: FLOW }, grant: GRANT });
    assert.equal(omitted.notice, null, 'admin is the default');
});

test('a phase that reaches an unprepared robot fails the flow with the administrator message, the normal way', async (t) => {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'roboflow-unprepared-')));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const started = [];
    const robots = [{ id: 'one-111111', name: 'one', codingAgents: ['codex'] }];
    const service = new RoboFlowService({ robotStore: { list: async () => robots, getByName: async (name) => robots.find((robot) => robot.name === name), get: async (id) => robots.find((robot) => robot.id === id) },
        runtimeManager: { resolveCwd: async (value) => value, guiBusy: () => false, stopTask() {}, startTask(robot, type, request) { started.push(request.runtimeTaskId); return { taskId: request.runtimeTaskId, state: 'queued' }; } },
        databaseFile: path.join(root, 'roboflow.sqlite'), workflowsDirectory: path.join(root, 'old'), random: () => 0.99,
        discoverSkillsets: async () => ({ skillsets: [], diagnostics: [] }),
        skillsets: { repositoriesClient: { listRepositories: async () => [{ name: 'DocumentationSkills', source: root, origin: 'local' }] }, start: async (robot, input, enqueue) => enqueue(robot) } });
    await service.initialize(); await service.presetReady;
    t.after(() => service.close());
    await service.createWorkflow(linear);
    const flow = await service.startFlow({ workflowTypeId: 'linear', folder: root, objective: 'Work' });
    const message = 'worker_robot_stale: Ask an administrator to open robot "one" to update it.';
    service.onRuntimeTaskEvent({ kind: 'terminal', taskId: started[0], state: 'failed', result: '', error: message });
    while (service.chains.size) await Promise.allSettled(service.chains.values());
    const after = await service.getFlow(flow.id);
    assert.equal(after.status, 'failed');
    assert.equal(after.instances[0].state, 'failed');
    assert.equal(after.instances[0].error, message);
    assert.equal(after.error, message);
    assert.equal(started.length, 1, 'no successor is dispatched');
});

test('the RoboFlow pages carry and show the start notice', async () => {
    const read = (name) => fs.readFile(new URL(`../public/${name}`, import.meta.url), 'utf8');
    assert.match(await read('app.js'), /workerNotice[\s\S]*sessionStorage\.setItem\(`roboteam-flow-notice:\$\{flow\.id\}`/);
    assert.match(await read('cron-jobs.js'), /started\?\.workerNotice\?\.message/);
    assert.match(await read('roboflow.html'), /id="flowNotice"[^>]*hidden/);
    assert.match(await read('roboflow.js'), /sessionStorage\.getItem\(key\)[\s\S]*if \(selected\) showStartNotice\(selected\)/);
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
