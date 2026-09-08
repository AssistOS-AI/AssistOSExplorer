import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ConversationSessionStore } from '../src/lib/conversationSessionStore.mjs';
import { attachTaskToSession } from '../src/lib/webchatRuntime.mjs';
import { createWebchatBackgroundTaskManager } from '../src/lib/webchatBackgroundTasks.mjs';
import { getTask, readTaskLog } from '../src/lib/workspaceTasks.mjs';

for (const failure of ['none', 'session-publication', 'task-publication']) {
    test(`script task attachment tracks logs and completion with ${failure}`, { timeout: 5000 }, async (t) => {
        const workingDir = await fs.mkdtemp(path.join(os.tmpdir(), 'robot-task-attachment-'));
        const store = new ConversationSessionStore({ workingDir });
        const session = await store.ensureCurrentSession();
        const turn = await store.beginTurn({ sessionId: session.sessionId, text: 'Delegate work' });
        const origin = { sessionId: session.sessionId, assistantMessageId: turn.assistantMessageId,
            turnId: 'launch-turn', sourceTabId: 'origin-tab' };
        const envelopes = [];
        const updates = [];
        let calls = 0;
        let complete;
        const completed = new Promise((resolve) => { complete = resolve; });
        const manager = await createWebchatBackgroundTaskManager({ workingDir, emitProtocol: false,
            onTaskStarted: (task, context) => attachTaskToSession(store, task, context, {
                webchat: true,
                write(value) {
                    if (failure === 'session-publication') throw new Error('display failed');
                    envelopes.push(JSON.parse(value));
                },
            }),
            onPublish(event) {
                if (failure === 'task-publication' && event.event === 'started') throw new Error('display failed');
                updates.push(event);
                if (event.task?.status === 'finished') complete(event);
            },
            agentClientModule: {
                setAgentTaskObserver() { return () => {}; },
                async createAgentClient() { return {
                    async getTaskStatus() {
                        return ++calls === 1 ? { status: 'running' } : {
                            status: 'completed', logSeq: 1, logTail: 'Child inspected the page.',
                            result: { content: [{ type: 'text', text: 'Child result.' }] },
                        };
                    },
                }; },
            },
        });
        t.after(async () => { manager.close(); await fs.rm(workingDir, { recursive: true, force: true }); });
        const waiter = manager.createTaskStartWaiter(origin);
        const task = await manager.observeScriptTask({ agentName: 'worker', taskId: 'remote-task',
            toolName: 'execute-task', arguments: { task: 'Inspect page' } }, origin);
        assert.equal((await waiter.promise).id, task.id);
        const final = await completed;
        assert.equal(final.finalOutput, 'Child result.');
        assert.equal(final.log.tail, 'Child inspected the page.');
        assert.equal(getTask(workingDir, task.id).status, 'finished');
        assert.ok(JSON.stringify(readTaskLog(workingDir, task.id)).includes('Child inspected the page.'));
        const saved = store.loadSession(session.sessionId);
        assert.ok(saved.messages.some((message) => message.type === 'task' && message.taskId === task.id));
        assert.deepEqual(saved.messages.find((message) => message.id === turn.assistantMessageId).progress, []);
        if (failure !== 'session-publication') {
            assert.equal(envelopes[0].session.sessionId, session.sessionId);
            assert.equal(envelopes[0].targetTabId, 'origin-tab');
            assert.equal(envelopes[0].summary.hasHistory, true);
        }
        assert.ok(updates.some((event) => event.task?.assistantMessageId === turn.assistantMessageId));
    });
}
