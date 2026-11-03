import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { RunManager } from '../../../../roboWorkAgent/server/run-manager.mjs';
import { RobotPaths } from '../../../../roboWorkAgent/server/robot-paths.mjs';

// A resident RoboWork whose runs start `childEntry` in place of ALA. Run admission, argument construction, output
// records, input, callbacks and stop are RoboWork's own; only the robot registry, the tool cache and the sandbox
// launch are replaced. `robot` supplies the robot's ALA configuration and its installed coding agents. With
// `modelOperation`, model listing runs RoboWork's own model operation against the ALA installation it names.
export async function createRunManagerRoboWork({ workspaceRoot, home, childEntry, robot, modelOperation = null }) {
    // Short, because the channel sockets below it must fit a Unix socket path.
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rw-'));
    const paths = new RobotPaths({ dataDir, workspaceRoot });
    paths.home = () => home;
    const manager = new RunManager({ paths, alaEntry: childEntry,
        robots: { require: async id => ({ id, name: id, codingAgents: ['codex'] }) },
        toolCache: { root: path.join(dataDir, 'tool-cache'), prepareCodingAgents: async () => ({}) },
        // RoboWork runs a robot with a cleared environment: only what it builds for the run reaches the process.
        buildLaunch: async ({ command, args, env }) => ({ command, args,
            options: { detached: true, stdio: ['pipe', 'pipe', 'pipe'], env: { PATH: process.env.PATH, ...env } } }) });
    await manager.initialize();
    const modelScript = fileURLToPath(new URL('../../../../roboWorkAgent/server/model-op.mjs', import.meta.url));
    const listModels = async ({ robotId, agent, cwd }) => {
        const workingDirectory = await paths.grant(cwd, 'cwd');
        const identity = await paths.identity(workingDirectory, 'cwd');
        const input = { alaEntry: modelOperation.alaEntry, agent, cwd: workingDirectory, identity, home,
            soul: modelOperation.soul, dataDir: modelOperation.dataDir, robotId };
        const child = spawn(process.execPath, [modelScript, JSON.stringify(input)], { env: { PATH: process.env.PATH, ...modelOperation.env }, stdio: ['ignore', 'pipe', 'pipe'] });
        let stdout = '';
        child.stdout.on('data', chunk => { stdout += chunk; });
        const code = await new Promise(resolve => child.once('close', resolve));
        // RoboWork reports a failed discovery without the child's own message.
        if (code !== 0) throw Object.assign(new Error('Model discovery failed'), { code: 'MODEL_DISCOVERY_FAILED', statusCode: 500 });
        return { agent, models: JSON.parse(stdout) };
    };
    const operations = {
        ...modelOperation ? { robot_models: listModels } : {},
        robot_config: async () => ({ homeTarget: home, ...await robot.config(), agents: await robot.agents() }),
        run_start: value => manager.start(value), run_read: value => manager.read(value), run_input: value => manager.input(value),
        run_stop: value => manager.stop(value), run_list: value => manager.list(value), run_release: value => manager.release(value),
    };
    return {
        manager, calls: [], starts: [],
        async call(tool, input = {}) {
            this.calls.push(tool);
            if (tool === 'run_start') this.starts.push(structuredClone(input));
            if (!operations[tool]) throw new Error(`RoboWork stand-in does not implement ${tool}`);
            return operations[tool](input);
        },
        async close() {
            await manager.close();
            await fs.rm(dataDir, { recursive: true, force: true });
        },
    };
}
