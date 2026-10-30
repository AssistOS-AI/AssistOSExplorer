// The per-execution Node supervisor (plan Revision 10, sections B, E and G). One object implements BOTH existing seams on
// top of the sandbox launcher and the execution network:
//
//   ledger seam (resourceLedger.mjs `sandbox` parameter)
//     create({ kind, resourceId, marker, locator, spec }) -> { identity, gate: { commit(), abort() } | null, handle }
//     alive(), abortUncommitted(ids), endProcessTrees(), endEndpoint(), releaseEgress(), releaseViews(), removeRuntime(), exit()
//   endpoint seam (supervisorEndpointServer.mjs `sandbox` parameter), built per ledger by providerSandbox(ledger):
//     inventory(), tempdir(), start({ process, request, streams }), stop({ process, graceMs }), setExitHandler(fn)
//   plus endpointSocket and controlStreams (the supervisor's ends of the endpoint frame channel and ALA's stdio),
//   diagnostics stats(), and the recovery helpers sandboxRecordFor, createRecoveryView, findMarkerProcesses,
//   findNamespaceMembers.
//
// Resource kinds handled by create():
//   'keeper'        the execution's ANCHOR (deviation, needs the lead's confirmation): the ledger still publishes the first
//                   resource as kind 'keeper' and proves it absent by pid + start time. There is no keeper process any more,
//                   so the anchor is a tiny gated holder (`setpriv --pdeathsig KILL -- sh -c 'read; exec sleep'` with the
//                   marker as an argv element). exit() kills it. It dies with the worker, so an uncommitted dependent can be
//                   proven absent after a crash exactly as before. Identity { pid, startTime }.
//   'runtime-dir'   <runtimeDir>/x/<id> with channels, stream, tmp, ctl and stage below it. Identity { path, dev, ino }.
//   'netns'         the whole execution network (netns, veth, /30, nft table), all named from the netns locator id
//                   (executionNetwork.mjs namesFor). Identity { netNs, name, host, peer, table, subnet }. 'veth' and
//                   'nft-table' reservations, if a ledger publishes them, are accepted as no-ops (nothing exists under
//                   their own names; recovery removes everything through the netns locator, see createRecoveryView).
//   'mount'         accepted as a no-op record (see create()).
//   'endpoint'      the provider endpoint sandbox (role endpoint). Gated. spec { config } is its one JSON argument.
//                   With `modelChannel` ({ directory, configPath }, M-26) the execution's `model/` directory is bound read-only at
//                   `modelChannel.directory` into THIS sandbox ONLY (never into ALA or a workload): the endpoint's relay reaches the model
//                   socket there, and nothing else can.
//   'process-tree'  spec.role 'orchestration' (ALA) or 'workload' (one provider request). Gated.
//
// Directories (HOME, grants, session storage) are given as { path, fd }: the real path and the caller's open descriptor of it
// (grantResolver.mjs). The descriptor only supplies the device and inode; the sandbox's prep stage re-opens the path inside its
// own mount namespace and refuses a different identity (a descriptor cannot be bound across mount namespaces).
//
// Custody: nothing is committed on a sandbox's word; the launcher reads the identity from /proc. A creation that fails or
// is abandoned before commit is aborted through its gate (SIGKILL, then the gate closes), and abortUncommitted is only a request.
// Release order is the ledger's (section 5.5): process trees, endpoint, egress, views, runtime directory, anchor.

import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import { spawn, spawnSync } from 'node:child_process';

import { createExecutionNetwork, namesFor, renderHosts, renderResolvConf } from './executionNetwork.mjs';
import { mapVirtualExclusions } from './exclusions.mjs';
import { createActivityMeter, createWorkloadActivityWalk } from './workloadActivity.mjs';
import { SandboxError, sandboxError } from './sandboxErrors.mjs';

const ANCHOR_KINDS = new Set(['keeper', 'supervisor', 'sandbox']);
const STREAM_BASENAME = /^[a-z0-9]{8,64}$/u;
const TOOL_PATH = '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin';
const WORKLOAD_PATH = '/usr/local/bin:/usr/bin:/bin';
// The anchor script is fixed text; the marker arrives as $1 so that it is a literal argv element of the shell.
const ANCHOR_SCRIPT = 'IFS= read -r _ || exit 0; exec sleep 2147483647';

const defer = () => { const d = {}; d.promise = new Promise((resolve, reject) => { d.resolve = resolve; d.reject = reject; }); return d; };
const decimal = (value) => String(value);

export function createExecutionSupervisor({
    launcher, view, createNetwork = createExecutionNetwork, spawnImpl = spawn, fsImpl = fs, netImpl = net, clock = { now: () => Date.now(), sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)) },
    admission, roles, home = null, grants = [], workloadPath = WORKLOAD_PATH, onInfrastructureLoss = () => {}, modelChannel = null,
    limits = {}, supervisorPid = process.pid, pairSocketPathLimit = 100, activityWalk = null, now = Date.now
} = {}) {
    if (!launcher || typeof launcher.launch !== 'function') throw new TypeError('A launcher is required');
    if (!view || typeof view.process !== 'function') throw new TypeError('A procView is required');
    if (!admission || !Array.isArray(admission.inventory) || typeof admission.streamDirectory !== 'string') throw new TypeError('An admission is required');
    if (!roles?.orchestration || !roles?.endpoint || !roles?.workload) throw new TypeError('roles.orchestration, roles.endpoint and roles.workload are required');
    const stopGraceMs = limits.stopGraceMs ?? 2000;
    // M-35: the walk is shared by every execution of the worker (pass the same one to each supervisor); the meter is this execution's.
    const meter = createActivityMeter({ walk: activityWalk ?? createWorkloadActivityWalk({ view, now }), now });

    let runtime = null; // { path, locator }
    let network = null;
    let anchor = null;
    let lost = false;
    let ended = false;
    let exitHandler = () => {};
    let pair = null; // { client, accepted } until both spawns took their copy
    const uncommitted = new Map(); // resourceId -> abort()
    const trees = new Set(); // process-tree sandboxes (orchestration and workloads)
    const workloads = new Map(); // process number -> sandbox
    const finished = new Set(); // process numbers whose sandbox exited and was released
    let endpointSandbox = null;
    let etcWritten = null; // null | 'bare' (no network yet) | 'network'
    let orchestration = null;

    const rt = (name) => `${runtime.path}/${name}`;
    const requireRuntime = () => { if (!runtime) throw sandboxError('setup_failed', 'the runtime directory does not exist yet'); };

    // ---- anchor ------------------------------------------------------------------------------------------------------

    async function createAnchor({ marker }) {
        const child = spawnImpl('setpriv', ['--pdeathsig', 'KILL', '--', '/bin/sh', '-c', ANCHOR_SCRIPT, 'rw-anchor', marker],
            { stdio: ['pipe', 'ignore', 'ignore'], env: { PATH: TOOL_PATH }, cwd: '/' });
        const exited = defer();
        let alive = true;
        child.once('error', () => { alive = false; exited.resolve(); });
        child.once('exit', () => {
            alive = false;
            exited.resolve();
            if (!ended && anchor?.committed) { lost = true; try { onInfrastructureLoss('anchor_lost'); } catch { /* the caller's handler must not break the supervisor */ } }
        });
        child.stdin?.on?.('error', () => {});
        const kill = async () => {
            try { child.kill('SIGKILL'); } catch { /* gone */ }
            try { child.stdin?.destroy?.(); } catch { /* closed */ }
            await Promise.race([exited.promise, clock.sleep(limits.killWaitMs ?? 5000)]);
        };
        const entry = { child, kill, committed: false, isAlive: () => alive };
        // A process that has just exec'd may show an empty or partial cmdline for a moment: read again before refusing.
        let snapshot = null;
        for (let attempt = 0; attempt < 50; attempt += 1) {
            snapshot = view.process(child.pid);
            if (snapshot && snapshot.ppid === supervisorPid && snapshot.cmdline.includes(marker)) break;
            await clock.sleep(10);
        }
        if (!snapshot || snapshot.ppid !== supervisorPid || !snapshot.cmdline.includes(marker)) {
            await kill();
            throw sandboxError('identity_mismatch', 'anchor');
        }
        // R25': a direct child is signalled only through its ChildProcess, never by kill(2) on a pid.
        const unregister = view.registerSandboxChild?.({ pid: snapshot.pid, startTime: snapshot.startTime, kill: () => child.kill('SIGKILL') }) ?? (() => {});
        exited.promise.then(unregister);
        anchor = entry;
        return {
            identity: { pid: snapshot.pid, startTime: snapshot.startTime },
            gate: {
                async commit() {
                    if (!alive) return false;
                    entry.committed = true;
                    return new Promise((resolve) => child.stdin.write('1\n', (error) => resolve(!error)));
                },
                abort: kill
            },
            handle: null
        };
    }

    // ---- runtime directory -------------------------------------------------------------------------------------------

    function createRuntimeDir({ locator }) {
        const dir = locator?.path;
        if (typeof dir !== 'string' || !dir.startsWith('/') || dir === '/') throw sandboxError('invalid_request', 'runtime locator');
        fsImpl.mkdirSync(dir.slice(0, dir.lastIndexOf('/')), { recursive: true, mode: 0o700 });
        fsImpl.mkdirSync(dir, { mode: 0o700 });
        for (const name of ['channels', 'model', 'stream', 'tmp', 'ctl', 'stage', 'etc']) fsImpl.mkdirSync(`${dir}/${name}`, { mode: 0o700 });
        const stat = fsImpl.lstatSync(dir, { bigint: true });
        if (!stat.isDirectory()) throw sandboxError('setup_failed', 'runtime directory');
        runtime = { path: dir, locator };
        return { identity: { path: dir, dev: decimal(stat.dev), ino: decimal(stat.ino) }, gate: null, handle: null };
    }

    // ---- network -----------------------------------------------------------------------------------------------------

    async function createNetns({ locator }) {
        const id = locator?.netns;
        if (typeof id !== 'string') throw sandboxError('invalid_request', 'netns locator');
        const created = createNetwork({ reservationId: id });
        await created.setup();
        network = created;
        return {
            identity: {
                netNs: created.nsInode(), name: created.name, host: created.hostVeth, peer: created.peerVeth, table: created.table, subnet: created.subnet
            },
            gate: null,
            handle: created
        };
    }

    // ---- sockets -----------------------------------------------------------------------------------------------------

    async function makePair() {
        requireRuntime();
        const path = rt('pair.sock');
        if (Buffer.byteLength(path) > pairSocketPathLimit) throw sandboxError('setup_failed', 'pair socket path too long');
        const server = netImpl.createServer({ pauseOnConnect: true });
        try {
            await new Promise((resolve, reject) => { server.once('error', reject); server.listen(path, resolve); });
            const acceptedPromise = new Promise((resolve, reject) => { server.once('connection', resolve); server.once('error', reject); });
            const client = netImpl.connect(path);
            await new Promise((resolve, reject) => { client.once('connect', resolve); client.once('error', reject); });
            const accepted = await acceptedPromise;
            return { client, accepted };
        } finally {
            server.close();
            try { fsImpl.unlinkSync(path); } catch { /* gone */ }
        }
    }

    const closePair = () => {
        if (!pair) return;
        for (const socket of [pair.client, pair.accepted]) { try { socket.destroy(); } catch { /* closed */ } }
        pair = null;
    };

    const hostStreamPath = (virtual) => {
        const slash = virtual.lastIndexOf('/');
        if (virtual.slice(0, slash) !== admission.streamDirectory || !STREAM_BASENAME.test(virtual.slice(slash + 1))) {
            throw sandboxError('invalid_request', 'stream path');
        }
        return `${rt('stream')}/${virtual.slice(slash + 1)}`;
    };

    async function connectStream(path) {
        const socket = netImpl.connect(path);
        await new Promise((resolve, reject) => { socket.once('connect', resolve); socket.once('error', reject); });
        socket.pause?.();
        return socket;
    }

    // ---- launches ----------------------------------------------------------------------------------------------------

    // Wraps a launched sandbox as a ledger creation: the gate remembers it is uncommitted until commit() ran.
    function asCreation(resourceId, sandbox, { tree }) {
        if (tree) trees.add(sandbox);
        uncommitted.set(resourceId, () => sandbox.gate.abort());
        return {
            identity: sandbox.identity,
            gate: {
                commit: async () => {
                    const ok = await sandbox.gate.commit();
                    if (ok) uncommitted.delete(resourceId);
                    return ok;
                },
                abort: async () => { uncommitted.delete(resourceId); await sandbox.gate.abort(); }
            },
            handle: sandbox
        };
    }

    async function createEndpoint({ resourceId, marker, spec }) {
        requireRuntime();
        if (!network) throw sandboxError('setup_failed', 'the execution network does not exist yet');
        pair ??= await makePair();
        try {
            const sandbox = await launcher.launch({
                role: 'endpoint', marker, runtimeDir: runtime.path, netns: network.nsPath, netnsInode: network.nsInode(),
                roBinds: roles.endpoint.roBinds, symlinks: roles.endpoint.symlinks, env: roles.endpoint.env ?? {}, cwd: roles.endpoint.cwd ?? '/',
                argv: [...roles.endpoint.argv, JSON.stringify(spec?.config ?? {})], anchored: roles.endpoint.anchored ?? [],
                binds: [{ source: rt('stream'), dest: '/stream', mode: 'rw' }, { source: rt('channels'), dest: '/run/robo-work/channels', mode: 'ro' },
                    ...(modelChannel ? [{ source: rt('model'), dest: modelChannel.directory, mode: 'ro' }] : [])],
                stdio: ['ignore', 'ignore', 'ignore'], roleFds: { 3: pair.client, 4: 'pipe' }
            });
            endpointSandbox = sandbox;
            return asCreation(resourceId, sandbox, { tree: false });
        } finally {
            if (orchestration || !pair) closePair();
        }
    }

    async function createOrchestration({ resourceId, marker }) {
        requireRuntime();
        pair ??= await makePair();
        try {
            const sandbox = await launcher.launch({
                role: 'orchestration', marker, runtimeDir: runtime.path,
                roBinds: roles.orchestration.roBinds, symlinks: roles.orchestration.symlinks, env: roles.orchestration.env ?? {}, cwd: roles.orchestration.cwd ?? '/',
                argv: roles.orchestration.argv, anchored: roles.orchestration.anchored ?? [],
                binds: [{ source: rt('channels'), dest: '/run/robo-work/channels', mode: 'ro' }],
                stdio: ['pipe', 'pipe', 'pipe'], roleFds: { 3: pair.accepted }
            });
            orchestration = sandbox;
            return asCreation(resourceId, sandbox, { tree: true });
        } finally {
            if (endpointSandbox) closePair();
        }
    }

    // The workload's /etc/resolv.conf and /etc/hosts, generated once per execution in <runtime>/etc and bound read-only. The nameservers
    // are exactly the ones the execution firewall accepts port 53 for (network.resolvers); a workload without network gets a resolv.conf
    // with no nameserver, so a lookup fails at once instead of waiting for a server that cannot be reached.
    function ensureEtcFiles() {
        const files = { hosts: rt('etc/hosts'), resolvJoin: rt('etc/resolv.conf'), resolvNone: rt('etc/resolv.none.conf') };
        const withNetwork = network !== null;
        if (etcWritten === 'network' || (etcWritten === 'bare' && !withNetwork)) return files;
        // Written to a new inode and renamed over: a sandbox that already has the old file bound keeps reading the old one whole.
        const put = (file, text) => { fsImpl.writeFileSync(`${file}.new`, text, { mode: 0o644 }); fsImpl.renameSync(`${file}.new`, file); };
        put(files.hosts, renderHosts());
        put(files.resolvJoin, renderResolvConf({ nameservers: network?.resolvers ?? [], options: network?.resolverOptions ?? [] }));
        put(files.resolvNone, renderResolvConf({}));
        etcWritten = withNetwork ? 'network' : 'bare';
        return files;
    }

    // The folders and the cwd of the request select the grants, with write access only where both the grant and the request ask for it.
    function selectGrants(request) {
        const chosen = [];
        // The request's exclusions are virtual paths; each becomes a grant-relative path of the admitted grant that holds it (or the
        // request is refused). An exclusion in a grant this request does not mount hides nothing and is dropped.
        const exclusionsByGrant = mapVirtualExclusions(request.exclusions, grants);
        for (const grant of grants) {
            const touching = request.folders.filter((folder) => folder.path === grant.path || folder.path.startsWith(`${grant.path}/`));
            const cwdInside = request.cwd === grant.path || request.cwd.startsWith(`${grant.path}/`);
            if (touching.length === 0 && !cwdInside) continue;
            // The working directory is writable (ALA DS006: "a read-only ancestor may contain the writable working directory"),
            // so a cwd inside a write-admitted grant asks for write like a write folder does.
            const wantsWrite = cwdInside || touching.some((folder) => folder.access === 'write');
            chosen.push({ name: grant.name, path: grant.hostPath, fd: grant.fd, mode: wantsWrite && grant.access === 'write' ? 'rw' : 'ro', exclusions: exclusionsByGrant.get(grant.name) ?? [] });
        }
        return chosen;
    }

    async function createWorkload({ resourceId, marker, spec }) {
        requireRuntime();
        if (!home || !Number.isInteger(home.fd) || typeof home.path !== 'string') throw sandboxError('setup_failed', 'no HOME directory');
        const { request, streams } = spec;
        const netMode = request.network === 'none' ? 'none' : 'join';
        if (netMode === 'join' && !network) throw sandboxError('setup_failed', 'the execution network does not exist yet');
        const chosenGrants = selectGrants(request);
        const etc = ensureEtcFiles(); // refuses a bad exclusion before any socket or process exists
        const sockets = [];
        try {
            const stdio = [];
            for (const [slot, name] of [[0, 'stdin'], [1, 'stdout'], [2, 'stderr']]) {
                if (streams[name] === undefined) { stdio[slot] = 'ignore'; continue; }
                const socket = await connectStream(hostStreamPath(streams[name]));
                sockets.push(socket);
                stdio[slot] = socket;
            }
            const sandbox = await launcher.launch({
                role: 'workload', marker, runtimeDir: runtime.path, netMode, ...(netMode === 'join' ? { netns: network.nsPath, netnsInode: network.nsInode() } : {}),
                roBinds: roles.workload.roBinds, symlinks: roles.workload.symlinks,
                roFiles: [{ source: netMode === 'join' ? etc.resolvJoin : etc.resolvNone, dest: '/etc/resolv.conf' }, { source: etc.hosts, dest: '/etc/hosts' }],
                // OPENCODE_CONFIG is provider-owned (the validator refuses it from ALA): it comes after request.env and only for an execution
                // admitted for the model channel (M-26). The file holds no secret.
                env: { HOME: request.home, PATH: workloadPath, TMPDIR: '/tmp', ...request.env, ...(modelChannel ? { OPENCODE_CONFIG: modelChannel.configPath } : {}) },
                cwd: request.cwd, argv: [request.executable, ...request.args], home: { path: home.path, fd: home.fd }, grants: chosenGrants,
                channelsDir: rt('channels'), tmpDir: rt('tmp'), stdio, scanLimits: roles.workload.scanLimits
            });
            return asCreation(resourceId, sandbox, { tree: true });
        } finally {
            for (const socket of sockets) { try { socket.destroy(); } catch { /* closed */ } }
        }
    }

    async function create(request) {
        if (ended) throw sandboxError('setup_failed', 'the supervisor has ended');
        const { kind } = request;
        if (ANCHOR_KINDS.has(kind)) return createAnchor(request);
        if (kind === 'runtime-dir') return createRuntimeDir(request);
        if (kind === 'netns') return createNetns(request);
        if (kind === 'veth' || kind === 'nft-table') return { identity: { ...request.locator }, gate: null, handle: null };
        // Each sandbox's staging mounts live in its own private mount namespace, recorded as stageMntNs in its process-tree
        // identity. A separate 'mount' blocker therefore holds nothing of its own: it records "no namespace" and is absent.
        if (kind === 'mount') return { identity: { mntNs: '0', mountId: 0, mountpoint: `${runtime?.path ?? '/'}/stage` }, gate: null, handle: null };
        if (kind === 'endpoint') return createEndpoint(request);
        if (kind === 'process-tree') {
            const role = request.spec?.role;
            if (role === 'orchestration') return createOrchestration(request);
            if (role === 'workload') return createWorkload(request);
        }
        throw sandboxError('invalid_request', `unsupported resource ${String(kind)}`);
    }

    // ---- end path ----------------------------------------------------------------------------------------------------

    // A request only: the ledger proves absence itself.
    async function abortUncommitted(resourceIds) {
        for (const id of resourceIds ?? []) {
            const abort = uncommitted.get(id);
            uncommitted.delete(id);
            if (abort) { try { await abort(); } catch { /* proven by the walk */ } }
        }
    }

    async function endTree(sandbox) {
        const verdict = await sandbox.stop({ graceMs: stopGraceMs });
        if (!verdict.absent) throw sandboxError('setup_failed', `process tree still present: ${verdict.problems.join(',')}`);
    }

    async function endProcessTrees() {
        for (const [id, abort] of [...uncommitted]) { uncommitted.delete(id); try { await abort(); } catch { /* proven by the walk */ } }
        const results = await Promise.allSettled([...trees].map(endTree));
        workloads.clear();
        const failed = results.find((result) => result.status === 'rejected');
        if (failed) throw failed.reason;
    }

    async function endEndpoint() {
        closePair();
        if (endpointSandbox) await endTree(endpointSandbox);
    }

    async function releaseEgress() {
        if (!network) return;
        await network.release();
        const verdict = await network.verifyAbsent();
        if (!verdict.absent) throw sandboxError('network_setup_failed', `egress still present: ${verdict.problems.join(',')}`);
        network = null;
    }

    async function releaseViews() {
        // The masks live in each sandbox's private mount namespace and went with its monitor; what remains is the staging directory
        // and the namespace pins. A sandbox that cannot be proven gone, or whose staging directory cannot be removed, fails the step.
        const results = await Promise.allSettled([...trees, ...(endpointSandbox ? [endpointSandbox] : [])].map((sandbox) => sandbox.release()));
        const failed = results.find((result) => result.status === 'rejected' || result.value?.absent !== true || result.value?.stageRemoved === false);
        if (failed) throw failed.status === 'rejected' ? failed.reason : sandboxError('setup_failed', `a sandbox view could not be released: ${(failed.value.problems ?? []).join(',') || 'staging directory remains'}`);
    }

    // The last step of the end path (step 6). Like the keeper before it, the anchor ends with this step: the ledger proves the
    // runtime directory and then the anchor absent, so the anchor must be gone when this returns.
    async function removeRuntime() {
        try {
            if (runtime) {
                if (view.remove?.('runtime-dir', runtime.locator) !== true) throw sandboxError('setup_failed', 'the runtime directory could not be removed');
                runtime = null;
            }
        } finally {
            await exit();
        }
    }

    async function exit() {
        ended = true;
        closePair();
        if (anchor) { await anchor.kill(); anchor = null; }
    }

    // ---- endpoint seam -----------------------------------------------------------------------------------------------

    function providerSandbox(ledger) {
        return {
            async inventory() { return admission.inventory.map((entry) => ({ ...entry })); },
            // The shared temporary directory of the execution, bound at /tmp in every workload; the path is the workload's.
            async tempdir() {
                requireRuntime();
                const name = `ala-${crypto.randomBytes(8).toString('hex')}`;
                fsImpl.mkdirSync(`${rt('tmp')}/${name}`, { mode: 0o700 });
                return `/tmp/${name}`;
            },
            // Resolves only after the gate commit succeeded: the workload has executed.
            async start({ process: number, request, streams }) {
                const published = await ledger.publish({ kind: 'process-tree', spec: { role: 'workload', process: number, request, streams } });
                const sandbox = published.handle;
                workloads.set(number, sandbox);
                sandbox.onExit(() => {
                    sandbox.wait().then(({ exitCode, signal }) => exitHandler(number, signal ? null : exitCode, signal ?? null), () => {});
                    // A finished workload is ended on its observed exit: absence is proven, the staging directory removed and the
                    // namespace pins closed, so that repeated workloads in one execution do not accumulate descriptors and
                    // namespaces. If absence cannot be proven the pins stay and the end path deals with it.
                    sandbox.release().then((verdict) => {
                        if (verdict.absent === true && verdict.stageRemoved !== false) { trees.delete(sandbox); workloads.delete(number); finished.add(number); }
                    }, () => {});
                });
            },
            async stop({ process: number, graceMs }) {
                if (finished.has(number)) return; // it exited and was ended already
                const sandbox = workloads.get(number);
                if (!sandbox) throw sandboxError('invalid_request', 'unknown process');
                const verdict = await sandbox.stop({ graceMs });
                if (!verdict.absent) throw sandboxError('setup_failed', 'the process tree could not be proven gone');
            },
            setExitHandler(handler) { exitHandler = handler; }
        };
    }

    return {
        create, alive: () => !lost && !ended && anchor !== null && anchor.isAlive(), abortUncommitted,
        endProcessTrees, endEndpoint, releaseEgress, releaseViews, removeRuntime, exit,
        providerSandbox,
        // M-35, once per watchdog tick: did this execution's workloads show activity? A new member, or CPU growth of the persisting
        // members of at least 2 % of one CPU since the previous tick (workloadActivity.mjs). Read-only; false when no workload runs.
        workloadActivity() {
            const live = [...workloads.values()].filter((sandbox) => !sandbox.exited && sandbox.identity?.pidNs).map((sandbox) => ({ ...sandbox.identity, owner: `${sandbox.identity.pid}:${sandbox.identity.startTime}` }));
            return meter.sample(live);
        },
        get endpointSocket() { return endpointSandbox?.channel ?? null; },
        get controlStreams() { return orchestration ? { stdin: orchestration.stdio[0], stdout: orchestration.stdio[1], stderr: orchestration.stdio[2] } : null; },
        get network() { return network; },
        get runtimeDir() { return runtime?.path ?? null; },
        stats: () => ({ lost, ended, trees: trees.size, workloads: workloads.size, uncommitted: uncommitted.size, hasNetwork: network !== null, hasRuntime: runtime !== null })
    };
}

// ---- recovery ---------------------------------------------------------------------------------------------------------

// recoveryWalk.createWalker's `sandboxRecord`: the anchor's own S1 record (any release state) for a blocker whose locator
// names it. `getState` returns the current WorkerState handle (it changes when recovery reopens the store).
export const sandboxRecordFor = (getState) => (blocker) => getState().getResource({ resourceId: blocker.locator.keeper });

// Processes whose argv carries the reservation marker as a literal element (every pre-commit stage, and bwrap itself).
export const findMarkerProcesses = (view, marker) => view.listProcesses().filter((entry) => entry.cmdline.includes(marker));

// Every process in the recorded namespaces: the sandbox PID namespace, plus holders of its mount, stage-mount and net namespaces.
export function findNamespaceMembers(view, identity) {
    const wanted = new Set([identity.pidNs, identity.mntNs, identity.stageMntNs, identity.netNs].filter((value) => value !== undefined));
    return view.listProcesses().filter((entry) => wanted.has(entry.pidNs) || wanted.has(entry.mntNs) || wanted.has(entry.netNs)
        || entry.fdNs.some((inode) => wanted.has(inode)));
}

function defaultRunSync(command, args) {
    const result = spawnSync(command, args, { env: { PATH: TOOL_PATH }, encoding: 'utf8', timeout: 20000, stdio: ['ignore', 'pipe', 'pipe'] });
    return { status: result.status ?? 128, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

// The recovery walker's view: procView plus what it cannot know, the egress objects. procView answers "present" for veth
// and nft-table (it cannot see them), so this wrapper asks `ip` and `nft`. `remove('netns', { netns: id })` deletes the
// whole execution network by the names that derive from the locator id (firewall, veth, netns), which is the one hook
// recoveryWalk needs for a network left behind by a crashed supervisor.
export function createRecoveryView(view, { runSync = defaultRunSync, exists = (file) => fs.existsSync(file) } = {}) {
    const linkPresent = (name) => {
        const result = runSync('ip', ['-o', 'link', 'show']);
        if (result.status !== 0) return true;
        return result.stdout.split('\n').some((line) => new RegExp(`^[0-9]+: ${name}[@:]`, 'u').test(line));
    };
    const tablePresent = (table) => {
        const result = runSync('nft', ['list', 'tables']);
        if (result.status !== 0) return true;
        return result.stdout.split('\n').some((line) => line.trim().endsWith(` ${table}`));
    };
    const netnsNames = (locator) => (typeof locator?.netns === 'string' ? namesFor(locator.netns) : null);
    return {
        ...view,
        cgroupSubtree: view.cgroupSubtree,
        exists(kind, locator) {
            if (kind === 'veth') return linkPresent(locator.host) || linkPresent(locator.peer);
            if (kind === 'nft-table') return tablePresent(locator.table);
            // An execution network is present while any of its parts is: the netns file, either veth end, or the nft table.
            if (kind === 'netns') {
                const names = netnsNames(locator);
                return names === null ? true : exists(`/run/netns/${names.netns}`) || linkPresent(names.host) || linkPresent(names.peer) || tablePresent(names.table);
            }
            return view.exists(kind, locator);
        },
        remove(kind, locator) {
            if (kind === 'veth') { runSync('ip', ['link', 'del', locator.host]); return !linkPresent(locator.host); }
            if (kind === 'nft-table') { runSync('nft', ['delete', 'table', 'inet', locator.table]); return !tablePresent(locator.table); }
            if (kind === 'netns') {
                const names = netnsNames(locator);
                if (names === null) return false;
                runSync('nft', ['delete', 'table', 'inet', names.table]);
                runSync('ip', ['link', 'del', names.host]);
                runSync('ip', ['netns', 'del', names.netns]);
                return !exists(`/run/netns/${names.netns}`) && !linkPresent(names.host) && !tablePresent(names.table);
            }
            return view.remove(kind, locator);
        }
    };
}

export { SandboxError };
