import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ensureDefaultAgentModel, DEFAULT_OPENCODE_MODEL } from '../server/agent-model-config.mjs';
import { prepareRobotShell } from '../server/robot-shell.mjs';

async function home(t) {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-model-'));
    t.after(() => fs.rm(directory, { recursive: true, force: true }));
    return directory;
}

const readConfig = (directory) => fs.readFile(path.join(directory, '.ala', 'config.json'), 'utf8').then(JSON.parse);

test('default OpenCode model is recorded for ALA without overwriting an existing choice', async (t) => {
    const directory = await home(t);

    const created = await ensureDefaultAgentModel(directory);
    assert.equal(created.codingAgents.models.opencode, DEFAULT_OPENCODE_MODEL);
    assert.deepEqual(await readConfig(directory), {
        version: 1,
        codingAgents: { models: { opencode: DEFAULT_OPENCODE_MODEL } },
    });

    // A second call is idempotent and does not rewrite the value.
    assert.equal(await ensureDefaultAgentModel(directory), null);

    // A user-selected model is preserved, including other config sections.
    await fs.writeFile(path.join(directory, '.ala', 'config.json'), JSON.stringify({
        version: 1,
        codingAgents: { priority: ['opencode', 'codex', 'pi'], models: { opencode: 'soul-gateway/chosen' }, efforts: { opencode: 'high' }, websearch: true },
    }));
    assert.equal(await ensureDefaultAgentModel(directory), null);
    const preserved = await readConfig(directory);
    assert.equal(preserved.codingAgents.models.opencode, 'soul-gateway/chosen');
    assert.deepEqual(preserved.codingAgents.priority, ['opencode', 'codex', 'pi']);
    assert.equal(preserved.codingAgents.websearch, true);
});

test('default OpenCode model adds a missing backend while keeping existing ones', async (t) => {
    const directory = await home(t);
    await fs.mkdir(path.join(directory, '.ala'), { recursive: true });
    await fs.writeFile(path.join(directory, '.ala', 'config.json'), JSON.stringify({
        version: 1, codingAgents: { models: { codex: 'gpt-5.1-codex' } },
    }));
    await ensureDefaultAgentModel(directory);
    const config = await readConfig(directory);
    assert.equal(config.codingAgents.models.codex, 'gpt-5.1-codex');
    assert.equal(config.codingAgents.models.opencode, DEFAULT_OPENCODE_MODEL);
});

test('unreadable or foreign ALA config is left untouched', async (t) => {    const directory = await home(t);
    await fs.mkdir(path.join(directory, '.ala'), { recursive: true });
    await fs.writeFile(path.join(directory, '.ala', 'config.json'), '{ not json');
    assert.equal(await ensureDefaultAgentModel(directory), null);
    assert.equal(await fs.readFile(path.join(directory, '.ala', 'config.json'), 'utf8'), '{ not json');

    await fs.writeFile(path.join(directory, '.ala', 'config.json'), JSON.stringify({ version: 9, codingAgents: {} }));
    assert.equal(await ensureDefaultAgentModel(directory), null);
    assert.equal((await readConfig(directory)).version, 9);
});

test('robot shell preparation records the OpenCode default model for OpenCode robots only', async (t) => {
    const opencodeHome = await home(t);
    await prepareRobotShell(opencodeHome);
    assert.equal((await readConfig(opencodeHome)).codingAgents.models.opencode, DEFAULT_OPENCODE_MODEL);

    const codexHome = await home(t);
    await prepareRobotShell(codexHome, { codingAgents: ['codex'] });
    await assert.rejects(fs.access(path.join(codexHome, '.ala', 'config.json')), { code: 'ENOENT' });
});
