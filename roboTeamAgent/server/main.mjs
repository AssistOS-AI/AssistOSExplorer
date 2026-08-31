import { DesktopManager } from './desktop-manager.mjs';
import { createRoboTeamServer } from './http-server.mjs';
import { ProfileStore } from './profile-store.mjs';

const host = process.env.ROBOTEAM_SERVICE_HOST || '0.0.0.0';
const port = Number(process.env.ROBOTEAM_SERVICE_PORT || process.env.PORT) || 7000;
const dataDir = process.env.ROBOTEAM_DATA_DIR || '/data';
const internalToken = String(process.env.ROBOTEAM_INTERNAL_TOKEN || '');

if (!internalToken) {
    throw new Error('ROBOTEAM_INTERNAL_TOKEN is required');
}

const profileStore = new ProfileStore({ dataDir });
await profileStore.initialize();

const desktopManager = new DesktopManager({
    dataDir,
    maxActive: process.env.ROBOTEAM_MAX_ACTIVE_DESKTOPS,
});

const server = createRoboTeamServer({
    profileStore,
    desktopManager,
    internalToken,
    mcpPort: process.env.ROBOTEAM_MCP_PORT,
    publicBasePath: process.env.ROBOTEAM_PUBLIC_BASE_PATH,
    routeKey: process.env.ROBOTEAM_ROUTE_KEY || 'roboTeamAgent',
    noVncRoot: process.env.ROBOTEAM_NOVNC_ROOT || '/usr/share/novnc',
});

server.listen(port, host, () => {
    console.log(`RoboTeamAgent listening on ${host}:${port}`);
});

let shuttingDown = false;
async function shutdown() {
    if (shuttingDown) return;
    shuttingDown = true;
    server.close();
    await desktopManager.stopAll();
    process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
