import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { RoboFlowService } from '../server/roboflow/roboflow-service.mjs';
import { normalizeWorkflow } from '../server/roboflow/graph.mjs';
import { parseRoute } from '../server/roboflow/result-parser.mjs';
import { coverage, canonicalSkillset } from '../server/roboflow/skill-matching.mjs';

const task = (id, extras = {}) => ({ id, name: id, description: `Execute ${id}`, executionType: 'terminal', skillsets: [], ...extras });
const edge = (sourceTaskId, targetTaskId) => ({ id: `${sourceTaskId}-${targetTaskId}`, sourceTaskId, targetTaskId });
const graph = () => ({ id: 'example', name: 'Example', entryTaskId: 'a', tasks: [task('a'), task('b'), task('c')], edges: [edge('a', 'b'), edge('a', 'c'), edge('b', 'a')] });
async function fixture(t, options = {}) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'roboflow-graph-'));
    const robots = [{ id: 'default-id', name: 'default', codingAgents: ['codex'] }, { id: 'worker-id', name: 'worker', codingAgents: ['codex'] }];
    const started = [], stopped = [];
    const robotStore = { list: async () => robots, getByName: async name => robots.find(robot => robot.name === name), get: async id => robots.find(robot => robot.id === id) };
    const runtimeManager = { resolveCwd: async value => value || root,
        startTask(robot, type, request) { started.push({ robot, type, request, taskId: request.runtimeTaskId }); return { taskId: request.runtimeTaskId, state: 'queued' }; },
        stopTask(robot, type, id) { stopped.push(id); }, guiBusy: options.guiBusy || (() => false) };
    const service = new RoboFlowService({ robotStore, runtimeManager, databaseFile: path.join(root, 'roboflow.sqlite'), workflowsDirectory: path.join(root, 'old'), random: () => .99,
        discoverSkillsets: async () => ({ skillsets: [], diagnostics: [] }), ...options });
    await service.initialize();
    t.after(async () => { await service.close(); await fs.rm(root, { recursive: true, force: true }); });
    async function finish(index, result = 'Done', state = 'completed') {
        service.onRuntimeTaskEvent({ kind: 'terminal', taskId: started[index].taskId, result, state });
        while (service.chains.size) await Promise.allSettled(service.chains.values());
    }
    return { service, robots, started, stopped, root, finish };
}

test('graph validation accepts cycles and rejects broken identity or legacy robot assignments', () => {
    assert.equal(normalizeWorkflow(graph()).tasks.length, 3);
    assert.throws(() => normalizeWorkflow({ ...graph(), entryTaskId: 'missing' }), /entryTaskId/);
    assert.throws(() => normalizeWorkflow({ ...graph(), edges: [edge('a', 'missing')] }), /endpoints/);
    assert.throws(() => normalizeWorkflow({ ...graph(), tasks: [task('a'), task('a')] }), /unique/);
    assert.throws(() => normalizeWorkflow({ ...graph(), members: [] }), /obsolete/);
});

test('branch parser tolerates aliases and formats but only authorizes outgoing edges', () => {
    for (const source of ['#nextEdgeId\na-b', '# message\nOK\n# Edge\na-b', '# NEXTEDGE\r\n```\r\na-b\r\n```', '{"nextEdge":"a-b"}', '```json\n{"Edge":"a-b"}\n```']) assert.equal(parseRoute(source, graph(), 'a').nextEdgeId, 'a-b');
    for (const source of ['Done', '#Edge\nb-a', '{"Edge":"a-b","nextEdge":"a-c"}', '#Edge\nunknown']) assert.throws(() => parseRoute(source, graph(), 'a'));
});

test('cycles create distinct tasks, preserve only final response history and branch prompts', async t => {
    const f = await fixture(t); await f.service.createWorkflow(graph());
    const flow = await f.service.startFlow({ workflowTypeId: 'example', objective: 'Work' });
    assert.match(f.started[0].request.systemPrompt, /Current node: a/);
    f.service.onRuntimeTaskEvent({ kind: 'progress', taskId: f.started[0].taskId, chunk: 'SECRET INTERMEDIATE' });
    await f.finish(0, '#message\nRevise\n#nextEdgeId\na-b');
    assert.equal(f.started[1].request.systemPrompt, '');
    const input = JSON.parse(f.started[1].request.task);
    assert.equal(input.previousFinalResponses[0].response, '#message\nRevise\n#nextEdgeId\na-b');
    assert.ok(!f.started[1].request.task.includes('SECRET INTERMEDIATE'));
    await f.finish(1, 'Revised');
    assert.notEqual(f.started[2].taskId, f.started[0].taskId);
    await f.finish(2, '{"Edge":"a-c"}'); await f.finish(3, 'Accepted');
    const completed = await f.service.getFlow(flow.id);
    assert.equal(completed.status, 'completed'); assert.equal(completed.result, 'Accepted');
    assert.deepEqual(completed.instances.map(instance => instance.taskId), ['a', 'b', 'a', 'c']);
    const tables = f.service.database.db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(row => row.name).sort();
    assert.deepEqual(tables, ['task_instances', 'workflow_runs', 'workflow_types']);
    const stored = f.service.database.db.prepare('SELECT record FROM task_instances').all().map(row => row.record).join();
    assert.ok(!stored.includes('Revised')); assert.ok(!stored.includes('SECRET INTERMEDIATE'));
});

test('zero and one outgoing edge never require route output; repeated completion does not launch twice', async t => {
    const f = await fixture(t); await f.service.createWorkflow({ ...graph(), edges: [edge('a', 'b')] });
    const flow = await f.service.startFlow({ workflowTypeId: 'example', objective: 'Work' });
    assert.equal(f.started[0].request.systemPrompt, '');
    await f.finish(0, 'plain response'); await f.finish(0, 'duplicate');
    assert.equal(f.started.length, 2); await f.finish(1);
    assert.equal((await f.service.getFlow(flow.id)).status, 'completed');
});

test('invalid route fails without dispatch; stop prevents late completion', async t => {
    const f = await fixture(t); await f.service.createWorkflow(graph());
    const flow = await f.service.startFlow({ workflowTypeId: 'example', objective: 'Work' });
    await f.finish(0, '#Edge\nb-a'); assert.equal((await f.service.getFlow(flow.id)).status, 'failed'); assert.equal(f.started.length, 1);
    const second = await f.service.startFlow({ workflowTypeId: 'example', objective: 'Work' });
    await f.service.stopFlow(second.id); await f.finish(1, '#Edge\na-b');
    assert.equal((await f.service.getFlow(second.id)).status, 'stopped'); assert.equal(f.started.length, 2);
});

test('default requires an execution mode and always uses the default robot', async t => {
    const f = await fixture(t);
    await assert.rejects(() => f.service.startFlow({ workflowTypeId: 'default', objective: 'Work' }), /executionType/);
    for (const mode of ['terminal', 'desktop', 'browser']) {
        const flow = await f.service.startFlow({ workflowTypeId: 'default', objective: 'Work', executionType: mode });
        const started = f.started.at(-1); assert.equal(started.robot.name, 'default'); assert.equal(started.type, mode === 'terminal' ? 'simple' : mode); assert.equal(started.request.systemPrompt, '');
        await f.finish(f.started.length - 1); assert.equal((await f.service.getFlow(flow.id)).status, 'completed');
    }
    await f.service.createWorkflow(graph());
    await assert.rejects(() => f.service.startFlow({ workflowTypeId: 'example', objective: 'Work', executionType: 'terminal' }), /executionType/);
});

test('coverage requires all enabled skillsets on one robot and is not persisted', async t => {
    const f = await fixture(t);
    const source = '/workspace/skills';
    const repo = { name: 'local', source, skills: [{ name: 'one' }, { name: 'two' }], definitions: [{ name: 'S1', skills: ['one'] }, { name: 'S2', skills: ['two'] }] };
    f.robots[0].skillsets = [repo]; f.robots[0].disabledSkillsets = ['local-set-2'];
    f.robots[1].skillsets = [repo]; f.robots[1].disabledSkillsets = ['local-set-1'];
    const definition = { ...graph(), tasks: [task('a', { skillsets: [canonicalSkillset(source, 'S1'), canonicalSkillset(source, 'S2')] })], edges: [] };
    assert.equal(coverage(definition, f.robots).warning, true);
    await f.service.createWorkflow(definition);
    const failed = await f.service.startFlow({ workflowTypeId: 'example', objective: 'Work' }); assert.equal(failed.status, 'failed');
    f.robots[1].disabledSkillsets = [];
    assert.equal((await f.service.listWorkflows()).find(graph => graph.id === 'example').coverage.warning, false);
    assert.ok(!JSON.stringify(await f.service.registry.get('example')).includes('coverage'));
});

test('run snapshots survive editing and deleting their workflow', async t => {
    const f = await fixture(t); const saved = await f.service.createWorkflow({ ...graph(), edges: [] });
    const flow = await f.service.startFlow({ workflowTypeId: 'example', objective: 'Work' });
    await f.service.updateWorkflow('example', { ...saved, name: 'Changed' });
    await assert.rejects(() => f.service.updateWorkflow('example', saved), /changed/);
    await f.service.deleteWorkflow('example'); await f.finish(0, 'Done');
    assert.equal((await f.service.getFlow(flow.id)).graph.name, 'Example');
});

test('GUI selection prefers idle matching robots and queues when all are busy', async t => {
    const f = await fixture(t, { guiBusy: id => id === 'worker-id' });
    await f.service.createWorkflow({ ...graph(), tasks: [task('a', { executionType: 'browser' })], edges: [] });
    await f.service.startFlow({ workflowTypeId: 'example', objective: 'Work' }); assert.equal(f.started[0].robot.name, 'default');
    f.service.runtimeManager.guiBusy = () => true;
    await f.service.startFlow({ workflowTypeId: 'example', objective: 'Work' }); assert.equal(f.started[1].robot.name, 'worker');
});

test('generation uses supplied system instructions and returns a validated unsaved graph', async t => {
    const f = await fixture(t);
    const pending = f.service.generateWorkflow({ description: 'Make a graph' });
    while (!f.started.length) await new Promise(resolve => setImmediate(resolve));
    assert.equal(f.started[0].robot.name, 'default'); assert.equal(f.started[0].type, 'simple'); assert.match(f.started[0].request.systemPrompt, /workflow planner/);
    await f.finish(0, JSON.stringify(graph())); const generated = await pending;
    assert.equal(generated.graph.entryTaskId, 'a'); assert.equal(await f.service.registry.get('example'), null);
});

test('restart fails unfinished runs without replay and removes legacy workflow definitions', async t => {
    const f = await fixture(t);
    await f.service.createWorkflow(graph());
    const flow = await f.service.startFlow({ workflowTypeId: 'example', objective: 'Work' });
    await f.service.close();
    const legacy = path.join(f.root, 'old');
    await fs.mkdir(legacy); await fs.writeFile(path.join(legacy, 'legacy.json'), '{"members":[]}');
    await fs.writeFile(path.join(legacy, 'keep.txt'), 'unrelated');
    f.service.registry.legacyDirectory = legacy;
    await f.service.initialize();
    const recovered = await f.service.getFlow(flow.id);
    assert.equal(recovered.status, 'failed'); assert.equal(recovered.instances[0].state, 'interrupted');
    assert.equal(f.started.length, 1);
    await assert.rejects(fs.stat(path.join(legacy, 'legacy.json')), { code: 'ENOENT' });
    assert.equal(await fs.readFile(path.join(legacy, 'keep.txt'), 'utf8'), 'unrelated');
    assert.equal((await f.service.registry.list()).length, 2);
});

test('generation rejects malformed and unknown skillset output and cancellation stops only its runtime task', async t => {
    const f = await fixture(t);
    for (const output of ['not a graph', JSON.stringify({ ...graph(), tasks: [task('a', { skillsets: ['unknown'] })], edges: [] })]) {
        const index = f.started.length;
        const pending = f.service.generateWorkflow({ description: 'Make a graph' });
        const rejected = assert.rejects(pending);
        while (f.started.length === index) await new Promise(resolve => setImmediate(resolve));
        await f.finish(index, output); await rejected;
    }
    const control = new AbortController();
    const pending = f.service.generateWorkflow({ description: 'Make a graph' }, { signal: control.signal });
    const rejected = assert.rejects(pending, /cancelled/);
    while (f.started.length < 3) await new Promise(resolve => setImmediate(resolve));
    control.abort(); await rejected;
    assert.deepEqual(f.stopped, [f.started[2].taskId]);
    assert.equal(f.service.generations.size, 0); assert.equal(await f.service.registry.get('example'), null);
});

test('unreachable uncovered nodes warn but do not prevent successful execution', async t => {
    const f = await fixture(t);
    const saved = await f.service.createWorkflow({ ...graph(), tasks: [task('a'), task('b', { skillsets: ['missing/set'] })], edges: [] });
    assert.equal(saved.coverage.warning, true);
    const flow = await f.service.startFlow({ workflowTypeId: 'example', objective: 'Work' });
    await f.finish(0); assert.equal((await f.service.getFlow(flow.id)).status, 'completed');
    assert.equal(f.started.length, 1);
});

test('generation without a project uses managed scratch and the visit cap is configurable', async t => {
    const f = await fixture(t, { maxVisits: 1 });
    f.service.runtimeManager.resolveCwd = async value => { assert.ok(path.isAbsolute(value), 'runtime needs an explicit cwd'); return value; };
    const pending = f.service.generateWorkflow({ description: 'Draft' });
    while (!f.started.length) await new Promise(resolve => setImmediate(resolve));
    assert.equal(f.started[0].request.cwd, path.join(f.root, '.achilles-cli', 'roboflow-generation'));
    await f.finish(0, JSON.stringify(graph())); await pending;
    await f.service.createWorkflow({ ...graph(), edges: [edge('a', 'a')] });
    const flow = await f.service.startFlow({ workflowTypeId: 'example', objective: 'Work', folder: f.root });
    await f.finish(1, 'Again');
    assert.equal(f.started.length, 2); assert.match((await f.service.getFlow(flow.id)).error, /maximum task visits/);
});

test('global discovery includes unregistered skill repositories and prepares remote sources via Ploinky', async t => {
    const { discoverWorkflowSkillsets } = await import('../server/roboflow/skill-matching.mjs');
    const f = await fixture(t);
    const source = path.join(f.root, 'skills-repo'); await fs.mkdir(path.join(source, 'skills', 'review'), { recursive: true });
    await fs.writeFile(path.join(source, 'skills', 'review', 'SKILL.md'), '---\nname: review\ndescription: Review code.\n---\nReview it.');
    await fs.writeFile(path.join(source, 'skillsets.md'), '# Review set\n## Description\nReview changes.\n## Skills\n- review\n');
    const prepared = [];
    const catalog = await discoverWorkflowSkillsets({
        listRepositories: async () => [{ name: 'skills-repo', source: 'https://example.com/skills.git', origin: 'remote', kind: 'skills' }],
        prepareRepository: async input => { prepared.push(input); return [{ name: 'skills-repo', source, origin: 'workspace', kind: 'skills' }]; }
    });
    assert.equal(prepared.length, 1); assert.deepEqual(catalog.diagnostics, []);
    assert.ok(catalog.skillsets.some(set => set.id === canonicalSkillset(source, 'Review set')));
    assert.equal(coverage({ tasks: [task('a', { skillsets: [canonicalSkillset(source, 'Review set')] })] }, f.robots).warning, true);
});

test('workflow skillset discovery reads only skills/ and ignores agent instruction descriptors', async t => {
    const { discoverWorkflowSkillsets } = await import('../server/roboflow/skill-matching.mjs');
    const f = await fixture(t);
    const source = path.join(f.root, 'project');
    const agentSkill = path.join(source, '.agents', 'skills', 'achilles_specs', 'SKILL.md');
    await fs.mkdir(path.dirname(agentSkill), { recursive: true });
    await fs.writeFile(agentSkill, '---\nname: achilles_specs\ndescription: Agent instruction.\n---\n');
    const skill = path.join(source, 'skills', 'review', 'SKILL.md');
    await fs.mkdir(path.dirname(skill), { recursive: true });
    // Invalid skill name on purpose: workflow discovery must not validate names.
    await fs.writeFile(skill, '---\nname: Review Extra\ndescription: Review code.\n---\n');
    const catalog = await discoverWorkflowSkillsets({
        listRepositories: async () => [
            { name: 'project', source, origin: 'workspace', kind: 'skills' },
            { name: 'mixed-repo', source, origin: 'workspace', kind: 'mixed' },
            { name: 'agent-repo', source, origin: 'workspace', kind: 'agents' },
        ],
    });
    assert.deepEqual(catalog.diagnostics, []);
    assert.equal(catalog.skillsets.some(set => ['project', 'mixed-repo', 'agent-repo'].includes(set.repositoryName)), false);
});
