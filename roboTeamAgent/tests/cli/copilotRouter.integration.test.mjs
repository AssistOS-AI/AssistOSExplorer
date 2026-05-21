import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { MainAgent, discoverSkillsFromRoot } from '../achilles-cli/node_modules/achillesAgentLib/MainAgent/index.mjs';
import {
    BACKEND as OPEN_INTERPRETER_BACKEND,
    LIST_TOOL,
    PROVIDER_AGENT,
    PROVIDER_STATUS_TOOL,
    RELAY_AGENT,
    SUBMIT_TOOL,
} from '../achilles-cli/src/skills/launch-open-interpreter/src/index.mjs';
import { collectPloinkyRepoSkillRoots } from '../achilles-cli/src/index.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BUILTIN_SKILLS_ROOT = path.join(__dirname, '../achilles-cli/src/skills');
const WEB_SEARCH_BACKEND = 'web-search';
const WEB_SEARCH_PROVIDER_AGENT = 'webSearchAgent';
const WEB_SEARCH_STATUS_TOOL = 'web_search_status';
const BROWSER_USE_BACKEND = 'browser-use';
const BROWSER_USE_PROVIDER_AGENT = 'browserUseAgent';
const BROWSER_USE_STATUS_TOOL = 'browser_use_status';

function logger() {
    return {
        debug() {},
        info() {},
        log() {},
        warn() {},
        error() {},
    };
}

function jsonResponse(payload) {
    return {
        result: {
            content: [{ type: 'text', text: JSON.stringify(payload) }],
        },
    };
}

function registerSkillRoot(agent, skillRoot, isInternal = true) {
    const discovered = discoverSkillsFromRoot(skillRoot, { logger: logger() });
    for (const skillRecord of discovered) {
        skillRecord.isInternal = isInternal;
        agent._registerSkill(skillRecord);
    }
    agent._refreshOrchestratedSkillIndex?.();
}

function hasProviderLikeToken(promptText) {
    return /(^|\s)@[a-z][a-z0-9_-]*(?=\s|$|[.,:;!?])/i.test(String(promptText || ''));
}

function isWebSearchPrompt(promptText) {
    const text = String(promptText || '').toLowerCase();
    if (hasProviderLikeToken(text)) {
        return false;
    }
    if (isBrowserUsePrompt(text)) {
        return false;
    }
    if (/\b(memory|prior work|previous discussion|discussed)\b/.test(text)) {
        return false;
    }
    return /\b(search online|look up|latest|current|recent|news|web lookup|pricing)\b/.test(text);
}

function isBrowserUsePrompt(promptText) {
    const text = String(promptText || '').toLowerCase();
    if (hasProviderLikeToken(text)) {
        return false;
    }
    return /\b(chatgpt|gemini)\b/.test(text)
        && /\b(use|ask|browser|login|log in|oauth|account)\b/.test(text);
}

function isExecutionPrompt(promptText) {
    const text = String(promptText || '').toLowerCase();
    if (hasProviderLikeToken(text)) {
        return false;
    }
    if (/\bhow\s+(do|can|could)\s+i\b/.test(text) || /\bhow\s+i\s+(do|can|could)\b/.test(text)) {
        return false;
    }
    return /\b(run|execute|test|debug|build|benchmark|empirically check)\b/.test(text);
}

function installDeterministicCopilotLoop(agent, loopCalls) {
    agent.llmAgent.startLoopAgentSession = async (tools, promptText, options = {}) => {
        assert.ok(tools['launch-open-interpreter'], 'copilot-router should expose launch-open-interpreter');
        assert.ok(tools['launch-web-search'], 'copilot-router should expose launch-web-search');
        assert.match(options.systemPrompt, /Use `launch-open-interpreter`/);
        assert.match(options.systemPrompt, /Rule order is precedence/);
        assert.match(options.systemPrompt, /launch-web-search/);

        let selectedTool = null;
        if (isBrowserUsePrompt(promptText) && tools['launch-browser-use']) {
            selectedTool = 'launch-browser-use';
        } else if (isWebSearchPrompt(promptText)) {
            selectedTool = 'launch-web-search';
        } else if (isExecutionPrompt(promptText)) {
            selectedTool = 'launch-open-interpreter';
        }

        let lastResult = 'Answered directly without launching an external provider.';
        if (selectedTool) {
            lastResult = await tools[selectedTool].handler(null, promptText, {
                signal: options.signal || null,
            });
        }

        loopCalls.push({
            prompt: promptText,
            selectedTool,
            result: lastResult,
        });

        return {
            status: 'completed',
            getLastResult() {
                return lastResult;
            },
        };
    };
}

function createRouterAgent(options = {}) {
    const tempDir = options.tempDir || fs.mkdtempSync(path.join(os.tmpdir(), 'copilot-router-integration-'));
    const agent = new MainAgent({
        startDir: tempDir,
        logger: logger(),
        disableInternalSkills: true,
    });
    registerSkillRoot(agent, BUILTIN_SKILLS_ROOT, true);
    if (options.registerPloinkyRepoSkillRoots) {
        for (const skillRoot of collectPloinkyRepoSkillRoots(tempDir, { PLOINKY_WORKSPACE_ROOT: tempDir }, logger())) {
            registerSkillRoot(agent, skillRoot, false);
        }
    }
    const loopCalls = [];
    installDeterministicCopilotLoop(agent, loopCalls);
    return { agent, loopCalls, tempDir };
}

function writeDeployedWebSearchLauncher(workspaceRoot) {
    const skillDir = path.join(workspaceRoot, '.ploinky', 'repos', 'copilot-agents', 'achilles-skills', 'launch-web-search');
    fs.mkdirSync(path.join(skillDir, 'src'), { recursive: true });
    fs.writeFileSync(path.join(skillDir, 'cskill.md'), `# Launch Web Search

Dispatch current-information Copilot prompts to the deployed web search provider
through the Copilot Provider Relay.

## Backend
web-search

## Cacheable
true

## ProviderAvailability
active

## Input Format
Accepts a JSON object or prompt text with a \`prompt\` field.

## Output Format
Returns a structured launcher result with \`ok\`, \`backend\`, \`cacheable\`,
\`result_text\`, \`persistence_hint\`, and \`diagnostics\`.
`);
    fs.writeFileSync(path.join(skillDir, 'src', 'index.mjs'), `
function extractJson(response) {
    const text = response?.result?.content
        ?.filter((entry) => entry?.type === 'text' && typeof entry.text === 'string')
        ?.map((entry) => entry.text)
        ?.join('\\n') || '{}';
    return JSON.parse(text);
}

export async function action(args = {}) {
    const prompt = String(args.prompt || args.promptText || '').trim();
    const context = args.context && typeof args.context === 'object' ? args.context : {};
    const callAgentTool = args.callAgentTool || context.callAgentTool;
    const invocationToken = args.invocationToken || context.invocationToken;
    const catalog = extractJson(await callAgentTool('copilotProviderRelay', 'copilot_provider_list_backends', {}, { invocationToken }));
    const backend = (catalog.backends || []).find((entry) => entry.id === 'web-search');
    const providerAgent = backend?.provider?.agent || 'webSearchAgent';
    await callAgentTool(providerAgent, 'web_search_status', {}, { invocationToken });
    const payload = extractJson(await callAgentTool('copilotProviderRelay', 'copilot_provider_task_submit', {
        backend: 'web-search',
        prompt,
    }, { invocationToken }));
    const result = {
        ok: Boolean(payload.ok),
        backend: 'web-search',
        cacheable: true,
        result_text: payload.final_answer || '',
        persistence_hint: {
            ku_type: 'agent.result.web-search',
            record_result: true,
            ttl_hint_seconds: payload.ttl_hint_seconds || 86400,
        },
        diagnostics: {
            providerAvailability: 'active',
            providerAgent,
        },
    };
    if (!Array.isArray(context.providerLauncherResults)) {
        context.providerLauncherResults = [];
    }
    context.providerLauncherResults.push({
        launcher: 'launch-web-search',
        backend: 'web-search',
        prompt,
        result,
    });
    return result;
}
`);
    return skillDir;
}

function writeDeployedBrowserUseLauncher(workspaceRoot) {
    const skillDir = path.join(workspaceRoot, '.ploinky', 'repos', 'copilot-agents', 'achilles-skills', 'launch-browser-use');
    fs.mkdirSync(path.join(skillDir, 'src'), { recursive: true });
    fs.writeFileSync(path.join(skillDir, 'cskill.md'), `# Launch Browser Use

Dispatch browser Copilot prompts to the deployed browser-use provider through
the Copilot Provider Relay.

## Backend
browser-use

## Cacheable
false

## ProviderAvailability
active

## Input Format
Accepts a JSON object or prompt text with a \`prompt\` field.
`);
    fs.writeFileSync(path.join(skillDir, 'src', 'index.mjs'), `
function extractJson(response) {
    const text = response?.result?.content
        ?.filter((entry) => entry?.type === 'text' && typeof entry.text === 'string')
        ?.map((entry) => entry.text)
        ?.join('\\n') || '{}';
    return JSON.parse(text);
}

function providerFromPrompt(prompt) {
    return /\\bgemini\\b/i.test(prompt) ? 'gemini' : 'chatgpt';
}

export async function action(args = {}) {
    const prompt = String(args.prompt || args.promptText || '').trim();
    const context = args.context && typeof args.context === 'object' ? args.context : {};
    const callAgentTool = args.callAgentTool || context.callAgentTool;
    const invocationToken = args.invocationToken || context.invocationToken;
    const provider = providerFromPrompt(prompt);
    const catalog = extractJson(await callAgentTool('copilotProviderRelay', 'copilot_provider_list_backends', {}, { invocationToken }));
    const backend = (catalog.backends || []).find((entry) => entry.id === 'browser-use');
    const providerAgent = backend?.provider?.agent || 'browserUseAgent';
    await callAgentTool(providerAgent, 'browser_use_status', {}, { invocationToken });
    const payload = extractJson(await callAgentTool('copilotProviderRelay', 'copilot_provider_task_submit', {
        backend: 'browser-use',
        provider,
        prompt,
    }, { invocationToken }));
    const result = {
        ok: Boolean(payload.ok),
        backend: 'browser-use',
        cacheable: false,
        result_text: payload.final_answer || payload.natural_language_output || payload.error || '',
        provider,
        viewerUrl: payload.viewerUrl,
        sessionId: payload.sessionId,
        requires_user_action: payload.requires_user_action,
        diagnostics: {
            providerAvailability: 'active',
            providerAgent,
        },
    };
    if (!Array.isArray(context.providerLauncherResults)) {
        context.providerLauncherResults = [];
    }
    context.providerLauncherResults.push({
        launcher: 'launch-browser-use',
        backend: 'browser-use',
        prompt,
        result,
    });
    return result;
}
`);
    return skillDir;
}

function createWebchatContext({ workingDir, callAgentTool }) {
    return {
        invocationToken: 'router-token',
        workingDir,
        providerLauncherResults: [],
        callAgentTool,
        webchatOrigin: {
            surface: 'webchat',
            tabId: 'router-test',
        },
        webchatResources: [{ name: 'notes.md', content: 'integration fixture' }],
        webchatPaths: [{ path: 'scripts/check.mjs', type: 'file', label: 'Check script' }],
    };
}

describe('copilot-router launcher integration', () => {
    const tempDirs = [];

    afterEach(() => {
        while (tempDirs.length) {
            fs.rmSync(tempDirs.pop(), { recursive: true, force: true });
        }
    });

    it('routes execution prompts to the Open Interpreter launcher and submits through Copilot Provider Relay', async () => {
        const { agent, loopCalls, tempDir } = createRouterAgent();
        tempDirs.push(tempDir);
        const mcpCalls = [];
        const context = createWebchatContext({
            workingDir: tempDir,
            callAgentTool: async (agentName, toolName, args, options) => {
                mcpCalls.push({ agentName, toolName, args, options });
                if (agentName === RELAY_AGENT && toolName === LIST_TOOL) {
                    return jsonResponse({
                        backends: [{
                            id: OPEN_INTERPRETER_BACKEND,
                            provider: { agent: PROVIDER_AGENT },
                        }],
                    });
                }
                if (agentName === PROVIDER_AGENT && toolName === PROVIDER_STATUS_TOOL) {
                    return jsonResponse({ agent: PROVIDER_AGENT, status: 'ok' });
                }
                if (agentName === RELAY_AGENT && toolName === SUBMIT_TOOL) {
                    return jsonResponse({
                        ok: true,
                        backend: OPEN_INTERPRETER_BACKEND,
                        final_answer: 'Open Interpreter launched and tests passed.',
                        jobId: 'job-router-1',
                    });
                }
                throw new Error(`Unexpected MCP call: ${agentName}.${toolName}`);
            },
        });

        const result = await agent.executeSkill(
            'copilot-router',
            'Build and test the sample project.',
            { context, model: 'plan' }
        );

        assert.match(result.skill, /copilot-router/);
        assert.equal(result.session, 'loop');
        assert.equal(loopCalls.length, 1);
        assert.equal(loopCalls[0].selectedTool, 'launch-open-interpreter');
        assert.deepEqual(mcpCalls.map((call) => [call.agentName, call.toolName]), [
            [RELAY_AGENT, LIST_TOOL],
            [PROVIDER_AGENT, PROVIDER_STATUS_TOOL],
            [RELAY_AGENT, SUBMIT_TOOL],
        ]);
        assert.equal(mcpCalls[2].options.invocationToken, 'router-token');
        assert.equal(mcpCalls[2].args.backend, OPEN_INTERPRETER_BACKEND);
        assert.match(mcpCalls[2].args.prompt, /Build and test the sample project/);
        assert.deepEqual(mcpCalls[2].args.paths, ['scripts/check.mjs']);

        assert.equal(context.providerLauncherResults.length, 1);
        const [launcherResult] = context.providerLauncherResults;
        assert.equal(launcherResult.launcher, 'launch-open-interpreter');
        assert.equal(launcherResult.backend, OPEN_INTERPRETER_BACKEND);
        assert.equal(launcherResult.result.ok, true);
        assert.equal(launcherResult.result.result_text, 'Open Interpreter launched and tests passed.');
        assert.equal(launcherResult.result.diagnostics.providerAvailability, 'active');
    });

    it('routes online/current prompts to a deployed Web Search launcher and submits through Copilot Provider Relay', async () => {
        const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'copilot-router-integration-'));
        writeDeployedWebSearchLauncher(tempDir);
        const { agent, loopCalls } = createRouterAgent({
            tempDir,
            registerPloinkyRepoSkillRoots: true,
        });
        tempDirs.push(tempDir);
        const mcpCalls = [];
        const context = createWebchatContext({
            workingDir: tempDir,
            callAgentTool: async (agentName, toolName, args, options) => {
                mcpCalls.push({ agentName, toolName, args, options });
                if (agentName === RELAY_AGENT && toolName === LIST_TOOL) {
                    return jsonResponse({
                        backends: [{
                            id: WEB_SEARCH_BACKEND,
                            provider: { agent: WEB_SEARCH_PROVIDER_AGENT },
                        }],
                    });
                }
                if (agentName === WEB_SEARCH_PROVIDER_AGENT && toolName === WEB_SEARCH_STATUS_TOOL) {
                    return jsonResponse({ agent: WEB_SEARCH_PROVIDER_AGENT, status: 'ok' });
                }
                if (agentName === RELAY_AGENT && toolName === SUBMIT_TOOL) {
                    return jsonResponse({
                        ok: true,
                        backend: WEB_SEARCH_BACKEND,
                        final_answer: 'Node.js latest release date is May 14, 2026.',
                        ttl_hint_seconds: 3600,
                    });
                }
                throw new Error(`Unexpected MCP call: ${agentName}.${toolName}`);
            },
        });

        const result = await agent.executeSkill(
            'copilot-router',
            'Search online for the latest release notes.',
            { context, model: 'plan' }
        );

        assert.match(result.skill, /copilot-router/);
        assert.equal(result.session, 'loop');
        assert.equal(loopCalls.length, 1);
        assert.equal(loopCalls[0].selectedTool, 'launch-web-search');
        assert.deepEqual(mcpCalls.map((call) => [call.agentName, call.toolName]), [
            [RELAY_AGENT, LIST_TOOL],
            [WEB_SEARCH_PROVIDER_AGENT, WEB_SEARCH_STATUS_TOOL],
            [RELAY_AGENT, SUBMIT_TOOL],
        ]);
        assert.equal(mcpCalls[2].options.invocationToken, 'router-token');
        assert.equal(mcpCalls[2].args.backend, WEB_SEARCH_BACKEND);
        assert.match(mcpCalls[2].args.prompt, /Search online for the latest release notes/);

        assert.equal(context.providerLauncherResults.length, 1);
        const [launcherResult] = context.providerLauncherResults;
        assert.equal(launcherResult.launcher, 'launch-web-search');
        assert.equal(launcherResult.backend, WEB_SEARCH_BACKEND);
        assert.equal(launcherResult.result.ok, true);
        assert.equal(launcherResult.result.cacheable, true);
        assert.equal(launcherResult.result.persistence_hint.record_result, true);
        assert.equal(launcherResult.result.diagnostics.providerAvailability, 'active');
        assert.equal(launcherResult.result.result_text, 'Node.js latest release date is May 14, 2026.');
    });

    it('routes logged-in browser service prompts to Browser Use before Web Search', async () => {
        const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'copilot-router-integration-'));
        writeDeployedBrowserUseLauncher(tempDir);
        writeDeployedWebSearchLauncher(tempDir);
        const { agent, loopCalls } = createRouterAgent({
            tempDir,
            registerPloinkyRepoSkillRoots: true,
        });
        tempDirs.push(tempDir);
        const mcpCalls = [];
        const context = createWebchatContext({
            workingDir: tempDir,
            callAgentTool: async (agentName, toolName, args, options) => {
                mcpCalls.push({ agentName, toolName, args, options });
                if (agentName === RELAY_AGENT && toolName === LIST_TOOL) {
                    return jsonResponse({
                        backends: [{
                            id: BROWSER_USE_BACKEND,
                            provider: { agent: BROWSER_USE_PROVIDER_AGENT },
                        }],
                    });
                }
                if (agentName === BROWSER_USE_PROVIDER_AGENT && toolName === BROWSER_USE_STATUS_TOOL) {
                    return jsonResponse({ agent: BROWSER_USE_PROVIDER_AGENT, status: 'ok' });
                }
                if (agentName === RELAY_AGENT && toolName === SUBMIT_TOOL) {
                    return jsonResponse({
                        ok: true,
                        backend: BROWSER_USE_BACKEND,
                        provider: args.provider,
                        viewerUrl: '/services/browser-use/sessions/sess_router_test',
                        sessionId: 'sess_router_test',
                        requires_user_action: true,
                    });
                }
                throw new Error(`Unexpected MCP call: ${agentName}.${toolName}`);
            },
        });

        const result = await agent.executeSkill(
            'copilot-router',
            'Use Gemini in the browser to search for the latest OpenAI model news.',
            { context, model: 'plan' }
        );

        assert.match(result.skill, /copilot-router/);
        assert.equal(result.session, 'loop');
        assert.equal(loopCalls.length, 1);
        assert.equal(loopCalls[0].selectedTool, 'launch-browser-use');
        assert.deepEqual(mcpCalls.map((call) => [call.agentName, call.toolName]), [
            [RELAY_AGENT, LIST_TOOL],
            [BROWSER_USE_PROVIDER_AGENT, BROWSER_USE_STATUS_TOOL],
            [RELAY_AGENT, SUBMIT_TOOL],
        ]);
        assert.equal(mcpCalls[2].options.invocationToken, 'router-token');
        assert.equal(mcpCalls[2].args.backend, BROWSER_USE_BACKEND);
        assert.equal(mcpCalls[2].args.provider, 'gemini');
        assert.match(mcpCalls[2].args.prompt, /latest OpenAI model news/);

        assert.equal(context.providerLauncherResults.length, 1);
        const [launcherResult] = context.providerLauncherResults;
        assert.equal(launcherResult.launcher, 'launch-browser-use');
        assert.equal(launcherResult.backend, BROWSER_USE_BACKEND);
        assert.equal(launcherResult.result.ok, true);
        assert.equal(launcherResult.result.cacheable, false);
        assert.equal(launcherResult.result.provider, 'gemini');
        assert.equal(launcherResult.result.requires_user_action, true);
    });

    it('does not treat provider-looking @web-search text as a launcher command', async () => {
        const { agent, loopCalls, tempDir } = createRouterAgent();
        tempDirs.push(tempDir);
        const mcpCalls = [];
        const context = createWebchatContext({
            workingDir: tempDir,
            callAgentTool: async (...args) => {
                mcpCalls.push(args);
                throw new Error('No provider should be called for @token text');
            },
        });

        const result = await agent.executeSkill(
            'copilot-router',
            '@web-search latest Node.js release',
            { context, model: 'plan' }
        );

        assert.match(result.skill, /copilot-router/);
        assert.equal(result.session, 'loop');
        assert.equal(result.result, 'Answered directly without launching an external provider.');
        assert.equal(loopCalls.length, 1);
        assert.equal(loopCalls[0].selectedTool, null);
        assert.equal(context.providerLauncherResults.length, 0);
        assert.equal(mcpCalls.length, 0);
    });

    it('does not launch a provider for how-to execution questions', async () => {
        const { agent, loopCalls, tempDir } = createRouterAgent();
        tempDirs.push(tempDir);
        const mcpCalls = [];
        const context = createWebchatContext({
            workingDir: tempDir,
            callAgentTool: async (...args) => {
                mcpCalls.push(args);
                throw new Error('No provider should be called for explanatory prompts');
            },
        });

        const result = await agent.executeSkill(
            'copilot-router',
            'Explain how I could run this script locally.',
            { context, model: 'plan' }
        );

        assert.match(result.skill, /copilot-router/);
        assert.equal(result.session, 'loop');
        assert.equal(result.result, 'Answered directly without launching an external provider.');
        assert.equal(loopCalls.length, 1);
        assert.equal(loopCalls[0].selectedTool, null);
        assert.equal(context.providerLauncherResults.length, 0);
        assert.equal(mcpCalls.length, 0);
    });
});
