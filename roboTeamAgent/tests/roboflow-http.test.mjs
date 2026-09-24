import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createRoboTeamServer } from '../server/http-server.mjs';
import { RobotStore } from '../server/robot-store.mjs';
import { RoboFlowService } from '../server/roboflow/roboflow-service.mjs';
const graph = { id: 'example', name: 'Example', entryTaskId: 'one', tasks: [{ id: 'one', name: 'One', description: 'Execute objective', skillsets: [], executionType: 'terminal' }], edges: [] };
const headers = role => ({ 'content-type': 'application/json', 'x-ploinky-auth-info': JSON.stringify({ user: { id: 'actor', roles: [role] } }) });
async function fixture(t) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'roboflow-http-'));
    const robotStore = new RobotStore({ dataDir: path.join(root, 'data') }); await robotStore.initialize(); await robotStore.ensureDefaultRobot();
    const started = [];
    const runtimeManager = { workspaceRoot: root, status: () => ({ state: 'stopped' }), resolveCwd: async () => root,
        startTask(robot, type, request) { started.push({ robot, type, request }); return { taskId: request.runtimeTaskId, state: 'queued' }; },
        stopTask() {}, sendTaskMessage() { return { delivery: 'sent' }; },
        resumeTask(robot, taskId, prompt, options = {}) { return { taskId: options.runtimeTaskId, state: 'queued' }; }, activePort: () => null };
    const roboflow = new RoboFlowService({ robotStore, runtimeManager, databaseFile: path.join(root, 'roboflow.sqlite'), workflowsDirectory: path.join(root, 'old'), discoverSkillsets: async () => ({ skillsets: [], diagnostics: [] }) });
    await roboflow.initialize();
    const server = createRoboTeamServer({ robotStore, runtimeManager, roboflow, internalToken: 'test-token', publicBasePath: '/rt/' });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(async () => { await new Promise(resolve => server.close(resolve)); await roboflow.close(); await fs.rm(root, { recursive: true, force: true }); });
    const base = `http://127.0.0.1:${server.address().port}`;
    const request = (url, role = 'admin', body, method = body ? 'POST' : 'GET') => fetch(base + url, { method, headers: headers(role), ...(body ? { body: JSON.stringify(body) } : {}) });
    return { request, roboflow, started };
}
test('graph HTTP CRUD and coverage preserve administrator boundaries', async t => {
    const f = await fixture(t);
    assert.equal((await f.request('/api/roboflow/workflows', 'user', graph)).status, 403);
    assert.equal((await f.request('/api/roboflow/workflows', 'admin', graph)).status, 201);
    const { workflows } = await (await f.request('/api/roboflow/workflows', 'user')).json(); assert.equal(workflows.length, 2);
    assert.equal((await f.request('/api/roboflow/validate', 'user', graph)).status, 403);
    assert.equal((await f.request('/api/roboflow/generate', 'user', { description: 'Generate' })).status, 403);
    assert.equal((await f.request('/api/roboflow/validate', 'admin', graph)).status, 200);
    assert.equal((await f.request('/api/roboflow/skillsets')).status, 200);
    assert.equal((await f.request('/api/roboflow/workflows/default', 'admin', undefined, 'DELETE')).status, 409);
});
test('HTTP runs return task instances and project logs; retired execution controls are absent', async t => {
    const f = await fixture(t); await f.request('/api/roboflow/workflows', 'admin', graph);
    const response = await f.request('/api/roboflow/flows', 'user', { workflowTypeId: 'example', objective: 'Work' }); assert.equal(response.status, 201);
    const { flow } = await response.json(); const taskId = f.started[0].request.runtimeTaskId;
    f.roboflow.onRuntimeTaskEvent({ kind: 'progress', taskId, chunk: 'Task progress' });
    f.roboflow.onRuntimeTaskEvent({ kind: 'terminal', taskId, state: 'completed', result: 'Final response' });
    while (f.roboflow.chains.size) await Promise.allSettled(f.roboflow.chains.values());
    const result = await (await f.request(`/api/roboflow/flows/${flow.id}?logs=none`, 'user')).json(); assert.equal(result.flow.result, 'Final response');
    assert.equal(await (await f.request(`/api/roboflow/flows/${flow.id}/logs/${flow.instances[0].id}`)).text(), 'Task progress');
    assert.equal((await f.request(`/api/roboflow/flows/${flow.id}/launch`, 'user', { member: 'one' })).status, 404);
    assert.equal((await f.request('/api/roboflow/flows', 'user', { workflowTypeId: 'default', objective: 'Work' })).status, 400);
});
test('HTTP stops a single phase and stops the whole flow with it', async t => {
    const f = await fixture(t); await f.request('/api/roboflow/workflows', 'admin', graph);
    const { flow } = await (await f.request('/api/roboflow/flows', 'user', { workflowTypeId: 'example', objective: 'Work' })).json();
    const instanceId = flow.instances[0].id;
    const stopped = await f.request(`/api/roboflow/flows/${flow.id}/instances/${instanceId}/stop`, 'user', {});
    assert.equal(stopped.status, 200);
    const { flow: after } = await stopped.json();
    assert.equal(after.status, 'stopped');
    assert.equal(after.instances[0].state, 'stopped');
    assert.equal((await f.request(`/api/roboflow/flows/${flow.id}/instances/not-an-instance/stop`, 'user', {})).status, 404);
});
test('HTTP messages and continues a single phase', async t => {
    const f = await fixture(t); await f.request('/api/roboflow/workflows', 'admin', graph);
    const { flow } = await (await f.request('/api/roboflow/flows', 'user', { workflowTypeId: 'example', objective: 'Work' })).json();
    const instanceId = flow.instances[0].id;
    const message = await f.request(`/api/roboflow/flows/${flow.id}/instances/${instanceId}/message`, 'user', { prompt: 'go' });
    assert.equal(message.status, 200);
    assert.equal((await message.json()).delivery, 'sent');
    await f.request(`/api/roboflow/flows/${flow.id}/instances/${instanceId}/stop`, 'user', {});
    const resume = await f.request(`/api/roboflow/flows/${flow.id}/instances/${instanceId}/resume`, 'user', { prompt: 'again' });
    assert.equal(resume.status, 200);
    const { flow: after } = await resume.json();
    assert.equal(after.status, 'running');
    assert.equal((await f.request(`/api/roboflow/flows/${flow.id}/instances/not-an-instance/message`, 'user', { prompt: 'x' })).status, 404);
});
