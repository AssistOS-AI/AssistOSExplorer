import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { RoboFlowService } from '../server/roboflow/roboflow-service.mjs';
import { stopOperationId } from '../server/worker-coordinator/worker-client.mjs';

// A user's pause, terminate and live message of a RoboFlow phase are worker controls (decisions M-12 (b), M-40): they carry the
// requesting user's own grant, never the flow binding. A system-initiated stop (flow failure) keeps the coordinator identity and
// the binding. A user stop that does not reach the worker is told to that user.
const REFERENCE = 'r'.repeat(22);
const task = (id) => ({ id, name: id, prompt: `Execute ${id}`, executionType: 'terminal', skillsets: [] });
const graph = { id: 'stopping', name: 'Stopping', description: 'one phase', entryTaskId: 'a', tasks: [task('a')], edges: [] };

async function fixture(t, { lookup = async () => ({ referenceId: REFERENCE }) } = {}) {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'roboflow-user-stop-')));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const stops = [];
    const messages = [];
    const calls = { lookup: [], control: [] };
    const robots = [{ id: 'default-id', name: 'default', codingAgents: ['codex'] }];
    const runtimeManager = { resolveCwd: async (value) => value, guiBusy: () => false,
        stopTask(robot, type, taskId, options) { stops.push({ taskId, options }); return { state: 'completed' }; },
        sendTaskMessage(robot, taskId, prompt, options) { messages.push({ taskId, prompt, options }); return { delivery: 'delivered' }; },
        startTask(robot, type, request) { return { taskId: request.runtimeTaskId, state: 'queued' }; } };
    const workerClient = {
        async lookup(origin, auth) { calls.lookup.push({ origin, auth }); return lookup(origin, auth); },
        async control(referenceId, body, auth) { calls.control.push({ referenceId, body, auth }); return {}; },
    };
    const service = new RoboFlowService({ robotStore: { list: async () => robots, getByName: async (name) => robots.find((robot) => robot.name === name), get: async (id) => robots.find((robot) => robot.id === id) },
        runtimeManager, databaseFile: path.join(root, 'roboflow.sqlite'), workflowsDirectory: path.join(root, 'old'), random: () => 0.99,
        discoverSkillsets: async () => ({ skillsets: [], diagnostics: [] }),
        skillsets: { repositoriesClient: { listRepositories: async () => [{ name: 'DocumentationSkills', source: root, origin: 'local' }] }, start: async (robot, input, enqueue) => enqueue(robot) },
        workerMode: true, workerClient, workerSleep: () => new Promise((resolve) => setTimeout(resolve, 1)) });
    await service.initialize();
    await service.presetReady;
    t.after(() => service.close());
    await service.createWorkflow(graph);
    const start = async () => {
        const flow = await service.startFlow({ workflowTypeId: 'stopping', folder: root, objective: 'Work' });
        const instance = (await service.getFlow(flow.id)).instances[0];
        return { flow, instance };
    };
    return { service, stops, messages, calls, start };
}
const authsOf = (calls) => [calls.lookup.map((call) => call.auth), calls.control.map((call) => call.auth)];

test('a user pause carries the request\'s own grant to the phase\'s task child and to the worker, never the binding', async (t) => {
    const f = await fixture(t);
    const { flow } = await f.start();
    const user = { grant: 'h.e30.PAUSEGRANT', undelivered: [] };
    await f.service.pauseFlow(flow.id, user);
    assert.equal(f.stops.length, 1);
    assert.deepEqual(f.stops[0].options, { userInitiated: true, ownerGrant: 'h.e30.PAUSEGRANT' });
    assert.deepEqual(authsOf(f.calls), [[{ grant: 'h.e30.PAUSEGRANT' }], [{ grant: 'h.e30.PAUSEGRANT' }]]);
    assert.equal(f.calls.control[0].body.op, 'stop');
    assert.equal(f.calls.control[0].body.operationId, stopOperationId(REFERENCE));
    assert.deepEqual(user.undelivered, []);
});

test('a user terminate (and its child flows) carry the grant too; a system failure keeps the binding and no user mark', async (t) => {
    const f = await fixture(t);
    const { flow } = await f.start();
    await f.service.terminateFlow(flow.id, { grant: 'h.e30.TERMGRANT', undelivered: [] });
    assert.deepEqual(f.stops.at(-1).options, { userInitiated: true, ownerGrant: 'h.e30.TERMGRANT' });
    assert.deepEqual(authsOf(f.calls), [[{ grant: 'h.e30.TERMGRANT' }], [{ grant: 'h.e30.TERMGRANT' }]]);

    const g = await fixture(t);
    const { flow: second } = await g.start();
    await g.service._fail(second.id, 'The flow failed', 'failed');
    assert.equal(g.stops[0].options, undefined, 'a system stop carries no user mark and no grant');
    assert.deepEqual(authsOf(g.calls), [[{ bindingId: second.id }], [{ bindingId: second.id }]]);
});

test('a user stop the worker did not receive is reported to that user and the local pause still happens', async (t) => {
    const f = await fixture(t, { lookup: async () => { throw Object.assign(new Error('forbidden'), { code: 'forbidden' }); } });
    const { flow } = await f.start();
    const user = { grant: 'h.e30.REFUSED', undelivered: [] };
    const paused = await f.service.pauseFlow(flow.id, user);
    assert.equal(paused.status, 'paused');
    assert.equal(user.undelivered.length, 1);
    assert.equal(user.undelivered[0].code, 'forbidden');
    assert.equal(f.calls.control.length, 0);
});

test('a live message of a running phase carries the messaging request\'s own grant', async (t) => {
    const f = await fixture(t);
    const { flow, instance } = await f.start();
    await f.service.messageInstance(flow.id, instance.id, 'also check the logs', { grant: 'h.e30.MSGGRANT' });
    assert.deepEqual(f.messages[0].options, { ownerGrant: 'h.e30.MSGGRANT' });
    await f.service.messageInstance(flow.id, instance.id, 'and again');
    assert.equal(f.messages[1].options, undefined);
});
