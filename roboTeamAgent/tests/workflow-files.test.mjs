import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { WorkflowRegistry } from '../server/roboflow/workflow-registry.mjs';
import { ScheduleFolders } from '../server/roboflow/schedule-folders.mjs';

const definition = (name, extra = {}) => ({ name, description: 'A test workflow.', entryTaskId: 'one', edges: [],
    tasks: [{ id: 'one', name: 'One', prompt: 'Do one.', executionType: 'terminal', skillsets: [] }], ...extra });

function deferred() {
    let resolve;
    const promise = new Promise(done => { resolve = done; });
    return { promise, resolve };
}

async function bounded(promise) {
    let timer;
    try {
        return await Promise.race([promise, new Promise((resolve, reject) => {
            timer = setTimeout(() => reject(new Error('workflow operation did not settle')), 3000);
        })]);
    } finally { clearTimeout(timer); }
}

// Hold only the first real filesystem operation. A serialized second caller cannot enter yet.
function holdFirst(t, object, method, { after = false } = {}) {
    const original = object[method].bind(object), entered = deferred(), release = deferred();
    let first = true;
    object[method] = async (...args) => {
        if (!first) return original(...args);
        first = false;
        const value = after ? await original(...args) : undefined;
        entered.resolve();
        await bounded(release.promise);
        return after ? value : original(...args);
    };
    t.after(() => { release.resolve(); object[method] = original; });
    return { entered: entered.promise, release: () => release.resolve() };
}

async function overlap(gate, first, second) {
    // Attach rejection handlers before allowing either request to complete.
    const results = Promise.allSettled([first, second]);
    try {
        // Give the competing request time to reach a scan/write on the unfixed registry.
        await new Promise(resolve => setTimeout(resolve, 30));
    } finally { gate.release(); }
    return bounded(results);
}

function uniqueWinner(results) {
    assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
    assert.equal(results.filter(result => result.status === 'rejected').length, 1);
    assert.equal(results.find(result => result.status === 'rejected').reason.statusCode, 409);
    return results.find(result => result.status === 'fulfilled').value;
}

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

test('overlapping file saves accept one revision and persist only that winner', async t => {
    const { root, registry } = await workspace(t);
    await fs.mkdir(path.join(root, 'Repo'));
    const created = await registry.create(definition('Save race'), { location: 'Repo' });
    const gate = holdFirst(t, registry.files, 'write');
    const first = registry.update(created.id, { ...created, description: 'First editor' });
    await bounded(gate.entered);
    const results = await overlap(gate, first, registry.update(created.id, { ...created, description: 'Second editor' }));
    const winner = uniqueWinner(results);
    assert.equal(winner.description, 'First editor');
    assert.equal(JSON.parse(await fs.readFile(path.join(root, winner.source.path), 'utf8')).description, winner.description);
    assert.equal((await registry.get(created.id)).revision, winner.revision);
    assert.equal((await registry.list())[0].description, winner.description);
});

test('overlapping creates in separate repositories retain one global workflow id', async t => {
    const { root, registry } = await workspace(t);
    await fs.mkdir(path.join(root, 'RepoA'));
    await fs.mkdir(path.join(root, 'RepoB'));
    const gate = holdFirst(t, registry.files, 'create');
    const first = registry.create(definition('Global race'), { location: 'RepoA' });
    await bounded(gate.entered);
    const winner = uniqueWinner(await overlap(gate, first, registry.create(definition('Global race'), { location: 'RepoB' })));
    assert.equal(winner.source.path, 'RepoA/flows/global-race.json');
    assert.equal(JSON.parse(await fs.readFile(path.join(root, winner.source.path), 'utf8')).name, winner.name);
    await assert.rejects(fs.access(path.join(root, 'RepoB/flows/global-race.json')), { code: 'ENOENT' });
    assert.deepEqual((await registry.list()).map(graph => graph.id), [winner.id]);
    assert.equal((await registry.get(winner.id)).revision, winner.revision);
    assert.deepEqual(registry.fileErrors, []);
});

for (const firstSource of ['file', 'internal']) test(`overlapping ${firstSource}-first creation excludes the other source after a delayed real operation`, async t => {
    const { root, registry } = await workspace(t);
    await fs.mkdir(path.join(root, 'Repo'));
    await registry.initialize();
    // Internal-first holds its real empty admission scan; file-first holds file publication.
    const gate = holdFirst(t, registry.files, firstSource === 'file' ? 'create' : 'scan', { after: firstSource === 'internal' });
    const input = definition('Mixed race');
    const create = source => registry.create({ ...input, description: source }, source === 'file' ? { location: 'Repo' } : {});
    const first = create(firstSource);
    await bounded(gate.entered);
    const winner = uniqueWinner(await overlap(gate, first, create(firstSource === 'file' ? 'internal' : 'file')));
    assert.equal(winner.description, firstSource);
    assert.equal(winner.source.kind, firstSource);
    const internalFile = path.join(registry.directory, 'mixed-race.json');
    if (firstSource === 'internal') assert.equal(JSON.parse(await fs.readFile(internalFile, 'utf8')).description, firstSource);
    else await assert.rejects(fs.access(internalFile), { code: 'ENOENT' });
    if (firstSource === 'file') assert.equal(JSON.parse(await fs.readFile(path.join(root, winner.source.path), 'utf8')).description, firstSource);
    else await assert.rejects(fs.access(path.join(root, 'Repo/flows/mixed-race.json')), { code: 'ENOENT' });
    assert.deepEqual((await registry.list()).map(graph => graph.id), [winner.id]);
    assert.equal((await registry.get(winner.id)).description, firstSource);
    assert.deepEqual(registry.fileErrors, []);
});

test('a delayed catalog refresh cannot clear a subsequent file creation', async t => {
    const { root, registry } = await workspace(t);
    await fs.mkdir(path.join(root, 'Repo'));
    await registry.initialize();
    const gate = holdFirst(t, registry.files, 'scan', { after: true });
    const refresh = registry.refresh();
    await bounded(gate.entered);
    const results = await overlap(gate, refresh, registry.create(definition('After refresh'), { location: 'Repo' }));
    assert.deepEqual(results.map(result => result.status), ['fulfilled', 'fulfilled']);
    const winner = results[1].value;
    assert.equal(registry.getSync(winner.id)?.revision, winner.revision);
    assert.equal((await registry.get(winner.id)).revision, winner.revision);
    assert.deepEqual((await registry.list()).map(graph => graph.id), [winner.id]);
    assert.deepEqual(registry.fileErrors, []);
});

test('scan, persistence and removal-guard rejections leave subsequent operations usable', async t => {
    const { root, registry } = await workspace(t);
    await fs.mkdir(path.join(root, 'Repo'));
    const scan = registry.files.scan.bind(registry.files);
    registry.files.scan = async () => { await scan(); throw new Error('injected scan failure'); };
    await assert.rejects(registry.get('missing'), /injected scan failure/);
    registry.files.scan = scan;
    const create = registry.files.create.bind(registry.files);
    registry.files.create = async () => { throw new Error('injected create failure'); };
    await assert.rejects(registry.create(definition('Recovery'), { location: 'Repo' }), /injected create failure/);
    registry.files.create = create;
    const created = await bounded(registry.create(definition('Recovery'), { location: 'Repo' }));
    const write = registry.files.write.bind(registry.files);
    registry.files.write = async () => { throw new Error('injected write failure'); };
    await assert.rejects(registry.update(created.id, { ...created, description: 'Failed write' }), /injected write failure/);
    registry.files.write = write;
    assert.equal((await registry.get(created.id)).revision, created.revision);
    const saved = await bounded(registry.update(created.id, { ...created, description: 'Recovered' }));
    await assert.rejects(registry.remove(created.id, { beforeRemove: () => { throw new Error('injected guard failure'); } }), /injected guard failure/);
    assert.equal((await bounded(registry.get(created.id))).revision, saved.revision);
    assert.equal((await bounded(registry.list()))[0].description, 'Recovered');
    assert.equal(JSON.parse(await fs.readFile(path.join(root, saved.source.path), 'utf8')).description, 'Recovered');
    const remove = registry.files.remove.bind(registry.files);
    registry.files.remove = async () => { throw new Error('injected remove failure'); };
    await assert.rejects(registry.remove(created.id), /injected remove failure/);
    assert.equal(registry.fileIndex.get(created.id).revision, saved.revision, 'failed persistence must retain the published entry');
    registry.files.remove = remove;
    assert.equal((await bounded(registry.get(created.id))).revision, saved.revision);
    assert.equal(await bounded(registry.remove(created.id)), true);
    assert.equal(await bounded(registry.remove(created.id)), false);
});

test('concurrent initialization preserves presets, missing results and revision checks', async t => {
    const { registry } = await workspace(t);
    await bounded(Promise.all([registry.initialize(), registry.initialize()]));
    for (const id of ['default', 'code-development']) registry.addPreset(definition(id, { id }));
    await registry.create(definition('Created', { id: 'created' }));
    assert.deepEqual((await registry.list()).map(graph => graph.id).sort(), ['code-development', 'created', 'default']);
    for (const id of ['default', 'code-development']) {
        assert.equal(registry.getSync(id).readOnly, true);
        assert.equal(registry.getSync(id).source, undefined);
        await assert.rejects(registry.create(definition(id, { id })), { statusCode: id === 'default' ? 400 : 409 });
        await assert.rejects(registry.update(id, {}), { statusCode: 409 });
        await assert.rejects(registry.remove(id), { statusCode: 409 });
    }
    assert.equal(await registry.get('missing'), null);
    assert.equal(await registry.update('missing', {}), null);
    assert.equal(await registry.remove('missing'), false);
    const saved = await registry.get('created');
    await assert.rejects(registry.update(saved.id, { ...saved, revision: undefined }), { statusCode: 409 });
    await assert.rejects(registry.update(saved.id, { ...saved, revision: 0 }), { statusCode: 409 });
    assert.equal((await registry.get(saved.id)).revision, saved.revision);
});
