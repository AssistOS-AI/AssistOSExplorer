import { requireWorkspaceRoot } from './workspace-root.mjs';
import { createRoboTeamServer, readTaskTurnTranscript, webchatTranscriptReader } from './http-server.mjs';
import { RobotStore } from './robot-store.mjs';
import { RuntimeManager } from './runtime-manager.mjs';
import { RobotSkillsets } from './robot-skillsets.mjs';
import { RoboFlowService } from './roboflow/roboflow-service.mjs';
import { DATA_DIR, PUBLIC_BASE_PATH } from './constants.mjs';
import { ProxyAgentClient } from './proxy-pool/proxy-client.mjs';
import { removeLegacyStorage } from './legacy-storage-cleanup.mjs';
import { LiveSessionsRegistry } from './live-sessions/registry.mjs';
import { startLiveSessionsIpc } from './live-sessions/ipc-server.mjs';
import { RuntimeLiveSource, composeTaskObservers } from './live-sessions/runtime-source.mjs';
import { workerConfigured } from './mcp-tool-list.mjs';
import { createWorkerCoordinatorHop } from './worker-coordinator/hop.mjs';

const workspaceRoot = requireWorkspaceRoot();
const host = process.env.ROBOTEAM_SERVICE_HOST || '0.0.0.0';
const port = Number(process.env.ROBOTEAM_SERVICE_PORT) || 3001;
const dataDir = DATA_DIR;
const internalToken = String(process.env.ROBOTEAM_INTERNAL_TOKEN || '');

if (!internalToken) {
    throw new Error('ROBOTEAM_INTERNAL_TOKEN is required');
}

const publicBasePath = PUBLIC_BASE_PATH;
await removeLegacyStorage({ dataDir, workspaceRoot, log: (line) => console.log(line) });
// With the worker configured the robot HOME is the worker's: RoboTeam writes no old home (decision M-72, no migration).
const robotStore = new RobotStore({ dataDir, writesOldHome: !workerConfigured() });
await robotStore.initialize();
await robotStore.ensureDefaultRobot();

// The shared proxy pool lives in the optional proxyAgent; without it robots connect directly.
const proxyPool = new ProxyAgentClient();

const runtimeManager = new RuntimeManager({
    dataDir,
    publicBasePath,
    workspaceRoot,
    proxyPool,
    ownerKey: internalToken,
});
runtimeManager.skillsets = new RobotSkillsets({ robotStore,
    workspaceRoot, alaCommand: runtimeManager.alaCommand });
await runtimeManager.initialize();
// Shell and socket only: seeding copies thousands of files per robot and runs after the service is listening.
for (const robot of await robotStore.list()) await runtimeManager.prepareOpenCode(robot.id, { seed: false });

const workerCoordinator = { hop: createWorkerCoordinatorHop({ env: process.env }) };
const roboflow = new RoboFlowService({
    robotStore,
    runtimeManager,
    skillsets: runtimeManager.skillsets,
    workspaceRoot,
    workerCoordinator,
});
await roboflow.initialize();

// Live Sessions agent runs. RoboFlow observes runtime events first; the Live
// Sessions source runs after it and is isolated from it.
const liveSessions = new LiveSessionsRegistry({
    agent: process.env.ROBOTEAM_ROUTE_KEY || 'roboTeamAgent',
    urlBase: `/base-agent-additional-server/${process.env.ROBOTEAM_ROUTE_KEY || 'roboTeamAgent'}/${port}`,
});
const liveSource = new RuntimeLiveSource({ registry: liveSessions, runtimeManager, robotStore, roboflow, workspaceRoot,
    readTranscript: readTaskTurnTranscript });
runtimeManager.setTaskObserver(composeTaskObservers((event) => roboflow.onRuntimeTaskEvent(event), [(event) => liveSource.onRuntimeTaskEvent(event)]));

const server = createRoboTeamServer({
    robotStore,
    runtimeManager,
    roboflow,
    proxyPool,
    internalToken,
    mcpPort: process.env.ROBOTEAM_MCP_PORT,
    publicBasePath,
    routeKey: process.env.ROBOTEAM_ROUTE_KEY || 'roboTeamAgent',
    liveSessions,
    // Fails closed per call until the coordinator base and private identity are configured.
    workerCoordinator,
});

// Same-container publishers reach the registry over the private IPC socket.
// An IPC failure leaves HTTP and the in-process source running.
async function startProductionIpc() {
    try {
        return await startLiveSessionsIpc({ registry: liveSessions, readTranscript: webchatTranscriptReader(robotStore, workspaceRoot) });
    } catch (error) {
        console.error(`[live-sessions] IPC listener unavailable; copilot runs are not listed: ${error.code || error.message}`);
        return null;
    }
}

const liveSessionsIpc = await startProductionIpc();

server.listen(port, host, () => {
    console.log(`RoboTeamAgent listening on ${host}:${port}`);
    roboflow.scheduler.start();
    // Downloads must not delay service readiness; requests share this cache's pending preparations.
    void runtimeManager.toolCache.warmup()
        .then(async () => runtimeManager.warmOpenCodePlugins(await robotStore.list()))
        .catch(error => {
            console.error(`[tool-cache] startup preparation failed: ${error.message}`);
        });
});

let shuttingDown = false;
async function shutdown() {
    if (shuttingDown) return;
    shuttingDown = true;
    server.close();
    await roboflow.close();
    await runtimeManager.stopAll();
    await liveSessionsIpc?.close().catch((error) => console.error(`[live-sessions] ${error.message}`));
    liveSessions.close();
    process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
