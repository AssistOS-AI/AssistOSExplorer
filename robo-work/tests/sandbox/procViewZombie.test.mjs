import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createProcView } from '../../server/execution/procView.mjs';

// A fake procRoot with hand-made entries. An unreadable fd directory is a symlink loop (ELOOP), which fails the same way for
// root and for an ordinary user; the reader must treat only a dead zombie (State Z, one thread) as gone.
function procRoot(t, entries) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rw-proc-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    for (const { pid, state = 'S', threads = 1, unreadableFd = false, leaderNs = ['pid', 'mnt', 'net'], tasks = [] } of entries) {
        const dir = path.join(root, String(pid));
        fs.mkdirSync(path.join(dir, 'ns'), { recursive: true });
        fs.writeFileSync(path.join(dir, 'stat'), `${pid} (x) ${state} 1 ${pid} ${pid} 0 -1 0 0 0 0 0 0 0 0 0 20 0 ${threads} 0 ${1000 + pid} 0 0 0\n`);
        fs.writeFileSync(path.join(dir, 'cmdline'), 'x\0');
        fs.writeFileSync(path.join(dir, 'status'), `Name:\tx\nState:\t${state} (state)\nThreads:\t${threads}\n`);
        for (const type of leaderNs) fs.symlinkSync(`${type}:[${4026531000 + pid}]`, path.join(dir, 'ns', type));
        if (unreadableFd) fs.symlinkSync('fd', path.join(dir, 'fd')); else fs.mkdirSync(path.join(dir, 'fd'));
        // /proc/<pid>/task/<tid>: a thread is readable on its own, whatever the leader is. ns: { type: inode } (a missing type is unreadable),
        // fds: link targets of its descriptors, unreadable: its fd directory cannot be read.
        for (const { tid, ns = {}, fds = [], unreadable = false } of tasks) {
            const task = path.join(dir, 'task', String(tid));
            fs.mkdirSync(path.join(task, 'ns'), { recursive: true });
            for (const [type, inode] of Object.entries(ns)) fs.symlinkSync(`${type}:[${inode}]`, path.join(task, 'ns', type));
            if (unreadable) fs.symlinkSync('fd', path.join(task, 'fd'));
            else { fs.mkdirSync(path.join(task, 'fd')); fds.forEach((target, index) => fs.symlinkSync(target, path.join(task, 'fd', String(index + 3)))); }
        }
    }
    return root;
}

const view = (root) => createProcView({ procRoot: root, signal: () => { throw new Error('no signalling in this test'); } });

test('a dead zombie (State Z, one thread) with unreadable descriptors is gone, not an error', (t) => {
    const root = procRoot(t, [{ pid: 10 }, { pid: 11, state: 'Z', unreadableFd: true }]);
    assert.deepEqual(view(root).listProcesses().map((entry) => entry.pid), [10]);
    assert.equal(view(root).process(11), null);
});

test('F13: a LIVE (R or S) process whose descriptors cannot be read, as a killed multi-threaded leader is for a moment, is listed as opaque, not an error', (t) => {
    const live = procRoot(t, [{ pid: 13, unreadableFd: true }, { pid: 14, state: 'R', threads: 6, unreadableFd: true }]);
    assert.deepEqual(view(live).listProcesses().map((entry) => [entry.pid, entry.opaque === true]), [[13, true], [14, true]]);
    assert.equal(view(live).process(13).opaque, true);
});

test('a process whose stat or cmdline cannot be read at all still fails closed', (t) => {
    const root = procRoot(t, [{ pid: 17 }]);
    fs.rmSync(path.join(root, '17', 'cmdline'));
    fs.mkdirSync(path.join(root, '17', 'cmdline'));
    assert.throws(() => view(root).listProcesses(), { code: 'proc_unreadable' });
});

test('F13: a zombie group leader whose other threads are still exiting is listed as present but opaque, never as an error', (t) => {
    const root = procRoot(t, [{ pid: 12, state: 'Z', threads: 2, unreadableFd: true }, { pid: 14 }]);
    const listed = view(root).listProcesses();
    assert.deepEqual(listed.map((entry) => entry.pid), [12, 14]);
    // the leader's own links are readable here and only its descriptors are not (no thread can be read either): present, opaque
    assert.deepEqual({ pid: listed[0].pid, ppid: listed[0].ppid, fdNs: listed[0].fdNs, opaque: listed[0].opaque, threadNs: listed[0].threadNs },
        { pid: 12, ppid: 1, fdNs: [], opaque: true, threadNs: { pidNs: [listed[0].pidNs], netNs: [listed[0].netNs], mntNs: [listed[0].mntNs] } });
    assert.equal(listed[1].opaque, undefined);
    assert.equal(view(root).process(12).opaque, true);
});

test('a dead (X) process with unreadable descriptors is gone', (t) => {
    const root = procRoot(t, [{ pid: 15, state: 'X', unreadableFd: true }, { pid: 16 }]);
    assert.deepEqual(view(root).listProcesses().map((entry) => entry.pid), [16]);
});


// ---- M-36: a robot's pthread_exit trick leaves a zombie leader with a live thread ----------------------------------------------
// Observed: leader State Z, Threads 2, fd EACCES, ns/mnt and ns/net unreadable, ns/pid readable; the live thread's ns links and fd are readable.

test('M-36: a zombie leader with a live thread is classified by the thread, not left opaque', (t) => {
    const root = procRoot(t, [{ pid: 20, state: 'Z', threads: 2, unreadableFd: true, leaderNs: ['pid'], tasks: [
        { tid: 20, unreadable: true }, // the leader's own task entry: unreadable like the leader
        { tid: 21, ns: { pid: 4026531020, mnt: 4026534321, net: 4026534264 }, fds: ['net:[4026534264]', 'socket:[1]'] }
    ] }]);
    const [entry] = view(root).listProcesses();
    assert.equal(entry.pid, 20);
    assert.equal(entry.opaque, undefined, 'readable through the thread: not opaque');
    assert.deepEqual([entry.pidNs, entry.netNs, entry.mntNs], ['4026531020', '4026534264', '4026534321']);
    assert.deepEqual(entry.fdNs, ['4026534264']);
    assert.deepEqual(entry.threadNs, { pidNs: ['4026531020'], netNs: ['4026534264'], mntNs: ['4026534321'] });
});

test('M-36: threads may hold different namespaces (setns is per thread): the union is reported, the leader\'s own value stays primary', (t) => {
    const root = procRoot(t, [{ pid: 30, state: 'Z', threads: 3, unreadableFd: true, leaderNs: ['pid', 'net'], tasks: [
        { tid: 31, ns: { pid: 4026531030, mnt: 4026539001, net: 4026539101 }, fds: ['mnt:[4026539001]'] },
        { tid: 32, ns: { pid: 4026531030, mnt: 4026539002, net: 4026539102 }, fds: ['net:[4026539102]'] }
    ] }]);
    const [entry] = view(root).listProcesses();
    assert.equal(entry.netNs, String(4026531030), 'the leader\'s readable value is the primary');
    assert.deepEqual(entry.threadNs.netNs.sort(), ['4026531030', '4026539101', '4026539102']);
    assert.deepEqual(entry.threadNs.mntNs, ['4026539001', '4026539002']);
    assert.equal(entry.mntNs, '4026539001', 'unreadable on the leader: the first thread that can be read');
    assert.deepEqual(entry.fdNs.sort(), ['4026539001', '4026539102'], 'descriptors of every thread');
    assert.equal(entry.opaque, undefined);
});

test('M-36: opaque only when NO thread is readable: all threads exiting, or no thread at all, keeps the process present and unknowable', (t) => {
    const noneReadable = procRoot(t, [{ pid: 40, state: 'Z', threads: 3, unreadableFd: true, leaderNs: [], tasks: [{ tid: 41, unreadable: true }, { tid: 42, unreadable: true }] }]);
    const [entry] = view(noneReadable).listProcesses();
    assert.equal(entry.opaque, true);
    assert.deepEqual([entry.pidNs, entry.netNs, entry.mntNs, entry.fdNs], [null, null, null, []]);
    const partial = procRoot(t, [{ pid: 50, state: 'Z', threads: 2, unreadableFd: true, leaderNs: ['pid'], tasks: [{ tid: 51, ns: { pid: 4026531050, net: 4026539150 }, fds: [] }] }]);
    const [part] = view(partial).listProcesses();
    assert.equal(part.opaque, true, 'the mount namespace is readable from nowhere: still unknowable');
    assert.equal(part.netNs, '4026539150');
    assert.equal(part.mntNs, null);
    const gone = procRoot(t, [{ pid: 60, state: 'Z', threads: 1, unreadableFd: true, leaderNs: [] }]);
    assert.deepEqual(view(gone).listProcesses(), [], 'a zombie with a single thread has nothing to read and is gone');
});

test('M-36: a readable leader is not scanned thread by thread (cost), and a leader with only its fd unreadable is completed by the threads', (t) => {
    const root = procRoot(t, [{ pid: 70, tasks: [{ tid: 71, ns: { pid: 1, mnt: 2, net: 3 } }] }, { pid: 80, state: 'R', threads: 2, unreadableFd: true, tasks: [{ tid: 81, ns: { pid: 4, mnt: 5, net: 6 }, fds: ['pid:[4026531080]'] }] }]);
    const spying = createProcView({ procRoot: root, signal: () => {} });
    const [plain, completed] = spying.listProcesses();
    assert.equal(plain.threadNs, undefined, 'fully readable: the threads were never touched');
    assert.equal(completed.opaque, undefined);
    assert.deepEqual(completed.fdNs, ['4026531080']);
});

test('namespace pins belong to an owner: a later sandbox pinning the same inode number does not make an earlier one look pinned', (t) => {
    const root = procRoot(t, [{ pid: 1 }]);
    const v = view(root);
    const unpinFirst = v.pinNamespace('pid', '4026534333', '100:1000');
    assert.equal(v.isPinned('pid', '4026534333', '100:1000'), true);
    assert.equal(v.isPinned('pid', '4026534333'), true, 'without an owner: pinned by anyone');
    unpinFirst();
    assert.equal(v.isPinned('pid', '4026534333', '100:1000'), false);
    assert.equal(v.isPinned('pid', '4026534333'), false);
    const unpinSecond = v.pinNamespace('pid', '4026534333', '200:2000');
    assert.equal(v.isPinned('pid', '4026534333', '100:1000'), false, 'the number is pinned again, by someone else');
    assert.equal(v.isPinned('pid', '4026534333', '200:2000'), true);
    assert.equal(v.isPinned('mnt', '4026534333', '200:2000'), false, 'type is part of the key');
    // counted per owner, and unpin is idempotent
    const again = v.pinNamespace('pid', '4026534333', '200:2000');
    unpinSecond(); unpinSecond();
    assert.equal(v.isPinned('pid', '4026534333', '200:2000'), true);
    again();
    assert.equal(v.isPinned('pid', '4026534333'), false);
});
