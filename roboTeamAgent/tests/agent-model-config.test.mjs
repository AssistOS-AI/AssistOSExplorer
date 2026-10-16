import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ensureAgentConfig, DEFAULT_OPENCODE_MODEL } from '../server/agent-model-config.mjs';
import { prepareRobotShell } from '../server/robot-shell.mjs';
import { RobotStore } from '../server/robot-store.mjs';

async function home(t) {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-model-'));
    t.after(() => fs.rm(directory, { recursive: true, force: true }));
    return directory;
}

const configFile = (directory) => path.join(directory, '.ala', 'config.json');
const readConfig = (directory) => fs.readFile(configFile(directory), 'utf8').then(JSON.parse);

test('a new OpenCode robot gets OpenCode as its agent and the default OpenCode model', async (t) => {
    const directory = await home(t);
    const created = await ensureAgentConfig(directory, { codingAgents: ['opencode'] });
    assert.deepEqual(created, { codingAgent: 'opencode', models: { opencode: DEFAULT_OPENCODE_MODEL }, efforts: {} });
    assert.deepEqual(await readConfig(directory), created);
    // A second call is idempotent and does not rewrite the file.
    assert.equal(await ensureAgentConfig(directory, { codingAgents: ['opencode'] }), null);
});

test('saved models and efforts are kept; an explicit agent replaces the saved one', async (t) => {
    const directory = await home(t);
    await fs.mkdir(path.join(directory, '.ala'));
    await fs.writeFile(configFile(directory), JSON.stringify({
        codingAgent: 'opencode', models: { opencode: 'soul-gateway/chosen', codex: 'gpt-5.5' }, efforts: { codex: 'high' },
    }));
    assert.equal(await ensureAgentConfig(directory, { codingAgents: ['opencode'] }), null);
    await ensureAgentConfig(directory, { codingAgents: ['codex'], codingAgent: 'codex' });
    assert.deepEqual(await readConfig(directory), {
        codingAgent: 'codex', models: { opencode: 'soul-gateway/chosen', codex: 'gpt-5.5' }, efforts: { codex: 'high' },
    });
});

test('a config ALA would reject is left untouched', async (t) => {
    const directory = await home(t);
    await fs.mkdir(path.join(directory, '.ala'));
    await fs.writeFile(configFile(directory), '{ not json');
    assert.equal(await ensureAgentConfig(directory, { codingAgents: ['opencode'] }), null);
    assert.equal(await fs.readFile(configFile(directory), 'utf8'), '{ not json');
    const old = JSON.stringify({ version: 1, codingAgents: { models: {} } });
    await fs.writeFile(configFile(directory), old);
    assert.equal(await ensureAgentConfig(directory, { codingAgents: ['opencode'] }), null);
    assert.equal(await fs.readFile(configFile(directory), 'utf8'), old);
});

test('robot shell preparation records the robot agent; only OpenCode robots get a default model', async (t) => {
    const opencodeHome = await home(t);
    await prepareRobotShell(opencodeHome);
    assert.deepEqual(await readConfig(opencodeHome), { codingAgent: 'opencode', models: { opencode: DEFAULT_OPENCODE_MODEL }, efforts: {} });
    const codexHome = await home(t);
    await prepareRobotShell(codexHome, { codingAgents: ['codex'] });
    assert.deepEqual(await readConfig(codexHome), { codingAgent: 'codex', models: {}, efforts: {} });
});

test('creating a robot and changing its coding agent update its ALA config', async (t) => {
    const dataDir = await home(t);
    const store = new RobotStore({ dataDir });
    await store.initialize();
    const robot = await store.create({ name: 'Config Robot' });
    const robotHome = path.join(store.robotPath(robot.id), 'home');
    assert.equal((await readConfig(robotHome)).codingAgent, 'opencode');
    await store.setCodingAgents(robot.id, ['codex']);
    assert.deepEqual(await readConfig(robotHome), { codingAgent: 'codex', models: { opencode: DEFAULT_OPENCODE_MODEL }, efforts: {} });
});

test('model selections preserve other agents and clear effort only when changing the model', async t => {
    const dataDir = await home(t), store = new RobotStore({ dataDir });
    await store.initialize();
    const robot = await store.create({ name: 'Model settings' });
    const robotHome = path.join(store.robotPath(robot.id), 'home');
    await fs.writeFile(configFile(robotHome), JSON.stringify({ codingAgent: 'opencode',
        models: { opencode: 'provider/old', codex: 'saved-model' }, efforts: { opencode: 'high', codex: 'low' } }));
    await store.setCodingAgents(robot.id, ['opencode'], { model: 'provider/old' });
    assert.equal((await readConfig(robotHome)).efforts.opencode, 'high');
    await store.setCodingAgents(robot.id, ['opencode'], { model: 'provider/new' });
    assert.deepEqual(await readConfig(robotHome), { codingAgent: 'opencode',
        models: { opencode: 'provider/new', codex: 'saved-model' }, efforts: { codex: 'low' } });
    await store.setCodingAgents(robot.id, ['opencode'], { model: null });
    assert.equal((await readConfig(robotHome)).models.opencode, DEFAULT_OPENCODE_MODEL);
    await store.setCodingAgents(robot.id, ['codex'], { model: null });
    assert.deepEqual(await readConfig(robotHome), { codingAgent: 'codex', models: { opencode: DEFAULT_OPENCODE_MODEL }, efforts: {} });
    const before = await readConfig(robotHome);
    for (const model of ['', 1, {}, 'x\ny']) await assert.rejects(store.setCodingAgents(robot.id, ['pi'], { model }), /model must/);
    await assert.rejects(store.setCodingAgents(robot.id, ['pi', 'codex'], { model: 'some-model' }), /model must/);
    assert.deepEqual(await readConfig(robotHome), before);
    assert.deepEqual((await store.get(robot.id)).codingAgents, ['codex']);
});


test('robot default model and effort are saved together and default effort clears only that backend', async t => {
    const directory = await home(t);
    await ensureAgentConfig(directory, { codingAgents: ['opencode'], model: 'provider/model', effort: 'high' });
    assert.equal((await readConfig(directory)).efforts.opencode, 'high');
    await ensureAgentConfig(directory, { codingAgents: ['codex'], codingAgent: 'codex', model: 'codex/model', effort: 'low' });
    await ensureAgentConfig(directory, { codingAgents: ['opencode'], codingAgent: 'opencode', model: 'provider/model', effort: null });
    assert.deepEqual((await readConfig(directory)).efforts, { codex: 'low' });
    const original = await fs.readFile(configFile(directory), 'utf8');
    for (const effort of [123, '', {}, 'wrong effort']) await assert.rejects(ensureAgentConfig(directory, { codingAgents: ['opencode'], model: 'provider/model', effort }), /effort/);
    await assert.rejects(ensureAgentConfig(directory, { codingAgents: ['codex'], model: null, effort: 'high' }), /explicit model/);
    assert.equal(await fs.readFile(configFile(directory), 'utf8'), original);
});
