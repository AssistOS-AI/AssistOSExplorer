import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createRoboTeamServer } from '../server/http-server.mjs';
import { RobotStore } from '../server/robot-store.mjs';
import { RoboFlowService } from '../server/roboflow/roboflow-service.mjs';
import { WorkflowRegistry } from '../server/roboflow/workflow-registry.mjs';
import { TaskFlowStore } from '../server/roboflow/task-flow-store.mjs';

function authHeader(userId, roles = ['user']) {
    return JSON.stringify({ user: { id: userId, username: userId, roles } });
}

async function waitFor(predicate, { attempts = 3000 } = {}) {
    for (let index = 0; index < attempts; index += 1) {
        const value = await predicate();
        if (value) return value;
        await new Promise((resolve) => setImmediate(resolve));
    }
    throw new Error('condition was not met');
}

async function startFixture() {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'roboflow-http-'));
    const dataDir = path.join(root, 'private');
    const workspaceRoot = path.join(root, 'workspace');
    await fs.mkdir(workspaceRoot, { recursive: true });
    const robotStore = new RobotStore({ dataDir });
    await robotStore.initialize();
    let counter = 0;
    const started = [];
    const runtimeManager = {
        workspaceRoot,
        status: () => ({ state: 'stopped' }),
        async resolveCwd(value) { return path.resolve(String(value || workspaceRoot)); },
        startTask(robot, type, request) { counter += 1; started.push({ taskId: `task-${counter}`, robot, type, request }); return { taskId: `task-${counter}`, state: 'queued' }; },
        stopTask() { return {}; },
        activePort: () => null,
        hasUnfinishedTasks: () => false,
        logs: async () => '',
    };
    const roboflow = new RoboFlowService({
        robotStore,
        runtimeManager,
        registry: new WorkflowRegistry({ directory: path.join(dataDir, 'roboflow', 'workflows') }),
        store: new TaskFlowStore({ directory: path.join(dataDir, 'roboflow', 'flows') }),
    });
    await roboflow.initialize();
    const server = createRoboTeamServer({ robotStore, runtimeManager, roboflow, internalToken: 'test-token', publicBasePath: '/rt/', mcpPort: 65534 });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    return {
        root, roboflow, runtimeManager, robotStore, started,
        baseUrl: `http://127.0.0.1:${server.address().port}`,
        close: async () => { await new Promise((resolve) => server.close(resolve)); await fs.rm(root, { recursive: true, force: true }); },
    };
}

const json = (roles, body, method = 'POST') => ({
    method,
    headers: { 'content-type': 'application/json', 'x-ploinky-auth-info': authHeader('actor', roles) },
    body: body === undefined ? undefined : JSON.stringify(body),
});

const WORKFLOW = { id: 'software-change', name: 'Software change', decisionMemberId: 'impl', members: [{ id: 'impl', robotName: 'worker', executionType: 'terminal' }] };

test('workflow creation requires an administrator and lists for members', async (t) => {
    const f = await startFixture();
    t.after(f.close);
    await f.robotStore.create({ name: 'worker' });

    assert.equal((await fetch(`${f.baseUrl}/api/roboflow/workflows`, json(['user'], WORKFLOW))).status, 403);
    const created = await fetch(`${f.baseUrl}/api/roboflow/workflows`, json(['admin'], WORKFLOW));
    assert.equal(created.status, 201);
    const listed = await fetch(`${f.baseUrl}/api/roboflow/workflows`, { headers: { 'x-ploinky-auth-info': authHeader('user') } });
    assert.equal(listed.status, 200);
    assert.equal((await listed.json()).workflows.length, 1);
});

test('task flow lifecycle over HTTP starts, launches, logs and finishes', async (t) => {
    const f = await startFixture();
    t.after(f.close);
    await f.robotStore.create({ name: 'worker' });
    await f.roboflow.createWorkflow(WORKFLOW);

    const created = await fetch(`${f.baseUrl}/api/roboflow/flows`, json(['user'], { workflowTypeId: 'software-change', objective: 'Add OAuth', folder: f.root }));
    assert.equal(created.status, 201);
    const { flow } = await created.json();
    assert.equal(flow.status, 'running');

    const decision = await waitFor(() => f.started.find((entry) => entry.request.task.includes('Flow id')));
    assert.equal(decision.type, 'simple');

    const launched = await fetch(`${f.baseUrl}/api/roboflow/flows/${flow.id}/launch`, json(['user'], { member: 'impl', instruction: 'Implement' }));
    assert.equal(launched.status, 202);
    const { invocationId, runtimeTaskId } = await launched.json();
    assert.equal(f.started.find((entry) => entry.taskId === runtimeTaskId).type, 'simple');

    f.roboflow.onRuntimeTaskEvent({ kind: 'progress', taskId: runtimeTaskId, chunk: 'hello log\n' });
    f.roboflow.onRuntimeTaskEvent({ kind: 'terminal', taskId: runtimeTaskId, state: 'completed', result: 'finished', error: null });
    f.roboflow.onRuntimeTaskEvent({ kind: 'terminal', taskId: decision.taskId, state: 'completed', result: 'step done', error: null });
    await waitFor(async () => {
        const snapshot = await f.roboflow.getFlow(flow.id, { logMode: 'none' });
        return snapshot.invocations[0]?.state === 'completed';
    });

    const details = await fetch(`${f.baseUrl}/api/roboflow/flows/${flow.id}`, { headers: { 'x-ploinky-auth-info': authHeader('user') } });
    const body = await details.json();
    assert.equal(body.flow.invocations[0].summary, 'finished');
    assert.equal(body.flow.invocations[0].state, 'completed');

    const log = await fetch(`${f.baseUrl}/api/roboflow/flows/${flow.id}/invocations/${invocationId}/log`, { headers: { 'x-ploinky-auth-info': authHeader('user') } });
    assert.match(await log.text(), /hello log/);

    const finished = await fetch(`${f.baseUrl}/api/roboflow/flows/${flow.id}/finish`, json(['user'], { result: 'done' }));
    assert.equal(finished.status, 200);
    assert.equal((await finished.json()).flow.status, 'completed');
});

test('workflow update requires an administrator and the default workflow cannot be edited or deleted', async (t) => {
    const f = await startFixture();
    t.after(f.close);
    await f.robotStore.create({ name: 'worker' });
    await f.roboflow.createWorkflow({ id: 'custom', name: 'Custom', decisionMemberId: 'm', members: [{ id: 'm', robotName: 'worker', executionType: 'terminal' }] });
    await f.roboflow.createWorkflow({ id: 'default', name: 'Default', decisionMemberId: 'm', members: [{ id: 'm', robotName: 'worker', executionType: 'terminal' }] });
    const edit = { name: 'Custom v2', decisionMemberId: 'm', members: [{ id: 'm', robotName: 'worker', executionType: 'browser' }] };

    assert.equal((await fetch(`${f.baseUrl}/api/roboflow/workflows/custom`, json(['user'], edit, 'PUT'))).status, 403);
    const updated = await fetch(`${f.baseUrl}/api/roboflow/workflows/custom`, json(['admin'], edit, 'PUT'));
    assert.equal(updated.status, 200);
    assert.equal((await updated.json()).workflow.members[0].executionType, 'browser');

    const editedDefault = await fetch(`${f.baseUrl}/api/roboflow/workflows/default`, json(['admin'], edit, 'PUT'));
    assert.equal(editedDefault.status, 409);
    assert.match((await editedDefault.json()).error, /default workflow cannot be edited/);

    const deleted = await fetch(`${f.baseUrl}/api/roboflow/workflows/default`, json(['admin'], undefined, 'DELETE'));
    assert.equal(deleted.status, 409);
    assert.match((await deleted.json()).error, /default workflow cannot be deleted/);
});

test('roboflow view is served and requires authentication', async (t) => {
    const f = await startFixture();
    t.after(f.close);
    assert.equal((await fetch(`${f.baseUrl}/roboflow`)).status, 401);
    const page = await fetch(`${f.baseUrl}/roboflow`, { headers: { 'x-ploinky-auth-info': authHeader('user') } });
    assert.equal(page.status, 200);
    assert.match(await page.text(), /RoboFlow/);
});
