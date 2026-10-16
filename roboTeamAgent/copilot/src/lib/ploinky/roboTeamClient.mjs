import { callToolWhenReady, ensureAgentsRunning } from './ploinkyAgentRuntime.mjs';

export const ROBOTEAM_AGENT = 'roboTeamAgent';
export const ROBOTEAM_AGENT_REF = 'AchillesCLI/roboTeamAgent';

function trim(value) {
    return typeof value === 'string' ? value.trim() : '';
}

function mcpErrorMessage(result) {
    const text = Array.isArray(result?.content)
        ? result.content.map((entry) => trim(entry?.text)).filter(Boolean).join('\n')
        : '';
    const matches = [...text.matchAll(/(?:^|\n)Error:\s*([^\n]+)/gu)];
    return trim(matches.at(-1)?.[1]) || trim(text.split('\n')[0]) || 'RoboTeam operation failed.';
}

async function resolveClient(invocation = {}) {
    if (invocation.agentClient && typeof invocation.agentClient.callToolWithoutWait === 'function') {
        return invocation.agentClient;
    }
    if (!process.env.PLOINKY_AGENT_ID || !process.env.PLOINKY_AGENT_SECRET) {
        throw new Error('Ploinky agent credentials are required for RoboTeam delegation.');
    }
    const module = await import('/Agent/client/AgentMcpClient.mjs');
    if (!module?.createAgentClient || typeof module.createAgentClient !== 'function') {
        throw new Error('Ploinky AgentMcpClient is unavailable in this runtime.');
    }
    return module.createAgentClient(ROBOTEAM_AGENT);
}

export async function createRoboTeamClient(invocation = {}) {
    const client = await resolveClient(invocation);
    await ensureAgentsRunning(client, [ROBOTEAM_AGENT_REF], invocation);
    return {
        async call(toolName, input = {}) {
            const result = await callToolWhenReady(() => client.callToolWithoutWait(toolName, input));
            if (result?.isError === true) throw new Error(mcpErrorMessage(result));
            if (result?.ok === false) throw new Error(trim(result.error) || 'RoboTeam operation failed.');
            return result && typeof result === 'object' ? result : {};
        },
        async getTaskStatus(taskId) {
            if (typeof client.getTaskStatus !== 'function') throw new Error('RoboTeam task status is unavailable.');
            return client.getTaskStatus(taskId);
        },
    };
}

export const roboTeamClientInternals = { mcpErrorMessage };
