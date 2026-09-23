import path from 'node:path';

export const CODING_AGENT_NAMES = Object.freeze(['codex', 'opencode', 'pi']);
// ALA can inject a Streamable HTTP MCP endpoint only into Codex and OpenCode.
// Pi has no native ALA-managed MCP support, so it cannot drive a GUI task.
export const GUI_CODING_AGENTS = Object.freeze(['codex', 'opencode']);

export function normalizeCodingAgents(value = ['opencode']) {
    if (!Array.isArray(value) || !value.length || value.some(name => !CODING_AGENT_NAMES.includes(name))) {
        throw new Error('codingAgents must contain codex, opencode or pi');
    }
    return CODING_AGENT_NAMES.filter(name => value.includes(name));
}

export function robotCodingAgents(robot) {
    // Existing robots retain their installed tool set until explicitly configured.
    return normalizeCodingAgents(robot.codingAgents === undefined ? CODING_AGENT_NAMES : robot.codingAgents);
}

export function codingAgentEnvironment(agents, environment = process.env, cacheRoot = '/data/tool-cache') {
    const env = { ...environment };
    const excluded = new Set(CODING_AGENT_NAMES.map(name => environment[`${name.toUpperCase()}_BIN`])
        .filter(Boolean).map(binary => path.dirname(binary)));
    const inherited = String(env.PATH || '').split(path.delimiter).filter(directory => directory
        && !excluded.has(directory) && directory !== cacheRoot && !directory.startsWith(cacheRoot + path.sep));
    for (const name of CODING_AGENT_NAMES) {
        delete env[`${name.toUpperCase()}_BIN`];
        if (agents[name]) env[`${name.toUpperCase()}_BIN`] = path.join(agents[name].binPath, name);
    }
    env.PATH = [...Object.values(agents).map(agent => agent.binPath), ...inherited].join(path.delimiter);
    return env;
}
