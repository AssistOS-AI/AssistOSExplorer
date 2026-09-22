import { requireWorkspaceRoot } from './workspace-root.mjs';
import { createRoboTeamServer } from './http-server.mjs';
import { RobotStore } from './robot-store.mjs';
import { RuntimeManager } from './runtime-manager.mjs';
import { RobotSkillsets } from './robot-skillsets.mjs';
import { RoboFlowService } from './roboflow/roboflow-service.mjs';
import { ensureDefaultWorkflow } from './roboflow/default-workflow.mjs';
import { DECISION_MCP_NAME } from './roboflow/constants.mjs';
import { DATA_DIR, PUBLIC_BASE_PATH } from './constants.mjs';

const workspaceRoot = requireWorkspaceRoot();
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
    workspaceRoot,
});
runtimeManager.skillsets = new RobotSkillsets({ robotStore,
    workspaceRoot, alaCommand: runtimeManager.alaCommand });
await runtimeManager.initialize();
for (const robot of await robotStore.list()) await runtimeManager.prepareOpenCode(robot.id);

// The decision robot receives the RoboTeam MCP capability natively. This is an
// internal injection, not a skill or skillset.
const mcpPort = Number(process.env.ROBOTEAM_MCP_PORT) || 7000;
const decisionMcpServers = String(process.env.ROBOTEAM_DECISION_MCP_SERVERS
    || `${DECISION_MCP_NAME}=http://127.0.0.1:${mcpPort}/mcp`);

const roboflow = new RoboFlowService({
    robotStore,
    runtimeManager,
    skillsets: runtimeManager.skillsets,
    decisionMcpServers,
    workspaceRoot,
});
await roboflow.initialize();
await ensureDefaultWorkflow(roboflow.registry);
runtimeManager.setTaskObserver((event) => roboflow.onRuntimeTaskEvent(event));

const server = createRoboTeamServer({
    robotStore,
    runtimeManager,
    roboflow,
    internalToken,
    mcpPort: process.env.ROBOTEAM_MCP_PORT,
    publicBasePath,
    routeKey: process.env.ROBOTEAM_ROUTE_KEY || 'roboTeamAgent',
});

server.listen(port, host, () => {
    console.log(`RoboTeamAgent listening on ${host}:${port}`);
    // Downloads must not delay service readiness; requests share this cache's pending preparations.
    void runtimeManager.toolCache.warmup().catch(error => {
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
    process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
