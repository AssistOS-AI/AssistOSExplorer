import { CODING_AGENT_NAMES } from './coding-agents.mjs';
import { robotCodingAgent } from './robot-models.mjs';

// Which agent a robot uses, and whether it holds a login. Login detection ran ALA against the robot's old home in RoboTeam; ALA now
// runs only in the worker (decision M-5), so until that detection moves to a worker utility execution (T5, decision M-56) every
// login is reported as 'unknown'. Nothing is read from the robot's old home (decision M-10): the agent comes from RoboTeam's record.
export const LOGIN_UNKNOWN = 'unknown';
const UNKNOWN_LOGINS = Object.freeze(Object.fromEntries(CODING_AGENT_NAMES.map(name => [name, LOGIN_UNKNOWN])));

export function createCodingAgentStatus() {
    return {
        // { codex, opencode, pi, claude } each 'unknown' until the worker reports them.
        async logins() { return { ...UNKNOWN_LOGINS }; },
        // The agent for the robot, read from its record exactly as the settings read it (RobotModels.config): the first enabled agent.
        async activeAgent(robot) { return robotCodingAgent(robot); },
    };
}
