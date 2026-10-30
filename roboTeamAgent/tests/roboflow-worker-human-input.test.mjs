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

// ---- RoboTeam restarted while the model asked ----
// The first service starts the flow and goes down with its phase running; the question is recorded at the worker meanwhile.
async function restarted(t, { events, state = 'human-input', data = { reason: 'human_input', requestId: REQUEST } }) {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'roboflow-restart-')));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const robots = [{ id: 'default-id', name: 'default', codingAgents: ['codex'] }];
    const resumed = [];
    const make = (started, extra = {}) => new RoboFlowService({ robotStore: { list: async () => robots, getByName: async (name) => robots.find((robot) => robot.name === name), get: async (id) => robots.find((robot) => robot.id === id) },
        runtimeManager: { resolveCwd: async (value) => value, guiBusy: () => false, stopTask() {},
            startTask(robot, type, request) { started.push(request.runtimeTaskId); return { taskId: request.runtimeTaskId, state: 'queued' }; },
            resumeTask(robot, taskId, prompt, options = {}) { resumed.push({ taskId, prompt, runtimeTaskId: options.runtimeTaskId }); return { taskId: options.runtimeTaskId, state: 'queued' }; } },
        databaseFile: path.join(root, 'roboflow.sqlite'), workflowsDirectory: path.join(root, 'old'), random: () => 0.99,
        discoverSkillsets: async () => ({ skillsets: [], diagnostics: [] }),
        skillsets: { repositoriesClient: { listRepositories: async () => [{ name: 'DocumentationSkills', source: root, origin: 'local' }] }, start: async (robot, input, enqueue) => enqueue(robot) }, ...extra });
    const first = make([]);
    await first.initialize(); await first.presetReady;
    await first.createWorkflow(flowGraph);
    const flow = await first.startFlow({ workflowTypeId: 'asking', folder: root, objective: 'Work' });
    const phase = (await first.store.get(flow.id)).instances[0];
    first.onRuntimeTaskEvent({ kind: 'state', taskId: phase.runtimeTaskId, state: 'running' });
    while (first.chains.size) await Promise.allSettled(first.chains.values());
    await first.close();
    const calls = { control: [], events: [] };
    const lines = [];
    const worker = {
        async lookup() { return { referenceId: REFERENCE, state: 'human-input', originRequestId: 'x' }; },
        async read() { return { state, result: { status: state, outputText: 'Waiting for the answer.', data } }; },
        async events(referenceId, window, auth) { calls.events.push({ referenceId, window, auth }); return typeof events === 'function' ? events(window) : events; },
        async control(referenceId, body, auth) { calls.control.push({ referenceId, body, auth }); return {}; },
    };
    const second = make([], { workerMode: true, workerClient: worker, workerReconcileMs: 1, workerSleep: () => new Promise((resolve) => setTimeout(resolve, 1)), log: (line) => lines.push(line) });
    await second.initialize();
    t.after(() => second.close());
    await second.reconciliation;
    while (second.chains.size) await Promise.allSettled(second.chains.values());
    return { service: second, flow, phase, resumed, calls, lines };
}
const questionRow = { sequence: 4, at: 'x', type: 'human-input-request', data: { requestId: REQUEST, question: 'Which customer?', options: ['Retail', 'Business', 'Enterprise'] } };
const pageOf = (...rows) => ({ events: rows, nextAfter: rows.at(-1).sequence });

test('a question asked while RoboTeam was down is recovered from the worker\'s events, pending and answerable once', async (t) => {
    const f = await restarted(t, { events: pageOf({ sequence: 1, type: 'state', data: { state: 'running' } }, questionRow, { sequence: 5, type: 'state', data: { state: 'human-input' } }) });
    const flow = await f.service.getFlow(f.flow.id);
    // Recreated exactly as the live path records it.
    assert.equal(flow.status, 'paused');
    assert.equal(flow.humanInput.status, 'pending');
    assert.equal(flow.humanInput.executionEnded, true, 'the phase had ended at the worker, so the question can be answered');
    assert.equal(flow.humanInput.question, 'Which customer?');
    assert.deepEqual(flow.humanInput.options, ['Retail', 'Business', 'Enterprise']);
    assert.deepEqual(flow.humanInput.worker, { referenceId: REFERENCE, requestId: REQUEST });
    assert.equal(flow.humanInput.runtimeTaskId, f.phase.runtimeTaskId);
    assert.equal(flow.instances[0].state, 'paused');
    // Read with the coordinator identity and the flow binding, with no user grant.
    assert.deepEqual(f.calls.events[0].auth, { bindingId: f.flow.id });
    assert.ok(f.lines.includes(`[roboflow] reconcile flow=${f.flow.id} phase=${f.phase.id} decision=finished:human-input`));
    assert.equal(f.resumed.length, 0, 'recovering the question dispatches nothing');
    // The user answers: the worker gets the answer once with that request's grant, and the phase continues once.
    const grant = 'h.e30.RECOVERED';
    await f.service.answerHumanInput(f.flow.id, { requestId: flow.humanInput.id, option: 1 }, 'user-1', { grant });
    assert.equal(f.calls.control.length, 1);
    assert.equal(f.calls.control[0].referenceId, REFERENCE);
    assert.deepEqual(f.calls.control[0].auth, { grant });
    assert.deepEqual(f.calls.control[0].body.payload, { requestId: REQUEST, answer: 'Business' });
    assert.equal(f.resumed.length, 1);
    await assert.rejects(f.service.answerHumanInput(f.flow.id, { requestId: flow.humanInput.id, option: 1 }, 'user-1', { grant }), /no longer waiting/);
    assert.equal(f.calls.control.length, 1);
    assert.equal(f.resumed.length, 1);
});

test('the question is found across event pages, and the one for the attempt\'s request is taken', async (t) => {
    const other = { sequence: 2, type: 'human-input-request', data: { requestId: 'z'.repeat(20), question: 'Another?', options: ['x', 'y', 'w'] } };
    const f = await restarted(t, { events: (window) => (window.after === 0 ? { events: [other], nextAfter: 2 } : window.after === 2 ? { events: [questionRow], nextAfter: 4 } : { events: [], nextAfter: window.after }) });
    const flow = await f.service.getFlow(f.flow.id);
    assert.equal(flow.humanInput.question, 'Which customer?');
    assert.equal(f.calls.events.length >= 2, true);
});

test('events that cannot be read now leave the phase untouched and are asked again; events without the question pause the phase with a reason', async (t) => {
    let attempts = 0;
    const f = await restarted(t, { events: () => { attempts += 1; if (attempts === 1) throw new WorkerError('worker_unreachable', 503); return pageOf(questionRow); } });
    assert.ok(attempts >= 2, 'asked again after the first failure');
    assert.equal((await f.service.getFlow(f.flow.id)).humanInput.status, 'pending');

    const lost = await restarted(t, { events: { events: [], nextAfter: 0 } });
    const flow = await lost.service.getFlow(lost.flow.id);
    assert.equal(flow.humanInput ?? null, null, 'nothing to invent when the worker no longer holds it');
    assert.equal(flow.instances[0].state, 'paused');
    assert.match(flow.instances[0].error, /could not be recovered from the worker/);
    assert.ok(lost.lines.some((line) => line.includes('decision=finished:human-input (question not recovered)')));
});
