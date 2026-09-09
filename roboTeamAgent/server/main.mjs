import { createRoboTeamServer } from './http-server.mjs';
import { RobotStore } from './robot-store.mjs';
import { RuntimeManager } from './runtime-manager.mjs';
import { RobotSkillsets } from './robot-skillsets.mjs';
import { DATA_DIR, PUBLIC_BASE_PATH } from './constants.mjs';

const host = process.env.ROBOTEAM_SERVICE_HOST || '0.0.0.0';
const port = Number(process.env.ROBOTEAM_SERVICE_PORT) || 3001;
const dataDir = DATA_DIR;
const internalToken = String(process.env.ROBOTEAM_INTERNAL_TOKEN || '');

if (!internalToken) {
    throw new Error('ROBOTEAM_INTERNAL_TOKEN is required');
}

const publicBasePath = PUBLIC_BASE_PATH;
const robotStore = new RobotStore({ dataDir });
await robotStore.initialize();
await robotStore.ensureDefaultRobot();

const runtimeManager = new RuntimeManager({
    dataDir,
    publicBasePath,
    workspaceRoot: process.env.PLOINKY_WORKSPACE_ROOT || '/workspace',
});
runtimeManager.skillsets = new RobotSkillsets({ robotStore,
    workspaceRoot: process.env.PLOINKY_WORKSPACE_ROOT || '/workspace', alaCommand: runtimeManager.alaCommand });
await runtimeManager.initialize();

const server = createRoboTeamServer({
    robotStore,
    runtimeManager,
    internalToken,
    mcpPort: process.env.ROBOTEAM_MCP_PORT,
    publicBasePath,
    routeKey: process.env.ROBOTEAM_ROUTE_KEY || 'roboTeamAgent',
});

server.listen(port, host, () => {
    console.log(`RoboTeamAgent listening on ${host}:${port}`);
});

let shuttingDown = false;
async function shutdown() {
    if (shuttingDown) return;
    shuttingDown = true;
    server.close();
    await runtimeManager.stopAll();
    process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
