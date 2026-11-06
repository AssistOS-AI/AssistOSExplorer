import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import { RuntimeManager } from '../server/runtime-manager.mjs';
import { DESKTOP_TASK_INSTRUCTIONS } from '../copilot/src/lib/prompts.mjs';
import { emailInstructions } from '../server/robot-email.mjs';
import { normalizeWorkflow } from '../server/roboflow/graph.mjs';

// A manager whose RoboWork and ALA wrapper are recorded. Every wrapper exits cleanly after reading its prompt.
async function fixture(t, { environments = {} } = {}) {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'roboteam-task-launch-')));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const workspace = path.join(root, 'workspace');
    await fs.mkdir(workspace, { recursive: true });
    const calls = [], spawns = [], required = [];
    const roboWork = { call: async (tool, input) => {
        calls.push({ tool, input });
        if (tool === 'run_list') return [];
        if (tool === 'robot_status') return { robots: [] };
        if (tool === 'gui_ensure') return { state: 'running', mode: input.mode, sessionUrl: '/own/session/', mcpPort: 8100, cwd: input.cwd };
        return {};
    } };
    const spawnImpl = (_command, args, options) => {
        const child = new EventEmitter();
        child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.stdin = new PassThrough(); child.kill = () => true;
        let text = '';
        child.stdin.on('data', chunk => { text += chunk; });
        const record = { args, env: options.env };
        spawns.push(record);
        setImmediate(() => { record.prompt = JSON.parse(text.split('\n')[0]); child.emit('close', 0, null); });
        return child;
    };
    const agentEnvironments = { require: async ref => { required.push(ref); return { ref }; } };
    const manager = new RuntimeManager({ dataDir: path.join(root, 'data'), workspaceRoot: root, roboWork, spawnImpl, agentEnvironments });
    t.after(() => manager.stopAll());
    const run = async (robot, type, request) => {
        const accepted = manager.startTask(robot, type, { cwd: workspace, task: 'Do it', ...request });
        const finished = ['completed', 'failed'];
        while (!finished.includes(manager.taskStatus(robot.id, accepted.taskId).state)) await new Promise(resolve => setTimeout(resolve, 5));
        return { accepted, status: manager.taskStatus(robot.id, accepted.taskId) };
    };
    return { manager, calls, spawns, required, run, workspace };
}

const value = (args, flag) => args[args.indexOf(flag) + 1];

test('a coding agent the robot has disabled is refused before anything is prepared or started', async t => {
    const f = await fixture(t);
    const robot = { id: 'selected-a1b2c3', name: 'Selected', codingAgents: ['opencode'] };
    const { status } = await f.run(robot, 'simple', { ca: 'codex' });
    assert.equal(status.state, 'failed');
    assert.match(status.error, /Coding agent codex is not enabled for this robot/u);
    assert.equal(f.spawns.length, 0);
    assert.deepEqual(f.calls.filter(call => ['robot_ensure', 'gui_ensure'].includes(call.tool)), []);
    const enabled = await f.run(robot, 'simple', { ca: 'opencode' });
    assert.equal(enabled.status.state, 'completed', enabled.status.error);
    assert.equal(f.spawns.length, 1);
});

test('only a task may replace the retained container, and a plain open or start never does', async t => {
    const f = await fixture(t);
    const robot = { id: 'replace-a1b2c3', name: 'Replace', codingAgents: ['codex'] };
    const replace = () => f.calls.filter(call => call.tool === 'gui_ensure').map(call => call.input.allowReplace);
    await f.manager.openDesktop(robot, f.workspace);
    await f.manager.start(robot, 'browser');
    assert.deepEqual(replace(), [false, false]);
    await f.run(robot, 'simple', { ca: 'codex' });
    assert.deepEqual(replace(), [false, false], 'a Simple task leaves the retained container alone');
    const desktop = await f.run(robot, 'desktop', { ca: 'codex' });
    assert.equal(desktop.status.state, 'completed', desktop.status.error);
    assert.deepEqual(replace(), [false, false, true]);
    const input = f.calls.filter(call => call.tool === 'gui_ensure').at(-1).input;
    assert.equal(input.mode, 'desktop'); assert.equal(input.cwd, f.workspace);
});

test('a started GUI task answers with its session address at once, and a Simple task has none', async t => {
    const f = await fixture(t);
    const robot = { id: 'session-a1b2c3', name: 'Session', codingAgents: ['codex'] };
    for (const type of ['desktop', 'browser']) {
        const accepted = f.manager.startTask(robot, type, { cwd: f.workspace, task: 'Look', ca: 'codex' });
        assert.match(accepted.sessionUrl, new RegExp(`/api/robots/${robot.id}/session/$`, 'u'));
        assert.equal(f.manager.taskStatus(robot.id, accepted.taskId).sessionUrl, accepted.sessionUrl);
        while (!['completed', 'failed'].includes(f.manager.taskStatus(robot.id, accepted.taskId).state)) await new Promise(resolve => setTimeout(resolve, 5));
    }
    const simple = f.manager.startTask(robot, 'simple', { cwd: f.workspace, task: 'Look', ca: 'codex' });
    assert.equal('sessionUrl' in simple, false);
    while (!['completed', 'failed'].includes(f.manager.taskStatus(robot.id, simple.taskId).state)) await new Promise(resolve => setTimeout(resolve, 5));
});

test('a robot named by an email address is told its identity in browser and desktop tasks only', async t => {
    const f = await fixture(t);
    const mailer = { id: 'mailer-a1b2c3', name: 'mailer@example.com', codingAgents: ['codex'] };
    const prompts = {};
    for (const type of ['simple', 'browser', 'desktop']) {
        const { status } = await f.run(mailer, type, { ca: 'codex', systemPrompt: 'Route it' });
        assert.equal(status.state, 'completed', status.error);
        prompts[type] = f.spawns.at(-1).prompt.systemPrompt;
    }
    assert.equal(prompts.simple, 'Route it');
    assert.equal(prompts.browser, `${emailInstructions('mailer@example.com')}\n\nRoute it`);
    assert.equal(prompts.desktop, `${DESKTOP_TASK_INSTRUCTIONS}\n\n${emailInstructions('mailer@example.com')}\n\nRoute it`);
    const plain = { id: 'plain-a1b2c3', name: 'Plain', codingAgents: ['codex'] };
    await f.run(plain, 'browser', { ca: 'codex', systemPrompt: 'Route it' });
    assert.equal(f.spawns.at(-1).prompt.systemPrompt, 'Route it');
});

test('an explicit coding agent is passed on, automatic selection passes none, and a GUI task names its mode', async t => {
    const f = await fixture(t);
    const robot = { id: 'agents-a1b2c3', name: 'Agents', codingAgents: ['codex', 'opencode'] };
    await f.run(robot, 'desktop', { ca: 'opencode' });
    const explicit = f.spawns.at(-1).args;
    assert.equal(value(explicit, '--ca'), 'opencode'); assert.equal(value(explicit, '--gui'), 'desktop');
    for (const request of [{ ca: 'auto' }, {}]) {
        await f.run(robot, 'browser', request);
        const automatic = f.spawns.at(-1).args;
        assert.equal(automatic.includes('--ca'), false); assert.equal(value(automatic, '--gui'), 'browser');
        assert.equal(automatic.includes('--model'), false);
    }
    await f.run(robot, 'simple', { ca: 'codex', mcpServers: ['one=http://127.0.0.1:1/mcp', 'two=http://127.0.0.1:2/mcp'] });
    const simple = f.spawns.at(-1).args;
    assert.equal(simple.includes('--gui'), false);
    assert.equal(value(simple, '--MCPServers'), 'one=http://127.0.0.1:1/mcp,two=http://127.0.0.1:2/mcp');
});

test('an Environment is handed to a Simple task only, after it is checked', async t => {
    const f = await fixture(t);
    const robot = { id: 'environment-a1b2c3', name: 'Environment', codingAgents: ['codex'] };
    await f.run(robot, 'simple', { ca: 'codex', environment: 'repo/agent' });
    assert.deepEqual(f.required, ['repo/agent']);
    assert.equal(value(f.spawns.at(-1).args, '--environment'), 'repo/agent');
    for (const type of ['desktop', 'browser']) {
        await f.run(robot, type, { ca: 'codex', environment: 'repo/agent' });
        assert.equal(f.spawns.at(-1).args.includes('--environment'), false, type);
    }
    assert.deepEqual(f.required, ['repo/agent']);
    await f.run(robot, 'simple', { ca: 'codex' });
    assert.equal(f.spawns.at(-1).args.includes('--environment'), false);
});

test('a workflow task may select an Environment only as a terminal task of a custom workflow', () => {
    const task = extra => ({ id: 'one', name: 'One', prompt: 'Do', skillsets: [], ...extra });
    const workflow = tasks => normalizeWorkflow({ name: 'Custom', tasks, edges: [], entryTaskId: 'one' });
    assert.equal(workflow([task({ executionType: 'terminal', environment: 'repo/agent' })]).tasks[0].environment, 'repo/agent');
    assert.equal('environment' in workflow([task({ executionType: 'terminal', environment: '' })]).tasks[0], false);
    for (const bad of [{ executionType: 'browser', environment: 'repo/agent' }, { executionType: 'desktop', environment: 'repo/agent' },
        { executionType: 'terminal', environment: 'not-a-reference' }, { executionType: 'terminal', environment: '../x/agent' }]) {
        assert.throws(() => workflow([task(bad)]), { statusCode: 400 }, JSON.stringify(bad));
    }
    assert.throws(() => normalizeWorkflow({ name: 'Standard', tasks: [task({ environment: 'repo/agent' })], edges: [] }, { id: 'default', builtin: true }), { statusCode: 400 });
});

test('a workflow prompt larger than the RoboWork run tag limit stays out of the tag and still reaches the wrapper', async t => {
    const f = await fixture(t);
    const robot = { id: 'workflow-a1b2c3', name: 'Workflow', codingAgents: ['codex'] };
    const prompt = 'Previous phase response. '.repeat(8 * 1024);
    const systemPrompt = 'Route by the workflow graph. '.repeat(4 * 1024);
    assert.ok(Buffer.byteLength(prompt) > 128 * 1024);
    const { status } = await f.run(robot, 'simple', { ca: 'codex', task: prompt, systemPrompt,
        workflowRunId: 'add-book-672e9d4e', workflowInstanceId: 'instance-1', ownerPrincipal: 'user:alice' });
    assert.equal(status.state, 'completed', status.error);
    const spawned = f.spawns.at(-1);
    assert.equal(spawned.prompt.prompt, prompt);
    assert.match(spawned.prompt.systemPrompt, /Route by the workflow graph/u);
    const raw = spawned.env.ROBOTEAM_TASK_TAG;
    assert.ok(Buffer.byteLength(raw) < 64 * 1024, `tag is ${Buffer.byteLength(raw)} bytes`);
    const tag = JSON.parse(raw);
    assert.equal('task' in tag.request, false);
    assert.equal('systemPrompt' in tag.request, false);
    assert.equal(tag.request.taskPreview, prompt.slice(0, 1024));
    assert.equal(tag.request.workflowRunId, 'add-book-672e9d4e');
    assert.equal(tag.request.workflowInstanceId, 'instance-1');
    assert.equal(tag.ownerPrincipal, 'user:alice');
    assert.equal(tag.request.ownerPrincipal, 'user:alice');
});
