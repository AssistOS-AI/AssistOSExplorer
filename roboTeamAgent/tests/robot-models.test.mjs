import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { RobotStore } from '../server/robot-store.mjs';
import { RobotModels } from '../server/robot-models.mjs';
import { configuredModelCatalog, filterCodingModels } from '../public/skills-dialog.js';

test('model search matches all words across model IDs and labels regardless of case or order', () => {
    const models = [{ id: 'soul-gateway/deepseek-v4-flash', label: 'DeepSeek Flash' }, { id: 'opencode/big-pickle', label: 'Big Pickle' }];
    assert.deepEqual(filterCodingModels(models, ' FLASH   soul '), [models[0]]);
    assert.deepEqual(filterCodingModels(models, 'pickle BIG'), [models[1]]);
    assert.deepEqual(filterCodingModels(models, 'flash pickle'), []);
    assert.deepEqual(filterCodingModels(models, ''), models);
});

// Decision M-56: RoboTeam runs no ALA, so listing and effort validation are unavailable until the worker utility executions (T5);
// the saved selection is read from RoboTeam's own record. An ALA loader is not even part of the service any more, so a stand-in
// installed on the runtime that throws when touched proves nothing is loaded.
async function service(t) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'robot-models-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const store = new RobotStore({ dataDir: path.join(root, '.data') });
    await store.initialize();
    const touched = [];
    const trap = name => () => { touched.push(name); throw new Error(`${name} must not be called`); };
    const runtime = { workspaceRoot: root, get alaCommand() { return trap('alaCommand')(); },
        toolCache: { prepareCodingAgents: trap('prepareCodingAgents') }, prepareOpenCode: trap('prepareOpenCode') };
    return { store, touched, models: new RobotModels({ robotStore: store, runtimeManager: runtime, installation: trap('installation') }) };
}

test('a listing is refused with the plain 409 and loads neither ALA nor a coding-agent CLI', async t => {
    const { store, touched, models } = await service(t);
    const robot = await store.create({ name: 'Catalog' });
    await assert.rejects(models.list(robot, 'opencode'), error => error.statusCode === 409 && error.publicCode === 'model_listing_unavailable'
        && error.message === 'Model listing is available after the worker model-listing update.');
    await assert.rejects(models.list(robot, '../unknown'), /Unknown coding agent/);
    assert.deepEqual(touched, []);
});

test('effort validation checks the format, then refuses with the same 409 because it needs a listing', async t => {
    const { store, touched, models } = await service(t);
    const robot = await store.create({ name: 'Efforts' });
    await assert.rejects(models.validateEffort(robot, 'opencode', 'provider/model', 'bad effort'), error => error.statusCode === 400);
    await assert.rejects(models.validateEffort(robot, 'opencode', 'provider/model', 'high'), error => error.statusCode === 409 && error.publicCode === 'model_listing_unavailable');
    assert.deepEqual(touched, []);
});

test('an effort is checked against the static levels of Claude Code and Pi, and the saved effort of any agent needs no list', async t => {
    const { store, touched, models } = await service(t);
    const robot = await store.create({ name: 'Static', codingAgents: ['claude'] });
    await models.validateEffort(robot, 'claude', 'sonnet', 'xhigh');
    await models.validateEffort(robot, 'pi', 'provider/model', 'minimal');
    await assert.rejects(models.validateEffort(robot, 'claude', 'sonnet', 'minimal'), error => error.statusCode === 400);
    await assert.rejects(models.validateEffort(robot, 'pi', 'provider/model', 'turbo'), error => error.statusCode === 400);
    const saved = await store.setCodingAgents(robot.id, ['opencode'], { model: 'provider/saved', effort: 'high' });
    await models.validateEffort(saved, 'opencode', 'provider/saved', 'high');
    await assert.rejects(models.validateEffort(saved, 'opencode', 'provider/other', 'high'), error => error.statusCode === 409);
    await assert.rejects(models.validateEffort(saved, 'opencode', 'provider/saved', 'low'), error => error.statusCode === 409);
    await assert.rejects(models.validateEffort(saved, 'codex', 'provider/saved', 'high'), error => error.statusCode === 409);
    assert.deepEqual(touched, []);
});

test('the saved selection comes from the robot record, not from ALA or the old home', async t => {
    const { store, touched, models } = await service(t);
    const robot = await store.create({ name: 'Saved', codingAgents: ['opencode'] });
    assert.deepEqual(await models.config(robot), { codingAgent: 'opencode', models: {}, efforts: {}, defaultModels: { opencode: 'opencode/glm-5.3-flash-free' } });
    await store.setCodingAgents(robot.id, ['opencode'], { model: 'provider/saved', effort: 'high' });
    const config = await models.config(robot);
    assert.deepEqual([config.codingAgent, config.models, config.efforts], ['opencode', { opencode: 'provider/saved' }, { opencode: 'high' }]);
    assert.deepEqual(touched, []);
});

test('the picker degrades to the configured model only', () => {
    assert.deepEqual(configuredModelCatalog('provider/saved'), [{ id: 'provider/saved', label: 'provider/saved', efforts: [] }]);
    assert.deepEqual(configuredModelCatalog(undefined), []);
    assert.deepEqual(configuredModelCatalog(''), []);
});

test('neither module imports the ALA installation loader or the native environment', async () => {
    for (const file of ['../server/robot-models.mjs', '../server/coding-agent-status.mjs']) {
        const source = await fs.readFile(new URL(file, import.meta.url), 'utf8');
        assert.doesNotMatch(source, /alaInstallation|alaEnvironment|resolveAlaInstallation|detectCodingAgentLogin|discoverCodingAgents/u, file);
    }
});
