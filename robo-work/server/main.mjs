import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { createCoordinatorAdapter } from './coordinatorAdapter.mjs';
import { createReplayCache, createVerifierConfig } from './coordinatorAuth.mjs';
import { createCoordinatorHttpHandler, createTaskReferenceHttpHandler, createTerminalTargetsHttpHandler } from './providerHttp.mjs';
import { createTaskReferenceAdapter } from './taskReferenceAdapter.mjs';
import { createTerminalTargetsAdapter } from './terminalTargets.mjs';
import { openWorkerState } from './workerState.mjs';
import { createProcView } from './execution/procView.mjs';
import { createWalker } from './execution/recoveryWalk.mjs';
import { createSandboxLauncher } from './sandbox/sandboxLauncher.mjs';
import { createRecoveryView, sandboxRecordFor } from './sandbox/executionSupervisor.mjs';
import { createDispatcher } from './runtime/dispatcher.mjs';
import { createExecutionFactory } from './runtime/executionFactory.mjs';
import { createLifecycleDriver } from './runtime/lifecycleDriver.mjs';
import { runSandboxPreflight } from './runtime/preflight.mjs';
import { createProductionRuntime } from './runtime/productionRuntime.mjs';
import { recoverWorkerGeneration } from './runtime/recovery.mjs';
import { createRobotStore } from './runtime/robotStore.mjs';

// The robo-work worker bootstrap (plan section 11, 12): opens the worker state in the agent's own store, runs generation
// recovery, builds the verifier, the coordinator, task-reference and terminal-target adapters with their HTTP handlers,
// starts the lifecycle driver and the execution dispatcher, and listens on two ports.
//
//   coordinator port (PORT, default 7000)    only `POST /v1/coordinator/...`; the Router forwards RoboTeam's signed hop here
//                                            (manifest executionProvider.coordinatorRoutes), bound on all interfaces because
//                                            the published port must reach it
//   provider port (ROBO_WORK_PROVIDER_PORT, default 7300, loopback)
//                                            `/v1/task-refs/...` (declared taskReferences.path) and `/v1/terminal-control/targets`
//                                            (not declared yet: terminals come in their own landing, decision M-8)
//
// Environment read (all optional unless marked):
//   PLOINKY_AGENT_SECRET (required)   the agent's 64-hex request secret: the key the Router signs every hop token with
//   PLOINKY_AGENT_ID (required)       this agent's principal `agent:<repo>/<agent>`: the token audience
//   PLOINKY_WORKSPACE_ROOT            the shared workspace (mounted at the same path in this container)
//   ROBO_WORK_WORKSPACE_ROOT          overrides PLOINKY_WORKSPACE_ROOT
//   ROBO_WORK_DATA_DIR                the private store, default /var/lib/robo-work
//   ROBO_WORK_WORKSPACE_ID            default `ws-` plus 24 hex of SHA-256(workspace root): stable across restarts
//   ROBO_WORK_ROUTE_KEY               the provider name in task references, default `robo-work`
//   ROBO_WORK_COORDINATORS            comma list of coordinator principals, default `agent:<repo>/roboTeamAgent`
//   PORT, ROBO_WORK_COORDINATOR_HOST, ROBO_WORK_PROVIDER_PORT, ROBO_WORK_PROVIDER_HOST
//   ROBO_WORK_ALA_ROOT                the AdvancedLanguageAgent checkout, default /Agent/linked/AdvancedLanguageAgent
//   ROBO_WORK_MAX_CONCURRENT          concurrent executions, default 4
//   ROBO_WORK_INACTIVITY_TIMEOUT_MS   a task attempt with no activity for this long is ended `failed` / `inactive_timeout`
//                                     (activity: an ALA record or output, a request from ALA to the provider, a prompt or message
//                                     delivered, or workload CPU: every 60 s the workloads of the attempt are sampled read-only from
//                                     /proc, and a new workload process, or CPU growth of the running ones of at least 2 % of one CPU
//                                     since the previous sample, counts as activity), default 1200000 (20 minutes).
//                                     A silent attempt whose workload is also CPU-idle (below 2 %) ends after this bound; a silent but
//                                     busy one stays alive until ROBO_WORK_MAX_ATTEMPT_MS.
//   ROBO_WORK_MAX_ATTEMPT_MS          a task attempt is ended `failed` / `deadline_exceeded` after this long, whatever its activity
//                                     (the 4 h maximum is what bounds a busy loop that CPU activity keeps alive),
//                                     default 14400000 (4 hours)
//                                     Both: an integer from 1000 (one second) to 604800000 (7 days); anything else stops the start.
//                                     They bound task attempts only, run while the attempt is starting or running, and are suspended
//                                     while a human-input question is waiting. The end is the normal stop path; if the stop cannot be
//                                     verified the result is `termination_unverified`. No retry and no replacement attempt.

export const DEFAULT_LIMITS = Object.freeze({
    requestBytes: 4 * 1024 * 1024, robots: 256, receipts: 100000, admissions: 100000, resultBytes: 512 * 1024 - 1024,
    bindings: 10000, controls: 50000, tokenReplayEntries: 200000, obligations: 10000, outboxRevisions: 100000,
    obligationAcceptMs: 24 * 60 * 60 * 1000
});
export const TASK_REFERENCES_PATH = '/v1/task-refs';
export const TERMINALS_PATH = '/v1/terminal-control';
const SERVER_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));

function required(env, name) {
    const value = String(env[name] ?? '').trim();
    if (!value) throw new Error(`${name} is required`);
    return value;
}

function integerPort(value, fallback) {
    const text = String(value ?? '').trim();
    if (!text) return fallback;
    const port = Number(text);
    if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error(`Invalid port: ${text}`);
    return port;
}

function boundedMs(env, name, fallback) {
    const text = String(env[name] ?? '').trim();
    if (!text) return fallback;
    const value = Number(text);
    if (!/^[0-9]+$/u.test(text) || !Number.isSafeInteger(value) || value < 1000 || value > 7 * 24 * 60 * 60 * 1000) {
        throw new Error(`${name} must be an integer from 1000 to 604800000 milliseconds`);
    }
    return value;
}

export function readConfig(env = process.env) {
    const secretHex = required(env, 'PLOINKY_AGENT_SECRET');
    if (!/^[0-9a-f]{64}$/iu.test(secretHex)) throw new Error('PLOINKY_AGENT_SECRET must be 64 hexadecimal characters');
    const audience = required(env, 'PLOINKY_AGENT_ID');
    const match = /^agent:([^\s/:]+)\/[^\s/:]+$/u.exec(audience);
    if (!match) throw new Error('PLOINKY_AGENT_ID must be agent:<repo>/<agent>');
    const workspaceRoot = String(env.ROBO_WORK_WORKSPACE_ROOT || env.PLOINKY_WORKSPACE_ROOT || '').trim().replace(/\/+$/u, '');
    if (!path.isAbsolute(workspaceRoot) || workspaceRoot === '/') throw new Error('The workspace root is not configured');
    const coordinators = String(env.ROBO_WORK_COORDINATORS || '').trim()
        ? String(env.ROBO_WORK_COORDINATORS).split(',').map((entry) => entry.trim()).filter(Boolean)
        : [`agent:${match[1]}/roboTeamAgent`];
    return {
        secret: Buffer.from(secretHex, 'hex'), audience, coordinators, workspaceRoot,
        dataDir: String(env.ROBO_WORK_DATA_DIR || '/var/lib/robo-work').trim(),
        workspaceId: String(env.ROBO_WORK_WORKSPACE_ID || '').trim() || `ws-${crypto.createHash('sha256').update(workspaceRoot).digest('hex').slice(0, 24)}`,
        routeKey: String(env.ROBO_WORK_ROUTE_KEY || 'robo-work').trim(),
        coordinatorPort: integerPort(env.PORT, 7000), coordinatorHost: String(env.ROBO_WORK_COORDINATOR_HOST || '0.0.0.0').trim(),
        providerPort: integerPort(env.ROBO_WORK_PROVIDER_PORT, 7300), providerHost: String(env.ROBO_WORK_PROVIDER_HOST || '127.0.0.1').trim(),
        alaRoot: String(env.ROBO_WORK_ALA_ROOT || '/Agent/linked/AdvancedLanguageAgent').trim(),
        maxConcurrent: integerPort(env.ROBO_WORK_MAX_CONCURRENT, 4),
        inactivityTimeoutMs: boundedMs(env, 'ROBO_WORK_INACTIVITY_TIMEOUT_MS', 20 * 60 * 1000),
        maxAttemptMs: boundedMs(env, 'ROBO_WORK_MAX_ATTEMPT_MS', 4 * 60 * 60 * 1000)
    };
}

function privateDirectory(target) {
    fs.mkdirSync(target, { recursive: true, mode: 0o700 });
    const stat = fs.lstatSync(target);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('A worker directory is not a plain directory');
    fs.chmodSync(target, 0o700);
}

function listen(server, port, host) {
    return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, () => { server.off('error', reject); resolve(server.address().port); });
    });
}

function closeServer(server) {
    return new Promise((resolve) => {
        server.close(() => resolve());
        server.closeIdleConnections?.();
        setTimeout(() => { server.closeAllConnections?.(); }, 2000).unref?.();
    });
}

function alaEntryOf(alaRoot) {
    try {
        const root = fs.realpathSync(alaRoot);
        return fs.statSync(path.join(root, 'bin', 'ala.mjs')).isFile() ? root : null;
    } catch {
        return null;
    }
}

const jsonLog = (event, fields = {}) => {
    try { process.stderr.write(`${JSON.stringify({ at: new Date().toISOString(), event, ...fields })}\n`); } catch { /* stderr closed */ }
};

// Starts the worker. `overrides` are test seams: preflight, recover (async (store) => void), factory, listen ports,
// limits, log, now. A production start passes none.
export async function startWorker({ env = process.env, overrides = {} } = {}) {
    const config = { ...readConfig(env), ...(overrides.config ?? {}) };
    const log = overrides.log ?? jsonLog;
    const limits = overrides.limits ?? DEFAULT_LIMITS;

    for (const name of ['state', 'runtime']) privateDirectory(path.join(config.dataDir, name));
    privateDirectory(path.join(config.dataDir, 'robots'));
    const stateDir = path.join(config.dataDir, 'state');
    const robots = createRobotStore({ root: config.dataDir });

    // ALA must be present, or the runtime refuses preparation and admission instead of accepting work it cannot run.
    const alaRoot = overrides.alaRoot === undefined ? alaEntryOf(config.alaRoot) : overrides.alaRoot;
    let preflight = overrides.preflight ?? runSandboxPreflight();
    if (alaRoot === null && preflight.ok) preflight = Object.freeze({ ...preflight, ok: false, reason: 'ala_missing' });
    const runtime = createProductionRuntime({ preflight, robots });

    const store = openWorkerState({
        dataDir: stateDir, workspaceId: config.workspaceId, provider: config.routeKey, limits, runtime, create: true,
        ...(overrides.now ? { now: overrides.now } : {})
    });

    // Process view, launcher and recovery walker (Linux only; a start on another platform has no execution support).
    const clock = overrides.clock ?? { now: () => Date.now(), sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)) };
    let view = null;
    let launcher = null;
    let walker = null;
    try {
        view = createProcView({ runtimeRoot: path.join(config.dataDir, 'runtime') });
        walker = createWalker({
            view: createRecoveryView(view), clock, releaseDeadlineMs: 15000, pollMs: 100, sandboxRecord: sandboxRecordFor(() => store)
        });
        if (preflight.ok && !overrides.factory) launcher = createSandboxLauncher({ view, procMasks: preflight.masks });
    } catch (error) {
        log('process_view_unavailable', { error: error?.code ?? error?.name });
    }

    // Generation recovery: roll the generation, settle every blocker of the prior one, complete.
    let recovered = false;
    try {
        if (overrides.recover) await overrides.recover(store);
        else if (walker) await recoverWorkerGeneration({ state: store, walker });
        else store.beginGenerationRecovery(store.generationId);
        recovered = !store.getWorkerStatus().recoveryPending;
    } catch (error) {
        log('recovery_incomplete', { error: error?.code ?? error?.name });
    }

    const verifier = createVerifierConfig({
        secret: config.secret, audience: config.audience, coordinators: config.coordinators, replayCache: createReplayCache()
    });
    const httpLimits = { requestBytes: limits.requestBytes };
    // The request line is logged with a refusal (no query, no header) so that an unexpected caller can be identified from the path.
    const onRefusal = ({ route, code, reason, method, path: requestPath }) => log('refusal', { route, code, reason, method, path: requestPath });
    const coordinatorHandler = createCoordinatorHttpHandler({
        adapter: createCoordinatorAdapter({ store, workspaceId: config.workspaceId, verifier }), limits: httpLimits, onRefusal
    });
    const taskReferenceHandler = createTaskReferenceHttpHandler({
        adapter: createTaskReferenceAdapter({ store, workspaceId: config.workspaceId, verifier, basePath: TASK_REFERENCES_PATH }),
        basePath: TASK_REFERENCES_PATH, limits: httpLimits, onRefusal
    });
    const terminalHandler = createTerminalTargetsHttpHandler({
        adapter: createTerminalTargetsAdapter({ store, workspaceId: config.workspaceId, verifier, basePath: TERMINALS_PATH }),
        basePath: TERMINALS_PATH, limits: httpLimits, onRefusal
    });
    const providerHandler = (req, res) => {
        const target = String(req.url || '');
        if (target === TERMINALS_PATH || target.startsWith(`${TERMINALS_PATH}/`)) return terminalHandler(req, res);
        return taskReferenceHandler(req, res);
    };

    const lifecycle = createLifecycleDriver({ store, robots, workspaceId: config.workspaceId, log });
    let factory = overrides.factory ?? null;
    if (factory === null && launcher && alaRoot) {
        factory = createExecutionFactory({
            store, robots, launcher, view, walker, clock, workspaceRoot: config.workspaceRoot, runtimeDir: path.join(config.dataDir, 'runtime'),
            serverDir: SERVER_DIRECTORY, alaRoot, log
        });
    }
    const dispatcher = factory
        ? createDispatcher({ store, workspaceId: config.workspaceId, workspaceRoot: config.workspaceRoot, factory, options: { maxConcurrent: config.maxConcurrent, inactivityTimeoutMs: config.inactivityTimeoutMs, maxAttemptMs: config.maxAttemptMs }, log })
        : null;

    const coordinatorServer = http.createServer(coordinatorHandler);
    const providerServer = http.createServer(providerHandler);
    for (const server of [coordinatorServer, providerServer]) {
        server.requestTimeout = 30000;
        server.headersTimeout = 10000;
        server.keepAliveTimeout = 5000;
    }
    const coordinatorPort = await listen(coordinatorServer, config.coordinatorPort, config.coordinatorHost);
    const providerPort = await listen(providerServer, config.providerPort, config.providerHost);
    lifecycle.start();
    dispatcher?.start();
    log('listening', { coordinatorPort, providerPort, recovered, sandbox: preflight.ok, reason: preflight.reason ?? null });

    let closing = null;
    return Object.freeze({
        coordinatorPort, providerPort, store, config, recovered, preflight, dispatcher, lifecycle,
        // Graceful shutdown: stop accepting, interrupt running attempts through the end path, close the store.
        close() {
            closing ??= (async () => {
                await Promise.allSettled([closeServer(coordinatorServer), closeServer(providerServer)]);
                lifecycle.stop();
                await dispatcher?.close();
                store.close();
            })();
            return closing;
        }
    });
}

async function main() {
    let worker;
    try {
        worker = await startWorker();
    } catch (error) {
        jsonLog('start_failed', { error: error?.code ?? error?.name, message: String(error?.message ?? '').slice(0, 200) });
        process.exit(1);
    }
    const stop = (signal) => {
        jsonLog('stopping', { signal });
        worker.close().then(() => process.exit(0), () => process.exit(1));
        setTimeout(() => process.exit(1), 60000).unref();
    };
    process.once('SIGTERM', () => stop('SIGTERM'));
    process.once('SIGINT', () => stop('SIGINT'));
    process.on('unhandledRejection', (reason) => jsonLog('unhandled_rejection', { error: reason?.code ?? reason?.name }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
