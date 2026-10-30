import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { RoboFlowService } from '../server/roboflow/roboflow-service.mjs';
import { WorkerError } from '../server/worker-coordinator/worker-client.mjs';

// A human-input question the worker holds (decision M-14, base section 9): RoboFlow pauses the phase as for the local channel,
// the user's answer goes to the worker once with the answering request's own grant, and only then is the continuation dispatched.
const task = (id, extras = {}) => ({ id, name: id, prompt: `Execute ${id}`, executionType: 'terminal', skillsets: [], ...extras });
const flowGraph = { id: 'asking', name: 'Asking', description: 'asks then goes on', entryTaskId: 'a',
    tasks: [task('a', { allowsHumanInput: true }), task('b')], edges: [{ id: 'a-b', sourceTaskId: 'a', targetTaskId: 'b' }] };
const REFERENCE = 'r'.repeat(22);
const REQUEST = 'q'.repeat(20);
const INPUT = { question: 'Which customer?', options: ['Retail', 'Business', 'Enterprise'], worker: { referenceId: REFERENCE, requestId: REQUEST } };

async function fixture(t, { control } = {}) {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'roboflow-human-')));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const started = [];
    const resumed = [];
    const calls = [];
    const robots = [{ id: 'default-id', name: 'default', codingAgents: ['codex'] }];
    const runtimeManager = { resolveCwd: async (value) => value, guiBusy: () => false, stopTask() {},
        startTask(robot, type, request) { started.push({ robot, type, request, taskId: request.runtimeTaskId }); return { taskId: request.runtimeTaskId, state: 'queued' }; },
        resumeTask(robot, taskId, prompt, options = {}) { resumed.push({ taskId, prompt, runtimeTaskId: options.runtimeTaskId }); return { taskId: options.runtimeTaskId, state: 'queued' }; } };
    const workerClient = {
        async control(referenceId, body, auth) { calls.push({ referenceId, body, auth }); if (control) return control(calls.length); return {}; },
        async lookup() { return null; },
    };
    const service = new RoboFlowService({ robotStore: { list: async () => robots, getByName: async (name) => robots.find((robot) => robot.name === name), get: async (id) => robots.find((robot) => robot.id === id) },
        runtimeManager, databaseFile: path.join(root, 'roboflow.sqlite'), workflowsDirectory: path.join(root, 'old'), random: () => 0.99,
        discoverSkillsets: async () => ({ skillsets: [], diagnostics: [] }),
        skillsets: { repositoriesClient: { listRepositories: async () => [{ name: 'DocumentationSkills', source: root, origin: 'local' }] }, start: async (robot, input, enqueue) => enqueue(robot) },
        workerMode, workerClient: workerMode ? workerClient : undefined, workerSleep: () => new Promise((resolve) => setTimeout(resolve, 1)) });
    await service.initialize();
    await service.presetReady;
    t.after(() => service.close());
    await service.createWorkflow(flowGraph);
    const flow = await service.startFlow({ workflowTypeId: 'asking', folder: root, objective: 'Work' });
    const settle = async () => { while (service.chains.size) await Promise.allSettled(service.chains.values()); };
    return { service, flow, started, resumed, calls, settle };
}
const workerMode = true;

// The question reaches RoboFlow from the child's event; the phase's child then ends normally and the task terminal event follows.
async function asked(f) {
    const question = await f.service.requestHumanInput(f.started[0].taskId, INPUT);
    f.service.onRuntimeTaskEvent({ kind: 'terminal', taskId: f.started[0].taskId, state: 'completed', result: 'Waiting for the answer.' });
    await f.settle();
    return question;
}

test('the worker question pauses the phase as the local channel does and keeps the worker reference and request', async (t) => {
    const f = await fixture(t);
    const question = await asked(f);
    const flow = await f.service.getFlow(f.flow.id);
    assert.equal(flow.status, 'paused');
    assert.equal(flow.humanInput.status, 'pending');
    assert.equal(flow.humanInput.executionEnded, true);
    assert.deepEqual(flow.humanInput.worker, { referenceId: REFERENCE, requestId: REQUEST });
    assert.equal(flow.humanInput.id, question.id);
});

test('a worker question with a malformed reference or request is refused', async (t) => {
    const f = await fixture(t);
    for (const worker of [{ referenceId: 'short', requestId: REQUEST }, { referenceId: REFERENCE, requestId: 'x' }, { referenceId: REFERENCE }]) {
        await assert.rejects(f.service.requestHumanInput(f.started[0].taskId, { ...INPUT, worker }), /not valid/);
    }
    assert.equal((await f.service.getFlow(f.flow.id)).humanInput, undefined);
});

test('the answer goes to the worker once with the answering request\'s own grant, then the continuation is dispatched once', async (t) => {
    const f = await fixture(t);
    const question = await asked(f);
    const grant = 'h.e30.ANSWERGRANT';
    const resumedFlow = await f.service.answerHumanInput(f.flow.id, { requestId: question.id, option: 3, text: 'Partners' }, 'user-1', { grant });
    assert.equal(f.calls.length, 1);
    assert.equal(f.calls[0].referenceId, REFERENCE);
    assert.deepEqual(f.calls[0].auth, { grant });
    assert.equal(f.calls[0].body.op, 'answer');
    assert.deepEqual(f.calls[0].body.payload, { requestId: REQUEST, answer: 'Partners' });
    assert.match(f.calls[0].body.operationId, /^[A-Za-z0-9_-]{22}$/);
    assert.equal(f.resumed.length, 1, 'the continuation is dispatched exactly once');
    assert.equal(f.resumed[0].prompt, 'My answer to your question is: Partners');
    assert.notEqual(f.resumed[0].runtimeTaskId, f.started[0].taskId, 'a new runtime task, so a new deterministic origin');
    assert.equal(resumedFlow.humanInput.status, 'answered');
    // Answering again changes nothing and sends nothing.
    await assert.rejects(f.service.answerHumanInput(f.flow.id, { requestId: question.id, option: 0 }, 'user-2', { grant }), /no longer waiting/);
    assert.equal(f.calls.length, 1);
    assert.equal(f.resumed.length, 1);
});

test('an answer with no grant, or one the worker does not accept, dispatches nothing and is never resent by RoboTeam', async (t) => {
    const f = await fixture(t, { control: (count) => { if (count === 1) throw new WorkerError('worker_reply_unknown', 503); return {}; } });
    const question = await asked(f);
    await assert.rejects(f.service.answerHumanInput(f.flow.id, { requestId: question.id, option: 0 }, 'user-1'), (error) => error.statusCode === 403 && error.message === 'owner_evidence_unavailable');
    assert.equal(f.calls.length, 0, 'nothing is sent without the answering request\'s grant');
    await assert.rejects(f.service.answerHumanInput(f.flow.id, { requestId: question.id, option: 0 }, 'user-1', { grant: 'h.e30.ONE' }), (error) => error.statusCode === 503 && error.message === 'worker_reply_unknown');
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(f.calls.length, 1, 'a lost reply is not retried automatically');
    assert.equal(f.resumed.length, 0, 'no continuation before the worker accepted the answer');
    assert.equal((await f.service.getFlow(f.flow.id)).humanInput.status, 'pending');
    // The user answers again with a fresh grant: the same answer is the same operation at the worker; now it is accepted and the phase continues once.
    await f.service.answerHumanInput(f.flow.id, { requestId: question.id, option: 0 }, 'user-1', { grant: 'h.e30.TWO' });
    assert.equal(f.calls.length, 2);
    assert.equal(f.calls[1].body.operationId, f.calls[0].body.operationId);
    assert.deepEqual(f.calls[1].auth, { grant: 'h.e30.TWO' });
    assert.equal(f.resumed.length, 1);
});

test('a question the local channel asked is answered locally, with no worker call', async (t) => {
    const f = await fixture(t);
    const local = await f.service.requestHumanInput(f.started[0].taskId, { question: 'Which customer?', options: ['Retail', 'Business', 'Enterprise'] });
    f.service.onRuntimeTaskEvent({ kind: 'terminal', taskId: f.started[0].taskId, state: 'completed', result: 'Waiting.' });
    await f.settle();
    await f.service.answerHumanInput(f.flow.id, { requestId: local.id, option: 1 }, 'user-1');
    assert.equal(f.calls.length, 0);
    assert.equal(f.resumed.length, 1);
    assert.equal((await f.service.getFlow(f.flow.id)).humanInput.worker, undefined);
});
