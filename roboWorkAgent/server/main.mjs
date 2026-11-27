import path from 'node:path';
import { createWorkerControl } from './worker-control.mjs';
import { RobotPaths } from './robot-paths.mjs';
import { ToolCache } from './tool-cache.mjs';
import { RuntimeBundle } from './runtime-bundle.mjs';
import { RobotManager } from './robot-manager.mjs';
import { RunManager } from './run-manager.mjs';
import { EnvironmentManager } from './environment.mjs';
import { createHomeOperations } from './home-op.mjs';
import { createSoulGatewayService } from './soul-gateway-service.mjs';
import { createRoboWorkServer } from './http-server.mjs';
import { GitCredentialStore } from './git-credentials.mjs';
import { createGitCredentialSockets } from './git-credential-socket.mjs';
import { listenCsvMailGit } from './csv-mail-git.mjs';
import { resolveAlaCommand } from './ala-command.mjs';
import { DATA_DIR, PUBLIC_BASE_PATH } from './constants.mjs';
import { GuiManager, proxySessionHttp, proxySessionWebSocket } from './gui-manager.mjs';
import { ProxyAgentClient } from './proxy-pool/proxy-client.mjs';
import { createTerminalProfiles } from './terminal-profiles.mjs';
import { refreshImages } from './image-refresh.mjs';
import { createOpenCodeMigration } from './opencode-migration.mjs';

const internalToken = process.env.ROBOWORK_INTERNAL_TOKEN;
if (!internalToken) throw new Error('ROBOWORK_INTERNAL_TOKEN is required');
const paths = new RobotPaths();
const alaEntry = resolveAlaCommand();
const toolCache = new ToolCache();
const soulGateway = createSoulGatewayService();
const rawHomeOperation = createHomeOperations({ paths, alaEntry, toolCache });
const migration = createOpenCodeMigration({ paths, alaEntry, toolCache, homeOperation: rawHomeOperation });
const homeOperation = (id, operation, input) => {
    migration.guard(id);
    return rawHomeOperation(id, operation, input);
};
const gitStore = new GitCredentialStore({ robotsDir: paths.robotsDir });
if (!gitStore.available) console.error('[git-credentials] ROBOWORK_CREDENTIALS_KEY is not configured; robot git credentials are unavailable');
const gitCredentials = { store: gitStore, sockets: createGitCredentialSockets({ store: gitStore }) };
const csvMailGit = await listenCsvMailGit('/csv-mail-git/git.sock', () => gitStore.readWorkspaceToken()).catch(error => {
    console.error(`[csv-mail-git] socket unavailable: ${error.code || 'FAILED'}`);
    return null;
});
const robots = new RobotManager({ paths, toolCache, homeOperation, soulGateway, alaEntry, gitCredentials });
await robots.initialize();
await robots.restoreGitCredentials().catch(error => console.error(`[git-credentials] startup restore failed: ${error.code || 'FAILED'}`));
const environment = new EnvironmentManager();
const runtimeBundle = new RuntimeBundle({ toolCache, workspaceRoot: paths.workspaceRoot, alaEntry });
const runs = new RunManager({ paths, robots, toolCache, environment, runtimeBundle, alaEntry });
robots.runs = runs;
await runs.initialize();
const gui = new GuiManager({ dataDir: paths.dataDir, robotsDir: paths.robotsDir, workspaceRoot: paths.workspaceRoot, publicBasePath: PUBLIC_BASE_PATH,
    toolCache, homeOps: homeOperation, proxyPool: new ProxyAgentClient(), getRobot: id => robots.require(id),
    prepareRobot: async id => { await robots.require(id); await soulGateway.prepare(paths.soul(id)); },
    hasActiveRun: id => runs.list({ robotId: id }).some(run => ['starting', 'running', 'stopping'].includes(run.state)),
});
robots.gui = gui; runs.gui = gui;
await gui.initialize();
robots.migrationGuard = id => migration.guard(id);
robots.migrationStatus = id => migration.status(id);
// Superseded tool generations are collected exactly here: leftover runs are already killed (runs.initialize) and Browser and
// Desktop containers are already removed (gui.initialize), and the container, with its terminals, ends when this service
// exits, so nothing can still use a generation. Only the renames are awaited; deleting the trash happens after listen.
const collection = await toolCache.collectGarbage({ terminalStateDir: path.join(paths.dataDir, 'server-state', 'terminal'),
    legacyNpmCache: path.join(DATA_DIR, '.npm') }).catch(error => {
    console.error(`[tool-cache] garbage collection failed: ${error?.code || 'FAILED'}`);
    return { cleanup: async () => {} };
});
const workerControl = createWorkerControl({ root: path.join(paths.dataDir, 'server-state', 'worker-control') });
const terminal = createTerminalProfiles({ workerControl, paths, robots, toolCache, homeOperation, environment, runtimeBundle });
const migrationReady = migration.start();
const server = createRoboWorkServer({ robots, runs, environment, gui, terminal, internalToken, publicBasePath: PUBLIC_BASE_PATH,
    proxyHttp: proxySessionHttp, proxyWebSocket: proxySessionWebSocket });
server.listen(Number(process.env.ROBOWORK_SERVICE_PORT || 3001), process.env.ROBOWORK_SERVICE_HOST || '0.0.0.0', () => {
    console.log('RoboWork service ready');
    void collection.cleanup().catch(error => console.error(`[tool-cache] trash cleanup failed: ${error?.code || 'FAILED'}`));
    // Downloads must not delay service readiness; requests share pending cache preparations.
    console.log('[runtime-bundle] startup preparation starting');
    void runtimeBundle.warmup().then(() => console.log('[runtime-bundle] startup preparation ready'), error => {
        console.error(`[runtime-bundle] startup preparation failed; will retry on demand: ${error.code || 'BUILD_FAILED'}`);
    });
    // Tagged images are pulled again in the background, so a build published under the same tag reaches robots.
    // GUI images are always refreshed; agent environment images only when already present.
    void (async () => {
        await refreshImages(Object.values(gui.images), { podmanCommand: gui.podmanCommand });
        await environment.refreshImages();
    })().catch(error => console.error(`[image-refresh] startup refresh failed: ${error.code || 'FAILED'}`));
    void migrationReady.then(async () => {
        // RoboTeam can finish startup while migration is running; restore the preparation it deferred.
        for (const { id } of (await robots.status()).robots) {
            if (migration.status(id).state !== 'complete') continue;
            try {
                const record = await robots.require(id);
                await robots.ensure({ robotId: id, name: record.name, codingAgents: record.codingAgents, seed: false });
            } catch (error) {
                console.error(`[robot-preparation] robot=${id} failed: ${error.code || 'FAILED'}`);
            }
        }
        await toolCache.warmup();
    }).catch(error => {
        console.error(`[tool-cache] startup preparation failed: ${error.message}`);
    });
});
let closing;
async function close() {
    if (closing) return closing;
    closing = (async () => {
        csvMailGit?.close();
        csvMailGit?.closeAllConnections();
        server.close(); await workerControl.close(); await runs.close(); await gui.shutdown(); await runtimeBundle.close(); await soulGateway.close(); await gitCredentials.sockets.close(); server.closeAllConnections();
    })();
    return closing;
}
process.on('SIGTERM', () => { void close().then(() => process.exit(0), () => process.exit(1)); });
process.on('SIGINT', () => { void close().then(() => process.exit(0), () => process.exit(1)); });
