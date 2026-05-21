import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
    BACKEND,
    LIST_TOOL,
    PROVIDER_AGENT,
    PROVIDER_STATUS_TOOL,
    RELAY_AGENT,
    SUBMIT_TOOL,
    action
} from '../achilles-cli/src/skills/launch-open-interpreter/src/index.mjs';

function jsonResponse(payload) {
    return {
        result: {
            content: [{ type: 'text', text: JSON.stringify(payload) }]
        }
    };
}

describe('launch-open-interpreter cskill', () => {
    it('uses copilotProviderRelay as the canonical dispatcher', () => {
        assert.equal(BACKEND, 'open-interpreter');
        assert.equal(RELAY_AGENT, 'copilotProviderRelay');
        assert.equal(PROVIDER_AGENT, 'openInterpreterAgent');
        assert.equal(LIST_TOOL, 'copilot_provider_list_backends');
        assert.equal(SUBMIT_TOOL, 'copilot_provider_task_submit');
        assert.equal(PROVIDER_STATUS_TOOL, 'oi_status');
    });

    it('does not dispatch provider-looking @ text', async () => {
        const calls = [];
        const result = await action({
            prompt: '@open-interpreter list primes',
            context: { invocationToken: 'caller-token' },
            callAgentTool: (...args) => {
                calls.push(args);
                throw new Error('unexpected call');
            }
        });
        assert.equal(result.ok, false);
        assert.equal(result.cacheable, false);
        assert.equal(result.diagnostics.deprecatedToken, true);
        assert.equal(calls.length, 0);
    });

    it('requires an invocation token before calling router-mediated MCP', async () => {
        const calls = [];
        const result = await action({
            prompt: 'execute this script',
            callAgentTool: (...args) => {
                calls.push(args);
                throw new Error('unexpected call');
            }
        });
        assert.equal(result.ok, false);
        assert.equal(result.cacheable, false);
        assert.equal(result.diagnostics.missingInvocationToken, true);
        assert.equal(calls.length, 0);
    });

    it('submits execution through copilot_provider_task_submit with context resources', async () => {
        const calls = [];
        const result = await action({
            prompt: 'run the smoke test',
            context: {
                invocationToken: 'caller-token',
                workingDir: '/workspace/project',
                webchatResources: [{ name: 'notes.md', content: 'body' }],
                webchatPaths: [
                    { path: 'docs', type: 'directory', label: 'Docs' },
                    { path: 'src/check.mjs', type: 'file', label: 'Check script' }
                ],
                webchatOrigin: { tabId: 'tab-1' },
                webchatResourceWarnings: ['missing file']
            },
            callAgentTool: async (...args) => {
                calls.push(args);
                const [, toolName] = args;
                if (toolName === LIST_TOOL) {
                    return jsonResponse({ backends: [{ id: BACKEND, provider: { agent: PROVIDER_AGENT } }] });
                }
                if (toolName === PROVIDER_STATUS_TOOL) {
                    return jsonResponse({ agent: PROVIDER_AGENT, status: 'ok' });
                }
                return jsonResponse({ ok: true, backend: BACKEND, final_answer: 'smoke passed', jobId: 'job-1' });
            }
        });

        assert.equal(result.ok, true);
        assert.equal(result.cacheable, false);
        assert.equal(result.result_text, 'smoke passed');
        assert.deepEqual(calls.map((call) => [call[0], call[1]]), [
            [RELAY_AGENT, LIST_TOOL],
            [PROVIDER_AGENT, PROVIDER_STATUS_TOOL],
            [RELAY_AGENT, SUBMIT_TOOL],
        ]);
        assert.equal(calls[0][3].invocationToken, 'caller-token');
        assert.equal(calls[1][3].invocationToken, 'caller-token');
        assert.equal(calls[2][3].invocationToken, 'caller-token');
        const submitArguments = calls[2][2];
        assert.equal(submitArguments.backend, BACKEND);
        assert.match(submitArguments.prompt, /run the smoke test/);
        assert.match(submitArguments.prompt, /Reference forwarding notes:/);
        assert.match(submitArguments.prompt, /Workspace reference "Docs" is a directory path/);
        assert.deepEqual(submitArguments.resources, [{ name: 'notes.md', content: 'body' }]);
        assert.deepEqual(submitArguments.paths, ['src/check.mjs']);
        assert.equal(submitArguments.origin.type, 'semantic-copilot');
        assert.equal(submitArguments.origin.tabId, 'tab-1');
        assert.equal(result.diagnostics.providerAgent, PROVIDER_AGENT);
    });

    it('returns unavailable when the provider route is not reachable', async () => {
        const calls = [];
        const result = await action({
            prompt: 'run the smoke test',
            context: { invocationToken: 'caller-token' },
            callAgentTool: async (...args) => {
                calls.push(args);
                const [, toolName] = args;
                if (toolName === LIST_TOOL) {
                    return jsonResponse({ backends: [{ id: BACKEND, provider: { agent: PROVIDER_AGENT } }] });
                }
                if (toolName === PROVIDER_STATUS_TOOL) {
                    throw new Error('route not found');
                }
                throw new Error('submit should not be called');
            }
        });

        assert.equal(result.ok, false);
        assert.equal(result.cacheable, false);
        assert.equal(result.diagnostics.providerAvailability, 'not_deployed');
        assert.doesNotMatch(result.result_text, /enable copilot-agents|ploinky enable/i);
        assert.match(result.result_text, /provider agent openInterpreterAgent is not reachable/);
        assert.deepEqual(calls.map((call) => [call[0], call[1]]), [
            [RELAY_AGENT, LIST_TOOL],
            [PROVIDER_AGENT, PROVIDER_STATUS_TOOL],
        ]);
    });

    it('reports missing provider relay backend without enable-command guidance', async () => {
        const calls = [];
        const result = await action({
            prompt: 'run the smoke test',
            context: { invocationToken: 'caller-token' },
            callAgentTool: async (...args) => {
                calls.push(args);
                return jsonResponse({ backends: [] });
            }
        });

        assert.equal(result.ok, false);
        assert.equal(result.cacheable, false);
        assert.equal(result.diagnostics.providerAvailability, 'not_deployed');
        assert.equal(result.diagnostics.missingBackend, BACKEND);
        assert.match(result.result_text, /launcher is available/);
        assert.doesNotMatch(result.result_text, /enable copilot-agents|ploinky enable/i);
        assert.deepEqual(calls.map((call) => [call[0], call[1]]), [
            [RELAY_AGENT, LIST_TOOL],
        ]);
    });
});
