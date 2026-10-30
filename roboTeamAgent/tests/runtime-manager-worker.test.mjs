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
