import test from 'node:test';
import assert from 'node:assert/strict';
import { RobotModels } from '../server/robot-models.mjs';
import { filterCodingModels } from '../public/skills-dialog.js';

test('model search matches all words across model IDs and labels regardless of case or order', () => {
    const models = [{ id: 'soul-gateway/deepseek-v4-flash', label: 'DeepSeek Flash' }, { id: 'opencode/big-pickle', label: 'Big Pickle' }];
    assert.deepEqual(filterCodingModels(models, ' FLASH   soul '), [models[0]]);
    assert.deepEqual(filterCodingModels(models, 'pickle BIG'), [models[1]]);
    assert.deepEqual(filterCodingModels(models, 'flash pickle'), []);
    assert.deepEqual(filterCodingModels(models, ''), models);
});

test('the model catalog is read from RoboWork for the robot without opening a session', async () => {
    const calls = [];
    const robot = { id: 'catalog-abc123' };
    const roboWork = { call: async (method, input, options) => {
        calls.push([method, input, options]);
        if (method === 'robot_config') return { codingAgent: 'opencode', defaultModels: { opencode: 'provider/model' } };
        return { agent: input.agent, models: [{ id: 'provider/model', efforts: ['high', 'low'] }] };
    } };
    const service = new RobotModels({ robotStore: {}, runtimeManager: { roboWork } });
    assert.equal((await service.config(robot)).codingAgent, 'opencode');
    assert.deepEqual(calls, [['robot_config', { robotId: robot.id }, undefined]]);
    assert.deepEqual(await service.list(robot, 'opencode'), { agent: 'opencode', models: [{ id: 'provider/model', efforts: ['high', 'low'] }] });
    assert.deepEqual(calls[1], ['robot_models', { robotId: robot.id, agent: 'opencode' }, { timeoutMs: 90000 }]);
    const before = calls.length;
    await assert.rejects(service.list(robot, '../unknown'), /Unknown coding agent/);
    const abort = new AbortController(); abort.abort();
    await assert.rejects(service.list(robot, 'opencode', { signal: abort.signal }), /abort/i);
    assert.equal(calls.length, before, 'an unknown agent or an aborted request must not reach RoboWork');
    const listedBefore = calls.filter(([method]) => method === 'robot_models').length;
    await service.validateEffort(robot, 'opencode', 'provider/model', 'high');
    await assert.rejects(service.validateEffort(robot, 'opencode', 'provider/model', 'unsupported'), /does not advertise/);
    await assert.rejects(service.validateEffort(robot, 'opencode', 'provider/other', 'high'), /does not advertise/);
    // No reuse by age: each validation reads the model list again.
    assert.equal(calls.filter(([method]) => method === 'robot_models').length - listedBefore, 3);
});

test('effort validation follows the current upstream model list with no waiting period', async () => {
    const robot = { id: 'fresh-abc123' };
    let upstream = [{ id: 'provider/old', efforts: ['low'] }];
    const roboWork = { call: async (method, input) => method === 'robot_config'
        ? { codingAgent: 'opencode', defaultModels: {} } : { agent: input.agent, models: upstream } };
    const service = new RobotModels({ robotStore: {}, runtimeManager: { roboWork } });
    // Fill any catalog the service might keep.
    await service.list(robot, 'opencode');
    await service.validateEffort(robot, 'opencode', 'provider/old', 'low');
    // A model and an effort added upstream are accepted immediately.
    upstream = [{ id: 'provider/old', efforts: ['low', 'max'] }, { id: 'provider/new', efforts: ['high'] }];
    await service.validateEffort(robot, 'opencode', 'provider/new', 'high');
    await service.validateEffort(robot, 'opencode', 'provider/old', 'max');
    // A model and an effort removed upstream are rejected immediately.
    upstream = [{ id: 'provider/old', efforts: ['low'] }];
    await assert.rejects(service.validateEffort(robot, 'opencode', 'provider/new', 'high'), /does not advertise/);
    await assert.rejects(service.validateEffort(robot, 'opencode', 'provider/old', 'max'), /does not advertise/);
});
