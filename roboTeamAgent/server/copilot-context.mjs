import { requireWorkspaceRoot } from './workspace-root.mjs';
import { RobotStore } from './robot-store.mjs';
import { RobotSkillsets } from './robot-skillsets.mjs';
import { resolveAlaCommand } from './ala-command.mjs';
import { DATA_DIR } from './constants.mjs';
import { robotCodingAgents } from './coding-agents.mjs';
import { RoboWorkClient } from './run-client.mjs';

// CLI wrappers own registry/conversation state, never native homes or tools.
export async function prepareCopilotContext(robotName = 'default', { holdUsage = false, seed,
    dataDir = DATA_DIR, alaCommand, roboWork = new RoboWorkClient() } = {}) {
    const workspaceRoot = requireWorkspaceRoot();
    const store = new RobotStore({ dataDir, roboWork });
    await store.initialize();
    const robot = await store.getByName(robotName);
    if (!robot) throw new Error(`Robot not found: ${robotName}`);
    const releaseUsage = holdUsage ? await store.acquireCliUsage(robot.id) : null;
    try {
        await roboWork.call('robot_ensure', { robotId: robot.id, name: robot.name, codingAgents: robotCodingAgents(robot),
            ...(seed === false ? { seed: false } : {}) });
        delete process.env.ROBOTEAM_COPILOT_ROOT;
        process.env.ROBOTEAM_COPILOT_ROBOT_ID = robot.id;
        process.env.ROBOTEAM_COPILOT_ROBOT_NAME = robot.name;
        process.env.ACHILLES_ALA_COMMAND = resolveAlaCommand(alaCommand);
        delete process.env.ACHILLES_ALA_HOME;
        delete process.env.ROBOTEAM_INTERNAL_TOKEN;
        const skillsets = new RobotSkillsets({ robotStore: store, workspaceRoot, alaCommand: process.env.ACHILLES_ALA_COMMAND });
        return { robot: await store.get(robot.id), store, skillsets, releaseUsage };
    } catch (error) {
        await releaseUsage?.();
        throw error;
    }
}
