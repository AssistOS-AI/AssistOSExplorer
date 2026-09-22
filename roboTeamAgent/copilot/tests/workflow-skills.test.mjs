import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeRequest as normalizeLaunch, action as launchWorkflow } from '../src/skills/launch-workflow/scripts/action.mjs';

test('launch-workflow parses JSON and command forms', () => {
    assert.deepEqual(normalizeLaunch('{"action":"list-workflows"}'), { action: 'list-workflows' });
    assert.deepEqual(normalizeLaunch('start software-change :: Add OAuth'), {
        action: 'start', workflowTypeId: 'software-change', objective: 'Add OAuth',
    });
    assert.deepEqual(normalizeLaunch('{"action":"start","workflowTypeId":"default","objective":"Do it"}'), {
        action: 'start', workflowTypeId: 'default', objective: 'Do it',
    });
    assert.throws(() => normalizeLaunch('invoke x y'), /unsupported workflow action/);
});

test('launch-workflow reports a failed request without throwing', async () => {
    assert.match(await launchWorkflow({ promptText: 'unknown' }), /Could not run the workflow action/);
});
