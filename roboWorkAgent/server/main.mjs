import { RobotPaths } from './robot-paths.mjs';
import { ToolCache } from './tool-cache.mjs';
import { RuntimeBundle } from './runtime-bundle.mjs';
import { RobotManager } from './robot-manager.mjs';
import { RunManager } from './run-manager.mjs';
import { EnvironmentManager } from './environment.mjs';
import { createHomeOperations } from './home-op.mjs';
import { createSoulGatewayService } from './soul-gateway-service.mjs';
import { createRoboWorkServer } from './http-server.mjs';
import { resolveAlaCommand } from './ala-command.mjs';
import { PUBLIC_BASE_PATH } from './constants.mjs';
import { GuiManager, proxySessionHttp, proxySessionWebSocket } from './gui-manager.mjs';
import { ProxyAgentClient } from './proxy-pool/proxy-client.mjs';

const internalToken = process.env.ROBOWORK_INTERNAL_TOKEN;
if (!internalToken) throw new Error('ROBOWORK_INTERNAL_TOKEN is required');
const paths = new RobotPaths();
const alaEntry = resolveAlaCommand();
const toolCache = new ToolCache();
const soulGateway = createSoulGatewayService();
const homeOperation = createHomeOperations({ paths, alaEntry, toolCache });
const robots = new RobotManager({ paths, toolCache, homeOperation, soulGateway, alaEntry });
await robots.initialize();
const environment = new EnvironmentManager();
const runtimeBundle = new RuntimeBundle({ toolCache, workspaceRoot: paths.workspaceRoot, alaEntry });
const runs = new RunManager({ paths, robots, toolCache, environment, runtimeBundle, alaEntry });
robots.runs = runs;
await runs.initialize();
const gui = new GuiManager({ dataDir: paths.dataDir, workspaceRoot: paths.workspaceRoot, publicBasePath: PUBLIC_BASE_PATH,
    toolCache, homeOps: homeOperation, proxyPool: new ProxyAgentClient(), getRobot: id => robots.require(id),
    prepareRobot: async id => { await robots.require(id); await soulGateway.prepare(paths.soul(id)); },
    hasActiveRun: id => runs.list({ robotId: id }).some(run => ['starting', 'running', 'stopping'].includes(run.state)),
});
robots.gui = gui; runs.gui = gui;
await gui.initialize();
const server = createRoboWorkServer({ robots, runs, environment, gui, internalToken, publicBasePath: PUBLIC_BASE_PATH,
    proxyHttp: proxySessionHttp, proxyWebSocket: proxySessionWebSocket });
server.listen(Number(process.env.ROBOWORK_SERVICE_PORT || 3001), process.env.ROBOWORK_SERVICE_HOST || '0.0.0.0', () => {
    console.log('RoboWork service ready');
});
let closing;
async function close() {
    if (closing) return closing;
    closing = (async () => {
        server.close(); await runs.close(); await gui.shutdown(); await soulGateway.close(); server.closeAllConnections();
    })();
    return closing;
}
process.on('SIGTERM', () => { void close().then(() => process.exit(0), () => process.exit(1)); });
process.on('SIGINT', () => { void close().then(() => process.exit(0), () => process.exit(1)); });
