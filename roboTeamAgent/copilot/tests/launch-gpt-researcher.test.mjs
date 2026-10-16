import test from 'node:test';
import assert from 'node:assert/strict';

import {
    action,
    SEARCH_AGENT_REF,
    TARGET_AGENT,
    TARGET_AGENT_REF,
    TOOL_NAME,
} from '../src/skills/launch-gpt-researcher/scripts/action.mjs';

test('action calls GPTResearcher MCP tool with plain prompt', async () => {
    const calls = [];
    const starts = [];
    const result = await action({
        promptText: 'research the workspace',
        workingDir: '/workspace/project',
        agentClient: {
            ensureAgentRunning: async (agentRef, options) => starts.push({ agentRef, options }),
            callToolWithoutWait: async (toolName, payload, options) => {
                calls.push({ toolName, payload, options });
                return {
                    content: [{ type: 'text', text: JSON.stringify({ ok: true, report: 'research complete' }) }],
                };
            },
        },
    });

    assert.equal(result, 'GPTResearcher task completed.\n\nresearch complete');
    assert.equal(TARGET_AGENT, 'GPTResearcher');
    assert.equal(TOOL_NAME, 'start_research');
    assert.deepEqual(starts, [
        { agentRef: SEARCH_AGENT_REF, options: { mode: 'global', timeoutMs: 180000 } },
        { agentRef: TARGET_AGENT_REF, options: { mode: 'global', timeoutMs: 180000 } },
    ]);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].toolName, TOOL_NAME);
    assert.deepEqual(calls[0].payload, {
        query: 'research the workspace',
        workingDir: '/workspace/project',
    });
});

test('action accepts JSON input with query, context, reportType, and useLocalDocs', async () => {
    const result = await action({
        promptText: JSON.stringify({
            query: 'build a research brief',
            context: 'focus on implementation tradeoffs',
            reportType: 'custom_report',
            useLocalDocs: false,
            workingDir: '/ignored/by/skill',
        }),
        workingDir: '/workspace/current',
        agentClient: {
            callToolWithoutWait: async (toolName, payload) => {
                assert.equal(toolName, TOOL_NAME);
                assert.deepEqual(payload, {
                    query: 'build a research brief',
                    context: 'focus on implementation tradeoffs',
                    reportType: 'custom_report',
                    workingDir: '/workspace/current',
                    useLocalDocs: false,
                });
                return {
                    content: [{ type: 'text', text: JSON.stringify({ ok: true, report: 'brief' }) }],
                };
            },
        },
    });

    assert.equal(result, 'GPTResearcher task completed.\n\nbrief');
});

test('action accepts context and reportType with text prompt', async () => {
    const calls = [];
    const result = await action({
        promptText: 'summarize useful files',
        context: 'include implementation constraints',
        reportType: 'research_report',
        workingDir: '/workspace/text-prompt',
        agentClient: {
            callToolWithoutWait: async (toolName, payload) => {
                calls.push({ toolName, payload });
                return {
                    content: [{ type: 'text', text: JSON.stringify({ ok: true, report: 'summary' }) }],
                };
            },
        },
    });

    assert.equal(result, 'GPTResearcher task completed.\n\nsummary');
    assert.deepEqual(calls[0].payload, {
        query: 'summarize useful files',
        context: 'include implementation constraints',
        reportType: 'research_report',
        workingDir: '/workspace/text-prompt',
    });
});

test('action falls back to compact JSON when report is absent', async () => {
    const result = await action({
        promptText: 'research',
        workingDir: '/workspace/fallback',
        agentClient: {
            callToolWithoutWait: async () => ({
                content: [{ type: 'text', text: JSON.stringify({ ok: true, sourceUrls: ['https://example.com'] }) }],
            }),
        },
    });

    assert.equal(result, 'GPTResearcher task completed.\n\n{"ok":true,"sourceUrls":["https://example.com"]}');
});

test('action reports delegated failures as plain text', async () => {
    const result = await action({
        promptText: 'research',
        agentClient: {
            callToolWithoutWait: async () => {
                throw new Error('router unavailable');
            },
        },
    });

    assert.equal(result, 'GPTResearcher task failed: router unavailable');
});

test('action reports failed task payloads as plain text', async () => {
    const result = await action({
        promptText: 'research',
        agentClient: {
            callToolWithoutWait: async () => {
                const error = new Error('task failed');
                error.task = {
                    content: [{ type: 'text', text: JSON.stringify({ ok: false, error: 'missing OPENAI_API_KEY' }) }],
                };
                throw error;
            },
        },
    });

    assert.equal(result, 'GPTResearcher task failed: missing OPENAI_API_KEY');
});

test('action returns plain text for missing prompt', async () => {
    const result = await action({ promptText: '   ' });
    assert.match(result, /needs a natural-language research task/);
});
