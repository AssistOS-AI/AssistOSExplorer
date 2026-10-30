import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { deleteRobotEverywhere } from '../server/robot-delete.mjs';
import { RobotStore } from '../server/robot-store.mjs';
import { removeRobotOnWorker } from '../server/worker-coordinator/grant-actions.mjs';
import { createRobotProvisioner } from '../server/worker-coordinator/robot-provisioning.mjs';
import { WorkerError } from '../server/worker-coordinator/worker-client.mjs';

// Robot deletion across RoboTeam and the worker (F12, decision M-29): every local precondition before the worker is asked, 409 and
// never a half-deleted robot, and a settled outcome when the local delete fails after the worker accepted.
const stopped = () => ({ status: () => ({ state: 'stopped' }), hasUnfinishedTasks: () => false });

// A real store with a real robot, and the chat helper registered the way robot-cli does (acquireCliUsage).
async function fixture(t) {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'robot-delete-'));
    t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
    const store = new RobotStore({ dataDir });
    const robot = await store.create({ name: 'Disposable' });
    const worker = { calls: [], accept: true };
    const removeOnWorker = async (target) => {
        worker.calls.push(target.id);
        if (worker.busy) throw Object.assign(new Error('robot_busy: the robot has running or unsettled work; stop it first.'), { statusCode: 409, code: 'robot_busy' });
        return { deleted: true };
    };
    return { store, robot, worker, removeOnWorker, exists: async () => Boolean(await store.get(robot.id)) };
}

test('a live robot chat refuses the delete with 409 before the worker is asked, and nothing is deleted anywhere', async (t) => {
    const f = await fixture(t);
    const release = await f.store.acquireCliUsage(f.robot.id);
    await assert.rejects(deleteRobotEverywhere({ robot: f.robot, runtimeManager: stopped(), robotStore: f.store, removeOnWorker: f.removeOnWorker }),
        (error) => error.statusCode === 409 && /close the robot chat and stop its CLI tasks before deleting it/.test(error.message));
    assert.deepEqual(f.worker.calls, [], 'the worker was not asked');
    assert.equal(await f.exists(), true);
    // The chat ends; the same delete now goes through, worker first, then the record.
    await release();
    await deleteRobotEverywhere({ robot: f.robot, runtimeManager: stopped(), robotStore: f.store, removeOnWorker: f.removeOnWorker });
    assert.deepEqual(f.worker.calls, [f.robot.id]);
    assert.equal(await f.exists(), false);
});

test('a running workstation or task, and the manager\'s own state, refuse with 409 before the worker is asked', async (t) => {
    const f = await fixture(t);
    const cases = {
        'workstation running': { status: () => ({ state: 'running' }), hasUnfinishedTasks: () => false },
        'task running': { status: () => ({ state: 'stopped', task: { state: 'running' } }), hasUnfinishedTasks: () => false },
        'unfinished tasks': { status: () => ({ state: 'stopped' }), hasUnfinishedTasks: () => true },
        'manager busy': { ...stopped(), assertDeletable() { throw Object.assign(new Error('stop the robot and its queued tasks before deleting it'), { statusCode: 409 }); } },
    };
    for (const [name, runtimeManager] of Object.entries(cases)) {
        await assert.rejects(deleteRobotEverywhere({ robot: f.robot, runtimeManager, robotStore: f.store, removeOnWorker: f.removeOnWorker }), (error) => error.statusCode === 409, name);
    }
    assert.deepEqual(f.worker.calls, []);
    assert.equal(await f.exists(), true);
});

test('a worker that finds the robot busy refuses with 409 and the record is kept', async (t) => {
    const f = await fixture(t);
    f.worker.busy = true;
    await assert.rejects(deleteRobotEverywhere({ robot: f.robot, runtimeManager: stopped(), robotStore: f.store, removeOnWorker: f.removeOnWorker }),
        (error) => error.statusCode === 409 && error.code === 'robot_busy' && /running or unsettled work; stop it first/.test(error.message));
    assert.equal(f.worker.calls.length, 1);
    assert.equal(await f.exists(), true);
    // Through the real provisioner the worker's refusal reaches the same answer.
    const client = {
        async getRobot() { return { lifecycle: 'ready', revision: 3 }; },
        async deleteRobot() { throw new WorkerError('robot_busy', 409); },
    };
    const provisioner = createRobotProvisioner({ client, robotStore: {}, sleep: async () => {} });
    const robot = { ...f.robot, worker: { robotId: 'AAAAAAAAAAAAAAAAAAAAAA' } };
    await assert.rejects(deleteRobotEverywhere({ robot, runtimeManager: stopped(), robotStore: f.store, removeOnWorker: (target) => removeRobotOnWorker({ provisioner, robot: target, grant: 'g' }) }),
        (error) => error.statusCode === 409 && error.code === 'robot_busy');
    assert.equal(await f.exists(), true);
});

test('success removes the worker\'s robot first and then RoboTeam\'s record', async (t) => {
    const f = await fixture(t);
    const order = [];
    const store = { assertDeletable: (id) => f.store.assertDeletable(id), delete: async (id) => { order.push('record'); return f.store.delete(id); } };
    await deleteRobotEverywhere({ robot: f.robot, runtimeManager: stopped(), robotStore: store, removeOnWorker: async (target) => { order.push('worker'); return f.removeOnWorker(target); } });
    assert.deepEqual(order, ['worker', 'record']);
    assert.equal(await f.exists(), false);
    // Local-only mode (no worker): the record alone.
    const g = await fixture(t);
    await deleteRobotEverywhere({ robot: g.robot, runtimeManager: stopped(), robotStore: g.store, removeOnWorker: null });
    assert.equal(await g.exists(), false);
});

test('a local delete that fails after the worker accepted is retried, then settled with a 409 that says deleting again finishes it', async (t) => {
    const f = await fixture(t);
    // Something starts between the check and the delete: the first two local attempts are refused, the third succeeds.
    let attempts = 0;
    const store = { assertDeletable: async () => {}, delete: async (id) => { attempts += 1; if (attempts < 3) throw Object.assign(new Error('close the robot chat and stop its CLI tasks before deleting it'), { statusCode: 409 }); return f.store.delete(id); } };
    await deleteRobotEverywhere({ robot: f.robot, runtimeManager: stopped(), robotStore: store, removeOnWorker: f.removeOnWorker, sleep: async () => {} });
    assert.equal(attempts, 3);
    assert.equal(await f.exists(), false, 'settled: both removed');

    const h = await fixture(t);
    let tries = 0;
    const stuck = { assertDeletable: async () => {}, delete: async () => { tries += 1; throw Object.assign(new Error('close the robot chat and stop its CLI tasks before deleting it'), { statusCode: 409 }); } };
    await assert.rejects(deleteRobotEverywhere({ robot: h.robot, runtimeManager: stopped(), robotStore: stuck, removeOnWorker: h.removeOnWorker, sleep: async () => {} }),
        (error) => error.statusCode === 409 && error.code === 'robot_delete_incomplete' && /already deleted this robot/.test(error.message) && /Delete it again to finish/.test(error.message));
    assert.equal(tries, 3, 'bounded');
    // Deleting again: the worker's deletion is idempotent, so only the record remains to be removed.
    await deleteRobotEverywhere({ robot: h.robot, runtimeManager: stopped(), robotStore: h.store, removeOnWorker: h.removeOnWorker, sleep: async () => {} });
    assert.equal(await h.exists(), false);
    // A failure that is not a precondition is not disguised as one.
    const broken = { assertDeletable: async () => {}, delete: async () => { throw new Error('disk failure'); } };
    await assert.rejects(deleteRobotEverywhere({ robot: f.robot, runtimeManager: stopped(), robotStore: broken, removeOnWorker: null, sleep: async () => {} }), /disk failure/);
});
