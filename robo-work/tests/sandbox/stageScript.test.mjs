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
        const r = run(['final', '0,1,2,3', 'KEEP,UNSET_ONE', '/bin/sh', '-c', probe], { stdio, env: { PATH: process.env.PATH, KEEP: '1', LEAK: 'no' } });
        assert.equal(r.status, 0, r.stderr);
        const lines = r.stdout.split('\n').filter(Boolean);
        const fdNumbers = lines.filter((l) => l.startsWith('fd ')).map((l) => Number(l.split(' ')[1])).filter((n) => n >= 3);
        assert.deepEqual(fdNumbers, [3], 'only the allowlisted fd >= 3 remains');
        const env = lines.filter((l) => l.includes('='));
        assert.ok(env.includes('KEEP=1'));
        assert.ok(env.every((l) => l === 'KEEP=1' || l.startsWith('PWD=') || l.startsWith('_=') || l.startsWith('OLDPWD=') || l.startsWith('SHLVL=')), env.join(','));
    } finally { for (const fd of fds) fs.closeSync(fd); }
}));

test('final: only the named variables survive; values with spaces, quotes and newlines are exact and never on a command line', () => {
    const value = 'a b\n"c" $(id) \'d\' ;*';
    const r = run(['final', '0,1,2', 'ONE,TWO', '/usr/bin/env'], { env: { PATH: process.env.PATH, ONE: value, TWO: '', OTHER: 'x', IFS: 'x' } });
    assert.equal(r.status, 0, r.stderr);
    assert.ok(r.stdout.includes(`ONE=${value}`));
    assert.ok(r.stdout.includes('\nTWO=\n') || r.stdout.startsWith('TWO=\n') || r.stdout.endsWith('TWO=\n'));
    assert.ok(!/OTHER|^IFS=/m.test(r.stdout));
    const ps = run(['final', '0,1,2', 'ONE', '/bin/sh', '-c', 'cat /proc/$$/cmdline | tr "\\0" " "'], { env: { PATH: process.env.PATH, ONE: 'sekrit-value' } });
    assert.ok(!ps.stdout.includes('sekrit-value'));
});

test('final: every env name is checked on its own: empty, digit-first and metacharacter names are refused before anything runs', () => {
    for (const names of ['A,,B', ',A', '1A', 'A,2B', 'A-B', 'A B', 'A;id', 'A$B', 'A=B', 'A.B', 'A*']) {
        assert.equal(run(['final', '0,1,2', names, '/usr/bin/env'], { env: { PATH: process.env.PATH, A: 'x', B: 'y' } }).status, 64, names);
    }
    assert.equal(run(['final', '0,1,2', 'A,B_2,_C', '/usr/bin/true']).status, 0);
});

test('prep: a marker that begins with a dash (an S1 id does so about once in 64) is passed verbatim to prep and to bwrap', () => tmp((dir) => {
    const dashed = '-abc_DEF-0123456789xyz';
    const stage = prepFixture(dir, `import fs from 'node:fs'; fs.writeFileSync(${JSON.stringify(path.join(dir, 'prep.arg'))}, process.argv[2]);`, '#!/bin/sh\necho "$@"\n');
    const r = spawnSync('/bin/sh', [stage, 'prep', dashed, String(process.pid), '', '4', SPEC, '0,1,2,4', '--', '/bin/cmd'], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(fs.readFileSync(path.join(dir, 'prep.arg'), 'utf8'), dashed);
    assert.equal(r.stdout, `--unshare-uts --unsetenv ${dashed} --args 4 -- /bin/cmd\n`);
}));

test('final: bad arguments are refused', () => {
    assert.equal(run(['final', 'x', 'A', '/bin/true']).status, 64);
    assert.equal(run(['final', '0,1,2', 'A;id', '/bin/true']).status, 64);
    assert.equal(run(['final', '0,1,2', '/bin/true']).status, 64);
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
const MARKER = 'rwMarker0123456789_-ab';
const SPEC = '{"spec":1}';
const KEEP = '0,1,2,3,4';

test('prep: non-zero exit of prep is propagated and bwrap never runs', () => tmp((dir) => {
    const stage = prepFixture(dir, 'process.exit(37);', '#!/bin/sh\ntouch "$0.ran"\n');
    const r = spawnSync('/bin/sh', [stage, 'prep', MARKER, String(process.pid), '5', '4', SPEC, '0,1,2,4,5', '--', '/bin/true'], { encoding: 'utf8' });
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
        const r = spawnSync('/bin/sh', [stage, 'prep', MARKER, String(process.pid), '3', '4', SPEC, '0,1,2,3,4', '--', '/bin/cmd', 'a b', '--x'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe', grant, keep] });
        assert.equal(r.status, 0, r.stderr);
        assert.ok(r.stdout.startsWith(`--unshare-uts --unsetenv ${MARKER} --args 4 -- /bin/cmd a b --x\n`), r.stdout);
        const open = r.stdout.split('\n').filter((l) => l.startsWith('fd ')).map((l) => Number(l.split(' ')[1])).filter((n) => n >= 3);
        assert.deepEqual(open, [4], 'grant fd 3 closed, bwrap args fd 4 kept');
        assert.equal(fs.readFileSync(path.join(dir, 'prep.out'), 'utf8').split(' ')[0], MARKER);
        assert.equal(fs.readFileSync(path.join(dir, 'prep.out'), 'utf8').split(' ')[1], SPEC, 'prep receives the spec, not the bwrap command');
    } finally { fs.closeSync(grant); fs.closeSync(keep); }
}));

test('prep: a changed parent (PPID mismatch) refuses before bwrap', () => tmp((dir) => {
    const stage = prepFixture(dir, '', '#!/bin/sh\ntouch "$0.ran"\n');
    const r = spawnSync('/bin/sh', [stage, 'prep', MARKER, String(process.pid + 1), '5', '4', SPEC, '0,1,2,4,5', '--', '/bin/true'], { encoding: 'utf8' });
    assert.equal(r.status, 70);
    assert.ok(!fs.existsSync(path.join(dir, 'fake-bwrap.ran')));
}));

test('prep: malformed arguments are refused', () => {
    assert.equal(run(['prep', 'bad', '1', '3', '4', SPEC, '--', '/bin/true']).status, 64, 'too short');
    assert.equal(run(['prep', 'rw bad marker1', '1', '3', '4', SPEC, KEEP, '--', '/bin/true']).status, 64, 'characters outside the marker set');
    assert.equal(run(['prep', MARKER, 'x', '3', '4', SPEC, KEEP, '--', '/bin/true']).status, 64);
    assert.equal(run(['prep', MARKER, '1', '3', '4', SPEC, KEEP, 'nodashes', '/bin/true']).status, 64);
    assert.equal(run(['prep', MARKER, '1', '3', '4', SPEC, KEEP, '--']).status, 64, 'a command is required');
    assert.equal(run(['prep', 'a'.repeat(65), '1', '3', '4', SPEC, KEEP, '--', '/bin/true']).status, 64, 'too long');
    // M-65 keep set: digits only, no empty element, and it must list the args fd and every grant fd
    for (const keep of ['', ',', '0,,1,3,4', '0,1,3,4,', ',0,1,3,4', '0,1,x,3,4', '0 1 3 4', '0;1,3,4']) {
        assert.equal(run(['prep', MARKER, '1', '3', '4', SPEC, keep, '--', '/bin/true']).status, 64, `keep ${JSON.stringify(keep)}`);
    }
    assert.equal(run(['prep', MARKER, '1', '3', '4', SPEC, '0,1,2,3', '--', '/bin/true']).status, 64, 'args fd not in the keep set');
    assert.equal(run(['prep', MARKER, '1', '3,5', '4', SPEC, '0,1,2,3,4', '--', '/bin/true']).status, 64, 'a grant fd not in the keep set');
    assert.equal(run(['prep', MARKER, '1', '3,,5', '4', SPEC, '0,1,2,3,4,5', '--', '/bin/true']).status, 64, 'an empty grant element');
});

test('M-47: the setpriv that starts node prep, and node prep itself, carry the marker on their argv; so does the final exec of bwrap', () => tmp((dir) => {
    const stage = prepFixture(dir, `import fs from 'node:fs'; fs.writeFileSync(${JSON.stringify(path.join(dir, 'prep.argv'))}, JSON.stringify(process.argv));`, '#!/bin/sh\necho "$@"\n');
    // a setpriv that records its argv and then runs the rest of the command line, as the real one does
    const bin = path.join(dir, 'bin');
    fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, 'setpriv'), `#!/bin/sh\nprintf '%s\\n' "$@" > ${JSON.stringify(path.join(dir, 'setpriv.argv'))}\nshift 3\nexec "$@"\n`, { mode: 0o755 });
    const dashed = '-qZ9_prepMarker0123456789';
    const r = spawnSync('/bin/sh', [stage, 'prep', dashed, String(process.pid), '', '4', SPEC, '0,1,2,4', '--', '/bin/cmd'], { encoding: 'utf8', env: { PATH: `${bin}:${process.env.PATH}` } });
    assert.equal(r.status, 0, r.stderr);
    assert.ok(fs.readFileSync(path.join(dir, 'setpriv.argv'), 'utf8').split('\n').includes(dashed), 'setpriv');
    assert.ok(JSON.parse(fs.readFileSync(path.join(dir, 'prep.argv'), 'utf8')).includes(dashed), 'node sandboxPrep.mjs');
    assert.ok(r.stdout.split(' ').includes(dashed), 'bwrap');
}));
