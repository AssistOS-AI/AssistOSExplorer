import assert from 'node:assert/strict';
import test from 'node:test';

import { WORKSPACE_COPILOT_PROMPT } from '../copilot/src/lib/prompts.mjs';

test('the workspace copilot answers plain requests directly and uses workflows only for work that needs one', () => {
    const answerAt = WORKSPACE_COPILOT_PROMPT.indexOf('Answer plain questions and direct instructions');
    const workflowAt = WORKSPACE_COPILOT_PROMPT.indexOf('use list-workflows');
    assert.ok(answerAt >= 0, 'direct answering is stated');
    assert.ok(workflowAt > answerAt, 'workflow use comes after the direct-answer rule');
    assert.match(WORKSPACE_COPILOT_PROMPT, /do not list or launch workflows for them/u);
    assert.match(WORKSPACE_COPILOT_PROMPT, /Only when the user asks for work that needs a workflow/u);
    assert.match(WORKSPACE_COPILOT_PROMPT, /Never invent workflow IDs/u);
});
