import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { RobotStore } from '../server/robot-store.mjs';
import { RuntimeManager } from '../server/runtime-manager.mjs';
import { registerProject, findProjectRecord } from '../server/project-storage.mjs';

async function fixture(t) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'robot-project-storage-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const dataDir = path.join(root, '.data/roboTeamAgent');
    const store = new RobotStore({ dataDir });
    const robot = await store.create({ name: 'worker' });
    const project = path.join(root, 'project');
    await fs.mkdir(project);
    return { root, project, store, robot, options: { dataDir, workspaceRoot: root } };
}

test('task records survive robot deletion and can be found after manager restart', async t => {
    const f = await fixture(t);
    const id = randomUUID();
    const manager = new RuntimeManager(f.options);
    await manager._saveTask({ taskId: id, robotId: f.robot.id, type: 'simple', state: 'completed',
        alaSessionId: id, request: { cwd: f.project, task: 'Review', ca: 'codex' } });
    const expected = path.join(f.project, '.achilles-cli/tasks', id, 'executions', `${id}.json`);
    assert.equal(findProjectRecord(f.options, 'task', id), expected);
    await assert.rejects(fs.stat(path.join(f.store.robotPath(f.robot.id), 'runtime', `${id}.task.json`)), { code: 'ENOENT' });
    await f.store.delete(f.robot.id);
    assert.equal(JSON.parse(await fs.readFile(expected, 'utf8')).robotId, f.robot.id);
    const second = new RuntimeManager(f.options);
    second._drainTaskQueue = async () => {};
    await assert.rejects(second.resumeTask({ id: 'replacement-123456' }, id), /no matching task/);
    assert.equal(findProjectRecord(f.options, 'task', id), expected);
});

test('project lookup rejects ambiguous copied sessions and substituted files', async t => {
    const f = await fixture(t);
    const id = randomUUID();
    registerProject(f.options, f.project);
    const sessions = path.join(f.project, '.achilles-cli/sessions');
    await fs.mkdir(sessions);
    const file = path.join(sessions, `${id}.json`);
    await fs.writeFile(file, JSON.stringify({ sessionId: id }));
    assert.equal(findProjectRecord(f.options, 'session', id), file);
    const second = path.join(f.root, 'second');
    await fs.mkdir(second);
    registerProject(f.options, second);
    await fs.mkdir(path.join(second, '.achilles-cli/sessions'));
    const duplicate = path.join(second, '.achilles-cli/sessions', `${id}.json`);
    await fs.copyFile(file, duplicate);
    assert.throws(() => findProjectRecord(f.options, 'session', id), /multiple folders/);
    await fs.unlink(duplicate);
    await fs.symlink(file, duplicate);
    assert.throws(() => findProjectRecord(f.options, 'session', id), /symbolic link/);
});

test('registration rejects a symlinked project store and paths outside the workspace', async t => {
    const f = await fixture(t);
    const target = path.join(f.root, 'target');
    await fs.mkdir(target);
    await fs.symlink(target, path.join(f.project, '.achilles-cli'));
    assert.throws(() => registerProject(f.options, f.project), /real directory/);
    assert.deepEqual(await fs.readdir(target), []);
    assert.throws(() => registerProject(f.options, os.tmpdir()), /outside PLOINKY_WORKSPACE_ROOT/);
});
