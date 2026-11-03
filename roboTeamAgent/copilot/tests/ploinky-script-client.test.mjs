import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createPloinkyTaskContext } from '../src/lib/ploinky/ploinkyTaskContext.mjs';
import { createSkillInvocation } from '../src/skills/launch-gpt-researcher/scripts/ploinkyInvocation.mjs';
import { action } from '../src/skills/launch-gpt-researcher/scripts/action.mjs';
import { RunChannels } from '../../../roboWorkAgent/server/run-channels.mjs';
import { createWebchatBackgroundTaskManager } from '../src/lib/webchat/webchatBackgroundTasks.mjs';

test('script task receipts attach authenticated observers to their originating chat turn', async (t) => {
    const workingDir = await fs.mkdtemp(path.join(os.tmpdir(), 'script-observer-'));
    // RoboTeam runs inside a configured Ploinky workspace; the fixture provides one.
    const previousRoot = process.env.PLOINKY_WORKSPACE_ROOT;
    process.env.PLOINKY_WORKSPACE_ROOT = path.dirname(workingDir);
    let manager;
    t.after(async () => {
        if (previousRoot === undefined) delete process.env.PLOINKY_WORKSPACE_ROOT; else process.env.PLOINKY_WORKSPACE_ROOT = previousRoot;
        manager?.close();
        await fs.rm(workingDir, { recursive: true, force: true });
    });
    const started = [];
    const reads = [];
    manager = await createWebchatBackgroundTaskManager({ workingDir, emitProtocol: false,
        onTaskStarted: (task, origin) => started.push({ task, origin }),
        agentClientModule: {
            setAgentTaskObserver() { return () => {}; },
            async createAgentClient(agent) { return {
                async getTaskStatus(id) { reads.push([agent, id]); return { id, status: id === 'missing' ? 'not_found' : 'queued' }; },
            }; },
        },
    });
    const origin = { workingDir, sessionId: 'session-a', turnId: 'turn-a', assistantMessageId: 'message-a' };
    await manager.observeScriptTask({ agentName: 'GPTResearcher', taskId: 'remote-a', toolName: 'execute-task', arguments: { prompt: 'Review' } }, origin);
    assert.deepEqual(reads[0], ['GPTResearcher', 'remote-a']);
    assert.equal(started[0].origin.sessionId, 'session-a');
    assert.equal(started[0].origin.assistantMessageId, 'message-a');
    await assert.rejects(manager.observeScriptTask({ agentName: 'GPTResearcher', taskId: 'missing', toolName: 'execute-task' }, origin), /script_task_not_found/);
});

test('launch scripts call the task callback and publish task receipts through the run channel', async (t) => {
    const workingDir = await fs.mkdtemp(path.join(os.tmpdir(), 'direct-ploinky-test-'));
    const channelRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'rw-'));
    let context;
    let channels;
    let serving;
    t.after(async () => {
        clearInterval(serving);
        try {
            await channels?.close();
            await context?.close();
        } finally {
            await fs.rm(workingDir, { recursive: true, force: true });
            await fs.rm(channelRoot, { recursive: true, force: true });
        }
    });
    const tasks = [];
    const calls = [];
    context = await createPloinkyTaskContext({ context: { workingDir }, robotId: 'robot-a', env: { PLOINKY_MASTER_KEY: 'must-not-copy' },
        onTask: (task) => tasks.push(task),
        createClient: async (agentName) => ({
            ensureAgentRunning: async (ref) => calls.push({ ref }),
            async callToolWithoutWait(toolName, input) {
                calls.push({ agentName, toolName, input });
                return { metadata: { taskId: 'remote-task' } };
            },
        }) });
    // RoboWork serves the run's channel; the controller answers each callback through the task context.
    channels = new RunChannels({ directory: path.join(channelRoot, 'channels'), definitions: [{ name: 'ploinky-runtime', context: context.context }] });
    const [mount] = await channels.prepare();
    const answered = new Set();
    serving = setInterval(() => {
        for (const callback of channels.list()) {
            if (answered.has(callback.id)) continue;
            answered.add(callback.id);
            context.dispatch(callback).then((body) => channels.reply({ id: callback.id, body }),
                (error) => channels.reply({ id: callback.id, status: error.statusCode || 403, body: { error: error.message } }));
        }
    }, 10);
    assert.equal((await fs.readFile(path.join(mount.source, 'context.json'), 'utf8')).includes('must-not-copy'), false);
    assert.deepEqual((await fs.readdir(mount.source)).sort(), ['context.json', 'request.sock', 'tasks.sock']);
    const invocation = await createSkillInvocation({ skillName: 'launch-gpt-researcher', input: 'Review', contextDirectory: mount.source });
    assert.equal(await action(invocation), 'Task started.');
    assert.equal(calls.at(-1).input.workingDir, workingDir);
    assert.equal(calls.at(-1).agentName, 'GPTResearcher');
    await invocation.close();
    assert.equal(tasks[0].taskId, 'remote-task');
});
