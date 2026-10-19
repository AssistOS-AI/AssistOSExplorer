import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { WorkflowRegistry } from '../server/roboflow/workflow-registry.mjs';
import { ScheduleFolders } from '../server/roboflow/schedule-folders.mjs';

const definition = (name, extra = {}) => ({ name, description: 'A test workflow.', entryTaskId: 'one', edges: [],
    tasks: [{ id: 'one', name: 'One', prompt: 'Do one.', executionType: 'terminal', skillsets: [] }], ...extra });

async function workspace(t) {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'workflow-files-')));
    const registry = new WorkflowRegistry({ directory: path.join(root, '.data', 'roboflow', 'flows'), presetIds: ['default', 'code-development'],
        workspaceRoot: root, folders: new ScheduleFolders(root) });
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const write = async (relative, value) => {
        await fs.mkdir(path.dirname(path.join(root, relative)), { recursive: true });
        await fs.writeFile(path.join(root, relative), typeof value === 'string' ? value : JSON.stringify(value));
    };
    return { root, registry, write };
}

test('workflow files in <repository>/flows and <repository>/<folder>/flows are listed beside internal workflows', async t => {
    const { root, registry, write } = await workspace(t);
    await registry.create(definition('Internal one'));
    await write('Repo/flows/add-topics.json', definition('Add topics', { tasks: [{ id: 'one', name: 'One', prompt: 'Do one.',
        executionType: 'terminal', skillsets: ['Repo/skills/add-topic', 'builtin:copilot/bash'] }] }));
    await write('Repo/agent/flows/deep-flow.json', definition('Deep flow'));
    // Hidden, dependency and deeper folders are not scanned.
    await write('.data/flows/hidden.json', definition('Hidden'));
    await write('Repo/node_modules/flows/dependency.json', definition('Dependency'));
    await write('Repo/agent/inner/flows/too-deep.json', definition('Too deep'));
    const workflows = await registry.list();
    assert.deepEqual(workflows.map(workflow => workflow.id).sort(), ['add-topics', 'deep-flow', 'internal-one']);
    const file = workflows.find(workflow => workflow.id === 'add-topics');
    assert.deepEqual(file.source, { kind: 'file', path: 'Repo/flows/add-topics.json' });
    assert.deepEqual(workflows.find(workflow => workflow.id === 'internal-one').source, { kind: 'internal' }, 'internal workflows carry no path');
    // Save keeps an internal workflow as a JSON file in the agent's data folder, never in the database.
    assert.equal(JSON.parse(await fs.readFile(path.join(root, '.data/roboflow/flows/internal-one.json'), 'utf8')).name, 'Internal one');
    // Workspace-relative skill paths resolve against the workspace; other identities stay unchanged.
    assert.deepEqual(file.tasks[0].skillsets, [path.join(root, 'Repo/skills/add-topic'), 'builtin:copilot/bash']);
    assert.equal(file.readOnly, false);
    assert.equal((await registry.get('deep-flow')).name, 'Deep flow');
    assert.deepEqual(registry.fileErrors, []);
});

test('a workflow can be created as a file, edited with a stale-save check and deleted', async t => {
    const { root, registry } = await workspace(t);
    await fs.mkdir(path.join(root, 'Repo', 'agent'), { recursive: true });
    const skill = path.join(root, 'Repo/skills/add-topic');
    const created = await registry.create(definition('Add topics', { tasks: [{ id: 'one', name: 'One', prompt: 'Do one.',
        executionType: 'terminal', skillsets: [skill, '/elsewhere/skill'] }] }), { location: 'Repo/agent' });
    assert.deepEqual(created.source, { kind: 'file', path: 'Repo/agent/flows/add-topics.json' });
    const file = path.join(root, 'Repo/agent/flows/add-topics.json');
    const saved = JSON.parse(await fs.readFile(file, 'utf8'));
    // Only the definition is stored; skills inside the workspace are stored relative to it.
    assert.deepEqual(Object.keys(saved), ['schemaVersion', 'name', 'description', 'entryTaskId', 'tasks', 'edges', 'layout']);
    assert.deepEqual(saved.tasks[0].skillsets, ['Repo/skills/add-topic', '/elsewhere/skill']);
    assert.deepEqual(created.tasks[0].skillsets, [skill, '/elsewhere/skill']);
    // A flows folder location means the same folder; the id stays unique across both sources.
    await assert.rejects(registry.create(definition('Add topics'), { location: 'Repo/flows' }), { statusCode: 409 });
    await assert.rejects(registry.create(definition('Add topics')), { statusCode: 409 });
    await assert.rejects(registry.create(definition('Other'), { location: 'Repo/agent/deeper' }), { statusCode: 400 });
    await assert.rejects(registry.create(definition('Other'), { location: '../outside' }), { statusCode: 400 });

    const updated = await registry.update('add-topics', { ...created, description: 'Adds topics.' });
    assert.equal(updated.description, 'Adds topics.');
    assert.notEqual(updated.revision, created.revision);
    assert.equal(JSON.parse(await fs.readFile(file, 'utf8')).description, 'Adds topics.');
    await assert.rejects(registry.update('add-topics', { ...created, description: 'Stale.' }), /reload before saving/);
    // An edit made on disk is what the service reads and what a later save is checked against.
    await fs.writeFile(file, JSON.stringify({ ...saved, name: 'Renamed on disk' }));
    assert.equal(registry.getSync('add-topics').name, 'Renamed on disk');
    await assert.rejects(registry.update('add-topics', { ...updated, description: 'Stale.' }), { statusCode: 409 });

    let checked = null;
    assert.equal(await registry.remove('add-topics', { beforeRemove: id => { checked = id; } }), true);
    assert.equal(checked, 'add-topics');
    await assert.rejects(fs.access(file), { code: 'ENOENT' });
    assert.equal(await registry.get('add-topics'), null);
});

test('invalid workflow files and id conflicts are reported, never listed as workflows', async t => {
    const { registry, write } = await workspace(t);
    await registry.create(definition('Taken'));
    await write('Repo/flows/taken.json', definition('Taken file'));
    await write('Repo/flows/twice.json', definition('Twice'));
    await write('Other/flows/twice.json', definition('Twice again'));
    await write('Repo/flows/broken.json', '{ not json');
    await write('Repo/flows/mismatch.json', { ...definition('Mismatch'), id: 'other-id' });
    await write('Repo/flows/no-tasks.json', definition('No tasks', { tasks: [] }));
    await write('Repo/flows/Bad_Name.json', definition('Bad name'));
    await write('Repo/flows/default.json', definition('Default'));
    assert.deepEqual((await registry.list()).map(workflow => workflow.id), ['taken']);
    const errors = Object.fromEntries(registry.fileErrors.map(error => [error.path, error.message]));
    assert.match(errors['Repo/flows/taken.json'], /already used by an internal workflow/);
    assert.match(errors['Repo/flows/twice.json'], /more than one file/);
    assert.match(errors['Other/flows/twice.json'], /more than one file/);
    assert.match(errors['Repo/flows/broken.json'], /invalid JSON/);
    assert.match(errors['Repo/flows/mismatch.json'], /does not match the file name/);
    assert.match(errors['Repo/flows/no-tasks.json'], /entryTaskId must identify a task/);
    assert.match(errors['Repo/flows/Bad_Name.json'], /not a valid workflow id/);
    assert.match(errors['Repo/flows/default.json'], /reserved/);
    assert.equal(await registry.get('twice'), null);
});

test('Save as on an existing workflow stores an external copy with -copy beside the unchanged original', async t => {
    const { workflowCopy } = await import('../public/workflow-editor.js');
    const { root, registry } = await workspace(t);
    await fs.mkdir(path.join(root, 'Repo'));
    const original = await registry.create(definition('Add topics', { description: 'Original.' }));
    const draft = { ...original, description: 'Edited before Save as.', coverage: {}, diagnostics: [] };
    const copy = workflowCopy(draft);
    assert.equal(copy.id, 'add-topics-copy');
    assert.equal(copy.name, 'Add topics copy');
    for (const field of ['revision', 'createdAt', 'updatedAt', 'readOnly', 'coverage', 'diagnostics', 'source']) assert.equal(field in copy, false, field);
    const saved = await registry.create(copy, { location: 'Repo' });
    assert.deepEqual(saved.source, { kind: 'file', path: 'Repo/flows/add-topics-copy.json' });
    assert.equal(saved.description, 'Edited before Save as.');
    assert.equal((await registry.get('add-topics')).description, 'Original.');
    assert.deepEqual(registry.getSync('add-topics').source, { kind: 'internal' });
    // A second copy with the same id is refused instead of overwriting the first.
    await assert.rejects(registry.create(workflowCopy(draft), { location: 'Repo' }), { statusCode: 409 });
    // Long ids stay within the id limit; a new draft without an id keeps its own identity.
    assert.equal(workflowCopy({ ...original, id: 'a'.repeat(64) }).id, `${'a'.repeat(59)}-copy`);
    assert.equal(workflowCopy({ name: 'New', tasks: [] }).id, undefined);
});
