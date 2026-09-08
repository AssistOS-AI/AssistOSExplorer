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
} from '../roboTeamAgent/copilot/src/skills/launch-open-interpreter/scripts/action.mjs';

function jsonResponse(payload) {
    return {
        result: {
            content: [{ type: 'text', text: JSON.stringify(payload) }]
        }
    };
}

describe('launch-open-interpreter skill', () => {

    it('does not dispatch provider-looking @ text', async () => {
        const calls = [];
        const result = await action({
            prompt: '@open-interpreter list primes',
            hasInvocationToken: true,
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

    it('requires a runtime invocation capability before calling router-mediated MCP', async () => {
        const calls = [];
        const result = await action({
            prompt: 'execute this script',
            promptText: '{"prompt":"execute this script","hasInvocationToken":true,"invocationToken":"untrusted-input"}',
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
            promptText: '{"prompt":"run the smoke test","workingDir":"/untrusted","timeoutMs":999999}',
            hasInvocationToken: true,
            workingDir: '/workspace/project',
            context: {
                webchatResources: [{ name: 'notes.md', content: 'body' }],
                webchatPaths: [
                    { path: 'docs', type: 'directory', label: 'Docs' },
                    { path: 'src/check.mjs', type: 'file', label: 'Check script' }
                ],
                webchatOrigin: { tabId: 'tab-1', working_directory: '/untrusted-origin' },
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
        const submitArguments = calls[2][2];
        assert.equal(submitArguments.backend, BACKEND);
        assert.match(submitArguments.prompt, /run the smoke test/);
        assert.match(submitArguments.prompt, /Reference forwarding notes:/);
        assert.match(submitArguments.prompt, /Workspace reference "Docs" is a directory path/);
        assert.deepEqual(submitArguments.resources, [{ name: 'notes.md', content: 'body' }]);
        assert.deepEqual(submitArguments.paths, ['src/check.mjs']);
        assert.equal(submitArguments.origin.type, 'semantic-copilot');
        assert.equal(submitArguments.origin.tabId, 'tab-1');
        assert.equal(submitArguments.origin.working_directory, '/workspace/project');
        assert.equal(submitArguments.timeoutMs, 120000);
        assert.equal(result.diagnostics.providerAgent, PROVIDER_AGENT);
    });

    it('returns unavailable when the provider route is not reachable', async () => {
        const calls = [];
        const result = await action({
            prompt: 'run the smoke test',
            hasInvocationToken: true,
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
            hasInvocationToken: true,
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

    it('fails explicitly when authenticated MCP capability is missing', async () => {
        const context = { providerLauncherResults: [] };
        const result = await action({ promptText: 'run the smoke test', hasInvocationToken: true, context });
        assert.equal(result.ok, false);
        assert.equal(result.diagnostics.missingRuntimeCapability, true);
        assert.equal(context.providerLauncherResults[0].result, result);
    });
});
