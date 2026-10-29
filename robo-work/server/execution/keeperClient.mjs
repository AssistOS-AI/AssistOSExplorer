// The production supervisor-side client of one keeper (keeper wire contract delta sections 2 to 6 and R1). It spawns
// the keeper with the fixed descriptor layout, verifies its hello through the supervisor's own view (procView.mjs),
// drives the v1 wire protocol (keeperFrames.mjs) with bounded in-flight accounting and a deadline on every request, and
// adapts it to the resource ledger (resourceLedger.mjs keeper interface) and to the provider endpoint server
// (supervisorEndpointServer.mjs keeper interface).
//
// Custody rules:
//   - Nothing is committed on a keeper's word. Every identity a keeper reports is checked against /proc (or the file
//     system) through the supervisor's view before the ledger may commit it; a mismatch aborts that creation and the
//     create rejects `identity_mismatch`. Only toLedgerIdentity produces committed identities.
//   - Loss before commitment never resubmits the work. A violation, a missed deadline, an unexpected exit or EOF ends
//     the channel: alive() turns false synchronously, every pending and queued call rejects with the reason, the
//     infrastructure loss is reported once, and the keeper is SIGKILLed through its ChildProcess after keeperExitWaitMs.
//   - The keeper is spawned on the main thread only (PR_SET_PDEATHSIG follows the forking thread), with an empty
//     environment and no Node message channel, so its only channels are the declared descriptors.
//   - In-flight bound (section 2, R1.2): ordinary ops take at most maxInFlight - reservedInFlight slots; the priority ops
//     (lease, ping, abort and end steps, shutdown) may use all maxInFlight. pty_input is outside that count: it has its
//     own per-pty window (ptyInputWindowFrames, ptyInputWindowBytes) and no deadline, so a terminal that does not read
//     can neither starve nor end the channel. A periodic ping with the normal deadline detects a hung keeper that has
//     no other periodic request (N-B).

import { spawn } from 'node:child_process';
import { isMainThread } from 'node:worker_threads';
import path from 'node:path';

import { ByteRing } from './controlStreamReader.mjs';
import { resolveEndpointLimits } from './executionLimits.mjs';
import { virtualPathProblem } from './providerSchema.mjs';
import { createFrameChannel } from './frameCodec.mjs';
import { channelLimitsForKeeper, helloLimits, resolveKeeperLimits } from './keeperLimits.mjs';
import {
    KEEPER_PROTOCOL, KEEPER_PROTOCOL_VERSION, MOUNT_OPS, PRIORITY_OPS, PROCESS_BEARING_CREATE_KINDS, acceptKeeperEvent, buildRequest,
    encodeBase64, isOriginId, keeperArgv, recordCommitReply, resourceHandle, toLedgerIdentity, validateKeeperReply, validateKeeperRequest
} from './keeperFrames.mjs';
import { grantRootSlots, viewMountpoint } from '../views/mountFrames.mjs';
import { createRootLeaseIssuer } from '../views/rootLease.mjs';
import { resolveViewLimits } from '../views/viewLimits.mjs';

export const KEEPER_EXECUTABLE = '/usr/local/libexec/robo-work/keeper';
const FIRST_EXTRA_SLOT = 8;
const MAX_ANCESTRY = 64;
const ABORT_BATCH = 64;

export class KeeperError extends Error {
    constructor(code, detail = null, kind = null) {
        super(detail ? `${code}: ${detail}` : code);
        this.name = 'KeeperError';
        this.code = code;
        this.kind = kind;
        this.detail = detail;
    }
}

const hasMarker = (cmdline, marker) => cmdline.some((value, index) => value === '--reservation' && cmdline[index + 1] === marker);

function inAncestry(view, entry, ancestorPid) {
    let current = entry;
    for (let depth = 0; depth < MAX_ANCESTRY && current; depth += 1) {
        if (current.ppid === ancestorPid) return true;
        if (current.ppid <= 1) return false;
        current = view.process(current.ppid);
    }
    return false;
}

// A gated stage the keeper reports: { pid, startTime, pidNs } on the wire. It must be alive with that start time and
// PID namespace, in a PID namespace other than the supervisor's, still carrying its marker after `--reservation` (it is
// at its gate), and a descendant of the keeper. Returns null or the first problem.
export function verifyProcessIdentity(view, wire, { marker, ancestorPid, supervisorPidNs }) {
    const entry = view.process(wire.pid);
    if (!entry) return 'process_absent';
    if (entry.startTime !== wire.startTime) return 'start_time_mismatch';
    if (entry.pidNs !== wire.pidNs) return 'pid_namespace_mismatch';
    if (entry.pidNs === supervisorPidNs) return 'shares_supervisor_pid_namespace';
    if (!hasMarker(entry.cmdline, marker)) return 'marker_missing';
    if (!inAncestry(view, entry, ancestorPid)) return 'not_a_keeper_descendant';
    return null;
}

// The keeper itself, from its hello: our direct child, with that start time, carrying its marker, in our PID namespace.
export function verifyKeeperIdentity(view, hello, { childPid, marker, supervisorPid }) {
    if (hello.pid !== childPid) return 'pid_mismatch';
    const entry = view.process(childPid);
    if (!entry) return 'process_absent';
    if (entry.startTime !== hello.startTime) return 'start_time_mismatch';
    if (entry.ppid !== supervisorPid) return 'not_a_supervisor_child';
    if (!hasMarker(entry.cmdline, marker)) return 'marker_missing';
    if (entry.pidNs !== view.selfNamespaces().pidNs) return 'pid_namespace_mismatch';
    return null;
}

function sameLimits(received, expected) {
    const keys = Object.keys(expected);
    return Object.keys(received).length === keys.length && keys.every((key) => received[key] === expected[key]);
}

const safely = (fn, ...args) => { try { fn?.(...args); } catch { /* a callback must not break the client */ } };

export function createExecutionKeeper({
    executable = KEEPER_EXECUTABLE, scope, runtimeRoot, ala = false, grantRoots = [], home = null, orchestrationRoot = null,
    limits: limitOverrides = {}, viewLimits: viewOverrides = {}, endpointLimits: endpointOverrides = {}, view, cgroupSubtree = null,
    verifyGrant = null, onInfrastructureLoss = () => {}, onDiagnostic = () => {}, onPtyInputStalled = () => {}
}) {
    const viewLimits = resolveViewLimits(viewOverrides);
    const endpointLimits = resolveEndpointLimits(endpointOverrides);
    const limits = resolveKeeperLimits(limitOverrides, { endpointLimits, viewLimits });
    if (viewLimits.firstGrantRootSlot !== FIRST_EXTRA_SLOT) throw new TypeError('The keeper spawn layout puts the first grant root at slot 8');
    if (!view || typeof view.process !== 'function' || typeof view.registerKeeperChild !== 'function') throw new TypeError('A procView is required');
    if (cgroupSubtree !== null && (cgroupSubtree === '/' || virtualPathProblem(cgroupSubtree, 989) !== null)) throw new TypeError('Invalid cgroup subtree');
    if (cgroupSubtree !== view.cgroupSubtree) throw new TypeError('cgroup_subtree_mismatch');
    if (!Array.isArray(grantRoots) || grantRoots.length > viewLimits.maxViewsPerKeeper) throw new TypeError('Too many grant roots');
    const command = executable;
    const expectedHelloLimits = helloLimits(limits, viewLimits);
    const ordinaryCap = limits.maxInFlight - limits.reservedInFlight;

    let phase = 'idle'; // idle -> spawned -> verified -> live -> ending -> ended; lost is terminal
    let lostReason = null;
    let lossReported = false;
    let child = null;
    let channel = null;
    let childExited = false;
    let killTimer = null;
    let helloWaiter = null;
    let keeperPid = null;
    let keeperMarker = null;
    let boundCgroupSubtree = null;
    let unregisterChild = () => {};
    let endStepSent = false;
    let finalOp = null;
    let finalReplied = false;
    let exitWaiters = [];
    let nextId = 1;
    let pingTimer = null;
    let pingOutstanding = false;
    let runtimeLocatorId = null;
    let ptyCount = 0;
    const ring = new ByteRing(limits.stderrRingBytes);
    const pending = new Map();
    const queues = { priority: [], ordinary: [] };
    const counts = { priority: 0, ordinary: 0, mount: 0 };
    const peaks = { ordinary: 0, total: 0, queued: 0, mount: 0 };
    const resources = new Map();
    const byHandle = new Map();
    const eventState = { helloSeen: false, resources: byHandle };
    const leaseLoops = new Set();
    const leaseGrants = new Set();
    const mountFramesSent = [];
    const listeners = { output: [], closed: [], exit: [] };
    let providerExit = () => {};
    let supervisorPidNs = null;

    const total = () => counts.priority + counts.ordinary;
    const queuedCount = () => queues.priority.length + queues.ordinary.length;

    function sendContext() {
        return {
            limits, viewLimits, endpointLimits, runtimeRoot, cgroupSubtree, keeperReservation: keeperMarker, orchestrationRoot: orchestrationRoot ?? undefined,
            mount: { scope: scope === 'gui' ? 'gui' : 'execution', runtimeRoot, reservationId: runtimeLocatorId, grantCount: grantRoots.length, prior: mountFramesSent }
        };
    }

    // ---- loss -------------------------------------------------------------------------------------------------------

    function stopTimers() {
        if (pingTimer !== null) { clearInterval(pingTimer); pingTimer = null; }
        for (const stop of [...leaseLoops]) stop();
        for (const entry of byHandle.values()) if (entry.pty?.stallTimer) { clearTimeout(entry.pty.stallTimer); entry.pty.stallTimer = null; }
    }

    function scheduleKill() {
        if (!child || childExited || killTimer !== null) return;
        killTimer = setTimeout(() => { killTimer = null; if (!childExited) { try { child.kill('SIGKILL'); } catch { /* gone */ } } }, limits.keeperExitWaitMs);
        killTimer.unref?.();
    }

    function rejectAll(reason) {
        for (const item of pending.values()) { if (item.timer) clearTimeout(item.timer); item.reject(new KeeperError(reason)); }
        pending.clear();
        leaseGrants.clear();
        counts.priority = 0;
        counts.ordinary = 0;
        counts.mount = 0;
        for (const item of [...queues.priority.splice(0), ...queues.ordinary.splice(0)]) item.reject(new KeeperError(reason));
        for (const entry of byHandle.values()) {
            if (!entry.pty) continue;
            for (const chunk of entry.pty.inputQueue.splice(0)) chunk.reject(new KeeperError(reason));
            entry.pty.queuedBytes = 0;
        }
    }

    // Ends the channel. `report` is false for an abort the caller chose (a create that failed before commit).
    function lose(reason, { report = true } = {}) {
        if (phase === 'lost' || phase === 'ended') return;
        const wasCommitted = phase === 'live' || phase === 'ending';
        phase = 'lost';
        lostReason = reason;
        stopTimers();
        try { channel?.destroy(); } catch { /* already gone */ }
        rejectAll(reason);
        helloWaiter?.reject(new KeeperError(reason));
        helloWaiter = null;
        scheduleKill();
        if (report && wasCommitted && !lossReported) {
            lossReported = true;
            safely(onInfrastructureLoss, reason);
        }
        for (const resolve of exitWaiters.splice(0)) resolve();
    }

    function violate(code) { lose(`keeper_violation:${code}`); }

    function ended() {
        if (phase === 'ended') return;
        phase = 'ended';
        stopTimers();
        rejectAll('keeper_ended');
        if (killTimer !== null) { clearTimeout(killTimer); killTimer = null; }
        for (const resolve of exitWaiters.splice(0)) resolve();
    }

    const notLive = () => new KeeperError(phase === 'lost' ? lostReason : phase === 'ended' ? 'keeper_ended' : 'keeper_not_committed');

    // ---- requests ---------------------------------------------------------------------------------------------------

    function deadlineFor(op, fields, item) {
        if (op === 'pty_input') return null;
        if (op === 'stop') return fields.graceMs + limits.stopExtraMs;
        if ((op === 'create' || op === 'commit') && PROCESS_BEARING_CREATE_KINDS.includes(item.ctx?.kind)) return limits.createDeadlineMs;
        return limits.requestDeadlineMs;
    }

    function write(item) {
        const frame = buildRequest(item.op, nextId, item.fields);
        const verdict = validateKeeperRequest(frame, sendContext());
        if (!verdict.ok) {
            item.reject(new KeeperError(verdict.violation ? 'bad_request' : verdict.refused, verdict.violation ?? null));
            return;
        }
        nextId += 1;
        item.frame = frame;
        pending.set(frame.id, item);
        if (item.op === 'view_root_lease') leaseGrants.add(item.fields.grantId);
        if (MOUNT_OPS.includes(item.op)) { counts.mount += 1; peaks.mount = Math.max(peaks.mount, counts.mount); }
        if (item.cls !== 'pty') {
            counts[item.cls] += 1;
            peaks.ordinary = Math.max(peaks.ordinary, counts.ordinary);
            peaks.total = Math.max(peaks.total, total());
        }
        const deadline = deadlineFor(item.op, item.fields, item);
        if (deadline !== null) {
            item.timer = setTimeout(() => lose(`keeper_timeout:${item.op}`), deadline);
            item.timer.unref?.();
        }
        item.onWrite?.(frame);
        try {
            channel.send(frame);
        } catch {
            // Not encodable within maxFrameBytes: nothing was written.
            pending.delete(frame.id);
            if (item.op === 'view_root_lease') leaseGrants.delete(item.fields.grantId);
            if (item.timer) clearTimeout(item.timer);
            if (item.cls !== 'pty') counts[item.cls] -= 1;
            if (MOUNT_OPS.includes(item.op)) counts.mount -= 1;
            item.reject(new KeeperError('bad_request', 'frame_too_large'));
        }
    }

    // Mount mutations and a second lease for the same grant stay queued until their respective slot is free.
    // Other grants' leases remain eligible while all mount slots are held.
    const nextEligible = (queue) => queue.findIndex((item) => (!MOUNT_OPS.includes(item.op) || counts.mount < viewLimits.maxMountInFlight)
        && (item.op !== 'view_root_lease' || !leaseGrants.has(item.fields.grantId)));
    function pump() {
        for (let index = nextEligible(queues.priority); index >= 0 && total() < limits.maxInFlight && channelOpen(); index = nextEligible(queues.priority)) {
            write(queues.priority.splice(index, 1)[0]);
        }
        for (let index = nextEligible(queues.ordinary); index >= 0 && counts.ordinary < ordinaryCap && total() < limits.maxInFlight && channelOpen(); index = nextEligible(queues.ordinary)) {
            write(queues.ordinary.splice(index, 1)[0]);
        }
    }

    const channelOpen = () => channel !== null && (phase === 'verified' || phase === 'live' || phase === 'ending');

    // cls: 'ordinary' | 'priority' | 'pty' | 'raw'. Resolves with the validated reply ({ ok: true, value } or a refusal).
    function request(op, fields, { cls = PRIORITY_OPS.includes(op) ? 'priority' : 'ordinary', ctx = {}, onWrite = null } = {}) {
        return new Promise((resolve, reject) => {
            if (!channelOpen()) { reject(notLive()); return; }
            const item = { op, fields, cls, ctx, resolve, reject, timer: null, frame: null, onWrite };
            if (cls === 'pty') { write(item); return; }
            if (queuedCount() >= limits.maxQueuedRequests) { reject(new KeeperError('keeper_busy')); return; }
            queues[cls].push(item);
            peaks.queued = Math.max(peaks.queued, queuedCount());
            pump();
        });
    }

    // ---- frames from the keeper -------------------------------------------------------------------------------------

    function onFrame(frame) {
        if (phase === 'lost' || phase === 'ended') return;
        if (Object.hasOwn(frame, 'id')) {
            const item = pending.get(frame.id);
            if (!item) { violate('unsolicited_reply'); return; }
            const verdict = validateKeeperReply(frame, item.frame, item.ctx);
            if (!verdict.ok) { violate(verdict.violation); return; }
            pending.delete(frame.id);
            if (item.op === 'view_root_lease') leaseGrants.delete(item.fields.grantId);
            if (item.timer) clearTimeout(item.timer);
            if (item.cls !== 'pty') counts[item.cls] -= 1;
            if (MOUNT_OPS.includes(item.op)) counts.mount -= 1;
            // The commit outcome is recorded now, before any later frame of the same read is judged (an exit may follow
            // the reply in one chunk), not in the awaiting continuation.
            if (item.op === 'commit') { const entry = byHandle.get(item.frame.resource); if (entry) recordCommitReply(entry, frame); }
            item.resolve(frame);
            pump();
            return;
        }
        if (!Object.hasOwn(frame, 'event')) { violate('bad_frame'); return; }
        const verdict = acceptKeeperEvent(frame, eventState, { limits });
        if (!verdict.ok) { violate(verdict.violation); return; }
        dispatchEvent(frame);
    }

    function dispatchEvent(frame) {
        switch (frame.event) {
            case 'hello':
                if (!helloWaiter) { violate('unexpected_hello'); return; }
                helloWaiter.resolve(frame);
                helloWaiter = null;
                return;
            case 'exit': {
                const entry = byHandle.get(frame.resource);
                if (entry.role === 'workload') safely(providerExit, entry.process, frame.code, frame.signal);
                else if (entry.kind === 'endpoint' && entry.commitOutcome === 'ok' && !endStepSent && phase === 'live' && !lossReported) {
                    lossReported = true;
                    safely(onInfrastructureLoss, 'endpoint_lost');
                }
                for (const fn of listeners.exit) safely(fn, frame.resource, frame.code, frame.signal);
                return;
            }
            case 'pty_output': {
                const bytes = Buffer.from(frame.data, 'base64');
                for (const fn of listeners.output) safely(fn, frame.resource, frame.seq, bytes);
                return;
            }
            case 'pty_closed': {
                const pty = byHandle.get(frame.resource).pty;
                for (const chunk of pty.inputQueue.splice(0)) chunk.reject(new KeeperError('pty_closed'));
                pty.queuedBytes = 0;
                for (const fn of listeners.closed) safely(fn, frame.resource);
                return;
            }
            default:
        }
    }

    // ---- the keeper -------------------------------------------------------------------------------------------------

    function stdioLayout() {
        const stdio = ['ignore', 'ignore', 'pipe', 'pipe'];
        for (let slot = 4; slot < FIRST_EXTRA_SLOT; slot += 1) stdio.push(ala ? 'pipe' : 'ignore');
        if (grantRoots.length > 0) {
            for (const { rootSlot, fd } of grantRootSlots(grantRoots.map((root) => root.fd), viewLimits)) {
                if (rootSlot !== stdio.length) throw new TypeError('Grant-root slots must follow the fixed layout');
                stdio.push(fd);
            }
        }
        if (home !== null) stdio.push(home.fd);
        return stdio;
    }

    async function createKeeper({ resourceId, marker }) {
        if (!isMainThread) throw new KeeperError('keeper_spawn_thread');
        if (phase !== 'idle') throw new KeeperError('keeper_exists');
        if (marker !== resourceId || !isOriginId(marker)) throw new KeeperError('bad_marker');
        keeperMarker = marker;
        supervisorPidNs = view.selfNamespaces().pidNs;
        if (cgroupSubtree !== null) {
            boundCgroupSubtree = view.cgroupSubtreeIdentity();
            if (boundCgroupSubtree === null) throw new KeeperError('cgroup_subtree_invalid');
        }
        const argv = keeperArgv({
            marker, parentPid: process.pid, scope, runtimeRoot, ala, grantRoots: grantRoots.length,
            homeIdentity: home?.identity ?? null, orchestrationRoot, cgroupSubtree: boundCgroupSubtree, channelLimits: channelLimitsForKeeper(limits), viewLimits
        });
        const stdio = stdioLayout();
        phase = 'spawned';
        const hello = new Promise((resolve, reject) => { helloWaiter = { resolve, reject }; });
        hello.catch(() => {});
        child = spawn(command, argv, { stdio, env: {}, detached: false, windowsHide: true });
        child.on('error', () => lose('keeper_spawn_failed', { report: false }));
        child.on('exit', () => {
            childExited = true;
            unregisterChild();
            if (killTimer !== null) { clearTimeout(killTimer); killTimer = null; }
            // A keeper that exits after the reply to its final op has ended; the reply may still be in the socket, so the
            // decision waits for the channel's close (which follows the data) unless the reply was already read.
            if (finalOp !== null && finalReplied) ended();
            else if (finalOp === null) lose('keeper_lost');
            for (const resolve of exitWaiters.splice(0)) resolve();
        });
        child.stderr?.on('data', (chunk) => ring.write(chunk));
        child.stderr?.on('error', () => {});
        channel = createFrameChannel(child.stdio[3], {
            maxFrameBytes: limits.maxFrameBytes, maxInFlight: limits.maxInFlight, partialFrameDeadlineMs: limits.partialFrameDeadlineMs,
            onFrame,
            onViolation: (code) => violate(code),
            onClose: () => {
                if (finalOp !== null && finalReplied) { if (childExited) ended(); return; }
                lose('keeper_lost');
            }
        });
        // No valid hello in time: the keeper is aborted before commit, its child SIGKILLed at once.
        const helloTimer = setTimeout(() => abortKeeper('keeper_timeout:hello'), limits.helloDeadlineMs);
        helloTimer.unref?.();
        let frame;
        try {
            frame = await hello;
        } finally {
            clearTimeout(helloTimer);
        }
        let problem = null;
        if (frame.protocol !== KEEPER_PROTOCOL || frame.version !== KEEPER_PROTOCOL_VERSION) problem = 'keeper_version_mismatch';
        else if (!sameLimits(frame.limits, expectedHelloLimits)) problem = 'keeper_limits_mismatch';
        else if (frame.marker !== marker) problem = 'identity_mismatch';
        else {
            let found;
            try { found = verifyKeeperIdentity(view, frame, { childPid: child.pid, marker, supervisorPid: process.pid }); } catch { found = 'proc_unreadable'; }
            if (found !== null) problem = 'identity_mismatch';
        }
        if (problem !== null) {
            abortKeeper(problem);
            throw new KeeperError(problem);
        }
        keeperPid = frame.pid;
        unregisterChild = view.registerKeeperChild({ pid: frame.pid, startTime: frame.startTime, kill: () => child.kill('SIGKILL') });
        phase = 'verified';
        const entry = { kind: 'keeper', resourceId, handle: null, committed: false };
        resources.set(resourceId, entry);
        return {
            identity: toLedgerIdentity('keeper', { pid: frame.pid, startTime: frame.startTime }),
            handle: null,
            gate: {
                // The keeper's gate is its first frame (K-7): commit_keeper releases it, anything else aborts it.
                commit: async () => {
                    if (phase !== 'verified') return false;
                    let reply;
                    try { reply = await request('commit_keeper', {}, { cls: 'priority' }); } catch { return false; }
                    // A channel torn down while the reply was being delivered is never reported committed.
                    if (reply.ok !== true || phase !== 'verified') return false;
                    entry.committed = true;
                    phase = 'live';
                    startPing();
                    return true;
                },
                abort: async () => { abortKeeper('keeper_aborted'); return true; }
            }
        };
    }

    // A keeper that was never committed is ended at once: the channel is destroyed and the child SIGKILLed.
    function abortKeeper(reason) {
        lose(reason, { report: false });
        if (child && !childExited) { try { child.kill('SIGKILL'); } catch { /* gone */ } }
    }

    function startPing() {
        pingTimer = setInterval(() => {
            if (phase !== 'live' || pingOutstanding || finalOp !== null) return;
            pingOutstanding = true;
            request('ping', {}, { cls: 'priority' }).then(() => { pingOutstanding = false; }, () => { pingOutstanding = false; });
        }, limits.pingIntervalMs);
        pingTimer.unref?.();
    }

    // ---- verification of a reported identity -----------------------------------------------------------------------

    function verifyWire(kind, wire, { marker, locator }) {
        const self = view.selfNamespaces();
        switch (kind) {
            case 'endpoint':
            case 'process-tree':
                return verifyProcessIdentity(view, wire, { marker, ancestorPid: keeperPid, supervisorPidNs });
            case 'netns': {
                const held = view.heldNamespaces(keeperPid);
                if (!held || !held.fdNs.includes(wire.netNs)) return 'netns_not_held';
                return wire.netNs === self.netNs ? 'netns_is_supervisor_namespace' : null;
            }
            case 'runtime-dir': {
                const found = view.pathIdentity(wire.path);
                if (wire.path !== locator.path || !found || found.type !== 'dir') return 'runtime_dir_absent';
                if (found.mode !== 0o700) return 'runtime_dir_mode';
                return found.dev === wire.dev && found.ino === wire.ino ? null : 'runtime_dir_identity';
            }
            case 'cgroup': {
                const found = view.pathIdentity(wire.path);
                const current = view.cgroupSubtreeIdentity();
                return boundCgroupSubtree && current && current.dev === boundCgroupSubtree.dev && current.ino === boundCgroupSubtree.ino
                    && wire.path === locator.path && path.dirname(wire.path) === cgroupSubtree
                    && found && found.type === 'dir' && found.dev === boundCgroupSubtree.dev && found.ino === wire.cgroupId ? null : 'cgroup_identity';
            }
            case 'pty': {
                if (!view.fdDevices(keeperPid).includes(wire.devptsDev)) return 'pty_not_held';
                return wire.devptsDev === view.containerDevptsDev() ? 'pty_on_container_devpts' : null;
            }
            default:
                return 'kind_not_verifiable';
        }
    }

    function verifyMount(value) {
        const held = view.heldNamespaces(keeperPid);
        if (!held || !held.fdNs.includes(value.mount.mountNamespaceInode)) return 'mntns_not_held';
        const server = view.process(value.fileServer.pid);
        if (!server || server.startTime !== value.fileServer.startTime) return 'file_server_absent';
        if (server.pidNs !== value.fileServer.pidNamespaceInode || server.ppid !== keeperPid) return 'file_server_identity';
        return null;
    }

    async function abortHandles(handles) {
        for (let index = 0; index < handles.length; index += ABORT_BATCH) {
            const reply = await request('abort_uncommitted', { resources: handles.slice(index, index + ABORT_BATCH) });
            if (reply.ok !== true) throw new KeeperError(reply.error, null, reply.kind);
        }
    }

    function gateFor(entry) {
        return {
            commit: async () => {
                let reply;
                try { reply = await request('commit', { resource: entry.handle }, { ctx: { kind: entry.kind } }); } catch { return false; }
                // entry.committed was set synchronously when the reply was read (onFrame). A channel torn down since, for
                // example by a later frame of the same read, is never reported as a released gate.
                return reply.ok === true && entry.commitOutcome === 'ok' && phase === 'live';
            },
            abort: async () => {
                try { await abortHandles([entry.handle]); return true; } catch { return false; }
            }
        };
    }

    async function createResource({ kind, resourceId, marker, locator, spec }) {
        if (phase !== 'live') throw notLive();
        if (endStepSent) throw new KeeperError('execution_ending');
        const handle = resourceHandle(resourceId);
        if (byHandle.has(handle) || resources.has(resourceId)) throw new KeeperError('duplicate_resource');
        if (kind === 'pty' && ptyCount >= limits.maxPtysPerKeeper) throw new KeeperError('pty_limit');
        const ctx = { kind, locator };
        const reply = await request('create', { resource: handle, kind, marker, locator, spec: spec ?? {} }, { ctx });
        if (reply.ok !== true) throw new KeeperError(reply.error, null, reply.kind);
        const wire = reply.value.identity;
        let problem;
        try { problem = verifyWire(kind, wire, { marker, locator }); } catch { problem = 'proc_unreadable'; }
        if (problem !== null) {
            try { await abortHandles([handle]); } catch { /* a request only; the walk decides */ }
            throw new KeeperError('identity_mismatch', problem);
        }
        const entry = {
            kind, resourceId, handle, committed: false, exited: false, locator, role: spec?.role ?? null, process: spec?.process ?? null
        };
        if (kind === 'pty') {
            ptyCount += 1;
            entry.pty = { nextSeq: '1', credit: 0, closed: false, inSeq: 0n, frames: 0, bytes: 0, inputQueue: [], queuedBytes: 0, stallTimer: null, stalled: false };
        }
        if (kind === 'runtime-dir' && runtimeLocatorId === null) runtimeLocatorId = locator.path.slice(locator.path.lastIndexOf('/') + 1);
        byHandle.set(handle, entry);
        resources.set(resourceId, entry);
        return { identity: toLedgerIdentity(kind, wire), handle, gate: gateFor(entry) };
    }

    async function createMount({ resourceId, spec }) {
        if (phase !== 'live') throw notLive();
        if (endStepSent) throw new KeeperError('execution_ending');
        if (runtimeLocatorId === null) throw new KeeperError('runtime_dir_missing');
        if (typeof verifyGrant !== 'function') throw new KeeperError('verify_grant_missing');
        if (resources.has(resourceId)) throw new KeeperError('duplicate_resource');
        const { grantId, rootSlot, expectedRootIdentity, access, descriptorCap, rlimitNofile } = spec ?? {};
        const issuer = createRootLeaseIssuer({ grantId, verify: () => verifyGrant(grantId), limits: viewLimits });
        const initial = await issuer.initial();
        if (!initial.ok) throw new KeeperError(initial.code);
        const mountpoint = viewMountpoint({ scope: scope === 'gui' ? 'gui' : 'execution', runtimeRoot, reservationId: runtimeLocatorId, grantId });
        const fields = {
            grantId, rootSlot, expectedRootIdentity, access, mountpoint, propagation: 'private', allowOther: true, descriptorCap, rlimitNofile,
            rootLease: initial.rootLease
        };
        const reply = await request('mount_view', fields, { onWrite: (frame) => mountFramesSent.push(frame) });
        if (reply.ok !== true) throw new KeeperError(reply.error, null, reply.kind);
        const { value } = reply;
        let problem;
        try { problem = verifyMount(value); } catch { problem = 'proc_unreadable'; }
        if (problem !== null) {
            try { await abortHandles([value.resource]); } catch { /* the walk decides */ }
            throw new KeeperError('identity_mismatch', problem);
        }
        const entry = { kind: 'mount', resourceId, handle: value.resource, committed: false, exited: false, issuer, fileServer: value.fileServer, grantId };
        byHandle.set(value.resource, entry);
        resources.set(resourceId, entry);
        return { identity: toLedgerIdentity('mount', value), handle: value.resource, gate: gateFor(entry) };
    }

    // ---- end path ---------------------------------------------------------------------------------------------------

    function waitForExit() {
        if (childExited || !child) return Promise.resolve();
        return new Promise((resolve) => { exitWaiters.push(resolve); });
    }

    async function endStep(op) {
        if (phase !== 'live') throw notLive();
        endStepSent = true;
        const final = op === 'remove_runtime' || op === 'shutdown';
        if (final) {
            finalOp = op;
            stopTimers();
        }
        const reply = await request(op, {});
        if (reply.ok !== true) throw new KeeperError('bad_reply');
        if (final) {
            finalReplied = true;
            phase = 'ending';
            scheduleKill();
            await waitForExit();
            if (childExited) ended();
        }
    }

    async function abortUncommitted(resourceIds) {
        if (!Array.isArray(resourceIds) || resourceIds.length === 0) return;
        // The keeper's own reservation, never committed: end it now (whatever the channel state).
        const keeperEntry = resources.get(keeperMarker);
        if (keeperMarker !== null && resourceIds.includes(keeperMarker) && !(keeperEntry?.committed === true)) { abortKeeper('keeper_aborted'); return; }
        if (phase !== 'live') throw notLive();
        // Committed handles are never listed: the keeper would refuse the whole frame.
        const handles = [];
        for (const resourceId of resourceIds) {
            const entry = resources.get(resourceId);
            if (entry) { if (!entry.committed && entry.handle) handles.push(entry.handle); continue; }
            if (isOriginId(resourceId)) handles.push(resourceHandle(resourceId));
        }
        if (handles.length > 0) await abortHandles([...new Set(handles)]);
    }

    // ---- PTY --------------------------------------------------------------------------------------------------------

    function ptyEntry(handle) {
        const entry = byHandle.get(handle);
        if (!entry || entry.kind !== 'pty' || !entry.committed) throw new KeeperError('unknown_resource');
        return entry.pty;
    }

    function armStall(handle, pty) {
        if (pty.stallTimer) clearTimeout(pty.stallTimer);
        pty.stallTimer = null;
        if (pty.frames === 0 || phase !== 'live') return;
        pty.stallTimer = setTimeout(() => {
            pty.stallTimer = null;
            if (pty.frames > 0 && !pty.stalled) { pty.stalled = true; safely(onPtyInputStalled, handle); }
        }, limits.ptyInputStallMs);
        pty.stallTimer.unref?.();
    }

    function pumpPty(handle, pty) {
        while (pty.inputQueue.length > 0 && pty.frames < limits.ptyInputWindowFrames
            && pty.bytes + pty.inputQueue[0].bytes.length <= limits.ptyInputWindowBytes && phase === 'live') {
            const chunk = pty.inputQueue.shift();
            pty.queuedBytes -= chunk.bytes.length;
            pty.frames += 1;
            pty.bytes += chunk.bytes.length;
            request('pty_input', { resource: handle, seq: chunk.seq, data: encodeBase64(chunk.bytes) }, { cls: 'pty' }).then((reply) => {
                pty.frames -= 1;
                pty.bytes -= chunk.bytes.length;
                pty.stalled = false;
                armStall(handle, pty);
                if (reply.ok === true) chunk.resolve(chunk.seq); else chunk.reject(new KeeperError(reply.error, null, reply.kind));
                pumpPty(handle, pty);
            }, (error) => chunk.reject(error));
        }
        armStall(handle, pty);
    }

    // One input frame (a WebTTY frame of at most 64 KiB) becomes consecutive chunks of at most ptyChunkBytes with
    // client-assigned sequence numbers. Resolves with the sequence of the last chunk once the keeper has written every
    // byte to the master (R1.2). Nothing is sent when the queue would exceed ptyInputQueueBytes (pty_input_backlog).
    function ptyInput(handle, bytes) {
        try {
            if (phase !== 'live') throw notLive();
            const pty = ptyEntry(handle);
            if (pty.closed) throw new KeeperError('pty_closed');
            const data = Buffer.from(bytes);
            if (data.length === 0) throw new KeeperError('empty_input');
            if (pty.queuedBytes + data.length > limits.ptyInputQueueBytes) throw new KeeperError('pty_input_backlog');
            const promises = [];
            for (let offset = 0; offset < data.length; offset += limits.ptyChunkBytes) {
                pty.inSeq += 1n;
                const chunk = { seq: String(pty.inSeq), bytes: data.subarray(offset, offset + limits.ptyChunkBytes) };
                promises.push(new Promise((resolve, reject) => { chunk.resolve = resolve; chunk.reject = reject; }));
                pty.inputQueue.push(chunk);
                pty.queuedBytes += chunk.bytes.length;
            }
            pumpPty(handle, pty);
            return Promise.all(promises).then((seqs) => seqs.at(-1));
        } catch (error) {
            return Promise.reject(error);
        }
    }

    async function ptyResize(handle, cols, rows) {
        ptyEntry(handle);
        const reply = await request('pty_resize', { resource: handle, cols, rows });
        if (reply.ok !== true) throw new KeeperError(reply.error, null, reply.kind);
    }

    // The credit is counted from the moment the frame is written (the keeper cannot send output for it earlier) and
    // returned if the keeper refuses it.
    async function ptyCredit(handle, bytes) {
        const pty = ptyEntry(handle);
        if (!Number.isSafeInteger(bytes) || bytes < 1 || pty.credit + bytes > limits.ptyMaxCreditBytes) throw new KeeperError('credit_overflow');
        let granted = false;
        const reply = await request('pty_credit', { resource: handle, bytes }, { onWrite: () => { pty.credit += bytes; granted = true; } });
        if (reply.ok !== true) {
            if (granted) pty.credit = Math.max(0, pty.credit - bytes);
            throw new KeeperError(reply.error, null, reply.kind);
        }
    }

    // ---- views ------------------------------------------------------------------------------------------------------

    // Renews the view's root lease every rootLeaseRenewMs through a priority slot. A revocation that the supervisor's own
    // view cannot confirm (the file server still there, or unproven) kills the keeper and quarantines the view.
    function startLeaseLoop(resourceId, { quarantineView }) {
        const entry = resources.get(resourceId);
        if (!entry || entry.kind !== 'mount' || !entry.committed) throw new KeeperError('unknown_resource');
        if (entry.stopLeaseLoop) throw new KeeperError('lease_loop_exists');
        const { issuer } = entry;
        let stopped = false;
        let busy = false;
        const timer = setInterval(async () => {
            if (stopped || busy) return;
            busy = true;
            try {
                const tick = await issuer.next();
                if (stopped) return;
                if (tick.frame && phase === 'live' && finalOp === null) {
                    const { op, ...fields } = tick.frame;
                    let sent = null;
                    const reply = await request(op, fields, { onWrite: (frame) => { sent = frame; } }).catch(() => null);
                    if (reply && sent) issuer.observeKeeperReply(reply, sent);
                }
                if (issuer.revocation()) {
                    const settled = await issuer.settleRevocation({ identity: entry.fileServer, probe: (pid) => view.processIdentity(pid) });
                    if (settled.action === 'kill_keeper_and_quarantine') {
                        stop();
                        if (child && !childExited) { try { child.kill('SIGKILL'); } catch { /* gone */ } }
                        safely(quarantineView, resourceId);
                    } else if (settled.due) stop();
                }
            } finally {
                busy = false;
            }
        }, viewLimits.rootLeaseRenewMs);
        timer.unref?.();
        function stop() {
            stopped = true;
            clearInterval(timer);
            leaseLoops.delete(stop);
            if (entry.stopLeaseLoop === stop) entry.stopLeaseLoop = null;
        }
        entry.stopLeaseLoop = stop;
        leaseLoops.add(stop);
        return stop;
    }

    async function unmountView(resourceId) {
        const entry = resources.get(resourceId);
        if (!entry || entry.kind !== 'mount') throw new KeeperError('unknown_resource');
        const reply = await request('unmount_view', { resource: entry.handle });
        if (reply.ok !== true) throw new KeeperError(reply.error, null, reply.kind);
    }

    // ---- adapters ---------------------------------------------------------------------------------------------------

    function providerKeeper(ledger, { netnsHandle }) {
        const handles = new Map();
        return {
            async tempdir() {
                const reply = await request('tempdir', {});
                if (reply.ok !== true) throw new KeeperError(reply.error, null, reply.kind);
                return reply.value.path;
            },
            // Resolves only after the gate commit succeeded: the workload has executed (state `executed`).
            async start({ process: number, request: startRequest, streams }) {
                const published = await ledger.publish({ kind: 'process-tree', spec: { role: 'workload', process: number, request: startRequest, streams, netns: netnsHandle } });
                handles.set(number, published.handle);
            },
            async stop({ process: number, graceMs }) {
                const handle = handles.get(number);
                if (!handle) throw new KeeperError('unknown_process');
                const reply = await request('stop', { resource: handle, graceMs }, { ctx: { kind: 'process-tree' } });
                if (reply.ok !== true) throw new KeeperError(reply.error, null, reply.kind);
            },
            setExitHandler(handler) { providerExit = handler; }
        };
    }

    return {
        // ledger-facing
        create(request_) {
            if (request_.kind === 'keeper') return createKeeper(request_);
            if (request_.kind === 'mount') return createMount(request_);
            return createResource(request_);
        },
        alive: () => phase === 'live',
        abortUncommitted,
        endProcessTrees: () => endStep('end_process_trees'),
        endEndpoint: () => endStep('end_endpoint'),
        releaseEgress: () => endStep('release_egress'),
        releaseViews: () => endStep('release_views'),
        removeRuntime: () => endStep('remove_runtime'),
        exit: () => endStep('shutdown'),
        // endpoint-facing
        providerKeeper,
        get endpointSocket() { return ala && child ? child.stdio[4] : null; },
        get controlStreams() { return ala && child ? { stdin: child.stdio[5], stdout: child.stdio[6], stderr: child.stdio[7] } : null; },
        // PTY
        ptyInput,
        ptyResize,
        ptyCredit,
        onPtyOutput(fn) { listeners.output.push(fn); },
        onPtyClosed(fn) { listeners.closed.push(fn); },
        onExit(fn) { listeners.exit.push(fn); },
        // views
        startLeaseLoop,
        unmountView,
        // diagnostics
        async inventory() {
            const reply = await request('inventory', {});
            return reply.value;
        },
        stderrTail: () => ring.contents().toString('utf8'),
        stats: () => ({
            phase, lostReason, pid: keeperPid, spawned: child !== null, exited: childExited, inFlight: { ...counts }, peakMount: peaks.mount, queued: queuedCount(), pending: pending.size, nextId, peaks: { ...peaks }
        }),
        // Internal (tests and diagnostics): one validated request. A frame that fails the v1 schema is never written
        // (rejects bad_request). pty_input sent this way bypasses the client's window, so that the keeper's own bound can
        // be exercised; nothing in production calls it.
        requestRaw({ op, ...fields }, { cls } = {}) {
            return request(op, fields, { cls: cls ?? (op === 'pty_input' ? 'pty' : PRIORITY_OPS.includes(op) ? 'priority' : 'ordinary') });
        }
    };
}
