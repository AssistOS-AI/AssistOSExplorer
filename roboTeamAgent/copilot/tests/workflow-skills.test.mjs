import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeRequest as normalizeLaunch, action as launchWorkflow } from '../src/skills/launch-workflow/scripts/action.mjs';

test('launch-workflow parses JSON and command forms', () => {
    assert.deepEqual(normalizeLaunch('{"action":"list-workflows"}'), { action: 'list-workflows' });
    assert.deepEqual(normalizeLaunch('start software-change :: Add OAuth'), {
        action: 'start', workflowTypeId: 'software-change', objective: 'Add OAuth',
    });
    assert.deepEqual(normalizeLaunch('{"action":"start","workflowTypeId":"default","objective":"Do it"}'), {
        action: 'start', workflowTypeId: 'default', objective: 'Do it',
    });
    assert.throws(() => normalizeLaunch('invoke x y'), /unsupported workflow action/);
});

test('launch-workflow reports a failed request without throwing', async () => {
    assert.match(await launchWorkflow({ promptText: 'unknown' }), /Could not run the workflow action/);
});

test('launch-workflow start returns immediately without waiting for the flow task', async () => {
    let waited = false;
    const invocation = {
        promptText: JSON.stringify({ action: 'start', workflowTypeId: 'default', objective: 'Do it' }),
        workingDir: '/workspace',
        agentClient: {
            async callToolWithoutWait(tool) {
                assert.equal(tool, 'roboflow_start_flow');
                return { metadata: { taskId: 'task-1' } };
            },
            async getTaskStatus() { waited = true; throw new Error('must not poll the task'); },
            async ensureAgentRunning() {},
        },
    };
    const result = await launchWorkflow(invocation);
    assert.match(result, /workflow started/i);
    assert.equal(waited, false);
});
