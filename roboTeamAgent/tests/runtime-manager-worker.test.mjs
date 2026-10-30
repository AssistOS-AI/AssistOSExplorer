import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import { RuntimeManager } from '../server/runtime-manager.mjs';
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

test('without the worker a stop is SIGTERM as before', () => {
    const c = child();
    RuntimeManager.prototype._stopChild.call({ workerMode: false }, c.child);
    assert.deepEqual(c.signals, ['SIGTERM']);
    assert.deepEqual(c.written, []);
    RuntimeManager.prototype._stopChild.call({ workerMode: true }, null);
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

test('without the worker a grant is neither kept nor sent', async (t) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'roboteam-nogrant-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const dataDir = path.join(root, 'data');
    const workspace = path.join(root, 'workspace');
    const robot = { id: 'plain-a1b2c3', name: 'Plain' };
    await Promise.all([fs.mkdir(path.join(dataDir, 'robots', robot.id, 'home'), { recursive: true }), fs.mkdir(workspace, { recursive: true })]);
    const texts = [];
    const spawnImpl = () => {
        const child = new EventEmitter();
        child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.kill = () => true; child.stdin = new PassThrough();
        let text = '';
        child.stdin.on('data', (chunk) => { text += chunk; });
        setImmediate(() => { texts.push(text); child.emit('close', 0, null); });
        return child;
    };
    const manager = new RuntimeManager({ dataDir, workspaceRoot: root, spawnImpl, workerMode: false, toolCache, execFileImpl: async () => ({ stdout: '[]', stderr: '' }) });
    t.after(() => manager.stopAll());
    const accepted = manager.startTask(robot, 'simple', { cwd: workspace, task: 'Do work', ca: 'codex', ownerGrant: 'h.e30.SECRETSIGNATURE' });
    while (!['completed', 'failed'].includes(manager.taskStatus(robot.id, accepted.taskId).state)) await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(manager.taskGrants.size, 0);
    assert.equal(texts.join('').includes('SECRETSIGNATURE'), false);
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
const STALE = 'worker_robot_stale: Robot "Stopper"\'s configuration changed; open the robot or start the flow again to update it.';

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
