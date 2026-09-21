import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeRequest, action } from '../src/skills/roboflow/scripts/action.mjs';

test('parses JSON and command forms of a RoboFlow request', () => {
    assert.deepEqual(normalizeRequest('{"action":"list-workflows"}'), { action: 'list-workflows' });
    assert.deepEqual(normalizeRequest('create-flow software-change :: Add OAuth'), {
        action: 'create-flow', workflowTypeId: 'software-change', objective: 'Add OAuth',
    });
    const invoke = normalizeRequest('invoke flow_0123456789abcdef01234567 impl Implement the feature');
    assert.equal(invoke.action, 'invoke');
    assert.equal(invoke.member, 'impl');
    assert.equal(invoke.instruction, 'Implement the feature');
    assert.deepEqual(normalizeRequest('stop flow_0123456789abcdef01234567'), { action: 'stop', flowId: 'flow_0123456789abcdef01234567' });
    assert.throws(() => normalizeRequest('unknown'), /unsupported RoboFlow action/);
});

test('action reports a failed request without throwing', async () => {
    const result = await action({ promptText: 'unknown' });
    assert.match(result, /Could not run the RoboFlow action/);
});
