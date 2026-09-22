import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import test from 'node:test';

import { RoboFlowService } from '../server/roboflow/roboflow-service.mjs';
import { WorkflowRegistry, normalizeWorkflow } from '../server/roboflow/workflow-registry.mjs';
import { TaskFlowStore } from '../server/roboflow/task-flow-store.mjs';
import { ensureDefaultWorkflow } from '../server/roboflow/default-workflow.mjs';

async function waitFor(predicate, { attempts = 3000 } = {}) {
    for (let index = 0; index < attempts; index += 1) {
        const value = await predicate();
        if (value) return value;
        await new Promise((resolve) => setImmediate(resolve));
    }
    throw new Error('condition was not met');
}

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
    decisionMemberId: 'impl',
    members: [
        { id: 'impl', robotName: 'implementer', executionType: 'terminal', role: 'Implements', skillSets: [], skills: [] },
        { id: 'qa', robotName: 'reviewer', executionType: 'desktop', role: 'Reviews' },
    ],
};

test('workflow normalization requires members, a valid decision member and execution types', () => {
    assert.throws(() => normalizeWorkflow({ name: 'example', members: [] }), /at least one member/);
    assert.throws(() => normalizeWorkflow({ name: 'example', members: [{ robotName: 'a', executionType: 'ssh' }] }), /executionType/);
    assert.throws(() => normalizeWorkflow({ name: 'example', members: [{ robotName: 'a', executionType: 'terminal' }] }), /decision member/);
    const normalized = normalizeWorkflow(WORKFLOW);
    assert.equal(normalized.members[0].id, 'impl');
    assert.equal(normalized.decisionMemberId, 'impl');
    const flagged = normalizeWorkflow({ name: 'flagged', members: [
        { robotName: 'a', executionType: 'terminal' },
        { robotName: 'b', executionType: 'terminal', decisionMaker: true },
    ] });
    assert.equal(flagged.decisionMemberId, 'b-2');
});

test('create workflow validates member robots and requires a decision member', async (t) => {
    const f = await fixture(t);
    await assert.rejects(() => f.service.createWorkflow({
        name: 'missing', decisionMemberId: 'ghost-1', members: [{ robotName: 'ghost', executionType: 'terminal' }],
    }), /does not exist/);
    const workflow = await f.service.createWorkflow(WORKFLOW);
    assert.equal(workflow.id, 'software-change');
    const catalog = await f.service.listWorkflowCatalog();
    assert.equal(catalog.length, 1);
    assert.equal(catalog[0].members[0].decisionMaker, true);
    assert.equal(catalog[0].members.find((member) => member.id === 'qa').executionType, 'desktop');
});

test('start flow runs the decision robot and advances after member runs finish', async (t) => {
    const f = await fixture(t);
    await f.service.createWorkflow(WORKFLOW);
    const flow = await f.service.startFlow({ workflowTypeId: 'software-change', objective: 'Add OAuth', folder: f.workspace });
    assert.equal(flow.status, 'running');

    const decision = await waitFor(() => f.started.find((task) => task.request.task.includes('Flow id')));
    assert.equal(decision.robotName, 'implementer');
    assert.equal(decision.type, 'simple');

    // The decision robot launches a member (non-blocking) and its turn ends.
    const launched = await f.service.launchMember(flow.id, { member: 'qa', instruction: 'Review OAuth' });
    assert.equal(launched.robotName, 'reviewer');
    assert.equal(launched.executionType, 'desktop');
    assert.equal(f.started.find((task) => task.taskId === launched.runtimeTaskId).type, 'desktop');

    f.service.onRuntimeTaskEvent({ kind: 'terminal', taskId: decision.taskId, state: 'completed', result: 'launching qa', error: null });
    await waitFor(async () => (await f.service.getFlow(flow.id, { logMode: 'none' })).awaitingStep === 0);
    let snapshot = await f.service.getFlow(flow.id, { logMode: 'none' });
    assert.equal(snapshot.awaitingStep, 0);

    f.service.onRuntimeTaskEvent({ kind: 'terminal', taskId: launched.runtimeTaskId, state: 'completed', result: 'looks good', error: null });
    await waitFor(async () => (await f.service.getFlow(flow.id, { logMode: 'none' })).steps.length === 2);
    snapshot = await f.service.getFlow(flow.id, { logMode: 'none' });
    assert.equal(snapshot.invocations[0].summary, 'looks good');
    assert.equal(snapshot.steps.length, 2);
    assert.equal(snapshot.currentStep, 1);

    // The decision robot finishes the flow.
    await f.service.finishFlow(flow.id, 'shipped');
    const done = await f.service.getFlow(flow.id, { logMode: 'none' });
    assert.equal(done.status, 'completed');
    assert.equal(done.result, 'shipped');
});

test('launch rejects members outside the workflow and terminal flows', async (t) => {
    const f = await fixture(t);
    await f.service.createWorkflow(WORKFLOW);
    const flow = await f.service.startFlow({ workflowTypeId: 'software-change', objective: 'x', folder: f.workspace });
    await assert.rejects(() => f.service.launchMember(flow.id, { member: 'ghost', instruction: 'x' }), /not part of this workflow/);
    await f.service.finishFlow(flow.id, '');
    await assert.rejects(() => f.service.launchMember(flow.id, { member: 'impl', instruction: 'x' }), /not running/);
});

test('stop flow cancels active runs and marks them stopped', async (t) => {
    const f = await fixture(t);
    await f.service.createWorkflow(WORKFLOW);
    const flow = await f.service.startFlow({ workflowTypeId: 'software-change', objective: 'x', folder: f.workspace });
    await waitFor(() => f.started.find((task) => task.request.task.includes('Flow id')));
    const launched = await f.service.launchMember(flow.id, { member: 'qa', instruction: 'Review' });
    await f.service.stopFlow(flow.id);
    assert.ok(f.stopped.some((entry) => entry.taskId === launched.runtimeTaskId));
    const stopped = await f.service.getFlow(flow.id, { logMode: 'none' });
    assert.equal(stopped.status, 'stopped');
    assert.equal(stopped.invocations[0].state, 'stopped');
});

test('default workflow is ensured with three default-robot members and a decision member', async (t) => {
    const f = await fixture(t);
    await f.robots.set('default', { id: 'default-0001', name: 'default', codingAgents: ['codex'] });
    const first = await ensureDefaultWorkflow(f.service.registry);
    assert.equal(first.id, 'default');
    assert.equal(first.decisionMemberId, 'default-terminal');
    assert.deepEqual(first.members.map((member) => member.id), ['default-terminal', 'default-browser', 'default-desktop']);
    assert.ok(first.members.every((member) => member.robotName === 'default'));
    assert.deepEqual(first.members.map((member) => member.executionType), ['terminal', 'browser', 'desktop']);
    const second = await ensureDefaultWorkflow(f.service.registry);
    assert.equal(second.createdAt, first.createdAt);
});

test('updating a workflow replaces its definition and the default workflow cannot be deleted', async (t) => {
    const f = await fixture(t);
    await ensureDefaultWorkflow(f.service.registry);
    await f.service.createWorkflow(WORKFLOW);
    const updated = await f.service.updateWorkflow('software-change', {
        name: 'Software change v2',
        description: 'Updated team',
        decisionMemberId: 'qa',
        members: [
            { id: 'impl', robotName: 'implementer', executionType: 'terminal' },
            { id: 'qa', robotName: 'reviewer', executionType: 'browser', role: 'Verifies' },
        ],
    });
    assert.equal(updated.id, 'software-change');
    assert.equal(updated.name, 'Software change v2');
    assert.equal(updated.decisionMemberId, 'qa');
    assert.equal(updated.members[1].executionType, 'browser');
    assert.equal(updated.members[1].role, 'Verifies');
    const stored = await f.service.getWorkflow('software-change');
    assert.equal(stored.createdAt, updated.createdAt);
    assert.equal(await f.service.deleteWorkflow('software-change'), true);
    assert.equal(await f.service.getWorkflow('software-change'), null);
    await assert.rejects(f.service.deleteWorkflow('default'), /cannot be deleted/);
    await assert.rejects(() => f.service.updateWorkflow('default', {
        name: 'Default v2', decisionMemberId: 'default-terminal',
        members: [{ id: 'default-terminal', robotName: 'implementer', executionType: 'terminal' }],
    }), /cannot be edited/);
    assert.ok(await f.service.getWorkflow('default'));
    await assert.rejects(() => f.service.updateWorkflow('missing', {
        name: 'x', decisionMemberId: 'm', members: [{ id: 'm', robotName: 'implementer', executionType: 'terminal' }],
    }), /not found/);
});

test('decision tasks receive the configured skillsets and the internal MCP capability', async (t) => {
    const f = await fixture(t);
    const calls = [];
    let counter = 0;
    f.service.skillsets = {
        start(robot, input, enqueue) {
            calls.push({ robotName: robot.name, skillSets: input.skillSets, skills: input.skills });
            counter += 1;
            return enqueue(robot, { policyId: `policy-${counter}` });
        },
    };
    f.service.decisionMcpServers = 'roboTeamAgent=http://127.0.0.1:7000/mcp';
    await f.service.createWorkflow({
        ...WORKFLOW,
        members: [
            { id: 'impl', robotName: 'implementer', executionType: 'terminal', skillSets: ['copilot'], skills: ['a/b'] },
            { id: 'qa', robotName: 'reviewer', executionType: 'desktop', skillSets: [], skills: [] },
        ],
    });
    const flow = await f.service.startFlow({ workflowTypeId: 'software-change', objective: 'x', folder: f.workspace });
    await waitFor(() => calls.length >= 1);
    assert.deepEqual(calls[0].skillSets, ['copilot']);
    assert.deepEqual(calls[0].skills, ['a/b']);
    assert.equal(f.started[0].request.mcpServers, 'roboTeamAgent=http://127.0.0.1:7000/mcp');
    await f.service.launchMember(flow.id, { member: 'qa', instruction: 'Review' });
    assert.deepEqual(calls[1].skillSets, []);
    assert.deepEqual(calls[1].skills, []);
    assert.equal(f.started[1].request.mcpServers, undefined);
});

test('service restart fails unfinished flows', async (t) => {
    const f = await fixture(t);
    await f.service.createWorkflow(WORKFLOW);
    const flow = await f.service.startFlow({ workflowTypeId: 'software-change', objective: 'x', folder: f.workspace });
    await waitFor(() => f.started.find((task) => task.request.task.includes('Flow id')));

    const revived = new RoboFlowService({
        robotStore: f.service.robotStore,
        runtimeManager: f.service.runtimeManager,
        registry: f.service.registry,
        store: f.service.store,
    });
    await revived.initialize();
    const recovered = await revived.getFlow(flow.id, { logMode: 'none' });
    assert.equal(recovered.status, 'failed');
    assert.match(recovered.error, /service restart/);
});
