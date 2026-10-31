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
