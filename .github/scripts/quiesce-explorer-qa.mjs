#!/usr/bin/env node
// Runs inside the exact QA Box selected and verified by the deployment workflow.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

export const SHUTDOWN_TIMEOUT_MS = 35_000;
const WORKSPACE = '/workspace';
const PLOINKY = '/opt/ploinky';
const ID = /^[a-f0-9]{64}$/;
const NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const TOKEN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const WATCHDOG = `${PLOINKY}/cli/server/Watchdog.js`;
const ROUTER = `${PLOINKY}/cli/server/RoutingServer.js`;
const PROVIDER_ORDER = new Map([
    ['webmeetScribeAgent', 20],
    ['webmeetStt', 30],
    ['liveKitServerAgent', 40],
    ['dpuAgent', 50],
    ['soul-gateway', 60],
    ['default-local-llm', 70],
]);

function refuse(code) {
    const error = new Error(code);
    error.code = code;
    throw error;
}

function requireProof(condition, code) {
    if (!condition) refuse(code);
}

function sleepSync(ms) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export function runBounded(command, args, timeout = 5_000, execute = spawnSync) {
    const result = execute(command, args, {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout,
        killSignal: 'SIGTERM',
        maxBuffer: 4 * 1024 * 1024,
    });
    requireProof(!result.error && result.status === 0, 'QA_COMMAND_FAILED');
    return String(result.stdout || '');
}

function parseJson(value, code) {
    try { return JSON.parse(value); } catch { refuse(code); }
}

function registryBindings(registry) {
    requireProof(registry && typeof registry === 'object' && !Array.isArray(registry), 'QA_REGISTRY_INVALID');
    const bindings = [];
    for (const [name, record] of Object.entries(registry)) {
        if (name === '_config') continue;
        requireProof(record?.type === 'agent' && record.runtime === 'podman'
            && NAME.test(name) && NAME.test(record.agentName) && NAME.test(record.repoName)
            && ID.test(record.containerId) && TOKEN.test(record.instanceId)
            && TOKEN.test(record.enableGeneration)
            && (!record.alias || NAME.test(record.alias)), 'QA_REGISTRY_INVALID');
        bindings.push({
            name,
            agent: record.agentName,
            repo: record.repoName,
            id: record.containerId,
            instanceId: record.instanceId,
            generation: record.enableGeneration,
            routeKey: record.alias || record.agentName,
            record,
        });
    }
    requireProof(bindings.length > 0 && new Set(bindings.map((item) => item.id)).size === bindings.length
        && new Set(bindings.map((item) => item.agent)).size === bindings.length, 'QA_REGISTRY_INVALID');
    return bindings.sort((a, b) => a.name.localeCompare(b.name));
}

function bindingIdentity(binding) {
    return JSON.stringify([
        binding.name, binding.agent, binding.repo, binding.id, binding.instanceId,
        binding.generation, binding.routeKey, binding.record.containerImage,
        binding.record.config?.binds, binding.record.profile, binding.record.projectPath,
    ]);
}

function inspectedIdentity(inspected) {
    requireProof(typeof inspected?.State?.Running === 'boolean'
        && typeof inspected.State.StartedAt === 'string' && inspected.State.StartedAt
        && typeof inspected.Image === 'string' && inspected.Image, 'QA_INSPECTION_INVALID');
    requireProof(Array.isArray(inspected.Mounts) && inspected.HostConfig?.Init === true
        && inspected.HostConfig.Privileged === false, 'QA_MOUNT_SECURITY_INVALID');
    return JSON.stringify([inspected.Id, inspected.Name, inspected.Image, inspected.State.StartedAt,
        inspected.Mounts, inspected.HostConfig, inspected.Config]);
}

const DURABLE_AGENTS = new Set(['dpuAgent', 'onlyOffice', 'umamiAgent', 'soul-gateway']);

/** Match the selected registry and manifest before trusting a database shutdown. */
export function assertContainerMounts(binding, inspected, { manifest, realpath = fs.realpathSync } = {}) {
    if (!DURABLE_AGENTS.has(binding.agent)) return '';
    const binds = binding.record.config?.binds;
    requireProof(Array.isArray(binds) && manifest && typeof manifest === 'object', 'QA_MOUNT_CONTRACT_MISSING');
    const expected = new Map();
    const put = (source, target, writable) => {
        requireProof(typeof source === 'string' && path.posix.isAbsolute(source) && path.posix.normalize(source) === source
            && typeof target === 'string' && path.posix.isAbsolute(target) && path.posix.normalize(target) === target
            && !expected.has(target), 'QA_MOUNT_CONTRACT_INVALID');
        expected.set(target, { source, writable });
    };
    for (const bind of binds) put(bind.source, bind.target, bind.ro !== true);
    const dataRoot = `${WORKSPACE}/.data`;
    for (const [source, target] of Object.entries(manifest.volumes || {})) {
        requireProof(source.startsWith('.data/') && !source.split('/').includes('..'), 'QA_DATA_MOUNT_INVALID');
        put(`${WORKSPACE}/${source}`, target, true);
    }
    const persistent = manifest.runtime?.resources?.persistentStorage;
    if (persistent) {
        requireProof(NAME.test(persistent.key), 'QA_DATA_MOUNT_INVALID');
        put(`${dataRoot}/${persistent.key}`, persistent.containerPath, true);
    }
    const requiredData = new Map([['/root', `${dataRoot}/${binding.agent}`], ['/shared', `${dataRoot}/shared`]]);
    if (binding.agent === 'dpuAgent') requiredData.set('/dpu-data', `${dataRoot}/dpu-data`);
    if (binding.agent === 'soul-gateway') requiredData.set('/data', `${dataRoot}/soul-gateway`);
    if (binding.agent === 'onlyOffice') {
        requiredData.set('/var/log/onlyoffice', `${dataRoot}/onlyOffice/log`);
        requiredData.set('/var/www/onlyoffice/Data', `${dataRoot}/onlyOffice/data`);
        requiredData.set('/var/lib/onlyoffice', `${dataRoot}/onlyOffice/lib`);
    }
    for (const [target, source] of requiredData) {
        requireProof(expected.get(target)?.source === source && expected.get(target)?.writable === true, 'QA_DATA_MOUNT_INVALID');
    }
    const actual = new Map();
    for (const mount of inspected.Mounts) {
        requireProof(mount.Type === 'bind' && typeof mount.RW === 'boolean'
            && !actual.has(mount.Destination), 'QA_MOUNT_CONTRACT_INVALID');
        actual.set(mount.Destination, mount);
        const contract = expected.get(mount.Destination);
        if (contract) {
            requireProof(contract.source === mount.Source && contract.writable === mount.RW, 'QA_MOUNT_CONTRACT_CHANGED');
        } else {
            const healthRelay = mount.Destination === '/run/ploinky-health-probes'
                && mount.Source === `${WORKSPACE}/.ploinky/run/health-probes/${binding.name}`;
            requireProof(!mount.RW || healthRelay, 'QA_UNREGISTERED_WRITABLE_MOUNT');
        }
        const dataTarget = [...requiredData.keys()].some((target) => mount.Destination === target
            || mount.Destination.startsWith(`${target}/`));
        if (dataTarget || mount.Source.startsWith(`${dataRoot}/`)) {
            requireProof((!dataTarget || requiredData.has(mount.Destination)) && contract
                && mount.Source.startsWith(`${dataRoot}/`) && realpath(dataRoot) === dataRoot
                && realpath(mount.Source) === mount.Source, 'QA_DATA_MOUNT_INVALID');
        }
    }
    for (const [target, contract] of expected) {
        requireProof(actual.has(target), 'QA_MOUNT_CONTRACT_MISSING');
        if (!contract.writable) requireProof(actual.get(target).RW === false, 'QA_SOURCE_MOUNT_WRITABLE');
    }
    const agentMount = expected.get('/Agent');
    requireProof(agentMount?.source.startsWith(`${WORKSPACE}/.ploinky/container-runtime/${binding.name}/Agent-`)
        && agentMount.writable === false && expected.get('/opt/ploinky-agentlib')?.source === '/opt/ploinky-agentlib'
        && expected.get('/opt/ploinky-agentlib')?.writable === false, 'QA_SOURCE_MOUNT_WRITABLE');
    for (const [target, contract] of expected) {
        if (target.includes('/node_modules') || target.startsWith('/run/ploinky')) {
            requireProof(contract.writable === false, 'QA_SOURCE_MOUNT_WRITABLE');
        }
    }
    return JSON.stringify(manifest);
}

function assertStopped(binding, inspected) {
    const state = inspected.State;
    const allowed = ['onlyOffice', 'soul-gateway'].includes(binding.agent) ? [0] : [0, 143];
    requireProof(state.Running === false && state.OOMKilled === false
        && !state.Error && Number.isInteger(state.ExitCode) && allowed.includes(state.ExitCode), 'QA_UNCLEAN_EXIT');
    return state.ExitCode;
}

async function holdMaintenanceLocks(adapters, bindings, work, index = 0) {
    if (index === bindings.length) return work();
    const binding = bindings[index];
    return adapters.withMaintenanceLock(binding.name, {
        operation: 'qa-backup-quiesce',
        metadata: { agent: binding.agent, repo: binding.repo },
        waitTimeoutMs: 5_000,
    }, () => holdMaintenanceLocks(adapters, bindings, work, index + 1));
}

/** The production orchestration is shared with adapter-driven behavioral tests. */
export async function quiesceExplorerQa(adapters) {
    const receipt = { version: 1, kind: 'qa-quiesce', result: 'failed', phase: 'preflight', stopped: [] };
    try {
        await adapters.withWorkspaceMutationLease({ operation: 'qa-backup-quiesce', waitTimeoutMs: 5_000 }, async () => {
            const bindings = registryBindings(adapters.readRegistry());
            const expectedRegistry = JSON.stringify(bindings.map(bindingIdentity));
            const expectedIds = bindings.map((binding) => binding.id).sort();
            const identities = new Map();
            const mountContracts = new Map();
            const processes = adapters.pinRouter();
            const inspect = (binding) => {
                const current = adapters.inspect(binding.id);
                adapters.assertOwnership(binding, current);
                const mountContract = adapters.assertMounts(binding, current);
                if (mountContracts.has(binding.id)) requireProof(mountContracts.get(binding.id) === mountContract, 'QA_MOUNT_CONTRACT_CHANGED');
                else mountContracts.set(binding.id, mountContract);
                const identity = inspectedIdentity(current);
                if (identities.has(binding.id)) requireProof(identities.get(binding.id) === identity, 'QA_CONTAINER_CHANGED');
                else identities.set(binding.id, identity);
                return current;
            };
            const revalidate = ({ router = true } = {}) => {
                requireProof(JSON.stringify(registryBindings(adapters.readRegistry()).map(bindingIdentity)) === expectedRegistry,
                    'QA_REGISTRY_CHANGED');
                const actualIds = adapters.listContainerIds();
                requireProof(actualIds.every((id) => ID.test(id))
                    && JSON.stringify([...actualIds].sort()) === JSON.stringify(expectedIds), 'QA_UNREGISTERED_CONTAINER');
                for (const binding of bindings) inspect(binding);
                if (router) adapters.assertRouterAlive(processes);
            };
            revalidate();
            await holdMaintenanceLocks(adapters, bindings, () => adapters.withNetworkLifecycleLock(async (capability) => {
                revalidate();
                const onlyOffice = bindings.find((binding) => binding.agent === 'onlyOffice');
                const ordered = [...bindings].sort((a, b) => {
                    const rank = (binding) => binding.agent === 'onlyOffice' ? 0 : PROVIDER_ORDER.get(binding.agent) ?? 10;
                    return rank(a) - rank(b) || a.name.localeCompare(b.name);
                });
                for (const binding of ordered) {
                    receipt.phase = binding.agent === 'onlyOffice' ? 'onlyoffice-drain' : 'agent-stop';
                    revalidate();
                    if (binding === onlyOffice) {
                        const dpu = bindings.find((item) => item.agent === 'dpuAgent');
                        requireProof(dpu && inspect(dpu).State.Running, 'QA_DPU_UNAVAILABLE');
                        const transition = await adapters.prepareTargetedAgentRestart({
                            containerName: binding.name,
                            routeKey: binding.routeKey,
                            repoName: binding.repo,
                            shortAgentName: binding.agent,
                            record: binding.record,
                            networkLifecycleCapability: capability,
                        });
                        revalidate();
                        adapters.drainTargetedContainer(binding.name, {
                            ...transition.targetedRestart,
                            reason: 'qa-backup-quiesce',
                            timeoutMs: SHUTDOWN_TIMEOUT_MS,
                            runtime: 'podman',
                            exists: () => { inspect(binding); return true; },
                            isRunning: () => {
                                adapters.assertRouterAlive(processes);
                                requireProof(inspect(dpu).State.Running, 'QA_DPU_UNAVAILABLE');
                                return inspect(binding).State.Running;
                            },
                            inspect: () => inspect(binding),
                            retireControlSocket: () => {
                                revalidate();
                                adapters.retireRuntimeRelaySocket(binding.name);
                            },
                            signal: () => {
                                revalidate();
                                adapters.signalContainer(binding.id);
                                return { status: 0 };
                            },
                            now: adapters.now,
                            sleep: adapters.sleep,
                        });
                    } else {
                        if (binding.agent === 'umamiAgent') {
                            receipt.phase = 'postgres-shutdown';
                            requireProof(inspect(binding).State.Running, 'QA_POSTGRES_PROOF_UNAVAILABLE');
                            revalidate();
                            requireProof(adapters.shutdownPostgres(binding.id) === 'shut down', 'QA_POSTGRES_UNCLEAN');
                            receipt.phase = 'agent-stop';
                        }
                        revalidate();
                        adapters.retireRuntimeRelaySocket(binding.name);
                        revalidate();
                        if (inspect(binding).State.Running) adapters.signalContainer(binding.id);
                        const deadline = adapters.now() + SHUTDOWN_TIMEOUT_MS;
                        while (inspect(binding).State.Running && adapters.now() < deadline) adapters.sleep(100);
                    }
                    revalidate();
                    const exitCode = assertStopped(binding, inspect(binding));
                    receipt.stopped.push({
                        agent: binding.agent, containerId: binding.id,
                        instanceId: binding.instanceId, enableGeneration: binding.generation, exitCode,
                        ...(binding.agent === 'umamiAgent' ? { postgres: 'shut down' } : {}),
                    });
                }
                receipt.phase = 'router-shutdown';
                revalidate();
                for (const binding of bindings) assertStopped(binding, inspect(binding));
                // Signaling Watchdog itself enables its force-kill timer. Router's
                // clean exit causes Watchdog to exit without that shutdown path.
                adapters.signalRouter(processes);
                const deadline = adapters.now() + SHUTDOWN_TIMEOUT_MS;
                while (!adapters.routerExited(processes) && adapters.now() < deadline) adapters.sleep(100);
                requireProof(adapters.routerExited(processes), 'QA_ROUTER_STOP_TIMEOUT');
                revalidate({ router: false });
                for (const binding of bindings) assertStopped(binding, inspect(binding));
                receipt.router = { routerPid: processes.router.pid, watchdogPid: processes.watchdog.pid, state: 'exited' };
                receipt.phase = 'complete';
                receipt.result = 'passed';
            }, { waitMs: 5_000 }));
        });
        return receipt;
    } catch (error) {
        receipt.result = 'failed';
        receipt.code = /^QA_[A-Z_]+$/.test(error?.code || '') ? error.code : 'QA_QUIESCE_FAILED';
        const failure = new Error(receipt.code);
        failure.code = receipt.code;
        failure.receipt = receipt;
        throw failure;
    }
}

export const POSTGRES_SHUTDOWN_SCRIPT = String.raw`
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const pgdata = process.env.PGDATA || '/root/postgres';
if (pgdata !== '/root/postgres' || fs.realpathSync(pgdata) !== pgdata) process.exit(1);
function run(args, timeout) {
    const result = spawnSync('su-exec', ['postgres', ...args], {
        encoding: 'utf8', timeout, killSignal: 'SIGTERM', maxBuffer: 1024 * 1024,
        stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, LC_ALL: 'C' },
    });
    if (result.error || result.status !== 0) process.exit(1);
    return result.stdout;
}
run(['pg_ctl', '-D', pgdata, '-m', 'fast', '-w', '-t', '35', 'stop'], 36000);
const control = run(['pg_controldata', '-D', pgdata], 5000);
if (!/^Database cluster state:\s+shut down\s*$/m.test(control)) process.exit(1);
process.stdout.write(JSON.stringify({ state: 'shut down' }));
`;

export function readLinuxProcess(pid, fsApi = fs) {
    requireProof(Number.isSafeInteger(pid) && pid > 0, 'QA_PROCESS_INVALID');
    try {
        const stat = fsApi.readFileSync(`/proc/${pid}/stat`, 'utf8');
        const fields = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/);
        if (fields[0] === 'Z' || fields[0] === 'X') return null;
        const argv = fsApi.readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').filter(Boolean);
        const uid = Number(fsApi.readFileSync(`/proc/${pid}/status`, 'utf8').match(/^Uid:\s+(\d+)/m)?.[1]);
        const cwd = fsApi.realpathSync(`/proc/${pid}/cwd`);
        const exe = fsApi.realpathSync(`/proc/${pid}/exe`);
        requireProof(/^\d+$/.test(fields[19]) && Number.isSafeInteger(uid) && argv.length > 0, 'QA_PROCESS_INVALID');
        return { pid, ppid: Number(fields[1]), startTicks: fields[19], uid, cwd, exe, argv };
    } catch (error) {
        if (error.code === 'ENOENT' || error.code === 'ESRCH') return null;
        refuse('QA_PROCESS_UNPROVEN');
    }
}

export function createRouterAdapter({ fsApi = fs, readProcess = readLinuxProcess, signal = process.kill.bind(process), uid = process.getuid() } = {}) {
    const read = (pid) => readProcess(pid, fsApi);
    const same = (current, expected) => JSON.stringify(current) === JSON.stringify(expected);
    const isScript = (item, script) => item && item.uid === uid && item.cwd === WORKSPACE
        && item.argv.length === 2 && item.argv[1] === script && path.basename(item.exe) === 'node';
    const routerProcesses = () => fsApi.readdirSync('/proc').filter((name) => /^\d+$/.test(name))
        .filter((name) => {
            try {
                return [WATCHDOG, ROUTER].includes(fsApi.readFileSync(`/proc/${name}/cmdline`, 'utf8').split('\0')[1]);
            } catch (error) {
                if (error.code === 'ENOENT' || error.code === 'ESRCH') return false;
                refuse('QA_PROCESS_UNPROVEN');
            }
        }).map((name) => read(Number(name))).filter(Boolean);
    return {
        pinRouter() {
            const init = read(1);
            requireProof(init?.exe === '/run/podman-init' && init.uid === uid && init.cwd === WORKSPACE
                && JSON.stringify(init.argv) === JSON.stringify(['/run/podman-init', '--', '/usr/local/bin/ploinky-box-entrypoint']),
            'QA_BOX_SUPERVISOR_UNPROVEN');
            // The deployed Box uses Podman's init shim. Its original child is
            // the entrypoint's exec sleep, while adopted nested-runtime helpers
            // are also children of init and are not supervisors.
            const childPids = fsApi.readFileSync('/proc/1/task/1/children', 'utf8').trim().split(/\s+/).filter(Boolean).map(Number);
            const idle = childPids.map((pid) => {
                try {
                    const argv = fsApi.readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').filter(Boolean);
                    return argv.length === 2 && argv[0] === 'sleep' && argv[1] === 'infinity' ? read(pid) : null;
                } catch (error) {
                    if (error.code === 'ENOENT' || error.code === 'ESRCH') return null;
                    refuse('QA_PROCESS_UNPROVEN');
                }
            }).filter(Boolean);
            requireProof(idle.length === 1 && idle[0].ppid === 1 && idle[0].uid === uid && idle[0].cwd === WORKSPACE
                && idle[0].exe === '/usr/bin/sleep', 'QA_BOX_SUPERVISOR_UNPROVEN');
            const pid = Number(fsApi.readFileSync(`${WORKSPACE}/.ploinky/running/router.pid`, 'utf8').trim());
            const watchdog = read(pid);
            requireProof(isScript(watchdog, WATCHDOG), 'QA_WATCHDOG_UNPROVEN');
            const candidates = routerProcesses();
            const router = candidates.find((item) => isScript(item, ROUTER) && item.ppid === pid);
            requireProof(router && candidates.length === 2, 'QA_ROUTER_UNPROVEN');
            return { watchdog, router, init, idle: idle[0] };
        },
        assertRouterAlive(pinned) {
            requireProof(same(read(1), pinned.init) && same(read(pinned.idle.pid), pinned.idle) && same(read(pinned.watchdog.pid), pinned.watchdog)
                && same(read(pinned.router.pid), pinned.router) && routerProcesses().length === 2, 'QA_ROUTER_CHANGED');
        },
        signalRouter(pinned) {
            this.assertRouterAlive(pinned);
            signal(pinned.router.pid, 'SIGTERM');
        },
        routerExited(pinned) {
            requireProof(same(read(1), pinned.init) && same(read(pinned.idle.pid), pinned.idle), 'QA_BOX_SUPERVISOR_CHANGED');
            for (const expected of [pinned.router, pinned.watchdog]) {
                const current = read(expected.pid);
                requireProof(!current || same(current, expected), 'QA_ROUTER_CHANGED');
            }
            const remaining = routerProcesses();
            requireProof(remaining.every((current) => [pinned.router, pinned.watchdog].some((item) => same(current, item))),
                'QA_ROUTER_CHANGED');
            return !read(pinned.router.pid) && !read(pinned.watchdog.pid) && remaining.length === 0;
        },
    };
}

export async function createProductionAdapters() {
    requireProof(process.platform === 'linux' && process.getuid() === 1000
        && process.env.PLOINKY_WORKSPACE_ROOT === WORKSPACE && fs.realpathSync(WORKSPACE) === WORKSPACE,
    'QA_WORKSPACE_INVALID');
    process.chdir(WORKSPACE);
    const load = (relative) => import(`${PLOINKY}/${relative}`);
    let modules;
    try {
        modules = await Promise.all([
            load('cli/utils/runtime/maintenanceLocks.js'),
            load('cli/sandbox/networkLifecycle.js'),
            load('cli/utils/agentRegistrySnapshot.js'),
            load('cli/sandbox/docker/containerOwnership.js'),
            load('cli/sandbox/networkIdentity.js'),
            load('cli/commands/targetedAgentRestart.js'),
            load('cli/sandbox/docker/targetedContainerLifecycle.js'),
            load('cli/sandbox/docker/healthProbes.js'),
        ]);
    } catch { refuse('QA_PLOINKY_APIS_UNAVAILABLE'); }
    const [locks, network, registry, ownership, identity, restart, drain, probes] = modules;
    const required = {
        withWorkspaceMutationLease: locks.withWorkspaceMutationLease,
        withMaintenanceLock: locks.withMaintenanceLock,
        withNetworkLifecycleLock: network.withNetworkLifecycleLock,
        prepareTargetedAgentRestart: restart.prepareTargetedAgentRestart,
        drainTargetedContainer: drain.drainTargetedContainer,
        retireRuntimeRelaySocket: probes.retireRuntimeRelaySocket,
    };
    requireProof(Object.values(required).every((value) => typeof value === 'function')
        && typeof registry.readAgentRegistrySnapshot === 'function'
        && typeof ownership.assertExactContainerOwnership === 'function'
        && typeof identity.workspaceNetworkIdentity === 'function', 'QA_PLOINKY_APIS_UNAVAILABLE');
    const workspaceHash = identity.workspaceNetworkIdentity(WORKSPACE).hash;
    runBounded('podman', ['version', '--format', '{{.Client.Version}}']);
    return {
        ...required,
        ...createRouterAdapter(),
        now: () => Date.now(),
        sleep: sleepSync,
        readRegistry: () => registry.readAgentRegistrySnapshot({ workspaceRoot: WORKSPACE }),
        listContainerIds: () => runBounded('podman', ['container', 'ls', '--all', '--quiet', '--no-trunc']).trim().split(/\s+/).filter(Boolean),
        inspect: (id) => {
            const records = parseJson(runBounded('podman', ['container', 'inspect', id]), 'QA_INSPECTION_INVALID');
            requireProof(Array.isArray(records) && records.length === 1, 'QA_INSPECTION_INVALID');
            return records[0];
        },
        assertOwnership: (binding, inspected) => ownership.assertExactContainerOwnership(
            binding.name, binding.record, inspected, binding.id, workspaceHash,
        ),
        assertMounts: (binding, inspected) => assertContainerMounts(binding, inspected, {
            manifest: DURABLE_AGENTS.has(binding.agent) ? parseJson(fs.readFileSync(
                `${WORKSPACE}/.ploinky/repos/${binding.repo}/${binding.agent}/manifest.json`, 'utf8',
            ), 'QA_MOUNT_CONTRACT_INVALID') : null,
        }),
        signalContainer: (id) => runBounded('podman', ['container', 'kill', '--signal', 'SIGTERM', id]),
        shutdownPostgres: (id) => {
            const proof = parseJson(runBounded('podman', [
                'container', 'exec', '--user', 'root', id, 'node', '-e', POSTGRES_SHUTDOWN_SCRIPT,
            ], 42_000), 'QA_POSTGRES_UNCLEAN');
            return proof?.state;
        },
    };
}

export async function main() {
    // Ploinky internals can log workspace configuration. The external contract is
    // exactly one sanitized receipt, including when an imported API fails.
    const originalConsole = new Map(['log', 'info', 'warn', 'error', 'debug'].map((key) => [key, console[key]]));
    for (const key of originalConsole.keys()) console[key] = () => {};
    let receipt;
    try {
        receipt = await quiesceExplorerQa(await createProductionAdapters());
    } catch (error) {
        receipt = error.receipt || { version: 1, kind: 'qa-quiesce', result: 'failed', phase: 'prerequisites',
            code: /^QA_[A-Z_]+$/.test(error?.code || '') ? error.code : 'QA_PREREQUISITE_FAILED', stopped: [] };
        process.exitCode = 1;
    } finally {
        for (const [key, value] of originalConsole) console[key] = value;
    }
    process.stdout.write(`${JSON.stringify(receipt)}\n`);
}

if (process.argv[1] === '-' || (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))) await main();
