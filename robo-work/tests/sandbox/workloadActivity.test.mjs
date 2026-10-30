// M-35: workload CPU activity for the attempt watchdog, over a fake /proc (real procView and real files; nothing is started).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createAttemptWatchdog } from '../../server/runtime/attemptWatchdog.mjs';
import { createProcView } from '../../server/execution/procView.mjs';
import { ACTIVITY_CPU_FRACTION, createActivityMeter, createWorkloadActivityWalk, parseCpuTicks } from '../../server/sandbox/workloadActivity.mjs';

const TICK = 60 * 1000;
const PID_NS = '4026534333';

function fakeProc(t) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rw-act-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    fs.mkdirSync(path.join(root, 'self', 'ns'), { recursive: true });
    for (const type of ['mnt', 'net', 'pid']) fs.symlinkSync(`${type}:[4026531840]`, path.join(root, 'self', 'ns', type));
    fs.writeFileSync(path.join(root, 'self', 'mountinfo'), '');
    const statLine = ({ pid, comm = 'opencode', ppid = 1, utime = 0, stime = 0, start = 1000 + pid }) => `${pid} (${comm}) S ${ppid} 1 1 0 -1 0 0 0 0 0 ${utime} ${stime} 0 0 20 0 1 0 ${start} 0 0 0\n`;
    const world = {
        root,
        set({ pid, pidNs = PID_NS, ...stat }) {
            const dir = path.join(root, String(pid));
            fs.mkdirSync(path.join(dir, 'ns'), { recursive: true });
            fs.writeFileSync(path.join(dir, 'stat'), statLine({ pid, ...stat }));
            fs.writeFileSync(path.join(dir, 'cmdline'), 'x\0');
            for (const type of ['mnt', 'net']) fs.writeFileSync(path.join(dir, 'ns', `${type}.tmp`), '') || (fs.rmSync(path.join(dir, 'ns', `${type}.tmp`)), true);
            for (const [type, value] of [['mnt', 4026531000 + pid], ['net', 4026531100], ['pid', pidNs]]) {
                try { fs.rmSync(path.join(dir, 'ns', type)); } catch { /* new */ }
                fs.symlinkSync(`${type}:[${value}]`, path.join(dir, 'ns', type));
            }
            fs.mkdirSync(path.join(dir, 'fd'), { recursive: true });
        },
        remove: (pid) => fs.rmSync(path.join(root, String(pid)), { recursive: true, force: true }),
        statOnly: (pid, text) => fs.writeFileSync(path.join(root, String(pid), 'stat'), text)
    };
    return world;
}

function meterOver(world, { pinned = true, listCount = null, now = { t: 0 } } = {}) {
    const view = createProcView({ procRoot: world.root, signal: () => {} });
    const list = view.listProcesses;
    if (listCount) view.listProcesses = () => { listCount.n += 1; return list(); };
    view.isPinned = (type, inode) => pinned && type === 'pid' && inode === PID_NS;
    const walk = createWorkloadActivityWalk({ view, procRoot: world.root, now: () => now.t });
    return { meter: createActivityMeter({ walk, now: () => now.t }), walk, now, view };
}

const TREE = [{ pidNs: PID_NS, init: { pid: 100, startTime: '1100' } }];

test('parseCpuTicks takes utime+stime after the LAST ")": a comm with ") " and spaces cannot shift the fields', () => {
    assert.deepEqual(parseCpuTicks('4201 (opencode) S 1 1 1 0 -1 0 0 0 0 0 150 50 0 0 20 0 1 0 5550003 0 0 0\n'), { pid: 4201, startTime: '5550003', ticks: 200n });
    const hostile = '77 (a ) S 1 2 3 4 5 6 7 8 9 99 99 99 99 99 ) S 1 1 1 0 -1 0 0 0 0 0 7 8 0 0 20 0 1 0 424242 0 0 0';
    assert.deepEqual(parseCpuTicks(hostile), { pid: 77, startTime: '424242', ticks: 15n });
    assert.deepEqual(parseCpuTicks('8 (x y z) S 1 1 1 0 -1 0 0 0 0 0 1 2 0 0 20 0 1 0 00042 0 0 0'), { pid: 8, startTime: '42', ticks: 3n });
    for (const bad of ['', 'garbage', '8 (short) S 1', 'x (bad) S 1 1 1 0 -1 0 0 0 0 0 1 2 0 0 20 0 1 0 1 0', '9 (ok) S 1 1 1 0 -1 0 0 0 0 0 a b 0 0 20 0 1 0 1 0 0 0', null]) assert.equal(parseCpuTicks(bad), null, String(bad));
});

test('a busy member (CPU growth of 2 % of one CPU or more over the tick) is activity, an idle server below it is not, and the threshold is inclusive', (t) => {
    const world = fakeProc(t);
    world.set({ pid: 100, comm: 'bwrap' });
    world.set({ pid: 101, ppid: 100, utime: 1000 });
    const { meter, now } = meterOver(world);
    assert.equal(meter.sample(TREE), true, 'first sample: the members are new');
    // idle: 0.5 s of CPU in 60 s is 0.8 %
    now.t += TICK; world.set({ pid: 101, ppid: 100, utime: 1050 });
    assert.equal(meter.sample(TREE), false, 'an idle opencode serve is below the threshold');
    // 1.19 s: just under 1.2 s; 1.2 s exactly: inclusive
    now.t += TICK; world.set({ pid: 101, ppid: 100, utime: 1050 + 119 });
    assert.equal(meter.sample(TREE), false);
    now.t += TICK; world.set({ pid: 101, ppid: 100, utime: 1050 + 119 + 120 });
    assert.equal(meter.sample(TREE), true, '1.2 s per 60 s is exactly 2 %');
    // busy
    now.t += TICK; world.set({ pid: 101, ppid: 100, utime: 1050 + 119 + 120 + 400, stime: 100 });
    assert.equal(meter.sample(TREE), true);
    assert.equal(ACTIVITY_CPU_FRACTION, 0.02);
});

test('a new member counts as activity even with no CPU growth; a restarted pid (new start time) is a new member', (t) => {
    const world = fakeProc(t);
    world.set({ pid: 100, comm: 'bwrap' });
    world.set({ pid: 101, ppid: 100, utime: 10 });
    const { meter, now } = meterOver(world);
    meter.sample(TREE);
    now.t += TICK;
    assert.equal(meter.sample(TREE), false, 'nothing new, nothing grew');
    now.t += TICK; world.set({ pid: 102, ppid: 101, utime: 0 });
    assert.equal(meter.sample(TREE), true, 'a child process appeared');
    now.t += TICK;
    assert.equal(meter.sample(TREE), false);
    now.t += TICK; world.set({ pid: 102, ppid: 101, utime: 0, start: 99999 });
    assert.equal(meter.sample(TREE), true, 'same pid, new start time: a different process');
});

test('growth is summed over PERSISTING members, compared per member: a member that left does not make the others look busy or idle', (t) => {
    const world = fakeProc(t);
    world.set({ pid: 100, comm: 'bwrap' });
    world.set({ pid: 101, ppid: 100, utime: 5000 });
    world.set({ pid: 102, ppid: 100, utime: 100 });
    const { meter, now } = meterOver(world);
    meter.sample(TREE);
    // each of two persisting members grew 0.7 s: 1.4 s in total is 2.3 %
    now.t += TICK; world.set({ pid: 101, ppid: 100, utime: 5070 }); world.set({ pid: 102, ppid: 100, utime: 170 });
    assert.equal(meter.sample(TREE), true);
    // the busy one exits (its CPU total vanishes): the survivor's own growth is what counts
    now.t += TICK; world.remove(101); world.set({ pid: 102, ppid: 100, utime: 175 });
    assert.equal(meter.sample(TREE), false, 'survivor grew 0.05 s; the departed member is not a negative or a positive');
});

test('a vanished member (stat gone between the listing and the read) is skipped; an unreadable stat earns no credit', (t) => {
    const world = fakeProc(t);
    world.set({ pid: 100, comm: 'bwrap' });
    world.set({ pid: 101, ppid: 100, utime: 10 });
    world.set({ pid: 102, ppid: 100, utime: 10 });
    const { meter, now, walk } = meterOver(world);
    meter.sample(TREE);
    now.t += TICK;
    // 101 is listed by the walk, then its stat is gone when it is read
    const snapshot = walk.snapshot();
    assert.ok(snapshot.processes.some((entry) => entry.pid === 101));
    world.remove(101);
    now.t += 6000; // the shared snapshot is older than shareMs: re-listed, 101 is simply gone
    assert.equal(meter.sample(TREE), false);
    // unreadable (a directory where the file should be: EISDIR): no credit, no throw, and not "new" later when it heals as the same process
    world.set({ pid: 103, ppid: 100, utime: 1000 });
    now.t += TICK;
    assert.equal(meter.sample(TREE), true, 'the new readable member 103');
    fs.rmSync(path.join(world.root, '103', 'stat'));
    fs.mkdirSync(path.join(world.root, '103', 'stat'));
    now.t += TICK;
    assert.equal(meter.sample(TREE), false, 'unreadable: no credit');
    // one member's stat unreadable AFTER the listing (EACCES): it earns no credit, the others are still compared
    const eacces = createWorkloadActivityWalk({ view: createProcView({ procRoot: world.root, signal: () => {} }), procRoot: world.root, now: () => now.t, shareMs: 0,
        readFile: (file) => { if (file.endsWith('/102/stat')) throw Object.assign(new Error('denied'), { code: 'EACCES' }); return fs.readFileSync(file, 'utf8'); } });
    assert.deepEqual(eacces.read(102, '1102'), { unreadable: true });
    assert.deepEqual(eacces.read(999, '1'), { gone: true });
    fs.rmSync(path.join(world.root, '103', 'stat'), { recursive: true });
    world.set({ pid: 103, ppid: 100, utime: 1000 });
    now.t += TICK;
    assert.equal(meter.sample(TREE), false, 'readable again with no growth: its baseline was kept, it is not new');
    // the stat read racing a removal: ENOENT after the snapshot
    const raced = createWorkloadActivityWalk({ view: { listProcesses: () => [{ pid: 555, ppid: 1, startTime: '1555', cmdline: [], pidNs: PID_NS, mntNs: '1', netNs: '1', fdNs: [] }, { pid: 100, ppid: 1, startTime: '1100', cmdline: [], pidNs: PID_NS, mntNs: '1', netNs: '1', fdNs: [] }], isPinned: () => true }, procRoot: world.root, now: () => now.t });
    assert.deepEqual(raced.read(555, '1555'), { gone: true });
});

test('members must be proven by their recorded pid-namespace inode: an unpinned inode with no recorded init alive is not a membership proof', (t) => {
    const world = fakeProc(t);
    world.set({ pid: 100, comm: 'bwrap' });
    world.set({ pid: 101, ppid: 100, utime: 9000 });
    world.set({ pid: 300, pidNs: '4026599999', utime: 9000 }); // someone else's namespace
    const pinned = meterOver(world);
    assert.equal(pinned.meter.sample(TREE), true);
    pinned.now.t += TICK; world.set({ pid: 300, pidNs: '4026599999', utime: 19000 });
    assert.equal(pinned.meter.sample(TREE), false, 'the other namespace is never read');
    // a reused inode: the recorded init is not alive (pid 100 gone), nothing pins it: no members, no credit
    world.remove(100);
    const unproven = meterOver(world, { pinned: false });
    assert.equal(unproven.meter.sample(TREE), false);
    // the recorded init alive in the namespace proves it without a pin
    world.set({ pid: 100, comm: 'bwrap' });
    const byInit = meterOver(world, { pinned: false });
    assert.equal(byInit.meter.sample(TREE), true);
    assert.equal(byInit.meter.sample([]), false, 'no workload, no activity');
});

test('ONE /proc walk is shared by every execution\'s tick (within the share window), and an unreadable /proc is "no activity", not an error', (t) => {
    const world = fakeProc(t);
    world.set({ pid: 100, comm: 'bwrap' });
    world.set({ pid: 101, ppid: 100, utime: 1 });
    const count = { n: 0 };
    const first = meterOver(world, { listCount: count });
    const second = createActivityMeter({ walk: first.walk, now: () => first.now.t });
    assert.equal(first.meter.sample(TREE), true);
    assert.equal(second.sample(TREE), true);
    assert.equal(count.n, 1, 'two executions ticking together read /proc once');
    first.now.t += TICK;
    first.meter.sample(TREE);
    assert.equal(count.n, 2, 'the next tick walks again');
    const broken = createActivityMeter({ walk: createWorkloadActivityWalk({ view: { listProcesses: () => { throw new Error('proc_unreadable'); } } }) });
    assert.equal(broken.sample(TREE), false);
});

// ---- the watchdog with the sampler: the behaviour the attempt sees --------------------------------------------------------

function scheduler() {
    let time = 0; let sequence = 0; let queue = [];
    return {
        now: () => time,
        timers: {
            setTimeout: (fn, ms) => { const handle = { fn, at: time + ms, id: (sequence += 1), unref() {} }; queue.push(handle); return handle; },
            clearTimeout: (handle) => { queue = queue.filter((entry) => entry !== handle); }
        },
        advance(ms) {
            const target = time + ms;
            for (;;) {
                const due = queue.filter((entry) => entry.at <= target).sort((a, b) => a.at - b.at || a.id - b.id)[0];
                if (!due) break;
                queue = queue.filter((entry) => entry !== due);
                time = due.at;
                due.fn();
            }
            time = target;
        }
    };
}

function attempt(t, cpuPerTickCentiseconds) {
    const world = fakeProc(t);
    world.set({ pid: 100, comm: 'bwrap' });
    world.set({ pid: 101, ppid: 100, utime: 0 });
    const clock = scheduler();
    const { meter } = meterOver(world, { now: { get t() { return clock.now(); }, set t(value) { /* driven by the scheduler */ } } });
    const fired = [];
    const watchdog = createAttemptWatchdog({ inactivityMs: 20 * 60 * 1000, maxMs: 4 * 60 * 60 * 1000, timers: clock.timers, now: clock.now, onTimeout: (reason) => fired.push([reason, clock.now()]) });
    let utime = 0;
    let minutes = 0;
    return {
        fired,
        // one watchdog tick (60 s): the member burns `cpuPerTickCentiseconds`, then the sampler runs and touches on activity
        tick() { clock.advance(TICK); minutes += 1; utime += cpuPerTickCentiseconds; world.set({ pid: 101, ppid: 100, utime }); if (meter.sample(TREE)) watchdog.touch(); },
        get minutes() { return minutes; }
    };
}

test('with the sampler wired to touch(): a silent but BUSY workload keeps the attempt alive; a silent CPU-IDLE one ends after the inactivity bound', (t) => {
    const busy = attempt(t, 300); // 3 s of CPU per minute: 5 %
    for (let index = 0; index < 90; index += 1) busy.tick();
    assert.deepEqual(busy.fired, [], '90 minutes of silent CPU keep the attempt alive');
    const idle = attempt(t, 20); // 0.2 s per minute: 0.33 %
    for (let index = 0; index < 40 && idle.fired.length === 0; index += 1) idle.tick();
    assert.equal(idle.fired.length, 1);
    assert.equal(idle.fired[0][0], 'inactive_timeout');
    assert.equal(idle.fired[0][1], 21 * 60 * 1000, 'the first sample counted (new member) at minute 1, so the bound ran from there: 1 + 20 minutes');
});

test('the 4 h maximum still ends a busy loop that CPU activity keeps alive', (t) => {
    const busy = attempt(t, 300);
    for (let index = 0; index < 250 && busy.fired.length === 0; index += 1) busy.tick();
    assert.deepEqual(busy.fired[0], ['deadline_exceeded', 4 * 60 * 60 * 1000]);
});
