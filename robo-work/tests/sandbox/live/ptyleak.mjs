// Live probe for M-65: a PTY master the worker holds WITHOUT close-on-exec (node-pty 1.0.0 leaves a robot terminal's master that
// way; Node/libuv does not close such descriptors at spawn) must reach no process of ANY sandbox launch of another robot: not the
// node prep, not bwrap, not orchestration (ALA), the endpoint, a workload or a terminal. Run where smoke.mjs runs (container root
// in the nested-podman profile or `podman exec` in the Box worker), AFTER a fresh deploy of the candidate:
//
//   node /code/tests/sandbox/live/ptyleak.mjs                          # held fd-only roles through the real supervisor/launcher
//   node /code/tests/sandbox/live/ptyleak.mjs --node-pty <dir>         # the same, but A's master is opened by node-pty itself (the
//                                                                      # real T1 mechanism; <dir> is the node-pty package directory)
//   node /code/tests/sandbox/live/ptyleak.mjs --watch 600 --worker-pid <pid>
//                                                                      # scan only, against the REAL worker: run it while robot A has a
//                                                                      # terminal open (T1) and robot B runs an AI task (and, with T1,
//                                                                      # opens a terminal)
//   Add --controlled to --watch: wait for MEASUREMENT_READY on stderr before launching B, then send one JSON line on stdin:
//   {"type":"finish","monitors":[{"pid":123,"startTime":"456","marker":"ledger-reservation","group":"ai"}, ...]}
//   Monitor groups are ai (B's task), terminal-a and terminal-b; live role coverage is checked within those groups.
//   The caller must supply currently running ledger monitors for A/B terminals and B's task before it ends. Missing finish,
//   missing live roles, unreadable observations and changed identities fail. Cleanup belongs AFTER the watch result.
//   node /code/tests/sandbox/live/ptyleak.mjs --detector-self-test     # no sandbox: proves only that the detector sees an inherited master
//
// Default mode. The supervisor process is ptyLeakFixture.mjs started as a child of this probe; robot A's PTY master is in it without
// close-on-exec: either inherited at fd 40 (a /dev/ptmx this probe opened, handed over by dup2, which clears close-on-exec), or,
// with --node-pty, opened in the fixture's own process by node-pty through a `--import` preload. Sampling begins before granting
// launch and ends only after every role is ready with the same live, readable identities. The controller then grants teardown,
// whose absence checks must independently succeed. The fixture uses the REAL launcher, supervisor, network and procView
// (anchor, endpoint, orchestration, one workload); its held role programs spawn no commands. Every 5 ms this probe reads /proc:
//
//   P0  precondition: the supervisor holds a PTY master (an fd whose fdinfo has `tty-index`, link .../ptmx) WITHOUT O_CLOEXEC.
//       Its identity is the (st_dev, st_ino) of the opened node: a sandbox has its own /dev and devpts, so no sandboxed process can
//       open that node itself; holding it means it was inherited.
//   L1  no process of B's launches holds A's master: the node prep (`sandboxPrep.mjs`), every bwrap process, every process in a
//       sandbox PID namespace, and the `sh stage.sh prep` shell once it has a child (it closes the fd before it runs prep). The
//       tools BEFORE stage.sh (setpriv, nsenter, unshare, and stage.sh before it has closed) may hold it: counted as the accepted
//       window, never a failure. A PTY master (link /dev/ptmx or /dev/pts/ptmx) whose identity cannot be read is a suspect
//       violation. Any unreadable live observation or changed identity during measurement stays failed, even if a later read
//       succeeds or the process dies. ENOENT/ESRCH with no remaining process is counted (`vanished`), never as clean coverage.
//   L2  the descriptor snapshot each held role's probe program took at its start holds nothing >= 3 outside the role
//       allowlist (orchestration 0-3, endpoint 0-4, workload 0-2) except Node's own (eventpoll, eventfd, io_uring, /dev/null, a pipe
//       open twice), and no PTY master at all.
//   C   coverage: at least one prep, bwrap, orchestration, endpoint and workload process whose fd table WAS read (a pid counts as
//       sampled only then; per-kind `unreadable` and `vanished` counts are reported); and a positive control (a plain
//       child holding the master by inheritance) must be detected, so a zero cannot come from a detector that sees nothing.
//   terminal: the fd-only fixture starts no terminal sandbox; --controlled --watch covers the real terminal/AI case.
//
// Prints ONE JSON document (counts, codes, fd numbers and link targets; never file content) on stdout, progress on stderr.
// Exit 0: every check held (pending items are listed in `pending`); 1: a check failed; 3: --watch found no PTY master in the worker.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import readline from 'node:readline';
import { pathToFileURL } from 'node:url';

import { createObservationLog, measureFixture, processKey, readIdentity, validateHeld } from './ptyLeakMeasurement.mjs';

const HERE = path.dirname(new URL(import.meta.url).pathname);
const argv = process.argv.slice(2);
const opt = (name) => { const at = argv.indexOf(name); return at === -1 ? null : argv[at + 1]; };
const evidence = { mode: null, checks: {}, counts: {}, pending: [], errors: [] };
const progress = (text) => process.stderr.write(`[ptyleak] ${text}\n`);
const check = (name, ok, extra = {}) => { evidence.checks[name] = { ok: ok === true, ...extra }; if (ok !== true) evidence.errors.push(name); };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const O_CLOEXEC = 0o2000000;
const LEAK_FD = 40;
const fdErrors = new Map();
const ROLE_ALLOW = { orchestration: [0, 1, 2, 3], endpoint: [0, 1, 2, 3, 4], workload: [0, 1, 2], terminal: [0, 1, 2] };
const NODE_INTERNAL = new Set(['anon_inode:[eventpoll]', 'anon_inode:[eventfd]', 'anon_inode:[io_uring]', '/dev/null']);

// ---- /proc readers ------------------------------------------------------------------------------------------------------------
const readText = (file) => { try { return fs.readFileSync(file, 'utf8'); } catch { return null; } };
const cmdlineOf = (pid) => (readText(`/proc/${pid}/cmdline`) ?? '').split('\0').filter(Boolean);
const ppidOf = (pid) => Number(/^PPid:\s*([0-9]+)/mu.exec(readText(`/proc/${pid}/status`) ?? '')?.[1] ?? 0);
const pidNsOf = (pid) => { try { return fs.readlinkSync(`/proc/${pid}/ns/pid`); } catch { return null; } };
const listPids = () => { try { return fs.readdirSync('/proc').filter((name) => /^[0-9]+$/u.test(name)).map(Number); } catch { return []; } };
// [{ fd, target, dev, ino, flags, ttyIndex }] of a process; entries that vanish while reading are skipped
function fdsOf(pid) {
    let names = [];
    try { names = fs.readdirSync(`/proc/${pid}/fd`); fdErrors.delete(pid); } catch (error) { fdErrors.set(pid, error.code); return null; }
    const out = [];
    for (const name of names) {
        try {
            const target = fs.readlinkSync(`/proc/${pid}/fd/${name}`);
            const info = readText(`/proc/${pid}/fdinfo/${name}`) ?? '';
            let dev = null; let ino = null;
            try { const st = fs.statSync(`/proc/${pid}/fd/${name}`, { bigint: true }); dev = String(st.dev); ino = String(st.ino); } catch { /* gone */ }
            out.push({ fd: Number(name), target, dev, ino, flags: parseInt(/^flags:\s*([0-7]+)/mu.exec(info)?.[1] ?? 'NaN', 8), ttyIndex: /^tty-index:/mu.test(info) });
        } catch (error) {
            if (!['ENOENT', 'ESRCH'].includes(error.code)) { fdErrors.set(pid, error.code); return null; }
        }
    }
    return out;
}
const isMaster = (entry) => /(^|\/)ptmx$/u.test(entry.target);
// A's masters in `pid`: PTY masters without close-on-exec
const leakableMasters = (pid) => (fdsOf(pid) ?? []).filter((entry) => isMaster(entry) && Number.isInteger(entry.flags) && (entry.flags & O_CLOEXEC) === 0 && entry.dev !== null);
// PTY masters of `pid` whose identity could not be read (reported with P0: such a master could not be matched)
const unknownMasters = (pid) => (fdsOf(pid) ?? []).filter((entry) => isMaster(entry) && entry.dev === null).length;
const identityKey = (entry) => `${entry.dev}:${entry.ino}`;

// ---- the sampler -------------------------------------------------------------------------------------------------------------
const selfPidNs = pidNsOf('self');
export function createSampler({ supervisorPid, masters, readers = {} }) {
    const identity = readers.identity ?? readIdentity;
    const readFds = readers.fdsOf ?? fdsOf;
    const fdError = readers.fdError ?? ((pid) => fdErrors.get(pid));
    const processes = readers.listPids ?? listPids;
    const parentOf = readers.ppidOf ?? ppidOf;
    const commandOf = readers.cmdlineOf ?? cmdlineOf;
    const namespaceOf = readers.pidNsOf ?? pidNsOf;
    const keys = new Set(masters.map(identityKey));
    const seen = { prep: new Set(), bwrap: new Set(), orchestration: new Set(), endpoint: new Set(), workload: new Set(), terminal: new Set(), stage: new Set(), sandboxOther: new Set() };
    const violations = [];
    const window = new Set();
    // Coverage requires a readable fd table and a known process identity. Failed observations remain latched by pid:startTime;
    // neither a later readable sample nor a reused pid erases them. ENOENT/ESRCH with no process provides no coverage.
    const unreadable = Object.fromEntries(Object.keys(seen).map((kind) => [kind, 0]));
    const vanished = Object.fromEntries(Object.keys(seen).map((kind) => [kind, 0]));
    const observations = createObservationLog();
    const lastUnreadable = observations.failures;
    const members = new Map();
    let samples = 0;
    // the role of a sandbox member: the real argv tail (after `--`) of its nearest bwrap ancestor
    function roleOf(pid, info) {
        for (let at = pid, hops = 0; at > 1 && hops < 64; at = info.get(at)?.ppid ?? parentOf(at), hops += 1) {
            const cmd = info.get(at)?.cmd ?? commandOf(at);
            if (path.basename(cmd[0] ?? '') !== 'bwrap') continue;
            const tail = cmd.slice(cmd.indexOf('--') + 1).join(' ');
            // workload and terminal share the real argv shape (`--new-session` is in the --args buffer): a terminal is told apart
            // only by PTYLEAK_TERMINAL_ARGV, a fragment of its command
            if (/stage\.sh final/u.test(tail)) return process.env.PTYLEAK_TERMINAL_ARGV && tail.includes(process.env.PTYLEAK_TERMINAL_ARGV) ? 'terminal' : 'workload';
            if (/role-orchestration|ala\.mjs/u.test(tail)) return 'orchestration';
            if (/role-endpoint|providerEndpointMain\.mjs/u.test(tail)) return 'endpoint';
            return 'sandboxOther';
        }
        return 'sandboxOther';
    }
    function descendsFrom(pid, root, info) {
        for (let at = pid, hops = 0; at > 1 && hops < 64; at = info.get(at)?.ppid ?? parentOf(at), hops += 1) if (at === root) return true;
        return false;
    }
    function markerOf(pid, info) {
        for (let at = pid, hops = 0; at > 1 && hops < 64; at = info.get(at)?.ppid ?? parentOf(at), hops += 1) {
            const cmd = info.get(at)?.cmd ?? commandOf(at);
            const index = cmd.indexOf('--unsetenv');
            if (path.basename(cmd[0] ?? '') === 'bwrap' && index >= 0) return cmd[index + 1] ?? null;
        }
        return null;
    }
    function sample() {
        samples += 1;
        const pids = processes();
        const info = new Map();
        for (const pid of pids) info.set(pid, { ppid: parentOf(pid), cmd: commandOf(pid), identity: identity(pid) });
        const children = new Map();
        for (const [pid, { ppid }] of info) children.set(ppid, (children.get(ppid) ?? 0) + 1);
        for (const pid of pids) {
            if (pid === process.pid || pid === supervisorPid) continue;
            if (supervisorPid !== null && !descendsFrom(pid, supervisorPid, info)) continue;
            const { cmd } = info.get(pid);
            const base = path.basename(cmd[0] ?? '');
            const sandbox = namespaceOf(pid) !== selfPidNs;
            let kind = null;
            if (sandbox) kind = roleOf(pid, info);
            else if (cmd.some((arg) => arg.endsWith('sandboxPrep.mjs'))) kind = 'prep';
            else if (base === 'bwrap') kind = 'bwrap';
            else if (cmd.some((arg) => arg.endsWith('stage.sh')) && cmd.includes('prep')) kind = (children.get(pid) ?? 0) > 0 ? 'stage' : 'window';
            else if (['setpriv', 'nsenter', 'unshare'].includes(base)) kind = 'window';
            if (kind === null) continue;
            const before = info.get(pid).identity;
            const table = readFds(pid);
            const after = identity(pid);
            if (kind === 'window') {
                if ((table ?? []).some((entry) => (entry.dev !== null && keys.has(identityKey(entry))) || (entry.dev === null && isMaster(entry)))) window.add(pid);
                continue;
            }
            if (table === null) {
                if (['ENOENT', 'ESRCH'].includes(fdError(pid)) && after === null) vanished[kind] += 1;
                else unreadable[kind] += 1;
                observations.record({ before, after, kind, table, errno: fdError(pid) });
                continue;
            }
            if (!observations.record({ before, after, kind, table })) continue;
            const key = processKey(before);
            seen[kind].add(key);
            members.set(key, { ...before, kind, marker: markerOf(pid, info) });
            const held = table.filter((entry) => entry.dev !== null && keys.has(identityKey(entry)));
            // a PTY master whose identity could not be read (stat failed) cannot be cleared: it is a suspect violation
            const suspect = table.filter((entry) => entry.dev === null && isMaster(entry));
            if (held.length + suspect.length > 0) {
                violations.push({ pid, kind, comm: (readText(`/proc/${pid}/comm`) ?? '').trim().slice(0, 24), fds: held.map((entry) => entry.fd),
                    suspectFds: suspect.map((entry) => ({ fd: entry.fd, target: entry.target })) });
            }
        }
    }
    return { sample, seen, violations, window, unreadable, vanished, lastUnreadable, members, get samples() { return samples; } };
}

export function validateWatchFinish(sampler, monitors, readers = {}) {
    if (!Array.isArray(monitors) || monitors.length === 0 || monitors.some((entry) => !entry || !Number.isSafeInteger(entry.pid) || entry.pid < 2
        || !/^\d+$/u.test(entry.startTime ?? '') || typeof entry.marker !== 'string' || !/^[A-Za-z0-9_-]{8,64}$/u.test(entry.marker)
        || !['ai', 'terminal-a', 'terminal-b'].includes(entry.group))) {
        return { held: [], failures: [{ reason: 'finish requires ledger reservation markers' }] };
    }
    const markers = monitors.map(({ marker }) => marker);
    const identity = readers.identity ?? readIdentity;
    const descriptors = readers.descriptors ?? fdsOf;
    const held = [...sampler.members.values()].filter((entry) => {
        const current = identity(entry.pid);
        return markers.includes(entry.marker) && current && processKey(current) === processKey(entry) && !['Z', 'X', 'x'].includes(current.state);
    });
    const failures = validateHeld(held, { identity, descriptors });
    failures.push(...validateHeld(monitors, { identity, descriptors }));
    for (const monitor of monitors) {
        if (!held.some((entry) => entry.marker === monitor.marker && entry.kind === 'bwrap' && processKey(entry) === processKey(monitor))) {
            failures.push({ ...monitor, reason: 'reservation monitor ended or changed identity before finish' });
        }
    }
    for (const [group, kinds] of Object.entries({ ai: ['orchestration', 'endpoint', 'workload'], 'terminal-a': ['terminal'], 'terminal-b': ['terminal'] })) {
        const ownMarkers = new Set(monitors.filter((entry) => entry.group === group).map((entry) => entry.marker));
        for (const kind of kinds) if (!held.some((entry) => entry.kind === kind && ownMarkers.has(entry.marker))) failures.push({ group, kind, reason: 'required ledger-bound role not alive at finish' });
    }
    return { held, failures };
}

// fds >= 3 outside the allowlist in a smoke.mjs probe snapshot ("n->target"), Node's own shapes excepted
function outsideAllowlist(snapshot, role) {
    const entries = (snapshot ?? []).map((text) => { const at = text.indexOf('->'); return { fd: Number(text.slice(0, at)), target: text.slice(at + 2) }; });
    const pipeUse = new Map();
    for (const { target } of entries) if (target.startsWith('pipe:')) pipeUse.set(target, (pipeUse.get(target) ?? 0) + 1);
    return entries.filter(({ fd, target }) => fd >= 3 && !ROLE_ALLOW[role].includes(fd) && !NODE_INTERNAL.has(target) && !(target.startsWith('pipe:') && pipeUse.get(target) >= 2) && target !== '?')
        .concat(entries.filter(({ target }) => /(^|\/)ptmx$/u.test(target)));
}

// ---- positive control: a plain child holding the master by inheritance must be detected ---------------------------------------
// `masterFd` is a descriptor of this process on the same node as `masters` (the supervisor's): the one handed to it, or the
// supervisor's master re-opened through /proc/<pid>/fd/<n> (for a PTY master that opens a new master on the same node).
const reopenMaster = (pid, entry) => { try { return fs.openSync(`/proc/${pid}/fd/${entry.fd}`, fs.constants.O_RDWR | fs.constants.O_NOCTTY); } catch { return null; } };
async function positiveControl(masterFd, masters, supervisorPid = null) {
    if (masterFd === null) { check('C positive control: a child that inherited the master is detected', false, { error: 'no local descriptor of the master', supervisorPid }); return; }
    const stdio = ['ignore', 'ignore', 'ignore', ...Array(LEAK_FD - 3).fill('ignore'), masterFd];
    const child = spawn('/bin/sleep', ['3'], { stdio });
    const closed = new Promise((resolve) => child.once('close', resolve));
    await sleep(200);
    const keys = new Set(masters.map(identityKey));
    const held = (fdsOf(child.pid) ?? []).filter((entry) => entry.dev !== null && keys.has(identityKey(entry)));
    child.kill('SIGKILL');
    await closed;
    check('C positive control: a child that inherited the master is detected', held.length > 0, { fds: held.map((entry) => entry.fd), supervisorPid });
}

// ---- modes ---------------------------------------------------------------------------------------------------------------------
export function nodePtyPreload(moduleDir) {
    const modulePath = path.resolve(moduleDir);
    const preload = `import { createRequire } from 'node:module'; const pty = createRequire(${JSON.stringify(path.join(modulePath, 'package.json'))})(${JSON.stringify(modulePath)}); `
        + "globalThis.__ptyleakA = pty.spawn('/bin/sh', ['-c', 'sleep 3600'], { name: 'xterm', cols: 80, rows: 24, env: { PATH: '/usr/bin:/bin' } });";
    return `data:text/javascript,${encodeURIComponent(preload)}`;
}

async function defaultMode() {
    evidence.mode = opt('--node-pty') ? 'node-pty' : 'inherited';
    const ptmx = fs.openSync('/dev/ptmx', fs.constants.O_RDWR | fs.constants.O_NOCTTY);
    const args = [];
    const ptyDir = opt('--node-pty');
    if (ptyDir) {
        // robot A's terminal opened by node-pty inside the supervisor process itself (the real T1 mechanism)
        args.push('--import', nodePtyPreload(ptyDir));
    }
    args.push(path.join(HERE, 'ptyLeakFixture.mjs'));
    const stdio = ['pipe', 'pipe', 'inherit', ...Array(LEAK_FD - 3).fill('ignore'), ptyDir ? 'ignore' : ptmx];
    const child = spawn(process.execPath, args, { stdio });
    let buffer = '';
    let fixtureResult;
    let readyResolve;
    let readyReject;
    const ready = new Promise((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
    // P0 and its positive control run before awaiting readiness; keep early rejection handled meanwhile.
    ready.catch(() => {});
    child.stdin.on('error', readyReject);
    child.stdout.on('data', (chunk) => {
        buffer += chunk;
        let end;
        while ((end = buffer.indexOf('\n')) !== -1) {
            const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
            try {
                const message = JSON.parse(line);
                if (message.type === 'ready') readyResolve(message);
                else if (message.type === 'result') fixtureResult = message;
                else readyReject(new Error('unexpected fixture message'));
            } catch { readyReject(new Error('invalid fixture protocol')); }
        }
    });
    const exited = new Promise((resolve) => {
        child.on('error', (error) => { readyReject(error); resolve({ code: null, signal: null, error: error.code }); });
        child.on('close', (code, signal) => { readyReject(new Error('fixture exited before ready')); resolve({ code, signal }); });
    });

    // P0: wait (at most 20 s) for the supervisor to hold a master without close-on-exec, then sample until it exits
    let masters = [];
    for (let waited = 0; waited < 20000 && masters.length === 0; waited += 5) { masters = leakableMasters(child.pid); if (masters.length === 0) await sleep(5); }
    check('P0 the supervisor holds a PTY master without close-on-exec', masters.length > 0, { fds: masters.map((entry) => entry.fd), ttyIndex: masters.map((entry) => entry.ttyIndex), unknownIdentity: unknownMasters(child.pid) });
    const sampler = createSampler({ supervisorPid: child.pid, masters });
    let measurement;
    try {
        const local = ptyDir && masters.length > 0 ? reopenMaster(child.pid, masters[0]) : ptmx;
        try { await positiveControl(local, masters, child.pid); }
        finally { if (ptyDir && local !== null) fs.closeSync(local); }
        if (masters.length === 0) throw new Error('no master precondition');
        measurement = await measureFixture({
            sample: () => sampler.sample(), ready,
            start: () => child.stdin.write('start\n'),
            validate: ({ held }) => validateHeld(held, { descriptors: fdsOf }),
            finish: (validated) => child.stdin.end(validated ? 'finish\n' : 'abort\n'),
            cleanup: async () => {
                const result = await exited;
                evidence.fixture = { exit: result, result: fixtureResult ?? null };
                check('C fixture teardown completed after measurement', result.code === 0 && fixtureResult?.ok === true);
            },
        });
        check('C held roles remained alive and readable through measurement finish', true, { held: measurement.held });
    } catch (error) {
        check('C controlled measurement completed', false, { error: String(error.message).slice(0, 500) });
        if (!child.stdin.writableEnded) child.stdin.end('abort\n');
        await exited;
    } finally {
        fs.closeSync(ptmx);
    }
    report(sampler);
    const snapshots = Object.fromEntries(['orchestration', 'endpoint', 'workload'].map((role) => [role, measurement?.snapshots?.[role]?.fds]));
    for (const [role, snapshot] of Object.entries(snapshots)) {
        const bad = outsideAllowlist(snapshot, role);
        check(`L2 ${role}: the probe's own descriptors are its allowlist (plus Node's own), no PTY master`, Array.isArray(snapshot) && bad.length === 0, { snapshot: snapshot ?? null, outside: bad });
    }
    evidence.pending.push('terminal: fd-only fixture starts no terminal sandbox; use controlled --watch with real robot terminals');
}

function report(sampler) {
    evidence.counts = Object.fromEntries(Object.entries(sampler.seen).map(([kind, pids]) => [kind, pids.size]));
    evidence.counts.samples = sampler.samples;
    evidence.counts.acceptedWindowHolders = sampler.window.size;
    evidence.counts.unreadable = sampler.unreadable;
    evidence.counts.vanished = sampler.vanished;
    check('L1 no prep, bwrap or sandbox process of B holds A\'s PTY master (nor a PTY master of unknown identity)', sampler.violations.length === 0, { violations: sampler.violations.slice(0, 20) });
    const blind = [...sampler.lastUnreadable.values()];
    check('L1 no unreadable or changed-identity observation during measurement', blind.length === 0, { unreadable: blind.slice(0, 20), count: blind.length });
    for (const kind of ['prep', 'bwrap', 'orchestration', 'endpoint', 'workload']) {
        if (evidence.mode === 'watch' && sampler.seen[kind].size === 0) { evidence.pending.push(`${kind}: no process sampled during the watch`); continue; }
        if (evidence.mode !== 'watch') check(`C at least one ${kind} process was sampled`, sampler.seen[kind].size > 0, { count: sampler.seen[kind].size });
    }
}

async function watchMode() {
    evidence.mode = 'watch';
    const seconds = Number(opt('--watch'));
    const workerPid = Number(opt('--worker-pid'));
    if (!(seconds >= 1 && seconds <= 86400) || !Number.isSafeInteger(workerPid)) { process.stderr.write('--watch <1..86400> --worker-pid <pid> required\n'); process.exit(2); }
    const workerIdentity = readIdentity(workerPid);
    const masters = leakableMasters(workerPid);
    evidence.counts.workerMasters = masters.length;
    if (masters.length === 0) { evidence.pending.push('no PTY master without close-on-exec in the worker: open a robot terminal (T1) first'); finish(3); }
    const local = reopenMaster(workerPid, masters[0]);
    await positiveControl(local, masters, workerPid);
    if (local !== null) fs.closeSync(local);
    const sampler = createSampler({ supervisorPid: workerPid, masters });
    const until = Date.now() + seconds * 1000;
    const controlled = argv.includes('--controlled');
    let request = null;
    let closed = false;
    const input = controlled ? readline.createInterface({ input: process.stdin }) : null;
    input?.on('line', (line) => {
        try {
            const message = JSON.parse(line);
            request = message.type === 'finish' ? message : { type: 'invalid' };
        } catch { request = { type: 'invalid' }; }
    });
    input?.on('close', () => { closed = true; });
    sampler.sample();
    if (controlled) progress('MEASUREMENT_READY');
    let reported = '';
    while (Date.now() < until && (!controlled || (!request && !closed))) {
        sampler.sample();
        if (controlled) {
            const counts = Object.fromEntries(Object.entries(sampler.seen).map(([kind, entries]) => [kind, entries.size]));
            const next = JSON.stringify(counts);
            if (next !== reported) { progress(`MEASUREMENT_COVERAGE ${next}`); reported = next; }
        }
        await sleep(5);
    }
    if (controlled) {
        check('C explicit finish before watch deadline', request?.type === 'finish' && Date.now() < until);
        sampler.sample();
        const verdict = validateWatchFinish(sampler, request?.monitors);
        sampler.sample();
        const after = readIdentity(workerPid);
        check('C worker identity unchanged', workerIdentity !== null && after !== null && processKey(workerIdentity) === processKey(after));
        check('C ledger-bound roles remained alive and readable at watch finish', verdict.failures.length === 0, verdict);
        input.close();
    }
    report(sampler);
    if (sampler.seen.terminal.size === 0) evidence.pending.push('terminal: no terminal sandbox sampled (set PTYLEAK_TERMINAL_ARGV to a fragment of the terminal command once T1 exists)');
}

async function detectorSelfTest() {
    evidence.mode = 'detector-self-test';
    const ptmx = fs.openSync('/dev/ptmx', fs.constants.O_RDWR | fs.constants.O_NOCTTY);
    const masters = (fdsOf(process.pid) ?? []).filter((entry) => entry.fd === ptmx);
    check('P0 a master was opened', masters.length === 1 && isMaster(masters[0]), { target: masters[0]?.target ?? null });
    await positiveControl(ptmx, masters);
    fs.closeSync(ptmx);
}

function finish(code = evidence.errors.length === 0 ? 0 : 1) {
    fs.writeFileSync(1, `${JSON.stringify(evidence, null, 2)}\n`);
    process.exit(code);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) try {
    if (argv.includes('--detector-self-test')) await detectorSelfTest();
    else if (opt('--watch') !== null) await watchMode();
    else await defaultMode();
} catch (error) {
    check('probe ran', false, { message: String(error?.message ?? error).slice(0, 300) });
} finally { finish(); }
