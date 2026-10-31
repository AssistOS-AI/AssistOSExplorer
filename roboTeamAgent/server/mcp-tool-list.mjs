// The MCP tools RoboTeam offers. With the worker configured a user's pause of a workflow is a worker control that needs the
// pressing user's own grant, which an MCP tool call does not carry, so the pause tool is not offered (decision M-55 (b)); the
// RoboFlow page's Pause button is the way.
export const WORKER_HIDDEN_TOOLS = Object.freeze(['roboflow_pause_flow']);

export function toolConfigFor(config, { workerMode }) {
    if (!workerMode) return config;
    return { ...config, tools: (Array.isArray(config.tools) ? config.tools : []).filter((tool) => !WORKER_HIDDEN_TOOLS.includes(tool?.name)) };
}
