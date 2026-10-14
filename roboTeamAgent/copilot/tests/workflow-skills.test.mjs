import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeRequest as normalizeLaunch, action as launchWorkflow } from '../src/skills/launch-workflow/scripts/action.mjs';
import { action as listWorkflows } from '../src/skills/list-workflows/scripts/action.mjs';
import fs from 'node:fs';

test('launch-workflow takes only a workflow name and an optional prompt', () => {
    assert.deepEqual(normalizeLaunch('daily-report'), { workflow: 'daily-report', prompt: '' });
    assert.deepEqual(normalizeLaunch('software-change :: Add OAuth'), { workflow: 'software-change', prompt: 'Add OAuth' });
    assert.deepEqual(normalizeLaunch('{"workflow":"default","prompt":"Do it"}'), { workflow: 'default', prompt: 'Do it' });
    assert.deepEqual(normalizeLaunch('{"workflow":"default","prompt":"Do it","executionType":"browser"}'), { workflow: 'default', prompt: 'Do it', executionType: 'browser' });
    assert.throws(() => normalizeLaunch(''), /workflow name is required/);
    // Another request format is named, with the expected one.
    assert.throws(() => normalizeLaunch('{"action":"start","workflowTypeId":"default","objective":"Do it"}'),
        /unknown field action, workflowTypeId, objective; the JSON request is \{"workflow":"<id from list-workflows>","prompt":/);
    assert.throws(() => normalizeLaunch('{"prompt":"Do it"}'), /workflow name is required; the JSON request is/);
});

test('launch-workflow accepts executionType only for the default workflow', async () => {
    const calls = [], agentClient = { ensureAgentRunning: async () => {}, callToolWithoutWait: async (tool, args) => { calls.push(args); return {}; } };
    const run = (request) => launchWorkflow({ promptText: JSON.stringify(request), workingDir: '/workspace', agentClient });
    assert.match(await run({ workflow: 'default', prompt: 'Check UI', executionType: 'browser' }), /workflow started/i);
    assert.equal(calls[0].executionType, 'browser');
    assert.match(await run({ workflow: 'code-development', prompt: 'Add OAuth', executionType: 'terminal' }), /only for the default workflow/);
    assert.match(await run({ workflow: 'default', prompt: 'Do it', executionType: 'gui' }), /must be one of/);
    assert.equal(calls.length, 1);
});

test('launch-workflow reports a failed request without throwing', async () => {
    assert.match(await launchWorkflow({ promptText: 'invoke x y' }), /Could not start the workflow/);
});

test('launch-workflow returns immediately and runs default in a terminal', async () => {
    const calls = [];
    let waited = false;
    const invocation = {
        promptText: JSON.stringify({ workflow: 'default', prompt: 'Do it' }),
        workingDir: '/workspace',
        agentClient: {
            async callToolWithoutWait(tool, args) { calls.push([tool, args]); return { metadata: { taskId: 'task-1' } }; },
            async getTaskStatus() { waited = true; throw new Error('must not poll the task'); },
            async ensureAgentRunning() {},
        },
    };
    assert.match(await launchWorkflow(invocation), /workflow started/i);
    assert.equal(waited, false);
    assert.deepEqual(calls, [['roboflow_start_flow', { workflowTypeId: 'default', executionType: 'terminal', objective: 'Do it', folder: '/workspace' }]]);
});

test('list-workflows reports ids, tasks and the execution types a workflow needs', async () => {
    const calls = [];
    const invocation = {
        promptText: '',
        agentClient: {
            async callToolWithoutWait(tool, args) {
                calls.push([tool, args]);
                return { workflows: [
                    { id: 'default', name: 'Standard development', description: 'One task.', kind: 'default', tasks: [{ name: 'Execute objective', supportedExecutionTypes: ['terminal', 'desktop', 'browser'] }] },
                    { id: 'code-development', name: 'Code Development', tasks: [{ name: 'Planning', executionType: 'terminal' }] },
                ] };
            },
            async ensureAgentRunning() {},
        },
    };
    const result = await listWorkflows(invocation);
    assert.deepEqual(calls.map(([tool]) => tool), ['roboflow_list_workflows']);
    assert.match(result, /^- default — Standard development — One task\. Tasks: Execute objective\. Accepts executionType terminal \(default\), desktop or browser\. Requires a prompt when starting\.$/m);
    assert.match(result, /^- code-development — Code Development Tasks: Planning \(terminal\)\. Requires a prompt when starting\.$/m);
});
test('launch-workflow may inherit a saved prompt but never invents generic work', async () => {
    const calls = [], agentClient = { ensureAgentRunning: async () => {}, callToolWithoutWait: async (tool, args) => { calls.push(args); return {}; } };
    for (const objective of [undefined, 'Changed scope']) {
        const result = await launchWorkflow({ promptText: JSON.stringify({ workflow: 'daily-report', prompt: objective }), workingDir: '/workspace', agentClient });
        assert.match(result, /workflow started/i);
    }
    assert.equal(Object.hasOwn(calls[0], 'objective'), false); assert.equal(calls[1].objective, 'Changed scope');
    assert.equal(calls[0].folder, '/workspace');
    for (const workflowTypeId of ['default', 'code-development']) assert.match(await launchWorkflow({ promptText: workflowTypeId, workingDir: '/workspace', agentClient }), /requires a prompt/);
    assert.equal(calls.length, 2);
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
