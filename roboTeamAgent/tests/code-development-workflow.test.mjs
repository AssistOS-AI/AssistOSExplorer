import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { presetGraph, readPresets } from '../server/roboflow/workflow-presets.mjs';
import { ScheduleFolders } from '../server/roboflow/schedule-folders.mjs';
import { WorkflowRegistry } from '../server/roboflow/workflow-registry.mjs';
import { graphDiagnostics } from '../server/roboflow/graph.mjs';
import { parseRoute } from '../server/roboflow/result-parser.mjs';

test('Code Development delegates from Planning and routes validation to rework or Finish', () => {
    const graph = presetGraph(readPresets().find(preset => preset.id === 'code-development'), { DocumentationSkills: '/skills' });
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

test('built-in workflows are JSON files in default-flows, resolved when loaded and never editable', async t => {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'code-development-')));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const presets = readPresets();
    assert.deepEqual(presets.map(preset => [preset.id, preset.repositories]), [['code-development', ['DocumentationSkills']], ['default', []]]);
    const code = presets.find(preset => preset.id === 'code-development');
    assert.throws(() => presetGraph(code), /DocumentationSkills is not available/);
    const registry = new WorkflowRegistry({ directory: path.join(root, 'flows'), presetIds: presets.map(preset => preset.id) });
    // A preset id is reserved before the preset itself can load.
    await assert.rejects(registry.create({ ...presetGraph(code, { DocumentationSkills: root }), id: undefined, name: 'Code Development' }), { statusCode: 409 });
    for (const preset of presets) registry.addPreset(presetGraph(preset, { DocumentationSkills: root }));
    const loaded = await registry.get('code-development');
    assert.equal(loaded.readOnly, true);
    assert.deepEqual(loaded.tasks.find(task => task.id === 'planning').skillsets, [path.join(root, 'gamp-specs'), path.join(root, 'detect-main-behaviors')]);
    assert.equal((await registry.get('default')).kind, 'default');
    await assert.rejects(registry.update('default', loaded), /cannot be edited/);
    await assert.rejects(registry.remove('code-development'), /cannot be deleted/);
    // Built-in workflows are never written to the internal folder.
    assert.deepEqual(await fs.readdir(path.join(root, 'flows')), []);
});

test('Save as copies a built-in workflow; the generic one becomes a terminal workflow', async t => {
    const { workflowCopy } = await import('../public/workflow-editor.js');
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'preset-copy-')));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    await fs.mkdir(path.join(root, 'Repo'));
    const presets = readPresets();
    const registry = new WorkflowRegistry({ directory: path.join(root, '.data'), presetIds: presets.map(preset => preset.id),
        workspaceRoot: root, folders: new ScheduleFolders(root) });
    for (const preset of presets) registry.addPreset(presetGraph(preset, { DocumentationSkills: root }));
    const generic = await registry.create(workflowCopy(await registry.get('default')), { location: 'Repo' });
    assert.equal(generic.id, 'default-copy'); assert.equal(generic.kind, undefined); assert.equal(generic.readOnly, false);
    assert.deepEqual(generic.tasks.map(task => task.executionType), ['terminal']);
    const code = await registry.create(workflowCopy(await registry.get('code-development')), { location: 'Repo' });
    assert.deepEqual(code.source, { kind: 'file', path: 'Repo/flows/code-development-copy.json' });
    assert.deepEqual(code.tasks.map(task => task.id), (await registry.get('code-development')).tasks.map(task => task.id));
});
