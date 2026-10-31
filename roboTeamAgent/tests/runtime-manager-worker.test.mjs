import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import { RuntimeManager, runtimeManagerInternals } from '../server/runtime-manager.mjs';
import { taskOriginId } from '../server/worker-coordinator/flow-origins.mjs';
import { isOriginId } from '../server/worker-coordinator/identities.mjs';
import { STOP_NOT_CONFIRMED_EXIT } from '../server/worker-coordinator/task-exit.mjs';

// A user stop of a robot-task child. Through the worker it is an explicit stdin record (a signal would
// only detach the child, which leaves the worker execution running); locally it is the signal.
function child() {
    const emitter = new EventEmitter();
    const written = [];
    const signals = [];
    emitter.stdin = { write: (value) => { written.push(value); return true; } };
    emitter.kill = (signal) => { signals.push(signal); return true; };
    return { child: emitter, written, signals };
}

test('with the worker a stop is the stdin record and the signal is only a delayed backstop', async () => {
    const c = child();
    RuntimeManager.prototype._stopChild.call({ workerMode: true }, c.child);
    assert.deepEqual(c.written.map((line) => JSON.parse(line)), [{ type: 'stop' }]);
    assert.deepEqual(c.signals, [], 'no immediate SIGTERM, which would only detach');
    c.child.emit('close');
});

test('a stop of no child is a no-op', () => {
    RuntimeManager.prototype._stopChild.call({}, null);
});

const toolCache = {
    root: '/cache',
    prepareShellTools: async (names = ['codex']) => ({ root: '/cache', path: '/cache/g', binPath: '/cache/g/bin', agents: Object.fromEntries(names.map((name) => [name, { path: `/cache/${name}`, binPath: `/cache/${name}/bin` }])) }),
    prepareMode: async (mode) => ({ path: `/cache/${mode}`, versions: {} }),
    prepareCodex: async () => ({ path: '/cache/codex', binPath: '/cache/codex/bin', versions: {} }),
    prepareCodingAgents: async (names = ['codex']) => Object.fromEntries(names.map((name) => [name, { path: `/cache/${name}`, binPath: `/cache/${name}/bin`, versions: {} }])),
};

// The owner grant of an `/api/control` task (decision M-21) reaches the child over stdin once, and nowhere else.
test('the request grant of a started task goes to its child over stdin only and is never persisted or reported', async (t) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'roboteam-grant-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const dataDir = path.join(root, 'data');
    const workspace = path.join(root, 'workspace');
    const robot = { id: 'granted-a1b2c3', name: 'Granted' };
    await Promise.all([fs.mkdir(path.join(dataDir, 'robots', robot.id, 'home'), { recursive: true }), fs.mkdir(workspace, { recursive: true })]);
    const spawned = [];
    const spawnImpl = (command, args, options) => {
        const child = new EventEmitter();
        child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.kill = () => true;
        child.stdin = new PassThrough();
        let text = '';
        child.stdin.on('data', (chunk) => { text += chunk; });
        spawned.push({ args, env: options.env, read: () => text });
        setImmediate(() => child.emit('close', 0, null));
        return child;
    };
    const grant = `h.${Buffer.from(JSON.stringify({ sub: 'user:alice' })).toString('base64url')}.SECRETSIGNATURE`;
    const manager = new RuntimeManager({ dataDir, workspaceRoot: root, spawnImpl, workerMode: true, toolCache, execFileImpl: async () => ({ stdout: '[]', stderr: '' }) });
    t.after(() => manager.stopAll());
    const accepted = manager.startTask(robot, 'simple', { cwd: workspace, task: 'Do work', ca: 'codex', ownerPrincipal: 'user:alice', ownerGrant: grant });
    assert.equal(JSON.stringify(manager.taskStatus(robot.id, accepted.taskId)).includes('SECRETSIGNATURE'), false, 'not in the task status');
    while (!['completed', 'failed'].includes(manager.taskStatus(robot.id, accepted.taskId).state)) await new Promise((resolve) => setTimeout(resolve, 5));
    const [child] = spawned;
    assert.equal(JSON.parse(child.read().split('\n')[0]).ownerGrant, grant, 'delivered over stdin');
    assert.equal(JSON.stringify(child.args).includes('SECRETSIGNATURE'), false, 'not in argv');
    assert.equal(JSON.stringify(child.env).includes('SECRETSIGNATURE'), false, 'not in the environment');
    const origin = child.args[child.args.indexOf('--worker-origin') + 1];
    assert.equal(origin, taskOriginId(accepted.taskId));
    assert.equal(isOriginId(origin), true);
    assert.equal(child.args.includes('--worker-binding'), false, 'a user task has no flow binding');
    // Nothing the task persisted (its project record), nor the manager's own state, holds the grant.
    const files = [];
    const walk = async (directory) => { for (const entry of await fs.readdir(directory, { withFileTypes: true })) { const full = path.join(directory, entry.name); if (entry.isDirectory()) await walk(full); else files.push(full); } };
    await walk(root);
    for (const file of files) assert.equal((await fs.readFile(file, 'utf8').catch(() => '')).includes('SECRETSIGNATURE'), false, file);
    assert.equal(manager.taskGrants.size, 0, 'dropped once the child has it');
    assert.equal(manager.tasks.get(accepted.taskId).request.ownerGrant, undefined);
});

test('without the coordinator base an AI task is refused at admission, naming the configuration, and nothing is spawned or kept', async (t) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'roboteam-nobase-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const dataDir = path.join(root, 'data');
    const workspace = path.join(root, 'workspace');
    const robot = { id: 'plain-a1b2c3', name: 'Plain' };
    await Promise.all([fs.mkdir(path.join(dataDir, 'robots', robot.id, 'home'), { recursive: true }), fs.mkdir(workspace, { recursive: true })]);
    const spawned = [];
    const manager = new RuntimeManager({ dataDir, workspaceRoot: root, spawnImpl: (...args) => { spawned.push(args); throw new Error('spawned'); }, workerMode: false, toolCache,
        execFileImpl: async () => ({ stdout: '[]', stderr: '' }) });
    t.after(() => manager.stopAll());
    const refusal = (error) => error.code === 'worker_not_configured' && error.statusCode === 409
        && /ROBOTEAM_WORKER_COORDINATOR_BASE is not set/.test(error.message) && /^worker_not_configured: /.test(error.message);
    for (const type of ['simple', 'browser', 'desktop']) {
        assert.throws(() => manager.startTask(robot, type, { cwd: workspace, task: 'Do work', ca: 'codex', ownerGrant: 'h.e30.SECRETSIGNATURE' }), refusal, type);
    }
    assert.deepEqual(spawned, []);
    assert.equal(manager.tasks.size, 0, 'no task record exists');
    assert.equal(manager.taskGrants.size, 0, 'no grant was kept');
});

test('without the coordinator base a resume is refused before it rewrites or saves the task record', async (t) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'roboteam-nobase-resume-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const robot = { id: 'plain-a1b2c3', name: 'Plain' };
    const manager = new RuntimeManager({ dataDir: path.join(root, 'data'), workspaceRoot: root, workerMode: false, toolCache,
        spawnImpl: () => { throw new Error('spawned'); }, execFileImpl: async () => ({ stdout: '[]', stderr: '' }) });
    t.after(() => manager.stopAll());
    const taskId = '11111111-1111-4111-8111-111111111111';
    const saved = [];
    manager._saveTask = async (task) => { saved.push(task.taskId); };
    manager.skillsets = { policies: { ensure: async () => {} } };
    const internal = { taskId, robotId: robot.id, type: 'simple', state: 'failed', alaSessionId: '22222222-2222-4222-8222-222222222222',
        request: { task: 'x', skillSelection: ['bash'] } };
    manager.tasks.set(taskId, internal);
    await assert.rejects(manager.resumeTask(robot, taskId, 'again'), (error) => error.code === 'worker_not_configured');
    assert.deepEqual(saved, [], 'nothing was saved');
    assert.deepEqual(internal.request, { task: 'x', skillSelection: ['bash'] }, 'the record was not rewritten');
});

test('a child that stopped on the missing configuration leaves that line as the task error, not an opaque ALA exit', () => {
    const line = 'worker_not_configured: AI execution is unavailable because ROBOTEAM_WORKER_COORDINATOR_BASE is not set. RoboTeam runs every AI task through the robo-work worker.';
    assert.equal(runtimeManagerInternals.alaFailureMessage(1, `noise\n${line}\n`), line);
});

// A running worker task that a user stops: the stop record carries the stopping request's own grant over stdin, the task is
// `pausing` until the child confirms, and an unconfirmed stop is a failure, never paused.
async function runningTask(t) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'roboteam-stop-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const dataDir = path.join(root, 'data');
    const workspace = path.join(root, 'workspace');
    const robot = { id: 'stopper-a1b2c3', name: 'Stopper' };
    await Promise.all([fs.mkdir(path.join(dataDir, 'robots', robot.id, 'home'), { recursive: true }), fs.mkdir(workspace, { recursive: true })]);
    const spawned = [];
    const spawnImpl = (command, args) => {
        const child = new EventEmitter();
        child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.kill = () => true; child.stdin = new PassThrough();
        let text = '';
        child.stdin.on('data', (chunk) => { text += chunk; });
        spawned.push({ child, args, lines: () => text.split('\n').filter(Boolean).map((line) => JSON.parse(line)) });
        return child;
    };
    const manager = new RuntimeManager({ dataDir, workspaceRoot: root, spawnImpl, workerMode: true, toolCache, execFileImpl: async () => ({ stdout: '[]', stderr: '' }) });
    t.after(() => manager.stopAll());
    const accepted = manager.startTask(robot, 'simple', { cwd: workspace, task: 'Do work', ca: 'codex', ownerPrincipal: 'user:alice' });
    while (!spawned.length || manager.taskStatus(robot.id, accepted.taskId).state !== 'running') await new Promise((resolve) => setTimeout(resolve, 5));
    return { manager, robot, accepted, child: spawned[0], root };
}
const settled = async (manager, robot, taskId) => { while (!['completed', 'failed', 'paused'].includes(manager.taskStatus(robot.id, taskId).state)) await new Promise((resolve) => setTimeout(resolve, 5)); return manager.taskStatus(robot.id, taskId); };

test('a user stop sends its own grant to the child over stdin; the task is pausing until the worker confirms', async (t) => {
    const f = await runningTask(t);
    const grant = 'h.e30.STOPSIGNATURE';
    f.manager.stopTask(f.robot, 'simple', f.accepted.taskId, { ownerGrant: grant });
    await new Promise((resolve) => setTimeout(resolve, 20));
    const stop = f.child.lines().find((record) => record.type === 'stop');
    assert.deepEqual(stop, { type: 'stop', ownerGrant: grant }, 'the stop record carries the stopping request\'s grant');
    const shown = f.manager.taskStatus(f.robot.id, f.accepted.taskId);
    assert.equal(shown.state, 'pausing', 'not paused as if stopped');
    assert.equal(JSON.stringify(shown).includes('STOPSIGNATURE'), false);
    assert.equal(JSON.stringify(f.child.args).includes('STOPSIGNATURE'), false);
    f.child.child.emit('close', 130, null);
    assert.equal((await settled(f.manager, f.robot, f.accepted.taskId)).state, 'paused', 'paused once the child confirmed');
    const files = [];
    const walk = async (directory) => { for (const entry of await fs.readdir(directory, { withFileTypes: true })) { const full = path.join(directory, entry.name); if (entry.isDirectory()) await walk(full); else files.push(full); } };
    await walk(f.root);
    for (const file of files) assert.equal((await fs.readFile(file, 'utf8').catch(() => '')).includes('STOPSIGNATURE'), false, file);
});

test('a user-initiated stop is marked so, with or without a grant; a system stop carries neither', async (t) => {
    const f = await runningTask(t);
    f.manager.stopTask(f.robot, 'simple', f.accepted.taskId, { ownerGrant: 'h.e30.USERSTOP', userInitiated: true });
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.deepEqual(f.child.lines().find((record) => record.type === 'stop'), { type: 'stop', user: true, ownerGrant: 'h.e30.USERSTOP' });
    const g = await runningTask(t);
    g.manager.stopTask(g.robot, 'simple', g.accepted.taskId, { userInitiated: true });
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.deepEqual(g.child.lines().find((record) => record.type === 'stop'), { type: 'stop', user: true }, 'a user stop with no grant says so; the child cannot fall back to the binding');
    const h = await runningTask(t);
    h.manager.stopTask(h.robot, 'simple', h.accepted.taskId);
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.deepEqual(h.child.lines().find((record) => record.type === 'stop'), { type: 'stop' });
});

test('a live message carries the messaging request\'s own grant to the child over stdin only', async (t) => {
    const f = await runningTask(t);
    f.child.child.stderr.write(`@@ALA_EVENT@@${JSON.stringify({ type: 'session-ready' })}\n`);
    await new Promise((resolve) => setTimeout(resolve, 20));
    const pending = f.manager.sendTaskMessage(f.robot, f.accepted.taskId, 'more please', { ownerGrant: 'h.e30.MSGSIG' });
    await new Promise((resolve) => setTimeout(resolve, 20));
    const record = f.child.lines().find((line) => line.type === 'message');
    assert.equal(record.message, 'more please');
    assert.equal(record.ownerGrant, 'h.e30.MSGSIG');
    assert.equal(JSON.stringify(f.manager.taskStatus(f.robot.id, f.accepted.taskId)).includes('MSGSIG'), false);
    f.child.child.stderr.write(`@@ALA_EVENT@@${JSON.stringify({ type: 'message-accepted', id: record.id, delivery: 'delivered' })}\n`);
    assert.equal((await pending).delivery, 'delivered');
    // Without a grant the record carries none.
    const next = f.manager.sendTaskMessage(f.robot, f.accepted.taskId, 'again');
    await new Promise((resolve) => setTimeout(resolve, 20));
    const plain = f.child.lines().filter((line) => line.type === 'message').at(-1);
    assert.equal(Object.hasOwn(plain, 'ownerGrant'), false);
    f.child.child.stderr.write(`@@ALA_EVENT@@${JSON.stringify({ type: 'message-accepted', id: plain.id, delivery: 'delivered' })}\n`);
    await next;
});

test('a stop the worker did not confirm is recorded as stop_not_confirmed, never paused', async (t) => {
    const f = await runningTask(t);
    f.manager.stopTask(f.robot, 'simple', f.accepted.taskId);
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.deepEqual(f.child.lines().find((record) => record.type === 'stop'), { type: 'stop' }, 'no grant to carry');
    f.child.child.emit('close', STOP_NOT_CONFIRMED_EXIT, null);
    const status = await settled(f.manager, f.robot, f.accepted.taskId);
    assert.equal(status.state, 'failed');
    assert.match(status.error, /stop_not_confirmed/);
    assert.equal(status.stopNotConfirmed, true);
});

// ---- how a worker task ends (F8): a precondition failure is shown plainly, and nothing is left `pausing` ----
const STALE = 'worker_robot_stale: Ask an administrator to open robot "Stopper" to update it.';

test('a child that stopped on a worker precondition leaves that message as the task error, not an opaque ALA exit', async (t) => {
    const f = await runningTask(t);
    f.child.child.stderr.write(`${STALE}\n`);
    await new Promise((resolve) => setTimeout(resolve, 10));
    f.child.child.emit('close', 1, null);
    const status = await settled(f.manager, f.robot, f.accepted.taskId);
    assert.equal(status.state, 'failed');
    assert.equal(status.error, STALE);
    assert.equal(/ALA exited/.test(status.error), false);
});

test('stopping an already failed worker task leaves it failed, never pausing', async (t) => {
    const f = await runningTask(t);
    f.child.child.stderr.write(`${STALE}\n`);
    await new Promise((resolve) => setTimeout(resolve, 10));
    f.child.child.emit('close', 1, null);
    await settled(f.manager, f.robot, f.accepted.taskId);
    // RoboFlow's `_fail` stops the phases of a failed flow, including this one.
    f.manager.stopTask(f.robot, 'simple', f.accepted.taskId);
    await new Promise((resolve) => setTimeout(resolve, 20));
    const status = f.manager.taskStatus(f.robot.id, f.accepted.taskId);
    assert.equal(status.state, 'failed');
    assert.equal(status.error, STALE);
    assert.deepEqual(f.child.lines().filter((record) => record.type === 'stop'), [], 'no stop is sent to a child that is gone');
});

test('a task whose stop is pending ends on every path as paused, failed or completed, never pausing', async (t) => {
    // The child fails on its own while the stop is pending: a failure, with its message.
    const failing = await runningTask(t);
    failing.manager.stopTask(failing.robot, 'simple', failing.accepted.taskId);
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(failing.manager.taskStatus(failing.robot.id, failing.accepted.taskId).state, 'pausing');
    failing.child.child.stderr.write(`${STALE}\n`);
    await new Promise((resolve) => setTimeout(resolve, 10));
    failing.child.child.emit('close', 1, null);
    const failed = await settled(failing.manager, failing.robot, failing.accepted.taskId);
    assert.equal(failed.state, 'failed');
    assert.equal(failed.error, STALE);

    // The model reported the task blocked while the stop was pending: still a failure.
    const blocked = await runningTask(t);
    blocked.manager.stopTask(blocked.robot, 'simple', blocked.accepted.taskId);
    await new Promise((resolve) => setTimeout(resolve, 20));
    blocked.child.child.stderr.write(`@@ALA_EVENT@@${JSON.stringify({ type: 'task-failed', message: 'Blocked.' })}\n`);
    await new Promise((resolve) => setTimeout(resolve, 10));
    blocked.child.child.emit('close', 1, null);
    assert.equal((await settled(blocked.manager, blocked.robot, blocked.accepted.taskId)).state, 'failed');

    // A confirmed interruption (130) and a child that had already finished (0) are paused.
    for (const code of [130, 0]) {
        const stopped = await runningTask(t);
        stopped.manager.stopTask(stopped.robot, 'simple', stopped.accepted.taskId);
        await new Promise((resolve) => setTimeout(resolve, 20));
        stopped.child.child.emit('close', code, null);
        assert.equal((await settled(stopped.manager, stopped.robot, stopped.accepted.taskId)).state, 'paused', `exit ${code}`);
    }
});

test('a child that the worker stopped for inactivity or duration leaves that plain line as the task error', async (t) => {
    for (const line of ['Stopped: no activity from the model for 20 minutes', 'Stopped: the task exceeded its maximum duration',
        'Stopped: no activity from the model for the allowed time. Last model error: HTTP 429: daily quota exceeded',
        'Stopped: the selected Soul Gateway model is not available', 'Stopped: Soul Gateway could not be reached for the model. Try again in a moment']) {
        const f = await runningTask(t);
        f.child.child.stderr.write(`${line}\n`);
        await new Promise((resolve) => setTimeout(resolve, 10));
        f.child.child.emit('close', 1, null);
        const status = await settled(f.manager, f.robot, f.accepted.taskId);
        assert.equal(status.state, 'failed');
        assert.equal(status.error, line);
    }
});
