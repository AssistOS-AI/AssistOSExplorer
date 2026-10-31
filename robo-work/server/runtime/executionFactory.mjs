import fs from 'node:fs';
import path from 'node:path';

import { createExecutionLedger } from '../execution/resourceLedger.mjs';
import { createSupervisorEndpointServer } from '../execution/supervisorEndpointServer.mjs';
import { createAdmission } from '../execution/supervisorRequestValidator.mjs';
import { resolveEndpointLimits } from '../execution/executionLimits.mjs';
import { createExecutionSupervisor } from '../sandbox/executionSupervisor.mjs';
import { WATCHDOG_TICK_MS, createWorkloadActivityWalk } from '../sandbox/workloadActivity.mjs';
import { VIRTUAL_CONFIG, VIRTUAL_SESSIONS } from './alaPlan.mjs';
import { createExecutionChannels } from './channels.mjs';
import { createSourceWatch, grantRoleFor, resolveExecutionGrants } from './executionGrants.mjs';
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

// The grant role of a plan grant (runtime/executionGrants.mjs, the one module that resolves production grants).
export { grantRoleFor };

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
// A skill's descriptor is opened below the skill's own anchored descriptor, never by path: O_NOFOLLOW refuses a symlinked SKILL.md and
// O_NONBLOCK keeps a FIFO of that name from blocking the worker.
const SKILL_FILE_FLAGS = fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK;

// True when the skill folder held open as `fd` has a regular file SKILL.md at its root (anchored open, no link followed).
export function hasRegularSkillFile(fd, { open = (target, flags) => fs.openSync(target, flags), fstat = (handle) => fs.fstatSync(handle), close = (handle) => fs.closeSync(handle) } = {}) {
    let handle;
    try {
        handle = open(`/proc/self/fd/${fd}/SKILL.md`, SKILL_FILE_FLAGS);
        return fstat(handle).isFile();
    } catch {
        return false;
    } finally {
        if (handle !== undefined) { try { close(handle); } catch { /* closed */ } }
    }
}

// The staged name of skill i (bwrapArgs.mjs SKILL_STAGE_NAME): skills are staged like grants, never under a project grant name.
export const skillStageName = (index) => `s${index}`;
const OPT = '/opt/robo-work';
const TOOLS = '/opt/robo-work-tools';
// M-8 robot terminal: the fixed, worker-chosen shell (M-8 SPEC "Sandbox" row). setsid makes a new session and takes the PTY slave
// (stdio 0) as its controlling terminal, so job control and ^C work; --wait keeps the exit status. A login bash reads the robot's own
// HOME profile only (inside the sandbox).
export const TERMINAL_ARGV = Object.freeze(['/usr/bin/setsid', '--ctty', '--wait', '/bin/bash', '-l']);
// /usr/local/sbin first: the image links the coding agents there (into /opt/robo-work-tools), so `command -v codex` works (M-10 logins).
export const TERMINAL_ENV = Object.freeze({ HOME: '/home/robot', TERM: 'xterm-256color', PATH: '/usr/local/sbin:/usr/local/bin:/usr/bin:/bin', LANG: 'C.UTF-8' });
export const TERMINAL_HOME = '/home/robot';

// The virtual name of a terminal's project grant: the selected folder's own name when it is a plain component, else `project`.
export function terminalGrantName(selection) {
    const name = String(selection).split('/').at(-1);
    return /^[A-Za-z0-9][A-Za-z0-9._ -]{0,127}$/u.test(name) && !name.endsWith(' ') ? name : 'project';
}

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

// `runtimeSources` is the active-source provider (executionGrants.mjs createRuntimeSourceProvider, decision M-63): asked once per launch
// that has a writable grant, and on the shared recheck tick while a writable attempt runs. Without it a writable launch is refused
// `runtime_sources_unavailable` (fail closed); a launch without a writable grant does not need it.
export function createExecutionFactory({
    store, robots, launcher, view, walker, clock, workspaceRoot, runtimeDir, serverDir, alaRoot, nodePath = process.execPath,
    log = () => {}, activityTickMs = WATCHDOG_TICK_MS, modelUpstream = null, runtimeSources = null, deps = {}
}) {
    const make = {
        supervisor: deps.createExecutionSupervisor ?? createExecutionSupervisor,
        ledger: deps.createExecutionLedger ?? createExecutionLedger,
        endpointServer: deps.createSupervisorEndpointServer ?? createSupervisorEndpointServer,
        // The whole grant helper (tests over fake paths replace it as a unit; tests of the source rule run the real one).
        executionGrants: deps.resolveExecutionGrants ?? resolveExecutionGrants,
        openDirectory: deps.openDirectory ?? ((target) => fs.openSync(target, DIRECTORY_FLAGS)),
        closeFd: deps.closeFd ?? ((fd) => fs.closeSync(fd)),
        image: deps.imageBinds ?? imageBinds,
        channels: deps.createExecutionChannels ?? createExecutionChannels,
        modelChannel: deps.createModelChannel ?? createModelChannel,
        managedConfig: deps.readManagedConfig ?? readManagedConfig,
        skillFile: deps.hasRegularSkillFile ?? hasRegularSkillFile,
        activityWalk: deps.createWorkloadActivityWalk ?? createWorkloadActivityWalk,
        timers: deps.timers ?? { setInterval, clearInterval }
    };
    const code = codeBinds({ serverDir, alaRoot, nodePath });
    const endpointLimits = resolveEndpointLimits();
    // M-35: ONE /proc walk shared by the activity ticks of every execution of this worker.
    const sharedActivityWalk = typeof view?.listProcesses === 'function' ? make.activityWalk({ view }) : null;
    // M-67 Q2: ONE active-source recheck per worker on the watchdog tick, running only while a writable attempt is registered.
    const sourceWatch = createSourceWatch({ provider: runtimeSources, tickMs: activityTickMs, timers: make.timers, log });
    const grantOptions = { workspaceRoot, workerStore: robots.root, sourceProvider: runtimeSources, log };

    return Object.freeze({
        // M-8 robot terminal. `item` { robotId, executionId, attemptId } of an admitted terminal; `project` null (HOME) or { selection }
        // (a workspace-relative folder, already syntax-checked). HOME is opened exactly as for a workload (robot store, O_NOFOLLOW; it is
        // not a workspace path, so it cannot go through the workspace grant resolver). The project folder is resolved ONLY through
        // resolveExecutionGrants (role `project`, access `write`: the active-source rule M-63 applies, fresh list for this launch) and, while
        // the terminal runs, registered with the factory's source watch (M-67 Q2): a folder that becomes an active source ends the terminal
        // (`revoked`). Refusals throw ExecutionSetupError (grant_<code>, runtime_sources_unavailable, robot_storage_unavailable) with
        // nothing opened or started. Returns { cwd, start({ slave }), exited, revoked, lost, end(outcome) }: start publishes the anchor, the
        // runtime directory, the execution network (the workload firewall) and the terminal process tree, in that order; no endpoint, no
        // ALA and no activity watchdog (the Router's WebTTY limits govern idle time, M-51 Q2).
        async openTerminal({ item, project = null, context, utility = false }) {
            if (utility && project !== null) throw new ExecutionSetupError('utility_project_forbidden');
            const fds = [];
            const grants = [];
            const closeAll = async () => {
                for (const fd of fds.splice(0)) { try { make.closeFd(fd); } catch { /* closed */ } }
                for (const grant of grants.splice(0)) { try { await grant.close(); } catch { /* closed */ } }
            };
            try {
                const where = robots.paths(item.robotId);
                let homeFd;
                try {
                    homeFd = make.openDirectory(where.home);
                    fds.push(homeFd);
                } catch {
                    throw new ExecutionSetupError('robot_storage_unavailable');
                }
                let resolved = [];
                let writeGrants = [];
                let cwd = TERMINAL_HOME;
                if (project !== null) {
                    const projectGrants = await make.executionGrants([{ role: 'project', access: 'write', relativePath: project.selection }], grantOptions);
                    grants.push(...projectGrants);
                    const name = terminalGrantName(project.selection);
                    resolved = [{ name, path: `/projects/${name}`, hostPath: path.join(workspaceRoot, ...project.selection.split('/')), access: 'write', fd: projectGrants[0].fd }];
                    writeGrants = projectGrants.filter((grant) => grant.access === 'write');
                    cwd = `/projects/${name}`;
                }
                const image = make.image();
                const helperBinds = utility ? [...code.roBinds.filter((bind) => bind.dest === `${OPT}/node`), ...code.alaBinds,
                    { source: path.join(serverDir, 'runtime', 'agentStatusHelper.mjs'), dest: `${OPT}/agentStatusHelper.mjs` }] : [];
                const roles = {
                    terminal: {
                        roBinds: [...image.roBinds, ...(image.toolBinds ?? []), ...helperBinds], symlinks: image.symlinks,
                        env: { ...TERMINAL_ENV }, argv: utility ? [code.node, `${OPT}/agentStatusHelper.mjs`] : [...TERMINAL_ARGV],
                    },
                };
                const lost = deferred();
                const supervisor = make.supervisor({
                    launcher, view, roles, home: { path: where.home, fd: homeFd }, grants: resolved, mode: utility ? 'utility' : 'terminal',
                    onInfrastructureLoss: (reason) => lost.resolve(`infrastructure_lost:${reason}`)
                });
                const layout = { runtimeDir, cgroupSubtree: path.join(runtimeDir, 'cgroup') };
                const ledger = make.ledger({
                    state: store, context, robotId: item.robotId, executionId: item.executionId, attemptId: item.attemptId,
                    referenceId: null, layout, sandbox: supervisor, walker, clock
                });
                return buildTerminal({ supervisor, ledger, closeAll, lost, cwd, executionId: item.executionId, writeGrants });
            } catch (error) {
                await closeAll();
                throw error;
            }
        },

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
                const gatewayModel = item.kind === 'utility' ? null : selectGatewayModel({ specification: item.specification, managed: managedConfig });
                const gatewayProvider = selectGatewayProvider({ specification: item.specification, managed: managedConfig });
                // Anchored, no-follow resolution: the resolver refuses protected names, anything outside the workspace and (M-63) a writable
                // grant inside, containing or aliasing an active runtime source; the list is fetched once, only when a grant is writable.
                const projectGrants = await make.executionGrants(plan.grants.map((entry) => ({ role: grantRoleFor(entry), access: entry.access, relativePath: entry.relativePath })), grantOptions);
                grants.push(...projectGrants);
                const resolved = plan.grants.map((entry, index) => ({ name: entry.name, path: entry.path, hostPath: entry.hostPath, access: entry.access, fd: projectGrants[index].fd }));
                // M-22 skills (T2): each admitted skill folder is resolved read-only by the same anchored resolver (a managed source below
                // .ploinky/repos as `skill-source` at depth >= 4, any other as a read-only `project` folder), and must hold a regular SKILL.md
                // at its root. Every refusal fails the attempt with nothing started: a required skill with skill_required_unavailable, any
                // other with its grant code or skill_not_a_skill (fail closed: no skill is silently dropped).
                const skills = [];
                for (const [index, skill] of (plan.skills ?? []).entries()) {
                    // A skill is a read entry, so it never needs the source list (read-only views of an active source stay permitted).
                    const [grant] = await make.executionGrants([{ role: grantRoleFor({ relativePath: skill.relativePath, access: 'read' }), access: 'read', relativePath: skill.relativePath }], {
                        ...grantOptions,
                        onRefused: (_entry, code) => {
                            log('skill_refused', { executionId: item.executionId, skill: skill.name, code: String(code).slice(0, 40), required: skill.required });
                            return skill.required ? 'skill_required_unavailable' : `grant_${String(code).replace(/[^a-z_]/gu, '').slice(0, 40)}`;
                        }
                    });
                    grants.push(grant);
                    if (!make.skillFile(grant.fd)) {
                        log('skill_refused', { executionId: item.executionId, skill: skill.name, code: 'skill_not_a_skill', required: skill.required });
                        throw new ExecutionSetupError(skill.required ? 'skill_required_unavailable' : 'skill_not_a_skill');
                    }
                    skills.push({ name: skill.name, stageName: skillStageName(index), path: skill.hostPath, fd: grant.fd, exclusions: [...(skill.exclusions ?? [])] });
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
                    launcher, view, admission, roles, home: { path: where.home, fd: homeFd }, grants: resolved, skills, activityWalk: sharedActivityWalk,
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
                return buildExecution({ supervisor, ledger, admission, closeAll, lost, channels, activity, gatewayModel, gatewayProvider, executionId: item.executionId, writeGrants: projectGrants.filter((grant) => grant.access === 'write') });
            } catch (error) {
                await closeAll();
                throw error;
            }
        }
    });

    function buildTerminal({ supervisor, ledger, closeAll, lost: lostRef, cwd, executionId, writeGrants }) {
        let ended = null;
        let unwatch = null;
        const exitedControl = deferred();
        exitedControl.promise.catch(() => {});
        const revokedControl = deferred();
        return {
            cwd,
            exited: exitedControl.promise,
            lost: lostRef.promise,
            revoked: revokedControl.promise,
            // `slave`: the PTY slave descriptor the caller holds (it stays the caller's; the spawn duplicates it into stdio 0-2).
            async start({ slave }) {
                if (ended === null && unwatch === null) unwatch = sourceWatch.register({ executionId, grants: writeGrants, onOverlap: (reason) => revokedControl.resolve(reason) });
                await ledger.startKeeper();
                await ledger.publish({ kind: 'runtime-dir' });
                await ledger.publish({ kind: 'netns' });
                const published = await ledger.publish({ kind: 'process-tree', spec: { role: 'terminal', slave, cwd } });
                published.handle.wait().then(({ exitCode, signal }) => exitedControl.resolve({ exitCode, signal }), (error) => exitedControl.reject(error));
                return { stdin: published.handle.stdio?.[0], stdout: published.handle.stdio?.[1], stderr: published.handle.stdio?.[2] };
            },
            // The section 5.5 end path (beginAttemptEnd first), then the local cleanup. Resolves with the ledger's { releaseLog }.
            end(outcome) {
                ended ??= (async () => {
                    if (unwatch !== null) { unwatch(); unwatch = null; }
                    try {
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

    function buildExecution({ supervisor, ledger, admission, closeAll, lost: lostRef, channels, activity, gatewayModel, gatewayProvider, executionId, writeGrants = [] }) {
        let endpointServer = null;
        let hosted = null;
        let model = null;
        let tree = null;
        let ended = null;
        let activityTicker = null;
        let unwatch = null;
        const exitedControl = deferred();
        const exited = exitedControl.promise;
        const revokedControl = deferred();
        return {
            exited,
            lost: lostRef.promise,
            // M-67 Q2: resolves with `source_activated` when a writable grant of this attempt now overlaps an active runtime source; the
            // dispatcher then ends the attempt through its normal stop path.
            revoked: revokedControl.promise,
            // M-43 (a): the last upstream error the model channel saw ({ status, message }), or null.
            lastModelError: () => model?.lastError() ?? null,
            async start() {
                if (ended === null && unwatch === null) unwatch = sourceWatch.register({ executionId, grants: writeGrants, onOverlap: (reason) => revokedControl.resolve(reason) });
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
                    if (unwatch !== null) { unwatch(); unwatch = null; }
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
