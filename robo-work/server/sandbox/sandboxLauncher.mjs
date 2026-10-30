// The sandbox launcher (plan Revision 10, sections B and G): spawns one bwrap sandbox through the fixed chain, proves its
// identity through the supervisor's own /proc view, and ends it with verified absence.
//
//   createSandboxLauncher({ view, spawnImpl?, signal?, clock?, procMasks, stageScript?, arch?, tools?, mainThread?, ... })
//       -> { launch(spec), toolsAvailable() }
//
//   launch(spec) -> Promise<Sandbox>   resolves once bwrap is up and BLOCKED on its gate (or, with spec.onIdentity,
//                                      after the hook returned and the gate byte was written)
//   Sandbox { identity, pid, marker, role, stdio, gate: { commit(), abort() }, release(), stop({ graceMs }), wait(),
//             verifyAbsent(), onExit(fn), exited }
//   identity { pid, startTime, pidNs, mntNs, netNs, stageMntNs, init: { pid, startTime } }
//        pid/startTime are the bwrap monitor's (== ChildProcess.pid); pidNs/mntNs/netNs are the SANDBOX's (read from the
//        init, never from the monitor, which lives in the worker's PID namespace); stageMntNs is the monitor's mount
//        namespace, the private one that holds the masks.
//
// spec
//   role         'orchestration' | 'endpoint' | 'workload' | 'terminal'
//   marker       the S1 reservation id; a literal argv element of the whole chain and the `--unsetenv` value of bwrap
//   runtimeDir   the execution's runtime directory (absolute): descriptor files and the staging directory live below it
//   netMode      'join' (default; endpoint and workload join the execution netns) or 'none' (workload, terminal: loopback only)
//   netns        path of the execution netns (/run/netns/<name>) for every role except orchestration; netnsInode (optional)
//                is the inode the init must be found in
//   roBinds, symlinks, env, cwd, argv          as bwrapArgs.mjs (argv for orchestration and endpoint starts node itself)
//   (the bwrap command is not in the args buffer: it is the tail of the chain after `--`, see bwrapArgs.mjs)
//   anchored     [{ name, path, fd, dest, mode }]  orchestration, endpoint: directories the caller holds open (session storage,
//                config). `path` is the real absolute path and `fd` the caller's descriptor of it; only the path and the
//                fd's device and inode go to prep, which re-opens the path inside the private mount namespace and refuses
//                a different identity (an inherited descriptor cannot be bound: the kernel refuses a mount of another
//                mount namespace). name is [a-z][a-z0-9-]*; it is bound at <stage>/binds/<name>.
//   binds        [{ source, dest, mode }]  plain path binds of directories in the execution runtime directory (stream, channels)
//   stdio        [s0, s1, s2]  each a descriptor number, a socket, 'pipe' or 'ignore' (a terminal's PTY slave goes here)
//   roleFds      { 3: socket|fd, 4: 'pipe'|socket|fd }  endpoint pair socket at 3 and frame channel at 4; orchestration at 3
//   home { path, fd }, grants [{ name, path, fd, mode, exclusions? }]  (exclusions: grant-relative paths masked like protected names), channelsDir, tmpDir     workload and terminal (same path/fd rule)
//   onIdentity   optional async (identity) => void: commit hook; when given, the gate byte is written after it returns
//   timeouts     prepTimeoutMs (default 120000), gateTimeoutMs (10000), verifyTimeoutMs (5000)
//
// Descriptor layout (every descriptor handed through the chain sits at a slot of the spawn's stdio array; Node marks
// everything else close-on-exec). No directory descriptor is handed over; all slots are below 10.
//   workload, terminal   0-2 streams | 3 seccomp | 4 block | 5 info | 6 json-status | 7 bwrap args
//   orchestration        0-2 streams | 3 pair socket | 4 seccomp | 5 block | 6 info | 7 json-status | 8 args
//   endpoint             0-2 streams | 3 pair socket | 4 frames | 5 seccomp | 6 block | 7 info | 8 json-status | 9 args
//
// Failure codes: sandbox_unavailable, mask_scan_limit, mask_unverified, identity_mismatch, commit_timeout, setup_failed,
// invalid_request. Nothing is committed on bwrap's word: the identity is read from /proc.

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { isMainThread } from 'node:worker_threads';

import { isValidComponentName } from '../views/protectedNames.mjs';
import { buildBwrapArgs, bwrapCommand } from './bwrapArgs.mjs';
import { checkRelativeExclusion } from './exclusions.mjs';
import { isMarker, markerSlot } from './marker.mjs';
import { compileSeccomp } from './seccompBpf.mjs';
import { SandboxError, codeForPrepExit, sandboxError } from './sandboxErrors.mjs';

export const STAGE_SCRIPT = fileURLToPath(new URL('./stage.sh', import.meta.url));
// Where a workload or terminal sandbox sees stage.sh (bound read-only from the supervisor's own copy): `stage.sh final`
// runs inside the sandbox, where the supervisor's code path does not exist. Its own top-level directory: a read-only
// /opt/robo-work bind would leave bwrap unable to create the file mount point.
export const SANDBOX_STAGE_SCRIPT = '/rw-stage/stage.sh';
export const TOOL_PATH = '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin';
const REQUIRED_TOOLS = ['setpriv', 'unshare', 'mount', 'umount', 'node'];
const ARCH = { x64: 'x86_64', arm64: 'aarch64' };
const ROLE_FD_ALLOW = { orchestration: [0, 1, 2, 3], endpoint: [0, 1, 2, 3, 4], workload: [0, 1, 2], terminal: [0, 1, 2] };
const SECCOMP_PROFILE = { orchestration: 'orchestration', endpoint: 'orchestration', workload: 'workload', terminal: 'workload' };
const DIGITS = /^[0-9]{1,20}$/u;

const defer = () => { const d = {}; d.promise = new Promise((resolve, reject) => { d.resolve = resolve; d.reject = reject; }); return d; };
const invalid = (detail) => sandboxError('invalid_request', detail);

function findTool(name, searchPath = TOOL_PATH) {
    for (const dir of searchPath.split(':')) {
        try { fs.accessSync(path.join(dir, name), fs.constants.X_OK); return path.join(dir, name); } catch { /* next */ }
    }
    return null;
}

// Opens /proc/<pid>/ns/<type> and returns { inode, close }. An open namespace file keeps the namespace alive, so its inode cannot
// be reused by another namespace while the descriptor is held.
function defaultOpenNamespace(pid, type) {
    const fd = fs.openSync(`/proc/${pid}/ns/${type}`, fs.constants.O_RDONLY);
    try {
        return { inode: String(fs.fstatSync(fd, { bigint: true }).ino), close: () => fs.closeSync(fd) };
    } catch (error) {
        fs.closeSync(fd);
        throw error;
    }
}

// Slot layout for a role.
export function slotLayout(role) {
    const layout = { role: [], seccomp: 0, block: 0, info: 0, status: 0, args: 0 };
    let next = 3;
    if (role === 'orchestration') layout.role = [3];
    if (role === 'endpoint') layout.role = [3, 4];
    next = 3 + layout.role.length;
    for (const key of ['seccomp', 'block', 'info', 'status', 'args']) layout[key] = next++;
    layout.size = next;
    return layout;
}

export function createSandboxLauncher({
    view, spawnImpl = spawn, signal = (pid, name) => process.kill(pid, name), clock = { now: () => Date.now(), sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)) },
    procMasks, stageScript = STAGE_SCRIPT, arch = ARCH[process.arch], tools = null, toolPath = TOOL_PATH,
    mainThread = isMainThread, supervisorPid = process.pid, fsImpl = fs, openNamespace = defaultOpenNamespace
} = {}) {
    // The worker container's /proc masks are re-applied inside every sandbox. No default: a launcher that does not know them
    // would start sandboxes with a wider /proc, so it refuses to exist.
    if (!Array.isArray(procMasks)) throw sandboxError('sandbox_unavailable', 'the /proc masks of the worker container are required');
    if (!view || typeof view.process !== 'function' || typeof view.listProcesses !== 'function' || typeof view.selfNamespaces !== 'function') {
        throw new TypeError('A procView is required');
    }
    if (!mainThread) throw sandboxError('sandbox_unavailable', 'sandboxes must be spawned from the main thread (parent-death signal)');
    if (typeof arch !== 'string') throw sandboxError('sandbox_unavailable', 'unsupported architecture');
    const resolvedTools = tools ?? Object.fromEntries(REQUIRED_TOOLS.map((name) => [name, findTool(name, toolPath)]));

    function toolsAvailable({ needNsenter = false } = {}) {
        const missing = REQUIRED_TOOLS.filter((name) => !resolvedTools[name]);
        if (needNsenter && !(resolvedTools.nsenter ?? findTool('nsenter', toolPath))) missing.push('nsenter');
        if (!fsImpl.existsSync('/usr/bin/bwrap')) missing.push('bwrap');
        return { ok: missing.length === 0, missing };
    }

    // ---------------------------------------------------------------------------------------------------------------

    async function launch(spec) {
        validate(spec);
        const netMode = spec.role === 'orchestration' ? 'none' : (spec.netMode ?? 'join');
        const needNetns = netMode === 'join';
        const available = toolsAvailable({ needNsenter: needNetns });
        if (!available.ok) throw sandboxError('sandbox_unavailable', `missing: ${available.missing.join(', ')}`);

        const layout = slotLayout(spec.role);
        const workloadLike = spec.role === 'workload' || spec.role === 'terminal';
        const cleanup = [];
        const closeLater = [];
        let child = null;
        let stageDir = null;
        let stageNames = { grants: [], binds: [] };
        try {
            // --- descriptor files: seccomp program and bwrap arguments (read to EOF by bwrap)
            const ctlDir = `${spec.runtimeDir}/ctl`;
            fsImpl.mkdirSync(ctlDir, { recursive: true, mode: 0o700 });
            const seccompFd = bufferFd(ctlDir, spec.marker, 'seccomp', compileSeccomp(SECCOMP_PROFILE[spec.role], arch));
            closeLater.push(seccompFd);

            // The directories prep must open for itself: HOME as binds/home, the anchored ones as binds/<name>, grants as projects/<name>.
            const mounts = {
                grants: (spec.grants ?? []).map((grant) => ({ name: grant.name, ...identityOf(grant), ...((grant.exclusions ?? []).length > 0 ? { exclusions: grant.exclusions } : {}) })),
                binds: workloadLike ? [{ name: 'home', ...identityOf(spec.home) }] : (spec.anchored ?? []).map((bind) => ({ name: bind.name, ...identityOf(bind) }))
            };
            const env = { ...(spec.env ?? {}) };
            const fdAllow = spec.fdAllow ?? ROLE_FD_ALLOW[spec.role];
            if (spec.role === 'orchestration' || spec.role === 'endpoint') env.RW_FD_ALLOW = fdAllow.join(',');
            stageNames = { grants: mounts.grants.map((grant) => grant.name), binds: mounts.binds.map((bind) => bind.name) };
            if (mounts.grants.length + mounts.binds.length > 0) stageDir = prepareStage(spec, mounts);
            const bwrapSpec = {
                role: spec.role, marker: spec.marker, netMode,
                seccompFd: layout.seccomp, blockFd: layout.block, infoFd: layout.info, jsonStatusFd: layout.status,
                roBinds: workloadLike ? [...(spec.roBinds ?? []), { source: stageScript, dest: SANDBOX_STAGE_SCRIPT }] : spec.roBinds,
                symlinks: spec.symlinks, binds: spec.binds,
                stageBinds: workloadLike ? undefined : (spec.anchored ?? []).map((bind) => ({ name: bind.name, dest: bind.dest, mode: bind.mode })),
                env, cwd: spec.cwd, argv: spec.argv, procMasks,
                stagingDir: stageDir ?? undefined, channelsDir: spec.channelsDir, stageScript: SANDBOX_STAGE_SCRIPT,
                fdAllow, grants: spec.grants, tmpDir: spec.tmpDir, grantPaths: spec.grantPaths
            };
            const argsBuffer = buildBwrapArgs(bwrapSpec);
            const bwrapTail = bwrapCommand(bwrapSpec);
            const argsFd = bufferFd(ctlDir, spec.marker, 'args', argsBuffer);
            closeLater.push(argsFd);

            // --- the spawn's stdio map
            const stdio = new Array(layout.size).fill('ignore');
            for (let slot = 0; slot < 3; slot += 1) stdio[slot] = spec.stdio?.[slot] ?? 'ignore';
            layout.role.forEach((slot) => { stdio[slot] = spec.roleFds?.[slot] ?? (slot === 4 ? 'pipe' : 'ignore'); });
            stdio[layout.seccomp] = seccompFd;
            stdio[layout.block] = 'pipe';
            stdio[layout.info] = 'pipe';
            stdio[layout.status] = 'pipe';
            stdio[layout.args] = argsFd;

            // --- the chain: marker trails the stage.sh command line, and is again on bwrap's real argv
            const prepSpec = {
                supervisorMntNs: view.selfNamespaces().mntNs,
                stageDir, maskDir: stageDir && `${stageDir}/mask-dir`, maskFile: stageDir && `${stageDir}/mask-file`,
                grants: mounts.grants, binds: mounts.binds, limits: spec.scanLimits
            };
            const command = ['--pdeathsig', 'KILL', '--'];
            if (needNetns) command.push('nsenter', `--net=${spec.netns}`, '--');
            command.push('unshare', '--mount', '--propagation', 'private', '--', '/bin/sh', stageScript, 'prep', spec.marker,
                String(supervisorPid), '', String(layout.args), JSON.stringify(prepSpec), '--', ...bwrapTail);
            child = spawnImpl('setpriv', command, { stdio, env: { PATH: toolPath }, cwd: '/', detached: false });
            for (const fd of closeLater.splice(0)) { try { fsImpl.closeSync(fd); } catch { /* closed */ } }

            return await supervise(child, spec, layout, stageDir, stageNames);
        } catch (error) {
            if (child) { try { child.kill('SIGKILL'); } catch { /* gone */ } }
            for (const fd of closeLater.splice(0)) { try { fsImpl.closeSync(fd); } catch { /* closed */ } }
            if (stageDir) removeStage(stageDir, stageNames);
            for (const step of cleanup) { try { step(); } catch { /* best effort */ } }
            if (error instanceof SandboxError) throw error;
            throw sandboxError(error?.code === 'invalid_request' ? 'invalid_request' : 'setup_failed', error?.code ?? error?.message ?? 'error');
        }
    }

    function validate(spec) {
        if (!spec || typeof spec !== 'object') throw invalid('spec');
        if (!Object.hasOwn(ROLE_FD_ALLOW, spec.role)) throw invalid('role');
        if (!isMarker(spec.marker)) throw invalid('marker');
        if (typeof spec.runtimeDir !== 'string' || !spec.runtimeDir.startsWith('/') || spec.runtimeDir === '/') throw invalid('runtimeDir');
        if (spec.netMode !== undefined && !['join', 'none'].includes(spec.netMode)) throw invalid('netMode');
        if (spec.role !== 'orchestration' && spec.netMode !== 'none' && !/^\/run\/netns\/rw[0-9a-f]{16}$/u.test(spec.netns ?? '')) throw invalid('netns');
        const held = (entry) => entry && typeof entry.path === 'string' && entry.path.startsWith('/') && Number.isInteger(entry.fd) && entry.fd >= 3;
        if (spec.role === 'workload' || spec.role === 'terminal') {
            if (!held(spec.home) || !Array.isArray(spec.grants)) throw invalid('workload directories');
            if (spec.grants.some((grant) => !held(grant) || !isValidComponentName(grant.name))) throw invalid('grant');
            // Exclusions (extra masks, grant-relative): refused here, before anything is created, when they are not plain relative paths.
            for (const grant of spec.grants) for (const rel of grant.exclusions ?? []) checkRelativeExclusion(rel);
        } else if ((spec.anchored ?? []).some((bind) => !held(bind) || !/^[a-z][a-z0-9-]{0,31}$/u.test(bind.name ?? ''))) throw invalid('anchored');
    }

    // The identity the supervisor recorded from its own descriptor; prep must find the same directory at the path.
    function identityOf(entry) {
        const stat = fsImpl.fstatSync(entry.fd, { bigint: true });
        if (!stat.isDirectory()) throw invalid('not a directory');
        return { path: entry.path, dev: String(stat.dev), ino: String(stat.ino) };
    }

    // A file in the runtime directory holding `buffer`, opened read-write, written with pwrite (the offset stays 0), and unlinked.
    function bufferFd(dir, marker, label, buffer) {
        const file = `${dir}/${markerSlot(marker)}.${label}`;
        const fd = fsImpl.openSync(file, fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
        try {
            fsImpl.unlinkSync(file);
            let written = 0;
            while (written < buffer.length) written += fsImpl.writeSync(fd, buffer, written, buffer.length - written, written);
        } catch (error) {
            fsImpl.closeSync(fd);
            throw error;
        }
        return fd;
    }

    // <runtimeDir>/stage/<markerSlot(marker)>/{projects/<grant>, binds/<name>, mask-dir (0555 empty), mask-file (0444 empty)}
    function prepareStage(spec, mounts) {
        const dir = `${spec.runtimeDir}/stage/${markerSlot(spec.marker)}`;
        fsImpl.mkdirSync(`${dir}/projects`, { recursive: true, mode: 0o700 });
        fsImpl.mkdirSync(`${dir}/binds`, { mode: 0o700 });
        for (const grant of mounts.grants) fsImpl.mkdirSync(`${dir}/projects/${grant.name}`, { mode: 0o700 });
        for (const bind of mounts.binds) fsImpl.mkdirSync(`${dir}/binds/${bind.name}`, { mode: 0o700 });
        fsImpl.mkdirSync(`${dir}/mask-dir`, { mode: 0o555 });
        fsImpl.chmodSync(`${dir}/mask-dir`, 0o555);
        fsImpl.writeFileSync(`${dir}/mask-file`, '', { mode: 0o444 });
        fsImpl.chmodSync(`${dir}/mask-file`, 0o444);
        return dir;
    }

    // Never recursive: a bind that leaked into this namespace must fail the rmdir, never lose a robot's file.
    function removeStage(dir, names) {
        const steps = [
            ...names.grants.map((name) => () => fsImpl.rmdirSync(`${dir}/projects/${name}`)),
            ...names.binds.map((name) => () => fsImpl.rmdirSync(`${dir}/binds/${name}`)),
            () => fsImpl.rmdirSync(`${dir}/projects`), () => fsImpl.rmdirSync(`${dir}/binds`), () => fsImpl.rmdirSync(`${dir}/mask-dir`),
            () => fsImpl.unlinkSync(`${dir}/mask-file`), () => fsImpl.rmdirSync(dir)
        ];
        let clean = true;
        for (const step of steps) { try { step(); } catch (error) { if (error?.code !== 'ENOENT') clean = false; } }
        return clean;
    }

    // ---------------------------------------------------------------------------------------------------------------

    async function supervise(child, spec, layout, stageDir, stageNames) {
        const exit = defer();
        let exited = null;
        let spawnError = null;
        const exitListeners = [];
        const failed = defer();
        failed.promise.catch(() => {});
        child.once('error', (error) => {
            spawnError = error;
            failed.reject(sandboxError(error?.code === 'ENOENT' ? 'sandbox_unavailable' : 'setup_failed', error?.code ?? 'spawn failed'));
        });
        child.once('exit', (code, signalName) => {
            exited = { code, signal: signalName };
            exit.resolve(exited);
            for (const fn of exitListeners.splice(0)) { try { fn(exited); } catch { /* a listener must not break the launcher */ } }
        });
        const sockets = child.stdio ?? [];
        const block = sockets[layout.block];
        const info = sockets[layout.info];
        const status = sockets[layout.status];
        if (!block || !info || !status) throw sandboxError('setup_failed', 'control channels missing');
        status.on?.('error', () => {});
        info.on?.('error', () => {});
        block.on?.('error', () => {});
        let statusText = '';
        status.on('data', (chunk) => { if (statusText.length < 4096) statusText += chunk; });

        const killMonitor = () => { try { child.kill('SIGKILL'); } catch { /* gone */ } };

        // 1. bwrap reports its child's PID once the sandbox exists (it is still blocked on the gate).
        const initPid = await readInfo(info, exit.promise, failed.promise, spec.prepTimeoutMs ?? 120000);
        if (spawnError) throw sandboxError('sandbox_unavailable', spawnError.code ?? 'spawn failed');
        if (!Number.isSafeInteger(child.pid)) throw sandboxError('setup_failed', 'no pid');

        // 2. Identity from /proc.
        const identity = readIdentity(child.pid, initPid, spec);
        const unregister = view.registerSandboxChild?.({ pid: identity.pid, startTime: identity.startTime, kill: killMonitor }) ?? (() => {});

        // Pin the recorded namespaces (B1): the sandbox's pid and mount namespaces and the private stage mount namespace stay
        // alive, with their inodes, until release(), so no other sandbox can show the same numbers while this one is recorded.
        // Each pin is checked against the inode just read; a mismatch means the process was not what was read.
        const pins = [];
        let pinned = false;
        const unpinAll = () => { pinned = false; for (const close of pins.splice(0).reverse()) { try { close(); } catch { /* closed */ } } };
        try {
            for (const [pid, type, inode] of [[identity.init.pid, 'pid', identity.pidNs], [identity.init.pid, 'mnt', identity.mntNs], [identity.pid, 'mnt', identity.stageMntNs]]) {
                const opened = openNamespace(pid, type);
                const unpinView = view.pinNamespace?.(type, inode) ?? (() => {});
                pins.push(() => { unpinView(); opened.close(); });
                if (String(opened.inode) !== String(inode)) throw sandboxError('identity_mismatch', `${type} namespace changed while being pinned`);
            }
            pinned = true;
        } catch (error) {
            unpinAll();
            unregister();
            killMonitor();
            throw error instanceof SandboxError ? error : sandboxError('identity_mismatch', `cannot pin a namespace: ${error?.code ?? 'error'}`);
        }

        let gateState = 'blocked'; // blocked -> open | aborted
        const gate = {
            async commit() {
                if (gateState !== 'blocked' || exited) return false;
                gateState = 'open';
                try {
                    await new Promise((resolve, reject) => {
                        const timer = setTimeout(() => reject(sandboxError('commit_timeout')), spec.gateTimeoutMs ?? 10000);
                        block.write(Buffer.from('1'), (error) => { clearTimeout(timer); if (error) reject(error); else resolve(); });
                    });
                    block.end?.();
                    return true;
                } catch {
                    killMonitor();
                    return false;
                }
            },
            // SIGKILL first, then close the gate: end-of-file on --block-fd unblocks bwrap.
            async abort() {
                if (gateState === 'aborted') return;
                gateState = 'aborted';
                killMonitor();
                try { block.destroy?.(); } catch { /* closed */ }
                await Promise.race([exit.promise, clock.sleep(spec.verifyTimeoutMs ?? 5000)]);
            }
        };

        // --- ending
        const poll = async (check, timeoutMs) => {
            const deadline = clock.now() + timeoutMs;
            for (;;) {
                const result = check();
                if (result.absent || clock.now() >= deadline) return result;
                await clock.sleep(25);
            }
        };

        function absence() {
            const problems = [];
            if (!exited) problems.push('monitor_running');
            const processes = view.listProcesses();
            // A namespace inode names this sandbox's namespace only while it is pinned. Once unpinned the kernel may hand the
            // number to another sandbox, so an unpinned inode proves nothing and is not looked for. Our own pins are not holders.
            if (pinned) {
                const holders = processes.filter((entry) => entry.pidNs === identity.pidNs || entry.mntNs === identity.mntNs
                    || entry.mntNs === identity.stageMntNs
                    || (entry.pid !== supervisorPid && [identity.pidNs, identity.mntNs, identity.stageMntNs].some((inode) => entry.fdNs?.includes(inode))));
                if (holders.length > 0) problems.push('namespace_held');
            }
            if (processes.some((entry) => entry.cmdline.includes(spec.marker))) problems.push('marker_present');
            if (processes.some((entry) => entry.pid === identity.init.pid && entry.startTime === identity.init.startTime)) problems.push('init_present');
            if (processes.some((entry) => entry.pid === identity.pid && entry.startTime === identity.startTime)) problems.push('monitor_present');
            return { absent: problems.length === 0, problems };
        }

        const verifyAbsent = () => poll(absence, spec.verifyTimeoutMs ?? 5000);

        // SIGTERM to every member of the sandbox PID namespace, after its identity is read again immediately before kill(2).
        function termMembers() {
            if (!pinned) return; // an unpinned inode may belong to another sandbox
            for (const member of view.listProcesses()) {
                if (member.pidNs !== identity.pidNs || member.pid === identity.pid) continue;
                const fresh = view.process(member.pid);
                if (!fresh || fresh.startTime !== member.startTime || fresh.pidNs !== identity.pidNs) continue;
                try { signal(member.pid, 'SIGTERM'); } catch { /* gone */ }
            }
        }

        let stopping = null;
        const stop = ({ graceMs = 2000 } = {}) => {
            if (stopping) return stopping;
            stopping = (async () => {
                if (!exited) {
                    if (gateState === 'blocked') await gate.abort();
                    else {
                        try { termMembers(); } catch { /* the SIGKILL below does not depend on it */ }
                        await Promise.race([exit.promise, clock.sleep(graceMs)]);
                        if (!exited) killMonitor();
                    }
                    await Promise.race([exit.promise, clock.sleep(spec.verifyTimeoutMs ?? 5000)]);
                }
                const verdict = await verifyAbsent();
                if (verdict.absent) unregister();
                return verdict;
            })();
            return stopping;
        };

        // Ends the sandbox and removes its staging directory. The verdict says whether absence was proven AND the staging
        // directory is gone (it is not when a bind leaked into this namespace: removal is never recursive). The pins are
        // released last, only after absence is proven.
        let released = null;
        const release = async () => {
            if (released) return released;
            released = (async () => {
                const verdict = await stop({ graceMs: 0 });
                const stageRemoved = verdict.absent && stageDir ? removeStage(stageDir, stageNames) : verdict.absent;
                if (verdict.absent) unpinAll();
                return { ...verdict, stageRemoved };
            })();
            return released;
        };

        const sandbox = {
            identity, pid: identity.pid, marker: spec.marker, role: spec.role, stdio: sockets.slice(0, 3),
            channel: spec.role === 'endpoint' ? sockets[4] : null, gate, stop, release, verifyAbsent,
            wait: () => exit.promise.then((value) => ({ ...value, exitCode: parseExitCode(statusText) ?? value.code })),
            onExit: (fn) => { if (exited) fn(exited); else exitListeners.push(fn); },
            get exited() { return exited; }
        };
        if (typeof spec.onIdentity === 'function') {
            try { await spec.onIdentity(identity); } catch (error) { await gate.abort(); await release(); throw error; }
            if (!(await gate.commit())) { await release(); throw sandboxError('commit_timeout'); }
        }
        return sandbox;
    }

    function readInfo(info, exitPromise, failedPromise, timeoutMs) {
        return new Promise((resolve, reject) => {
            let text = '';
            let settled = false;
            const finish = (fn, value) => { if (!settled) { settled = true; clearTimeout(timer); fn(value); } };
            const timer = setTimeout(() => finish(reject, sandboxError('setup_failed', 'timeout waiting for the sandbox')), timeoutMs);
            const parse = () => {
                const found = /"child-pid"\s*:\s*([0-9]+)/u.exec(text);
                if (found) finish(resolve, Number(found[1]));
            };
            failedPromise.catch((error) => finish(reject, error));
            info.on('data', (chunk) => { text += chunk; if (text.length > 4096) finish(reject, sandboxError('setup_failed', 'info too long')); else parse(); });
            info.on('end', () => { parse(); finish(reject, sandboxError('setup_failed', 'info closed')); });
            // The chain ended before bwrap reported: prep's exit code says why.
            exitPromise.then(({ code }) => {
                setImmediate(() => {
                    parse();
                    finish(reject, sandboxError(codeForPrepExit(code) ?? 'setup_failed', code === null ? 'killed' : `exit ${code}`));
                });
            });
        });
    }

    function parseExitCode(text) {
        const match = /"exit-code"\s*:\s*(-?[0-9]+)/u.exec(text);
        return match ? Number(match[1]) : null;
    }

    function readIdentity(monitorPid, initPid, spec) {
        if (!Number.isSafeInteger(initPid) || initPid < 2) throw sandboxError('identity_mismatch', 'bad child pid');
        const self = view.selfNamespaces();
        const monitor = view.process(monitorPid);
        const init = view.process(initPid);
        if (!monitor) throw sandboxError('identity_mismatch', 'monitor absent');
        if (!init) throw sandboxError('identity_mismatch', 'init absent');
        if (monitor.ppid !== supervisorPid) throw sandboxError('identity_mismatch', 'monitor is not our child');
        if (!monitor.cmdline.includes(spec.marker)) throw sandboxError('identity_mismatch', 'marker missing on bwrap argv');
        if (monitor.pidNs !== self.pidNs) throw sandboxError('identity_mismatch', 'monitor pid namespace');
        // The private mount namespace of the prep stage: never the worker's own.
        if (monitor.mntNs === self.mntNs) throw sandboxError('identity_mismatch', 'monitor shares the worker mount namespace');
        if (init.pidNs === self.pidNs || init.pidNs === monitor.pidNs) throw sandboxError('identity_mismatch', 'init shares the worker pid namespace');
        if (init.mntNs === self.mntNs || init.mntNs === monitor.mntNs) throw sandboxError('identity_mismatch', 'init mount namespace');
        // Every role runs in a network namespace of its own: orchestration in a fresh one, the others in the execution's.
        if (init.netNs === self.netNs) throw sandboxError('identity_mismatch', 'init shares the worker network namespace');
        if (spec.role !== 'orchestration' && spec.netnsInode !== undefined && init.netNs !== String(spec.netnsInode)) {
            throw sandboxError('identity_mismatch', 'init is not in the execution network namespace');
        }
        if (![init.pidNs, init.mntNs, init.netNs, monitor.mntNs, monitor.startTime, init.startTime].every((value) => DIGITS.test(String(value)))) {
            throw sandboxError('identity_mismatch', 'unreadable namespace');
        }
        return {
            pid: monitor.pid, startTime: monitor.startTime, pidNs: init.pidNs, mntNs: init.mntNs, netNs: init.netNs,
            stageMntNs: monitor.mntNs, init: { pid: init.pid, startTime: init.startTime }
        };
    }

    return { launch, toolsAvailable };
}
