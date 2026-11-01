import { requireWorkspaceRoot } from './workspace-root.mjs';
import { createRoboTeamServer, readTaskTurnTranscript, webchatTranscriptReader } from './http-server.mjs';
import { RobotStore } from './robot-store.mjs';
import { RuntimeManager } from './runtime-manager.mjs';
import { RobotSkillsets } from './robot-skillsets.mjs';
import { RoboFlowService } from './roboflow/roboflow-service.mjs';
import { DATA_DIR, PUBLIC_BASE_PATH } from './constants.mjs';
import { LiveSessionsRegistry } from './live-sessions/registry.mjs';
import { startLiveSessionsIpc } from './live-sessions/ipc-server.mjs';
import { RuntimeLiveSource, composeTaskObservers } from './live-sessions/runtime-source.mjs';
import { RoboWorkClient } from './run-client.mjs';

const workspaceRoot = requireWorkspaceRoot();
const host = process.env.ROBOTEAM_SERVICE_HOST || '0.0.0.0';
const port = Number(process.env.ROBOTEAM_SERVICE_PORT) || 3001;
const dataDir = DATA_DIR;
const internalToken = String(process.env.ROBOTEAM_INTERNAL_TOKEN || '');

if (!internalToken) {
    throw new Error('ROBOTEAM_INTERNAL_TOKEN is required');
}

const publicBasePath = PUBLIC_BASE_PATH;
const roboWork = new RoboWorkClient({ startupRetry: true });
const robotStore = new RobotStore({ dataDir, roboWork });
await robotStore.initialize();
await robotStore.ensureDefaultRobot();

const runtimeManager = new RuntimeManager({
    dataDir,
    publicBasePath,
    workspaceRoot,
    ownerKey: internalToken,
    robotStore,
    roboWork,
});
runtimeManager.skillsets = new RobotSkillsets({ robotStore,
    workspaceRoot, alaCommand: runtimeManager.alaCommand });
// Shell and socket only: seeding copies thousands of files per robot and runs after the service is listening.
for (const robot of await robotStore.list()) {
    try { await runtimeManager.prepareOpenCode(robot.id, { seed: false }); }
    catch (error) { console.error('[roboTeamAgent] robot preparation failed:', robot.id, error?.code || 'PREPARATION_FAILED'); }
}
await runtimeManager.initialize();
roboWork.finishStartup();

const roboflow = new RoboFlowService({
    robotStore,
    runtimeManager,
    skillsets: runtimeManager.skillsets,
    workspaceRoot,
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
    internalToken,
    mcpPort: process.env.ROBOTEAM_MCP_PORT,
    publicBasePath,
    routeKey: process.env.ROBOTEAM_ROUTE_KEY || 'roboTeamAgent',
    liveSessions,
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
    runtimeManager.resumeAttachedTasks();
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
