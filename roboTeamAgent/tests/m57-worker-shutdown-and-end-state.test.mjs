import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import { RuntimeManager } from '../server/runtime-manager.mjs';
import { findProjectRecord } from '../server/project-storage.mjs';

// Decision M-57: a RoboTeam shutdown detaches from worker-owned attempts without changing their state, and the end state of a
// task is the worker's terminal classification the child reports, not the child's exit code.
const toolCache = {
    root: '/cache',
    prepareShellTools: async () => ({ root: '/cache', path: '/cache/g', binPath: '/cache/g/bin', agents: {} }),
    prepareMode: async (mode) => ({ path: `/cache/${mode}`, versions: {} }),
    prepareCodex: async () => ({ path: '/cache/codex', binPath: '/cache/codex/bin', versions: {} }),
    prepareCodingAgents: async () => ({}),
};
const tick = (ms = 5) => new Promise((resolve) => setTimeout(resolve, ms));
const until = async (predicate) => { for (let i = 0; i < 400 && !predicate(); i++) await tick(); assert.ok(predicate(), 'condition not reached'); };
const CLASSIFICATION = (classification) => `@@ALA_EVENT@@${JSON.stringify({ type: 'worker-terminal', classification })}\n`;

async function setup(t) {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'roboteam-m57-')));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const dataDir = path.join(root, 'data');
    const workspace = path.join(root, 'workspace');
    const robot = { id: 'm57-a1b2c3', name: 'M57' };
    await Promise.all([fs.mkdir(path.join(dataDir, 'robots', robot.id, 'home'), { recursive: true }), fs.mkdir(workspace, { recursive: true })]);
    const children = [];
    const spawnImpl = () => {
        const child = new EventEmitter();
        child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.stdin = new PassThrough();
        child.signals = [];
        // SIGTERM is a detach: the child exits 130 and the worker keeps the execution.
        child.kill = (signal) => { child.signals.push(signal); setImmediate(() => child.emit('close', 130, signal)); return true; };
        children.push(child);
        return child;
    };
    const make = () => new RuntimeManager({ dataDir, workspaceRoot: root, spawnImpl, workerMode: true, toolCache, execFileImpl: async () => ({ stdout: '[]', stderr: '' }) });
    const manager = make();
    t.after(() => manager.stopAll());
    const start = () => manager.startTask(robot, 'simple', { cwd: workspace, task: 'Do work', ca: 'codex' });
    return { dataDir, root, robot, children, manager, make, start };
}

test('a shutdown during a running worker task detaches without changing its state; a new manager over the same data sees it running', async (t) => {
    const { dataDir, root, robot, children, manager, make, start } = await setup(t);
    const { taskId } = start();
    await until(() => children.length === 1 && manager.taskStatus(robot.id, taskId).state === 'running');
    const events = [];
    manager.setTaskObserver((event) => events.push(event));
    await manager.stopAll();
    await until(() => !manager.tasks.get(taskId).child);
    const status = manager.taskStatus(robot.id, taskId);
    assert.equal(status.state, 'running', 'still the worker-owned running attempt, not paused or failed');
    assert.equal(status.completedAt, undefined);
    assert.deepEqual(children[0].signals, ['SIGTERM'], 'detached by the signal');
    assert.equal(events.some((event) => event.kind === 'terminal'), false, 'no terminal report for an attempt the worker still owns');
    const file = findProjectRecord({ dataDir, workspaceRoot: root }, 'task', taskId);
    assert.equal(JSON.parse(await fs.readFile(file, 'utf8')).state, 'running', 'the stored record keeps the state for the reconciliation');
    const restarted = make();
    t.after(() => restarted.stopAll());
    assert.equal(findProjectRecord({ dataDir, workspaceRoot: root }, 'task', taskId), file);
});

test('a task that was never admitted at the worker is still paused at shutdown', async (t) => {
    const { robot, manager } = await setup(t);
    const taskId = '33333333-3333-4333-8333-333333333333';
    manager.tasks.set(taskId, { taskId, robotId: robot.id, type: 'simple', state: 'queued', request: { cwd: '/tmp' }, child: null, pendingMessages: [] });
    await manager.stopAll();
    assert.equal(manager.tasks.get(taskId).state, 'paused');
});

test('a stop that races a clean finish ends completed: the worker classification decides, not exit 0 after the stop', async (t) => {
    const { robot, children, manager, start } = await setup(t);
    const { taskId } = start();
    await until(() => children.length === 1 && manager.taskStatus(robot.id, taskId).state === 'running');
    manager.stopTask(robot, 'simple', taskId);
    await until(() => manager.taskStatus(robot.id, taskId).state === 'pausing');
    children[0].stdout.write('All done.');
    children[0].stderr.write(CLASSIFICATION('completed'));
    await tick();
    children[0].emit('close', 0, null);
    await until(() => manager.taskStatus(robot.id, taskId).state !== 'pausing');
    assert.equal(manager.taskStatus(robot.id, taskId).state, 'completed');
    assert.equal(manager.taskStatus(robot.id, taskId).result, 'All done.');
});

test('a stop the worker classified cancelled (exit 130) is still paused', async (t) => {
    const { robot, children, manager, start } = await setup(t);
    const { taskId } = start();
    await until(() => children.length === 1 && manager.taskStatus(robot.id, taskId).state === 'running');
    manager.stopTask(robot, 'simple', taskId);
    await until(() => manager.taskStatus(robot.id, taskId).state === 'pausing');
    children[0].stderr.write(CLASSIFICATION('cancelled'));
    await tick();
    children[0].emit('close', 130, null);
    await until(() => manager.taskStatus(robot.id, taskId).state !== 'pausing');
    assert.equal(manager.taskStatus(robot.id, taskId).state, 'paused');
});

// Reconciliation after the restart (plan section 9): the worker is asked before a stored task changes.
const REFERENCE = 'r'.repeat(22);
const FLOW = `flow_${'ab'.repeat(12)}`;
const REFERENCE_EVENT = `@@ALA_EVENT@@${JSON.stringify({ type: 'worker-reference', referenceId: REFERENCE })}\n`;

function fakeClient(answer) {
    const calls = [];
    return { calls, async lookup() { return null; }, async read(referenceId, auth) {
        calls.push({ referenceId, auth });
        const value = typeof answer === 'function' ? answer(calls.length) : answer;
        if (value instanceof Error) throw value;
        return value;
    } };
}

// A task running at the worker when RoboTeam shuts down; returns the stored task id and a restart with a fake worker.
async function shutDownRunning(t, { flow = true, reference = true } = {}) {
    const ctx = await setup(t);
    const { taskId } = ctx.manager.startTask(ctx.robot, 'simple', { cwd: path.join(ctx.root, 'workspace'), task: 'Do work', ca: 'codex',
        ...(flow ? { workflowRunId: FLOW, workflowInstanceId: 'inv_1' } : {}) });
    await until(() => ctx.children.length === 1 && ctx.manager.taskStatus(ctx.robot.id, taskId).state === 'running');
    if (reference) { ctx.children[0].stderr.write(REFERENCE_EVENT); await tick(20); }
    await ctx.manager.stopAll();
    await until(() => !ctx.manager.tasks.get(taskId).child);
    await tick(20);
    const restart = async (workerClient, options = {}) => {
        const manager = new RuntimeManager({ dataDir: ctx.dataDir, workspaceRoot: ctx.root, spawnImpl: () => { throw new Error('spawned'); }, workerMode: true,
            toolCache, execFileImpl: async () => ({ stdout: '[]', stderr: '' }), workerClient, workerReconcileMs: 10, ...options });
        t.after(() => manager.stopAll());
        await manager.initialize();
        return manager;
    };
    return { ...ctx, taskId, restart };
}

test('after a restart a worker that still runs the attempt keeps it running and a resume is refused', async (t) => {
    const { robot, taskId, restart } = await shutDownRunning(t);
    const client = fakeClient({ state: 'running' });
    const manager = await restart(client);
    assert.equal(client.calls[0].referenceId, REFERENCE);
    assert.deepEqual(client.calls[0].auth, { bindingId: FLOW }, 'the flow binding, no user grant');
    assert.equal(manager.taskStatus(robot.id, taskId).state, 'running');
    await assert.rejects(manager.resumeTask(robot, taskId, 'again'), /This task is still running on the worker\./);
    assert.equal(manager.tasks.size, 1, 'no second attempt was enqueued');
});

test('after a restart a terminal worker state decides the stored task: completed, cancelled -> paused, failed', async (t) => {
    for (const [state, expected, result] of [['completed', 'completed', { outputText: 'Done' }], ['cancelled', 'paused', {}], ['interrupted', 'paused', {}], ['failed', 'failed', { reason: 'inactive_timeout' }]]) {
        const { robot, taskId, restart, dataDir, root } = await shutDownRunning(t);
        const manager = await restart(fakeClient({ state, result }));
        const status = manager.taskStatus(robot.id, taskId);
        assert.equal(status.state, expected, state);
        if (state === 'completed') assert.equal(status.result, 'Done');
        const file = findProjectRecord({ dataDir, workspaceRoot: root }, 'task', taskId);
        assert.equal(JSON.parse(await fs.readFile(file, 'utf8')).state, expected, `${state} is stored`);
    }
});

test('an unreachable worker leaves the stored state and is asked again later', async (t) => {
    const { robot, taskId, restart } = await shutDownRunning(t);
    const client = fakeClient((count) => (count < 3 ? Object.assign(new Error('worker_unreachable'), { code: 'worker_unreachable' }) : { state: 'completed', result: { outputText: 'Late' } }));
    const manager = await restart(client);
    assert.equal(manager.taskStatus(robot.id, taskId).state, 'running', 'unchanged while unreachable');
    await assert.rejects(manager.resumeTask(robot, taskId, 'again'), /not confirmed yet|still running/);
    await until(() => manager.tasks.get(taskId).state === 'completed');
    assert.ok(client.calls.length >= 3);
});

test('a stored task is paused only after an authorized lookup confirms it was never admitted', async (t) => {
    const { robot, taskId, restart } = await shutDownRunning(t, { reference: false });
    const client = fakeClient({ state: 'running' });
    const manager = await restart(client);
    assert.equal(manager.taskStatus(robot.id, taskId).state, 'paused');
    assert.equal(client.calls.length, 0, 'nothing to ask the worker about');
});

test('a missing reference event does not lose an admission that the worker owns', async (t) => {
    const { robot, taskId, restart } = await shutDownRunning(t, { reference: false });
    const client = fakeClient({ state: 'running' });
    const lookups = [];
    client.lookup = async (origin, auth) => { lookups.push({ origin, auth }); return { referenceId: REFERENCE }; };
    const manager = await restart(client);
    assert.equal(lookups.length, 1);
    assert.deepEqual(lookups[0].auth, { bindingId: FLOW });
    assert.equal(manager.taskStatus(robot.id, taskId).state, 'running');
    await manager.stopAll();
    assert.equal(manager.taskStatus(robot.id, taskId).state, 'running', 'second shutdown also detaches adopted work');
});

test('without a grant, a missing reference stays unconfirmed and cannot be resumed', async (t) => {
    const { robot, taskId, restart } = await shutDownRunning(t, { reference: false, flow: false });
    const manager = await restart(fakeClient({ state: 'running' }));
    assert.equal(manager.taskStatus(robot.id, taskId).state, 'running');
    assert.equal(manager.taskStatus(robot.id, taskId).workerStatus, 'unconfirmed');
    await assert.rejects(manager.resumeTask(robot, taskId), (error) => error.code === 'task_state_unconfirmed');
});

test('a failed worker result racing Stop remains failed even when the child exits 130', async (t) => {
    const { robot, children, manager, start } = await setup(t);
    const { taskId } = start();
    await until(() => children.length === 1 && manager.taskStatus(robot.id, taskId).state === 'running');
    manager.stopTask(robot, 'simple', taskId);
    await until(() => manager.taskStatus(robot.id, taskId).state === 'pausing');
    children[0].stderr.write(CLASSIFICATION('failed'));
    children[0].emit('close', 130, null);
    await until(() => !manager.tasks.get(taskId).child);
    assert.equal(manager.taskStatus(robot.id, taskId).state, 'failed');
});

test('local response overflow remains failed even when the worker completed, with or without a concurrent Stop', async (t) => {
    for (const stop of [false, true]) {
        const { robot, children, manager, start } = await setup(t);
        const { taskId } = start();
        await until(() => children.length === 1 && manager.taskStatus(robot.id, taskId).state === 'running');
        if (stop) {
            manager.stopTask(robot, 'simple', taskId);
            await until(() => manager.taskStatus(robot.id, taskId).state === 'pausing');
        }
        children[0].stderr.write(CLASSIFICATION('completed'));
        children[0].stdout.write('x'.repeat(1024 * 1024 + 1));
        children[0].emit('close', 0, null);
        await until(() => !manager.tasks.get(taskId).child);
        assert.equal(manager.taskStatus(robot.id, taskId).state, 'failed');
        assert.match(manager.taskStatus(robot.id, taskId).error, /exceeds the 1 MiB limit/);
    }
});

test('a plain task has no evidence at a restart: it stays running, unconfirmed, and its resume reads the worker with the request grant', async (t) => {
    const { robot, taskId, restart } = await shutDownRunning(t, { flow: false });
    const client = fakeClient({ state: 'completed', result: { outputText: 'Ok' } });
    const manager = await restart(client);
    assert.equal(client.calls.length, 0, 'no grant, so no read');
    assert.equal(manager.taskStatus(robot.id, taskId).state, 'running');
    await assert.rejects(manager.resumeTask(robot, taskId, 'again'), /not confirmed yet/);
    manager.workerMode = true;
    // A request with a grant settles it; the task is terminal and the refusal no longer applies.
    const grant = `h.${Buffer.from('{}').toString('base64url')}.SIG`;
    await manager._reconcileTask(manager.tasks.get(taskId), { grant });
    assert.deepEqual(client.calls[0].auth, { grant });
    assert.equal(manager.taskStatus(robot.id, taskId).state, 'completed');
    let resumedRequest;
    manager._enqueueTask = (robot, type, request) => { resumedRequest = request; return { taskId: 'new-attempt' }; };
    manager._drainTaskQueue = async () => {};
    await manager.resumeTask(robot, taskId, 'continue', { ownerGrant: grant });
    assert.equal(resumedRequest.ownerGrant, grant, 'the same resume request authorizes the new plain-task admission');
});

test('a locally failed attempt cannot be resumed while its worker reference is still running', async (t) => {
    const { robot, taskId, restart } = await shutDownRunning(t);
    const manager = await restart(fakeClient({ state: 'running' }));
    const task = manager.tasks.get(taskId);
    task.state = 'failed';
    task.error = 'stop_not_confirmed';
    await assert.rejects(manager.resumeTask(robot, taskId), (error) => error.code === 'task_running_on_worker');
    assert.equal(manager.tasks.size, 1);
});
