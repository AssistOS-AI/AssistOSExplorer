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
    for (const { pid, state = 'S', threads = 1, unreadableFd = false } of entries) {
        const dir = path.join(root, String(pid));
        fs.mkdirSync(path.join(dir, 'ns'), { recursive: true });
        fs.writeFileSync(path.join(dir, 'stat'), `${pid} (x) ${state} 1 ${pid} ${pid} 0 -1 0 0 0 0 0 0 0 0 0 20 0 ${threads} 0 ${1000 + pid} 0 0 0\n`);
        fs.writeFileSync(path.join(dir, 'cmdline'), 'x\0');
        fs.writeFileSync(path.join(dir, 'status'), `Name:\tx\nState:\t${state} (state)\nThreads:\t${threads}\n`);
        for (const type of ['pid', 'mnt', 'net']) fs.symlinkSync(`${type}:[${4026531000 + pid}]`, path.join(dir, 'ns', type));
        if (unreadableFd) fs.symlinkSync('fd', path.join(dir, 'fd')); else fs.mkdirSync(path.join(dir, 'fd'));
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
    assert.deepEqual(listed[0], { pid: 12, ppid: 1, startTime: '1012', cmdline: ['x'], pidNs: null, netNs: null, mntNs: null, fdNs: [], opaque: true });
    assert.equal(listed[1].opaque, undefined);
    assert.equal(view(root).process(12).opaque, true);
});

test('a dead (X) process with unreadable descriptors is gone', (t) => {
    const root = procRoot(t, [{ pid: 15, state: 'X', unreadableFd: true }, { pid: 16 }]);
    assert.deepEqual(view(root).listProcesses().map((entry) => entry.pid), [16]);
});
