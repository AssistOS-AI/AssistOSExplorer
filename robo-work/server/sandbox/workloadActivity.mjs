// Workload CPU activity for the attempt watchdog (decision M-35). A task attempt whose workload is busy but silent (a build, a model
// call being waited on by a busy loop) is alive; one whose workload burns no CPU and says nothing is stalled. The watchdog (M-33)
// is touched by ALA records and provider requests; this adds what a workload's CPU time shows, read-only from /proc.
//
//   createWorkloadActivityWalk({ view, ... })   -> { snapshot() }
//        The one /proc walk shared by every execution's tick (view.listProcesses(), cached for `shareMs` so executions that tick
//        together read /proc once). Never throws: an unreadable /proc is a snapshot with ok:false (no credit, and the meters keep
//        their baselines).
//   createActivityMeter({ walk, ... })          -> { sample(workloads) -> boolean }       one meter per execution
//        workloads: [{ pidNs, init: { pid, startTime } }] the live workload trees of the execution. A process is a MEMBER when its
//        pid-namespace inode equals the tree's AND that inode is still proven to be the recorded one (pinned, or the recorded init is
//        alive in it): an inode alone is reused by the kernel. Per sample the meter reports ACTIVITY when
//          - a member appeared (pid + start time not seen at the previous sample), or
//          - the CPU time (utime + stime) of the members that PERSIST (compared per member) grew by at least
//            ACTIVITY_CPU_FRACTION of one CPU over the time since the previous sample (2 %: 1.2 s per 60 s tick).
//        A member whose stat is gone (ENOENT/ESRCH) is skipped; any other unreadable stat earns no credit and no baseline change.
//   parseCpuTicks(line) -> { pid, startTime, ticks } | null     fields are taken after the LAST ')' (comm is robot-controlled)
//
// 2 % of one CPU is a code constant. An idle `opencode serve` measured far below it in the Box (tests/sandbox/live/activity.mjs).

import fs from 'node:fs';

export const ACTIVITY_CPU_FRACTION = 0.02;
export const WATCHDOG_TICK_MS = 60 * 1000;
const DEFAULT_SHARE_MS = 5000;
const VANISHED = new Set(['ENOENT', 'ESRCH']);

// /proc/<pid>/stat: "<pid> (<comm>) <state> <ppid> ... <utime:14> <stime:15> ... <starttime:22>". comm may contain ') ' and spaces,
// so everything is counted from the last ')'. After it, field 3 (state) is index 0: utime index 11, stime index 12, starttime index 19.
export function parseCpuTicks(line) {
    if (typeof line !== 'string') return null;
    const text = line.endsWith('\n') ? line.slice(0, -1) : line;
    const open = text.indexOf(' (');
    const close = text.lastIndexOf(')');
    if (open < 1 || close < open || text[close + 1] !== ' ') return null;
    const pid = text.slice(0, open);
    if (!/^[1-9][0-9]{0,9}$/u.test(pid)) return null;
    const fields = text.slice(close + 2).split(' ');
    if (fields.length < 20) return null;
    const [utime, stime, startTime] = [fields[11], fields[12], fields[19]];
    if (![utime, stime, startTime].every((value) => /^[0-9]{1,20}$/u.test(value))) return null;
    return { pid: Number(pid), startTime: String(BigInt(startTime)), ticks: BigInt(utime) + BigInt(stime) };
}

export function createWorkloadActivityWalk({ view, now = Date.now, shareMs = DEFAULT_SHARE_MS, procRoot = '/proc', readFile = (file) => fs.readFileSync(file, 'utf8') } = {}) {
    if (!view || typeof view.listProcesses !== 'function') throw new TypeError('A procView is required');
    let cached = null;
    return Object.freeze({
        snapshot() {
            const at = now();
            if (cached !== null && at - cached.at < shareMs && at >= cached.at) return cached;
            let processes = [];
            let ok = true;
            try { processes = view.listProcesses(); } catch { processes = []; ok = false; }
            cached = { at, processes, ok };
            return cached;
        },
        // utime + stime of one process, from its own stat: { ticks } | { gone: true } | { unreadable: true }
        read(pid, startTime) {
            let text;
            try { text = readFile(`${procRoot}/${pid}/stat`); } catch (error) { return VANISHED.has(error?.code) ? { gone: true } : { unreadable: true }; }
            const parsed = parseCpuTicks(text);
            if (parsed === null || parsed.pid !== pid) return { unreadable: true };
            if (parsed.startTime !== startTime) return { gone: true }; // the pid was reused: the member is gone
            return { ticks: parsed.ticks };
        },
        isPinned: (type, inode) => view.isPinned?.(type, inode) === true
    });
}

export function createActivityMeter({ walk, now = Date.now, fraction = ACTIVITY_CPU_FRACTION, ticksPerSecond = 100 } = {}) {
    if (!walk || typeof walk.snapshot !== 'function') throw new TypeError('A walk is required');
    let previous = new Map(); // "pid:startTime" -> ticks
    let previousAt = null;
    return Object.freeze({
        sample(workloads) {
            const at = now();
            const { processes, ok = true } = walk.snapshot();
            if (!ok) return false; // an unreadable /proc: no credit, and the baselines are kept for the next sample
            const members = [];
            for (const workload of workloads ?? []) {
                if (typeof workload?.pidNs !== 'string') continue;
                const proven = walk.isPinned('pid', workload.pidNs)
                    || processes.some((entry) => entry.pid === workload.init?.pid && entry.startTime === workload.init?.startTime && entry.pidNs === workload.pidNs);
                if (!proven) continue;
                for (const entry of processes) if (entry.pidNs === workload.pidNs) members.push(entry);
            }
            const current = new Map();
            let appeared = false;
            let grownTicks = 0n;
            for (const member of members) {
                const key = `${member.pid}:${member.startTime}`;
                const reading = walk.read(member.pid, member.startTime);
                if (reading.gone) continue;
                if (reading.unreadable) {
                    // no credit; the baseline of a known member is kept so a later readable sample still compares
                    if (previous.has(key)) current.set(key, previous.get(key));
                    continue;
                }
                current.set(key, reading.ticks);
                if (!previous.has(key)) { appeared = true; continue; }
                const before = previous.get(key);
                if (reading.ticks > before) grownTicks += reading.ticks - before;
            }
            const elapsedSeconds = previousAt === null ? 0 : Math.max((at - previousAt) / 1000, 1);
            previous = current;
            previousAt = at;
            if (appeared) return true;
            return elapsedSeconds > 0 && Number(grownTicks) / ticksPerSecond >= fraction * elapsedSeconds;
        }
    });
}
