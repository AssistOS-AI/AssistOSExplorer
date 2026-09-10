import assert from 'node:assert/strict';
import test from 'node:test';

import { action } from '../src/skills/launch-robot/scripts/list.mjs';
import { ROBOTEAM_AGENT_REF } from '../src/skills/launch-robot/scripts/roboTeamClient.mjs';

test('robot discovery includes allowed skillsets and skill descriptions without full instructions', async () => {
    const result = await action({ agentClient: { callToolWithoutWait: async () => ({ robots: [{
        name: 'Analyst', description: 'Reports', skillsets: [{ id: 'repo-123-set-1', description: 'Read PDFs to prepare reports',
            skills: ['read'] }],
    }] }) } });
    assert.match(result, /Reports/);
    assert.match(result, /Read PDFs to prepare reports/);
    assert.match(result, /skillSets ID: repo-123-set-1/);
    assert.doesNotMatch(result, /PRIVATE BODY/);
});

test('lists the workspace robots returned by internal RoboTeam MCP', async () => {
    const calls = [];
    const starts = [];
    const result = await action({
        agentClient: {
            ensureAgentRunning: async (agentRef, options) => starts.push({ agentRef, options }),
            callToolWithoutWait: async (toolName, input, options) => {
                calls.push({ toolName, input, options });
                return {
                    ok: true,
                    robots: [{
                        name: 'Analyst',
                        specialization: 'Research',
                        run: { mode: 'desktop', state: 'running' },
                    }],
                };
            },
        },
    });

    assert.equal(result, '- Analyst — Research — desktop/running');
    assert.deepEqual(starts, [{
        agentRef: ROBOTEAM_AGENT_REF,
        options: { mode: 'global', timeoutMs: 180000 },
    }]);
    assert.deepEqual(calls, [{
        toolName: 'robot_list',
        input: {},
        options: undefined,
    }]);
});

test('reports an empty workspace robot list', async () => {
    const result = await action({
        agentClient: { callToolWithoutWait: async () => ({ ok: true, robots: [] }) },
    });
    assert.equal(result, 'No RoboTeam robots are available in this workspace.');
});

test('reports a bounded RoboTeam MCP failure instead of treating it as an empty list', async () => {
    const result = await action({
        agentClient: {
            callToolWithoutWait: async () => ({
                isError: true,
                content: [{ type: 'text', text: 'MCP error -32603\nError: robot service unavailable\nstack details' }],
            }),
        },
    });
    assert.equal(result, 'Could not list RoboTeam robots: robot service unavailable');
});


test('discovery lists individual skills for a repository without skillsets', async () => {
    const result = await action({ agentClient: { callToolWithoutWait: async () => ({ robots: [{
        name: 'Analyst', skillsets: [], skillRepositories: [{ id: 'repo-reports', skills: [
            { name: 'read-report', description: 'Read and summarize reports', instructions: 'PRIVATE BODY' },
        ] }],
    }] }) } });
    assert.match(result, /Skill repo-reports\/read-report: Read and summarize reports/);
    assert.doesNotMatch(result, /PRIVATE BODY|undefined/);
});
