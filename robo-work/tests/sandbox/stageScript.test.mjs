import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const STAGE = fileURLToPath(new URL('../../server/sandbox/stage.sh', import.meta.url));
const run = (args, options = {}) => spawnSync('/bin/sh', [STAGE, ...args], { encoding: 'utf8', ...options });

function tmp(fn) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rw-stage-'));
    try { return fn(dir); } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

test('final: closes non-allowlisted fds (including >= 10), clears env, runs the command', () => tmp((dir) => {
    const file = path.join(dir, 'f');
    fs.writeFileSync(file, 'x');
    const fds = [0, 1, 2, 3, 4].map(() => fs.openSync(file, 'r'));
    try {
        // child fds: 3 (allowed), 4, 5, 11 (via padding)
        const stdio = ['ignore', 'pipe', 'pipe', fds[0], fds[1], fds[2]];
        for (let i = 6; i < 11; i += 1) stdio.push(fds[3]);
        stdio.push(fds[4]);
        const probe = 'for f in /proc/self/fd/*; do n=${f##*/}; l=$(readlink "$f" 2>/dev/null) || continue; case $l in */fd|*/stage.sh) continue;; esac; echo "fd $n $l"; done; /usr/bin/env';
        const r = run(['final', '0,1,2,3', 'KEEP=1', '/bin/sh', '-c', probe], { stdio });
        assert.equal(r.status, 0, r.stderr);
        const lines = r.stdout.split('\n').filter(Boolean);
        const fdNumbers = lines.filter((l) => l.startsWith('fd ')).map((l) => Number(l.split(' ')[1])).filter((n) => n >= 3);
        assert.deepEqual(fdNumbers, [3], 'only the allowlisted fd >= 3 remains');
        const env = lines.filter((l) => l.includes('='));
        assert.ok(env.includes('KEEP=1'));
        assert.ok(env.every((l) => l === 'KEEP=1' || l.startsWith('PWD=') || l.startsWith('_=') || l.startsWith('OLDPWD=') || l.startsWith('SHLVL=')), env.join(','));
    } finally { for (const fd of fds) fs.closeSync(fd); }
}));

test('final: bad arguments are refused', () => {
    assert.equal(run(['final', 'x', '/bin/true']).status, 64);
    assert.equal(run(['final']).status, 64);
    assert.equal(run(['bogus']).status, 64);
});

function prepFixture(dir, prepBody, bwrapBody) {
    const stage = path.join(dir, 'stage.sh');
    fs.writeFileSync(stage, fs.readFileSync(STAGE, 'utf8').replace('/usr/bin/bwrap', path.join(dir, 'fake-bwrap')), { mode: 0o755 });
    fs.writeFileSync(path.join(dir, 'sandboxPrep.mjs'), prepBody);
    fs.writeFileSync(path.join(dir, 'fake-bwrap'), bwrapBody, { mode: 0o755 });
    return stage;
}
const MARKER = 'rw-0123456789ab';

test('prep: non-zero exit of prep is propagated and bwrap never runs', () => tmp((dir) => {
    const stage = prepFixture(dir, 'process.exit(37);', '#!/bin/sh\ntouch "$0.ran"\n');
    const r = spawnSync('/bin/sh', [stage, 'prep', MARKER, String(process.pid), '5', '4'], { encoding: 'utf8' });
    assert.equal(r.status, 37);
    assert.ok(!fs.existsSync(path.join(dir, 'fake-bwrap.ran')));
}));

test('prep: success closes grant fds and execs bwrap with the marker on real argv; prep receives marker', () => tmp((dir) => {
    const file = path.join(dir, 'f');
    fs.writeFileSync(file, 'x');
    const grant = fs.openSync(file, 'r');
    const keep = fs.openSync(file, 'r');
    try {
        const stage = prepFixture(dir,
            `import fs from 'node:fs'; fs.writeFileSync(${JSON.stringify(path.join(dir, 'prep.out'))}, process.argv.slice(2).join(' ') + ' grant=' + fs.existsSync('/proc/self/fd/3'));`,
            '#!/bin/sh\necho "$@"\nfor f in /proc/self/fd/*; do l=$(readlink "$f" 2>/dev/null) || continue; case $l in */fd) continue;; esac; echo "fd ${f##*/}"; done\n');
        const r = spawnSync('/bin/sh', [stage, 'prep', MARKER, String(process.pid), '3', '4', 'extra'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe', grant, keep] });
        assert.equal(r.status, 0, r.stderr);
        assert.ok(r.stdout.startsWith(`--unshare-uts --hostname ${MARKER} --args 4\n`), r.stdout);
        const open = r.stdout.split('\n').filter((l) => l.startsWith('fd ')).map((l) => Number(l.split(' ')[1])).filter((n) => n >= 3);
        assert.deepEqual(open, [4], 'grant fd 3 closed, bwrap args fd 4 kept');
        assert.equal(fs.readFileSync(path.join(dir, 'prep.out'), 'utf8').split(' ')[0], MARKER);
        assert.ok(fs.readFileSync(path.join(dir, 'prep.out'), 'utf8').includes('extra'));
    } finally { fs.closeSync(grant); fs.closeSync(keep); }
}));

test('prep: a changed parent (PPID mismatch) refuses before bwrap', () => tmp((dir) => {
    const stage = prepFixture(dir, '', '#!/bin/sh\ntouch "$0.ran"\n');
    const r = spawnSync('/bin/sh', [stage, 'prep', MARKER, String(process.pid + 1), '5', '4'], { encoding: 'utf8' });
    assert.equal(r.status, 70);
    assert.ok(!fs.existsSync(path.join(dir, 'fake-bwrap.ran')));
}));

test('prep: malformed arguments are refused', () => {
    assert.equal(run(['prep', 'bad', '1', '3', '4']).status, 64);
    assert.equal(run(['prep', MARKER, 'x', '3', '4']).status, 64);
});
