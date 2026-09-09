import fs from 'node:fs/promises';
import path from 'node:path';
import { RobotStore } from './robot-store.mjs';
import { RobotSkillsets } from './robot-skillsets.mjs';
import { ToolCache } from './tool-cache.mjs';
import { resolveAlaCommand } from './ala-command.mjs';
import { DATA_DIR } from './constants.mjs';

// One CLI process owns one robot context; browser input cannot change its home.
export async function prepareCopilotContext(robotName = 'default', { prepareTools = true, holdUsage = false,
    dataDir = DATA_DIR, alaCommand } = {}) {
    const store = new RobotStore({ dataDir });
    await store.initialize();
    const robot = await store.getByName(robotName);
    if (!robot) throw new Error(`Robot not found: ${robotName}`);
    const releaseUsage = holdUsage ? await store.acquireCliUsage(robot.id) : null;
    try {
        const robotRoot = store.robotPath(robot.id);
        const home = path.join(robotRoot, 'home');
        const stateRoot = path.join(robotRoot, 'copilot');
        for (const directory of [robotRoot, home]) {
            const stat = await fs.lstat(directory);
            if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Unsafe robot home.');
        }
        await fs.mkdir(stateRoot, { recursive: true, mode: 0o700 });
        if ((await fs.lstat(stateRoot)).isSymbolicLink()) throw new Error('Unsafe robot copilot state.');
        process.env.ROBOTEAM_COPILOT_ROOT = await fs.realpath(stateRoot);
        process.env.ROBOTEAM_COPILOT_ROBOT_ID = robot.id;
        process.env.ROBOTEAM_COPILOT_ROBOT_NAME = robot.name;
        process.env.ACHILLES_ALA_HOME = await fs.realpath(home);
        process.env.ACHILLES_ALA_COMMAND = resolveAlaCommand(alaCommand);
        delete process.env.ROBOTEAM_INTERNAL_TOKEN;
        if (prepareTools) {
            // CLI output is consumed as conversation content. Routine cache diagnostics
            // must not enter that channel; preparation failures still propagate below.
            const cache = new ToolCache({ dataDir: store.dataDir,
                log: () => {} });
            const agents = await cache.prepareCodingAgents();
            for (const name of ['codex', 'opencode', 'pi']) {
                process.env[`${name.toUpperCase()}_BIN`] = path.join(agents[name].binPath, name);
            }
            process.env.PATH = [...Object.values(agents).map((agent) => agent.binPath), process.env.PATH || ''].join(path.delimiter);
        }
        const skillsets = new RobotSkillsets({ robotStore: store,
            workspaceRoot: process.env.PLOINKY_WORKSPACE_ROOT || '/workspace', alaCommand: process.env.ACHILLES_ALA_COMMAND });
        return { robot, store, skillsets, releaseUsage };
    } catch (error) {
        await releaseUsage?.();
        throw error;
    }
}
