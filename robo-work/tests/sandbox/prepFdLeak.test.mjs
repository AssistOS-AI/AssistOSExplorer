// M-65: no PTY master, and no other descriptor outside the chain's keep set, may reach node prep, bwrap or anything bwrap
// starts. node-pty leaves a robot terminal's PTY master WITHOUT close-on-exec in the worker, and Node/libuv does not close
// such descriptors at spawn; `stage.sh prep` must close them before node prep runs and before it execs bwrap.
//
// Shims list the descriptors their successor inherits with `ls -l /proc/self/fd` run as a child (a listing of the shim's own
// pid would also show dash's close-on-exec script descriptor and the copies it saves while redirecting):
// the setpriv that starts node prep (`setpriv.node.*`), the outer setpriv of the chain (`setpriv.unshare.*` /
// `setpriv.nsenter.*`, the positive control: it runs BEFORE stage.sh and must still show the leak), and the stub bwrap.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { createSandboxLauncher } from '../../server/sandbox/sandboxLauncher.mjs';
import { readProcMasks } from '../../server/sandbox/procMasks.mjs';
import { createFakeView } from './helpers/fakes.mjs';

const STAGE = fileURLToPath(new URL('../../server/sandbox/stage.sh', import.meta.url));
const DRIVER = fileURLToPath(new URL('./helpers/fdLeakDriver.mjs', import.meta.url));
const MARKER = 'rwFdLeakMarker0123456789';
const SPEC = '{"spec":1}';
const range = (from, to) => Array.from({ length: to - from + 1 }, (_, i) => from + i);
// Shells: /bin/sh as the host has it, bash, bash started under the name `sh` (POSIX mode, as in the worker image, where /bin/sh
// is bash), and dash explicitly (the dash-only paths: single-digit redirections, the bash re-exec, exit 72 without bash).
const DASH = ['/usr/bin/dash', '/bin/dash'].find((file) => fs.existsSync(file)) ?? null;
const NO_DASH = DASH ? false : 'dash is not installed: the dash-only cases did not run (not a pass)';
const SHELLS = ['/bin/sh', '/bin/bash', 'sh->bash', ...(DASH ? [DASH] : [])];
const shellPath = (ctx, shell) => (shell === 'sh->bash' ? ctx.shAsBash : shell);

// A scratch world: shims (setpriv, nsenter, unshare), a stage.sh copy whose bwrap is a stub that lists its descriptors, an
// empty node prep, and a dumps directory. `noBash` points the copy's bash at a path that does not exist.
function world(fn, { noBash = false } = {}) {
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'rw-fdleak-')));
    try {
        const dumps = path.join(dir, 'dumps');
        const shims = path.join(dir, 'shims');
        const stageDir = path.join(dir, 'stage');
        for (const d of [dumps, shims, stageDir]) fs.mkdirSync(d);
        const write = (file, text) => fs.writeFileSync(file, text, { mode: 0o755 });
        write(path.join(shims, 'setpriv'), `#!/bin/sh\nls -l /proc/self/fd > ${JSON.stringify(dumps)}/setpriv.$4.$$ 2>/dev/null\nshift 3\nexec "$@"\n`);
        write(path.join(shims, 'nsenter'), '#!/bin/sh\nshift 2\nexec "$@"\n');
        write(path.join(shims, 'unshare'), '#!/bin/sh\nshift 4\nexec "$@"\n');
        const bwrap = path.join(dir, 'fake-bwrap');
        write(bwrap, `#!/bin/sh\nls -l /proc/self/fd > ${JSON.stringify(dumps)}/bwrap.$$ 2>/dev/null\nexit 0\n`);
        let text = fs.readFileSync(STAGE, 'utf8').replaceAll('/usr/bin/bwrap', bwrap);
        if (noBash) text = text.replaceAll('/bin/bash', path.join(dir, 'no-such-bash'));
        const stage = path.join(stageDir, 'stage.sh');
        write(stage, text);
        fs.writeFileSync(path.join(stageDir, 'sandboxPrep.mjs'), '');
        const file = path.join(dir, 'slot');
        fs.writeFileSync(file, 'x');
        fs.mkdirSync(path.join(dir, 'shbin'));
        const shAsBash = path.join(dir, 'shbin', 'sh');
        fs.symlinkSync('/bin/bash', shAsBash);
        const ctx = {
            dir, dumps, shims, stage, file, shAsBash,
            env: { PATH: `${shims}:/usr/local/bin:/usr/bin:/bin` },
            // [Map(fd -> target)] of every dump whose name starts with prefix; ls's own descriptors (its output file, the
            // /proc/<ls>/fd directory) are dropped, and so is the shim's own script (a dash shim started with 0-9 in use opens
            // it at fd 10 without close-on-exec; the real setpriv and bwrap are binaries)
            dump(prefix) {
                const found = fs.readdirSync(dumps).filter((name) => name.startsWith(prefix));
                const own = prefix.startsWith('bwrap') ? bwrap : path.join(shims, 'setpriv');
                return found.map((name) => {
                    const fds = new Map();
                    for (const line of fs.readFileSync(path.join(dumps, name), 'utf8').split('\n')) {
                        const m = / ([0-9]+) -> (.*)$/u.exec(line);
                        if (m && m[2] !== path.join(dumps, name) && m[2] !== own && !/^\/proc\/[0-9]+\/fd$/u.test(m[2])) fds.set(Number(m[1]), m[2]);
                    }
                    return fds;
                });
            }
        };
        return fn(ctx);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

const above2 = (fds) => [...fds.keys()].filter((fd) => fd >= 3).sort((a, b) => a - b);
const isPtmx = (target) => /(^|\/)ptmx$/u.test(target);

// Checks one dump: exactly the expected fds >= 3, and no PTY master anywhere.
function assertOnly(ctx, prefix, expected, label) {
    const dumps = ctx.dump(prefix);
    assert.equal(dumps.length, 1, `${label}: exactly one ${prefix} listing (the stage ran)`);
    const [fds] = dumps;
    assert.deepEqual(above2(fds), expected, `${label}: ${prefix} holds exactly the keep set (${JSON.stringify([...fds])})`);
    assert.ok(![...fds.values()].some(isPtmx), `${label}: no PTY master reaches ${prefix}`);
}

// stdio for a direct `stage.sh prep` run: workload layout (3 seccomp | 4 block | 5 info | 6 status | 7 args), then `extra`
// (slot -> fd), holes 'ignore'. libuv leaves an 'ignore' slot >= 3 untouched; it ends up closed in the child only because the
// test runner's own descriptor at that number (if any) is close-on-exec.
function layoutStdio(ctx, fds, extra) {
    const stdio = ['ignore', 'pipe', 'pipe', fds.file, 'pipe', 'pipe', 'pipe', fds.file];
    for (const [slot, fd] of Object.entries(extra)) { while (stdio.length <= Number(slot)) stdio.push('ignore'); stdio[Number(slot)] = fd; }
    return stdio;
}

function withFds(ctx, fn) {
    const fds = { file: fs.openSync(ctx.file, 'r'), ptmx: fs.openSync('/dev/ptmx', 'r+') };
    try { return fn(fds); } finally { fs.closeSync(fds.file); fs.closeSync(fds.ptmx); }
}

const prep = (ctx, { grants = '', keep = '0,1,2,3,4,5,6,7', stdio, shell = '/bin/sh' }) => spawnSync(shellPath(ctx, shell), [ctx.stage, 'prep', MARKER, String(process.pid), grants, '7', SPEC, keep, '--', '/bin/cmd'],
    { encoding: 'utf8', stdio, env: ctx.env });

for (const shell of SHELLS) {
    test(`M-65 prep (${shell}): a leaked PTY master at a single-digit fd (8, 9) is closed before node prep runs and before bwrap is exec'd`, () => world((ctx) => withFds(ctx, (fds) => {
        const r = prep(ctx, { shell, stdio: layoutStdio(ctx, fds, { 8: fds.ptmx, 9: fds.ptmx }) });
        assert.equal(r.status, 0, r.stderr);
        assertOnly(ctx, 'setpriv.node.', range(3, 7), 'single-digit');
        assertOnly(ctx, 'bwrap.', range(3, 7), 'single-digit');
    })));

    test(`M-65 prep (${shell}): leaks at fds >= 10 (12, 23) and a file at 9-11 are closed (dash: through the bash re-exec); a grant fd is kept for prep and closed before bwrap`, () => world((ctx) => withFds(ctx, (fds) => {
        const r = prep(ctx, { shell, grants: '8', keep: '0,1,2,3,4,5,6,7,8', stdio: layoutStdio(ctx, fds, { 8: fds.file, 9: fds.file, 10: fds.file, 11: fds.file, 12: fds.ptmx, 23: fds.ptmx }) });
        assert.equal(r.status, 0, r.stderr);
        assertOnly(ctx, 'setpriv.node.', range(3, 8), '>= 10');
        assertOnly(ctx, 'bwrap.', range(3, 7), '>= 10');
    })));
}

test('M-65 prep (dash): bash absent and a fd >= 10 must be closed: fail closed (exit 72) before node prep and bwrap', { skip: NO_DASH }, () => world((ctx) => withFds(ctx, (fds) => {
    const r = prep(ctx, { shell: DASH, stdio: layoutStdio(ctx, fds, { 12: fds.ptmx }) });
    assert.equal(r.status, 72, r.stderr);
    assert.deepEqual(fs.readdirSync(ctx.dumps), [], 'neither node prep nor bwrap ran');
}), { noBash: true }));

// Slot 8 stays free, so dash opens its script below 10 and moves it to 10+ close-on-exec: nothing needs bash.
test('M-65 prep (dash): bash absent, a single-digit leak only (9): dash closes it itself (no re-exec needed)', { skip: NO_DASH }, () => world((ctx) => withFds(ctx, (fds) => {
    const r = prep(ctx, { shell: DASH, stdio: layoutStdio(ctx, fds, { 9: fds.ptmx }) });
    assert.equal(r.status, 0, r.stderr);
    assertOnly(ctx, 'setpriv.node.', range(3, 7), 'dash');
    assertOnly(ctx, 'bwrap.', range(3, 7), 'dash');
}), { noBash: true }));

// The endpoint layout fills 0-9, so dash opens the script itself at fd 10 and does NOT mark it close-on-exec; bash (the
// worker image's /bin/sh) keeps its own at 255, close-on-exec. Either way the script's descriptor must not reach prep, bwrap
// or the command `final` execs.
const ENDPOINT_KEEP = '0,1,2,3,4,5,6,7,8,9';
const endpointStdio = (fds) => ['ignore', 'pipe', 'pipe', 'pipe', 'pipe', fds.file, 'pipe', 'pipe', 'pipe', fds.file];
for (const shell of SHELLS) {
    test(`M-65 prep and final (${shell}): with 0-9 all in use, the stage script's own descriptor reaches neither node prep, nor bwrap, nor the final command`, () => world((ctx) => withFds(ctx, (fds) => {
        const stdio = endpointStdio(fds);
        const r = spawnSync(shellPath(ctx, shell), [ctx.stage, 'prep', MARKER, String(process.pid), '', '9', SPEC, ENDPOINT_KEEP, '--', '/bin/cmd'], { encoding: 'utf8', stdio, env: ctx.env });
        assert.equal(r.status, 0, r.stderr);
        assertOnly(ctx, 'setpriv.node.', range(3, 9), `${shell} endpoint layout`);
        assertOnly(ctx, 'bwrap.', range(3, 9), `${shell} endpoint layout`);
        const f = spawnSync(shellPath(ctx, shell), [ctx.stage, 'final', ENDPOINT_KEEP, '', '/bin/ls', '-l', '/proc/self/fd'], { encoding: 'utf8', stdio, env: ctx.env });
        assert.equal(f.status, 0, `final: ${f.stderr}`);
        const open = f.stdout.split('\n').map((line) => / ([0-9]+) -> (.*)$/u.exec(line)).filter((m) => m && !/^\/proc\/[0-9]+\/fd$/u.test(m[2]));
        assert.deepEqual(open.map((m) => Number(m[1])).filter((fd) => fd >= 3).sort((a, b) => a - b), range(3, 9), `final keeps only its allowlist: ${f.stdout}`);
    })));
}

test('M-65 prep (dash, bash absent): with 0-9 all in use dash cannot close its own script descriptor (fd 10, not close-on-exec): fail closed (exit 72)', { skip: NO_DASH }, () => world((ctx) => withFds(ctx, (fds) => {
    const r = spawnSync(DASH, [ctx.stage, 'prep', MARKER, String(process.pid), '', '9', SPEC, ENDPOINT_KEEP, '--', '/bin/cmd'], { encoding: 'utf8', stdio: endpointStdio(fds), env: ctx.env });
    assert.equal(r.status, 72, r.stderr);
    assert.deepEqual(fs.readdirSync(ctx.dumps), [], 'neither node prep nor bwrap ran');
}), { noBash: true }));

test('M-65 launcher: the keep set is exactly the stdio slots in use; an \'ignore\' slot >= 3 is not kept (libuv leaves that fd number as the worker had it)', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rw-fdleak-keep-'));
    const dirFd = fs.openSync(dir, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY);
    try {
        const recorded = [];
        const launcher = createSandboxLauncher({
            view: createFakeView(), procMasks: readProcMasks({ readFile: () => fs.readFileSync(new URL('./fixtures/podman-nested-mountinfo.txt', import.meta.url), 'utf8') }),
            spawnImpl: (file, args, options) => { recorded.push({ args, stdio: options.stdio }); throw Object.assign(new Error('recorded'), { code: 'EREC' }); },
            tools: { setpriv: '/x', unshare: '/x', mount: '/x', umount: '/x', node: '/x', nsenter: '/x' }, arch: 'x86_64',
            fsImpl: { ...fs, existsSync: (file) => file === '/usr/bin/bwrap' || fs.existsSync(file) }
        });
        const base = { marker: MARKER, runtimeDir: dir, roBinds: [], env: {}, cwd: '/', argv: ['/usr/bin/node', '/m.mjs'] };
        const cases = [
            [{ ...base, role: 'orchestration', stdio: ['pipe', 'pipe', 'pipe'], roleFds: { 3: 'pipe' } }, '0,1,2,3,4,5,6,7,8'],
            [{ ...base, role: 'orchestration', stdio: ['pipe', 'pipe', 'pipe'] }, '0,1,2,4,5,6,7,8'],
            [{ ...base, role: 'endpoint', netns: '/run/netns/rw0123456789abcdef', stdio: ['ignore', 'ignore', 'ignore'], roleFds: { 3: 'pipe' } }, '0,1,2,3,4,5,6,7,8,9'],
            [{ ...base, role: 'endpoint', netns: '/run/netns/rw0123456789abcdef', roleFds: { 3: 'pipe', 4: 'ignore' } }, '0,1,2,3,5,6,7,8,9'],
            [{ ...base, role: 'workload', netMode: 'none', home: { path: dir, fd: dirFd }, grants: [], channelsDir: `${dir}/c`, tmpDir: `${dir}/t`, argv: ['/bin/true'] }, '0,1,2,3,4,5,6,7']
        ];
        for (const [spec, keep] of cases) {
            recorded.length = 0;
            await assert.rejects(launcher.launch(spec));
            const { args, stdio } = recorded[0];
            const at = args.indexOf('prep');
            assert.equal(args[at + 6], keep, `${spec.role} ${JSON.stringify(spec.roleFds ?? {})}`);
            assert.equal(args[at + 7], '--');
            assert.ok(args[at + 6].split(',').includes(args[at + 4]), 'the args fd is kept');
            assert.deepEqual(args[at + 6].split(',').map(Number), [...stdio.keys()].filter((slot) => slot < 3 || stdio[slot] !== 'ignore'));
            fs.rmSync(`${dir}/ctl`, { recursive: true, force: true });
        }
    } finally { fs.closeSync(dirFd); fs.rmSync(dir, { recursive: true, force: true }); }
});

// The real launcher with the real spawn, in a child process that holds a PTY master at fd 23 without close-on-exec.
for (const [role, variant, expected] of [
    ['workload', null, range(3, 7)], ['terminal', null, range(3, 7)], ['orchestration', null, range(3, 8)], ['orchestration', 'noRoleFd', range(4, 8)], ['endpoint', null, range(3, 9)]
]) {
    test(`M-65 real launcher chain, ${role}${variant ? ` (${variant})` : ''}: the worker's leaked PTY master (fd 23) reaches the chain's first tool but not node prep and not bwrap`, () => world((ctx) => {
        const ptmx = fs.openSync('/dev/ptmx', 'r+');
        try {
            const stdio = ['ignore', 'pipe', 'pipe', ...Array(20).fill('ignore'), ptmx];
            const r = spawnSync(process.execPath, [DRIVER, JSON.stringify({ role, variant, dir: ctx.dir, stage: ctx.stage, shims: ctx.shims, leakFd: 23 })], { encoding: 'utf8', stdio, timeout: 60000 });
            assert.equal(r.status, 0, r.stderr);
            const result = JSON.parse(r.stdout.trim().split('\n').at(-1));
            assert.ok(isPtmx(result.leakTarget ?? ''), `precondition: the driver holds a PTY master at 23 (${result.leakTarget})`);
            assert.equal(result.leakCloexec, false, 'precondition: without close-on-exec, as node-pty leaves it');
            assert.equal(result.outcome.launched, false, 'the stub bwrap ends the chain');
            // positive control: the tool before stage.sh still holds it, so the leak really entered the chain
            const outer = ctx.dump(role === 'endpoint' ? 'setpriv.nsenter.' : 'setpriv.unshare.');
            assert.equal(outer.length, 1, 'the outer setpriv ran');
            assert.ok(isPtmx(outer[0].get(23) ?? ''), 'positive control: fd 23 is the PTY master in the outer setpriv');
            assertOnly(ctx, 'setpriv.node.', expected, role);
            assertOnly(ctx, 'bwrap.', expected, role);
        } finally { fs.closeSync(ptmx); }
    }));
}
