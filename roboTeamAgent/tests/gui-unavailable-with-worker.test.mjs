import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { GUI_UNAVAILABLE_MESSAGE, GUI_UNAVAILABLE_WITH_WORKER, RuntimeManager } from '../server/runtime-manager.mjs';
import { createRoboTeamServer } from '../server/http-server.mjs';
import { RobotStore } from '../server/robot-store.mjs';
import { RoboFlowService } from '../server/roboflow/roboflow-service.mjs';
import { ToolCache } from '../server/tool-cache.mjs';
import { toolConfigFor, WORKER_HIDDEN_TOOLS } from '../server/mcp-tool-list.mjs';
import { authHeader, routerFetch } from './helpers/router-signed.mjs';

// Decision M-67: with the worker configured RoboTeam refuses Browser and Desktop work before any container of its own starts.
// These tests drive the real RuntimeManager with a recording container runner, through the HTTP surface and RoboFlow.
const MESSAGE = "Browser and Desktop robots aren't available with the worker yet";
const tools = { root: '/cache', prepareShellTools: async () => ({ root: '/cache', path: '/cache/s', binPath: '/cache/s/bin', agents: {} }),
    prepareMode: async (mode) => ({ path: `/cache/${mode}`, versions: {} }), prepareCodingAgents: async () => ({}) };

async function fixture(t, { workerMode }) {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'roboteam-m67-')));
    const workspaceRoot = path.join(root, 'workspace');
    await fs.mkdir(workspaceRoot);
    const previous = process.env.PLOINKY_WORKSPACE_ROOT;
    process.env.PLOINKY_WORKSPACE_ROOT = workspaceRoot;
    const robotStore = new RobotStore({ dataDir: path.join(root, 'private'), writesOldHome: !workerMode });
    await robotStore.initialize();
    const robot = await robotStore.ensureDefaultRobot();
    const containerCommands = [], spawned = [];
    const runtimeManager = new RuntimeManager({ workerMode, dataDir: path.join(root, 'private'), workspaceRoot, toolCache: tools,
        execFileImpl: async (command, args) => { containerCommands.push([command, ...args]); return { stdout: '', stderr: '' }; },
        spawnImpl: (...args) => { spawned.push(args); throw new Error('spawned'); } });
    const server = createRoboTeamServer({ robotStore, runtimeManager, internalToken: 'test-token', publicBasePath: '/rt/', mcpPort: 65534, workerMode });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    t.after(async () => {
        await new Promise((resolve) => server.close(resolve));
        await runtimeManager.stopAll();
        if (previous === undefined) delete process.env.PLOINKY_WORKSPACE_ROOT; else process.env.PLOINKY_WORKSPACE_ROOT = previous;
        await fs.rm(root, { recursive: true, force: true });
    });
    const base = `http://127.0.0.1:${server.address().port}`;
    const control = async (body) => {
        const response = await routerFetch(`${base}/api/control`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-roboteam-internal-token': 'test-token' }, body: JSON.stringify({ robotId: robot.id, ...body }) });
        return { status: response.status, body: await response.json().catch(() => ({})) };
    };
    const run = async (mode) => {
        const response = await routerFetch(`${base}/api/robots/${robot.id}/run`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-ploinky-auth-info': authHeader('admin-a', ['admin']) }, body: JSON.stringify({ mode }) });
        return { status: response.status, body: await response.json().catch(() => ({})) };
    };
    const list = async () => (await routerFetch(`${base}/api/robots`, { headers: { 'x-roboteam-internal-token': 'test-token', 'x-roboteam-listing-origin': 'agent' } })).json();
    return { control, run, list, robot, runtimeManager, containerCommands, spawned, workspaceRoot, root, robotStore };
}

test('with the worker the HTTP Browser and Desktop paths answer 409 with the code and message and start no container', async (t) => {
    const f = await fixture(t, { workerMode: true });
    const attempts = [
        ['open-desktop', () => f.control({ operation: 'open-desktop', cwd: f.workspaceRoot })],
        ['open-desktop without cwd', () => f.control({ operation: 'open-desktop' })],
        ['start-desktop-task', () => f.control({ operation: 'start-desktop-task', cwd: f.workspaceRoot, task: 'Look' })],
        ['start-browser-task', () => f.control({ operation: 'start-browser-task', cwd: f.workspaceRoot, task: 'Look' })],
        ['robot card Desktop', () => f.run('desktop')],
        ['robot card Browser', () => f.run('browser')],
    ];
    for (const [name, attempt] of attempts) {
        const { status, body } = await attempt();
        assert.equal(status, 409, name);
        assert.equal(body.error, MESSAGE, name);
        assert.equal(body.code, GUI_UNAVAILABLE_WITH_WORKER, name);
        assert.equal(body.code, 'gui_unavailable_with_worker');
    }
    assert.deepEqual(f.containerCommands, [], 'no container command ran');
    assert.deepEqual(f.spawned, []);
    assert.equal(f.runtimeManager.tasks.size, 0, 'no task record');
    assert.equal(f.runtimeManager.sessions.size, 0);
    assert.equal(f.runtimeManager.taskQueues.size, 0);
});

test('the robot listing tells the page that Browser and Desktop are unavailable only with the worker', async (t) => {
    const withWorker = await fixture(t, { workerMode: true });
    assert.deepEqual((await withWorker.list()).guiUnavailable, { code: 'gui_unavailable_with_worker', message: MESSAGE });
    const without = await fixture(t, { workerMode: false });
    assert.equal(Object.hasOwn(await without.list(), 'guiUnavailable'), false);
});

test('with the worker a resumed GUI task is refused with the code before anything is rewritten', async (t) => {
    const f = await fixture(t, { workerMode: true });
    const taskId = '11111111-1111-4111-8111-111111111111';
    f.runtimeManager.tasks.set(taskId, { taskId, robotId: f.robot.id, type: 'desktop', state: 'paused', alaSessionId: '22222222-2222-4222-8222-222222222222', request: { task: 'x', skillSelection: ['bash'] } });
    const { status, body } = await f.control({ operation: 'resume-task', taskId, prompt: 'again' });
    assert.equal(status, 409);
    assert.equal(body.code, GUI_UNAVAILABLE_WITH_WORKER);
    assert.equal(body.error, MESSAGE);
    assert.deepEqual(f.runtimeManager.tasks.get(taskId).request, { task: 'x', skillSelection: ['bash'] });
    assert.equal(f.runtimeManager.tasks.size, 1);
    assert.deepEqual(f.containerCommands, []);
});

async function flowService(t, f, options = {}) {
    const robots = [{ id: 'default-id', name: 'default', codingAgents: ['codex'] }];
    const robotStore = { list: async () => robots, getByName: async (name) => robots.find((robot) => robot.name === name), get: async (id) => robots.find((robot) => robot.id === id) };
    const service = new RoboFlowService({ robotStore, runtimeManager: f.runtimeManager, workerMode: true,
        skillsets: { repositoriesClient: { listRepositories: async () => [{ name: 'DocumentationSkills', source: f.root, origin: 'local' }] }, start: async (robot, input, enqueue) => enqueue(robot) },
        databaseFile: path.join(f.root, 'roboflow.sqlite'), workflowsDirectory: path.join(f.root, 'old'), random: () => 0,
        discoverSkillsets: async () => ({ skillsets: [], diagnostics: [] }), ...options });
    await service.initialize();
    await service.presetReady;
    t.after(() => service.close());
    return service;
}

test('with the worker a default flow or a schedule with Browser or Desktop is refused at start and save, and Terminal still works', async (t) => {
    const f = await fixture(t, { workerMode: true });
    const service = await flowService(t, f);
    const refused = (error) => error.code === GUI_UNAVAILABLE_WITH_WORKER && error.statusCode === 409 && error.message === MESSAGE;
    const before = (await service.listFlows?.())?.length;
    for (const executionType of ['desktop', 'browser']) {
        await assert.rejects(service.startFlow({ workflowTypeId: 'default', objective: 'Work', executionType, folder: f.workspaceRoot }), refused, `flow ${executionType}`);
        await assert.rejects(service.saveSchedule({ workflowTypeId: 'default', folder: f.workspaceRoot, objective: 'Work', executionType,
            timing: { kind: 'interval', everyMinutes: 60 } }, 'admin'), refused, `schedule ${executionType}`);
    }
    assert.equal(service.schedulesList ? service.schedulesList().length : service.schedules.listSync().length, 0, 'nothing was stored');
    assert.equal((await service.listFlows?.())?.length, before, 'no flow was created');
    const saved = await service.saveSchedule({ workflowTypeId: 'default', folder: f.workspaceRoot, objective: 'Work', executionType: 'terminal',
        timing: { kind: 'interval', everyMinutes: 60 } }, 'admin');
    assert.equal(saved.executionType, 'terminal');
    // An update of that schedule to a GUI mode is refused too.
    await assert.rejects(service.saveSchedule({ revision: saved.revision, executionType: 'desktop' }, 'admin', saved.id), refused, 'update');
    assert.equal(service.schedules.getSync(saved.id).executionType, 'terminal');
    // A schedule saved disabled is accepted, so a leftover GUI schedule can still be paused with its definition kept.
    const paused = await service.saveSchedule({ revision: service.schedules.getSync(saved.id).revision, executionType: 'desktop', enabled: false }, 'admin', saved.id);
    assert.equal(paused.executionType, 'desktop');
    assert.equal(paused.enabled, false);
    await assert.rejects(service.saveSchedule({ revision: paused.revision, enabled: true }, 'admin', saved.id), refused, 'enabling it again is refused');
});

test('without the worker a default GUI flow and schedule are not refused by M-67', async (t) => {
    const f = await fixture(t, { workerMode: false });
    const service = await flowService(t, f, { workerMode: false });
    const saved = await service.saveSchedule({ workflowTypeId: 'default', folder: f.workspaceRoot, objective: 'Work', executionType: 'desktop',
        timing: { kind: 'interval', everyMinutes: 60 } }, 'admin');
    assert.equal(saved.executionType, 'desktop');
});

test('a custom graph node that declares Browser or Desktop fails its flow at the phase with the message and starts no container', async (t) => {
    const f = await fixture(t, { workerMode: true });
    const service = await flowService(t, f);
    for (const executionType of ['desktop', 'browser']) {
        const id = `gui-${executionType}`;
        await service.createWorkflow({ id, name: id, description: 'GUI node', entryTaskId: 'a', edges: [],
            tasks: [{ id: 'a', name: 'a', prompt: 'Execute a', executionType, skillsets: [] }] });
        const started = await service.startFlow({ workflowTypeId: id, objective: 'Work', folder: f.workspaceRoot });
        while (service.chains.size) await Promise.allSettled(service.chains.values());
        const flow = await service.getFlow(started.id);
        assert.equal(flow.status, 'failed', executionType);
        assert.equal(flow.error, MESSAGE, executionType);
    }
    assert.deepEqual([...f.runtimeManager.tasks.values()].filter((task) => ['desktop', 'browser'].includes(task.type)), [], 'no GUI task record');
    assert.equal(f.runtimeManager.sessions.size, 0);
    assert.deepEqual(f.containerCommands, []);
});

test('the HTTP GUI guard runs before the owner-grant check and before any skill policy is written', async (t) => {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'roboteam-m67-grant-')));
    const workspaceRoot = path.join(root, 'workspace');
    await fs.mkdir(workspaceRoot);
    const previous = process.env.PLOINKY_WORKSPACE_ROOT;
    process.env.PLOINKY_WORKSPACE_ROOT = workspaceRoot;
    const robotStore = new RobotStore({ dataDir: path.join(root, 'private'), writesOldHome: false });
    await robotStore.initialize();
    const robot = await robotStore.ensureDefaultRobot();
    const commands = [], starts = [];
    const runtimeManager = new RuntimeManager({ workerMode: true, dataDir: path.join(root, 'private'), workspaceRoot, toolCache: tools,
        execFileImpl: async (...args) => { commands.push(args); return { stdout: '', stderr: '' }; } });
    // Worker enabled (a coordinator hop is present) and the control request carries no Router-minted grant.
    const server = createRoboTeamServer({ robotStore, runtimeManager, internalToken: 'test-token', publicBasePath: '/rt/', mcpPort: 65534, workerMode: true,
        workerCoordinator: { hop: { call: async () => ({ outcome: 'response', status: 200, json: {}, refusal: null }) } },
        skillsets: { start: async (...args) => { starts.push(args); throw new Error('skillsets.start must not run'); } } });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    t.after(async () => { await new Promise((resolve) => server.close(resolve)); if (previous === undefined) delete process.env.PLOINKY_WORKSPACE_ROOT; else process.env.PLOINKY_WORKSPACE_ROOT = previous; await fs.rm(root, { recursive: true, force: true }); });
    const base = `http://127.0.0.1:${server.address().port}`;
    const post = async (body) => {
        const response = await routerFetch(`${base}/api/control`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-roboteam-internal-token': 'test-token' }, body: JSON.stringify({ robotId: robot.id, ...body }) });
        return { status: response.status, body: await response.json().catch(() => ({})) };
    };
    for (const operation of ['start-browser-task', 'start-desktop-task']) {
        const result = await post({ operation, cwd: workspaceRoot, task: 'Look' });
        assert.equal(result.status, 409, operation);
        assert.equal(result.body.code, GUI_UNAVAILABLE_WITH_WORKER, operation);
    }
    // The same request for a Terminal task is not exempt from the grant check, which is the 403 the GUI guard precedes.
    const simple = await post({ operation: 'start-simple-task', cwd: workspaceRoot, task: 'Look' });
    assert.equal(simple.status, 403);
    assert.equal(starts.length, 0, 'skillsets.start never ran');
    assert.deepEqual(commands, []);
});

test('the worker-mode MCP tool list hides every Browser and Desktop tool and keeps the others', async () => {
    const config = JSON.parse(await fs.readFile(new URL('../mcp-config.json', import.meta.url), 'utf8'));
    const names = (value) => value.tools.map((tool) => tool.name);
    const gui = ['openDesktopForRobot', 'startDesktopTaskForRobot', 'stopDesktopTaskForRobot', 'startBrowserTaskForRobot', 'stopBrowserTaskForRobot',
        'getSessionUrlForRobotDesktop', 'getSessionUrlForRobotBrowser', 'stopDesktopContainerForRobot', 'stopBrowserContainerForRobot'];
    for (const name of gui) { assert.ok(names(config).includes(name), `${name} exists`); assert.ok(WORKER_HIDDEN_TOOLS.includes(name), name); }
    assert.deepEqual(toolConfigFor(config, { workerMode: false }), config);
    const worker = names(toolConfigFor(config, { workerMode: true }));
    for (const name of gui) assert.equal(worker.includes(name), false, name);
    for (const keep of ['startSimpleALATaskForRobot', 'stopSimpleALATaskForRobot', 'resumeTaskForRobot', 'getTaskStatusForRobot', 'sendMessageToRobotTask']) assert.ok(worker.includes(keep), keep);
});

test('the tool-cache warmup prepares only the shell family with the worker and all three otherwise', async () => {
    for (const [workerMode, expected] of [[true, ['shell']], [false, ['shell', 'desktop', 'browser']]]) {
        const prepared = [];
        const cache = new ToolCache({ workerMode, log: () => {} });
        cache.prepareShellTools = async () => { prepared.push('shell'); return {}; };
        cache.prepareMode = async (mode) => { prepared.push(mode); return {}; };
        const results = await cache.warmup();
        assert.deepEqual(prepared, expected, `workerMode ${workerMode}`);
        assert.equal(results.length, expected.length);
    }
    const manager = new RuntimeManager({ workerMode: true, toolCache: undefined, dataDir: '/nonexistent-m67', workspaceRoot: '/nonexistent-m67' });
    assert.equal(manager.toolCache.workerMode, true, 'the runtime manager builds its cache in worker mode');
});
