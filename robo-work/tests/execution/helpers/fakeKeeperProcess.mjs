// A FAKE keeper for the keeper client tests, and the fake /proc it is judged through. Never G1 evidence: nothing here
// creates a namespace, a pty or a mount. It exists so that the production client (keeperClient.mjs), the production
// view (procView.mjs) and the production schema (keeperFrames.mjs) can be exercised against a real child process on the
// Mac.
//
// Shape:
//   - The child is real. The client spawns `executable`, a generated wrapper: `python3 -I` records the descriptor table
//     it was started with (Node opens descriptors of its own at startup, Python -I does not) and execs Node on this file
//     in child mode. The child relays the bytes of fd 3 to the test process over a Unix socket and writes back what the
//     test process tells it to. Its own process.argv is the keeper argv the client built.
//   - The keeper's behaviour runs in the test process (the "brain"): a conforming keeper model that applies the
//     production request validator and the keeper-side admission (in-flight and pty window), answers every v1 op, and
//     writes fake /proc entries for the processes and descriptors it reports. Tests override single ops (hold a reply,
//     never answer, refuse) through `onRequest`.
//   - The fake /proc is a directory tree with the files procView reads: <pid>/stat, cmdline, ns/{pid,net,mnt} links,
//     fd/<n> links (namespace links as dangling `net:[N]` text; a pty holder as a link to a real file whose st_dev is the
//     pty's devptsDev; everything else /dev/null), <pid>/mountinfo, and self/.
//   - Fake pids start at 200000 and the view is built with a recording `signal`, so no real process is ever signalled.

import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createFrameDecoder, encodeFrame } from '../../../server/execution/frameCodec.mjs';
import {
    KEEPER_PROTOCOL, KEEPER_PROTOCOL_VERSION, PROCESS_BEARING_CREATE_KINDS, createKeeperAdmission, validateKeeperRequest
} from '../../../server/execution/keeperFrames.mjs';
import { HELLO_LIMIT_NAMES, KEEPER_CHANNEL_LIMIT_NAMES, KEEPER_LIMIT_DEFAULTS } from '../../../server/execution/keeperLimits.mjs';
import { ENDPOINT_LIMIT_DEFAULTS } from '../../../server/execution/executionLimits.mjs';
import { VIEW_LIMIT_DEFAULTS } from '../../../server/views/viewLimits.mjs';
import { findPython } from './topology.mjs';

const HERE = fileURLToPath(import.meta.url);
export const SELF_PID_NS = '4026531836';
export const SELF_NET_NS = '4026531840';
export const SELF_MNT_NS = '4026531841';
const SELF_MOUNTINFO = '22 1 0:21 / / rw,relatime - apfs /dev/root rw\n';

// ===================================================================================== child mode (the real process)

if (process.argv[2] === '--child') {
    const controlPath = process.argv[3];
    const control = net.connect(controlPath);
    const channel = new net.Socket({ fd: 3, readable: true, writable: true });
    const tell = (message) => { try { control.write(`${JSON.stringify(message)}\n`); } catch { /* host gone */ } };
    control.on('error', () => process.exit(0));
    control.on('close', () => process.exit(0));
    control.on('connect', () => {
        tell({ t: 'hello', pid: process.pid, ppid: process.ppid, argv: process.argv, layout: JSON.parse(process.env.FAKE_KEEPER_LAYOUT ?? 'null') });
    });
    channel.on('data', (chunk) => tell({ t: 'data', b64: chunk.toString('base64') }));
    channel.on('end', () => tell({ t: 'eof' }));
    channel.on('error', () => tell({ t: 'eof' }));
    let buffered = '';
    control.on('data', (chunk) => {
        buffered += chunk.toString('utf8');
        for (let index = buffered.indexOf('\n'); index >= 0; index = buffered.indexOf('\n')) {
            const message = JSON.parse(buffered.slice(0, index));
            buffered = buffered.slice(index + 1);
            if (message.t === 'write') channel.write(Buffer.from(message.b64, 'base64'));
            else if (message.t === 'raw') channel.write(Buffer.from(message.b64, 'base64'));
            else if (message.t === 'close3') channel.destroy();
            else if (message.t === 'stderr') fs.writeSync(2, message.text);
            else if (message.t === 'exit') {
                // Flush what was written to fd 3 first, so a final reply is not lost.
                if (channel.writableLength === 0) process.exit(message.code);
                channel.once('drain', () => process.exit(message.code));
                setTimeout(() => process.exit(message.code), 200).unref();
            }
        }
    });
}

// ===================================================================================== the fake /proc

let worldCounter = 0;

export function createFakeWorld(t) {
    const base = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'rwk-'));
    // after hooks run in registration order, so the steps that must precede removal (ending fake keepers) are queued
    // here and run first.
    const beforeRemove = [];
    t.after(async () => {
        for (const step of beforeRemove.splice(0)) { try { await step(); } catch { /* best effort */ } }
        if (path.basename(base).startsWith('rwk-') && path.dirname(base) === fs.realpathSync(os.tmpdir())) fs.rmSync(base, { recursive: true, force: true });
    });
    worldCounter += 1;
    const world = {
        base,
        beforeRemove,
        procRoot: path.join(base, 'proc'),
        runtimeRoot: path.join(base, 'rt'),
        cgroupSubtree: path.join(base, 'cg'),
        devpts: path.join(base, 'pts'),
        grants: path.join(base, 'g'),
        signals: [],
        // pids that ignore SIGKILL and stay in /proc (a stuck task), and pids kept when their keeper exits
        stubborn: new Set(),
        keepOnKeeperExit: new Set(),
        nextPid: 200000 + worldCounter * 1000,
        nextInode: 4026600000 + worldCounter * 10000,
        nextStart: 900000 + worldCounter * 1000
    };
    for (const dir of [world.procRoot, world.runtimeRoot, world.cgroupSubtree, world.devpts, world.grants, path.join(world.runtimeRoot, 'x')]) fs.mkdirSync(dir, { recursive: true });
    world.statfs = (target) => ({ type: target === world.cgroupSubtree ? 0x63677270 : 0 });
    world.newPid = () => world.nextPid++;
    world.newInode = () => String(world.nextInode++);
    world.newStartTime = () => String(world.nextStart++);

    // self: the supervisor as the view sees it.
    const selfDir = path.join(world.procRoot, 'self');
    fs.mkdirSync(path.join(selfDir, 'ns'), { recursive: true });
    fs.symlinkSync(`pid:[${SELF_PID_NS}]`, path.join(selfDir, 'ns', 'pid'));
    fs.symlinkSync(`net:[${SELF_NET_NS}]`, path.join(selfDir, 'ns', 'net'));
    fs.symlinkSync(`mnt:[${SELF_MNT_NS}]`, path.join(selfDir, 'ns', 'mnt'));
    fs.writeFileSync(path.join(selfDir, 'mountinfo'), SELF_MOUNTINFO);

    const procDir = (pid) => path.join(world.procRoot, String(pid));
    world.exists = (pid) => fs.existsSync(procDir(pid));
    world.writeProcess = ({ pid, ppid, startTime, cmdline, pidNs = SELF_PID_NS, netNs = SELF_NET_NS, mntNs = SELF_MNT_NS, comm = 'fake', mountinfo = null }) => {
        const dir = procDir(pid);
        fs.mkdirSync(path.join(dir, 'ns'), { recursive: true });
        fs.mkdirSync(path.join(dir, 'fd'), { recursive: true });
        const fields = ['S', ppid, pid, pid, 0, -1, 4194304, 0, 0, 0, 0, 0, 0, 0, 0, 20, 0, 1, 0, startTime, 0, 0];
        fs.writeFileSync(path.join(dir, 'stat'), `${pid} (${comm}) ${fields.join(' ')}\n`);
        fs.writeFileSync(path.join(dir, 'cmdline'), cmdline.length === 0 ? '' : `${cmdline.join('\0')}\0`);
        for (const [type, inode] of [['pid', pidNs], ['net', netNs], ['mnt', mntNs]]) {
            const link = path.join(dir, 'ns', type);
            fs.rmSync(link, { force: true });
            fs.symlinkSync(`${type}:[${inode}]`, link);
        }
        for (const fd of [0, 1, 2]) world.addFd(pid, fd, '/dev/null');
        if (mountinfo !== null) fs.writeFileSync(path.join(dir, 'mountinfo'), mountinfo);
        return { pid, ppid, startTime, pidNs, netNs, mntNs };
    };
    world.removeProcess = (pid) => fs.rmSync(procDir(pid), { recursive: true, force: true });
    world.addFd = (pid, fd, target) => {
        const link = path.join(procDir(pid), 'fd', String(fd));
        fs.rmSync(link, { force: true });
        fs.symlinkSync(target, link);
        return fd;
    };
    world.nextFd = (pid) => {
        const used = new Set(fs.readdirSync(path.join(procDir(pid), 'fd')).map(Number));
        let fd = 10;
        while (used.has(fd)) fd += 1;
        return fd;
    };
    world.removeFd = (pid, fd) => fs.rmSync(path.join(procDir(pid), 'fd', String(fd)), { force: true });
    world.readStat = (pid) => fs.readFileSync(path.join(procDir(pid), 'stat'), 'utf8');
    world.ppidOf = (pid) => Number(world.readStat(pid).split(') ')[1].split(' ')[1]);
    world.pids = () => fs.readdirSync(world.procRoot).filter((name) => /^[0-9]+$/u.test(name)).map(Number);
    world.descendants = (pid) => {
        const out = new Set();
        for (let grew = true; grew;) {
            grew = false;
            for (const candidate of world.pids()) {
                if (out.has(candidate) || candidate === pid) continue;
                let ppid;
                try { ppid = world.ppidOf(candidate); } catch { continue; }
                if (ppid === pid || out.has(ppid)) { out.add(candidate); grew = true; }
            }
        }
        return [...out];
    };
    world.appendSelfMount = (line) => fs.appendFileSync(path.join(selfDir, 'mountinfo'), line);
    world.writeSelfMountinfo = (text) => fs.writeFileSync(path.join(selfDir, 'mountinfo'), text);
    // The recording signal of the view: a SIGKILL makes a fake process (and its descendants) go, unless it is stubborn.
    world.signal = (pid, name) => {
        world.signals.push({ pid, name });
        if (pid < 200000) throw new Error(`refusing to model a signal to non-fake pid ${pid}`);
        if (world.stubborn.has(pid)) return;
        for (const descendant of world.descendants(pid)) if (!world.stubborn.has(descendant)) world.removeProcess(descendant);
        world.removeProcess(pid);
    };
    // A real file whose device stands for a devpts instance.
    world.newPtyFile = (index) => {
        const file = path.join(world.devpts, `ptmx-${index}`);
        fs.writeFileSync(file, '');
        return { file, dev: String(fs.statSync(file, { bigint: true }).dev) };
    };
    // A directory opened for a grant root or HOME slot.
    world.openDir = (t2, name) => {
        const dir = path.join(world.grants, name);
        fs.mkdirSync(dir, { recursive: true });
        const fd = fs.openSync(dir, 'r');
        t2.after(() => { try { fs.closeSync(fd); } catch { /* closed */ } });
        const stat = fs.fstatSync(fd, { bigint: true });
        return { fd, identity: { dev: String(stat.dev), ino: String(stat.ino) }, dir };
    };
    return world;
}

// ===================================================================================== keeper argv (as the keeper reads it)

export function parseKeeperArgv(argv) {
    const serve = argv.indexOf('serve');
    if (serve < 0) throw new Error('no serve subcommand');
    const out = { channelLimits: {}, viewLimits: {}, homeIdentity: null, orchestrationRoot: null, cgroupSubtree: null };
    for (let index = serve + 1; index < argv.length; index += 2) {
        const flag = argv[index];
        const value = argv[index + 1];
        if (value === undefined) throw new Error(`flag ${flag} has no value`);
        switch (flag) {
            case '--protocol': out.protocol = value; break;
            case '--reservation': out.marker = value; break;
            case '--parent-pid': out.parentPid = Number(value); break;
            case '--scope': out.scope = value; break;
            case '--runtime-root': out.runtimeRoot = value; break;
            case '--ala': out.ala = value === '1'; break;
            case '--grant-roots': out.grantRoots = Number(value); break;
            case '--home-identity': out.homeIdentity = value; break;
            case '--orchestration-root': out.orchestrationRoot = value; break;
            case '--cgroup-subtree': {
                const match = /^([0-9]{1,20}):([0-9]{1,20}):(\/.*)$/u.exec(value);
                if (out.cgroupSubtree !== null || !match || BigInt(match[1]) > 18446744073709551615n || BigInt(match[2]) > 18446744073709551615n
                    || match[3] === '/' || match[3].includes('\0') || path.posix.normalize(match[3]) !== match[3]
                    || match[3].endsWith('/') || Buffer.byteLength(match[3]) > 989) throw new Error('invalid cgroup subtree');
                out.cgroupSubtree = { dev: match[1], ino: match[2], path: match[3] };
                break;
            }
            case '--channel-limit': case '--view-limit': {
                const [name, number] = value.split('=');
                (flag === '--channel-limit' ? out.channelLimits : out.viewLimits)[name] = Number(number);
                break;
            }
            default: throw new Error(`unknown flag ${flag}`);
        }
    }
    return out;
}

// ===================================================================================== the host and the keeper brain

function shortSocketPath(world) {
    return path.join(world.base, 'c.sock');
}

function writeWrapper(world, controlPath) {
    const python = findPython();
    const wrapper = path.join(world.base, 'keeper');
    const source = `#!${python} -I
import json, os, stat, sys
layout = []
for fd in range(0, 24):
    try:
        s = os.fstat(fd)
    except OSError:
        continue
    kind = 'socket' if stat.S_ISSOCK(s.st_mode) else 'dir' if stat.S_ISDIR(s.st_mode) else 'char' if stat.S_ISCHR(s.st_mode) else 'fifo' if stat.S_ISFIFO(s.st_mode) else 'file'
    layout.append({'fd': fd, 'type': kind, 'dev': str(s.st_dev), 'ino': str(s.st_ino)})
report = {'fds': layout, 'environ': sorted(os.environ.keys())}
os.execve(${JSON.stringify(process.execPath)}, [${JSON.stringify(process.execPath)}, ${JSON.stringify(HERE)}, '--child', ${JSON.stringify(controlPath)}] + sys.argv[1:], {'FAKE_KEEPER_LAYOUT': json.dumps(report)})
`;
    fs.writeFileSync(wrapper, source, { mode: 0o755 });
    return wrapper;
}

// options: { onRequest(frame, keeper) -> undefined (default) | 'hold' | 'ignore' | { ok, value } | { refused } | { failure },
//            hello(frame) -> frame (to falsify the hello), sendHello: true, exitOnEof: true, stuck: false (the keeper's
//            /proc entry stays after it exits), onCommitReceived(frame, keeper), limitsCheck: true }
export async function createFakeKeeperHost(t, world, options = {}) {
    const controlPath = shortSocketPath(world);
    const keepers = [];
    const log = { keepers };
    const host = { world, log, options, keepers, executable: null, latest: () => keepers.at(-1) ?? null };
    let resolveFirst;
    host.connected = new Promise((resolve) => { resolveFirst = resolve; });
    const server = net.createServer((socket) => {
        let buffered = '';
        let keeper = null;
        socket.on('data', (chunk) => {
            buffered += chunk.toString('utf8');
            for (let index = buffered.indexOf('\n'); index >= 0; index = buffered.indexOf('\n')) {
                const message = JSON.parse(buffered.slice(0, index));
                buffered = buffered.slice(index + 1);
                if (message.t === 'hello') {
                    keeper = createBrain(host, socket, message);
                    keepers.push(keeper);
                    resolveFirst(keeper);
                } else if (message.t === 'data') keeper?.push(Buffer.from(message.b64, 'base64'));
                else if (message.t === 'eof') keeper?.onEof();
            }
        });
        socket.on('error', () => {});
        socket.on('close', () => keeper?.onGone());
    });
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(controlPath, resolve); });
    world.beforeRemove.push(async () => {
        for (const keeper of keepers) keeper.kill();
        await Promise.race([Promise.all(keepers.map((keeper) => keeper.whenGone())), new Promise((resolve) => setTimeout(resolve, 1000).unref())]);
        await new Promise((resolve) => { server.close(() => resolve()); setTimeout(resolve, 200).unref(); });
    });
    host.executable = writeWrapper(world, controlPath);
    return host;
}

function createBrain(host, socket, message) {
    const { world, options } = host;
    const parsed = parseKeeperArgv(message.argv);
    const limits = { ...KEEPER_LIMIT_DEFAULTS, ...parsed.channelLimits };
    const viewLimits = { ...VIEW_LIMIT_DEFAULTS, ...parsed.viewLimits };
    const admission = createKeeperAdmission(limits, viewLimits);
    // Like the native keeper, an unknown --channel-limit name is refused (recorded here; the native keeper exits 64).
    const unknownChannelLimits = Object.keys(parsed.channelLimits).filter((name) => !KEEPER_CHANNEL_LIMIT_NAMES.includes(name));
    const keeper = {
        pid: message.pid, ppid: message.ppid, argv: message.argv, layout: message.layout, parsed, limits, viewLimits,
        startTime: world.newStartTime(), committed: false, ending: false, gone: false, eof: false,
        frames: [], replies: [], violations: [], held: new Map(), ptyWrites: [], commits: [], events: [],
        handles: new Map(), mounts: [], mountFrames: [], runtimeLocatorId: null, mntNs: null, outSeq: new Map(), credit: new Map(),
        lastInput: new Map(), closedPtys: new Set(), maxOrdinaryInFlight: 0, maxPtyInFlight: 0, pendingIds: new Set(), ptyPending: new Set(),
        goneWaiters: [], unknownChannelLimits
    };
    keeper.whenGone = () => (keeper.gone ? Promise.resolve() : new Promise((resolve) => keeper.goneWaiters.push(resolve)));
    const tell = (msg) => { try { socket.write(`${JSON.stringify(msg)}\n`); } catch { /* gone */ } };
    keeper.writeRaw = (bytes) => tell({ t: 'raw', b64: Buffer.from(bytes).toString('base64') });
    keeper.send = (frame) => tell({ t: 'write', b64: encodeFrame(frame, { maxFrameBytes: 16 * 1024 * 1024 }).toString('base64') });
    keeper.stderr = (text) => tell({ t: 'stderr', text });
    keeper.exit = (code) => tell({ t: 'exit', code });
    keeper.closeChannel = () => tell({ t: 'close3' });
    // Only a child that has not gone (its control socket still open, so not yet reaped by the client) is signalled.
    keeper.kill = () => { if (keeper.gone) return; try { process.kill(keeper.pid, 'SIGKILL'); } catch { /* gone */ } };
    keeper.emit = (frame) => { keeper.events.push(frame); keeper.send(frame); };

    // /proc entry for the keeper itself (it is our test process's child: ppid is the real supervisor pid).
    world.writeProcess({ pid: keeper.pid, ppid: keeper.ppid, startTime: keeper.startTime, cmdline: message.argv, comm: 'keeper' });

    const reply = (frame, value) => {
        admission.settle(frame.id);
        keeper.pendingIds.delete(frame.id);
        keeper.ptyPending.delete(frame.id);
        const out = { id: frame.id, ok: true, value };
        keeper.replies.push(out);
        keeper.send(out);
    };
    const refuse = (frame, error, kind = 'refused') => {
        admission.settle(frame.id);
        keeper.pendingIds.delete(frame.id);
        keeper.ptyPending.delete(frame.id);
        const out = { id: frame.id, ok: false, kind, error };
        keeper.replies.push(out);
        keeper.send(out);
    };
    keeper.reply = reply;
    keeper.refuse = refuse;
    // A reply and an event in ONE write to fd 3, so the supervisor reads them in one chunk. For a commit reply the model's
    // entry is updated as the default handler would.
    keeper.replyThenEvent = (frame, answer, event) => {
        admission.settle(frame.id);
        keeper.pendingIds.delete(frame.id);
        const out = answer.ok === false ? { id: frame.id, ok: false, kind: answer.kind, error: answer.error } : { id: frame.id, ok: true, value: answer.value };
        // ok (executed) and failure (commit_failed) both mark the entry committed (R2.1).
        if (frame.op === 'commit' && (out.ok || out.kind === 'failure')) { const entry = keeper.handles.get(frame.resource); if (entry) { entry.committed = true; keeper.commits.push(frame.resource); } }
        keeper.replies.push(out);
        keeper.events.push(event);
        tell({ t: 'write', b64: Buffer.concat([encodeFrame(out, { maxFrameBytes: 16 * 1024 * 1024 }), encodeFrame(event, { maxFrameBytes: 16 * 1024 * 1024 })]).toString('base64') });
    };
    keeper.release = (id) => { const held = keeper.held.get(id); if (held) { keeper.held.delete(id); held(); } };
    keeper.releaseAll = () => { for (const id of [...keeper.held.keys()]) keeper.release(id); };

    const violation = (code) => {
        keeper.violations.push(code);
        // A keeper that sees a malformed supervisor frame tears down as on EOF and exits 65.
        teardownAll();
        keeper.exit(65);
    };

    const decoder = createFrameDecoder({
        maxFrameBytes: limits.maxFrameBytes, partialFrameDeadlineMs: limits.partialFrameDeadlineMs,
        onFrame: (frame) => handle(frame), onViolation: (code) => violation(code)
    });
    keeper.push = (chunk) => decoder.push(chunk);
    keeper.onEof = () => {
        keeper.eof = true;
        if (options.exitOnEof === false) return;
        teardownAll();
        keeper.exit(66);
    };
    keeper.onGone = () => {
        keeper.gone = true;
        decoder.close();
        for (const resolve of keeper.goneWaiters.splice(0)) resolve();
        if (!fs.existsSync(world.procRoot)) return; // the test has already removed its world
        // Kernel teardown of the keeper's process and its children, unless the test keeps them.
        try {
            const victims = [...world.descendants(keeper.pid)];
            for (const pid of victims) if (!world.keepOnKeeperExit.has(pid) && !world.stubborn.has(pid)) world.removeProcess(pid);
            if (options.stuck !== true) world.removeProcess(keeper.pid);
        } catch { /* the world is being removed */ }
    };

    function context() {
        return {
            limits, viewLimits, endpointLimits: ENDPOINT_LIMIT_DEFAULTS, runtimeRoot: parsed.runtimeRoot,
            keeperReservation: parsed.marker, cgroupSubtree: parsed.cgroupSubtree?.path ?? null,
            mount: { scope: parsed.scope === 'gui' ? 'gui' : 'execution', runtimeRoot: parsed.runtimeRoot, reservationId: keeper.runtimeLocatorId, grantCount: parsed.grantRoots, prior: keeper.mountFrames }
        };
    }

    function handle(frame) {
        keeper.frames.push({ frame, at: performance.now() });
        if (!keeper.committed) {
            if (frame.op !== 'commit_keeper') { violation('not_commit_keeper'); return; }
        }
        const verdict = validateKeeperRequest(frame, context());
        if (verdict.violation) { violation(verdict.violation); return; }
        const admitted = admission.admit(frame);
        if (!admitted.ok) { violation(admitted.violation); return; }
        if (frame.op === 'pty_input') {
            keeper.ptyPending.add(frame.id);
            keeper.maxPtyInFlight = Math.max(keeper.maxPtyInFlight, keeper.ptyPending.size);
        } else {
            keeper.pendingIds.add(frame.id);
            keeper.maxOrdinaryInFlight = Math.max(keeper.maxOrdinaryInFlight, keeper.pendingIds.size);
        }
        if (verdict.refused) { refuse(frame, verdict.refused); return; }
        if (frame.op === 'commit') options.onCommitReceived?.(frame, keeper);
        const decision = options.onRequest?.(frame, keeper);
        if (decision === 'ignore') return;
        if (decision === 'hold') { keeper.held.set(frame.id, () => defaultHandle(frame)); return; }
        if (decision && typeof decision === 'object') {
            if (decision.refused) refuse(frame, decision.refused);
            else if (decision.failure) refuse(frame, decision.failure, 'failure');
            else reply(frame, decision.value);
            return;
        }
        defaultHandle(frame);
    }

    // ---- the conforming model --------------------------------------------------------------------------------------

    const entryOf = (handle) => keeper.handles.get(handle);
    const netnsOf = (handle) => entryOf(handle)?.netNs ?? null;

    function removeEntry(entry) {
        if (entry.pid) {
            for (const pid of world.descendants(entry.pid)) if (!world.stubborn.has(pid)) world.removeProcess(pid);
            if (!world.stubborn.has(entry.pid)) world.removeProcess(entry.pid);
        }
        if (entry.fd !== undefined && world.exists(keeper.pid)) world.removeFd(keeper.pid, entry.fd);
        if (entry.dir) fs.rmSync(entry.dir, { recursive: true, force: true });
    }

    function teardownAll() {
        if (keeper.tornDown) return;
        keeper.tornDown = true;
        for (const entry of keeper.handles.values()) removeEntry(entry);
        for (const mount of keeper.mounts) removeMount(mount);
    }

    function spawnStage(kind, frame, netNs) {
        const pid = world.newPid();
        const stage = world.writeProcess({
            pid, ppid: keeper.pid, startTime: world.newStartTime(), pidNs: world.newInode(), netNs: netNs ?? SELF_NET_NS,
            cmdline: [`/usr/local/libexec/robo-work/${kind}`, '--reservation', frame.marker], comm: kind
        });
        return stage;
    }

    function createDefault(frame) {
        if (keeper.handles.has(frame.resource)) return refuse(frame, 'duplicate_resource');
        if (keeper.ending) return refuse(frame, 'execution_ending');
        const spec = frame.spec;
        for (const ref of [spec.netns, spec.pty]) {
            if (typeof ref === 'string' && entryOf(ref)?.committed !== true) return refuse(frame, 'resource_not_committed');
        }
        const entry = { kind: frame.kind, handle: frame.resource, committed: false, marker: frame.marker, role: spec.role ?? null };
        let identity;
        switch (frame.kind) {
            case 'runtime-dir': {
                fs.mkdirSync(frame.locator.path, { mode: 0o700 });
                fs.chmodSync(frame.locator.path, 0o700);
                const stat = fs.lstatSync(frame.locator.path, { bigint: true });
                entry.dir = frame.locator.path;
                keeper.runtimeLocatorId = path.basename(frame.locator.path);
                identity = { path: frame.locator.path, dev: String(stat.dev), ino: String(stat.ino) };
                break;
            }
            case 'cgroup': {
                fs.mkdirSync(frame.locator.path);
                entry.dir = frame.locator.path;
                identity = { path: frame.locator.path, cgroupId: String(fs.statSync(frame.locator.path, { bigint: true }).ino) };
                break;
            }
            case 'netns': {
                entry.netNs = world.newInode();
                entry.fd = world.addFd(keeper.pid, world.nextFd(keeper.pid), `net:[${entry.netNs}]`);
                identity = { netNs: entry.netNs };
                break;
            }
            case 'pty': {
                const index = keeper.handles.size;
                const pty = world.newPtyFile(index);
                entry.fd = world.addFd(keeper.pid, world.nextFd(keeper.pid), pty.file);
                entry.devptsDev = pty.dev;
                keeper.outSeq.set(frame.resource, 0n);
                keeper.credit.set(frame.resource, 0);
                keeper.lastInput.set(frame.resource, 0n);
                identity = { pty: frame.locator.pty, devptsDev: pty.dev, index };
                break;
            }
            case 'endpoint':
            case 'process-tree': {
                const netNs = spec.role === 'orchestration' ? world.newInode() : (spec.netns ? netnsOf(spec.netns) : null);
                const stage = spawnStage(frame.kind === 'endpoint' ? 'endpoint' : spec.role, frame, netNs);
                entry.pid = stage.pid;
                entry.process = spec.process ?? null;
                identity = { pid: stage.pid, startTime: stage.startTime, pidNs: stage.pidNs };
                break;
            }
            default:
                return refuse(frame, 'kind_not_supported');
        }
        entry.identity = identity;
        keeper.handles.set(frame.resource, entry);
        return reply(frame, { resource: frame.resource, identity });
    }

    function removeMount(mount) {
        if (mount.removed) return;
        mount.removed = true;
        if (!world.stubborn.has(mount.fileServer.pid)) world.removeProcess(mount.fileServer.pid);
    }

    function mountDefault(frame) {
        if (keeper.ending) return refuse(frame, 'execution_ending');
        keeper.mountFrames.push(frame);
        if (keeper.mntNs === null) {
            keeper.mntNs = world.newInode();
            keeper.mntFd = world.addFd(keeper.pid, world.nextFd(keeper.pid), `mnt:[${keeper.mntNs}]`);
        }
        const mountId = 500 + keeper.mounts.length;
        const resource = `m${crypto.randomBytes(16).toString('hex')}`;
        const pid = world.newPid();
        const server = world.writeProcess({
            pid, ppid: keeper.pid, startTime: world.newStartTime(), pidNs: world.newInode(), mntNs: keeper.mntNs, comm: 'file-server',
            cmdline: ['/usr/local/libexec/robo-work/file-server'],
            mountinfo: `${mountId} 22 0:${90 + keeper.mounts.length} / ${frame.mountpoint} rw,nosuid - fuse.rw-view rw-view rw\n`
        });
        const value = {
            resource,
            mount: { mountId, mountpoint: frame.mountpoint, mountNamespaceInode: keeper.mntNs },
            fileServer: { pid: server.pid, startTime: server.startTime, pidNamespaceInode: server.pidNs }
        };
        const mount = { resource, mountId, mountpoint: frame.mountpoint, fileServer: value.fileServer, committed: false, grantId: frame.grantId };
        keeper.mounts.push(mount);
        keeper.handles.set(resource, { kind: 'mount', handle: resource, committed: false, mount, pid: null });
        return reply(frame, value);
    }

    function defaultHandle(frame) {
        switch (frame.op) {
            case 'commit_keeper': keeper.committed = true; return reply(frame, {});
            case 'ping': return reply(frame, {});
            case 'create': return createDefault(frame);
            case 'commit': {
                const entry = entryOf(frame.resource);
                if (!entry) return refuse(frame, 'unknown_resource');
                if (entry.committed || entry.aborted) return refuse(frame, 'already_committed');
                if (PROCESS_BEARING_CREATE_KINDS.includes(entry.kind) && entry.pid && !world.exists(entry.pid)) return refuse(frame, 'gate_closed');
                entry.committed = true;
                if (entry.mount) entry.mount.committed = true;
                keeper.commits.push(frame.resource);
                return reply(frame, { state: PROCESS_BEARING_CREATE_KINDS.includes(entry.kind) ? 'executed' : 'committed' });
            }
            case 'abort_uncommitted': {
                if (frame.resources.some((handle) => entryOf(handle)?.committed === true)) return refuse(frame, 'already_committed');
                for (const handle of frame.resources) {
                    const entry = entryOf(handle);
                    if (!entry || entry.aborted) continue;
                    if (entry.mount) removeMount(entry.mount); else removeEntry(entry);
                    if (entry.mount) keeper.handles.delete(handle); else entry.aborted = true;
                }
                return reply(frame, {});
            }
            case 'stop': {
                const entry = entryOf(frame.resource);
                if (!entry) return refuse(frame, 'unknown_resource');
                if (!entry.pid) return refuse(frame, 'not_a_process');
                if (entry.exited || (!entry.aborted && !world.exists(entry.pid))) {
                    entry.exited = true;
                    return reply(frame, { state: 'exited' });
                }
                if (!entry.committed) return refuse(frame, 'resource_not_committed');
                if (!entry.exited) {
                    removeEntry(entry);
                    entry.exited = true;
                    keeper.emit({ event: 'exit', resource: frame.resource, code: null, signal: 'SIGTERM' });
                }
                return reply(frame, { state: 'exited' });
            }
            case 'tempdir': {
                if (keeper.runtimeLocatorId === null) return refuse(frame, 'runtime_dir_missing');
                return reply(frame, { path: `/tmp/ala-${crypto.createHash('sha256').update(keeper.runtimeLocatorId).digest('hex').slice(0, 16)}` });
            }
            case 'end_process_trees': {
                keeper.ending = true;
                for (const entry of keeper.handles.values()) {
                    if (entry.kind === 'process-tree' || entry.kind === 'pty') removeEntry(entry);
                    if (entry.kind === 'pty') keeper.closedPtys.add(entry.handle);
                }
                return reply(frame, {});
            }
            case 'end_endpoint':
                keeper.ending = true;
                for (const entry of keeper.handles.values()) if (entry.kind === 'endpoint') removeEntry(entry);
                return reply(frame, {});
            case 'release_egress':
                keeper.ending = true;
                for (const entry of keeper.handles.values()) if (entry.kind === 'netns') removeEntry(entry);
                return reply(frame, {});
            case 'release_views':
                keeper.ending = true;
                for (const mount of keeper.mounts) removeMount(mount);
                if (keeper.mntFd !== undefined && world.exists(keeper.pid)) world.removeFd(keeper.pid, keeper.mntFd);
                return reply(frame, {});
            case 'remove_runtime':
                keeper.ending = true;
                for (const entry of keeper.handles.values()) if (entry.kind === 'runtime-dir' || entry.kind === 'cgroup') removeEntry(entry);
                reply(frame, {});
                keeper.exit(0);
                return undefined;
            case 'shutdown':
                teardownAll();
                reply(frame, {});
                keeper.exit(0);
                return undefined;
            case 'inventory':
                return reply(frame, {
                    resources: [...keeper.handles.values()].map((entry) => ({ resource: entry.handle, kind: entry.kind, state: entry.aborted ? 'aborted' : entry.committed ? 'committed' : 'reserved' })),
                    descriptors: 3
                });
            case 'pty_input': {
                const entry = entryOf(frame.resource);
                if (!entry || entry.kind !== 'pty') return refuse(frame, 'unknown_resource');
                if (keeper.closedPtys.has(frame.resource)) return refuse(frame, 'pty_closed');
                const seq = BigInt(frame.seq);
                const last = keeper.lastInput.get(frame.resource);
                if (seq <= last) return reply(frame, { seq: frame.seq }); // replay: acknowledged, not written again
                if (seq !== last + 1n) return refuse(frame, 'sequence_gap');
                keeper.lastInput.set(frame.resource, seq);
                keeper.ptyWrites.push({ resource: frame.resource, seq: frame.seq, bytes: Buffer.from(frame.data, 'base64') });
                return reply(frame, { seq: frame.seq });
            }
            case 'pty_resize': {
                const entry = entryOf(frame.resource);
                if (!entry || entry.kind !== 'pty') return refuse(frame, 'unknown_resource');
                if (keeper.closedPtys.has(frame.resource)) return refuse(frame, 'pty_closed');
                return reply(frame, {});
            }
            case 'pty_credit': {
                const entry = entryOf(frame.resource);
                if (!entry || entry.kind !== 'pty') return refuse(frame, 'unknown_resource');
                const credit = keeper.credit.get(frame.resource) + frame.bytes;
                if (credit > limits.ptyMaxCreditBytes) return refuse(frame, 'credit_overflow');
                keeper.credit.set(frame.resource, credit);
                return reply(frame, {});
            }
            case 'mount_view': return mountDefault(frame);
            case 'unmount_view': {
                const entry = entryOf(frame.resource);
                if (!entry?.mount) return refuse(frame, 'unknown_resource');
                removeMount(entry.mount);
                return reply(frame, {});
            }
            case 'view_root_lease':
                if (!keeper.mounts.some((mount) => mount.grantId === frame.grantId && !mount.removed)) return refuse(frame, 'wrong_grant');
                return reply(frame, { state: 'live' });
            default: return refuse(frame, 'unknown_op');
        }
    }

    // PTY output with the next sequence number. `respectCredit: false` deliberately overruns.
    keeper.ptyOutput = (handle, bytes, { respectCredit = true } = {}) => {
        const data = Buffer.from(bytes);
        const credit = keeper.credit.get(handle) ?? 0;
        if (respectCredit && data.length > credit) return false;
        keeper.credit.set(handle, Math.max(0, credit - data.length));
        const seq = (keeper.outSeq.get(handle) ?? 0n) + 1n;
        keeper.outSeq.set(handle, seq);
        keeper.emit({ event: 'pty_output', resource: handle, seq: String(seq), data: data.toString('base64') });
        return true;
    };
    keeper.handleFor = (kind) => [...keeper.handles.values()].find((entry) => entry.kind === kind);

    if (options.sendHello !== false) {
        const hello = {
            event: 'hello', protocol: KEEPER_PROTOCOL, version: KEEPER_PROTOCOL_VERSION, pid: keeper.pid, startTime: keeper.startTime, marker: parsed.marker,
            limits: { ...Object.fromEntries(HELLO_LIMIT_NAMES.map((name) => [name, limits[name]])), rootLeaseTtlMs: viewLimits.rootLeaseTtlMs }
        };
        keeper.send(options.hello ? options.hello(hello, keeper) : hello);
    }
    return keeper;
}
