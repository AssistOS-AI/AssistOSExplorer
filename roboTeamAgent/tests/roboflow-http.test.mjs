import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createRoboTeamServer } from '../server/http-server.mjs';
import { RobotStore } from '../server/robot-store.mjs';
import { RoboFlowService } from '../server/roboflow/roboflow-service.mjs';
import { authHeader, routerFetch as fetch } from './helpers/router-signed.mjs';
const graph = { id: 'example', name: 'Example', entryTaskId: 'one', tasks: [{ id: 'one', name: 'One', prompt: 'Execute objective', skillsets: [], executionType: 'terminal' }], edges: [] };
const headers = role => ({ 'content-type': 'application/json', 'x-ploinky-auth-info': authHeader('actor', [role]) });
async function fixture(t) {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'roboflow-http-')));
    const robotStore = new RobotStore({ dataDir: path.join(root, 'data') }); await robotStore.initialize(); await robotStore.ensureDefaultRobot();
    const started = [];
    const runtimeManager = { workspaceRoot: root, status: () => ({ state: 'stopped' }), resolveCwd: async () => root,
        startTask(robot, type, request) { started.push({ robot, type, request }); return { taskId: request.runtimeTaskId, state: 'queued' }; },
        stopTask() {}, sendTaskMessage() { return { delivery: 'sent' }; },
        resumeTask(robot, taskId, prompt, options = {}) { return { taskId: options.runtimeTaskId, state: 'queued' }; }, activePort: () => null };
    const roboflow = new RoboFlowService({ robotStore, runtimeManager, skillsets: { repositoriesClient: { listRepositories: async () => [{ name: 'DocumentationSkills', source: root, origin: 'local' }] }, start: async (robot, input, enqueue) => enqueue(robot) }, databaseFile: path.join(root, 'roboflow.sqlite'), workflowsDirectory: path.join(root, 'old'), discoverSkillsets: async () => ({ skillsets: [], diagnostics: [] }) });
    await roboflow.initialize();
    const server = createRoboTeamServer({ robotStore, runtimeManager, roboflow, internalToken: 'test-token', publicBasePath: '/rt/' });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(async () => { await new Promise(resolve => server.close(resolve)); await roboflow.close(); await fs.rm(root, { recursive: true, force: true }); });
    const base = `http://127.0.0.1:${server.address().port}`;
    const request = (url, role = 'admin', body, method = body ? 'POST' : 'GET') => fetch(base + url, { method, headers: headers(role), ...(body ? { body: JSON.stringify(body) } : {}) });
    return { request, roboflow, started, base, root };
}
test('schedule folder HTTP picker is administrator-only, read-only on browse and creates confined folders', async t => {
    const f = await fixture(t), route = '/api/roboflow/schedule-folders';
    assert.equal((await fetch(f.base + route)).status, 401);
    assert.equal((await f.request(route, 'user')).status, 403);
    assert.equal((await f.request(route, 'user', { name: 'Reports' })).status, 403);
    const listing = await (await f.request(route)).json();
    await assert.rejects(fs.stat(listing.defaultFolder), { code: 'ENOENT' });
    const response = await f.request(route, 'admin', { parent: '', name: 'Daily reports' });
    assert.equal(response.status, 201); assert.equal((await response.json()).path, 'Daily reports');
    assert.equal((await f.request(route + '?path=Daily%20reports')).status, 200);
    assert.equal((await f.request(route, 'admin', { name: 'Daily reports' })).status, 409);
    assert.equal((await f.request(route + '?path=..%2Foutside')).status, 400);
    assert.equal((await f.request(route, 'admin', { parent: '/tmp', name: 'No' })).status, 400);
    assert.equal((await f.request('/schedule-folder-picker.js', 'user')).status, 200);
    assert.equal((await fetch(f.base + '/schedule-folder-picker.js')).status, 401);
});
test('saving a job without a folder creates the workspace default and keeps it on later edits', async t => {
    const f = await fixture(t);
    const input = { name: 'Default results', workflowTypeId: 'default', objective: 'Write a report', executionType: 'terminal', timing: { kind: 'interval', everyMinutes: 60 } };
    assert.equal((await f.request('/api/roboflow/schedules', 'admin', { ...input, workflowTypeId: 'missing' })).status, 400);
    await assert.rejects(fs.stat(path.join(f.root, 'cron-jobs-results')), { code: 'ENOENT' });
    const response = await f.request('/api/roboflow/schedules', 'admin', input); assert.equal(response.status, 201);
    const { schedule } = await response.json();
    assert.equal(schedule.folder, await fs.realpath(path.join(f.root, 'cron-jobs-results')));
    assert.equal(schedule.folderLabel, 'Workspace / cron-jobs-results');
    // The fixture runtime normally maps every input to root; use its real path contract here.
    f.roboflow.runtimeManager.resolveCwd = folder => fs.realpath(folder);
    const edited = await f.request(`/api/roboflow/schedules/${schedule.id}`, 'admin', { revision: schedule.revision, name: 'Renamed' }, 'PUT');
    assert.equal((await edited.json()).schedule.folder, schedule.folder);
    await f.request('/api/roboflow/schedule-folders', 'admin', { name: 'Reports' });
    const selected = await f.request(`/api/roboflow/schedules/${schedule.id}`, 'admin', { revision: 2, folder: path.join(f.root, 'Reports') }, 'PUT');
    assert.equal((await selected.json()).schedule.folderLabel, 'Workspace / Reports');
    const reset = await f.request(`/api/roboflow/schedules/${schedule.id}`, 'admin', { revision: 3, folder: '' }, 'PUT');
    assert.equal((await reset.json()).schedule.folder, schedule.folder);
});
test('Cron job HTTP CRUD requires administrators and uses optimistic revisions', async t => {
    const f = await fixture(t);
    const input = { name: 'Scheduled default', workflowTypeId: 'default', objective: 'Write a report', folder: '/workspace/project', executionType: 'terminal', timing: { kind: 'interval', everyMinutes: 60 }, enabled: false, createdBy: 'spoofed' };
    assert.equal((await f.request('/api/roboflow/schedules', 'user', input)).status, 403);
    assert.equal((await fetch(f.base + '/api/roboflow/schedules')).status, 401);
    const response = await f.request('/api/roboflow/schedules', 'admin', input); assert.equal(response.status, 201);
    const { schedule } = await response.json(); assert.equal(schedule.createdBy, 'actor'); assert.equal(schedule.nextRunAt, null); assert.equal(schedule.pendingLaunch, undefined);
    assert.equal((await f.request(`/api/roboflow/schedules/${schedule.id}`, 'user', { revision: 1, enabled: true }, 'PUT')).status, 403);
    const updated = await f.request(`/api/roboflow/schedules/${schedule.id}`, 'admin', { revision: 1, enabled: true }, 'PUT'); assert.equal(updated.status, 200);
    assert.equal((await updated.json()).schedule.revision, 2);
    assert.equal((await f.request(`/api/roboflow/schedules/${schedule.id}`, 'admin', { revision: 1, enabled: false }, 'PUT')).status, 409);
    assert.equal((await f.request('/api/roboflow/schedules', 'user')).status, 200);
    assert.equal((await f.request(`/api/roboflow/schedules/${schedule.id}`, 'user', undefined, 'DELETE')).status, 403);
    assert.equal((await f.request(`/api/roboflow/schedules/${schedule.id}`, 'admin', undefined, 'DELETE')).status, 200);
    assert.equal((await f.request(`/api/roboflow/schedules/${schedule.id}`, 'admin', undefined, 'DELETE')).status, 404);
});
test('HTTP workflows and Cron jobs inherit saved objectives while generic workflows still require one', async t => {
    const f = await fixture(t);
    const definition = { ...graph, description: 'Produce the daily report', defaultObjective: 'Produce the daily report with source links' };
    assert.equal((await f.request('/api/roboflow/workflows', 'admin', definition)).status, 201);
    const response = await f.request('/api/roboflow/flows', 'user', { workflowTypeId: 'example' }); assert.equal(response.status, 201);
    assert.equal((await response.json()).flow.objective, definition.defaultObjective);
    const input = { name: 'Inherited objective', workflowTypeId: 'example', timing: { kind: 'interval', everyMinutes: 60 } };
    const created = await f.request('/api/roboflow/schedules', 'admin', input); assert.equal(created.status, 201);
    const job = (await created.json()).schedule; assert.equal(job.objective, '');
    assert.equal((await f.request('/api/roboflow/flows', 'user', { workflowTypeId: 'default', executionType: 'terminal' })).status, 400);
    assert.equal((await f.request('/api/roboflow/schedules', 'admin', { ...input, workflowTypeId: 'code-development' })).status, 400);
    const tools = JSON.parse(await fs.readFile(new URL('../mcp-config.json', import.meta.url), 'utf8'));
    assert.ok(JSON.stringify(tools).includes('"objective":{"type":"string","minLength":1,"maxLength":32768,"optional":true}'));
});
test('scheduled HTTP runs use ordinary RoboFlow launch, history and actor identity', async t => {
    const f = await fixture(t);
    const { schedule } = await (await f.request('/api/roboflow/schedules', 'admin', { name: 'Report', workflowTypeId: 'default', objective: 'Write a report', folder: '/workspace/project', executionType: 'terminal', timing: { kind: 'interval', everyMinutes: 1 } })).json();
    const record = f.roboflow.schedules.getSync(schedule.id); record.nextRunAt = new Date(Date.now() - 1000).toISOString(); f.roboflow.schedules.saveSync(record);
    f.roboflow.scheduler.start(); await f.roboflow.scheduler.tick();
    const { schedules } = await (await f.request('/api/roboflow/schedules', 'user')).json();
    assert.equal(schedules[0].lastOutcome, 'started'); assert.equal(f.started.length, 1);
    const { flow } = await (await f.request(`/api/roboflow/flows/${schedules[0].lastFlowId}?logs=none`, 'user')).json();
    assert.equal(flow.scheduleId, schedule.id); assert.equal(flow.createdBy, 'actor'); assert.equal(flow.objective, 'Write a report');
    assert.equal((await f.request('/cron-jobs.js', 'user')).status, 200); assert.equal((await fetch(f.base + '/cron-jobs.js')).status, 401);
});
test('Run now HTTP requires an administrator and revision, launches once and resets scheduling', async t => {
    const f = await fixture(t); f.roboflow.scheduler.start();
    const { schedule } = await (await f.request('/api/roboflow/schedules', 'admin', {
        name: 'Manual report', workflowTypeId: 'default', objective: 'Write a report', executionType: 'terminal',
        timing: { kind: 'interval', everyMinutes: 60 }, enabled: false,
    })).json();
    const route = `/api/roboflow/schedules/${schedule.id}/run-now`;
    assert.equal((await fetch(f.base + route, { method: 'POST' })).status, 401);
    assert.equal((await f.request(route, 'user', { revision: 1 })).status, 403);
    assert.equal((await f.request(route, 'admin', {})).status, 400);
    assert.equal((await fetch(f.base + route, { method: 'POST', headers: headers('admin'), body: 'null' })).status, 400);
    assert.equal((await f.request(route, 'admin', { revision: 0 })).status, 409);
    assert.equal(f.started.length, 0);
    const response = await f.request(route, 'admin', { revision: 1, createdBy: 'spoofed' });
    assert.equal(response.status, 200); const result = await response.json();
    assert.equal(result.flow.createdBy, 'actor'); assert.equal(result.flow.scheduleId, schedule.id);
    assert.equal(result.schedule.nextRunAt, null); assert.equal(result.schedule.enabled, false);
    assert.equal(result.schedule.revision, 2); assert.equal(result.schedule.lastFlowId, result.flow.id);
    assert.equal(f.started.length, 1);
    assert.equal((await f.request(route, 'admin', { revision: 2 })).status, 409);
    const missing = '/api/roboflow/schedules/cron_000000000000000000000000/run-now';
    assert.equal((await f.request(missing, 'admin', { revision: 1 })).status, 404);
    await f.roboflow.store.update(result.flow.id, record => { record.status = 'completed'; });
    const enabled = (await (await f.request(`/api/roboflow/schedules/${schedule.id}`, 'admin', { revision: 2, enabled: true }, 'PUT')).json()).schedule;
    const before = Date.now();
    const second = await (await f.request(route, 'admin', { revision: enabled.revision })).json();
    assert.ok(Date.parse(second.schedule.nextRunAt) >= before + 3600000);
    assert.ok(Date.parse(second.schedule.nextRunAt) <= Date.now() + 3600000);
    assert.equal(f.started.length, 2);
});
test('Cron job HTTP validation rejects malformed schedules, missing workflows and extraneous modes', async t => {
    const f = await fixture(t); await f.request('/api/roboflow/workflows', 'admin', graph);
    const input = { name: 'Report', workflowTypeId: 'example', objective: 'Write a report', folder: '/workspace/project', timing: { kind: 'daily', times: ['09:00'], timeZone: 'Europe/Bucharest' } };
    for (const extra of [{ workflowTypeId: 'missing' }, { executionType: 'terminal' }, { enabled: 'true' }, { timing: { kind: 'daily', times: ['24:00'], timeZone: 'UTC' } }, { timing: { kind: 'interval', everyMinutes: 0 } }]) assert.equal((await f.request('/api/roboflow/schedules', 'admin', { ...input, ...extra })).status, 400);
    assert.equal((await f.request('/api/roboflow/schedules', 'admin', input)).status, 201);
    assert.equal((await f.request('/api/roboflow/workflows/example', 'admin', undefined, 'DELETE')).status, 409);
});
test('graph HTTP CRUD and coverage preserve administrator boundaries', async t => {
    const f = await fixture(t);
    assert.equal((await f.request('/api/roboflow/workflows', 'user', graph)).status, 403);
    assert.equal((await f.request('/api/roboflow/workflows', 'admin', graph)).status, 201);
    const { workflows } = await (await f.request('/api/roboflow/workflows', 'user')).json(); assert.equal(workflows.length, 3);
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

test('human-report HTTP view excludes routing fields while debug output retains the entire final response', async t => {
    const f = await fixture(t);
    await f.roboflow.createWorkflow({ ...graph,
        tasks: [graph.tasks[0], { ...graph.tasks[0], id: 'done', name: 'Done' }],
        edges: [{ id: 'go', sourceTaskId: 'one', targetTaskId: 'done' }, { id: 'retry', sourceTaskId: 'one', targetTaskId: 'one' }] });
    const flow = await f.roboflow.startFlow({ workflowTypeId: 'example', objective: 'Work' });
    const taskId = f.started[0].request.runtimeTaskId;
    const report = 'Am verificat interfața și totul funcționează.';
    const result = `<<human-report>>\n${report}\n<<human-report>>\n\n# nextEdgeId\ngo`;
    f.roboflow.onRuntimeTaskEvent({ kind: 'progress', taskId, chunk: result, outputKind: 'assistant', outputComplete: true, outputId: 'final' });
    f.roboflow.onRuntimeTaskEvent({ kind: 'terminal', taskId, state: 'completed', result });
    while (f.roboflow.chains.size) await Promise.allSettled(f.roboflow.chains.values());
    const { summaries } = await (await f.request(`/api/summary?flow=${flow.id}&instance=${flow.instances[0].id}`, 'user')).json();
    assert.deepEqual(summaries, [{ text: report }]);
    const debug = await (await f.request(`/api/roboflow/flows/${flow.id}/logs/${flow.instances[0].id}`, 'user')).text();
    assert.ok(debug.includes(result));
    const { flow: view } = await (await f.request(`/api/roboflow/flows/${flow.id}?logs=none`, 'user')).json();
    assert.equal(view.instances[0].finalResponse, result);
    assert.equal(JSON.parse(f.started[1].request.task).previousFinalResponses[0].response, '# nextEdgeId\ngo');
    assert.ok(!f.started[1].request.task.includes(report));
    assert.ok(!Object.hasOwn(JSON.parse(f.started[1].request.task).previousFinalResponses[0], 'humanReport'));
});
test('HTTP stops a single phase and stops the whole flow with it', async t => {
    const f = await fixture(t); await f.request('/api/roboflow/workflows', 'admin', graph);
    const { flow } = await (await f.request('/api/roboflow/flows', 'user', { workflowTypeId: 'example', objective: 'Work' })).json();
    const instanceId = flow.instances[0].id;
    const paused = await f.request(`/api/roboflow/flows/${flow.id}/instances/${instanceId}/pause`, 'user', {});
    assert.equal(paused.status, 200);
    const { flow: after } = await paused.json();
    assert.equal(after.status, 'paused');
    assert.equal(after.instances[0].state, 'paused');
    assert.equal((await f.request(`/api/roboflow/flows/${flow.id}/instances/not-an-instance/pause`, 'user', {})).status, 404);
});
test('HTTP messages and continues a single phase', async t => {    const f = await fixture(t); await f.request('/api/roboflow/workflows', 'admin', graph);
    const { flow } = await (await f.request('/api/roboflow/flows', 'user', { workflowTypeId: 'example', objective: 'Work' })).json();
    const instanceId = flow.instances[0].id;
    const message = await f.request(`/api/roboflow/flows/${flow.id}/instances/${instanceId}/message`, 'user', { prompt: 'go' });
    assert.equal(message.status, 200);
    assert.equal((await message.json()).delivery, 'sent');
    await f.request(`/api/roboflow/flows/${flow.id}/instances/${instanceId}/pause`, 'user', {});
    const resume = await f.request(`/api/roboflow/flows/${flow.id}/instances/${instanceId}/resume`, 'user', { prompt: 'again' });
    assert.equal(resume.status, 200);
    const { flow: after } = await resume.json();
    assert.equal(after.status, 'running');
    assert.equal((await f.request(`/api/roboflow/flows/${flow.id}/instances/not-an-instance/message`, 'user', { prompt: 'x' })).status, 404);
});
test('HTTP async generation starts, streams logs and cancels', async t => {
    const f = await fixture(t);
    assert.equal((await f.request('/api/roboflow/generations', 'user', { description: 'Make a graph' })).status, 403);
    const startedResponse = await f.request('/api/roboflow/generations', 'admin', { description: 'Make a graph' });
    assert.equal(startedResponse.status, 202);
    const { id } = await startedResponse.json();
    while (!f.started.length) await new Promise(resolve => setImmediate(resolve));
    f.roboflow.runtimeManager.taskStatus = () => ({ logTail: 'line one' });
    const running = await (await f.request(`/api/roboflow/generations/${id}`, 'user')).json();
    assert.equal(running.status, 'running');
    assert.equal(running.log, 'line one');
    assert.equal((await f.request(`/api/roboflow/generations/${id}`, 'admin', undefined, 'DELETE')).status, 200);
    assert.equal((await f.request(`/api/roboflow/generations/${id}`, 'user')).status, 404);
});

test('HTTP description revision retains admin checks and exposes a non-regeneration decision', async t => {
    const f = await fixture(t);
    const body = { workflow: graph, previousDescription: 'Write a report', description: 'Write a repport' };
    assert.equal((await f.request('/api/roboflow/generations', 'user', body)).status, 403);
    const started = await f.request('/api/roboflow/generations', 'admin', body);
    assert.equal(started.status, 202);
    const { id } = await started.json();
    while (!f.started.length) await new Promise(resolve => setImmediate(resolve));
    f.roboflow.onRuntimeTaskEvent({ kind: 'terminal', taskId: f.started[0].request.runtimeTaskId,
        state: 'completed', result: '# regenerate\nfalse\n# reason\nTypo only' });
    while (f.roboflow.generationTasks.get(id).status === 'running') await new Promise(resolve => setImmediate(resolve));
    const result = await (await f.request(`/api/roboflow/generations/${id}`, 'admin')).json();
    assert.equal(result.regenerate, false); assert.equal(result.graph, null); assert.equal(result.reason, 'Typo only');
    assert.equal(await f.roboflow.registry.get('example'), null);
    const asset = await f.request('/workflow-description-revision.js');
    assert.equal(asset.status, 200); assert.match(await asset.text(), /createDescriptionRevision/);
});

test('human-input answer route requires authentication and resumes with a validated choice', async t => {
    const f = await fixture(t);
    await f.request('/api/roboflow/workflows', 'admin', { ...graph, tasks: [{ ...graph.tasks[0], allowsHumanInput: true }] });
    const { flow } = await (await f.request('/api/roboflow/flows', 'user', { workflowTypeId: 'example', objective: 'Work' })).json();
    const taskId = f.started[0].request.runtimeTaskId;
    const question = await f.roboflow.requestHumanInput(taskId, { question: 'Q?', options: ['A', 'B', 'C'] });
    f.roboflow.onRuntimeTaskEvent({ kind: 'terminal', taskId, state: 'completed', result: 'Waiting' });
    while (f.roboflow.chains.size) await Promise.allSettled(f.roboflow.chains.values());
    const endpoint = `/api/roboflow/flows/${flow.id}/human-input/answer`;
    assert.equal((await fetch(f.base + endpoint, { method: 'POST', body: '{}' })).status, 401);
    const response = await f.request(endpoint, 'user', { requestId: question.id, option: 4 });
    assert.equal(response.status, 400);
    const answered = await f.request(endpoint, 'user', { requestId: question.id, option: 1 });
    assert.equal(answered.status, 200);
    assert.equal((await answered.json()).flow.humanInput.answer, 'B');
    assert.equal((await f.request(endpoint, 'user', { requestId: question.id, option: 0 })).status, 409);
});

test('HTTP termination blocks workflow and phase continuation', async t => {
    const f = await fixture(t); await f.request('/api/roboflow/workflows', 'admin', graph);
    const { flow } = await (await f.request('/api/roboflow/flows', 'user', { workflowTypeId: 'example', objective: 'Work' })).json();
    const response = await f.request(`/api/roboflow/flows/${flow.id}/terminate`, 'user', {});
    assert.equal(response.status, 200);
    assert.equal((await response.json()).flow.status, 'terminated');
    assert.equal((await f.request(`/api/roboflow/flows/${flow.id}/resume`, 'user', {})).status, 400);
    assert.equal((await f.request(`/api/roboflow/flows/${flow.id}/instances/${flow.instances[0].id}/resume`, 'user', { prompt: 'Continue' })).status, 400);
});
