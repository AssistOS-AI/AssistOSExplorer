import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import { RuntimeManager } from '../server/runtime-manager.mjs';

function deferred() {
    let resolve;
    const promise = new Promise(done => { resolve = done; });
    return { promise, resolve };
}

const turn = () => new Promise(setImmediate);

async function fixture(t) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'runtime-drain-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const robot = { id: 'drain-a1b2c3', name: 'Drain', codingAgents: ['codex'] };
    const children = [], preparations = [], events = [], calls = [];
    const manager = new RuntimeManager({ dataDir: root, workspaceRoot: root,
        roboWork: { call: async (tool, input) => { calls.push({ tool, input }); return {}; } },
        spawnImpl: (_command, args) => {
            const child = new EventEmitter();
            child.stdout = new PassThrough(); child.stderr = new PassThrough();
            child.stdin = { on() {}, write() {} };
            child.args = args;
            children.push(child);
            return child;
        },
    });
    manager.resolveCwd = async value => { preparations.push(value); return root; };
    manager._saveTask = async () => {};
    manager.setTaskObserver(event => events.push(event));
    const start = () => manager.startTask(robot, 'simple', { cwd: root, task: 'original', ca: 'codex',
        ownerPrincipal: 'user:original', environment: 'test/native' });
    manager.agentEnvironments.require = async () => {};
    const until = async predicate => {
        for (let count = 0; count < 100 && !predicate(); count++) await turn();
        assert.ok(predicate(), 'expected event was reached');
    };
    const finish = async () => {
        for (const child of children) child.emit('close', 0, null);
        await turn(); await turn();
    };
    t.after(finish);
    return { root, robot, manager, children, preparations, events, calls, start, until };
}

test('Continue admits immediately but waits for producer close and final cleanup; other sessions proceed', async t => {
    const f = await fixture(t);
    const old = f.start();
    await f.until(() => f.children.length === 1);
    f.manager.stopTask(f.robot, 'simple', old.taskId);
    await turn();
    assert.equal(f.manager.taskStatus(f.robot.id, old.taskId).state, 'paused');
    const cleanup = deferred(), cleaning = deferred();
    t.after(cleanup.resolve);
    f.manager._saveTask = async task => {
        if (task.taskId === old.taskId && task.state === 'paused') { cleaning.resolve(); await cleanup.promise; }
    };
    const resumed = await f.manager.resumeTask(f.robot, old.taskId, 'fresh message');
    assert.notEqual(resumed.taskId, old.taskId);
    await turn();
    assert.equal(f.preparations.length, 1, 'no replacement preparation while old producer is alive');
    assert.equal(f.children.length, 1);
    f.start();
    await f.until(() => f.children.length === 2);
    f.children[0].emit('close', 130, null);
    await cleaning.promise;
    await turn();
    assert.equal(f.children.length, 2, 'producer close alone does not finish cleanup');
    assert.equal(f.preparations.length, 2);
    cleanup.resolve();
    await f.until(() => f.children.length === 3);
    const task = f.manager.tasks.get(resumed.taskId);
    assert.equal(task.alaSessionId, old.taskId);
    assert.equal(task.request.task, 'fresh message');
    assert.equal(task.request.ownerPrincipal, 'user:original');
    assert.equal(task.request.environment, 'test/native');
    assert.ok(f.children[2].args.includes('--resume-session'));
    const publicJson = JSON.stringify([f.manager.taskStatus(f.robot.id, resumed.taskId), f.events]);
    assert.doesNotMatch(publicJson, /taskExecutions|completion|AbortController|Promise/);
});

for (const action of ['stop', 'shutdown']) {
    test(`${action} cancels only the waiting successor without a late launch`, async t => {
        const f = await fixture(t);
        const old = f.start();
        await f.until(() => f.children.length === 1);
        f.manager.stopTask(f.robot, 'simple', old.taskId);
        await turn();
        const next = await f.manager.resumeTask(f.robot, old.taskId);
        await turn();
        if (action === 'stop') f.manager.stopTask(f.robot, 'simple', next.taskId);
        else await f.manager.stopAll();
        await f.until(() => f.events.some(event => event.kind === 'terminal' && event.taskId === next.taskId));
        assert.deepEqual(f.events.filter(event => event.kind === 'terminal' && event.taskId === next.taskId).map(event => event.state), ['paused']);
        assert.equal(f.preparations.length, 1);
        assert.equal(f.calls.filter(call => call.tool === 'run_stop').length, 0);
        f.children[0].emit('close', 130, null);
        await turn(); await turn();
        assert.equal(f.children.length, 1);
        assert.equal(f.manager.taskStatus(f.robot.id, next.taskId).state, 'paused');
    });
}

test('35-second deadline fails only the successor, retaining the original drain and blocking deletion', async t => {
    const f = await fixture(t);
    const old = f.start();
    await f.until(() => f.children.length === 1);
    f.manager.stopTask(f.robot, 'simple', old.taskId);
    await turn();
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const next = await f.manager.resumeTask(f.robot, old.taskId);
    await turn();
    t.mock.timers.tick(34999);
    await turn();
    assert.equal(f.manager.taskStatus(f.robot.id, next.taskId).state, 'starting');
    t.mock.timers.tick(1);
    await f.until(() => f.events.some(event => event.kind === 'terminal' && event.taskId === next.taskId));
    assert.equal(f.manager.taskStatus(f.robot.id, next.taskId).state, 'failed');
    assert.match(f.manager.taskStatus(f.robot.id, next.taskId).error, /has not finished stopping/);
    assert.equal(f.preparations.length, 1);
    assert.equal(f.manager.hasUnfinishedTasks(f.robot.id), false, 'historical terminal accounting stays unchanged');
    let removed = false;
    await assert.rejects(f.manager.deleteRobot(f.robot.id, async () => { removed = true; }), /before deleting/);
    assert.equal(removed, false);
    const later = await f.manager.resumeTask(f.robot, next.taskId);
    await turn();
    assert.equal(f.children.length, 1, 'a timeout cannot settle or forget the predecessor');
    f.children[0].emit('close', 130, null);
    await f.until(() => f.children.length === 2);
    f.children[1].emit('close', 0, null);
    await f.until(() => f.events.some(event => event.kind === 'terminal' && event.taskId === later.taskId));
    await f.manager.deleteRobot(f.robot.id, async () => { removed = true; });
    assert.equal(removed, true, 'completed historical records do not prevent deletion');
});

test('child error without close retains a possible live producer', async t => {
    const f = await fixture(t);
    const old = f.start();
    await f.until(() => f.children.length === 1);
    f.children[0].emit('error', new Error('producer control failed'));
    await turn();
    assert.equal(f.manager.taskStatus(f.robot.id, old.taskId).state, 'failed');
    assert.equal(f.events.some(event => event.kind === 'terminal'), false);
    const next = await f.manager.resumeTask(f.robot, old.taskId);
    await turn();
    assert.equal(f.children.length, 1);
    assert.equal(f.preparations.length, 1);
    f.children[0].emit('close', 1, null);
    await f.until(() => f.children.length === 2);
    assert.equal(f.children[1].args[f.children[1].args.indexOf('--session-id') + 1], old.taskId);
    assert.equal(f.manager.tasks.get(next.taskId).alaSessionId, old.taskId);
});

test('known failure before a producer exists finishes without a phantom drain', async t => {
    const f = await fixture(t);
    const spawn = f.manager.spawnImpl;
    f.manager.spawnImpl = () => { throw new Error('spawn refused before creating a producer'); };
    const old = f.start();
    await f.until(() => f.events.some(event => event.kind === 'terminal' && event.taskId === old.taskId));
    assert.equal(f.manager.taskStatus(f.robot.id, old.taskId).state, 'failed');
    f.manager.spawnImpl = spawn;
    const next = await f.manager.resumeTask(f.robot, old.taskId);
    await f.until(() => f.children.length === 1);
    assert.equal(f.manager.taskStatus(f.robot.id, next.taskId).state, 'running');
});

test('a stop in the starting event cancels before installing a predecessor wait', async t => {
    const f = await fixture(t);
    const old = f.start();
    await f.until(() => f.children.length === 1);
    f.manager.stopTask(f.robot, 'simple', old.taskId);
    await turn();
    f.manager.setTaskObserver(event => {
        f.events.push(event);
        if (event.kind === 'state' && event.state === 'starting' && event.taskId !== old.taskId) {
            const task = f.manager.tasks.get(event.taskId);
            task.cancelRequested = true;
            task.state = 'paused';
        }
    });
    const next = await f.manager.resumeTask(f.robot, old.taskId);
    await f.until(() => f.events.some(event => event.kind === 'terminal' && event.taskId === next.taskId));
    assert.equal(f.children.length, 1);
});

test('deletion remains blocked after producer close until final persistence cleanup completes', async t => {
    const f = await fixture(t);
    const old = f.start();
    await f.until(() => f.children.length === 1);
    f.manager.stopTask(f.robot, 'simple', old.taskId);
    await turn();
    const cleanup = deferred(), cleaning = deferred();
    t.after(cleanup.resolve);
    f.manager._saveTask = async () => { cleaning.resolve(); await cleanup.promise; };
    f.children[0].emit('close', 130, null);
    await cleaning.promise;
    await assert.rejects(f.manager.deleteRobot(f.robot.id, async () => assert.fail('removed while cleaning')), /before deleting/);
    cleanup.resolve();
    await f.until(() => f.events.some(event => event.kind === 'terminal' && event.taskId === old.taskId));
    await f.manager.deleteRobot(f.robot.id, async () => {});
});

test('two Continue calls paused in policy preparation admit exactly one replacement', async t => {
    const f = await fixture(t);
    const old = f.manager._newTask(f.robot, 'simple', { cwd: f.root, task: 'old' });
    old.state = 'paused';
    const gate = deferred(), both = deferred();
    let calls = 0;
    f.manager.skillsets = { policies: { ensure: async () => { if (++calls === 2) both.resolve(); await gate.promise; } } };
    const first = f.manager.resumeTask(f.robot, old.taskId);
    const second = f.manager.resumeTask(f.robot, old.taskId);
    await both.promise;
    gate.resolve();
    const results = await Promise.allSettled([first, second]);
    assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
    assert.match(results.find(result => result.status === 'rejected').reason.message, /already has an active execution/);
    assert.equal(f.events.filter(event => event.kind === 'admitted').length, 1);
});

for (const changed of ['deleted', 'manual-control', 'terminal-state']) {
    test(`Continue rechecks ${changed} after human-input and policy awaits`, async t => {
        const f = await fixture(t);
        const old = f.manager._newTask(f.robot, 'simple', { cwd: f.root, task: 'old' });
        old.state = 'paused';
        const gate = deferred(), entered = deferred();
        f.manager.skillsets = { policies: { ensure: async () => { entered.resolve(); await gate.promise; } } };
        f.manager.assertHumanInputAnswered = async () => {};
        const result = f.manager.resumeTask(f.robot, old.taskId);
        await entered.promise;
        if (changed === 'deleted') f.manager.deletedRobots.add(f.robot.id);
        if (changed === 'manual-control') f.manager.manualControl.set(f.robot.id, 'another-task');
        if (changed === 'terminal-state') old.state = 'running';
        gate.resolve();
        await assert.rejects(result, /deleted|manual control|no matching task/);
        assert.equal(f.events.filter(event => event.kind === 'admitted').length, 0);
        assert.equal(f.children.length, 0);
    });
}

test('saved execution JSON contains no completion promise, wait handle or controller map', async t => {
    const f = await fixture(t);
    const old = f.start();
    await f.until(() => f.children.length === 1);
    f.manager.stopTask(f.robot, 'simple', old.taskId);
    await turn();
    const next = await f.manager.resumeTask(f.robot, old.taskId);
    await turn();
    await RuntimeManager.prototype._saveTask.call(f.manager, f.manager.tasks.get(next.taskId));
    const json = await fs.readFile(path.join(f.root, '.roboteam', 'tasks', old.taskId, 'executions', `${next.taskId}.json`), 'utf8');
    assert.equal(JSON.parse(json).alaSessionId, old.taskId);
    assert.doesNotMatch(json, /taskExecutions|completion|cancelWait|Promise|AbortController/);
    f.manager.stopTask(f.robot, 'simple', next.taskId);
    await turn();
});
