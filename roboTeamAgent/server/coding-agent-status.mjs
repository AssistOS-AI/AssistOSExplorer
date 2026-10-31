import { CODING_AGENT_NAMES } from './coding-agents.mjs';
import { robotCodingAgent } from './robot-models.mjs';

// The worker owns login inspection. RoboTeam forwards its bounded projection; unavailable or unbound robots stay unknown.
export const LOGIN_UNKNOWN = 'unknown';
const UNKNOWN_LOGINS = Object.freeze(Object.fromEntries(CODING_AGENT_NAMES.map(name => [name, LOGIN_UNKNOWN])));

export function createCodingAgentStatus({ workerClient = null, robotStore = null } = {}) {
    return {
        // { codex, opencode, pi, claude }: login booleans from the worker, or 'unknown'.
        async logins(robotId) {
            if (!workerClient || !robotStore) return { ...UNKNOWN_LOGINS };
            const robot = await robotStore.get(robotId);
            if (!robot?.worker?.robotId) return { ...UNKNOWN_LOGINS };
            try {
                const result = await workerClient.agentStatus(robot.worker.robotId);
                return Object.fromEntries(CODING_AGENT_NAMES.map((name) => [name, result.agents.find((entry) => entry.name === name)?.loggedIn ?? LOGIN_UNKNOWN]));
            } catch { return { ...UNKNOWN_LOGINS }; }
        },
        // The agent for the robot, read from its record exactly as the settings read it (RobotModels.config): the first enabled agent.
        async activeAgent(robot) { return robotCodingAgent(robot); },
    };
}
