import fs from 'node:fs';
import path from 'node:path';

import { createExecutionLedger } from '../execution/resourceLedger.mjs';
import { createSupervisorEndpointServer } from '../execution/supervisorEndpointServer.mjs';
import { createAdmission } from '../execution/supervisorRequestValidator.mjs';
import { resolveEndpointLimits } from '../execution/executionLimits.mjs';
import { createExecutionSupervisor } from '../sandbox/executionSupervisor.mjs';
import { WATCHDOG_TICK_MS, createWorkloadActivityWalk } from '../sandbox/workloadActivity.mjs';
import { foldPathName } from '../views/protectedNames.mjs';
import { resolveGrant } from '../views/grantResolver.mjs';
import { VIRTUAL_CONFIG, VIRTUAL_SESSIONS } from './alaPlan.mjs';
import { createExecutionChannels } from './channels.mjs';
import {
    MODEL_DIRECTORY_VIEW, MODEL_RELAY_PORT, MODEL_SOCKET_VIEW, OPENCODE_CONFIG_VIEW, createModelChannel, selectGatewayModel, selectGatewayProvider
} from './modelChannel.mjs';
import { ExecutionSetupError } from './setupError.mjs';

// The production execution factory: for one admitted attempt it assembles the per-execution Node supervisor
// (sandbox/executionSupervisor.mjs), the resource ledger (execution/resourceLedger.mjs) and the supervisor side of the
// provider endpoint channel (execution/supervisorEndpointServer.mjs), and exposes them through the dispatcher's
// execution seam (see dispatcher.mjs). The publication order is the plan's: the anchor first, then the runtime directory,
// the execution network, the provider endpoint and last the orchestration domain (ALA).

function deferred() {
    const control = {};
    control.promise = new Promise((resolve, reject) => { control.resolve = resolve; control.reject = reject; });
    return control;
}

// The grant role of a plan grant. A read-only folder under `.ploinky/repos/<repo>/` is a skill source (the resolver's only exemption
// for a managed source, never writable); every other grant, and every writable one (the cwd is always writable), is a project.
export function grantRoleFor(entry) {
    const segments = String(entry.relativePath).split('/');
    const managed = segments.length >= 3 && foldPathName(segments[0]) === '.ploinky' && segments[1] === 'repos';
    return managed && entry.access === 'read' ? 'skill-source' : 'project';
}

// Every request ALA makes to the provider (inventory, tempdir, a workload start or stop) and every workload exit is activity of the attempt
// (M-33). This is the only view of the workloads the worker has without a change to the stream sockets: the bytes a workload writes go to
// ALA through sockets that the endpoint passes on unread, so output as such is seen only through the ALA records it leads to.
export function observed(sandbox, activity) {
    const wrapped = { ...sandbox };
    for (const method of ['inventory', 'tempdir', 'start', 'stop']) {
        if (typeof sandbox[method] === 'function') wrapped[method] = (...args) => { activity(); return sandbox[method](...args); };
    }
    if (typeof sandbox.setExitHandler === 'function') wrapped.setExitHandler = (handler) => sandbox.setExitHandler((...args) => { activity(); return handler(...args); });
    return wrapped;
}

export { ExecutionSetupError };

// The robot's managed ALA configuration (config/ala.json, written by the worker itself and bound read-only into ALA): the coding agent
// and the models ALA will run when the specification names none. Unreadable or malformed means {} (the specification then decides).
export function readManagedConfig(file, { read = (target) => fs.readFileSync(target, 'utf8') } = {}) {
    try {
        const text = read(file);
        if (typeof text !== 'string' || text.length > 64 * 1024) return {};
        const value = JSON.parse(text);
        return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    } catch {
        return {};
    }
}

// The executables of the coding backends that ALA may ask the provider to run (the admission inventory).
export const TOOL_INVENTORY = Object.freeze(['codex', 'claude', 'opencode', 'pi'].map((name) => Object.freeze({ name })));
const STREAM_DIRECTORY = '/stream';
const DIRECTORY_FLAGS = fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW;
const OPT = '/opt/robo-work';
const TOOLS = '/opt/robo-work-tools';

// The read-only image binds shared by every role: /usr and the certificate directories, plus symlinks for the merged-usr
// directories. A system without a merged /usr binds the directories themselves.
export function imageBinds({ exists = (target) => fs.existsSync(target), readlink = (target) => { try { return fs.readlinkSync(target); } catch { return null; } } } = {}) {
    const roBinds = [];
    const symlinks = [];
    for (const dir of ['/usr', '/etc/ssl', '/etc/ca-certificates', '/etc/alternatives']) if (exists(dir)) roBinds.push({ source: dir, dest: dir });
    for (const dir of ['/bin', '/sbin', '/lib', '/lib64']) {
        const link = readlink(dir);
        if (link !== null) symlinks.push({ target: link.startsWith('/') ? link.slice(1) : link, dest: dir });
        else if (exists(dir)) roBinds.push({ source: dir, dest: dir });
    }
    // The image's locked coding-agent tree (/usr/local/sbin/<agent> link into it), bound read-only for workloads only.
    const toolBinds = exists(TOOLS) ? [{ source: TOOLS, dest: TOOLS }] : [];
    return { roBinds, symlinks, toolBinds };
}

// Where Node, ALA and the endpoint code are seen inside the sandboxes. `serverDir` is robo-work/server.
export function codeBinds({ serverDir, alaRoot, nodePath = process.execPath }) {
    const roBinds = [
        { source: path.join(serverDir, 'execution'), dest: `${OPT}/execution` },
        { source: path.join(serverDir, 'sandbox', 'fdTrim.mjs'), dest: `${OPT}/fdTrim.mjs` }
    ];
    let node = nodePath;
    if (!nodePath.startsWith('/usr/')) {
        roBinds.push({ source: path.dirname(path.dirname(nodePath)), dest: `${OPT}/node` });
        node = `${OPT}/node/bin/${path.basename(nodePath)}`;
    }
    return { roBinds, alaBinds: [{ source: alaRoot, dest: `${OPT}/ala` }], node };
}

export function createExecutionFactory({
    store, robots, launcher, view, walker, clock, workspaceRoot, runtimeDir, serverDir, alaRoot, nodePath = process.execPath,
    log = () => {}, activityTickMs = WATCHDOG_TICK_MS, modelUpstream = null, deps = {}
}) {
    const make = {
        supervisor: deps.createExecutionSupervisor ?? createExecutionSupervisor,
        ledger: deps.createExecutionLedger ?? createExecutionLedger,
        endpointServer: deps.createSupervisorEndpointServer ?? createSupervisorEndpointServer,
        grant: deps.resolveGrant ?? resolveGrant,
        openDirectory: deps.openDirectory ?? ((target) => fs.openSync(target, DIRECTORY_FLAGS)),
        closeFd: deps.closeFd ?? ((fd) => fs.closeSync(fd)),
        image: deps.imageBinds ?? imageBinds,
        channels: deps.createExecutionChannels ?? createExecutionChannels,
        modelChannel: deps.createModelChannel ?? createModelChannel,
        managedConfig: deps.readManagedConfig ?? readManagedConfig,
        activityWalk: deps.createWorkloadActivityWalk ?? createWorkloadActivityWalk,
        timers: deps.timers ?? { setInterval, clearInterval }
    };
    const code = codeBinds({ serverDir, alaRoot, nodePath });
    const endpointLimits = resolveEndpointLimits();
    // M-35: ONE /proc walk shared by the activity ticks of every execution of this worker.
    const sharedActivityWalk = typeof view?.listProcesses === 'function' ? make.activityWalk({ view }) : null;

    return Object.freeze({
        async open({ item, plan, context, channels = {}, activity = () => {} }) {
            const fds = [];
            const grants = [];
            const lost = deferred();
            const closeAll = async () => {
                for (const fd of fds.splice(0)) { try { make.closeFd(fd); } catch { /* closed */ } }
                for (const grant of grants.splice(0)) { try { await grant.close(); } catch { /* closed */ } }
            };
            try {
                const where = robots.paths(item.robotId);
                const open = (target) => { const fd = make.openDirectory(target); fds.push(fd); return fd; };
                let homeFd;
                let sessionsFd;
                let configFd;
                try {
                    homeFd = open(where.home);
                    sessionsFd = open(where.sessions);
                    configFd = open(where.configDir);
                } catch {
                    throw new ExecutionSetupError('robot_storage_unavailable');
                }
                // M-26: the one Soul Gateway model this execution may use, or null (no model channel, no OPENCODE_CONFIG).
                const managedConfig = make.managedConfig(where.config);
                const gatewayModel = selectGatewayModel({ specification: item.specification, managed: managedConfig });
                const gatewayProvider = selectGatewayProvider({ specification: item.specification, managed: managedConfig });
                // Anchored, no-follow resolution: the resolver refuses protected names and anything outside the workspace.
                const resolved = [];
                for (const entry of plan.grants) {
                    const result = await make.grant({ role: grantRoleFor(entry), access: entry.access, relativePath: entry.relativePath },
                        { workspaceRoot, protectedLocations: [{ label: 'the worker store', path: robots.root }] });
                    if (!result.ok) throw new ExecutionSetupError(`grant_${String(result.code).replace(/[^a-z_]/gu, '').slice(0, 40)}`);
                    grants.push(result.grant);
                    resolved.push({ name: entry.name, path: entry.path, hostPath: entry.hostPath, access: entry.access, fd: result.grant.fd });
                }
                const admission = createAdmission({
                    grants: plan.grants.map((entry) => ({ path: entry.path, access: entry.access })),
                    inventory: TOOL_INVENTORY, streamDirectory: STREAM_DIRECTORY
                });
                const image = make.image();
                const common = { roBinds: [...image.roBinds, ...code.roBinds], symlinks: image.symlinks, cwd: '/' };
                const roles = {
                    orchestration: {
                        ...common, roBinds: [...common.roBinds, ...code.alaBinds],
                        env: { ...plan.env },
                        argv: [code.node, '--import', `${OPT}/fdTrim.mjs`, `${OPT}/ala/bin/ala.mjs`, ...plan.argv],
                        // Directories are held as { path, fd }: prep re-opens the path inside its private mount namespace and refuses a
                        // different identity (a descriptor cannot be bound across mount namespaces).
                        anchored: [
                            { name: 'session', path: where.sessions, fd: sessionsFd, dest: VIRTUAL_SESSIONS, mode: 'rw' },
                            { name: 'config', path: where.configDir, fd: configFd, dest: path.posix.dirname(VIRTUAL_CONFIG), mode: 'ro' }
                        ]
                    },
                    endpoint: { ...common, env: {}, argv: [code.node, '--import', `${OPT}/fdTrim.mjs`, `${OPT}/execution/providerEndpointMain.mjs`] },
                    workload: { roBinds: [...image.roBinds, ...(image.toolBinds ?? [])], symlinks: image.symlinks }
                };
                const supervisor = make.supervisor({
                    launcher, view, admission, roles, home: { path: where.home, fd: homeFd }, grants: resolved, activityWalk: sharedActivityWalk,
                    modelChannel: gatewayModel === null ? null : { directory: MODEL_DIRECTORY_VIEW, configPath: OPENCODE_CONFIG_VIEW },
                    onInfrastructureLoss: (reason) => lost.resolve(`infrastructure_lost:${reason}`)
                });
                // referenceId stays null: the ledger would read the reference back with the adapter context, which the store (rightly) does
                // not let see an owner's reference (scope and 'read' operation), and the dispatcher does not use that read.
                const layout = { runtimeDir, cgroupSubtree: path.join(runtimeDir, 'cgroup') };
                const ledger = make.ledger({
                    state: store, context, robotId: item.robotId, executionId: item.executionId, attemptId: item.attemptId,
                    referenceId: null, layout, sandbox: supervisor, walker, clock
                });
                return buildExecution({ supervisor, ledger, admission, closeAll, lost, channels, activity, gatewayModel, gatewayProvider, executionId: item.executionId });
            } catch (error) {
                await closeAll();
                throw error;
            }
        }
    });

    function buildExecution({ supervisor, ledger, admission, closeAll, lost: lostRef, channels, activity, gatewayModel, gatewayProvider, executionId }) {
        let endpointServer = null;
        let hosted = null;
        let model = null;
        let tree = null;
        let ended = null;
        let activityTicker = null;
        const exitedControl = deferred();
        const exited = exitedControl.promise;
        return {
            exited,
            lost: lostRef.promise,
            // M-43 (a): the last upstream error the model channel saw ({ status, message }), or null.
            lastModelError: () => model?.lastError() ?? null,
            async start() {
                await ledger.startKeeper();
                await ledger.publish({ kind: 'runtime-dir' });
                // The admitted channels live in the channels directory of the runtime directory (read-only in every workload).
                if (channels.taskFailure || channels.humanInput) {
                    hosted = await make.channels({ directory: `${supervisor.runtimeDir}/channels`, taskFailure: channels.taskFailure ?? null, humanInput: channels.humanInput ?? null });
                }
                // M-26: the Soul Gateway model channel of an OpenCode robot with a gateway model. Its socket is in the `model/` directory,
                // which only the endpoint sandbox sees; the endpoint relays 127.0.0.1:MODEL_RELAY_PORT of the execution network to it.
                if (gatewayModel !== null) {
                    if (modelUpstream === null) throw new ExecutionSetupError('model_channel_unavailable');
                    model = await make.modelChannel({
                        socketDirectory: `${supervisor.runtimeDir}/model`, configDirectory: `${supervisor.runtimeDir}/channels`,
                        allowed: gatewayModel, providerId: gatewayProvider, upstream: modelUpstream, activity, log, executionId
                    });
                }
                await ledger.publish({ kind: 'netns' });
                await ledger.publish({
                    kind: 'endpoint',
                    spec: { config: { streamDirectory: STREAM_DIRECTORY, relays: model === null ? [] : [{ port: MODEL_RELAY_PORT, target: { path: MODEL_SOCKET_VIEW } }] } }
                });
                endpointServer = make.endpointServer({
                    socket: supervisor.endpointSocket, admission, sandbox: observed(supervisor.providerSandbox(ledger), activity), limits: endpointLimits, log,
                    onEnd: (reason) => { if (ended === null) lostRef.resolve(`endpoint_ended:${reason}`); }
                });
                const published = await ledger.publish({ kind: 'process-tree', spec: { role: 'orchestration' } });
                tree = published.handle;
                // M-35: on each watchdog tick a workload that used CPU (or appeared) is activity of the attempt, so a silent but busy
                // attempt is not ended as inactive; an idle one is. The 4 h maximum still bounds a busy loop.
                if (typeof supervisor.workloadActivity === 'function') {
                    activityTicker = make.timers.setInterval(() => { try { if (supervisor.workloadActivity()) activity(); } catch { /* sampling is advisory */ } }, activityTickMs);
                    activityTicker.unref?.();
                }
                tree.wait().then(({ exitCode, signal }) => exitedControl.resolve({ exitCode, signal }), (error) => exitedControl.reject(error));
                return supervisor.controlStreams;
            },
            // The section 5.5 end path (step 1, beginAttemptEnd, is the ledger's first act), then the local cleanup.
            end(outcome) {
                ended ??= (async () => {
                    if (activityTicker !== null) { make.timers.clearInterval(activityTicker); activityTicker = null; }
                    try {
                        endpointServer?.end('execution_ended');
                        // In-flight model requests are aborted, then the channel is closed, before the process trees are ended.
                        await model?.close().catch(() => {});
                        await hosted?.close().catch(() => {});
                        return await ledger.endExecution(outcome);
                    } finally {
                        await supervisor.exit().catch(() => {});
                        await closeAll();
                    }
                })();
                return ended;
            }
        };
    }
}
