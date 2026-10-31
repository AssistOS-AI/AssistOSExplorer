import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { spawnSync } from 'node:child_process';

import { TERMINAL_ENV } from '../../server/runtime/executionFactory.mjs';
import { buildBwrapArgs, bwrapCommand, bwrapRealArgv } from '../../server/sandbox/bwrapArgs.mjs';
import { SANDBOX_STAGE_SCRIPT, STAGE_SCRIPT } from '../../server/sandbox/sandboxLauncher.mjs';
import { compileSeccomp } from '../../server/sandbox/seccompBpf.mjs';

// M-8 terminal sandbox, with the REAL bwrap (unprivileged, user namespace) and the REAL stage.sh `final`, on this Linux host:
//   1. the terminal sandbox root ruling (2026-10-31): a write to `/` lands in bwrap's per-sandbox tmpfs root and never on the host, while
//      /usr stays read-only and HOME (the only host directory bound read-write here) receives only what the shell wrote to HOME;
//   2. M-65 fd rules: the shell's stdio 0-2 are the PTY slave and it holds NOTHING else, although bwrap was started holding (without
//      close-on-exec) this terminal's own PTY master at fd 30 and another robot's PTY master at fd 23;
//   3. the slave is the shell's controlling terminal (setsid --ctty) and the sandbox has no capability, NoNewPrivs and a seccomp filter.
// The prep stage before bwrap (setpriv, unshare, stage.sh prep, node prep) is covered by prepFdLeak.test.mjs (role terminal); this test
// starts bwrap directly because `unshare --mount` needs privileges this host user does not have.

const BWRAP = '/usr/bin/bwrap';
const ARCH = { x64: 'x86_64', arm64: 'aarch64' }[process.arch];

// Python is the fd plumber only: it opens the PTY pair and a second PTY master, and forks. The parent keeps holding the master (as the
// worker does; bwrap's monitor closes every extra descriptor, so without an outside holder the slave would hang up) and waits; the child
// places every descriptor at its slot WITHOUT close-on-exec, including the two masters, and execs bwrap. Terminal bytes are discarded.
const DRIVER = String.raw`
import os, sys, pty
argv, files = sys.argv[1], sys.argv[2:]
import json
argv = json.loads(argv)
master, slave = pty.openpty()
other = os.open('/dev/ptmx', os.O_RDWR | os.O_NOCTTY)
seccomp = os.open(files[0], os.O_RDONLY)
args = os.open(files[1], os.O_RDONLY)
r, w = os.pipe()
os.write(w, b'1'); os.close(w)
null = os.open('/dev/null', os.O_WRONLY)
plan = {0: slave, 1: slave, 2: slave, 3: seccomp, 4: r, 5: null, 6: os.dup(null), 7: args, 23: other, 30: master}
keep = set(plan)
pid = os.fork()
if pid == 0:
    tmp = {fd: os.dup(src) for fd, src in plan.items()}
    for fd, src in tmp.items():
        os.dup2(src, fd, inheritable=True)
    for fd in list(tmp.values()) + [master, slave, other, seccomp, args, r, null]:
        if fd not in keep:
            try: os.close(fd)
            except OSError: pass
    os.execv(argv[0], argv)
holder = master
for fd in (slave, other, seccomp, args, r, null):
    os.close(fd)
os.set_blocking(holder, False)
seen = b''
while True:
    done, status = os.waitpid(pid, os.WNOHANG)
    try: seen = (seen + os.read(holder, 65536))[-4096:]
    except OSError: pass
    if done:
        code = os.waitstatus_to_exitcode(status)
        if code != 0: sys.stderr.write(seen.decode('utf-8', 'replace'))
        sys.exit(code)
    import time; time.sleep(0.02)
`;

function bwrapUsable() {
    const probe = spawnSync(BWRAP, ['--unshare-user', '--ro-bind', '/usr', '/usr', '--symlink', 'usr/bin', '/bin', '--symlink', 'usr/lib', '/lib', '--symlink', 'usr/lib64', '/lib64', '/bin/true'], { timeout: 10000 });
    return probe.status === 0;
}

test('terminal sandbox (real bwrap + stage.sh final): writable root is a per-sandbox tmpfs, the shell holds only the PTY slave on 0-2, no capability', { skip: !bwrapUsable() || !ARCH ? 'bwrap is not usable for this user' : false }, () => {
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'rw-terminal-sbx-')));
    try {
        const staging = path.join(dir, 'stage');
        for (const sub of ['binds/home', 'projects']) fs.mkdirSync(path.join(staging, sub), { recursive: true });
        for (const sub of ['channels', 'tmp']) fs.mkdirSync(path.join(dir, sub));
        const marker = 'rw-TerminalRootMarker012345';
        const script = [
            'test -t 0 && echo yes > /home/robot/tty.txt',
            'ls -l /proc/$$/fd > /home/robot/fds.txt 2>&1',
            `echo written > /${marker} && cat /${marker} > /home/robot/root.txt && ls -d /${marker} >> /home/robot/root.txt`,
            '( echo x > /usr/zz ) 2> /home/robot/usr.txt || echo refused >> /home/robot/usr.txt',
            'grep -E "^(CapInh|CapPrm|CapEff|CapBnd|CapAmb|NoNewPrivs|Seccomp):" /proc/self/status > /home/robot/status.txt',
            'cat /proc/$$/stat | cut -d" " -f6 > /home/robot/session.txt; echo $$ >> /home/robot/session.txt'
        ].join('; ');
        const spec = {
            role: 'terminal', marker, seccompFd: 3, blockFd: 4, infoFd: 5, jsonStatusFd: 6, netMode: 'none',
            roBinds: [{ source: '/usr', dest: '/usr' }, { source: STAGE_SCRIPT, dest: SANDBOX_STAGE_SCRIPT }],
            symlinks: [{ target: 'usr/bin', dest: '/bin' }, { target: 'usr/lib', dest: '/lib' }, { target: 'usr/lib64', dest: '/lib64' }, { target: 'usr/sbin', dest: '/sbin' }],
            env: { ...TERMINAL_ENV }, cwd: '/home/robot', argv: ['/usr/bin/setsid', '--ctty', '--wait', '/bin/sh', '-c', script], procMasks: [],
            stagingDir: staging, channelsDir: path.join(dir, 'channels'), stageScript: SANDBOX_STAGE_SCRIPT, fdAllow: [0, 1, 2], grants: [], tmpDir: path.join(dir, 'tmp')
        };
        const argsFile = path.join(dir, 'args');
        const seccompFile = path.join(dir, 'seccomp');
        fs.writeFileSync(argsFile, buildBwrapArgs(spec));
        fs.writeFileSync(seccompFile, compileSeccomp('workload', ARCH));
        // The terminal role never remounts the root read-only (a workload does): the ruling allows a writable per-sandbox tmpfs root.
        assert.equal(fs.readFileSync(argsFile).toString().split('\0').includes('--remount-ro'), false);
        const argv = bwrapRealArgv({ argsFd: 7, marker, command: bwrapCommand(spec) });
        const run = spawnSync('python3', ['-I', '-c', DRIVER, JSON.stringify(argv), seccompFile, argsFile], { encoding: 'utf8', timeout: 30000, cwd: dir });
        assert.equal(run.status, 0, `bwrap run failed: ${run.stderr}`);
        const home = (name) => fs.readFileSync(path.join(staging, 'binds/home', name), 'utf8');

        // 1. Root writes stay in the sandbox's own tmpfs.
        assert.equal(home('root.txt'), `written\n/${marker}\n`, 'the shell could write to / inside its sandbox');
        assert.equal(fs.existsSync(`/${marker}`), false, 'the host root is unchanged');
        const hostFiles = spawnSync('find', [dir, '-name', marker], { encoding: 'utf8' }).stdout.trim();
        assert.equal(hostFiles, '', 'no bound host directory received the root write');
        assert.match(home('usr.txt'), /Read-only file system/u);

        // 2. The shell's descriptors: 0, 1, 2 (the PTY slave) and nothing else; neither PTY master reached it.
        const fds = home('fds.txt').split('\n').filter((line) => / -> /u.test(line)).map((line) => {
            const [, fd, target] = /\s([0-9]+) -> (.*)$/u.exec(line);
            return { fd: Number(fd), target };
        });
        // The listing runs with the shell's own redirection of 1 and 2 to fds.txt, so the shell shows its saved copies of the slave (dash
        // keeps them at 10 and 11; bash -l keeps the terminal at 255): every descriptor is the slave or that file, and none is a master.
        const slave = fds.find((entry) => entry.fd === 0)?.target;
        assert.match(slave ?? '', /^\/dev\/pts\/[0-9]+$/u, home('fds.txt'));
        for (const entry of fds) assert.ok([slave, '/home/robot/fds.txt'].includes(entry.target), `fd ${entry.fd} -> ${entry.target}`);
        assert.equal(fds.some((entry) => entry.fd === 23 || entry.fd === 30), false, 'neither leaked master slot survived stage.sh final');
        assert.equal(fds.some((entry) => /ptmx/u.test(entry.target)), false, 'no PTY master is held by the shell');

        // 3. Controlling terminal, session leader, no capability, NoNewPrivs, seccomp filter.
        assert.equal(home('tty.txt'), 'yes\n');
        const [sid, pid] = home('session.txt').trim().split('\n');
        assert.equal(sid, pid, 'the shell leads its own session (setsid --ctty)');
        const status = Object.fromEntries(home('status.txt').trim().split('\n').map((line) => line.split(':').map((part) => part.trim())));
        for (const key of ['CapInh', 'CapPrm', 'CapEff', 'CapBnd', 'CapAmb']) assert.equal(status[key], '0000000000000000', key);
        assert.equal(status.NoNewPrivs, '1');
        assert.equal(status.Seccomp, '2');
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});
