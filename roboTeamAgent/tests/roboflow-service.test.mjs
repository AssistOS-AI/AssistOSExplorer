import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { RoboFlowService } from '../server/roboflow/roboflow-service.mjs';
import { normalizeWorkflow, workflowDefaultObjective, resolveWorkflowObjective } from '../server/roboflow/graph.mjs';
import { parseRoute } from '../server/roboflow/result-parser.mjs';
import { coverage, canonicalSkillset, canonicalSkill, matchRobot, robotSelections } from '../server/roboflow/skill-matching.mjs';

const task = (id, extras = {}) => ({ id, name: id, prompt: `Execute ${id}`, executionType: 'terminal', skillsets: [], ...extras });
const edge = (sourceTaskId, targetTaskId) => ({ id: `${sourceTaskId}-${targetTaskId}`, sourceTaskId, targetTaskId });
const graph = () => ({ id: 'example', name: 'Example', description: 'Example workflow', entryTaskId: 'a', tasks: [task('a'), task('b'), task('c')], edges: [edge('a', 'b'), edge('a', 'c'), edge('b', 'a')] });
const humanReport = text => `<<human-report>>\n${text}\n<<human-report>>`;
async function fixture(t, options = {}) {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'roboflow-graph-')));
    const robots = [{ id: 'default-id', name: 'default', codingAgents: ['codex'] }, { id: 'worker-id', name: 'worker', codingAgents: ['codex'] }];
    const started = [], stopped = [], messages = [], resumed = [];
    const robotStore = { list: async () => robots, getByName: async name => robots.find(robot => robot.name === name), get: async id => robots.find(robot => robot.id === id) };
    const runtimeManager = { resolveCwd: async value => value || root,
        startTask(robot, type, request) { started.push({ robot, type, request, taskId: request.runtimeTaskId }); return { taskId: request.runtimeTaskId, state: 'queued',
            ...(['browser', 'desktop'].includes(type) ? { sessionUrl: `/api/robots/${robot.id}/session/` } : {}) }; },
        stopTask(robot, type, id) { stopped.push(id); },
        sendTaskMessage(robot, taskId, prompt) { messages.push({ robot, taskId, prompt }); return { delivery: 'sent' }; },
        resumeTask(robot, taskId, prompt, options = {}) { resumed.push({ robot, taskId, prompt }); return { taskId: options.runtimeTaskId, state: 'queued' }; },
        guiBusy: options.guiBusy || (() => false) };
    const service = new RoboFlowService({ robotStore, runtimeManager, skillsets: { repositoriesClient: { listRepositories: async () => [{ name: 'DocumentationSkills', source: root, origin: 'local' }] }, start: async (robot, input, enqueue) => enqueue(robot) }, databaseFile: path.join(root, 'roboflow.sqlite'), workflowsDirectory: path.join(root, 'old'), random: () => .99,
        discoverSkillsets: async () => ({ skillsets: [], diagnostics: [] }), ...options });
    service.skillsets.repositoriesClient ||= { listRepositories: async () => [{ name: 'DocumentationSkills', source: root, origin: 'local' }] };
    await service.initialize();
    await service.presetReady;
    t.after(async () => { await service.close(); await fs.rm(root, { recursive: true, force: true }); });
    async function finish(index, result = 'Done', state = 'completed') {
        service.onRuntimeTaskEvent({ kind: 'terminal', taskId: started[index].taskId, result, state });
        while (service.chains.size) await Promise.allSettled(service.chains.values());
    }
    return { service, robots, started, stopped, messages, resumed, root, finish };
}

test('flow observers see committed phase changes even when overall status is unchanged, but never failed transactions', async t => {
    const f = await fixture(t);
    await f.service.createWorkflow(graph());
    const flow = await f.service.startFlow({ workflowTypeId: 'example', folder: f.root, objective: 'Work' });
    const events = [];
    const unsubscribe = f.service.subscribeFlow(flow.id, event => {
        if (event.kind === 'flow') events.push(f.service.store.getSync(flow.id));
    });
    await assert.rejects(f.service.store.update(flow.id, record => { record.error = 'Not committed'; throw new Error('Rollback'); }), /Rollback/);
    assert.equal(events.length, 0); assert.equal((await f.service.store.get(flow.id)).error, null);
    await f.service.store.update(flow.id, record => { record.instances[0].state = 'running'; });
    assert.equal(events.length, 1); assert.equal(events[0].status, 'running');
    assert.equal(events[0].instances[0].state, 'running'); assert.equal(events[0].revision, flow.revision + 1);
    unsubscribe(); assert.equal(f.service.store.subscribers.size, 0);
});

test('graph validation accepts cycles and rejects broken identity or legacy robot assignments', () => {
    const normalized = normalizeWorkflow(graph());
    assert.equal(normalized.tasks.length, 3);
    assert.deepEqual(normalized.edges[0], { ...edge('a', 'b'), sourcePort: 'right', targetPort: 'left' });
    assert.deepEqual(normalizeWorkflow({ ...graph(), edges: [{ ...edge('a', 'b'), sourcePort: 'left', targetPort: 'right' }] }).edges[0], { ...edge('a', 'b'), sourcePort: 'left', targetPort: 'right' });
    assert.throws(() => normalizeWorkflow({ ...graph(), edges: [{ ...edge('a', 'b'), sourcePort: 'top' }] }), /ports/);
    assert.throws(() => normalizeWorkflow({ ...graph(), entryTaskId: 'missing' }), /entryTaskId/);
    assert.throws(() => normalizeWorkflow({ ...graph(), edges: [edge('a', 'missing')] }), /endpoints/);
    assert.throws(() => normalizeWorkflow({ ...graph(), tasks: [task('a'), task('a')] }), /unique/);
    assert.throws(() => normalizeWorkflow({ ...graph(), members: [] }), /obsolete/);
});

test('branch parser tolerates aliases and formats but only authorizes outgoing edges', () => {
    for (const source of ['#nextEdgeId\na-b', '# nextNodePrompt\nOK\n# Edge\na-b', '# NEXTEDGE\r\n```\r\na-b\r\n```', '{"nextEdge":"a-b"}', '```json\n{"Edge":"a-b"}\n```']) assert.equal(parseRoute(source, graph(), 'a').nextEdgeId, 'a-b');
    for (const source of ['Done', '#Edge\nb-a', '{"Edge":"a-b","nextEdge":"a-c"}', '#Edge\nunknown']) assert.throws(() => parseRoute(source, graph(), 'a'));
});
test('workflow defaults reuse saved requirements, descriptions or task prompts without inventing generic work', () => {
    assert.equal(normalizeWorkflow({ ...graph(), defaultObjective: 'Original request', description: 'Short summary' }).defaultObjective, 'Original request');
    assert.equal(normalizeWorkflow({ ...graph(), description: 'Write a report' }).defaultObjective, 'Write a report');
    assert.match(normalizeWorkflow({ ...graph(), description: '' }).defaultObjective, /a\nExecute a/);
    for (const id of ['default', 'code-development']) assert.equal(workflowDefaultObjective({ id, description: 'Generic description', defaultObjective: 'Not a real request' }), '');
    assert.equal(workflowDefaultObjective({ id: 'large', tasks: [{ name: 'Work', prompt: 'x'.repeat(32769) }] }), '');
    assert.throws(() => resolveWorkflowObjective({ id: 'default' }), /explicit objective/);
    assert.throws(() => normalizeWorkflow({ ...graph(), defaultObjective: 4 }), /must be text/);
    assert.throws(() => normalizeWorkflow({ ...graph(), defaultObjective: 'x'.repeat(32769) }), /32768/);
});
test('derived objectives are not written to workflow files; new runs capture defaults and explicit overrides separately', async t => {
    const f = await fixture(t);
    const saved = await f.service.createWorkflow({ ...graph(), description: 'Write the saved report' });
    assert.equal((await f.service.registry.get(saved.id)).defaultObjective, 'Write the saved report');
    assert.equal(JSON.parse(await fs.readFile(path.join(f.root, 'old', `${saved.id}.json`), 'utf8')).defaultObjective, undefined);
    const inherited = await f.service.startFlow({ workflowTypeId: saved.id });
    assert.equal(inherited.objective, 'Write the saved report'); assert.equal(JSON.parse(f.started[0].request.task).objective, inherited.objective);
    const explicit = await f.service.startFlow({ workflowTypeId: saved.id, objective: 'Different work' });
    assert.equal(explicit.objective, 'Different work');
    const current = await f.service.registry.get(saved.id);
    await f.service.updateWorkflow(saved.id, { ...current, description: 'Write the updated report' });
    assert.equal((await f.service.registry.get(saved.id)).defaultObjective, 'Write the updated report');
    assert.equal((await f.service.getFlow(inherited.id)).objective, 'Write the saved report');
    await assert.rejects(f.service.startFlow({ workflowTypeId: 'default', executionType: 'terminal' }), /explicit objective/);
    await assert.rejects(f.service.startFlow({ workflowTypeId: 'code-development' }), /explicit objective/);
});
test('captured generation requirements survive ordinary saves and default resolution uses the same fresh graph as its run snapshot', async t => {
    const f = await fixture(t);
    const saved = await f.service.createWorkflow({ ...graph(), description: 'Summary', defaultObjective: 'Original detailed requirements' });
    const { defaultObjective, ...oldClient } = saved;
    await f.service.updateWorkflow(saved.id, { ...oldClient, name: 'Renamed' });
    assert.equal((await f.service.registry.get(saved.id)).defaultObjective, defaultObjective);
    const create = f.service.store.createFromWorkflow.bind(f.service.store);
    f.service.store.createFromWorkflow = async (...args) => {
        const current = await f.service.registry.get(saved.id);
        await f.service.updateWorkflow(saved.id, { ...current, defaultObjective: 'Requirements updated before capture' });
        return create(...args);
    };
    const run = await f.service.startFlow({ workflowTypeId: saved.id });
    assert.equal(run.objective, 'Requirements updated before capture'); assert.equal(run.graph.defaultObjective, run.objective);
});

test('cycles create distinct tasks, preserve only final response history and branch prompts', async t => {
    const f = await fixture(t); await f.service.createWorkflow(graph());
    const flow = await f.service.startFlow({ workflowTypeId: 'example', objective: 'Work' });
    assert.match(f.started[0].request.systemPrompt, /Current node: a/);
    f.service.onRuntimeTaskEvent({ kind: 'progress', taskId: f.started[0].taskId, chunk: 'SECRET INTERMEDIATE' });
    await f.finish(0, '#nextNodePrompt\nRevise\n#nextEdgeId\na-b');
    assert.equal(f.started[1].request.systemPrompt, '');
    const input = JSON.parse(f.started[1].request.task);
    assert.equal(input.previousFinalResponses[0].response, '#nextNodePrompt\nRevise\n#nextEdgeId\na-b');
    assert.ok(!f.started[1].request.task.includes('SECRET INTERMEDIATE'));
    await f.finish(1, 'Revised');
    assert.notEqual(f.started[2].taskId, f.started[0].taskId);
    await f.finish(2, '{"Edge":"a-c"}'); await f.finish(3, 'Accepted');
    const completed = await f.service.getFlow(flow.id);
    assert.equal(completed.status, 'completed'); assert.equal(completed.result, 'Accepted');
    assert.deepEqual(completed.instances.map(instance => instance.taskId), ['a', 'b', 'a', 'c']);
    const tables = f.service.database.db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(row => row.name).sort();
    assert.deepEqual(tables, ['task_instances', 'workflow_runs', 'workflow_schedules']);
    const stored = f.service.database.db.prepare('SELECT record FROM task_instances').all().map(row => row.record).join();
    assert.ok(!stored.includes('Revised')); assert.ok(!stored.includes('SECRET INTERMEDIATE'));
});

test('routing keeps the original response for debugging and passes only technical context to the next task', async t => {
    const f = await fixture(t);
    await f.service.createWorkflow(graph());
    const flow = await f.service.startFlow({ workflowTypeId: 'example', objective: 'Work' });
    const payload = '# nextEdgeId\na-b';
    const result = humanReport('The input validation needs a fix.') + '\n\n' + payload;
    await f.finish(0, result);
    const input = JSON.parse(f.started[1].request.task);
    assert.equal(input.previousFinalResponses[0].response, payload);
    assert.ok(!Object.hasOwn(input.previousFinalResponses[0], 'humanReport'));
    assert.ok(!f.started[1].request.task.includes('The input validation needs a fix.'));
    assert.equal(await f.service.store.readOutput(flow.id, flow.instances[0].id, 'result'), result);
    assert.equal((await f.service.getFlow(flow.id)).instances[0].finalResponse, result);
    await f.finish(1, humanReport('User-only fix report.') + '\n# nextNodePrompt\nFixed the missing validation.');
    assert.equal(JSON.parse(f.started[2].request.task).previousFinalResponses[1].response, '# nextNodePrompt\nFixed the missing validation.');
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
    await f.service.pauseFlow(second.id); await f.finish(1, '#Edge\na-b');
    assert.equal((await f.service.getFlow(second.id)).status, 'paused'); assert.equal(f.started.length, 2);
});

test('pausing a single phase cancels its runtime task and pauses the whole flow', async t => {
    const f = await fixture(t); await f.service.createWorkflow(graph());
    const flow = await f.service.startFlow({ workflowTypeId: 'example', objective: 'Work' });
    const instanceId = flow.instances[0].id;
    const paused = await f.service.pauseInstance(flow.id, instanceId);
    assert.equal(paused.status, 'paused');
    assert.equal(paused.instances[0].state, 'paused');
    assert.deepEqual(f.stopped, [f.started[0].taskId]);
    assert.equal((await f.service.getFlow(flow.id)).status, 'paused');
    await assert.rejects(() => f.service.pauseInstance(flow.id, 'inv_000000000000000000000000'), { statusCode: 404 });
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
    await f.service.updateWorkflow('example', { ...saved, name: 'Changed', tasks: [...saved.tasks].reverse() });
    const reordered = await f.service.registry.get('example');
    assert.deepEqual(reordered.tasks.map(task => task.id), ['c', 'b', 'a']);
    const nextFlow = await f.service.startFlow({ workflowTypeId: 'example', objective: 'New run' });
    assert.deepEqual(nextFlow.graph.tasks.map(task => task.id), ['c', 'b', 'a']);
    assert.equal(nextFlow.instances[0].taskId, 'a');
    assert.deepEqual((await f.service.getFlow(flow.id)).graph.tasks.map(task => task.id), ['a', 'b', 'c']);
    await assert.rejects(() => f.service.updateWorkflow('example', saved), /changed/);
    await f.service.deleteWorkflow('example'); await f.finish(0, 'Done');
    assert.equal((await f.service.getFlow(flow.id)).graph.name, 'Example');
    assert.deepEqual((await f.service.getFlow(flow.id)).graph.tasks.map(task => task.id), ['a', 'b', 'c']);
});

test('browser tasks record the live GUI session URL on their instance', async t => {
    const f = await fixture(t); await f.service.createWorkflow({ ...graph(), tasks: [task('a', { executionType: 'browser' })], edges: [] });
    const flow = await f.service.startFlow({ workflowTypeId: 'example', objective: 'Work' });
    const instance = (await f.service.getFlow(flow.id)).instances[0];
    assert.equal(instance.sessionUrl, `/api/robots/${f.started[0].robot.id}/session/`);
});

test('GUI selection prefers idle matching robots and queues when all are busy', async t => {    const f = await fixture(t, { guiBusy: id => id === 'worker-id' });
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
    assert.equal(generated.graph.defaultObjective, 'Make a graph');
    assert.equal(generated.graph.entryTaskId, 'a'); assert.equal(await f.service.registry.get('example'), null);
});

test('both generation entrypoints accept Markdown graphs and reject invalid Markdown drafts', async t => {
    const f = await fixture(t);
    const source = humanReport('Created a draft for review.') + '\n\n# name\nMarkdown draft\n# entryTaskId\none\n# task\none\n# name\nWork\n# executionType\nterminal\n# skillsets\n# allowsHumanInput\ntrue\n# prompt\n~~~~text\nImplement "quotes" without escaping.\n# task\nThis is literal prompt text.\n~~~~';
    for (const browser of [false, true]) {
        for (const invalid of [false, true]) {
            const index = f.started.length;
            const output = invalid ? source.replace('# skillsets\n', '# skillsets\n- unknown\n') : source;
            const pending = browser ? await f.service.startGeneration({ description: 'Draft' }) : f.service.generateWorkflow({ description: 'Draft' });
            const rejected = !browser && invalid ? assert.rejects(pending, /unknown skillset/) : null;
            while (f.started.length === index) await new Promise(resolve => setImmediate(resolve));
            assert.match(f.started[index].request.systemPrompt, /structured Markdown graph/);
            await f.finish(index, output);
            if (rejected) { await rejected; continue; }
            if (browser) while (f.service.generationTasks.get(pending.id).status === 'running') await new Promise(resolve => setImmediate(resolve));
            const result = browser ? f.service.generationInfo(pending.id) : await pending;
            if (invalid) {
                assert.equal(result.status, 'failed'); assert.match(result.error, /unknown skillset/);
            } else {
                assert.equal(result.graph.tasks[0].allowsHumanInput, true);
                assert.equal(result.graph.tasks[0].prompt, 'Implement "quotes" without escaping.\n# task\nThis is literal prompt text.');
                assert.deepEqual(result.graph.edges, []);
            }
        }
    }
    assert.equal(await f.service.registry.get('markdown-draft'), null);
});

test('Markdown child plans run in order, pass prior results and follow the saved continuation once', async t => {
    const f = await fixture(t);
    await f.service.createWorkflow({ id: 'child', name: 'Child', description: 'Child workflow', entryTaskId: 'one', tasks: [task('one')], edges: [] });
    await f.service.createWorkflow({ id: 'parent', name: 'Parent', description: 'Parent workflow', entryTaskId: 'creator', tasks: [task('creator', { creator: true }), task('end')],
        edges: [{ id: 'delegate', sourceTaskId: 'creator', targetTaskId: 'run-workflows' }, { id: 'after', sourceTaskId: 'run-workflows', targetTaskId: 'end' }] });
    const parent = await f.service.startFlow({ workflowTypeId: 'parent', objective: 'Work' });
    const firstPrompt = 'Implement "quoted" inputs.\n# workflow\nLiteral example.';
    const payload = `# nextEdgeId\ndelegate\n# afterWorkflowsEdgeId\nafter\n##Workflow\ndefault\n# executionType\nterminal\n# prompt\n~~~~text\n${firstPrompt}\n~~~~\n# workflow\nchild\n# prompt\nVerify the implementation.`;
    const response = humanReport('Implement, then verify the change.') + '\n\n' + payload;
    await f.finish(0, response);
    const creator = (await f.service.getFlow(parent.id)).instances[0];
    assert.equal(creator.childFlowIds.length, 2);
    const [first, second] = creator.childFlowIds;
    assert.equal((await f.service.getFlow(first)).objective, firstPrompt);
    assert.equal((await f.service.getFlow(second)).status, 'pending');
    assert.equal(f.started.length, 2);
    await f.finish(0, response);
    assert.equal(f.started.length, 2);
    const implementation = humanReport('User-only implementation report.') + '\n# nextNodePrompt\nImplemented "quotes".';
    await f.finish(1, implementation);
    assert.equal(f.started.length, 3);
    assert.equal(JSON.parse(f.started[2].request.task).previousSubflowFinalResponse, '# nextNodePrompt\nImplemented "quotes".');
    await f.finish(2, humanReport('User-only verification report.') + '\n# nextNodePrompt\nVerified');
    assert.equal(f.started.length, 4);
    assert.equal(JSON.parse(f.started[3].request.task).currentTaskId, 'end');
    const previous = JSON.parse(f.started[3].request.task).previousFinalResponses;
    assert.equal(previous[0].response, payload);
    assert.ok(!Object.hasOwn(previous[0], 'humanReport'));
    assert.ok(!f.started[2].request.task.includes('User-only'));
    assert.ok(!f.started[3].request.task.includes('User-only'));
    assert.ok(!f.started[3].request.task.includes('Implement, then verify the change.'));
    assert.deepEqual(JSON.parse(previous[1].response).map(child => child.result), ['# nextNodePrompt\nImplemented "quotes".', '# nextNodePrompt\nVerified']);
    assert.equal((await f.service.getFlow(first)).result, implementation);
    await f.finish(3, 'Done');
    assert.equal((await f.service.getFlow(parent.id)).status, 'completed');
});

test('invalid Markdown delegation never creates or starts a partial child group', async t => {
    const f = await fixture(t);
    await f.service.createWorkflow({ id: 'child', name: 'Child', description: 'Child workflow', entryTaskId: 'one', tasks: [task('one')], edges: [] });
    await f.service.createWorkflow({ id: 'parent', name: 'Parent', description: 'Parent workflow', entryTaskId: 'creator', tasks: [task('creator', { creator: true }), task('end')],
        edges: [{ id: 'delegate', sourceTaskId: 'creator', targetTaskId: 'run-workflows' }, { id: 'after', sourceTaskId: 'run-workflows', targetTaskId: 'end' }] });
    const prefix = '# nextEdgeId\ndelegate\n# afterWorkflowsEdgeId\nafter\n';
    const child = '# workflow\nchild\n# prompt\nWork\n';
    const invalid = [
        prefix, prefix + '# workflow\nchild', prefix + '# workflow\nchild\n# prompt\n',
        prefix + child + '# workflow\nmissing\n# prompt\nSecond',
        prefix + child + '# workflow\nparent\n# prompt\nRecursive',
        prefix + '# workflow\ndefault\n# prompt\nMissing mode',
        prefix + child + '# executionType\nterminal', prefix + child.repeat(101),
        prefix.replace('after\n', 'delegate\n') + child,
        prefix + '# workflow\nchild\n# prompt\n' + 'x'.repeat(32769),
        prefix + child + '# nextEdgeId\nother',
    ];
    for (const source of invalid) {
        const index = f.started.length;
        const parent = await f.service.startFlow({ workflowTypeId: 'parent', objective: 'Work' });
        await f.finish(index, source);
        assert.equal((await f.service.getFlow(parent.id)).status, 'failed');
        assert.equal(f.started.length, index + 1);
        assert.ok(!(await f.service.listFlows()).some(flow => flow.parentFlowId === parent.id));
    }
});

test('a creator can choose an ordinary Markdown route without child fields', async t => {
    const f = await fixture(t);
    await f.service.createWorkflow({ ...graph(), tasks: [task('a', { creator: true }), task('b'), task('c')] });
    const flow = await f.service.startFlow({ workflowTypeId: 'example', objective: 'Work' });
    await f.finish(0, '# nextNodePrompt\nReady\n##NEXT_EDGE_ID\na-c');
    assert.equal(f.started.length, 2);
    assert.equal(JSON.parse(f.started[1].request.task).currentTaskId, 'c');
    await f.finish(1, 'Done');
    assert.equal((await f.service.getFlow(flow.id)).status, 'completed');
});

test('restart pauses unfinished runs without replay and keeps saved workflow files', async t => {
    const f = await fixture(t);
    await f.service.createWorkflow(graph());
    const flow = await f.service.startFlow({ workflowTypeId: 'example', objective: 'Work' });
    await f.service.close();
    await f.service.initialize();
    const recovered = await f.service.getFlow(flow.id);
    assert.equal(recovered.status, 'paused'); assert.equal(recovered.instances[0].state, 'paused');
    assert.equal(f.started.length, 1);
    assert.deepEqual((await f.service.registry.list()).map(workflow => workflow.id).sort(), ['code-development', 'default', 'example']);
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
    assert.equal(f.started[0].request.cwd, path.join(f.root, '.roboteam', 'roboflow-generation'));
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

test('workflow skillset discovery reads only skills/ by folder name and never parses SKILL.md', async t => {
    const { discoverWorkflowSkillsets } = await import('../server/roboflow/skill-matching.mjs');
    const f = await fixture(t);
    const source = path.join(f.root, 'project');
    const agentSkill = path.join(source, '.agents', 'skills', 'achilles_specs', 'SKILL.md');
    await fs.mkdir(path.dirname(agentSkill), { recursive: true });
    await fs.writeFile(agentSkill, '---\nname: achilles_specs\ndescription: Agent instruction.\n---\n');
    const skill = path.join(source, 'skills', 'review', 'SKILL.md');
    await fs.mkdir(path.dirname(skill), { recursive: true });
    // A descriptor with a different declared name must not affect the catalog.
    await fs.writeFile(skill, '---\nname: Review Extra\ndescription: Review code.\n---\n');
    const mixedSource = path.join(f.root, 'mixed');
    await fs.mkdir(path.join(mixedSource, 'skills', 'review'), { recursive: true });
    await fs.writeFile(path.join(mixedSource, 'skills', 'review', 'SKILL.md'), '---\nname: review\ndescription: Review code.\n---\n');
    const catalog = await discoverWorkflowSkillsets({
        listRepositories: async () => [
            { name: 'project', source, origin: 'workspace', kind: 'skills' },
            { name: 'mixed-repo', source: mixedSource, origin: 'workspace', kind: 'mixed' },
            { name: 'agent-repo', source, origin: 'workspace', kind: 'agents' },
        ],
    });
    assert.deepEqual(catalog.diagnostics, []);
    assert.ok(catalog.skillsets.some(set => set.kind === 'skill' && set.repositoryName === 'project' && set.name === 'review'));
    assert.equal(catalog.skillsets.some(set => set.name === 'Review Extra'), false);
    assert.equal(catalog.skillsets.some(set => set.name === 'achilles_specs'), false);
    const mixedSkill = catalog.skillsets.find(set => set.repositoryName === 'mixed-repo' && set.name === 'review');
    assert.ok(mixedSkill, 'mixed repositories contribute their skills/ folder');
    // A robot records a mixed repository by its skills/ folder, so it covers the workflow's id for the skill.
    const mixedRoot = path.join(await fs.realpath(mixedSource), 'skills');
    assert.equal(mixedSkill.id, canonicalSkill(mixedRoot, 'review'));
    const robot = { id: 'worker', name: 'worker', skillsets: [{ name: 'mixed-repo', source: mixedRoot,
        skills: [{ name: 'review', description: 'Review code.', directory: 'review' }], definitions: [] }] };
    assert.equal(matchRobot(robot, { skillsets: [mixedSkill.id] }), true);
    assert.equal(catalog.skillsets.some(set => set.repositoryName === 'agent-repo'), false);
});

test('repositories without declared skillsets match and mount individual skills', () => {
    const source = '/workspace/skills';
    const repo = { name: 'local', source, skills: [{ name: 'one', description: 'One' }], definitions: [] };
    const skillId = canonicalSkill(source, 'one');
    const worker = { id: 'worker-id', name: 'worker', skillsets: [repo] };
    assert.deepEqual(robotSelections(worker), [{ id: skillId, kind: 'skill', selector: 'local/one', name: 'one',
        description: 'One', repositoryId: source, repositoryName: 'local' }]);
    assert.equal(matchRobot(worker, { skillsets: [skillId] }), true);
    assert.equal(matchRobot({ id: 'other-id', name: 'other', skillsets: [] }, { skillsets: [skillId] }), false);
    assert.equal(robotSelections({ id: 'default-id', name: 'default', skillsets: [repo] }).some(item => item.id === skillId), true);
});

test('repositories with declared skillsets expose only their skillsets', () => {
    const repo = { name: 'sets', source: '/workspace/sets', skills: [{ name: 'x' }, { name: 'y' }], definitions: [{ name: 'S', skills: ['x'] }] };
    const selections = robotSelections({ id: 'worker-id', name: 'worker', skillsets: [repo] });
    assert.deepEqual(selections.map(item => item.selector), ['sets-set-1']);
    assert.ok(selections.every(item => item.kind === 'skillset'));
});

test('workflow task selections map skillsets and individual skills to robot selectors', async t => {
    const recorded = [];
    const f = await fixture(t, { skillsets: { start: async (robot, input, enqueue) => { recorded.push(input); return enqueue(robot, { policyId: 'policy-1' }); } } });
    const source = '/workspace/skills';
    f.robots[1].skillsets = [
        { name: 'named', source: '/workspace/named', skills: [{ name: 'x' }], definitions: [{ name: 'S1', skills: ['x'] }] },
        { name: 'individual', source, skills: [{ name: 'one' }], definitions: [] },
    ];
    const setsId = canonicalSkillset('/workspace/named', 'S1');
    const skillId = canonicalSkill(source, 'one');
    await f.service.createWorkflow({ ...graph(), tasks: [task('a', { skillsets: [setsId, skillId] })], edges: [] });
    await f.service.startFlow({ workflowTypeId: 'example', objective: 'Work' });
    assert.equal(f.started[0].robot.name, 'worker');
    assert.deepEqual(recorded[0].skillSets, ['named-set-1']);
    assert.deepEqual(recorded[0].skills, ['individual/one']);
});

test('a live prompt reaches the running phase and is recorded in its log', async t => {
    const f = await fixture(t); await f.service.createWorkflow({ ...graph(), edges: [edge('a', 'b')] });
    const flow = await f.service.startFlow({ workflowTypeId: 'example', objective: 'Work' });
    const instance = flow.instances[0];
    await f.service.store.writeOutput(flow.id, instance.id, 'Previous output without a newline');
    const result = await f.service.messageInstance(flow.id, instance.id, '  keep going  ');
    assert.deepEqual(f.messages, [{ robot: f.started[0].robot, taskId: f.started[0].taskId, prompt: 'keep going' }]);
    assert.equal(result.delivery, 'sent');
    assert.match(await f.service.getInvocationLog(flow.id, instance.id), /Previous output without a newline\nyou> keep going\n\n/);
    await f.service.messageInstance(flow.id, instance.id, 'First line\nSecond line');
    assert.match(await f.service.getInvocationLog(flow.id, instance.id), /\nyou> First line\nyou> Second line\n\n/);
    await assert.rejects(() => f.service.messageInstance(flow.id, 'inv_000000000000000000000000', 'x'), { statusCode: 404 });
    await assert.rejects(() => f.service.messageInstance(flow.id, instance.id, ''), /prompt/);
});

test('workflow resume sends an English prompt on its own log line', async t => {
    const f = await fixture(t);
    await f.service.createWorkflow(graph());
    const flow = await f.service.startFlow({ workflowTypeId: 'example', objective: 'Work' });
    const instance = flow.instances[0];
    f.service.onRuntimeTaskEvent({ kind: 'state', taskId: f.started[0].taskId, state: 'running' });
    while (f.service.chains.size) await Promise.allSettled(f.service.chains.values());
    await f.service.pauseFlow(flow.id);
    await f.service.store.writeOutput(flow.id, instance.id, 'Interrupted output');
    await f.service.resumeFlow(flow.id);
    assert.equal(f.resumed[0].prompt, 'Continue where you left off');
    assert.match(await f.service.getInvocationLog(flow.id, instance.id), /Interrupted output\nyou> Continue where you left off\n\n/);
});

test('continuing a completed phase resumes its session and the run advances from that phase', async t => {
    const f = await fixture(t); await f.service.createWorkflow({ ...graph(), edges: [edge('a', 'b'), edge('b', 'c')] });
    const flow = await f.service.startFlow({ workflowTypeId: 'example', objective: 'Work' });
    await f.finish(0, 'A'); await f.finish(1, 'B'); await f.finish(2, 'C');
    let current = await f.service.getFlow(flow.id);
    assert.equal(current.status, 'completed');
    const completedB = current.instances.find(instance => instance.taskId === 'b');
    await assert.rejects(() => f.service.messageInstance(flow.id, completedB.id, 'now'), /running phase/);
    const resumedFlow = await f.service.resumeInstance(flow.id, completedB.id, 'redo b');
    assert.equal(f.resumed.length, 1);
    assert.equal(f.resumed[0].taskId, completedB.runtimeTaskId);
    const resumedB = resumedFlow.instances.find(instance => instance.id === completedB.id);
    assert.notEqual(resumedB.runtimeTaskId, completedB.runtimeTaskId);
    assert.equal(resumedB.state, 'running');
    assert.equal(resumedFlow.status, 'running');
    f.service.onRuntimeTaskEvent({ kind: 'terminal', taskId: resumedB.runtimeTaskId, state: 'completed', result: 'B2' });
    while (f.service.chains.size) await Promise.allSettled(f.service.chains.values());
    const after = await f.service.getFlow(flow.id);
    assert.equal(after.status, 'running');
    assert.equal(after.instances.filter(instance => instance.taskId === 'c').length, 2);
    assert.match(await f.service.getInvocationLog(flow.id, completedB.id), /you> redo b/);
    const queuedC = after.instances.find(instance => instance.state === 'queued');
    await assert.rejects(() => f.service.resumeInstance(flow.id, queuedC.id, 'again'), /can continue/);
    const before = (await f.service.getInvocationLog(flow.id, completedB.id)).match(/you>/g).length;
    const resumedWithoutPrompt = await f.service.resumeInstance(flow.id, completedB.id, '   ');
    assert.equal(resumedWithoutPrompt.instances.find(instance => instance.id === completedB.id).state, 'running');
    assert.equal(f.resumed.length, 2);
    assert.equal(f.resumed[1].prompt, '');
    assert.equal((await f.service.getInvocationLog(flow.id, completedB.id)).match(/you>/g).length, before);
});

test('async generation streams task logs and returns the validated graph', async t => {
    const f = await fixture(t);
    const { id } = await f.service.startGeneration({ description: 'Make a graph' });
    while (!f.started.length) await new Promise(resolve => setImmediate(resolve));
    assert.equal(f.started[0].robot.name, 'default');
    f.service.runtimeManager.taskStatus = () => ({ logTail: 'working on it' });
    assert.deepEqual(f.service.generationInfo(id), { id, status: 'running', log: 'working on it', graph: null, error: null });
    await f.finish(0, JSON.stringify(graph()));
    let done = null;
    for (let attempt = 0; attempt < 100 && done?.status !== 'completed'; attempt++) {
        done = f.service.generationInfo(id) || done;
        if (done?.status !== 'completed') await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.equal(done.status, 'completed');
    assert.equal(done.graph.entryTaskId, 'a');
    assert.equal(done.graph.defaultObjective, 'Make a graph');
    assert.equal(f.service.generationInfo(id), null);
});

test('cancelling an async generation stops its runtime task', async t => {
    const f = await fixture(t);
    const { id } = await f.service.startGeneration({ description: 'Make a graph' });
    while (!f.started.length) await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(f.service.cancelGeneration(id), { id, status: 'cancelled', graph: null, error: 'Graph generation cancelled' });
    assert.deepEqual(f.stopped, [f.started[0].taskId]);
    assert.equal(f.service.generationInfo(id), null);
    assert.equal(f.service.cancelGeneration(id), null);
});

test('cancelling a generation releases the pending runtime completion and ignores later output', async t => {
    const f = await fixture(t);
    const { id } = await f.service.startGeneration({ description: 'Read' });
    while (!f.started.length) await new Promise(resolve => setImmediate(resolve));
    f.service.cancelGeneration(id);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(f.service.generations.size, 0);
    await f.finish(0, JSON.stringify(graph()));
    assert.equal(f.service.generationInfo(id), null); assert.equal(await f.service.registry.get('example'), null);
});

test('Save needs a description, a task and every prompt; other gaps are warnings until a run starts', async t => {
    const f = await fixture(t);
    await assert.rejects(f.service.createWorkflow({ ...graph(), description: ' ' }), /Add a workflow description before saving/);
    await assert.rejects(f.service.createWorkflow({ ...graph(), entryTaskId: '', tasks: [], edges: [] }), /Add at least one task before saving/);
    await assert.rejects(f.service.createWorkflow({ ...graph(), tasks: [task('a'), task('b', { prompt: '' }), task('c')] }), /Task b needs a prompt before saving/);
    const saved = await f.service.createWorkflow({ ...graph(), tasks: [task('a'), task('b', { name: '' }), task('c')] });
    await assert.rejects(f.service.updateWorkflow(saved.id, { ...saved, description: '' }), /Add a workflow description before saving/);
    assert.equal(saved.tasks[1].name, '');
    assert.ok((await f.service.validateDraft(saved)).diagnostics.some(item => item.message === 'Task b needs a name'));
    await assert.rejects(f.service.startFlow({ workflowTypeId: saved.id, objective: 'Work' }), /not ready to run: Task b needs a name/);
    assert.equal(f.started.length, 0);
});

test('human input commits before routing and concurrent answers resume the same visit once', async t => {
    const f = await fixture(t);
    await f.service.createWorkflow({ ...graph(), tasks: [task('a', { allowsHumanInput: true }), task('b')], edges: [edge('a', 'b')] });
    const flow = await f.service.startFlow({ workflowTypeId: 'example', objective: 'Work' });
    const runtimeTaskId = f.started[0].taskId;
    assert.equal(f.started[0].request.allowsHumanInput, true);
    const input = { question: 'Which customer?', options: ['Retail', 'Business', 'Enterprise'] };
    const question = await f.service.requestHumanInput(runtimeTaskId, input);
    assert.equal((await f.service.requestHumanInput(runtimeTaskId, input)).id, question.id);
    assert.equal((await f.service.getFlow(flow.id)).status, 'paused');
    await assert.rejects(f.service.answerHumanInput(flow.id, { requestId: question.id, option: 0 }), /finishing/);
    await assert.rejects(f.service.resumeFlow(flow.id), /pending human-input/);
    await assert.rejects(f.service.resumeInstance(flow.id, flow.instances[0].id, 'skip'), /pending human-input/);
    await f.finish(0, 'Waiting for the user.');
    const paused = await f.service.getFlow(flow.id);
    assert.equal(paused.humanInput.executionEnded, true);
    assert.equal(paused.instances.length, 1);
    assert.equal(f.started.length, 1);
    const answers = await Promise.allSettled([
        f.service.answerHumanInput(flow.id, { requestId: question.id, option: 3, text: 'Partners' }, 'user-1'),
        f.service.answerHumanInput(flow.id, { requestId: question.id, option: 1 }, 'user-2'),
    ]);
    assert.equal(answers.filter(result => result.status === 'fulfilled').length, 1);
    assert.equal(f.resumed.length, 1);
    assert.equal(f.resumed[0].taskId, runtimeTaskId);
    assert.equal(f.resumed[0].prompt, 'My answer to your question is: Partners');
    const resumed = await f.service.getFlow(flow.id);
    assert.equal(resumed.status, 'running');
    assert.equal(resumed.humanInput.answeredBy, 'user-1');
    assert.equal(resumed.instances[0].id, flow.instances[0].id);
    f.service.onRuntimeTaskEvent({ kind: 'terminal', taskId: resumed.instances[0].runtimeTaskId, state: 'completed', result: 'Now done' });
    while (f.service.chains.size) await Promise.allSettled(f.service.chains.values());
    assert.equal(f.started.length, 2);
    assert.equal((await f.service.getFlow(flow.id)).instances[1].taskId, 'b');
});

test('human input rejects disabled nodes, stale executions and malformed questions', async t => {
    const f = await fixture(t);
    await f.service.createWorkflow({ ...graph(), edges: [] });
    await f.service.startFlow({ workflowTypeId: 'example', objective: 'Work' });
    const id = f.started[0].taskId;
    await assert.rejects(f.service.requestHumanInput(id, { question: 'Q', options: ['a', 'b'] }), /three/);
    await assert.rejects(f.service.requestHumanInput(id, { question: 'Q', options: ['a', 'a', 'b'] }), /distinct/);
    await assert.rejects(f.service.requestHumanInput(id, { question: 'Q', options: ['a', 'b', 'c'] }), /not allowed/);
    await f.finish(0);
    await assert.rejects(f.service.requestHumanInput(id, { question: 'Q', options: ['a', 'b', 'c'] }), /no longer active/);
    assert.throws(() => normalizeWorkflow({ ...graph(), tasks: [task('a', { allowsHumanInput: 'true' })], edges: [] }), /boolean/);
});

test('human-input answer restores the pending question when continuation cannot start', async t => {
    const f = await fixture(t);
    await f.service.createWorkflow({ ...graph(), tasks: [task('a', { allowsHumanInput: true })], edges: [] });
    const flow = await f.service.startFlow({ workflowTypeId: 'example', objective: 'Work' });
    const question = await f.service.requestHumanInput(f.started[0].taskId, { question: 'Q?', options: ['a', 'b', 'c'] });
    await f.finish(0, 'Waiting', 'failed');
    f.service.runtimeManager.resumeTask = async () => { throw new Error('Robot unavailable'); };
    await assert.rejects(f.service.answerHumanInput(flow.id, { requestId: question.id, option: 0 }), /Robot unavailable/);
    const paused = await f.service.getFlow(flow.id);
    assert.equal(paused.status, 'paused');
    assert.equal(paused.humanInput.status, 'pending');
    assert.equal(paused.instances[0].runtimeTaskId, f.started[0].taskId);
});

test('pending question survives restart and can be answered after the old task is gone', async t => {
    const f = await fixture(t);
    await f.service.createWorkflow({ ...graph(), tasks: [task('a', { allowsHumanInput: true })], edges: [] });
    const flow = await f.service.startFlow({ workflowTypeId: 'example', objective: 'Work' });
    const question = await f.service.requestHumanInput(f.started[0].taskId, { question: 'Q?', options: ['a', 'b', 'c'] });
    await f.service.close();
    await f.service.initialize();
    const recovered = await f.service.getFlow(flow.id);
    assert.equal(recovered.humanInput.id, question.id);
    assert.equal(recovered.humanInput.executionEnded, true);
    assert.equal(recovered.status, 'paused');
    assert.equal((await f.service.answerHumanInput(flow.id, { requestId: question.id, option: 2 })).status, 'running');
    assert.equal(f.resumed[0].prompt, 'My answer to your question is: c');
});

test('a resumed task can ask another question and stale replies cannot answer it', async t => {
    const f = await fixture(t);
    await f.service.createWorkflow({ ...graph(), tasks: [task('a', { allowsHumanInput: true })], edges: [] });
    const flow = await f.service.startFlow({ workflowTypeId: 'example', objective: 'Work' });
    const input = { question: 'Q?', options: ['a', 'b', 'c'] };
    const first = await f.service.requestHumanInput(f.started[0].taskId, input);
    await f.finish(0);
    const resumed = await f.service.answerHumanInput(flow.id, { requestId: first.id, option: 0 });
    const taskId = resumed.instances[0].runtimeTaskId;
    const second = await f.service.requestHumanInput(taskId, input);
    assert.notEqual(second.id, first.id);
    f.service.onRuntimeTaskEvent({ kind: 'terminal', taskId, state: 'completed', result: 'Waiting again' });
    while (f.service.chains.size) await Promise.allSettled(f.service.chains.values());
    await assert.rejects(f.service.answerHumanInput(flow.id, { requestId: first.id, option: 0 }), /no longer waiting/);
    assert.equal((await f.service.getFlow(flow.id)).humanInput.id, second.id);
});

test('a child question pauses the parent join and answering resumes the graph', async t => {
    const f = await fixture(t);
    await f.service.createWorkflow({ id: 'child', name: 'Child', description: 'Child workflow', entryTaskId: 'one', tasks: [task('one', { allowsHumanInput: true })], edges: [] });
    await f.service.createWorkflow({ id: 'parent', name: 'Parent', description: 'Parent workflow', entryTaskId: 'creator', tasks: [task('creator', { creator: true }), task('end')],
        edges: [{ id: 'delegate', sourceTaskId: 'creator', targetTaskId: 'run-workflows' }, { id: 'after', sourceTaskId: 'run-workflows', targetTaskId: 'end' }] });
    const parent = await f.service.startFlow({ workflowTypeId: 'parent', objective: 'Work' });
    await f.finish(0, '# nextEdgeId\ndelegate\n# afterWorkflowsEdgeId\nafter\n# workflow\nchild\n# prompt\nChoose customer');
    const child = (await f.service.listFlows()).find(flow => flow.parentFlowId === parent.id);
    const request = await f.service.requestHumanInput(f.started[1].taskId, { question: 'Q?', options: ['a', 'b', 'c'] });
    await f.finish(1, 'Waiting');
    assert.equal((await f.service.getFlow(parent.id)).status, 'paused');
    const continued = await f.service.answerHumanInput(child.id, { requestId: request.id, option: 0 });
    f.service.onRuntimeTaskEvent({ kind: 'terminal', taskId: continued.instances[0].runtimeTaskId, state: 'completed', result: 'Done' });
    while (f.service.chains.size) await Promise.allSettled(f.service.chains.values());
    assert.equal((await f.service.getFlow(parent.id)).instances.at(-1).taskId, 'end');
    assert.equal(f.started.length, 3);
});

test('a terminal event queued behind the question cannot route even without routing output', async t => {
    const f = await fixture(t);
    await f.service.createWorkflow({ ...graph(), tasks: [task('a', { allowsHumanInput: true }), task('b'), task('c')] });
    const flow = await f.service.startFlow({ workflowTypeId: 'example', objective: 'Work' });
    const asking = f.service.requestHumanInput(f.started[0].taskId, { question: 'Q?', options: ['a', 'b', 'c'] });
    const ending = f.finish(0, 'Waiting without a nextEdgeId');
    await Promise.all([asking, ending]);
    const paused = await f.service.getFlow(flow.id);
    assert.equal(paused.status, 'paused');
    assert.equal(paused.error, null);
    assert.equal(paused.humanInput.executionEnded, true);
    assert.equal(f.started.length, 1);
});


test('a missing output directory does not leave a finished human-input execution unanswerable', async t => {
    const f = await fixture(t);
    await f.service.createWorkflow({ ...graph(), tasks: [task('a', { allowsHumanInput: true })], edges: [] });
    const flow = await f.service.startFlow({ workflowTypeId: 'example', objective: 'Work' });
    await f.service.requestHumanInput(f.started[0].taskId, { question: 'Q?', options: ['a', 'b', 'c'] });
    f.service.store.writeOutput = async () => { throw new Error('Output unavailable'); };
    await f.finish(0, 'Waiting');
    const paused = await f.service.getFlow(flow.id);
    assert.equal(paused.humanInput.executionEnded, true);
    assert.equal(paused.instances[0].outputUnavailable, true);
});

test('termination is irreversible, survives restart and ignores late runtime events', async t => {
    const f = await fixture(t);
    await f.service.createWorkflow(graph());
    const flow = await f.service.startFlow({ workflowTypeId: 'example', objective: 'Work' });
    const instance = flow.instances[0];
    const ending = f.service.terminateFlow(flow.id);
    f.service.onRuntimeTaskEvent({ kind: 'terminal', taskId: instance.runtimeTaskId, state: 'completed', result: '#Edge\na-b' });
    await ending;
    while (f.service.chains.size) await Promise.allSettled(f.service.chains.values());
    let current = await f.service.getFlow(flow.id);
    assert.equal(current.status, 'terminated');
    assert.equal(current.instances.length, 1);
    assert.equal(current.instances[0].state, 'terminated');
    assert.ok(f.stopped.includes(instance.runtimeTaskId));
    await assert.rejects(f.service.resumeFlow(flow.id), /Terminated/);
    await assert.rejects(f.service.resumeInstance(flow.id, instance.id, 'Continue'), /Terminated/);
    assert.equal(f.started[0].request.workflowRunId, flow.id);
    await assert.rejects(f.service.runtimeManager.assertHumanInputAnswered(instance.runtimeTaskId), /Terminated/);
    await assert.rejects(f.service.runtimeManager.assertHumanInputAnswered('previous-attempt', flow.id), /Terminated/);
    await f.service.initialize();
    await f.service.pauseFlow(flow.id);
    current = await f.service.terminateFlow(flow.id);
    assert.equal(current.status, 'terminated');
    assert.equal(f.started.length, 1);
});

test('termination cancels pending human input and stops the still-running question author', async t => {
    const f = await fixture(t);
    await f.service.createWorkflow({ ...graph(), tasks: [task('a', { allowsHumanInput: true })], edges: [] });
    const flow = await f.service.startFlow({ workflowTypeId: 'example', objective: 'Work' });
    const question = await f.service.requestHumanInput(f.started[0].taskId, { question: 'Q?', options: ['a', 'b', 'c'] });
    await f.service.terminateFlow(flow.id);
    await assert.rejects(f.service.answerHumanInput(flow.id, { requestId: question.id, option: 0 }));
    await f.finish(0, 'Waiting');
    await f.service.initialize();
    const current = await f.service.getFlow(flow.id);
    assert.equal(current.status, 'terminated');
    assert.equal(current.humanInput.status, 'cancelled');
    assert.ok(f.stopped.includes(f.started[0].taskId));
});

test('terminating a parent terminates running and pending children without launching the next node', async t => {
    const f = await fixture(t);
    await f.service.createWorkflow({ id: 'child', name: 'Child', description: 'Child workflow', entryTaskId: 'one', tasks: [task('one')], edges: [] });
    await f.service.createWorkflow({ id: 'parent', name: 'Parent', description: 'Parent workflow', entryTaskId: 'creator',
        tasks: [task('creator', { creator: true }), task('end')],
        edges: [{ id: 'delegate', sourceTaskId: 'creator', targetTaskId: 'run-workflows' },
            { id: 'after', sourceTaskId: 'run-workflows', targetTaskId: 'end' }] });
    const parent = await f.service.startFlow({ workflowTypeId: 'parent', objective: 'Work' });
    await f.finish(0, JSON.stringify({ nextEdgeId: 'delegate', afterWorkflowsEdgeId: 'after',
        workflows: [{ workflowTypeId: 'child', prompt: 'First' }, { workflowTypeId: 'child', prompt: 'Second' }] }));
    const children = (await f.service.listFlows()).filter(flow => flow.parentFlowId === parent.id);
    assert.equal(children.length, 2);
    await f.service.terminateFlow(parent.id);
    await f.finish(1, 'Late child output');
    for (const child of children) {
        assert.equal((await f.service.getFlow(child.id)).status, 'terminated');
        await assert.rejects(f.service.resumeFlow(child.id), /Terminated/);
    }
    await assert.rejects(f.service.resumeInstance(parent.id, parent.instances[0].id, 'Again'), /Terminated/);
    assert.equal((await f.service.getFlow(parent.id)).status, 'terminated');
    assert.equal(f.started.length, 2);
});

test('startup does not wait for the marketplace; the Code Development preset appears once it answers', async t => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'roboflow-preset-'));
    let attempts = 0;
    const repositoriesClient = { listRepositories: async () => {
        attempts += 1;
        if (attempts < 3) throw Object.assign(new Error('Marketplace request failed: EDGE_GENERATION_INACTIVE'), { code: 'EDGE_GENERATION_INACTIVE' });
        return [{ name: 'DocumentationSkills', source: root, origin: 'local' }];
    } };
    const service = new RoboFlowService({ robotStore: { list: async () => [] }, runtimeManager: { resolveCwd: async value => value || root },
        skillsets: { repositoriesClient }, databaseFile: path.join(root, 'roboflow.sqlite'), workflowsDirectory: path.join(root, 'old'), presetRetryMs: 10 });
    const errors = [];
    const originalError = console.error;
    console.error = (message) => errors.push(String(message));
    t.after(async () => { console.error = originalError; await service.close(); await fs.rm(root, { recursive: true, force: true }); });
    await service.initialize();
    assert.equal(await service.registry.get('code-development'), null);
    assert.ok(await service.registry.get('default'));
    assert.equal(await service.presetReady, true);
    assert.equal(attempts, 3);
    assert.ok(await service.registry.get('code-development'));
    assert.equal(errors.filter((line) => line.includes('Code Development workflow is not available yet')).length, 1);
});

test('closing the service stops a preset retry that is still waiting', async t => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'roboflow-preset-close-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const service = new RoboFlowService({ robotStore: { list: async () => [] }, runtimeManager: { resolveCwd: async value => value || root },
        skillsets: { repositoriesClient: { listRepositories: async () => { throw new Error('unavailable'); } } },
        databaseFile: path.join(root, 'roboflow.sqlite'), workflowsDirectory: path.join(root, 'old'), presetRetryMs: 60000 });
    const originalError = console.error;
    console.error = () => {};
    try {
        await service.initialize();
        await service.close();
        assert.equal(await service.presetReady, false);
    } finally { console.error = originalError; }
});

test('forced failure affects only its phase and keeps workflow state priority', async t => {
    const f = await fixture(t); await f.service.createWorkflow(graph());
    for (const otherState of [null, 'running', 'paused']) {
        const flow = await f.service.startFlow({ workflowTypeId: 'example', objective: 'Work' });
        const runtimeTaskId = f.started.at(-1).taskId;
        if (otherState) await f.service.store.update(flow.id, current => {
            current.instances.push({ ...f.service._instance('b', current.instances.length), state: otherState });
        });
        f.service.onRuntimeTaskEvent({ kind: 'terminal', taskId: runtimeTaskId, state: 'failed', forcedFailure: true, error: 'Deployment access is unavailable.' });
        while (f.service.chains.size) await Promise.allSettled(f.service.chains.values());
        const updated = await f.service.store.get(flow.id);
        assert.equal(updated.instances[0].state, 'failed');
        assert.equal(updated.instances[0].error, 'Deployment access is unavailable.');
        assert.equal(updated.status, otherState || 'failed');
        if (otherState) assert.equal(updated.instances[1].state, otherState);
        const count = f.started.length;
        f.service.onRuntimeTaskEvent({ kind: 'terminal', taskId: runtimeTaskId, state: 'completed', result: 'Wrong success' });
        while (f.service.chains.size) await Promise.allSettled(f.service.chains.values());
        assert.equal((await f.service.store.get(flow.id)).instances[0].state, 'failed');
        assert.equal(f.started.length, count);
    }
    assert.deepEqual(f.stopped, []);
});

// Live Sessions ownership: flows keep the signed principal of whoever started
// them; every phase, child flow and continuation carries it unchanged.
test('a flow stores the signed owner and every dispatched phase carries owner and phase association', async t => {
    const f = await fixture(t);
    await f.service.createWorkflow(graph());
    const flow = await f.service.startFlow({ workflowTypeId: 'example', folder: f.root, objective: 'Work', createdBy: 'alice', ownerPrincipal: 'user:alice' });
    assert.equal((await f.service.store.get(flow.id)).ownerPrincipal, 'user:alice');
    const first = (await f.service.getFlow(flow.id)).instances[0];
    assert.equal(f.started[0].request.ownerPrincipal, 'user:alice');
    assert.equal(f.started[0].request.workflowRunId, flow.id);
    assert.equal(f.started[0].request.workflowInstanceId, first.id);
    await f.finish(0, '#Edge\na-b');
    const second = (await f.service.getFlow(flow.id)).instances[1];
    assert.equal(f.started[1].request.ownerPrincipal, 'user:alice');
    assert.equal(f.started[1].request.workflowInstanceId, second.id);
    // Unsigned or malformed owners are the system owner.
    for (const owner of [undefined, null, 'alice', '', 'user:']) {
        const other = await f.service.startFlow({ workflowTypeId: 'example', folder: f.root, objective: 'Work', ownerPrincipal: owner });
        assert.equal((await f.service.store.get(other.id)).ownerPrincipal, null, String(owner));
        assert.equal(f.started.at(-1).request.ownerPrincipal, null, String(owner));
    }
});

test('child workflows inherit the parent owner', async t => {
    const f = await fixture(t);
    await f.service.createWorkflow({ id: 'child', name: 'Child', entryTaskId: 'one', tasks: [task('one')], edges: [] });
    await f.service.createWorkflow({ id: 'parent', name: 'Parent', entryTaskId: 'creator', tasks: [task('creator', { creator: true }), task('end')],
        edges: [{ id: 'delegate', sourceTaskId: 'creator', targetTaskId: 'run-workflows' }, { id: 'after', sourceTaskId: 'run-workflows', targetTaskId: 'end' }] });
    const parent = await f.service.startFlow({ workflowTypeId: 'parent', objective: 'Work', ownerPrincipal: 'user:alice' });
    await f.finish(0, `# nextEdgeId\ndelegate\n# afterWorkflowsEdgeId\nafter\n# workflow\nchild\n# prompt\nDo it.`);
    const [childId] = (await f.service.getFlow(parent.id)).instances[0].childFlowIds;
    assert.equal((await f.service.store.get(childId)).ownerPrincipal, 'user:alice');
    assert.equal(f.started[1].request.ownerPrincipal, 'user:alice');
    assert.equal(f.started[1].request.workflowRunId, childId);
});

test('a re-dispatched never-started phase keeps the flow owner', async t => {
    const f = await fixture(t);
    await f.service.createWorkflow(graph());
    const flow = await f.service.startFlow({ workflowTypeId: 'example', folder: f.root, objective: 'Work', ownerPrincipal: 'user:alice' });
    await f.service.pauseFlow(flow.id);
    await f.service.resumeInstance(flow.id, (await f.service.getFlow(flow.id)).instances[0].id, 'Again');
    assert.equal(f.started.length, 2);
    assert.equal(f.started[1].request.ownerPrincipal, 'user:alice');
});

test('runtime admission events never change phase state or start time', async t => {
    const f = await fixture(t);
    await f.service.createWorkflow(graph());
    const flow = await f.service.startFlow({ workflowTypeId: 'example', folder: f.root, objective: 'Work' });
    f.service.onRuntimeTaskEvent({ kind: 'admitted', taskId: f.started[0].taskId, state: 'running' });
    while (f.service.chains.size) await Promise.allSettled(f.service.chains.values());
    const [phase] = (await f.service.getFlow(flow.id)).instances;
    assert.equal(phase.state, 'queued');
    assert.equal(phase.startedAt, null);
});

test('with the Live Sessions source wired after it, RoboFlow still advances and the phase row ends', async t => {
    const { LiveSessionsRegistry } = await import('../server/live-sessions/registry.mjs');
    const { RuntimeLiveSource, composeTaskObservers } = await import('../server/live-sessions/runtime-source.mjs');
    const f = await fixture(t);
    await f.service.createWorkflow(graph());
    const registry = new LiveSessionsRegistry({ log: () => {} });
    const source = new RuntimeLiveSource({ registry, runtimeManager: f.service.runtimeManager, robotStore: f.service.robotStore, roboflow: f.service, workspaceRoot: f.root });
    const order = [];
    const observe = composeTaskObservers(event => { order.push(`roboflow:${event.kind}`); f.service.onRuntimeTaskEvent(event); },
        [event => { order.push(`live:${event.kind}`); source.onRuntimeTaskEvent(event); }]);
    const flow = await f.service.startFlow({ workflowTypeId: 'example', folder: f.root, objective: 'Work', ownerPrincipal: 'user:alice' });
    const first = f.started[0];
    // The real runtime announces admission with the request's owner and phase.
    observe({ kind: 'admitted', robotId: first.robot.id, robotName: first.robot.name, taskId: first.taskId, type: first.type, state: 'queued',
        cwd: first.request.cwd, ownerPrincipal: first.request.ownerPrincipal, workflowRunId: first.request.workflowRunId, workflowInstanceId: first.request.workflowInstanceId });
    observe({ kind: 'progress', taskId: first.taskId, chunk: 'working' });
    observe({ kind: 'terminal', taskId: first.taskId, state: 'completed', result: '#Edge\na-b' });
    while (f.service.chains.size) await Promise.allSettled(f.service.chains.values());
    assert.equal(f.service.bindings.has(first.taskId), false, 'RoboFlow forgot the binding');
    assert.equal(f.started.length, 2, 'RoboFlow advanced to the next phase');
    assert.equal((await f.service.getFlow(flow.id)).instances[0].state, 'completed');
    const [row] = registry.list({ principal: 'user:alice', canAdmin: false });
    assert.equal(row.kind, 'workflow-phase');
    assert.equal(row.status, 'finished');
    assert.deepEqual(order, ['roboflow:admitted', 'live:admitted', 'roboflow:progress', 'live:progress', 'roboflow:terminal', 'live:terminal']);
});

test('RoboFlow continuations name their phase, and a message to a phase that is not running is run_ended', async t => {
    const f = await fixture(t);
    await f.service.createWorkflow(graph());
    const options = [];
    const resumeTask = f.service.runtimeManager.resumeTask;
    f.service.runtimeManager.resumeTask = (robot, taskId, prompt, opts = {}) => { options.push(opts); return resumeTask(robot, taskId, prompt, opts); };
    const flow = await f.service.startFlow({ workflowTypeId: 'example', folder: f.root, objective: 'Work' });
    const [phase] = (await f.service.getFlow(flow.id)).instances;
    f.service.onRuntimeTaskEvent({ kind: 'state', taskId: f.started[0].taskId, state: 'running' });
    while (f.service.chains.size) await Promise.allSettled(f.service.chains.values());
    await f.finish(0, 'Partial', 'paused');
    await assert.rejects(f.service.messageInstance(flow.id, phase.id, 'hello'), (error) => error.liveOutcome === 'run_ended');
    await f.service.resumeInstance(flow.id, phase.id, 'Continue');
    assert.equal(options.length, 1);
    assert.equal(options[0].workflowInstanceId, phase.id);
    assert.match(options[0].runtimeTaskId, /^[0-9a-f-]{36}$/u);
});
