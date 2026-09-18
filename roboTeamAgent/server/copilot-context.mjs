import { requireWorkspaceRoot } from './workspace-root.mjs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { RobotStore } from './robot-store.mjs';
import { RobotSkillsets } from './robot-skillsets.mjs';
import { ToolCache } from './tool-cache.mjs';
import { resolveAlaCommand } from './ala-command.mjs';
import { prepareRobotShell } from './robot-shell.mjs';
import { DATA_DIR } from './constants.mjs';
import { robotCodingAgents, codingAgentEnvironment } from './coding-agents.mjs';

// One CLI process owns one robot context; browser input cannot change its home.
export async function prepareCopilotContext(robotName = 'default', { prepareTools = true, holdUsage = false,
    dataDir = DATA_DIR, alaCommand, toolCache } = {}) {
    const workspaceRoot = requireWorkspaceRoot();
    const store = new RobotStore({ dataDir });
    await store.initialize();
    const robot = await store.getByName(robotName);
    if (!robot) throw new Error(`Robot not found: ${robotName}`);
    const releaseUsage = holdUsage ? await store.acquireCliUsage(robot.id) : null;
    try {
        const robotRoot = store.robotPath(robot.id);
        const home = path.join(robotRoot, 'home');
        for (const directory of [robotRoot, home]) {
            const stat = await fs.lstat(directory);
            if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Unsafe robot home.');
        }
        delete process.env.ROBOTEAM_COPILOT_ROOT;
        process.env.ROBOTEAM_COPILOT_ROBOT_ID = robot.id;
        process.env.ROBOTEAM_COPILOT_ROBOT_NAME = robot.name;
        process.env.ACHILLES_ALA_HOME = await fs.realpath(home);
        await prepareRobotShell(home);
        process.env.ACHILLES_ALA_COMMAND = resolveAlaCommand(alaCommand);
        if (process.env.PLOINKY_AGENTLIB_DIR) {
            process.env.ACHILLES_AGENT_LIB_PATH = process.env.PLOINKY_AGENTLIB_DIR;
        }
        delete process.env.ROBOTEAM_INTERNAL_TOKEN;
        if (prepareTools) {
            // CLI output is consumed as conversation content. Routine cache diagnostics
            // must not enter that channel; preparation failures still propagate below.
            const cache = toolCache || new ToolCache({ dataDir: store.dataDir,
                log: () => {} });
            const codingAgents = robotCodingAgents(robot);
            const tools = await cache.prepareShellTools(codingAgents);
            const environment = codingAgentEnvironment(tools.agents, process.env, cache.root);
            for (const name of ['CODEX_BIN', 'OPENCODE_BIN', 'PI_BIN']) delete process.env[name];
            Object.assign(process.env, environment);
            await prepareRobotShell(home, { codingAgents, binPath: tools.binPath, cacheRoot: cache.root });
        }
        const skillsets = new RobotSkillsets({ robotStore: store,
            workspaceRoot, alaCommand: process.env.ACHILLES_ALA_COMMAND });
        return { robot, store, skillsets, releaseUsage };
    } catch (error) {
        await releaseUsage?.();
        throw error;
    }
}
