import { createRoboTeamServer } from './http-server.mjs';
import { RobotStore } from './robot-store.mjs';
import { RuntimeManager } from './runtime-manager.mjs';

const host = process.env.ROBOTEAM_SERVICE_HOST || '0.0.0.0';
const port = Number(process.env.ROBOTEAM_SERVICE_PORT) || 3001;
const dataDir = process.env.ROBOTEAM_DATA_DIR || '/data';
const internalToken = String(process.env.ROBOTEAM_INTERNAL_TOKEN || '');

if (!internalToken) {
    throw new Error('ROBOTEAM_INTERNAL_TOKEN is required');
}

const publicBasePath = process.env.ROBOTEAM_PUBLIC_BASE_PATH;
const robotStore = new RobotStore({ dataDir });
await robotStore.initialize();

const runtimeManager = new RuntimeManager({
    dataDir,
    publicBasePath,
    maxActive: process.env.ROBOTEAM_MAX_ACTIVE_ROBOTS,
    browserImage: process.env.ROBOTEAM_BROWSER_IMAGE,
    desktopImage: process.env.ROBOTEAM_DESKTOP_IMAGE,
    timezone: process.env.TZ,
});
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
