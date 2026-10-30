import assert from 'node:assert/strict';
import test from 'node:test';

import { buildBwrapArgs, bwrapCommand, bwrapRealArgv } from '../../server/sandbox/bwrapArgs.mjs';

const MARKER = 'rwMarker0123456789_-ab';
const base = { marker: MARKER, seccompFd: 5, blockFd: 6, infoFd: 7, jsonStatusFd: 8, cwd: '/', roBinds: [{ source: '/usr', dest: '/usr' }], argv: ['/usr/bin/node', '/opt/robo-work/ala.mjs'] };
const workload = { ...base, role: 'workload', netMode: 'join', stagingDir: '/run/rw/stage', channelsDir: '/run/rw/x/r1/channels', stageScript: '/opt/robo-work/stage.sh', cwd: '/projects/a', grants: [{ name: 'a', mode: 'rw' }, { name: 'b', mode: 'ro' }], env: { HOME: '/home/robot' }, argv: ['/bin/echo', 'hi'] };
const parse = (buf) => { const s = buf.toString('utf8'); assert.ok(s.endsWith('\0')); return s.slice(0, -1).split('\0'); };
const code = (spec) => assert.throws(() => buildBwrapArgs(spec), { code: 'invalid_request' });

test('common flags, in order, for every role', () => {
    const common = '--unshare-user --uid 1000 --gid 1000 --unshare-pid --unshare-ipc --unshare-uts --unshare-cgroup-try --die-with-parent --cap-drop ALL --disable-userns --assert-userns-disabled --clearenv --proc /proc --dev /dev --tmpfs /tmp --tmpfs /dev/shm --seccomp 5 --block-fd 6 --info-fd 7 --json-status-fd 8';
    for (const spec of [{ ...base, role: 'orchestration', netMode: 'none' }, { ...base, role: 'endpoint', netMode: 'join' }, workload, { ...workload, role: 'terminal' }]) {
        assert.ok(parse(buildBwrapArgs(spec)).join(' ').startsWith(common), spec.role);
    }
});

test('orchestration: unshare-net, new-session, fixed env, direct exec', () => {
    const args = parse(buildBwrapArgs({ ...base, role: 'orchestration', netMode: 'none' }));
    assert.ok(args.includes('--unshare-net') && args.includes('--new-session'));
    assert.ok(args.join(' ').includes('--setenv NODE_CHANNEL_FD 3 --setenv NODE_CHANNEL_SERIALIZATION_MODE json'));
    assert.ok(!args.includes('--'), 'the command is not in the buffer: bwrap ignores it there');
    assert.deepEqual(bwrapCommand({ ...base, role: 'orchestration', netMode: 'none' }), base.argv);
    code({ ...base, role: 'orchestration', netMode: 'join' });
    code({ ...base, role: 'orchestration', netMode: 'none', env: { NODE_CHANNEL_FD: '9' } });
});

test('endpoint: no unshare-net, no new-session', () => {
    const args = parse(buildBwrapArgs({ ...base, role: 'endpoint', netMode: 'join' }));
    assert.ok(!args.includes('--unshare-net') && !args.includes('--new-session'));
});

test('workload: home, grant binds, channels, stage.sh final; terminal has no new-session', () => {
    const args = parse(buildBwrapArgs(workload));
    const line = args.join(' ');
    assert.ok(args.includes('--new-session'));
    assert.ok(line.includes('--bind /run/rw/stage/binds/home /home/robot'));
    assert.ok(!line.includes('--bind-fd') && !line.includes('--ro-bind-fd'), 'no descriptor binds');
    assert.ok(line.includes('--bind /run/rw/stage/projects/a /projects/a'));
    assert.ok(line.includes('--ro-bind /run/rw/stage/projects/b /projects/b'));
    assert.ok(line.includes('--ro-bind /run/rw/x/r1/channels /run/robo-work/channels'));
    assert.ok(line.endsWith('--setenv HOME /home/robot --chdir /projects/a'), 'values are in the buffer, the command is not');
    assert.deepEqual(bwrapCommand(workload), ['/bin/sh', '/opt/robo-work/stage.sh', 'final', '0,1,2', 'HOME', '/bin/echo', 'hi']);
    assert.ok(!buildBwrapArgs({ ...workload, env: { SECRET_TOKEN: 'sekrit' } }).toString().includes('/bin/echo'));
    assert.ok(!bwrapCommand({ ...workload, env: { SECRET_TOKEN: 'sekrit' } }).join(' ').includes('sekrit'), 'a value is never on the command line');
    assert.ok(!parse(buildBwrapArgs({ ...workload, role: 'terminal' })).includes('--new-session'));
});

test('validation: destination, grant source, role, markers, argv', () => {
    code({ ...workload, roBinds: [{ source: '/usr', dest: '/etc/passwd' }] });
    code({ ...workload, roBinds: [{ source: '/usr', dest: '/projects/x' }] });
    code({ ...workload, roBinds: [{ source: '/usr', dest: '/usr/../etc' }] });
    code({ ...workload, roBinds: [{ source: '/run/rw/stage/projects/a/x', dest: '/usr' }] });
    code({ ...workload, roBinds: [{ source: '/projects/a', dest: '/usr' }] });
    code({ ...workload, grantPaths: ['/work/g'], roBinds: [{ source: '/work/g/sub', dest: '/usr' }] });
    code({ ...workload, role: 'robot' });
    code({ ...workload, marker: 'bad' });
    code({ ...workload, grants: [{ name: '../x', mode: 'ro' }] });
    code({ ...workload, argv: ['-rm'] });
    code({ ...workload, argv: ['A=b'] });
    code({ ...workload, env: { 'A B': 'x' } });
    for (const name of ['IFS', 'BASH_ENV', 'ENV', 'LD_PRELOAD', 'BASH_FUNC_x', 'lower', 'PS4', 'SHELLOPTS']) code({ ...workload, env: { [name]: 'x' } });
    code({ ...workload, seccompFd: 'x' });
});

test('real argv carries the marker; the buffer does not', () => {
    assert.deepEqual(bwrapRealArgv({ argsFd: 4, marker: MARKER }), ['/usr/bin/bwrap', '--unshare-uts', '--unsetenv', MARKER, '--args', '4']);
    assert.deepEqual(bwrapRealArgv({ argsFd: 4, marker: MARKER, command: ['/bin/true'] }).slice(-2), ['--', '/bin/true']);
    assert.ok(!buildBwrapArgs(workload).toString().includes(MARKER));
    assert.throws(() => bwrapRealArgv({ argsFd: 4, marker: 'x' }), { code: 'invalid_request' });
});

// M-24: the marker rides as the value of --unsetenv on the real argv while --clearenv sits in the --args buffer. Both are
// plain environment operations of bwrap, applied in argv order; neither rejects the other, so their order does not matter.
test('the real argv carries the marker after --unsetenv and never --hostname; --clearenv stays in the buffer', () => {
    const argv = bwrapRealArgv({ argsFd: 7, marker: '-AbCdEf12345678901234', command: ['/bin/true'] });
    assert.deepEqual(argv.slice(0, 6), ['/usr/bin/bwrap', '--unshare-uts', '--unsetenv', '-AbCdEf12345678901234', '--args', '7']);
    assert.equal(argv.includes('--hostname'), false);
    assert.equal(argv.includes('--clearenv'), false);
});
