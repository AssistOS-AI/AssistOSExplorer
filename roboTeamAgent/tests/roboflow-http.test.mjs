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
        startTask(robot, type, request) { counter += 1; started.push({ robot, type, request }); return { taskId: `task-${counter}`, state: 'queued' }; },
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

test('workflow creation requires an administrator and lists for members', async (t) => {
    const f = await startFixture();
    t.after(f.close);
    await f.robotStore.create({ name: 'worker' });
    const workflow = { id: 'software-change', name: 'Software change', members: [{ id: 'impl', robotName: 'worker', executionType: 'terminal' }] };

    assert.equal((await fetch(`${f.baseUrl}/api/roboflow/workflows`, json(['user'], workflow))).status, 403);
    const created = await fetch(`${f.baseUrl}/api/roboflow/workflows`, json(['admin'], workflow));
    assert.equal(created.status, 201);
    const listed = await fetch(`${f.baseUrl}/api/roboflow/workflows`, { headers: { 'x-ploinky-auth-info': authHeader('user') } });
    assert.equal(listed.status, 200);
    assert.equal((await listed.json()).workflows.length, 1);
});

test('task flow lifecycle over HTTP exposes summaries and full logs', async (t) => {
    const f = await startFixture();
    t.after(f.close);
    await f.robotStore.create({ name: 'worker' });
    await f.roboflow.createWorkflow({ id: 'software-change', name: 'Software change', members: [{ id: 'impl', robotName: 'worker', executionType: 'terminal' }] });

    const created = await fetch(`${f.baseUrl}/api/roboflow/flows`, json(['user'], { workflowTypeId: 'software-change', objective: 'Add OAuth', folder: f.root }));
    assert.equal(created.status, 201);
    const { flow } = await created.json();

    const invoked = await fetch(`${f.baseUrl}/api/roboflow/flows/${flow.id}/invoke`, json(['user'], { member: 'impl', instruction: 'Implement' }));
    assert.equal(invoked.status, 202);
    const { invocationId, runtimeTaskId } = await invoked.json();
    assert.equal(f.started.length, 1);
    assert.equal(f.started[0].type, 'simple');

    f.roboflow.onRuntimeTaskEvent({ kind: 'progress', taskId: runtimeTaskId, chunk: 'hello log\n' });
    f.roboflow.onRuntimeTaskEvent({ kind: 'terminal', taskId: runtimeTaskId, state: 'completed', result: 'finished', error: null });
    await f.roboflow.waitForInvocation(flow.id, invocationId);

    const details = await fetch(`${f.baseUrl}/api/roboflow/flows/${flow.id}`, { headers: { 'x-ploinky-auth-info': authHeader('user') } });
    const body = await details.json();
    assert.equal(body.flow.invocations[0].summary, 'finished');
    assert.equal(body.flow.invocations[0].state, 'completed');

    const log = await fetch(`${f.baseUrl}/api/roboflow/flows/${flow.id}/invocations/${invocationId}/log`, { headers: { 'x-ploinky-auth-info': authHeader('user') } });
    assert.match(await log.text(), /hello log/);

    const finished = await fetch(`${f.baseUrl}/api/roboflow/flows/${flow.id}/finish`, json(['user'], { result: 'done' }));
    assert.equal(finished.status, 200);
    assert.equal((await finished.json()).flow.status, 'done');
});

test('roboflow view is served and requires authentication', async (t) => {
    const f = await startFixture();
    t.after(f.close);
    assert.equal((await fetch(`${f.baseUrl}/roboflow`)).status, 401);
    const page = await fetch(`${f.baseUrl}/roboflow`, { headers: { 'x-ploinky-auth-info': authHeader('user') } });
    assert.equal(page.status, 200);
    assert.match(await page.text(), /RoboFlow/);
});
