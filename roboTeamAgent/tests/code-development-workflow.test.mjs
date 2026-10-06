import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { codeDevelopmentWorkflowDefinition, ensureCodeDevelopmentWorkflow } from '../server/roboflow/code-development-workflow.mjs';
import { WorkflowRegistry } from '../server/roboflow/workflow-registry.mjs';
import { graphDiagnostics, normalizeWorkflow } from '../server/roboflow/graph.mjs';
import { parseRoute } from '../server/roboflow/result-parser.mjs';

test('Code Development delegates from Planning and routes validation to rework or Finish', () => {
    const graph = normalizeWorkflow(codeDevelopmentWorkflowDefinition());
    assert.deepEqual(graphDiagnostics(graph), []);
    for (const edge of graph.edges) {
        assert.equal(edge.sourcePort, 'right', `${edge.id} must leave the output port`);
        assert.equal(edge.targetPort, 'left', `${edge.id} must enter the input port`);
    }
    assert.deepEqual(graph.tasks.filter(task => task.creator).map(task => task.id), ['planning']);
    assert.ok(!graph.tasks.some(task => task.id === 'execution'));
    assert.deepEqual(graph.edges.map(edge => [edge.sourceTaskId, edge.targetTaskId]), [
        ['planning', 'run-workflows'], ['run-workflows', 'validation'],
        ['validation', 'planning'], ['validation', 'finish'],
    ]);
    for (const nextEdgeId of ['validation-to-planning', 'validation-to-finish']) {
        assert.equal(parseRoute(JSON.stringify({ nextEdgeId }), graph, 'validation').nextEdgeId, nextEdgeId);
    }
    assert.throws(() => parseRoute('Done', graph, 'validation'));
    assert.ok(!graph.edges.some(edge => edge.sourceTaskId === 'finish'));
});

test('startup upgrades older Code Development graphs once and preserves run snapshots', async t => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'code-development-'));
    const registry = new WorkflowRegistry({ directory: root });
    t.after(async () => { registry.database.close(); await fs.rm(root, { recursive: true, force: true }); });
    const skillService = { repositoriesClient: { listRepositories: async () => [
        { name: 'DocumentationSkills', source: root, origin: 'local' },
    ] } };
    const legacy = codeDevelopmentWorkflowDefinition(root);
    legacy.tasks = legacy.tasks.filter(task => task.id !== 'finish');
    legacy.tasks.find(task => task.id === 'planning').creator = false;
    legacy.tasks.push({ id: 'execution', name: 'Execution', creator: true,
        executionType: 'terminal', skillsets: [], prompt: 'Delegate implementation.' });
    legacy.edges = [
        { id: 'planning-to-execution', sourceTaskId: 'planning', targetTaskId: 'execution' },
        { id: 'execution-to-subflows', sourceTaskId: 'execution', targetTaskId: 'run-workflows' },
        { id: 'execution-to-validation', sourceTaskId: 'execution', targetTaskId: 'validation' },
        { id: 'subflows-to-validation', sourceTaskId: 'run-workflows', targetTaskId: 'validation' },
    ];
    const original = await registry.create(legacy, false, { system: true });
    const snapshot = JSON.stringify({ id: 'existing-run', graph: original });
    registry.database.db.prepare('INSERT INTO workflow_runs (id, record) VALUES (?, ?)')
        .run('existing-run', snapshot);
    const updated = await ensureCodeDevelopmentWorkflow(registry, skillService);
    assert.equal(updated.revision, original.revision + 1);
    assert.equal(updated.createdAt, original.createdAt);
    assert.deepEqual(normalizeWorkflow(updated), normalizeWorkflow(codeDevelopmentWorkflowDefinition(await fs.realpath(root))));
    assert.deepEqual(await ensureCodeDevelopmentWorkflow(registry, skillService), updated);
    assert.equal(registry.database.db.prepare('SELECT record FROM workflow_runs WHERE id=?').get('existing-run').record, snapshot);
});
