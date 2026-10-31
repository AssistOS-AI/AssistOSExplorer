import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { setDisabledSkills } from '../src/lib/config/achillesSettings.mjs';
import { ConversationSessionStore } from '../src/lib/storage/conversationSessionStore.mjs';
import { createCatalogFixture, writeSkill } from './helpers/anthropicCatalogFixture.mjs';
import { buildAchillesSkillCatalog, toAutocompleteCatalog, buildSessionCompletions } from '../src/mcp/list-slash-commands.mjs';
import { loadAutocompleteCatalog } from '../src/mcp/list-slash-commands.mjs';

test('model completions use the explicit conversation and surface native discovery failures', async (t) => {
    const { workingDir } = await createCatalogFixture(t);
    const store = new ConversationSessionStore({ workingDir });
    const first = await store.createSession();
    const second = await store.createSession();
    const calls = [];
    const catalog = { getSkills: () => [] };
    const engine = { async listModels({ sessionId }) {
        calls.push(sessionId);
        return { backend: 'pi', models: [
            { id: 'native-model', efforts: ['low', 'high'] },
            { id: 'provider/other-model', efforts: ['medium'] },
            'legacy-model',
            { name: 'no-effort-model', efforts: [] },
        ] };
    } };
    const result = await loadAutocompleteCatalog({ dir: workingDir, sessionId: first.sessionId,
        skillCatalog: catalog, engine });
    assert.deepEqual(calls, [first.sessionId]);
    const modelCommand = result.commands.find((c) => c.name === '/model');
    assert.deepEqual(modelCommand.argCompletions, []);
    assert.deepEqual(modelCommand.subCommands.map((m) => m.name),
        ['default', 'native-model', 'provider/other-model', 'legacy-model', 'no-effort-model']);
    assert.deepEqual(modelCommand.subCommands.map((m) => m.argCompletions.map((arg) => arg.value)),
        [[], ['default', 'low', 'high'], ['default', 'medium'], [], []]);
    const preview = await loadAutocompleteCatalog({ dir: workingDir, freshSession: true, skillCatalog: catalog, engine });
    assert.notEqual(calls[1], second.sessionId);
    assert.equal(store.listSessions().sessions.length, 2);
    assert.equal(preview.modelError, undefined);
    const failed = await loadAutocompleteCatalog({ dir: workingDir, sessionId: first.sessionId,
        skillCatalog: catalog, engine: { async listModels() { throw new Error('Native discovery failed'); } } });
    assert.equal(failed.modelError, 'Native discovery failed');
});

const builtins = ['bash', 'launch-gpt-researcher', 'launch-workflow', 'list-workflows',
    'report-task-blocked', 'require-human-input', 'workflow-creator'];

test('MCP automatically discovers exactly the packaged catalog without authoring directories', async (t) => {
    const { workingDir } = await createCatalogFixture(t);
    const authoring = writeSkill(path.join(workingDir, '.agents', 'skills'), 'authoring', 'authoring');
    const { skills } = await buildAchillesSkillCatalog(workingDir);
    assert.deepEqual(skills.map((skill) => skill.name), builtins);
    assert.ok(skills.every((skill) => skill.type === 'anthropic' && skill.isInternal));
    assert.ok(fs.existsSync(path.join(authoring, 'SKILL.md')));
});

test('MCP respects external overrides, descriptor descriptions and persisted disablement', async (t) => {
    const { workingDir } = await createCatalogFixture(t);
    const root = path.join(workingDir, 'skills');
    writeSkill(root, 'custom-bash', 'bash', 'Use custom Bash rules.');
    writeSkill(root, 'research', 'research', 'Research the workspace.');
    await setDisabledSkills(workingDir, ['bash']);
    const publicCatalog = await buildAchillesSkillCatalog(workingDir, { skillRoots: [root] });
    assert.deepEqual(publicCatalog.skills.filter((skill) => skill.name === 'bash'), [{
        key: 'bash', name: 'bash', type: 'anthropic', isInternal: false, enabled: false,
    }]);
    const catalog = await toAutocompleteCatalog({ dir: workingDir, skillRoots: [root] });
    const exec = catalog.commands.find((command) => command.name === '/exec');
    assert.equal(exec.argCompletions.some((entry) => entry.value === 'bash'), false);
    assert.equal(exec.argCompletions.find((entry) => entry.value === 'research').description, 'Research the workspace.');
    const list = catalog.commands.find((command) => command.name === '/list');
    assert.deepEqual(list.subCommands.map((sub) => sub.name), ['robots']);
    for (const name of ['/raw', '/read', '/reload', '/remove', '/skill', '/skills', '/update', '/add']) {
        assert.equal(catalog.commands.some((command) => command.name === name), false);
    }
    assert.equal(catalog.commands.some((command) => ['/tier', '/build', '/write', '/test'].includes(command.name)), false);
});

test('malformed and duplicate descriptors fail public catalog discovery explicitly', async (t) => {
    const { workingDir } = await createCatalogFixture(t);
    const root = path.join(workingDir, 'skills');
    writeSkill(root, 'one', 'duplicate');
    writeSkill(root, 'two', 'duplicate');
    await assert.rejects(buildAchillesSkillCatalog(workingDir, { skillRoots: [root] }), /Duplicate skill name/);
    fs.rmSync(path.join(root, 'two'), { recursive: true });
    writeSkill(root, 'bad', 'bad', '');
    await assert.rejects(buildAchillesSkillCatalog(workingDir, { skillRoots: [root] }), /descriptor must define/);
});

test('session completions expose shared sessions without changing the startup selection', async (t) => {
    const { workingDir } = await createCatalogFixture(t);
    const store = new ConversationSessionStore({ workingDir });
    const first = await store.createSession();
    const second = await store.createSession();
    const completions = buildSessionCompletions(workingDir);
    assert.deepEqual(new Set(completions.map((entry) => entry.value)), new Set([first.sessionId, second.sessionId]));
    assert.equal((await store.ensureCurrentSession()).sessionId, second.sessionId);
});

test('T5 fresh worker catalog reads native model utilities without creating a conversation or loading local ALA', async (t) => {
    const { workingDir } = await createCatalogFixture(t);
    const before = process.env.ROBOTEAM_WORKER_COORDINATOR_BASE;
    process.env.ROBOTEAM_WORKER_COORDINATOR_BASE = '/worker';
    t.after(() => { if (before === undefined) delete process.env.ROBOTEAM_WORKER_COORDINATOR_BASE; else process.env.ROBOTEAM_WORKER_COORDINATOR_BASE = before; });
    const calls = [];
    const result = await loadAutocompleteCatalog({ dir: workingDir, freshSession: true, skillCatalog: { getSkills: () => [] },
        robotId: 'local', robotStore: { get: async () => ({ id: 'local', codingAgents: ['codex'], worker: { robotId: 'worker-id' } }) },
        workerHop: { call: async (operation, body) => {
            calls.push([operation, body]);
            return { outcome: 'response', status: 200, json: operation === 'robots/get' ? { configuration: { backend: 'codex' } }
                : { agent: 'codex', models: [{ id: 'model-a', efforts: ['high'] }] } };
        } },
    });
    assert.equal(result.modelError, undefined);
    assert.deepEqual(calls, [['robots/get', { robotId: 'worker-id' }], ['robots/models', { robotId: 'worker-id', agent: 'codex' }]]);
    assert.deepEqual(result.commands.find((command) => command.name === '/model').subCommands.map((entry) => entry.name), ['default', 'model-a']);
    assert.equal(new ConversationSessionStore({ workingDir }).listSessions().sessions.length, 0);
});
