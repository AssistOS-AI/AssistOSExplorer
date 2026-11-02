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
    const expected = path.join(f.project, '.roboteam/tasks', id, 'executions', `${id}.json`);
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
    // A saved session is the config.json inside its own .roboteam/sessions/<sessionId> directory.
    const sessionDirectory = path.join(f.project, '.roboteam/sessions', id);
    await fs.mkdir(sessionDirectory, { recursive: true });
    const file = path.join(sessionDirectory, 'config.json');
    await fs.writeFile(file, JSON.stringify({ sessionId: id }));
    assert.equal(findProjectRecord(f.options, 'session', id), file);
    const second = path.join(f.root, 'second');
    await fs.mkdir(second);
    registerProject(f.options, second);
    const duplicateDirectory = path.join(second, '.roboteam/sessions', id);
    await fs.mkdir(duplicateDirectory, { recursive: true });
    const duplicate = path.join(duplicateDirectory, 'config.json');
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
    await fs.symlink(target, path.join(f.project, '.roboteam'));
    assert.throws(() => registerProject(f.options, f.project), /real directory/);
    assert.deepEqual(await fs.readdir(target), []);
    assert.throws(() => registerProject(f.options, os.tmpdir()), /outside PLOINKY_WORKSPACE_ROOT/);
});

test('a continued task takes its folder and skill policy from where its record sits, not from the record', async t => {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'robot-resume-folder-')));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const options = { dataDir: path.join(root, '.data/roboTeamAgent'), workspaceRoot: root };
    const project = path.join(root, 'project'), other = path.join(root, 'other');
    await fs.mkdir(project); await fs.mkdir(other);
    registerProject(options, project);
    const robot = { id: 'worker-123456', name: 'worker' };
    const id = randomUUID();
    const request = { cwd: project, task: 'Review' };
    const manager = new RuntimeManager({ ...options, roboWork: { call: async () => ({}) } });
    manager._drainTaskQueue = async () => {};
    await manager._saveTask({ taskId: id, robotId: robot.id, type: 'simple', state: 'completed', alaSessionId: id, request });
    const record = findProjectRecord(options, 'task', id);
    const policies = [], started = [];
    const resume = () => {
        const fresh = new RuntimeManager({ ...options, roboWork: { call: async () => ({}) } });
        fresh._drainTaskQueue = async () => {};
        fresh.skillsets = { policies: { ensure: async (_robot, policyId) => { policies.push(policyId); } } };
        const enqueue = fresh._enqueueTask.bind(fresh);
        fresh._enqueueTask = (...args) => { started.push(args[2]); return enqueue(...args); };
        return fresh.resumeTask(robot, id);
    };
    // A robot planted a record that names another folder: nothing starts.
    const saved = JSON.parse(await fs.readFile(record, 'utf8'));
    await fs.writeFile(record, JSON.stringify({ ...saved, request: { ...saved.request, cwd: other } }));
    await assert.rejects(resume(), /belongs to another folder/u);
    assert.deepEqual(started, []);
    // A skill policy reference in the record is not followed.
    await fs.writeFile(record, JSON.stringify({ ...saved, request: { ...saved.request, skillPolicyRef: randomUUID() } }));
    await resume();
    assert.deepEqual(policies, [id]);
    assert.equal(started[0].cwd, project);
    // A link to the folder passes the comparison, so the canonical folder replaces it before anything resolves it again.
    const link = path.join(project, 'link');
    await fs.symlink(project, link);
    await fs.writeFile(record, JSON.stringify({ ...saved, request: { ...saved.request, cwd: link } }));
    await resume();
    assert.equal(started[1].cwd, project);
});
