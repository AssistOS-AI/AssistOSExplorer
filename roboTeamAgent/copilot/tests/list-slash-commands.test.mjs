import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { setDisabledSkills } from '../src/lib/achillesSettings.mjs';
import { ConversationSessionStore } from '../src/lib/conversationSessionStore.mjs';
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
        return { backend: 'pi', models: ['native-model'] };
    } };
    const result = await loadAutocompleteCatalog({ dir: workingDir, sessionId: first.sessionId,
        skillCatalog: catalog, engine });
    assert.deepEqual(calls, [first.sessionId]);
    assert.deepEqual(result.commands.find((c) => c.name === '/model').argCompletions.map((m) => m.value), ['default', 'native-model']);
    const preview = await loadAutocompleteCatalog({ dir: workingDir, freshSession: true, skillCatalog: catalog, engine });
    assert.notEqual(calls[1], second.sessionId);
    assert.equal(store.listSessions().sessions.length, 2);
    assert.equal(preview.modelError, undefined);
    const failed = await loadAutocompleteCatalog({ dir: workingDir, sessionId: first.sessionId,
        skillCatalog: catalog, engine: { async listModels() { throw new Error('Native discovery failed'); } } });
    assert.equal(failed.modelError, 'Native discovery failed');
});

const builtins = ['bash', 'launch-gpt-researcher', 'launch-robot'];

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
    const publicCatalog = await buildAchillesSkillCatalog(workingDir);
    assert.deepEqual(publicCatalog.skills.filter((skill) => skill.name === 'bash'), [{
        key: 'bash', name: 'bash', type: 'anthropic', isInternal: false, enabled: false,
    }]);
    const catalog = await toAutocompleteCatalog({ dir: workingDir });
    const exec = catalog.commands.find((command) => command.name === '/exec');
    assert.equal(exec.argCompletions.some((entry) => entry.value === 'bash'), false);
    assert.equal(exec.argCompletions.find((entry) => entry.value === 'research').description, 'Research the workspace.');
    const enable = catalog.commands.find((command) => command.name === '/skill').subCommands.find((sub) => sub.name === 'enable');
    assert.equal(enable.argCompletions.find((entry) => entry.value === 'bash').description, 'Use custom Bash rules.');
    assert.equal(catalog.commands.some((command) => ['/tier', '/build', '/write', '/test'].includes(command.name)), false);
});

test('malformed and duplicate descriptors fail public catalog discovery explicitly', async (t) => {
    const { workingDir } = await createCatalogFixture(t);
    const root = path.join(workingDir, 'skills');
    writeSkill(root, 'one', 'duplicate');
    writeSkill(root, 'two', 'duplicate');
    await assert.rejects(buildAchillesSkillCatalog(workingDir), /Duplicate task-skill name/);
    fs.rmSync(path.join(root, 'two'), { recursive: true });
    writeSkill(root, 'bad', 'bad', '');
    await assert.rejects(buildAchillesSkillCatalog(workingDir), /descriptor must define/);
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
