import { requireWorkspaceRoot } from './workspace-root.mjs';
import { DEFAULT_ROBOT_NAME, RobotStore } from './robot-store.mjs';
import { RobotSkillsets } from './robot-skillsets.mjs';
import { resolveAlaCommand } from './ala-command.mjs';
import { DATA_DIR } from './constants.mjs';
import { robotCodingAgents } from './coding-agents.mjs';
import { RoboWorkClient } from './run-client.mjs';

// CLI wrappers own registry/conversation state, never native homes or tools.
// `selector` is `{ id }`, which every service passes, or `{ name }` (also a bare string) for a person who names the
// robot in a terminal; without one the default robot is used. The name is resolved once, here, and only the id is
// kept: ROBOTEAM_COPILOT_ROBOT_NAME is a display label.
export async function prepareCopilotContext(selector = {}, { holdUsage = false, seed,
    dataDir = DATA_DIR, alaCommand, roboWork = new RoboWorkClient() } = {}) {
    const { id, name } = typeof selector === 'string' ? { name: selector } : (selector || {});
    const workspaceRoot = requireWorkspaceRoot();
    const store = new RobotStore({ dataDir, roboWork });
    await store.initialize();
    const robot = id ? await store.get(id)
        : !name || name === DEFAULT_ROBOT_NAME ? await store.getDefault() : await store.getByName(name);
    if (!robot) throw new Error(`Robot not found: ${id || name || DEFAULT_ROBOT_NAME}`);
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
