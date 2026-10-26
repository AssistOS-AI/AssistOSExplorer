import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRoboTeamServer } from '../../server/http-server.mjs';

// RoboTeam HTTP server over a stub robot store and runtime, for Live Sessions
// route tests. It needs no /proc, so it runs on every platform.
export const TOKEN = 'live-sessions-token';
export const CONTAINER_SENTINEL = 'CONTAINER-LOG-SENTINEL-7f3c';

function stubRobotStore(dataDir, robots = []) {
    return {
        dataDir,
        list: async () => robots,
        get: async (id) => robots.find((robot) => robot.id === id) || null,
        getByName: async (name) => robots.find((robot) => robot.name === name) || null,
        robotPath: (id) => path.join(dataDir, 'robots', id),
    };
}

export async function startHttpFixture(t, { liveSessions, robots = [], roboflow = null, calls = {}, streamLifetimeMs } = {}) {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'live-sessions-http-')));
    const workspaceRoot = path.join(root, 'workspace');
    await fs.mkdir(workspaceRoot, { recursive: true });
    const robotStore = stubRobotStore(path.join(root, 'data'), robots);
    calls.startTask ||= [];
    calls.resumeTask ||= [];
    const runtimeManager = {
        workspaceRoot,
        skillsets: { start: async (robot, body, start) => start(robot, { policyId: 'policy' }) },
        status: () => ({ state: 'stopped' }),
        activePort: () => null,
        hasUnfinishedTasks: () => false,
        taskStatus: () => null,
        startTask(robot, type, request) { calls.startTask.push({ type, request }); return { taskId: 'task-1', state: 'queued' }; },
        resumeTask(robot, taskId, prompt, ...rest) { calls.resumeTask.push({ taskId, prompt, rest }); return { taskId: 'task-2', state: 'queued' }; },
        logs: async () => { calls.containerLogs = (calls.containerLogs || 0) + 1; return CONTAINER_SENTINEL; },
    };
    const server = createRoboTeamServer({ robotStore, runtimeManager, roboflow, internalToken: TOKEN, publicBasePath: '/rt/', mcpPort: 65534,
        liveSessions, liveSessionsStreamLifetimeMs: streamLifetimeMs });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    t.after(async () => {
        server.closeAllConnections?.();
        await new Promise((resolve) => server.close(resolve));
        await fs.rm(root, { recursive: true, force: true });
    });
    return { baseUrl, root, workspaceRoot };
}
