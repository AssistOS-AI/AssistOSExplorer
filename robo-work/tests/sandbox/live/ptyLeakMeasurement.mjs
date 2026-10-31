// Test-only measurement state. An observation belongs to pid:startTime, never to a reused pid.
import fs from 'node:fs';

const heldRoleProgram = String.raw`
const fs = require('fs');
const role = process.argv.find((arg) => /^role-(orchestration|endpoint|workload)$/.test(arg));
const fds = fs.readdirSync('/proc/self/fd').map((fd) => {
    try { return fd + '->' + fs.readlinkSync('/proc/self/fd/' + fd); } catch { return fd + '->?'; }
});
const snapshot = JSON.stringify({ role, fds });
if (role === 'role-endpoint') fs.writeFileSync('/stream/fd-ready.json', snapshot);
else fs.writeSync(1, snapshot + '\n');
setInterval(() => {}, 1000);
`;

export function heldRoleArgv(role, { node = '/usr/local/bin/node', fdTrim = '/opt/robo-work/server/sandbox/fdTrim.mjs' } = {}) {
    if (!['orchestration', 'endpoint', 'workload'].includes(role)) throw new Error('unknown fd fixture role');
    // The real launcher gives RW_FD_ALLOW only to orchestration/endpoint. Workloads are trimmed by stage.sh final.
    return [node, ...(role === 'workload' ? [] : ['--import', fdTrim]), '-e', heldRoleProgram, `role-${role}`];
}

export function readIdentity(pid, procRoot = '/proc') {
    try {
        const stat = fs.readFileSync(`${procRoot}/${pid}/stat`, 'utf8');
        const fields = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/u);
        if (!/^\d+$/u.test(fields[19] ?? '')) return null;
        return { pid, startTime: fields[19], state: fields[0], threads: Number(fields[17]) };
    } catch { return null; }
}

export const processKey = ({ pid, startTime }) => `${pid}:${startTime}`;

// Unlike readIdentity, this proof reader never conflates an opaque/invalid stat with absence.
export function readIdentityObservation(pid, procRoot = '/proc', io = fs) {
    try {
        const stat = io.readFileSync(`${procRoot}/${pid}/stat`, 'utf8');
        const close = stat.lastIndexOf(')');
        const fields = stat.slice(close + 2).trim().split(/\s+/u);
        if (stat.length > 8192 || !stat.startsWith(`${pid} (`) || close < 0 || !/^[A-Za-z]$/u.test(fields[0] ?? '')
            || !/^\d+$/u.test(fields[19] ?? '')) return { outcome: 'unknown', reason: 'invalid-stat' };
        return { outcome: 'present', identity: { pid, startTime: fields[19], state: fields[0] } };
    } catch (error) {
        return ['ENOENT', 'ESRCH'].includes(error.code) ? { outcome: 'absent', errno: error.code }
            : { outcome: 'unknown', errno: error.code ?? 'UNKNOWN' };
    }
}

// Evidence only: never use readable threads to clear the leader's failed observation. The deadline is cooperative;
// synchronous proc operations can overrun it. Entry/read limits bound work even when the clock has not advanced.
export function captureOpacityDiagnostic({ pid, sampleTime, before, after, scanIdentity, failure, ancestry = [],
    procRoot = '/proc', io = fs, now = () => process.hrtime.bigint(), limits = {} }) {
    const caps = { tids: 8, fds: 16, ancestry: 16, reads: 128, elapsedNs: 10000000, ...limits };
    const started = now();
    const result = { sampleTimeNs: String(sampleTime), before, after, scanIdentity, failure,
        ancestry: ancestry.slice(0, caps.ancestry), tids: [], limits: caps, reads: 0, incomplete: false, truncated: [] };
    const truncate = (reason) => { result.incomplete = true; if (!result.truncated.includes(reason)) result.truncated.push(reason); };
    if (ancestry.length > caps.ancestry) truncate('ancestry-limit');
    if (ancestry.some((entry) => entry.incomplete || !entry.identity)) result.incomplete = true;
    result.identityBracket = !before || !after ? 'unreadable' : processKey(before) === processKey(after) ? 'same' : 'changed';
    if (result.identityBracket !== 'same') result.incomplete = true;
    const operation = (syscall, relativePath, run) => {
        if (result.reads >= caps.reads || now() - started >= BigInt(caps.elapsedNs)) {
            truncate(result.reads >= caps.reads ? 'read-limit' : 'cooperative-time-limit');
            return { ok: false, syscall, relativePath, incomplete: true };
        }
        result.reads += 1;
        try { return { ok: true, value: run(`${procRoot}/${relativePath}`) }; }
        catch (error) { result.incomplete = true; return { ok: false, syscall, relativePath, errno: error.code ?? 'UNKNOWN' }; }
    };
    const stat = (relativePath, tid) => {
        const read = operation('readFile', relativePath, (file) => io.readFileSync(file, 'utf8'));
        if (!read.ok) return read;
        const fields = read.value.slice(read.value.lastIndexOf(')') + 2).trim().split(/\s+/u);
        if (!/^\d+$/u.test(fields[19] ?? '')) { result.incomplete = true; return { ok: false, relativePath, reason: 'invalid-stat' }; }
        const flags = /^\d+$/u.test(fields[6] ?? '') && Number.isSafeInteger(Number(fields[6])) ? Number(fields[6]) : null;
        if (flags === null) result.incomplete = true;
        const comm = read.value.slice(read.value.indexOf('(') + 1, read.value.lastIndexOf(')'));
        return { ok: true, identity: { pid: tid, startTime: fields[19], state: fields[0], threads: Number(fields[17]) },
            flags, ioWorkerComm: /^iou-wrk-[0-9]+$/u.test(comm) };
    };
    const status = (relativePath) => {
        const read = operation('readFile', relativePath, (file) => io.readFileSync(file, 'utf8'));
        if (!read.ok) return read;
        const values = {};
        for (const name of ['FDSize', 'Tgid', 'Uid']) {
            const matches = read.value.split('\n').filter((line) => line.startsWith(`${name}:`));
            const tokens = matches[0]?.slice(name.length + 1).trim().split(/\s+/u) ?? [];
            if (read.value.length > 8192 || matches.length !== 1 || tokens.length !== (name === 'Uid' ? 4 : 1)
                || tokens.some((value) => !/^\d+$/u.test(value) || !Number.isSafeInteger(Number(value)))) {
                result.incomplete = true;
                return { ok: false, relativePath, reason: 'invalid-status' };
            }
            values[name] = name === 'Uid' ? tokens.map(Number) : Number(tokens[0]);
        }
        return { ok: true, ...values };
    };
    const entries = (relativePath, cap, label) => {
        const opened = operation('opendir', relativePath, (file) => io.opendirSync(file, { bufferSize: 1 }));
        if (!opened.ok) return { outcome: opened, names: [] };
        const names = [];
        let complete = false;
        try {
            for (let index = 0; index <= cap; index += 1) {
                const read = operation('readdir', relativePath, () => opened.value.readSync());
                if (!read.ok) return { outcome: read, names };
                if (read.value === null) { complete = true; break; }
                if (index === cap) { truncate(label); break; }
                if (/^\d+$/u.test(read.value.name)) names.push(read.value.name);
            }
        } finally { opened.value.closeSync(); }
        return { outcome: { ok: true, complete, entries: names.length }, names };
    };
    const tasks = entries(`${pid}/task`, caps.tids, 'tid-limit');
    result.taskRead = tasks.outcome;
    if (tasks.names.length === 0) { result.incomplete = true; result.threadIdentityOutcome = 'no-thread-identities'; }
    for (const tid of tasks.names) {
        const root = `${pid}/task/${tid}`;
        const thread = { tid: Number(tid), before: stat(`${root}/stat`, Number(tid)), fds: [] };
        result.tids.push(thread);
        thread.statusBefore = status(`${root}/status`);
        const descriptors = entries(`${root}/fd`, caps.fds, 'fd-limit');
        thread.fdRead = descriptors.outcome;
        for (const fd of descriptors.names) {
            const relativePath = `${root}/fd/${fd}`;
            const link = operation('readlink', relativePath, (file) => io.readlinkSync(file));
            const entry = { fd: Number(fd), link: link.ok ? { ok: true, ptyMaster: /(^|\/)ptmx$/u.test(link.value) } : link };
            if (entry.link.ptyMaster) {
                const node = operation('stat', relativePath, (file) => io.statSync(file, { bigint: true }));
                entry.ptyIdentity = node.ok ? { ok: true, dev: String(node.value.dev), ino: String(node.value.ino) } : node;
            }
            thread.fds.push(entry);
        }
        thread.statusAfter = status(`${root}/status`);
        thread.after = stat(`${root}/stat`, Number(tid));
        if (thread.before.ok && thread.after.ok && processKey(thread.before.identity) !== processKey(thread.after.identity)) {
            thread.identityChanged = true;
            result.incomplete = true;
        }
    }
    result.elapsedNs = String(now() - started);
    return result;
}

export function createObservationLog() {
    const failures = new Map();
    const readable = new Map();
    return {
        failures, readable,
        record({ before, after, kind, table, errno = null }) {
            if (table === null && ['ENOENT', 'ESRCH'].includes(errno) && after === null) return false;
            const key = before ? processKey(before) : `unknown:${after?.pid ?? 'pid'}`;
            if (!before || (after && processKey(after) !== key)) {
                failures.set(key, { pid: before?.pid ?? after?.pid, kind, reason: 'process identity unreadable or changed' });
                return false;
            }
            if (table === null) {
                if (['ENOENT', 'ESRCH'].includes(errno) && after === null) return false;
                failures.set(key, { ...before, kind, reason: 'fd table unreadable', errno });
                return false;
            }
            readable.set(key, { ...before, kind });
            return true; // a later readable sample cannot erase a failed observation
        },
    };
}

export function validateHeld(held, { identity = readIdentity, descriptors }) {
    if (!Array.isArray(held) || held.length === 0) return [{ reason: 'no held process identities' }];
    const failures = [];
    for (const expected of held) {
        const before = identity(expected.pid);
        const table = descriptors(expected.pid);
        const after = identity(expected.pid);
        if (!before || !after || processKey(before) !== processKey(expected) || processKey(after) !== processKey(expected)
            || ['Z', 'X', 'x'].includes(before.state) || ['Z', 'X', 'x'].includes(after.state) || table === null) {
            failures.push({ ...expected, reason: 'held process exited, changed identity, or became unreadable' });
        }
    }
    return failures;
}

// Start sampling before granting launch; freeze the measurement before granting teardown. Failure paths still request cleanup.
export async function measureFixture({ start, ready, sample, validate, finish, cleanup, deadlineMs = 30000, intervalMs = 5 }) {
    let timer;
    let interval;
    let measurement;
    let validated = false;
    try {
        sample();
        interval = setInterval(sample, intervalMs);
        const deadline = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('fixture readiness deadline')), deadlineMs); });
        start();
        measurement = await Promise.race([ready, deadline]);
        sample();
        const failures = validate(measurement);
        if (failures.length > 0) throw new Error(`fixture finish validation: ${JSON.stringify(failures)}`);
        validated = true;
    } finally {
        clearTimeout(timer);
        clearInterval(interval);
        finish(validated);
        await cleanup();
    }
    return measurement;
}
