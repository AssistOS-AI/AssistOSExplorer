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

test('a zombie leader with live threads, and a live process with unreadable descriptors, still fail closed with proc_unreadable', (t) => {
    const leader = procRoot(t, [{ pid: 12, state: 'Z', threads: 2, unreadableFd: true }]);
    assert.throws(() => view(leader).listProcesses(), { code: 'proc_unreadable' });
    const live = procRoot(t, [{ pid: 13, unreadableFd: true }]);
    assert.throws(() => view(live).listProcesses(), { code: 'proc_unreadable' });
    assert.throws(() => view(live).process(13), { code: 'proc_unreadable' });
});
