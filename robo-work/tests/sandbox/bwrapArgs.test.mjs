import assert from 'node:assert/strict';
import test from 'node:test';

import { buildBwrapArgs, bwrapRealArgv } from '../../server/sandbox/bwrapArgs.mjs';

const MARKER = 'rw-0123456789abcdef';
const base = { marker: MARKER, seccompFd: 5, blockFd: 6, infoFd: 7, jsonStatusFd: 8, cwd: '/', roBinds: [{ source: '/usr', dest: '/usr' }], argv: ['/usr/bin/node', '/opt/robo-work/ala.mjs'] };
const workload = { ...base, role: 'workload', netMode: 'join', homeFd: 9, stagingDir: '/run/rw/stage', channelsDir: '/run/rw/x/r1/channels', stageScript: '/opt/robo-work/stage.sh', cwd: '/projects/a', grants: [{ name: 'a', mode: 'rw' }, { name: 'b', mode: 'ro' }], env: { HOME: '/home/robot' }, argv: ['/bin/echo', 'hi'] };
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
    assert.deepEqual(args.slice(args.indexOf('--') + 1), base.argv);
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
    assert.ok(line.includes('--bind-fd 9 /home/robot'));
    assert.ok(line.includes('--bind /run/rw/stage/projects/a /projects/a'));
    assert.ok(line.includes('--ro-bind /run/rw/stage/projects/b /projects/b'));
    assert.ok(line.includes('--ro-bind /run/rw/x/r1/channels /run/robo-work/channels'));
    assert.ok(line.endsWith('-- /bin/sh /opt/robo-work/stage.sh final 0,1,2 HOME=/home/robot /bin/echo hi'));
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
    code({ ...workload, seccompFd: 'x' });
});

test('real argv carries the marker; the buffer does not', () => {
    assert.deepEqual(bwrapRealArgv({ argsFd: 4, marker: MARKER }), ['/usr/bin/bwrap', '--unshare-uts', '--hostname', MARKER, '--args', '4']);
    assert.ok(!buildBwrapArgs(workload).toString().includes(MARKER));
    assert.throws(() => bwrapRealArgv({ argsFd: 4, marker: 'x' }), { code: 'invalid_request' });
});
