// The MCP tools RoboTeam offers. With the worker configured a user's pause of a workflow is a worker control that needs the
// pressing user's own grant, which an MCP tool call does not carry, so the pause tool is not offered (decision M-55 (b)); the
// RoboFlow page's Pause button is the way. For the same reason the start tool is not offered either (decision M-61): an
// internal-token request carries no user grant, so the flows route refuses it before the flow exists; workflows are started
// from the RoboFlow page.
export const WORKER_HIDDEN_TOOLS = Object.freeze(['roboflow_pause_flow', 'roboflow_start_flow']);

export function toolConfigFor(config, { workerMode }) {
    if (!workerMode) return config;
    return { ...config, tools: (Array.isArray(config.tools) ? config.tools : []).filter((tool) => !WORKER_HIDDEN_TOOLS.includes(tool?.name)) };
}

// Whether the worker is configured (ROBOTEAM_WORKER_COORDINATOR_BASE), read where the tool list, the start refusal and the
// catalog need it.
export const workerConfigured = (env = process.env) => String(env.ROBOTEAM_WORKER_COORDINATOR_BASE || '').trim() !== '';
