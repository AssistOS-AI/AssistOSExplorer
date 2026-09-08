import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createPloinkyTaskContext } from '../src/lib/ploinkyTaskContext.mjs';
import { createSkillInvocation } from '../src/skills/launch-robot/scripts/ploinkyInvocation.mjs';
import { action } from '../src/skills/launch-gpt-researcher/scripts/action.mjs';
import { createWebchatBackgroundTaskManager } from '../src/lib/webchatBackgroundTasks.mjs';

test('script task receipts attach authenticated observers to their originating chat turn', async (t) => {
    const workingDir = await fs.mkdtemp(path.join(os.tmpdir(), 'script-observer-'));
    t.after(() => fs.rm(workingDir, { recursive: true, force: true }));
    const started = [];
    const reads = [];
    const manager = await createWebchatBackgroundTaskManager({ workingDir, emitProtocol: false,
        onTaskStarted: (task, origin) => started.push({ task, origin }),
        agentClientModule: {
            setAgentTaskObserver() { return () => {}; },
            async createAgentClient(agent) { return {
                async getTaskStatus(id) { reads.push([agent, id]); return { id, status: id === 'missing' ? 'not_found' : 'queued' }; },
            }; },
        },
    });
    t.after(() => manager.close());
    const origin = { workingDir, sessionId: 'session-a', turnId: 'turn-a', assistantMessageId: 'message-a' };
    await manager.observeScriptTask({ agentName: 'GPTResearcher', taskId: 'remote-a', toolName: 'execute-task', arguments: { prompt: 'Review' } }, origin);
    assert.deepEqual(reads[0], ['GPTResearcher', 'remote-a']);
    assert.equal(started[0].origin.sessionId, 'session-a');
    assert.equal(started[0].origin.assistantMessageId, 'message-a');
    await assert.rejects(manager.observeScriptTask({ agentName: 'GPTResearcher', taskId: 'missing', toolName: 'execute-task' }, origin), /script_task_not_found/);
});

test('launch scripts call the Ploinky SDK directly and publish task receipts without sockets', async (t) => {
    const workingDir = await fs.mkdtemp(path.join(os.tmpdir(), 'direct-ploinky-test-'));
    t.after(() => fs.rm(workingDir, { recursive: true, force: true }));
    const tasks = [];
    const context = await createPloinkyTaskContext({ context: { workingDir }, env: { PLOINKY_MASTER_KEY: 'must-not-copy' }, onTask: (task) => tasks.push(task) });
    t.after(() => context.close());
    assert.equal((await fs.readFile(path.join(context.directory, 'context.json'), 'utf8')).includes('must-not-copy'), false);
    assert.deepEqual((await fs.readdir(context.directory)).sort(), ['context.json', 'events']);
    let observer;
    const calls = [];
    const sdk = {
        setAgentTaskObserver(callback) { observer = callback; return () => { observer = null; }; },
        async createAgentClient(agentName) { return {
            ensureAgentRunning: async (ref) => calls.push({ ref }),
            async callToolWithoutWait(toolName, input) {
                calls.push({ agentName, toolName, input });
                await observer({ agentName, toolName, taskId: 'remote-task', arguments: input, metadata: { status: 'queued' } });
                return { metadata: { taskId: 'remote-task' } };
            },
        }; },
    };
    const invocation = await createSkillInvocation({ skillName: 'launch-gpt-researcher', input: 'Review', contextDirectory: context.directory, sdk });
    assert.equal(await action(invocation), 'Task started.');
    assert.equal(calls.at(-1).input.workingDir, workingDir);
    assert.equal(calls.at(-1).agentName, 'GPTResearcher');
    await invocation.close();
    await context.close();
    assert.equal(tasks[0].taskId, 'remote-task');
});
