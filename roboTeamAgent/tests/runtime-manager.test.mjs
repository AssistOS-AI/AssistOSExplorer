import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
// Tests explicitly provision the workspace normally supplied by Ploinky.
process.env.PLOINKY_WORKSPACE_ROOT = os.tmpdir();
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import { RuntimeManager as RemoteRuntimeManager, runtimeManagerInternals } from '../server/runtime-manager.mjs';
import { DESKTOP_TASK_INSTRUCTIONS } from '../copilot/src/lib/prompts.mjs';
import { emailInstructions } from '../server/robot-email.mjs';
import { RoboWorkClient, spawnRoboWorkRun } from '../server/run-client.mjs';
import { createPloinkyTaskContext } from '../copilot/src/lib/ploinky/ploinkyTaskContext.mjs';

const preparedToolCache = {
    root: '/cache',
    prepareShellTools: async (names = ['codex', 'opencode', 'pi']) => ({ root: '/cache', path: '/cache/shell-generations/test',
        binPath: '/cache/shell-generations/test/bin', agents: Object.fromEntries(names.map(name => [name, { path: `/cache/${name}`, binPath: `/cache/${name}/bin` }])) }),
    prepareMode: async (mode) => ({ path: `/cache/${mode}`, versions: {} }),
    prepareCodex: async () => ({ path: '/cache/codex', binPath: '/cache/codex/bin', versions: {} }),
    prepareCodingAgents: async (names = ['codex', 'opencode', 'pi']) => Object.fromEntries(names.map((name) => [name, {
        path: `/cache/${name}`,
        binPath: `/cache/${name}/bin`,
        versions: {},
    }])),
};


class RuntimeManager extends RemoteRuntimeManager {
    constructor(options = {}) {
        super({ roboWork: { call: async (tool) => tool === 'run_list' ? [] : tool === 'robot_status' ? { robots: [] } : {} }, ...options });
    }
}

test('run client drains base64 output, preserves last-sequence cursor and relays callback replies once', async () => {
    const calls = [], waits = [];
    let reads = 0, callbackCount = 0;
    const client = { call: async (tool, input) => {
        calls.push({ tool, input });
        if (tool !== 'run_read') return { ok: true };
        reads++;
        return { state: 'exited', exit: { code: 0 }, next: 1,
            records: reads === 1 ? [{ seq: 1, stream: 'stdout', data: Buffer.from('answer').toString('base64') }] : [],
            callbacks: reads === 1 ? [{ id: 'callback-one', channel: 'ploinky-runtime', path: '/agent-call', body: {} }] : [] };
    } };
    const child = await spawnRoboWorkRun({ client, input: { runId: 'run-one' }, wait: async ms => { waits.push(ms); await new Promise(setImmediate); },
        onCallback: async () => { callbackCount++; return { answer: true }; } });
    let output = '';
    child.stdout.on('data', chunk => { output += chunk; });
    child.stdin.write('control\n');
    const closed = new Promise(resolve => child.once('close', resolve));
    assert.equal(await closed, 0);
    assert.equal(output, 'answer');
    assert.equal(callbackCount, 1);
    assert.deepEqual(calls.filter(call => call.tool === 'run_read').map(call => [call.input.after, call.input.waitMs]), [[0, 100], [1, 100]]);
    assert.equal(calls.find(call => call.input.data)?.input.data, Buffer.from('control\n').toString('base64'));
    assert.deepEqual(calls.find(call => call.input.reply)?.input.reply, { id: 'callback-one', status: 200, body: { answer: true } });
    assert.deepEqual(waits, [100]);
});

test('attached runs replay without starting or sending prompt and disconnect never stops the run', async () => {
    const calls = [], waits = [];
    let child;
    child = await spawnRoboWorkRun({ client: { call: async (tool, input) => {
        calls.push({ tool, input });
        return { state: 'running', records: [], callbacks: [] };
    } }, input: { runId: 'existing' }, attach: true, wait: async ms => {
        waits.push(ms); if (ms >= 2000) child.disconnect();
    } });
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(calls.every(call => call.tool === 'run_read'), true);
    assert.equal(waits.at(-1), 2000);
    assert.ok(waits[0] >= 100 && waits[0] <= 250);
    assert.equal(child.kill(), false);
});

test('MCP client never falls back locally when RoboWork refuses a call', async () => {
    const calls = [];
    const client = new RoboWorkClient({ createClient: async agent => ({ callTool: async (...args) => {
        calls.push({ agent, args }); return { isError: true, code: 'RUN_UNKNOWN', message: 'Unknown run' };
    } }) });
    await assert.rejects(client.call('run_read', { runId: 'absent' }, { timeoutMs: 123 }), { code: 'RUN_UNKNOWN' });
    assert.deepEqual(calls, [{ agent: 'roboWorkAgent', args: ['run_read', { runId: 'absent' }, { timeoutMs: 123 }] }]);
});

test('task context carries no environment, SDK or delegation and refuses other robots and tools', async () => {
    const calls = [], observed = [];
    const context = await createPloinkyTaskContext({ context: { workingDir: '/workspace/project', resources: [] },
        env: { PLOINKY_AGENT_SECRET: 'private-sentinel', PLOINKY_AGENT_API_KEY: 'api-sentinel' },
        createClient: async agent => ({ callToolWithoutWait: async (tool, input) => {
            calls.push({ agent, tool, input }); return { metadata: { taskId: 'research-one' } };
        }, getTaskStatus: async () => ({ status: 'running' }) }), onTask: async task => { observed.push(task); } });
    assert.deepEqual(context.context, { version: 3, workingDir: '/workspace/project', resources: [], paths: [], origin: {} });
    assert.equal(JSON.stringify(context.context).includes('PLOINKY_'), false);
    for (const body of [{ agent: 'roboTeamAgent', tool: 'startSimpleALATaskForRobot', payload: { robotName: 'victim' } },
        { agent: 'roboWorkAgent', tool: 'run_start' }, { agent: 'other/GPTResearcher', tool: 'start_research' }]) {
        await assert.rejects(context.dispatch({ path: '/agent-call', body }), { statusCode: 403 });
    }
    await context.dispatch({ path: '/agent-call', body: { agent: 'GPTResearcher', tool: 'start_research', payload: { query: 'public facts' } } });
    assert.equal(calls.length, 1);
    assert.equal(observed[0].taskId, 'research-one');
    await assert.rejects(context.dispatch({ path: '/ensure-agent', body: { ref: 'other/agent' } }), { statusCode: 403 });
});

test('task context forces the folder of tools that start work to the run working folder', async () => {
    const calls = [];
    const createClient = async agent => ({ callToolWithoutWait: async (tool, input) => { calls.push({ agent, tool, input }); return {}; } });
    const context = await createPloinkyTaskContext({ context: { workingDir: '/workspace/project' }, robotId: 'robot-one', env: {}, createClient });
    await context.dispatch({ path: '/agent-call', body: { agent: 'roboTeamAgent', tool: 'roboflow_start_flow',
        payload: { workflowTypeId: 'default', folder: '/workspace/other-robot', restrictToRobot: 'robot-two' } } });
    await context.dispatch({ path: '/agent-call', body: { agent: 'roboTeamAgent', tool: 'roboflow_start_flow', payload: { workflowTypeId: 'default' } } });
    // Without a calling robot the relay cannot constrain a workflow, so it starts none.
    const anonymous = await createPloinkyTaskContext({ context: { workingDir: '/workspace/project' }, env: {}, createClient });
    await assert.rejects(anonymous.dispatch({ path: '/agent-call', body: { agent: 'roboTeamAgent', tool: 'roboflow_start_flow', payload: {} } }), { statusCode: 403 });
    await context.dispatch({ path: '/agent-call', body: { agent: 'GPTResearcher', tool: 'start_research',
        payload: { query: 'q', workingDir: '/workspace/other-robot' } } });
    assert.deepEqual(calls.map(call => call.input), [{ workflowTypeId: 'default', folder: '/workspace/project', restrictToRobot: 'robot-one', ownerPrincipal: null },
        { workflowTypeId: 'default', folder: '/workspace/project', restrictToRobot: 'robot-one', ownerPrincipal: null }, { query: 'q', workingDir: '/workspace/project' }]);
    await assert.rejects(context.dispatch({ path: '/agent-call', body: { agent: 'roboTeamAgent', tool: 'roboflow_start_flow', payload: 'x' } }), { statusCode: 403 });
});

test('the relay stamps a started workflow with the run owner and overwrites a robot-sent one', async () => {
    const calls = [];
    const createClient = async () => ({ callToolWithoutWait: async (tool, input) => { calls.push(input); return {}; } });
    const send = (context, payload) => createPloinkyTaskContext({ context: { workingDir: '/workspace/project', ...context }, robotId: 'robot-one', env: {}, createClient })
        .then(relay => relay.dispatch({ path: '/agent-call', body: { agent: 'roboTeamAgent', tool: 'roboflow_start_flow', payload } }));
    await send({ ownerPrincipal: 'user:alice' }, { workflowTypeId: 'w' });
    await send({ ownerPrincipal: 'user:alice' }, { workflowTypeId: 'w', ownerPrincipal: 'user:mallory' });
    await send({}, { workflowTypeId: 'w', ownerPrincipal: 'user:mallory' });
    await send({ ownerPrincipal: 'mallory' }, { workflowTypeId: 'w' });
    assert.deepEqual(calls.map(call => call.ownerPrincipal), ['user:alice', 'user:alice', null, null]);
});

test('a robot task relay stamps the owner from the service-set task tag only', async () => {
    const { taskOwnerContext } = await import('../server/task-owner.mjs');
    const calls = [];
    const createClient = async () => ({ callToolWithoutWait: async (tool, input) => { calls.push(input); return {}; } });
    for (const env of [{ ROBOTEAM_TASK_TAG: JSON.stringify({ ownerPrincipal: 'user:alice' }) }, { ROBOTEAM_TASK_TAG: JSON.stringify({ ownerPrincipal: null }) },
        { ROBOTEAM_TASK_TAG: JSON.stringify({ ownerPrincipal: 'alice' }) }, { ROBOTEAM_TASK_TAG: '{' }, {}]) {
        const relay = await createPloinkyTaskContext({ context: { workingDir: '/workspace/project', ...taskOwnerContext(env) }, robotId: 'robot-one', env: {}, createClient });
        await relay.dispatch({ path: '/agent-call', body: { agent: 'roboTeamAgent', tool: 'roboflow_start_flow', payload: { workflowTypeId: 'w' } } });
    }
    assert.deepEqual(calls.map(call => call.ownerPrincipal), ['user:alice', null, null, null, null]);
});

test('extracts visible coding-agent messages from the ALA event stream', () => {
    let output = '';
    const parser = runtimeManagerInternals.createAlaProgressParser((text) => { output += text; });
    parser.push(Buffer.from('ala diagnostic\n@@ALA_EVENT@@{"type":"coding-agent-message","agent":"codex","message":"first '));
    parser.push(Buffer.from('message\\n"}\n@@ALA_EVENT@@{"type":"coding-agent-final","message":"duplicate"}\n'));
    parser.finish();
    assert.equal(output, 'ala diagnostic\nfirst message\n');
});

test('reports the bounded ALA diagnostic when the process exits unsuccessfully', () => {
    const message = runtimeManagerInternals.alaFailureMessage(1, '\u001b[31mala: Codex is unavailable\u001b[0m\n');
    assert.equal(message, 'ALA exited with 1: ala: Codex is unavailable');
    assert.ok(runtimeManagerInternals.alaFailureMessage(1, 'x'.repeat(5000)).length < 4200);
});

test('keeps task prompts private and rejects a mismatched stop operation', async (t) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'roboteam-stop-test-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const dataDir = path.join(root, 'data');
    const workspace = path.join(root, 'workspace');
    const robot = { id: 'private-a1b2c3', name: 'Private' };
    await Promise.all([
        fs.mkdir(path.join(dataDir, 'robots', robot.id, 'home'), { recursive: true }),
        fs.mkdir(path.join(dataDir, 'robots', robot.id, 'runtime'), { recursive: true }),
        fs.mkdir(workspace, { recursive: true }),
    ]);
    const spawnImpl = () => {
        const child = new EventEmitter();
        child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.kill = () => { queueMicrotask(() => child.emit('close', null, 'SIGTERM')); return true; };
        return child;
    };
    const manager = new RuntimeManager({ dataDir, workspaceRoot: root, spawnImpl, toolCache: preparedToolCache });
    let execution;
    const runTask = manager._runTask.bind(manager);
    t.mock.method(manager, '_runTask', (...args) => { execution = runTask(...args); return execution; });
    manager.startTask(robot, 'simple', { cwd: workspace, task: 'secret prompt' });
    while (manager.taskStatus(robot.id).state === 'queued') await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal('task' in manager.taskStatus(robot.id), false);
    assert.throws(() => manager.stopTask(robot, 'desktop', manager.taskStatus(robot.id).taskId), /active simple task/);
    manager.stopTask(robot, 'simple');
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(manager.taskStatus(robot.id).state, 'paused');
    await execution; // Finish asynchronous preparation before removing its home.
    await manager.stopAll();
});

test('can stop one parallel CLI task without interrupting another', async (t) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'roboteam-stop-queued-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const dataDir = path.join(root, 'data');
    const workspace = path.join(root, 'workspace');
    const robot = { id: 'stop-queue-a1b2c3', name: 'Stop Queue' };
    await Promise.all([
        fs.mkdir(path.join(dataDir, 'robots', robot.id, 'home'), { recursive: true }),
        fs.mkdir(path.join(dataDir, 'robots', robot.id, 'runtime'), { recursive: true }),
        fs.mkdir(workspace, { recursive: true }),
    ]);
    const children = [];
    const manager = new RuntimeManager({
        dataDir,
        workspaceRoot: root,
        toolCache: preparedToolCache,
        spawnImpl: () => {
            const child = new EventEmitter();
            child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.kill = () => true;
            children.push(child);
            return child;
        },
    });
    const first = manager.startTask(robot, 'simple', { cwd: workspace, task: 'First' });
    const second = manager.startTask(robot, 'simple', { cwd: workspace, task: 'Second' });
    while (children.length < 2) await new Promise((resolve) => setTimeout(resolve, 5));
    manager.stopTask(robot, 'simple', second.taskId);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(manager.taskStatus(robot.id, first.taskId).state, 'running');
    assert.equal(manager.taskStatus(robot.id, second.taskId).state, 'paused');
    for (const child of children) child.emit('close', 0, null);
    while (manager.taskStatus(robot.id, first.taskId).state !== 'completed') await new Promise((resolve) => setTimeout(resolve, 5));
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(children.length, 2);
});

test('holds the robot queue during manual GUI control and resumes the interrupted task first', async () => {
    const robot = { id: 'manual-a1b2c3', name: 'Manual' };
    const killed = [];
    const manager = new RuntimeManager({ toolCache: preparedToolCache });
    const interrupted = {
        taskId: '11111111-1111-4111-8111-111111111111',
        alaSessionId: '22222222-2222-4222-8222-222222222222',
        robotId: robot.id,
        type: 'desktop',
        state: 'running',
        createdAt: new Date().toISOString(),
        request: { cwd: '/workspace/project', task: 'Inspect the application.', ca: 'codex' },
        logTail: '',
        logSeq: 0,
        logTruncated: false,
        result: '',
        error: null,
        child: { kill: (signal) => { killed.push(signal); return true; } },
        cancelRequested: false,
    };
    const waiting = {
        ...interrupted,
        taskId: 'waiting-task',
        alaSessionId: '33333333-3333-4333-8333-333333333333',
        state: 'queued',
        request: { cwd: '/workspace/project', task: 'Run after resume.', ca: 'codex' },
        child: null,
    };
    manager.tasks.set(interrupted.taskId, interrupted);
    manager.tasks.set(waiting.taskId, waiting);
    manager.latestTask.set(robot.id, interrupted.taskId);
    manager.activeTasks.set(robot.id, interrupted.taskId);
    manager.taskQueues.set(robot.id, [waiting.taskId]);

    manager.takeControl(robot, interrupted.taskId);
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(manager.manualControl.get(robot.id), interrupted.taskId);
    assert.deepEqual(killed, ['SIGINT']);
    assert.equal(manager.taskStatus(robot.id, interrupted.taskId).state, 'paused');
    await manager._drainTaskQueue(robot);
    assert.equal(manager.taskStatus(robot.id, waiting.taskId).state, 'queued');

    interrupted.child = null;
    const resumed = await manager.resumeTask(robot, interrupted.taskId);
    const resumedInternal = manager.tasks.get(resumed.taskId);
    assert.equal(manager.manualControl.has(robot.id), false);
    assert.deepEqual(manager.taskQueues.get(robot.id), [resumed.taskId, waiting.taskId]);
    assert.match(resumedInternal.request.task, /^Continue\./u);
    assert.equal(resumedInternal.request.alaSessionId, interrupted.alaSessionId);
    assert.equal(resumedInternal.request.resumeSession, true);
    assert.match(resumedInternal.request.task, /Inspect the current visible desktop or browser state/u);
    assert.equal(resumedInternal.request.cwd, interrupted.request.cwd);
    manager.shuttingDown = true;
});

test('restores a completed Simple conversation after restart without repeating its original prompt', async (t) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'roboteam-resume-record-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const robot = { id: 'resume-a1b2c3', name: 'Resume' };
    const project = path.join(root, 'project');
    await fs.mkdir(project);
    const first = new RuntimeManager({ dataDir: root, toolCache: preparedToolCache });
    const taskId = '12345678-1234-4123-8123-123456789abc';
    await first._saveTask({ taskId, robotId: robot.id, type: 'simple', state: 'completed',
        alaSessionId: taskId, request: { cwd: project, task: 'original task', ca: 'pi' } });
    const second = new RuntimeManager({ dataDir: root, toolCache: preparedToolCache });
    second._drainTaskQueue = async () => {};
    second.shuttingDown = true;
    const continued = await second.resumeTask(robot, taskId, 'now add tests');
    const request = second.tasks.get(continued.taskId).request;
    assert.equal(request.task, 'now add tests');
    assert.equal(request.alaSessionId, taskId);
    assert.equal(request.resumeSession, true);
    assert.equal(request.ca, 'pi');
    second.tasks.get(continued.taskId).state = 'completed';
    const resumed = await second.resumeTask(robot, taskId);
    assert.equal(second.tasks.get(resumed.taskId).request.task, 'Continue.');
    await assert.rejects(second.resumeTask({ id: 'another-robot' }, taskId), /no matching task/);
});

test('active message delivery waits for an ALA receipt and starting tasks queue input', async () => {
    const robot = { id: 'message-a1b2c3', name: 'Message' };
    const manager = new RuntimeManager({ toolCache: preparedToolCache });
    const task = { taskId: 'active-id', robotId: robot.id, state: 'starting', pendingMessages: [] };
    manager.tasks.set(task.taskId, task);
    assert.equal((await manager.sendTaskMessage(robot, task.taskId, 'first')).delivery, 'queued');
    assert.equal(task.pendingMessages[0].message, 'first');
    task.controlReady = true;
    task.state = 'running';
    task.child = { stdin: { write(line) {
        const command = JSON.parse(line);
        assert.equal(command.message, 'live');
        const waiter = manager.messageWaiters.get(command.id);
        clearTimeout(waiter.timer);
        manager.messageWaiters.delete(command.id);
        waiter.resolve({ delivery: 'delivered' });
    } } };
    assert.equal((await manager.sendTaskMessage(robot, task.taskId, 'live')).delivery, 'delivered');
    task.state = 'completed';
    await assert.rejects(manager.sendTaskMessage(robot, task.taskId, 'too late'), /no longer running/);
});

test('an explicit GUI stop does not enter manual-control mode', async () => {
    const robot = { id: 'stop-gui-a1b2c3', name: 'Stop GUI' };
    const manager = new RuntimeManager({ toolCache: preparedToolCache });
    const active = {
        taskId: 'explicit-stop-task',
        robotId: robot.id,
        type: 'browser',
        state: 'running',
        createdAt: new Date().toISOString(),
        request: { cwd: '/workspace/project', task: 'Inspect the page.', ca: 'codex' },
        logTail: '',
        logSeq: 0,
        logTruncated: false,
        result: '',
        error: null,
        child: { kill: () => true },
        cancelRequested: false,
    };
    manager.tasks.set(active.taskId, active);
    manager.latestTask.set(robot.id, active.taskId);
    manager.activeTasks.set(robot.id, active.taskId);

    manager.stopTask(robot, 'browser', active.taskId);
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(manager.taskStatus(robot.id, active.taskId).state, 'paused');
    assert.equal(manager.manualControl.has(robot.id), false);
});

test('new GUI work clears manual control after every previous GUI task was paused', async () => {
    const robot = { id: 'restart-a1b2c3', name: 'Restart' };
    const manager = new RuntimeManager({ toolCache: preparedToolCache });
    const active = manager._newTask(robot, 'browser', { cwd: '/workspace' });
    active.state = 'running';
    active.child = { kill() {} };
    manager.activeTasks.set(robot.id, active.taskId);
    const waiting = manager.startTask(robot, 'browser', { cwd: '/workspace' });
    manager.takeControl(robot, active.taskId);
    manager.stopTask(robot, null, waiting.taskId);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(manager.manualControl.has(robot.id), true);
    // An unrelated CLI conversation must not keep the GUI pause alive.
    manager._newTask(robot, 'simple', {}).state = 'running';
    const executed = [];
    manager._runTask = async (_robot, task) => { executed.push(task.taskId); task.state = 'completed'; };
    const next = manager.startTask(robot, 'browser', { cwd: '/workspace' });
    assert.equal(manager.manualControl.has(robot.id), false);
    await manager._drainTaskQueue(robot);
    assert.deepEqual(executed, []); // Old process still holds the execution slot.
    manager.activeTasks.delete(robot.id);
    await manager._drainTaskQueue(robot);
    assert.deepEqual(executed, [next.taskId]);
    manager.shuttingDown = true;
});

test('new work keeps manual control while a previous GUI task is still queued', async () => {
    const robot = { id: 'paused-a1b2c3', name: 'Paused' };
    const manager = new RuntimeManager({ toolCache: preparedToolCache });
    manager.manualControl.set(robot.id, 'interrupted');
    const old = manager._newTask(robot, 'desktop', {});
    manager.taskQueues.set(robot.id, [old.taskId]);
    const next = manager.startTask(robot, 'browser', {});
    await manager._drainTaskQueue(robot);
    assert.equal(manager.manualControl.has(robot.id), true);
    assert.equal(manager.taskStatus(robot.id, next.taskId).blockedReason, 'manual-control');
    assert.equal(manager.taskStatus(robot.id, next.taskId).state, 'queued');
    manager.shuttingDown = true;
});

test('workflow callback channel is scoped to each runtime attempt and removed before terminal notification', async t => {
    const { requireHumanInput } = await import('../copilot/src/skills/require-human-input/scripts/run.mjs');
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'runtime-human-'));
    const robot = { id: 'human-a1b2c3', name: 'Human' };
    const workspace = path.join(root, 'workspace');
    const dataDir = path.join(root, 'data');
    await fs.mkdir(workspace, { recursive: true });
    await fs.mkdir(path.join(dataDir, 'robots', robot.id, 'home'), { recursive: true });
    const children = [];
    const callbacks = [];
    const terminal = [];
    const manager = new RuntimeManager({ dataDir, workspaceRoot: root, toolCache: preparedToolCache,
        execFileImpl: async () => ({ stdout: '[]', stderr: '' }),
        spawnImpl: (_command, _args, options) => {
            const child = new EventEmitter();
            child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.kill = () => true;
            children.push({ child, directory: options.env.ROBOTEAM_HUMAN_INPUT_DIRECTORY });
            return child;
        } });
    manager.requestHumanInput = async (taskId, input) => { callbacks.push({ taskId, input }); return { id: 'question' }; };
    manager.setTaskObserver(event => { if (event.kind === 'terminal') terminal.push(event); });
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const first = manager.startTask(robot, 'simple', { cwd: workspace, task: 'Ask', ca: 'codex', allowsHumanInput: true });
    for (let i = 0; i < 200 && children.length < 1; i++) await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(children.length, 1);
    const question = { question: 'Q?', options: ['A', 'B', 'C'] };
    await requireHumanInput(question, { directory: children[0].directory });
    assert.equal(callbacks[0].taskId, first.taskId);
    children[0].child.emit('close', 0);
    for (let i = 0; i < 200 && terminal.length < 1; i++) await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(terminal.length, 1);
    await assert.rejects(fs.stat(children[0].directory), { code: 'ENOENT' });
    const second = await manager.resumeTask(robot, first.taskId, 'My answer to your question is: A');
    for (let i = 0; i < 200 && children.length < 2; i++) await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(children.length, 2);
    assert.notEqual(children[1].directory, children[0].directory);
    await requireHumanInput(question, { directory: children[1].directory });
    assert.equal(callbacks[1].taskId, second.taskId);
    children[1].child.emit('close', 0);
    for (let i = 0; i < 200 && terminal.length < 2; i++) await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(terminal.length, 2);
    await assert.rejects(fs.stat(children[1].directory), { code: 'ENOENT' });
});

test('reported task failure never publishes completed even when the wrapper exits zero', async t => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'runtime-failure-'));
    const robot = { id: 'failure-a1b2c3', name: 'Failure' };
    const workspace = path.join(root, 'workspace'), dataDir = path.join(root, 'data');
    await fs.mkdir(workspace, { recursive: true });
    await fs.mkdir(path.join(dataDir, 'robots', robot.id, 'home'), { recursive: true });
    const events = [], launches = [];
    const manager = new RuntimeManager({ dataDir, workspaceRoot: root, toolCache: preparedToolCache,
        execFileImpl: async () => ({ stdout: '[]', stderr: '' }),
        spawnImpl: (_command, args) => {
            launches.push(args);
            const child = new EventEmitter();
            child.stdout = new PassThrough(); child.stderr = new PassThrough();
            setImmediate(() => {
                child.stderr.write('@@ALA_EVENT@@' + JSON.stringify({ type: 'task-failed', message: 'Missing deployment access.' }) + '\n');
                child.emit('close', 0, null);
            });
            return child;
        } });
    manager.setTaskObserver(event => events.push(event));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const started = manager.startTask(robot, 'simple', { cwd: workspace, task: 'Deploy', ca: 'codex', workflowRunId: 'flow_test' });
    for (let i = 0; i < 200 && !events.some(event => event.kind === 'terminal'); i++) await new Promise(resolve => setTimeout(resolve, 5));
    const terminal = events.filter(event => event.kind === 'terminal');
    assert.equal(terminal.length, 1);
    assert.equal(terminal[0].state, 'failed');
    assert.equal(terminal[0].forcedFailure, true);
    assert.equal(terminal[0].error, 'Missing deployment access.');
    assert.equal(manager.taskStatus(robot.id, started.taskId).state, 'failed');
    assert.equal(events.some(event => event.state === 'completed' || event.state === 'paused'), false);
    assert.ok(launches[0].includes('--workflow-execution'));
    await manager.resumeTask(robot, started.taskId, 'Try again');
    for (let i = 0; i < 200 && events.filter(event => event.kind === 'terminal').length < 2; i++) await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(launches.length, 2);
    assert.ok(launches[1].includes('--workflow-execution'));
    assert.ok(launches[1].includes('--resume-session'));
    manager.startTask(robot, 'simple', { cwd: workspace, task: 'Standalone', ca: 'codex' });
    for (let i = 0; i < 200 && events.filter(event => event.kind === 'terminal').length < 3; i++) await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(launches.length, 3);
    assert.equal(launches[2].includes('--workflow-execution'), false);
});

test('queued admission is observed with owner and phase association, without a state event or startedAt', async () => {
    const robot = { id: 'admit-a1b2c3', name: 'Admit' };
    const manager = new RuntimeManager({ toolCache: preparedToolCache });
    manager.shuttingDown = true;
    const events = [];
    manager.setTaskObserver((event) => events.push(event));
    const queued = manager.startTask(robot, 'browser', { cwd: '/workspace/project', task: 'Look', ownerPrincipal: 'user:alice',
        workflowRunId: `flow_${'a'.repeat(24)}`, workflowInstanceId: `inv_${'b'.repeat(24)}` });
    assert.deepEqual(events, [{ kind: 'admitted', robotId: robot.id, robotName: 'Admit', taskId: queued.taskId, type: 'browser', state: 'queued',
        cwd: '/workspace/project', ownerPrincipal: 'user:alice', workflowRunId: `flow_${'a'.repeat(24)}`, workflowInstanceId: `inv_${'b'.repeat(24)}` }]);
    const status = manager.taskStatus(robot.id, queued.taskId);
    assert.equal(status.startedAt, undefined);
    for (const key of ['ownerPrincipal', 'workflowInstanceId', 'transcriptRef', 'terminalEmitted']) assert.equal(Object.hasOwn(status, key), false, key);
    // Only a signed user principal is kept; anything else is the system owner.
    for (const owner of ['alice', 'user:', '', null, 7, { id: 'user:alice' }]) {
        events.length = 0;
        manager.startTask(robot, 'simple', { cwd: '/workspace/project', task: 'x', ownerPrincipal: owner });
        assert.equal(events[0].ownerPrincipal, null, JSON.stringify(owner));
        assert.equal(events[0].workflowRunId, null);
        assert.equal(events[0].workflowInstanceId, null);
    }
});

test('a queued GUI task cancelled before it runs ends with exactly one terminal event', async () => {
    const robot = { id: 'cancel-a1b2c3', name: 'Cancel' };
    const manager = new RuntimeManager({ toolCache: preparedToolCache });
    const active = manager._newTask(robot, 'browser', { cwd: '/workspace' });
    active.state = 'running';
    active.child = { kill() {} };
    manager.activeTasks.set(robot.id, active.taskId);
    const events = [];
    manager.setTaskObserver((event) => events.push(event));
    const waiting = manager.startTask(robot, 'browser', { cwd: '/workspace', task: 'Later' });
    const stop = manager.stopTask(robot, null, waiting.taskId);
    await new Promise((resolve) => setImmediate(resolve));
    manager.stopTask(robot, null, waiting.taskId);
    await new Promise((resolve) => setImmediate(resolve));
    manager.activeTasks.delete(robot.id);
    await manager._drainTaskQueue(robot);
    const terminal = events.filter((event) => event.kind === 'terminal' && event.taskId === waiting.taskId);
    assert.equal(terminal.length, 1);
    assert.deepEqual(terminal[0], { kind: 'terminal', robotId: robot.id, taskId: waiting.taskId, state: 'paused', result: '', error: null });
    assert.equal(events.some((event) => event.taskId === stop.taskId), false, 'helper stop records are never observed');
    manager.shuttingDown = true;
});

test('a CLI task stopped before or after its run starts reports one terminal event', async (t) => {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'runtime-stop-order-')));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const robot = { id: 'order-a1b2c3', name: 'Order' };
    const dataDir = path.join(root, 'data');
    await fs.mkdir(path.join(dataDir, 'robots', robot.id, 'home'), { recursive: true });
    // Run first, then stop: the run's finally reports the pause.
    const manager = new RuntimeManager({ dataDir, workspaceRoot: root, toolCache: preparedToolCache,
        execFileImpl: async () => ({ stdout: '[]', stderr: '' }), spawnImpl: () => { throw new Error('never spawned'); } });
    const events = [];
    manager.setTaskObserver((event) => events.push(event));
    const first = manager.startTask(robot, 'simple', { cwd: root, task: 'x', ca: 'codex' });
    manager.stopTask(robot, 'simple', first.taskId);
    for (let i = 0; i < 200 && !events.some((event) => event.kind === 'terminal'); i++) await new Promise((resolve) => setTimeout(resolve, 5));
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.deepEqual(events.filter((event) => event.kind === 'terminal').map((event) => [event.taskId, event.state]), [[first.taskId, 'paused']]);
    // Stop first, then the queued run: the stop reports it and the run never starts.
    events.length = 0;
    manager.shuttingDown = true;
    const second = manager.startTask(robot, 'simple', { cwd: root, task: 'y', ca: 'codex' });
    manager.stopTask(robot, 'simple', second.taskId);
    await new Promise((resolve) => setImmediate(resolve));
    manager.shuttingDown = false;
    await manager._runTask(robot, manager.tasks.get(second.taskId));
    assert.deepEqual(events.filter((event) => event.kind === 'terminal').map((event) => [event.taskId, event.state]), [[second.taskId, 'paused']]);
    assert.equal(events.some((event) => event.kind === 'state'), false);
});

test('the first turn-started event binds the task transcript to its own session; nothing else is accepted', async (t) => {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'runtime-transcript-')));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const robot = { id: 'transcript-a1b2c3', name: 'Transcript' };
    const dataDir = path.join(root, 'data');
    await fs.mkdir(path.join(dataDir, 'robots', robot.id, 'home'), { recursive: true });
    const turn = '11111111-2222-4333-8444-555555555555';
    const message = '66666666-7777-4888-8999-aaaaaaaaaaaa';
    const manager = new RuntimeManager({ dataDir, workspaceRoot: root, toolCache: preparedToolCache,
        execFileImpl: async () => ({ stdout: '[]', stderr: '' }),
        spawnImpl: () => {
            const child = new EventEmitter();
            child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.kill = () => true;
            setImmediate(() => {
                const event = (value) => child.stderr.write(`@@ALA_EVENT@@${JSON.stringify(value)}\n`);
                event({ type: 'turn-started', session: { sessionId: 'other' }, userMessageId: 'x', assistantMessageId: 'not-a-uuid', turnId: turn });
                event({ type: 'turn-started', session: { big: 'metadata' }, userMessageId: 'x', assistantMessageId: message, turnId: turn });
                event({ type: 'turn-started', assistantMessageId: '00000000-0000-4000-8000-000000000000', turnId: turn });
                child.emit('close', 0, null);
            });
            return child;
        } });
    const events = [];
    manager.setTaskObserver((event) => events.push(event));
    const started = manager.startTask(robot, 'simple', { cwd: root, task: 'x', ca: 'codex' });
    assert.equal(manager.taskTranscriptRef(robot.id, started.taskId), null, 'no transcript before the turn starts');
    for (let i = 0; i < 200 && !events.some((event) => event.kind === 'terminal'); i++) await new Promise((resolve) => setTimeout(resolve, 5));
    const task = manager.tasks.get(started.taskId);
    assert.deepEqual(manager.taskTranscriptRef(robot.id, started.taskId), { cwd: task.request.cwd, sessionId: task.alaSessionId, assistantMessageId: message });
    assert.equal(manager.taskTranscriptRef('other-robot', started.taskId), null);
    assert.equal(Object.hasOwn(manager.taskStatus(robot.id, started.taskId), 'transcriptRef'), false);
    assert.equal(events.some((event) => JSON.stringify(event).includes('metadata')), false, 'the event body is never forwarded');
});

test('task message failures carry typed live outcomes and keep their messages', async () => {
    const robot = { id: 'typed-a1b2c3', name: 'Typed' };
    const manager = new RuntimeManager({ toolCache: preparedToolCache, messageTimeoutMs: 20 });
    const outcome = async (promise) => { try { await promise; return 'resolved'; } catch (error) { return [error.liveOutcome, error.message]; } };
    assert.deepEqual(await outcome(manager.sendTaskMessage(robot, 'missing', 'x')), ['run_ended', 'Task is no longer running; continue it instead.']);
    const task = { taskId: 'typed-task', robotId: robot.id, state: 'running', pendingMessages: [], controlReady: true };
    manager.tasks.set(task.taskId, task);
    const written = [];
    task.child = { stdin: { write(line) { written.push(JSON.parse(line)); } } };
    const rejected = manager.sendTaskMessage(robot, task.taskId, 'reject me');
    const waiter = manager.messageWaiters.get(written[0].id);
    clearTimeout(waiter.timer);
    manager.messageWaiters.delete(written[0].id);
    waiter.reject(manager._messageFailure('rejected', 'Busy.'));
    assert.deepEqual(await outcome(rejected), ['rejected', 'Busy.']);
    assert.deepEqual(await outcome(manager.sendTaskMessage(robot, task.taskId, 'nobody answers')),
        ['unknown', 'Message acknowledgement timed out; delivery is unknown.']);
    task.controlReady = false;
    task.pendingMessages = Array.from({ length: 100 }, () => ({}));
    assert.deepEqual(await outcome(manager.sendTaskMessage(robot, task.taskId, 'full')), ['rejected', 'Task message queue is full.']);
    // An empty or oversized message is never delivered: rejected, with the same text.
    assert.deepEqual(await outcome(manager.sendTaskMessage(robot, task.taskId, ' ')), ['rejected', 'Message must contain 1 to 32768 characters.']);
    assert.deepEqual(await outcome(manager.sendTaskMessage(robot, task.taskId, 'x'.repeat(32769))), ['rejected', 'Message must contain 1 to 32768 characters.']);
});

test('a message pending when the task ends is reported as run_ended', async (t) => {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'runtime-ended-message-')));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const robot = { id: 'ended-a1b2c3', name: 'Ended' };
    const dataDir = path.join(root, 'data');
    await fs.mkdir(path.join(dataDir, 'robots', robot.id, 'home'), { recursive: true });
    let child;
    const manager = new RuntimeManager({ dataDir, workspaceRoot: root, toolCache: preparedToolCache,
        execFileImpl: async () => ({ stdout: '[]', stderr: '' }),
        spawnImpl: () => {
            child = new EventEmitter();
            child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.kill = () => true;
            child.stdin = { on() {}, write() {} };
            setImmediate(() => child.stderr.write(`@@ALA_EVENT@@${JSON.stringify({ type: 'session-ready' })}\n`));
            return child;
        } });
    const started = manager.startTask(robot, 'simple', { cwd: root, task: 'x', ca: 'codex' });
    for (let i = 0; i < 200 && !manager.tasks.get(started.taskId)?.controlReady; i++) await new Promise((resolve) => setTimeout(resolve, 5));
    const pending = manager.sendTaskMessage(robot, started.taskId, 'late');
    child.emit('close', 0, null);
    await assert.rejects(pending, (error) => error.liveOutcome === 'run_ended' && error.message === 'Task ended before the message was acknowledged.');
});

test('owner and phase association persist with the execution record and survive resume unchanged', async (t) => {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'runtime-owner-record-')));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const robot = { id: 'owner-a1b2c3', name: 'Owner' };
    const project = path.join(root, 'project');
    await fs.mkdir(project);
    const owned = '12345678-1234-4123-8123-123456789abc';
    const legacy = '12345678-1234-4123-8123-123456789abd';
    const first = new RuntimeManager({ dataDir: root, workspaceRoot: root, toolCache: preparedToolCache, ownerKey: 'boot-secret' });
    const task = first._newTask(robot, 'simple', { cwd: project, task: 'original', ca: 'pi', runtimeTaskId: owned, ownerPrincipal: 'user:alice',
        workflowRunId: `flow_${'c'.repeat(24)}`, workflowInstanceId: `inv_${'d'.repeat(24)}` });
    task.state = 'completed';
    await first._saveTask(task);
    await first._saveTask({ taskId: legacy, robotId: robot.id, type: 'simple', state: 'completed', alaSessionId: legacy,
        request: { cwd: project, task: 'old', ca: 'pi', ownerPrincipal: 'user:alice' } });
    const second = new RuntimeManager({ dataDir: root, workspaceRoot: root, toolCache: preparedToolCache, ownerKey: 'boot-secret' });
    second.shuttingDown = true;
    const events = [];
    second.setTaskObserver((event) => events.push(event));
    const resumed = await second.resumeTask(robot, owned, 'continue');
    await second.resumeTask(robot, legacy, 'continue');
    assert.notEqual(resumed.taskId, owned, 'a continuation is a new attempt with its own id');
    assert.deepEqual(events.map((event) => [event.ownerPrincipal, event.workflowRunId, event.workflowInstanceId]), [
        ['user:alice', `flow_${'c'.repeat(24)}`, null],
        [null, null, null],
    ], 'the bound owner survives; an unbound legacy owner is the system owner; phase association is never inherited');
});

test('a persisted owner that was tampered with, moved or written under another boot key is the system owner', async (t) => {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'runtime-owner-tamper-')));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const robot = { id: 'tamper-a1b2c3', name: 'Tamper' };
    const project = path.join(root, 'project');
    await fs.mkdir(project);
    const writer = new RuntimeManager({ dataDir: root, workspaceRoot: root, toolCache: preparedToolCache, ownerKey: 'boot-secret' });
    const ids = ['22345678-1234-4123-8123-123456789ab1', '22345678-1234-4123-8123-123456789ab2', '22345678-1234-4123-8123-123456789ab3'];
    for (const id of ids) {
        const task = writer._newTask(robot, 'simple', { cwd: project, task: 'x', ca: 'pi', runtimeTaskId: id, ownerPrincipal: 'user:alice' });
        task.state = 'completed';
        await writer._saveTask(task);
    }
    const file = (id) => path.join(project, '.roboteam', 'tasks', id, 'executions', `${id}.json`);
    const tampered = JSON.parse(await fs.readFile(file(ids[0]), 'utf8'));
    assert.equal(typeof tampered.ownerBinding, 'string');
    tampered.request.ownerPrincipal = 'user:mallory';
    await fs.writeFile(file(ids[0]), JSON.stringify(tampered));
    const moved = JSON.parse(await fs.readFile(file(ids[1]), 'utf8'));
    moved.ownerBinding = JSON.parse(await fs.readFile(file(ids[2]), 'utf8')).ownerBinding.replace(/^./u, (c) => (c === 'A' ? 'B' : 'A'));
    await fs.writeFile(file(ids[1]), JSON.stringify(moved));
    const reader = new RuntimeManager({ dataDir: root, workspaceRoot: root, toolCache: preparedToolCache, ownerKey: 'boot-secret' });
    reader.shuttingDown = true;
    const events = [];
    reader.setTaskObserver((event) => events.push(event));
    await reader.resumeTask(robot, ids[0], 'go');
    await reader.resumeTask(robot, ids[1], 'go');
    await reader.resumeTask(robot, ids[2], 'go');
    assert.deepEqual(events.map((event) => event.ownerPrincipal), [null, null, 'user:alice']);
    const restarted = new RuntimeManager({ dataDir: root, workspaceRoot: root, toolCache: preparedToolCache, ownerKey: 'next-boot-secret' });
    restarted.shuttingDown = true;
    const later = [];
    restarted.setTaskObserver((event) => later.push(event));
    await restarted.resumeTask(robot, ids[2], 'go');
    assert.equal(later[0].ownerPrincipal, null, 'a binding from another service start proves nothing');
});

test('an attempt reports at most one terminal event whichever paths reach it', () => {
    const robot = { id: 'once-a1b2c3', name: 'Once' };
    const manager = new RuntimeManager({ toolCache: preparedToolCache });
    const events = [];
    manager.setTaskObserver((event) => events.push(event));
    const task = manager._newTask(robot, 'simple', {});
    manager._emitTaskTerminal(task, { state: 'paused', result: '', error: null });
    manager._emitTaskTerminal(task, { state: 'failed', result: '', error: 'late' });
    assert.deepEqual(events, [{ kind: 'terminal', robotId: robot.id, taskId: task.taskId, state: 'paused', result: '', error: null }]);
});

// A stop that lands before the child is spawned ends the attempt: no spawn,
// paused, exactly one terminal event.
async function cancellableFixture(t, { gateEnsure = false } = {}) {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'runtime-cancel-window-')));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const robot = { id: 'window-a1b2c3', name: 'Window' };
    const dataDir = path.join(root, 'data');
    await fs.mkdir(path.join(dataDir, 'robots', robot.id, 'home'), { recursive: true });
    const spawns = [];
    let release, ensured;
    const ensureCalled = new Promise((resolve) => { ensured = resolve; });
    const gate = new Promise((resolve) => { release = resolve; });
    const manager = new RuntimeManager({ dataDir, workspaceRoot: root, toolCache: preparedToolCache,
        execFileImpl: async () => ({ stdout: '[]', stderr: '' }),
        skillsets: { policies: { ensure: async () => { ensured(); if (gateEnsure) await gate; } } },
        spawnImpl: () => {
            const child = new EventEmitter();
            child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.kill = () => true;
            spawns.push(child);
            setImmediate(() => child.emit('close', 0, null));
            return child;
        } });
    return { root, robot, manager, spawns, release, ensureCalled };
}

test('a stop while the task awaits its skill policy prevents the spawn and reports one paused terminal', async (t) => {
    const { LiveSessionsRegistry } = await import('../server/live-sessions/registry.mjs');
    const { RuntimeLiveSource, composeTaskObservers } = await import('../server/live-sessions/runtime-source.mjs');
    const { root, robot, manager, spawns, release, ensureCalled } = await cancellableFixture(t, { gateEnsure: true });
    const registry = new LiveSessionsRegistry({ log: () => {} });
    const source = new RuntimeLiveSource({ registry, runtimeManager: manager, robotStore: { get: async () => robot }, workspaceRoot: root });
    const events = [];
    manager.setTaskObserver(composeTaskObservers((event) => events.push(event), [(event) => source.onRuntimeTaskEvent(event)]));
    const started = manager.startTask(robot, 'simple', { cwd: root, task: 'x', ca: 'codex', ownerPrincipal: 'user:alice' });
    await ensureCalled;
    const [row] = registry.list({ principal: 'user:alice', canAdmin: false });
    assert.deepEqual(await registry.stop(row.id, { principal: 'user:alice', canAdmin: false }), { ok: true });
    await new Promise((resolve) => setImmediate(resolve));
    release();
    for (let i = 0; i < 200 && !events.some((event) => event.kind === 'terminal'); i++) await new Promise((resolve) => setTimeout(resolve, 5));
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(spawns.length, 0, 'the cancelled attempt never spawns');
    assert.equal(manager.taskStatus(robot.id, started.taskId).state, 'paused');
    assert.deepEqual(events.filter((event) => event.kind === 'terminal').map((event) => event.state), ['paused']);
    assert.equal(events.some((event) => event.kind === 'state' && event.state === 'running'), false);
    assert.equal(registry.list({ principal: 'user:alice', canAdmin: false })[0].status, 'stopped');
    assert.equal((await registry.stop(row.id, { principal: 'user:alice', canAdmin: false })).status, 409, 'an ended row cannot be stopped again');
});

test('a stop after the running transition but before the spawn prevents the spawn', async (t) => {
    const { root, robot, manager, spawns } = await cancellableFixture(t);
    const events = [];
    manager.setTaskObserver((event) => {
        events.push(event);
        if (event.kind === 'state' && event.state === 'running') manager.stopTask(robot, 'simple', event.taskId);
    });
    const started = manager.startTask(robot, 'simple', { cwd: root, task: 'x', ca: 'codex' });
    for (let i = 0; i < 200 && !events.some((event) => event.kind === 'terminal'); i++) await new Promise((resolve) => setTimeout(resolve, 5));
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(spawns.length, 0);
    assert.equal(manager.taskStatus(robot.id, started.taskId).state, 'paused');
    assert.deepEqual(events.filter((event) => event.kind === 'terminal').map((event) => event.state), ['paused']);
});

test('each continuation is a new attempt: own id, phase only when RoboFlow resumes it, and old terminals never end it', async (t) => {
    const { LiveSessionsRegistry } = await import('../server/live-sessions/registry.mjs');
    const { RuntimeLiveSource, composeTaskObservers } = await import('../server/live-sessions/runtime-source.mjs');
    const robot = { id: 'attempt-a1b2c3', name: 'Attempt' };
    const manager = new RuntimeManager({ toolCache: preparedToolCache });
    manager.shuttingDown = true;
    const registry = new LiveSessionsRegistry({ log: () => {} });
    const source = new RuntimeLiveSource({ registry, runtimeManager: manager, robotStore: { get: async () => robot }, workspaceRoot: '/workspace' });
    const events = [];
    manager.setTaskObserver(composeTaskObservers((event) => events.push(event), [(event) => source.onRuntimeTaskEvent(event)]));
    const phaseId = '33333333-1234-4123-8123-123456789abc';
    const flow = `flow_${'e'.repeat(24)}`;
    const instance = `inv_${'f'.repeat(24)}`;
    manager.startTask(robot, 'simple', { cwd: '/workspace', task: 'phase', runtimeTaskId: phaseId, alaSessionId: '44444444-1234-4123-8123-123456789abc',
        workflowRunId: flow, workflowInstanceId: instance, ownerPrincipal: 'user:alice' });
    assert.throws(() => manager.startTask(robot, 'simple', { cwd: '/workspace', task: 'again', runtimeTaskId: phaseId }), /already in use/);
    manager.tasks.get(phaseId).state = 'paused';
    // A continuation through the robot control API: a new id, a robot-task row.
    const viaControl = await manager.resumeTask(robot, phaseId, 'go on');
    assert.notEqual(viaControl.taskId, phaseId);
    const controlEvent = events.find((event) => event.kind === 'admitted' && event.taskId === viaControl.taskId);
    assert.deepEqual([controlEvent.workflowRunId, controlEvent.workflowInstanceId, controlEvent.ownerPrincipal], [flow, null, 'user:alice']);
    // A late terminal of the earlier attempt ends only its own row.
    source.onRuntimeTaskEvent({ kind: 'terminal', taskId: phaseId, state: 'paused', result: '', error: null });
    const rows = registry.list({ principal: 'user:alice', canAdmin: false });
    const kinds = Object.fromEntries(rows.map((row) => [row.kind, row.status]));
    assert.deepEqual(kinds, { 'workflow-phase': 'stopped', 'robot-task': 'waiting' });
    // RoboFlow's own continuation names its phase explicitly.
    manager.tasks.get(viaControl.taskId).state = 'paused';
    const viaRoboFlow = await manager.resumeTask(robot, viaControl.taskId, 'go', { runtimeTaskId: '55555555-1234-4123-8123-123456789abc', workflowInstanceId: instance });
    const flowEvent = events.find((event) => event.kind === 'admitted' && event.taskId === viaRoboFlow.taskId);
    assert.deepEqual([flowEvent.workflowRunId, flowEvent.workflowInstanceId, flowEvent.ownerPrincipal], [flow, instance, 'user:alice']);
});

test('RoboWork owns initialization, GUI, models and shutdown resources', async t => {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'runtime-remote-')));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const calls = [];
    const gui = { state: 'running', mode: 'desktop', sessionUrl: '/base-agent-additional-server/roboWorkAgent/3001/api/robots/robot-abc/session/', mcpPort: 8100, cwd: '/home/robot-abc' };
    const manager = new RuntimeManager({ dataDir: root, workspaceRoot: root, roboWork: { call: async (tool, input) => {
        calls.push({ tool, input });
        if (tool === 'robot_status') return { robots: [{ id: 'robot-abc', gui }] };
        if (tool === 'run_list') return [];
        if (tool === 'gui_ensure') return gui;
        if (tool === 'gui_logs') return { logs: 'own log' };
        return { state: 'stopped' };
    } } });
    await manager.initialize();
    assert.equal(manager.status('robot-abc').sessionUrl, gui.sessionUrl);
    const robot = { id: 'robot-abc', name: 'A', codingAgents: ['codex'] };
    assert.equal((await manager.openDesktop(robot)).sessionUrl, gui.sessionUrl);
    assert.deepEqual(calls.find(call => call.tool === 'gui_ensure').input, { robotId: robot.id, mode: 'desktop', codingAgents: ['codex'], allowReplace: false });
    assert.equal(await manager.logs(robot.id), 'own log');
    await manager.stopAll();
    assert.equal(calls.some(call => ['gui_stop', 'run_stop'].includes(call.tool)), false);
    manager.shuttingDown = false;
    await manager.stopContainer(robot.id, 'desktop');
    assert.deepEqual(calls.at(-1), { tool: 'gui_stop', input: { robotId: robot.id, mode: 'desktop' } });
});

test('runtime reattaches only authenticated live run records and preserves their owner across boot keys', async t => {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'runtime-reattach-')));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const robot = { id: 'robot-abc', name: 'A', codingAgents: ['codex'] };
    const taskId = '12345678-1234-4123-8123-123456789abc';
    const runs = [{ runId: 'run-one', robotId: robot.id, state: 'running', startedAt: new Date().toISOString(),
        tag: { kind: 'task', taskId, type: 'simple', sessionId: taskId, ownerPrincipal: 'user:alice', request: { cwd: root, task: 'wait', ca: 'codex' } } },
        { runId: 'old', robotId: robot.id, state: 'interrupted', tag: {} }];
    const manager = new RuntimeManager({ dataDir: root, workspaceRoot: root, ownerKey: 'new-launch',
        robotStore: { get: async id => id === robot.id ? robot : null },
        roboWork: { call: async tool => tool === 'run_list' ? runs : tool === 'robot_status' ? { robots: [] } : {} } });
    await manager.initialize();
    assert.equal(manager.tasks.size, 1);
    assert.equal(manager.tasks.get(taskId).attachRun, 'run-one');
    assert.equal(manager.tasks.get(taskId).request.ownerPrincipal, 'user:alice');
    const resumed = await manager.resumeTask(robot, taskId);
    assert.deepEqual(resumed, { taskId, state: 'queued', runId: 'run-one' });
    const events = [];
    manager.setTaskObserver(event => events.push(event));
    assert.equal(events[0].ownerPrincipal, 'user:alice');
    assert.equal(events[0].taskId, taskId);
});

test('a refused robot delete destroys nothing, and a repeat delete succeeds when RoboWork no longer has the robot', async t => {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'runtime-delete-')));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const calls = []; let refusal = Object.assign(new Error('close the robot chat and stop its CLI tasks before deleting it'), { code: 'ROBOT_BUSY', statusCode: 409 }), roboWorkError = null;
    const manager = new RuntimeManager({ dataDir: root, workspaceRoot: root,
        robotStore: { assertDeletable: async () => { if (refusal) throw refusal; } },
        roboWork: { call: async tool => { calls.push(tool); if (roboWorkError) throw roboWorkError; return {}; } } });
    let removed = 0;
    const remove = async () => { removed++; };
    await assert.rejects(manager.deleteRobot('robot-abc', remove), { code: 'ROBOT_BUSY', statusCode: 409 });
    assert.deepEqual(calls, []); assert.equal(removed, 0);
    assert.equal(manager.deletedRobots.has('robot-abc'), false);
    refusal = null;
    roboWorkError = Object.assign(new Error('RoboWork failed'), { code: 'ROBOWORK_FAILED' });
    await assert.rejects(manager.deleteRobot('robot-abc', remove), { code: 'ROBOWORK_FAILED' });
    assert.equal(removed, 0);
    roboWorkError = Object.assign(new Error('Unknown robotId'), { code: 'UNKNOWN_ROBOT', statusCode: 404 });
    await manager.deleteRobot('robot-abc', remove);
    assert.equal(removed, 1);
});

test('GUI preparation waits by polling status and surfaces a failed preparation', async t => {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'runtime-gui-poll-')));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const calls = []; let polls = 0, failing = false, reason = null;
    const manager = new RuntimeManager({ dataDir: root, workspaceRoot: root, roboWork: { call: async (tool, input) => {
        calls.push({ tool, input });
        if (tool === 'gui_ensure') return { state: 'starting', mode: 'desktop', cwd: '/home/robot-abc' };
        if (tool === 'robot_status') return { robots: [{ id: 'robot-abc', gui: {
            state: failing ? 'failed' : ++polls === 1 ? 'starting' : 'running', mode: 'desktop', sessionUrl: '/own/session/',
            ...(reason ? { error: reason } : {}),
        } }] };
        throw new Error('Unexpected tool');
    } } });
    const robot = { id: 'robot-abc', name: 'A', codingAgents: ['codex'] };
    assert.equal((await manager.openDesktop(robot)).sessionUrl, '/own/session/');
    assert.equal(polls, 2);
    assert.equal(calls.filter(call => call.tool === 'gui_ensure').length, 1);
    failing = true;
    await assert.rejects(manager.openDesktop(robot), { code: 'GUI_START_FAILED', statusCode: 409 });
    reason = { code: 'CWD_REFUSED', message: 'The working folder changed before the session started', statusCode: 400 };
    await assert.rejects(manager.openDesktop(robot), { ...reason });
    await assert.rejects(manager.resolveCwd(path.join(root, 'missing')), { message: 'cwd is unavailable' });
});
