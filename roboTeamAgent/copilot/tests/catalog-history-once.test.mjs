import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { buildTaskCompletions } from '../src/lib/tasks/workspaceTasks.mjs';
import * as slash from '../src/mcp/list-slash-commands.mjs';

const { buildSessionCompletions, buildTaskActionCompletions, loadAutocompleteCatalog } = slash;
// Present once the catalog snapshot exists; the per-action fallback reproduces the earlier entrypoint composition.
const buildTaskActionCompletionMap = slash.buildTaskActionCompletionMap
    || ((dir) => Object.fromEntries(['view', 'continue', 'pause', 'model', 'login'].map((action) => [action, buildTaskActionCompletions(dir, action)])));

const COUNT = 6;
const ACTIONS = ['view', 'continue', 'pause', 'model', 'login'];

function makeWorkspace(t) {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'achilles-catalog-once-')));
    const previous = process.env.PLOINKY_WORKSPACE_ROOT;
    process.env.PLOINKY_WORKSPACE_ROOT = root;
    t.after(() => {
        if (previous === undefined) delete process.env.PLOINKY_WORKSPACE_ROOT;
        else process.env.PLOINKY_WORKSPACE_ROOT = previous;
        fs.rmSync(root, { recursive: true, force: true });
    });
    const when = (index) => new Date(Date.UTC(2026, 9, 8, 0, index)).toISOString();
    for (let index = 0; index < COUNT; index += 1) {
        const id = `task_${index.toString(16).padStart(24, '0')}`;
        const taskDir = path.join(root, '.roboteam/tasks', id);
        fs.mkdirSync(taskDir, { recursive: true });
        fs.writeFileSync(path.join(taskDir, 'task.json'), JSON.stringify({ version: 1, id, targetAgent: 'fixture',
            remoteTaskId: `fixture-${index}`, status: index % 2 === 0 ? 'finished' : 'ongoing', createdAt: when(index),
            updatedAt: when(index), description: `Task ${index}`,
            continuation: { version: 1, targetAgent: 'fixture', toolName: 'continue_fixture', handle: 'synthetic_continuation_handle' } }));
        const sessionId = `${index.toString(16).padStart(8, '0')}-0000-4000-8000-000000000000`;
        const sessionDir = path.join(root, '.roboteam/sessions', sessionId);
        fs.mkdirSync(sessionDir, { recursive: true });
        fs.writeFileSync(path.join(sessionDir, 'config.json'), JSON.stringify({ version: 2, sessionId,
            createdAt: when(index), updatedAt: when(index), turns: [], cwd: root }));
    }
    return root;
}

function spyReads(t, root) {
    const counts = { task: new Map(), session: new Map() };
    const original = fs.readFileSync;
    fs.readFileSync = function (file, ...args) {
        const result = original.call(this, file, ...args);
        const name = String(file);
        if (name.startsWith(path.join(root, '.roboteam/tasks') + path.sep) && name.endsWith('task.json')) counts.task.set(name, (counts.task.get(name) || 0) + 1);
        if (name.startsWith(path.join(root, '.roboteam/sessions') + path.sep) && name.endsWith('config.json')) counts.session.set(name, (counts.session.get(name) || 0) + 1);
        return result;
    };
    t.after(() => { fs.readFileSync = original; });
    return counts;
}

const catalog = { getSkills: () => [] };
const engine = { async listModels() { return { models: [] }; } };
// Mirrors the tools/copilot-catalog.mjs request composition.
function request(root, extra = {}) {
    return loadAutocompleteCatalog({ dir: root, skillCatalog: catalog, engine, freshSession: true,
        sessionCompletions: buildSessionCompletions(root),
        taskCompletions: buildTaskActionCompletionMap(root), ...extra });
}

test('one catalog request reads each task file and session config once with unchanged output', async (t) => {
    const root = makeWorkspace(t);
    const expected = await toExpected(root);
    const counts = spyReads(t, root);
    const result = await request(root);
    assert.equal(counts.task.size, COUNT);
    assert.equal(counts.session.size, COUNT);
    assert.deepEqual([...counts.task.values()], Array(COUNT).fill(1));
    assert.deepEqual([...counts.session.values()], Array(COUNT).fill(1));
    assert.deepEqual(result, expected);
});

// Reference output built per action from independent reads, as the pre-change code did.
async function toExpected(root) {
    const taskCompletions = Object.fromEntries(ACTIONS.map((action) => [action, buildTaskCompletions(root, action)]));
    return loadAutocompleteCatalog({ dir: root, skillCatalog: catalog, engine, freshSession: true,
        sessionCompletions: buildSessionCompletions(root), taskCompletions });
}

test('caller-supplied completions are preserved and not recomputed', async (t) => {
    const root = makeWorkspace(t);
    const counts = spyReads(t, root);
    const supplied = Object.fromEntries(ACTIONS.map((action) => [action, [{ value: action, label: action }]]));
    const sessions = [{ value: 'supplied', label: 'supplied' }];
    const result = await loadAutocompleteCatalog({ dir: root, skillCatalog: catalog, engine, freshSession: true,
        sessionCompletions: sessions, taskCompletions: supplied });
    assert.equal(counts.task.size + counts.session.size, 0);
    const task = result.commands.find((c) => c.name === '/task').subCommands;
    for (const sub of task.filter((s) => ACTIONS.includes(s.name))) assert.deepEqual(sub.argCompletions, supplied[sub.name]);
    assert.deepEqual(result.commands.find((c) => c.name === '/session').subCommands.find((s) => s.name === 'resume').argCompletions, sessions);
});

test('direct loader fills only missing completions from a single history read', async (t) => {
    const root = makeWorkspace(t);
    const counts = spyReads(t, root);
    const view = [{ value: 'keep', label: 'keep' }];
    const result = await loadAutocompleteCatalog({ dir: root, skillCatalog: catalog, engine, freshSession: true, taskCompletions: { view } });
    assert.deepEqual([...counts.task.values()], Array(COUNT).fill(1));
    assert.deepEqual([...counts.session.values()], Array(COUNT).fill(1));
    const sub = (name) => result.commands.find((c) => c.name === '/task').subCommands.find((s) => s.name === name).argCompletions;
    assert.deepEqual(sub('view'), view);
    assert.deepEqual(sub('pause'), buildTaskCompletions(root, 'pause'));
});

test('direct loader with a malformed saved current session id still returns a catalog with modelError', async (t) => {
    const root = makeWorkspace(t);
    fs.mkdirSync(path.join(root, '.roboteam'), { recursive: true });
    fs.writeFileSync(path.join(root, '.roboteam/settings.json'), JSON.stringify({ currentSessionId: 'not-a-session-id' }));
    const result = await loadAutocompleteCatalog({ dir: root, skillCatalog: catalog, engine });
    assert.equal(result.type, 'achilles-slash-command-catalog');
    assert.equal(result.modelError, 'invalid_session_id');
    const resume = result.commands.find((c) => c.name === '/session').subCommands.find((s) => s.name === 'resume');
    assert.equal(resume.argCompletions.length, COUNT);
});
