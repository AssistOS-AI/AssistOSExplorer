import assert from 'node:assert/strict';
import test from 'node:test';

import { controlTaskSession } from '../src/lib/taskSessionControl.mjs';

const TASK = {
    id: 'task_111111111111111111111111',
    targetAgent: 'piAgent',
    status: 'finished',
    continuation: { handle: 'opaque-task-handle', toolName: 'continue-task' },
};

test('task control lists endpoint models and stores only the server-selected execution arguments', async () => {
    const calls = [];
    const clientModule = {
        async createAgentClient(agent) {
            calls.push(['client', agent]);
            return {
                async ensureAgentRunning(target, options) { calls.push(['ensure', target, options]); },
                async getModels() {
                    return {
                        object: 'list',
                        data: [{
                            id: 'pi/gpt-test',
                            displayName: 'GPT Test',
                            execution: { provider: 'pi', model: 'gpt-test' },
                        }],
                    };
                },
            };
        },
    };
    let stored = null;
    const result = await controlTaskSession({
        dir: '/work',
        taskId: TASK.id,
        operation: 'set_model',
        modelKey: 'pi/gpt-test',
        model: 'client-must-not-control-this',
    }, {
        clientModule,
        getTaskImpl: () => TASK,
        setTaskModelImpl: (_dir, _taskId, selection) => {
            stored = selection;
            return {
                ...TASK,
                execution: { model: selection },
                logAppend: 'switched model to: GPT Test\n',
                logOffset: 28,
            };
        },
    });
    assert.deepEqual(stored, {
        key: 'pi/gpt-test',
        provider: 'pi',
        model: 'gpt-test',
        label: 'GPT Test',
        description: 'pi',
    });
    assert.equal(result.model.model, 'gpt-test');
    assert.equal(result.logAppend, 'switched model to: GPT Test\n');
    assert.equal(result.logOffset, 28);
    assert.deepEqual(calls, [
        ['client', 'piAgent'],
        ['ensure', 'piAgent', { mode: 'global' }],
    ]);
});

test('task control rejects arbitrary operations before invoking the target tool', async () => {
    let called = false;
    await assert.rejects(() => controlTaskSession({
        dir: '/work',
        taskId: TASK.id,
        operation: 'execute_command',
    }, {
        getTaskImpl: () => TASK,
        clientModule: {
            async createAgentClient() {
                return {
                    async ensureAgentRunning() {},
                    async callTool() { called = true; },
                };
            },
        },
    }), /unsupported_task_control_operation/);
    assert.equal(called, false);
});

test('task login starts a stopped target agent before invoking its internal adapter', async () => {
    const calls = [];
    const result = await controlTaskSession({
        dir: '/work',
        taskId: TASK.id,
        operation: 'login_describe',
    }, {
        getTaskImpl: () => TASK,
        clientModule: {
            async createAgentClient() {
                return {
                    async ensureAgentRunning(agent, options) { calls.push(['ensure', agent, options]); },
                    async callTool(tool, input) {
                        calls.push(['tool', tool, input.operation]);
                        return { content: [{ type: 'text', text: '{"providers":[]}' }] };
                    },
                };
            },
        },
    });
    assert.deepEqual(result, { providers: [] });
    assert.deepEqual(calls, [
        ['ensure', 'piAgent', { mode: 'global' }],
        ['tool', 'task-session-control', 'login_describe'],
    ]);
});
