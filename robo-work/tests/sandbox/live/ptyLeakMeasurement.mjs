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

// Prior clean eligibility reads every thread's table; teardown itself supplies no descriptor coverage. A denied ptrace check
// can redact a present mm's code addresses to 1/1: only the complete zero bundle proves the missing-mm teardown condition.
function proveThreadGroup(expected, { procRoot = '/proc', io = fs, now = () => process.hrtime.bigint(), limits = {}, masters = [] } = {}, mode) {
    const caps = { tids: 64, fds: 256, reads: mode === 'clean' ? 8192 : 512, elapsedNs: 50000000, ...limits };
    const started = now();
    const proof = { ok: false, key: expected ? processKey(expected) : null, tids: [], reads: 0, limits: caps, leaks: [] };
    const fail = (reason) => { proof.reason = reason; return proof; };
    const operation = (run) => {
        if (proof.reads >= caps.reads || now() - started >= BigInt(caps.elapsedNs)) throw new Error('proof-budget');
        proof.reads += 1;
        return run();
    };
    const stat = (relative, pid) => {
        const raw = operation(() => io.readFileSync(`${procRoot}/${relative}/stat`, 'utf8'));
        const close = raw.lastIndexOf(')');
        const fields = raw.slice(close + 2).trim().split(/\s+/u);
        if (raw.length > 8192 || !raw.startsWith(`${pid} (`) || close < 0 || !/^[A-Za-z]$/u.test(fields[0] ?? '')
            || [6, 17, 19, 20, 21, 23, 24, 25].some((index) => !/^\d+$/u.test(fields[index] ?? ''))
            || !Number.isSafeInteger(Number(fields[17])) || Number(fields[17]) < 1) throw new Error('invalid-stat');
        return { identity: { pid, startTime: fields[19], state: fields[0], threads: Number(fields[17]) },
            exiting: (BigInt(fields[6]) & 4n) !== 0n,
            noMm: [20, 21, 23, 24, 25].every((index) => fields[index] === '0') };
    };
    const entries = (relative, cap) => {
        const directory = operation(() => io.opendirSync(`${procRoot}/${relative}`, { bufferSize: 1 }));
        const ids = [];
        try {
            for (;;) {
                const entry = operation(() => directory.readSync());
                if (entry === null) break;
                if (!/^\d+$/u.test(entry.name) || !Number.isSafeInteger(Number(entry.name))) throw new Error('invalid-entry');
                if (ids.length >= cap) throw new Error('entry-budget');
                ids.push(Number(entry.name));
            }
        } finally { directory.closeSync(); }
        if (new Set(ids).size !== ids.length) throw new Error('duplicate-entry');
        return ids.sort((left, right) => left - right);
    };
    const descriptors = (relative, tid) => {
        const names = entries(`${relative}/fd`, caps.fds);
        for (const fd of names) {
            const file = `${procRoot}/${relative}/fd/${fd}`;
            const target = operation(() => io.readlinkSync(file));
            if (/(^|\/)ptmx$/u.test(target)) {
                let node;
                try { node = operation(() => io.statSync(file, { bigint: true })); }
                catch (error) { proof.leaks.push({ tid, fd, unknownIdentity: true }); throw error; }
                if (typeof node.dev !== 'bigint' || typeof node.ino !== 'bigint' || node.dev < 0n || node.ino < 0n) {
                    proof.leaks.push({ tid, fd, unknownIdentity: true });
                    throw new Error('invalid-master-identity');
                }
                if (masters.some((master) => master.dev === String(node.dev) && master.ino === String(node.ino))) {
                    proof.leaks.push({ tid, fd, unknownIdentity: false });
                }
            }
        }
        if (names.join(',') !== entries(`${relative}/fd`, caps.fds).join(',')) throw new Error('descriptor-set-changed');
        return { complete: true, entries: names.length };
    };
    try {
        if (!expected || !Number.isSafeInteger(expected.pid) || expected.pid < 2 || !/^\d+$/u.test(expected.startTime ?? '')) return fail('invalid-identity');
        proof.before = stat(String(expected.pid), expected.pid);
        if (processKey(proof.before.identity) !== proof.key) return fail('group-identity-changed');
        if (mode === 'exit' && (!proof.before.exiting || !proof.before.noMm)) return fail('leader-not-in-mm-free-exit');
        if (mode === 'clean' && ['Z', 'X', 'x'].includes(proof.before.identity.state)) return fail('leader-not-live-for-prior-sample');
        const first = entries(`${expected.pid}/task`, caps.tids);
        if (!first.includes(expected.pid) || first.some((tid) => tid < 1) || first.length !== proof.before.identity.threads) return fail('incomplete-thread-group');
        for (const tid of first) {
            const relative = `${expected.pid}/task/${tid}`;
            const before = stat(relative, tid);
            const fds = mode === 'clean' ? descriptors(relative, tid) : undefined;
            const after = stat(relative, tid);
            proof.tids.push({ tid, before, after, ...(fds ? { fds } : {}) });
            if (processKey(before.identity) !== processKey(after.identity) || before.identity.threads !== first.length || after.identity.threads !== first.length) return fail('thread-identity-changed');
            if (mode === 'exit' && (!before.exiting || !after.exiting || !before.noMm || !after.noMm)) return fail('thread-not-in-mm-free-exit');
        }
        const last = entries(`${expected.pid}/task`, caps.tids);
        proof.after = stat(String(expected.pid), expected.pid);
        if (first.join(',') !== last.join(',') || processKey(proof.after.identity) !== proof.key
            || proof.after.identity.threads !== first.length) return fail('group-identity-changed');
        if (mode === 'exit' && (!proof.before.exiting || !proof.after.exiting || !proof.before.noMm || !proof.after.noMm)) return fail('leader-not-in-mm-free-exit');
        if (mode === 'clean' && (['Z', 'X', 'x'].includes(proof.before.identity.state) || ['Z', 'X', 'x'].includes(proof.after.identity.state))) return fail('leader-not-live-for-prior-sample');
        if (proof.leaks.length > 0) return fail('inherited-or-unknown-master');
        proof.ok = true;
        return proof;
    } catch (error) {
        const internal = ['proof-budget', 'invalid-stat', 'invalid-entry', 'entry-budget', 'duplicate-entry', 'descriptor-set-changed', 'invalid-master-identity'];
        return fail(/^[A-Z][A-Z0-9_]{1,31}$/u.test(error.code ?? '') ? error.code
            : internal.includes(error.message) ? error.message : 'proof-unreadable');
    }
}

export const proveExitTeardown = (expected, options) => proveThreadGroup(expected, options, 'exit');
export const provePriorCleanSample = (expected, options) => proveThreadGroup(expected, options, 'clean');

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
    const status = (relativePath, names = ['FDSize', 'Tgid', 'Uid']) => {
        const read = operation('readFile', relativePath, (file) => io.readFileSync(file, 'utf8'));
        if (!read.ok) return read;
        const values = {};
        for (const name of names) {
            const matches = read.value.split('\n').filter((line) => line.startsWith(`${name}:`));
            const tokens = matches[0]?.slice(name.length + 1).trim().split(/\s+/u) ?? [];
            const validToken = (value) => name === 'CapEff' ? /^[0-9a-f]{16}$/iu.test(value)
                : name === 'NoNewPrivs' ? /^[01]$/u.test(value) : /^\d+$/u.test(value) && Number.isSafeInteger(Number(value));
            if (read.value.length > 8192 || matches.length !== 1 || tokens.length !== (name === 'Uid' ? 4 : 1)
                || tokens.some((value) => !validToken(value))) {
                result.incomplete = true;
                return { ok: false, relativePath, reason: 'invalid-status' };
            }
            values[name] = name === 'Uid' ? tokens.map(Number) : name === 'CapEff' ? tokens[0].toLowerCase() : Number(tokens[0]);
        }
        return { ok: true, ...values };
    };
    const ownership = (relativePath) => {
        const read = operation('stat', relativePath, (file) => io.statSync(file));
        return read.ok ? { ok: true, uid: read.value.uid, gid: read.value.gid, mode: (read.value.mode & 0o7777).toString(8).padStart(4, '0') } : read;
    };
    const userNamespace = (relativePath) => {
        const read = operation('readlink', relativePath, (file) => io.readlinkSync(file));
        if (!read.ok) return read;
        const match = /^user:\[([0-9]+)\]$/u.exec(read.value);
        if (!match) { result.incomplete = true; return { ok: false, relativePath, reason: 'invalid-user-namespace' }; }
        return { ok: true, inode: match[1] };
    };
    const idMap = (relativePath) => {
        const read = operation('readFile', relativePath, (file) => io.readFileSync(file, 'utf8'));
        if (!read.ok) return read;
        const lines = read.value.trim().split('\n');
        const ranges = lines.slice(0, 8).map((line) => line.trim().split(/\s+/u));
        if (read.value.length > 8192 || ranges.some((range) => range.length !== 3
            || range.some((value) => !/^\d+$/u.test(value) || !Number.isSafeInteger(Number(value))))) {
            result.incomplete = true;
            return { ok: false, relativePath, reason: 'invalid-id-map' };
        }
        if (lines.length > 8) truncate('id-map-line-limit');
        return { ok: true, complete: lines.length <= 8, ranges: ranges.map((range) => range.map(Number)) };
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
    // Only permission-relevant status fields and proc node metadata are retained; never expose raw status or link targets.
    result.accessContext = {
        probe: { uid: process.getuid?.() ?? null, euid: process.geteuid?.() ?? null,
            status: status('self/status', ['CapEff', 'NoNewPrivs']), userNamespace: userNamespace('self/ns/user'),
            uidMap: idMap('self/uid_map'), gidMap: idMap('self/gid_map') },
        target: { processDirectory: ownership(String(pid)), fdDirectory: ownership(`${pid}/fd`),
            status: status(`${pid}/status`, ['Uid', 'NoNewPrivs']), userNamespace: userNamespace(`${pid}/ns/user`),
            uidMap: idMap(`${pid}/uid_map`), gidMap: idMap(`${pid}/gid_map`) },
    };
    const { probe, target } = result.accessContext;
    result.accessContext.sameUserNamespace = probe.userNamespace.ok && target.userNamespace.ok
        ? probe.userNamespace.inode === target.userNamespace.inode : null;
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
    const priorClean = new Map();
    const exitTeardowns = new Map();
    return {
        failures, readable, priorClean, exitTeardowns,
        record({ before, after, kind, table, errno = null, cleanFdSample = null, exitTeardown = null }) {
            if (table === null && ['ENOENT', 'ESRCH'].includes(errno) && after === null) return false;
            const key = before ? processKey(before) : `unknown:${after?.pid ?? 'pid'}`;
            if (!before || (after && processKey(after) !== key)) {
                failures.set(key, { pid: before?.pid ?? after?.pid, kind, reason: 'process identity unreadable or changed' });
                return false;
            }
            if (table === null) {
                if (['ENOENT', 'ESRCH'].includes(errno) && after === null) return false;
                if (after && processKey(after) === key && priorClean.has(key) && !failures.has(key)
                    && exitTeardown?.ok === true && exitTeardown.key === key) {
                    exitTeardowns.set(key, { ...before, kind, errno, priorClean: priorClean.get(key), proof: exitTeardown });
                    return false; // accepted teardown supplies no new descriptor coverage
                }
                failures.set(key, { ...before, kind, reason: 'fd table unreadable', errno });
                return false;
            }
            readable.set(key, { ...before, kind });
            if (cleanFdSample?.ok === true && cleanFdSample.key === key && after && processKey(after) === key && !['Z', 'X', 'x'].includes(before.state)
                && !['Z', 'X', 'x'].includes(after.state) && !priorClean.has(key)) priorClean.set(key, { before, after, kind, proof: cleanFdSample });
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
