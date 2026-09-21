import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import test from 'node:test';

import { RoboFlowService } from '../server/roboflow/roboflow-service.mjs';
import { WorkflowRegistry, normalizeWorkflow } from '../server/roboflow/workflow-registry.mjs';
import { TaskFlowStore } from '../server/roboflow/task-flow-store.mjs';

async function fixture(t) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'roboflow-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const workspace = path.join(root, 'workspace');
    await fs.mkdir(workspace, { recursive: true });
    const robots = new Map([
        ['implementer', { id: 'implementer-0001', name: 'implementer', codingAgents: ['codex'] }],
        ['reviewer', { id: 'reviewer-0001', name: 'reviewer', codingAgents: ['codex'] }],
    ]);
    const robotStore = {
        async getByName(name) { return robots.get(name) || null; },
        async get(id) { return [...robots.values()].find((robot) => robot.id === id) || null; },
        async list() { return [...robots.values()]; },
    };
    const started = [];
    const stopped = [];
    let counter = 0;
    const runtimeManager = {
        workspaceRoot: workspace,
        async resolveCwd(value) {
            const resolved = path.resolve(String(value || ''));
            if (resolved !== workspace && !resolved.startsWith(`${workspace}${path.sep}`)) throw new Error('cwd must stay inside the enabled Ploinky workspace');
            return resolved;
        },
        startTask(robot, type, request) {
            counter += 1;
            const taskId = `task-${counter}`;
            started.push({ taskId, robotName: robot.name, type, request });
            return { taskId, state: 'queued' };
        },
        stopTask(robot, type, taskId) { stopped.push({ robotName: robot.name, type, taskId }); return { taskId }; },
    };
    const service = new RoboFlowService({
        robotStore,
        runtimeManager,
        registry: new WorkflowRegistry({ directory: path.join(root, 'workflows') }),
        store: new TaskFlowStore({ directory: path.join(root, 'flows') }),
    });
    await service.initialize();
    return { root, workspace, service, started, stopped, robots };
}

const WORKFLOW = {
    id: 'software-change',
    name: 'Software change',
    description: 'Implement and review a change',
    members: [
        { id: 'impl', robotName: 'implementer', executionType: 'terminal', role: 'Implements', skillSets: [], skills: [] },
        { id: 'qa', robotName: 'reviewer', executionType: 'desktop', role: 'Reviews' },
    ],
};

test('workflow normalization rejects invalid members', () => {
    assert.throws(() => normalizeWorkflow({ name: 'example', members: [] }), /at least one member/);
    assert.throws(() => normalizeWorkflow({ name: 'example', members: [{ robotName: 'a', executionType: 'ssh' }] }), /executionType/);
    const normalized = normalizeWorkflow(WORKFLOW);
    assert.equal(normalized.members[0].id, 'impl');
});

test('create workflow validates member robots and accepts any declared execution type', async (t) => {
    const f = await fixture(t);
    await f.robots.set('legacy', { id: 'legacy-0001', name: 'legacy', codingAgents: ['opencode'] });
    await assert.rejects(() => f.service.createWorkflow({
        name: 'missing', members: [{ robotName: 'ghost', executionType: 'terminal' }],
    }), /does not exist/);
    const gui = await f.service.createWorkflow({
        id: 'gui-team', name: 'gui team', members: [{ robotName: 'legacy', executionType: 'desktop' }],
    });
    assert.equal(gui.members[0].executionType, 'desktop');
    const workflow = await f.service.createWorkflow(WORKFLOW);
    assert.equal(workflow.id, 'software-change');
    assert.equal((await f.service.listWorkflows()).length, 2);
});

test('task flow captures full logs, exposes summaries, and advances', async (t) => {
    const f = await fixture(t);
    await f.service.createWorkflow(WORKFLOW);
    const flow = await f.service.createFlow({ workflowTypeId: 'software-change', objective: 'Add OAuth', folder: f.workspace });
    assert.equal(flow.status, 'active');

    const started = await f.service.invokeMember(flow.id, { member: 'impl', instruction: 'Implement OAuth' });
    assert.equal(started.robotName, 'implementer');
    assert.equal(f.started[0].type, 'simple');

    f.service.onRuntimeTaskEvent({ kind: 'state', taskId: started.runtimeTaskId, state: 'running' });
    f.service.onRuntimeTaskEvent({ kind: 'progress', taskId: started.runtimeTaskId, chunk: 'working...\n' });
    f.service.onRuntimeTaskEvent({ kind: 'terminal', taskId: started.runtimeTaskId, state: 'completed', result: 'done: added routes', error: null });

    const outcome = await f.service.waitForInvocation(flow.id, started.invocationId);
    assert.equal(outcome.state, 'completed');
    assert.equal(outcome.summary, 'done: added routes');

    const summary = await f.service.getFlow(flow.id, { logMode: 'none' });
    assert.equal(summary.invocations.length, 1);
    assert.equal(summary.invocations[0].summary, 'done: added routes');
    assert.equal(summary.invocations[0].log, undefined);

    const log = await f.service.getInvocationLog(flow.id, started.invocationId);
    assert.match(log, /working\.\.\./);

    const tail = await f.service.getFlow(flow.id, { logMode: 'tail' });
    assert.match(tail.invocations[0].logTail, /working\.\.\./);

    await f.service.finishFlow(flow.id, 'shipped');
    const done = await f.service.getFlow(flow.id, { logMode: 'none' });
    assert.equal(done.status, 'done');
    assert.equal(done.result, 'shipped');
});

test('invoke rejects members outside the workflow and inactive flows', async (t) => {
    const f = await fixture(t);
    await f.service.createWorkflow(WORKFLOW);
    const flow = await f.service.createFlow({ workflowTypeId: 'software-change', objective: 'x', folder: f.workspace });
    await assert.rejects(() => f.service.invokeMember(flow.id, { member: 'ghost', instruction: 'x' }), /not part of this workflow/);
    await f.service.finishFlow(flow.id, '');
    await assert.rejects(() => f.service.invokeMember(flow.id, { member: 'impl', instruction: 'x' }), /not active/);
});

test('stop flow cancels the active runtime task and marks invocations stopped', async (t) => {
    const f = await fixture(t);
    await f.service.createWorkflow(WORKFLOW);
    const flow = await f.service.createFlow({ workflowTypeId: 'software-change', objective: 'x', folder: f.workspace });
    const started = await f.service.invokeMember(flow.id, { member: 'qa', instruction: 'Review' });
    assert.equal(f.started[0].type, 'desktop');
    await f.service.stopFlow(flow.id);
    assert.equal(f.stopped.length, 1);
    const stopped = await f.service.getFlow(flow.id, { logMode: 'none' });
    assert.equal(stopped.status, 'stopped');
    assert.equal(stopped.invocations[0].state, 'stopped');
});

test('service restart marks unfinished invocations interrupted', async (t) => {
    const f = await fixture(t);
    await f.service.createWorkflow(WORKFLOW);
    const flow = await f.service.createFlow({ workflowTypeId: 'software-change', objective: 'x', folder: f.workspace });
    await f.service.invokeMember(flow.id, { member: 'impl', instruction: 'x' });

    const revived = new RoboFlowService({
        robotStore: { async getByName() { return null; }, async get() { return null; }, async list() { return []; } },
        runtimeManager: f.service.runtimeManager,
        registry: f.service.registry,
        store: f.service.store,
    });
    await revived.initialize();
    const recovered = await revived.getFlow(flow.id, { logMode: 'none' });
    assert.equal(recovered.invocations[0].state, 'interrupted');
});
