// M-65 (anchor): the execution anchor is spawned outside the launcher chain. A descriptor the worker holds without close-on-exec (node-pty's
// PTY master of a robot terminal) is inherited by it, so ANCHOR_SCRIPT must close every inherited descriptor >= 3 before it waits and
// before its `exec sleep`. The inherited descriptors are planted in spawn slots (a slot >= 3 is open in the child without close-on-exec,
// exactly as an inherited non-CLOEXEC descriptor is), at 5, 12 and 23 (23 is where the M-65 driver holds a PTY master).
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { ANCHOR_SCRIPT } from '../../server/sandbox/executionSupervisor.mjs';

const MARKER = 'rwAnchorMarker0123456789';
const DASH = ['/usr/bin/dash', '/bin/dash'].find((file) => fs.existsSync(file)) ?? null;
const BASH = ['/bin/bash', '/usr/bin/bash'].find((file) => fs.existsSync(file)) ?? null;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function anchorFds(shell, planted, script = ANCHOR_SCRIPT) {
    const ptmx = fs.openSync('/dev/ptmx', fs.constants.O_RDWR | fs.constants.O_NOCTTY);
    try {
        const stdio = ['pipe', 'ignore', 'ignore'];
        for (const slot of planted) { while (stdio.length < slot) stdio.push('ignore'); stdio[slot] = ptmx; }
        const child = spawn(shell, ['-c', script, 'rw-anchor', MARKER], { stdio });
        const exited = new Promise((resolve) => child.once('exit', (code) => resolve(code)));
        try {
            // Before the gate: the inherited descriptors are already closed while the anchor waits on its stdin.
            await sleep(150);
            let before = null;
            try { before = fs.readdirSync(`/proc/${child.pid}/fd`).map(Number).sort((a, b) => a - b); } catch { before = null; }
            child.stdin.write('1\n');
            let after = null;
            for (let i = 0; i < 300 && after === null; i += 1) {
                try {
                    const cmdline = fs.readFileSync(`/proc/${child.pid}/cmdline`, 'utf8').split('\0');
                    if (cmdline[0].endsWith('sleep')) after = fs.readdirSync(`/proc/${child.pid}/fd`).map(Number).sort((a, b) => a - b);
                } catch { break; }
                if (after === null) await sleep(10);
            }
            const code = await Promise.race([exited, sleep(50).then(() => 'running')]);
            return { before, after, code };
        } finally {
            child.kill('SIGKILL');
            await exited;
        }
    } finally {
        fs.closeSync(ptmx);
    }
}

for (const [label, shell] of [['/bin/sh', '/bin/sh'], ...(BASH ? [['bash', BASH]] : [])]) {
    test(`M-65 anchor (${label}): inherited non-close-on-exec descriptors (5, 12, 23: a PTY master) are not open in the anchor's sleep process`, async () => {
        const { before, after, code } = await anchorFds(shell, [5, 12, 23]);
        assert.equal(code, 'running', 'the anchor waits in sleep');
        assert.deepEqual(before, [0, 1, 2], 'closed already while waiting at the gate');
        assert.deepEqual(after, [0, 1, 2]);
    });
}

test('M-65 anchor: the positive control: the same planted descriptors ARE open in a shell that does not close them', async () => {
    const ptmx = fs.openSync('/dev/ptmx', fs.constants.O_RDWR | fs.constants.O_NOCTTY);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rw-anchorfd-'));
    try {
        const out = path.join(dir, 'fds');
        const stdio = ['ignore', 'ignore', 'ignore'];
        for (const slot of [5, 12, 23]) { while (stdio.length < slot) stdio.push('ignore'); stdio[slot] = ptmx; }
        const child = spawn('/bin/sh', ['-c', `ls /proc/self/fd > ${out}`], { stdio });
        await new Promise((resolve) => child.once('exit', resolve));
        const listed = fs.readFileSync(out, 'utf8').split('\n').filter(Boolean).map(Number);
        for (const fd of [5, 12, 23]) assert.ok(listed.includes(fd), `fd ${fd} is inherited without close-on-exec`);
    } finally {
        fs.closeSync(ptmx);
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

if (DASH) {
    test('M-65 anchor (dash): a single-digit leak is closed in dash; one >= 10 is closed through the bash re-exec; without bash it fails closed (exit 72)', async () => {
        const small = await anchorFds(DASH, [5]);
        assert.deepEqual([small.code, small.after], ['running', [0, 1, 2]]);
        const big = await anchorFds(DASH, [5, 23]);
        assert.deepEqual([big.code, big.before, big.after], ['running', [0, 1, 2], [0, 1, 2]]);
        const noBash = await anchorFds(DASH, [5, 23], ANCHOR_SCRIPT.replaceAll('/bin/bash', '/nonexistent/bash'));
        assert.equal(noBash.code, 72);
        assert.equal(noBash.after, null, 'never reaches sleep');
    });
}
