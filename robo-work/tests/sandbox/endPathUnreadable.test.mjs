// F13: execution H_8gy17... was stopped while its multi-threaded workload (`opencode serve`) was killed. For a moment the workload
// was a zombie GROUP LEADER whose other threads were still exiting: its /proc/<pid>/fd is unreadable (EACCES) while the process is
// not yet gone. procView threw proc_unreadable out of listProcesses, the walker did not catch it, and the end path died with the
// execution `stopping` and every blocker `committed`. The end path must prove absence or quarantine, and never throw.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createWalker } from '../../server/execution/recoveryWalk.mjs';
import { ProcUnreadable, createProcView } from '../../server/execution/procView.mjs';
import { createRecoveryView } from '../../server/sandbox/executionSupervisor.mjs';

const clock = () => { let now = 0; return { now: () => now, sleep: async (ms) => { now += ms; } }; };

function fakeProc(t) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rw-f13-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    // the supervisor's own entry, read by listMounts
    fs.mkdirSync(path.join(root, 'self', 'ns'), { recursive: true });
    for (const type of ['mnt', 'net', 'pid']) fs.symlinkSync(`${type}:[4026531840]`, path.join(root, 'self', 'ns', type));
    fs.writeFileSync(path.join(root, 'self', 'mountinfo'), '');
    const add = ({ pid, ppid = 1, state = 'S', threads = 1, unreadableFd = false, pidNs = 4026534333, cmd = 'x' }) => {
        const dir = path.join(root, String(pid));
        fs.mkdirSync(path.join(dir, 'ns'), { recursive: true });
        fs.writeFileSync(path.join(dir, 'stat'), `${pid} (${cmd}) ${state} ${ppid} ${pid} ${pid} 0 -1 0 0 0 0 0 0 0 0 0 20 0 ${threads} 0 ${21000000 + pid} 0 0 0\n`);
        fs.writeFileSync(path.join(dir, 'cmdline'), `${cmd}\0`);
        fs.writeFileSync(path.join(dir, 'status'), `Name:\t${cmd}\nState:\t${state} (state)\nThreads:\t${threads}\n`);
        for (const type of ['mnt', 'net']) fs.symlinkSync(`${type}:[${4026531000 + pid}]`, path.join(dir, 'ns', type));
        fs.symlinkSync(`pid:[${pidNs}]`, path.join(dir, 'ns', 'pid'));
        if (unreadableFd) fs.symlinkSync('fd', path.join(dir, 'fd')); else fs.mkdirSync(path.join(dir, 'fd'));
    };
    const remove = (pid) => fs.rmSync(path.join(root, String(pid)), { recursive: true, force: true });
    return { root, add, remove };
}

// The ledger's identity for the workload tree of the incident: monitor 852 (gone), init 886, the opencode leader 887 below it.
const identity = (extra = {}) => ({ pid: 852, startTime: String(21000852), pidNs: '4026534333', mntNs: '4026534330', stageMntNs: '4026534328', netNs: '4026534199', init: { pid: 886, startTime: String(21000886) }, ...extra });
const blocker = { kind: 'process-tree', identity: identity(), locator: { marker: 'dhIeGEpmGTy8S2biO40VFQ', keeper: 'k' } };

function incident(t) {
    const proc = fakeProc(t);
    proc.add({ pid: 886, ppid: 1, cmd: 'bwrap', pidNs: 4026534333 });
    proc.add({ pid: 887, ppid: 886, state: 'Z', threads: 3, unreadableFd: true, cmd: 'opencode', pidNs: 4026534333 });
    const kills = [];
    const view = createProcView({ procRoot: proc.root, signal: (pid, name) => { kills.push([pid, name]); } });
    return { proc, view, kills };
}

test('F13 reproduction: listing processes while the multi-threaded workload is a zombie leader does not throw', (t) => {
    const { view } = incident(t);
    const listed = view.listProcesses();
    assert.deepEqual(listed.map((entry) => [entry.pid, entry.opaque === true]), [[886, false], [887, true]]);
});

test('F13 reproduction: the walker waits for the dying leader, kills nothing it cannot identify, and releases once it is gone', async (t) => {
    const { proc, view, kills } = incident(t);
    let polls = 0;
    const sleeping = { now: 0 };
    const walker = createWalker({
        view, releaseDeadlineMs: 5000, pollMs: 100, sandboxRecord: () => null,
        clock: { now: () => sleeping.now, sleep: async (ms) => { sleeping.now += ms; polls += 1; if (polls === 3) { proc.remove(887); proc.remove(886); } } }
    });
    assert.equal(walker.prove(blocker).absent, false, 'init and leader are present');
    assert.equal(await walker.walk(blocker), 'released');
    assert.ok(polls >= 3, 'it read again until the leader was gone');
    assert.ok(kills.some(([pid]) => pid === 886), 'the recorded init was forced');
});

test('F13: a leader that never goes away is quarantined at the deadline, not thrown', async (t) => {
    const { view } = incident(t);
    const walker = createWalker({ view, clock: clock(), releaseDeadlineMs: 500, pollMs: 100, sandboxRecord: () => null });
    assert.equal(await walker.walk(blocker), 'quarantined');
});

test('an opaque process holds a namespace only if it is attributable to it (a descendant of a process that holds it), until it is gone', async (t) => {
    const { proc, view } = incident(t);
    // the recovery view answers for the network objects (none exist here)
    const recovery = createRecoveryView(view, { runSync: () => ({ status: 0, stdout: '', stderr: '' }), exists: () => false });
    const walker = createWalker({ view: recovery, clock: clock(), releaseDeadlineMs: 300, pollMs: 100, sandboxRecord: () => null });
    // 887 (opaque: its descriptors cannot be read) descends from 886, which readably holds net:[4026531886]
    const mine = { kind: 'netns', identity: { netNs: '4026531886' }, locator: { netns: '0123456789abcdef0123456789abcdef', keeper: 'k' } };
    assert.equal(walker.prove(mine).absent, false);
    assert.ok(walker.prove(mine).holders.some((holder) => holder.via === 'opaque' && holder.pid === 887));
    // another execution's network: nothing readable names it and 887 does not descend from a holder of it
    const other = { ...mine, identity: { netNs: '4026539999' } };
    assert.equal(walker.prove(other).absent, true, 'an unattributable opaque process delays nobody');
    proc.remove(887);
    proc.remove(886);
    assert.equal(walker.prove(mine).absent, true);
});

test('M-36: an opaque process left running on purpose by one robot does not hold, delay or quarantine another execution\'s release', async (t) => {
    const proc = fakeProc(t);
    // execution A: init 700 with a hostile leader 701 whose descriptors are unreadable and which stays (a pthread_exit trick)
    proc.add({ pid: 700, ppid: 1, cmd: 'bwrap', pidNs: 4026534500 });
    proc.add({ pid: 701, ppid: 700, state: 'Z', threads: 2, unreadableFd: true, cmd: 'python3', pidNs: 4026534500 });
    // execution B: init 800 holding its own netns, released earlier or now
    proc.add({ pid: 800, ppid: 1, cmd: 'bwrap', pidNs: 4026534600 });
    const view = createProcView({ procRoot: proc.root, signal: () => {} });
    const recovery = createRecoveryView(view, { runSync: () => ({ status: 0, stdout: '', stderr: '' }), exists: () => false });
    const walker = createWalker({ view: recovery, clock: clock(), releaseDeadlineMs: 300, pollMs: 100, sandboxRecord: () => null });
    const netnsOfB = { kind: 'netns', identity: { netNs: '4026539001' }, locator: { netns: 'b'.repeat(32), keeper: 'kb' } };
    proc.remove(800); // B's processes are gone; A's opaque leader is still there
    assert.equal(await walker.walk(netnsOfB), 'released');
    // and the mount namespace of B the same way
    const mountOfB = { kind: 'mount', identity: { mntNs: '4026539002', mountId: 5, mountpoint: '/x' }, locator: { mount: 'b' } };
    assert.equal(await walker.walk(mountOfB), 'released');
});

test('an unreadable /proc is "not proven", never an exception: walk quarantines, attempt is undecided, force is silent, a transient failure heals', async () => {
    const failing = (failures) => {
        let calls = 0;
        return { listProcesses: () => { calls += 1; if (calls <= failures) throw new ProcUnreadable('887/fd', { code: 'EACCES' }); return []; }, listMounts: () => [], exists: () => false, remove: () => false, kill: () => false, unmount: () => false };
    };
    const make = (view) => createWalker({ view, clock: clock(), releaseDeadlineMs: 500, pollMs: 100, sandboxRecord: () => null });
    const always = make(failing(Infinity));
    assert.deepEqual(always.prove(blocker), { absent: false, holders: [{ via: 'proc-unreadable', code: 'proc_unreadable' }] });
    assert.equal(await always.walk(blocker), 'quarantined');
    assert.equal(await always.attempt(blocker), null);
    await assert.doesNotReject(always.force(blocker));
    assert.equal(await make(failing(4)).walk(blocker), 'released', 'two walk iterations fail, then /proc reads');
    for (const kind of ['netns', 'mount', 'runtime-dir', 'keeper']) {
        assert.equal(await make(failing(Infinity)).walk({ kind, identity: null, locator: { marker: 'm', netns: 'a'.repeat(32), path: '/x', keeper: 'k' } }), 'quarantined', kind);
    }
});

test('a view that throws something else (a read of mountinfo, a locator check) is also contained', async () => {
    const view = { listProcesses: () => [], listMounts: () => { throw new Error('mountinfo exploded'); }, exists: () => { throw new Error('ip exploded'); }, remove: () => false, kill: () => false, unmount: () => false };
    const walker = createWalker({ view, clock: clock(), releaseDeadlineMs: 300, pollMs: 100, sandboxRecord: () => null });
    for (const kind of ['mount', 'veth', 'runtime-dir', 'netns']) {
        assert.equal(await walker.walk({ kind, identity: { mntNs: '1', netNs: '2', mountId: 1, mountpoint: '/x' }, locator: { host: 'h', path: '/x', netns: 'n', keeper: 'k' } }), 'quarantined', kind);
    }
});
