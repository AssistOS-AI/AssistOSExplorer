import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeRequest as normalizeLaunch, action as launchWorkflow } from '../src/skills/launch-workflow/scripts/action.mjs';
import { action as listWorkflows } from '../src/skills/list-workflows/scripts/action.mjs';
import fs from 'node:fs';

test('launch-workflow only starts workflows; listing belongs to list-workflows', () => {
    assert.throws(() => normalizeLaunch('list-workflows'), /unsupported workflow action/);
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

test('launch-workflow rejects a list request', async () => {
    assert.match(await launchWorkflow({ promptText: '{"action":"list-workflows"}', agentClient: {} }), /unsupported workflow action/);
});

test('list-workflows reports ids, tasks and the execution types a workflow needs', async () => {
    const calls = [];
    const invocation = {
        promptText: '',
        agentClient: {
            async callToolWithoutWait(tool, args) {
                calls.push([tool, args]);
                return { workflows: [
                    { id: 'default', name: 'Standard development', description: 'One task.', tasks: [{ name: 'Execute objective', supportedExecutionTypes: ['terminal', 'desktop', 'browser'] }] },
                    { id: 'code-development', name: 'Code Development', tasks: [{ name: 'Planning', executionType: 'terminal' }] },
                ] };
            },
            async ensureAgentRunning() {},
        },
    };
    const result = await listWorkflows(invocation);
    assert.deepEqual(calls.map(([tool]) => tool), ['roboflow_list_workflows']);
    assert.match(result, /^- default — Standard development — One task\. Tasks: Execute objective\. Choose executionType when starting: terminal, desktop, browser\.$/m);
    assert.match(result, /^- code-development — Code Development Tasks: Planning \(terminal\)\.$/m);
});

test('list-workflows is a self-contained skill folder', () => {
    const root = new URL('../src/skills/list-workflows/', import.meta.url);
    for (const file of ['SKILL.md', 'scripts/run.mjs', 'scripts/action.mjs', 'scripts/roboTeamClient.mjs', 'scripts/ploinkyInvocation.mjs']) {
        assert.ok(fs.existsSync(new URL(file, root)), file);
    }
    for (const file of fs.readdirSync(new URL('scripts/', root))) {
        assert.doesNotMatch(fs.readFileSync(new URL(`scripts/${file}`, root), 'utf8'), /launch-workflow\//);
    }
});
