import assert from 'node:assert/strict';
import test from 'node:test';

import { formatWebchatError } from '../src/lib/webchatError.mjs';

test('WebChat errors link AchillesAgentLib stack frames to the workspace source copy', () => {
    const error = new Error('The LLM planner returned an empty response instead of the required Markdown decision.');
    error.stack = [
        `Error: ${error.message}`,
        '    at requestDecision (file:///code/node_modules/achillesAgentLib/LLMAgents/LoopAgenticSession/execution.mjs:171:15)',
        '    at async runLoopForPrompt (file:///code/node_modules/achillesAgentLib/LLMAgents/LoopAgenticSession/execution.mjs:201:26)',
    ].join('\n');

    assert.equal(formatWebchatError(error), [
        '[error] The LLM planner returned an empty response instead of the required Markdown decision.',
        'Source: [achillesAgentLib/LLMAgents/LoopAgenticSession/execution.mjs:171:15](/workspace-files/ploinky/node_modules/achillesAgentLib/LLMAgents/LoopAgenticSession/execution.mjs)',
    ].join('\n'));
});

test('WebChat errors use the forwarded public origin for clickable source links', () => {
    const error = new Error('Runtime failure');
    error.stack = [
        'Error: Runtime failure',
        '    at runWebchatInteractive (file:///code/copilot/src/index.mjs:664:42)',
    ].join('\n');

    assert.match(
        formatWebchatError(error, { publicBaseUrl: 'https://example.test/webchat?ignored=1' }),
        /\(https:\/\/example\.test\/workspace-files\/\.ploinky\/repos\/AchillesCLI\/roboTeamAgent\/copilot\/src\/index\.mjs\)$/,
    );
});

test('WebChat errors do not expose unmapped absolute stack paths', () => {
    const error = new Error('External failure');
    error.stack = [
        'Error: External failure',
        '    at provider (/private/runtime/provider.mjs:12:4)',
    ].join('\n');

    const output = formatWebchatError(error);
    assert.equal(output, '[error] External failure');
    assert.doesNotMatch(output, /private\/runtime/);
});
