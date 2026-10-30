import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createSandboxLauncher, slotLayout } from '../../server/sandbox/sandboxLauncher.mjs';
import { readProcMasks } from '../../server/sandbox/procMasks.mjs';
import { SUPERVISOR_PID, createFakeSpawn, createFakeView, fakeClock, mntNsOf, pidNsOf } from './helpers/fakes.mjs';

const MARKER = 'rwTestMarker0123456789_a';
const NETNS = '/run/netns/rw0123456789abcdef';
const TOOLS = { setpriv: '/usr/bin/setpriv', unshare: '/usr/bin/unshare', mount: '/usr/bin/mount', umount: '/usr/bin/umount', node: '/usr/bin/node', nsenter: '/usr/bin/nsenter' };
const MASKS = readProcMasks({ readFile: () => fs.readFileSync(new URL('./fixtures/podman-nested-mountinfo.txt', import.meta.url), 'utf8') });
const fsWithBwrap = { ...fs, existsSync: (file) => file === '/usr/bin/bwrap' || fs.existsSync(file) };

function rig(script = {}, options = {}) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rw-launch-'));
    const view = createFakeView();
    const { spawnImpl, spawned } = createFakeSpawn(view, script);
    const signals = [];
    const clock = fakeClock();
    const launcher = createSandboxLauncher({
        view, spawnImpl, signal: (pid, name) => signals.push([pid, name]), clock, procMasks: MASKS, tools: TOOLS, supervisorPid: SUPERVISOR_PID,
        stageScript: '/opt/robo-work/server/sandbox/stage.sh', arch: 'x86_64', fsImpl: fsWithBwrap, ...options
    });
    const dirFd = fs.openSync(dir, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY);
    return { dir, view, spawned, signals, launcher, dirFd, clock, done: () => { fs.closeSync(dirFd); fs.rmSync(dir, { recursive: true, force: true }); } };
}

const workloadSpec = (world, extra = {}) => ({
    role: 'workload', marker: MARKER, runtimeDir: world.dir, netns: NETNS, roBinds: [{ source: '/usr', dest: '/usr' }],
    env: { HOME: '/home/robot' }, cwd: '/projects/a', argv: ['/usr/bin/echo', 'hi'], home: { path: world.dir, fd: world.dirFd },
    grants: [{ name: 'a', path: world.dir, fd: world.dirFd, mode: 'rw' }], channelsDir: `${world.dir}/channels`, tmpDir: `${world.dir}/tmp`, stdio: [3, 4, 5].map(() => 'ignore'),
    verifyTimeoutMs: 200, ...extra
});

const nulSplit = (buffer) => buffer.toString('utf8').slice(0, -1).split('\0');

test('workload: the chain, the marker on argv, the descriptor map, and a gated identity read from /proc', async () => {
    const world = rig();
    try {
        const sandbox = await world.launcher.launch(workloadSpec(world));
        const [record] = world.spawned;
        assert.equal(record.file, 'setpriv');
        assert.deepEqual(record.args.slice(0, 6), ['--pdeathsig', 'KILL', '--', 'nsenter', `--net=${NETNS}`, '--']);
        assert.deepEqual(record.args.slice(6, 11), ['unshare', '--mount', '--propagation', 'private', '--']);
        const prep = record.args.indexOf('prep');
        assert.deepEqual(record.args.slice(prep - 2, prep + 1), ['/bin/sh', '/opt/robo-work/server/sandbox/stage.sh', 'prep']);
        assert.equal(record.args[prep + 1], MARKER, 'the marker is a literal argv element of the chain');
        assert.equal(record.args[prep + 2], String(SUPERVISOR_PID));
        assert.equal(record.args[prep + 3], '', 'no directory descriptor is handed over: prep re-opens them in its own namespace');
        assert.equal(record.args[prep + 4], '7', 'bwrap args at slot 7');
        assert.deepEqual(record.args.slice(prep + 6), ['--', '/bin/sh', '/opt/robo-work/server/sandbox/stage.sh', 'final', '0,1,2', 'HOME', '/usr/bin/echo', 'hi'],
            'the bwrap command is the tail of the chain, not part of the args buffer');
        const prepSpec = JSON.parse(record.args[prep + 5]);
        assert.equal(record.args[prep + 6], '--');
        assert.equal(prepSpec.supervisorMntNs, '2000');
        const here = fs.statSync(world.dir, { bigint: true });
        const identity0 = { path: world.dir, dev: String(here.dev), ino: String(here.ino) };
        assert.deepEqual(prepSpec.grants, [{ name: 'a', ...identity0 }]);
        assert.deepEqual(prepSpec.binds, [{ name: 'home', ...identity0 }]);
        assert.equal(prepSpec.stageDir, `${world.dir}/stage/${MARKER}`);
        assert.equal(record.options.env.PATH.includes('/usr/bin'), true);
        assert.deepEqual(Object.keys(record.options.env), ['PATH']);
        // slots: 3 seccomp | 4 block | 5 info | 6 status | 7 args; nothing else
        const stdio = record.options.stdio;
        assert.equal(stdio.length, 8);
        assert.deepEqual(stdio.slice(4, 7), ['pipe', 'pipe', 'pipe']);
        assert.ok(!stdio.includes(world.dirFd), 'a directory descriptor never reaches the chain');
        // the buffers the child reads
        const args = nulSplit(record.fdContents.args);
        assert.ok(args.join(' ').includes('--block-fd 4 --info-fd 5 --json-status-fd 6'));
        assert.ok(args.join(' ').includes('--seccomp 3'));
        assert.ok(args.join(' ').includes(`--bind ${world.dir}/stage/${MARKER}/binds/home /home/robot`));
        assert.ok(args.join(' ').includes('--ro-bind /dev/null /proc/kcore'), 'the worker /proc masks are re-applied');
        assert.ok(args.join(' ').includes(`--bind ${world.dir}/stage/${MARKER}/projects/a /projects/a`));
        assert.ok(!args.join(' ').includes('--bind-fd'), 'no --bind-fd: a descriptor of another mount namespace cannot be bound');
        assert.equal(record.fdContents.seccomp.length % 8, 0);
        // identity: the monitor is ChildProcess.pid, the namespaces are the INIT's
        const { identity } = sandbox;
        assert.equal(identity.pid, record.child.pid);
        assert.equal(identity.pidNs, pidNsOf(record.child.pid));
        assert.notEqual(identity.pidNs, world.view.self.pidNs);
        assert.equal(identity.stageMntNs, mntNsOf(record.child.pid));
        assert.equal(identity.init.pid, record.child.pid + 1);
        assert.equal(world.view.registered[0].pid, record.child.pid, 'the monitor is killed through its ChildProcess');
        // gated: nothing was written to the block fd yet
        assert.equal(record.block.read(), null);
        assert.equal(await sandbox.gate.commit(), true);
        assert.equal(record.block.read().toString(), '1');
        assert.equal(await sandbox.gate.commit(), false, 'the gate opens once');
    } finally { world.done(); }
});

test('orchestration: no nsenter, pair socket at slot 3, RW_FD_ALLOW in the buffer, the orchestration seccomp profile', async () => {
    const world = rig();
    try {
        const sandbox = await world.launcher.launch({
            role: 'orchestration', marker: MARKER, runtimeDir: world.dir, roBinds: [{ source: '/usr', dest: '/usr' }], env: {}, cwd: '/',
            argv: ['/usr/local/bin/node', '--import', '/opt/robo-work/server/sandbox/fdTrim.mjs', '/opt/ala/main.mjs'],
            anchored: [{ name: 'session', path: world.dir, fd: world.dirFd, dest: '/session', mode: 'rw' }],
            binds: [{ source: `${world.dir}/channels`, dest: '/run/robo-work/channels', mode: 'rw' }], stdio: ['pipe', 'pipe', 'pipe'], roleFds: { 3: 'pipe' }, verifyTimeoutMs: 200
        });
        const [record] = world.spawned;
        assert.ok(!record.args.includes('nsenter'));
        assert.deepEqual(record.args.slice(0, 4), ['--pdeathsig', 'KILL', '--', 'unshare']);
        const prep = record.args.indexOf('prep');
        assert.equal(record.args[prep + 3], '', 'no grant descriptors to close');
        assert.deepEqual(JSON.parse(record.args[prep + 5]).binds.map((bind) => bind.name), ['session']);
        assert.equal(record.args[prep + 4], '8');
        const args = nulSplit(record.fdContents.args).join(' ');
        assert.ok(args.includes('--setenv RW_FD_ALLOW 0,1,2,3'));
        assert.ok(args.includes('--seccomp 4 --block-fd 5 --info-fd 6 --json-status-fd 7'));
        assert.ok(args.includes(`--bind ${world.dir}/stage/${MARKER}/binds/session /session`));
        assert.ok(args.includes(`--bind ${world.dir}/channels /run/robo-work/channels`));
        assert.ok(args.includes('--unshare-net'));
        const workload = rig();
        try { await workload.launcher.launch(workloadSpec(workload)); assert.ok(record.fdContents.seccomp.length > workload.spawned[0].fdContents.seccomp.length); } finally { workload.done(); }
        assert.equal(sandbox.stdio.length, 3);
    } finally { world.done(); }
});

test('endpoint: joins the netns, pair socket at 3, frame channel at 4, control fds after them', async () => {
    const world = rig();
    try {
        const sandbox = await world.launcher.launch({
            role: 'endpoint', marker: MARKER, runtimeDir: world.dir, netns: NETNS, roBinds: [{ source: '/usr', dest: '/usr' }], env: {}, cwd: '/',
            argv: ['/usr/local/bin/node', '--import', '/opt/fdTrim.mjs', '/opt/main.mjs', '{}'], stdio: ['ignore', 'ignore', 'ignore'],
            roleFds: { 3: 'pipe', 4: 'pipe' }, verifyTimeoutMs: 200
        });
        const [record] = world.spawned;
        assert.ok(record.args.includes('nsenter'));
        assert.equal(record.args[record.args.indexOf('prep') + 4], '9');
        assert.equal(record.options.stdio.length, 10);
        assert.ok(nulSplit(record.fdContents.args).join(' ').includes('--setenv RW_FD_ALLOW 0,1,2,3,4'));
        assert.ok(sandbox.channel, 'the supervisor end of the frame channel is slot 4');
        assert.equal(sandbox.channel, record.child.stdio[4]);
    } finally { world.done(); }
});

test('a chain that ends before bwrap reports maps prep exit codes to launcher errors; a missing tool is sandbox_unavailable', async () => {
    for (const [status, code] of [[20, 'mask_scan_limit'], [21, 'mask_unverified'], [22, 'setup_failed'], [23, 'sandbox_unavailable'], [137, 'setup_failed']]) {
        const world = rig({ exitBefore: status });
        try {
            await assert.rejects(world.launcher.launch(workloadSpec(world)), { code }, `exit ${status}`);
            assert.ok(!fs.existsSync(`${world.dir}/stage/${MARKER}`), 'the staging directory is removed after a failed start');
        } finally { world.done(); }
    }
    const spawnFails = rig({ spawnError: Object.assign(new Error('x'), { code: 'ENOENT' }) });
    try {
        await assert.rejects(spawnFails.launcher.launch(workloadSpec(spawnFails)), (error) => ['sandbox_unavailable', 'setup_failed'].includes(error.code));
    } finally { spawnFails.done(); }
    const missing = rig({}, { tools: { ...TOOLS, setpriv: null } });
    try {
        await assert.rejects(missing.launcher.launch(workloadSpec(missing)), { code: 'sandbox_unavailable' });
        assert.equal(missing.spawned.length, 0);
    } finally { missing.done(); }
    const noBwrap = rig({}, { fsImpl: { ...fs, existsSync: () => false } });
    try { await assert.rejects(noBwrap.launcher.launch(workloadSpec(noBwrap)), { code: 'sandbox_unavailable' }); } finally { noBwrap.done(); }
    assert.throws(() => createSandboxLauncher({ view: createFakeView(), mainThread: false, tools: TOOLS, arch: 'x86_64' }), { code: 'sandbox_unavailable' });
});

test('identity is read from /proc, never from bwrap: every mismatch is identity_mismatch and the monitor is killed', async () => {
    const cases = {
        'marker missing on bwrap argv': { omitMarker: true },
        'monitor is not our child': { monitorPpid: 1 },
        'init shares the worker pid namespace': { initPidNs: '1000' },
        'init in the worker mount namespace': { initMntNs: '2000' },
        'monitor in the worker mount namespace': { monitorMntNs: '2000' },
        'init shares the worker network namespace': { initNetNs: '3000' }
    };
    for (const [name, script] of Object.entries(cases)) {
        const world = rig(script);
        try {
            await assert.rejects(world.launcher.launch(workloadSpec(world)), { code: 'identity_mismatch' }, name);
            assert.deepEqual(world.spawned[0].kills, ['SIGKILL'], name);
        } finally { world.done(); }
    }
    const world = rig();
    try {
        await assert.rejects(world.launcher.launch(workloadSpec(world, { netnsInode: '999' })), { code: 'identity_mismatch' });
    } finally { world.done(); }
});

test('gate abort kills the monitor BEFORE the block fd closes (end-of-file on --block-fd would unblock bwrap)', async () => {
    const world = rig();
    try {
        const sandbox = await world.launcher.launch(workloadSpec(world));
        const [record] = world.spawned;
        const order = [];
        const destroy = record.block.destroy.bind(record.block);
        record.block.destroy = (...args) => { order.push(['block closed', record.kills.length]); return destroy(...args); };
        await sandbox.gate.abort();
        assert.deepEqual(record.kills, ['SIGKILL']);
        assert.deepEqual(order, [['block closed', 1]], 'the SIGKILL was already sent when the gate closed');
        assert.equal(await sandbox.gate.commit(), false);
        assert.equal((await sandbox.wait()).signal, 'SIGKILL');
    } finally { world.done(); }
});

test('onIdentity: the hook sees the identity before the gate byte; a failing hook aborts', async () => {
    const world = rig();
    try {
        let seen = null;
        const sandbox = await world.launcher.launch(workloadSpec(world, { onIdentity: async (identity) => { seen = { identity, byte: world.spawned[0].block.read() }; } }));
        assert.equal(seen.byte, null);
        assert.equal(seen.identity.pid, sandbox.identity.pid);
        assert.equal(world.spawned[0].block.read().toString(), '1');
    } finally { world.done(); }
    const failing = rig();
    try {
        await assert.rejects(failing.launcher.launch(workloadSpec(failing, { onIdentity: async () => { throw new Error('ledger said no'); } })), /ledger said no/);
        assert.ok(failing.spawned[0].kills.length >= 1 && failing.spawned[0].kills.every((name) => name === 'SIGKILL'));
        assert.equal(failing.spawned[0].block.read(), null, 'no gate byte');
    } finally { failing.done(); }
});

test('stop: SIGTERM only to sandbox-namespace members whose identity is read again, then SIGKILL through the ChildProcess, then verified absence', async () => {
    const world = rig();
    try {
        const sandbox = await world.launcher.launch(workloadSpec(world));
        await sandbox.gate.commit();
        const { pidNs } = sandbox.identity;
        world.view.add({ pid: 7001, ppid: 5011, pidNs, mntNs: sandbox.identity.mntNs, netNs: '3001', startTime: '70' });
        world.view.add({ pid: 7002, ppid: 5011, pidNs, mntNs: sandbox.identity.mntNs, netNs: '3001', startTime: '71' }); // setsid / double fork
        world.view.add({ pid: 7003, ppid: 1, pidNs: '1000', mntNs: '2000', netNs: '3000', startTime: '72' }); // a neighbour in the worker namespace
        const original = world.view.process.bind(world.view);
        world.view.process = (pid) => (pid === 7002 ? { ...original(pid), startTime: '999' } : original(pid)); // pid reused between list and kill
        const stopping = sandbox.stop({ graceMs: 50 });
        const again = sandbox.stop({ graceMs: 50 });
        assert.equal(stopping, again, 'stop is idempotent');
        world.view.drop(7001);
        world.view.drop(7002);
        const verdict = await stopping;
        assert.deepEqual(world.signals.map(([pid]) => pid).filter((pid) => pid > 7000), [7001], 'only the member whose start time still matched is signalled');
        assert.ok(world.signals.every(([, name]) => name === 'SIGTERM'));
        assert.deepEqual(world.spawned[0].kills, ['SIGKILL']);
        assert.deepEqual(verdict, { absent: true, problems: [] });
        assert.equal(world.view.registered.length, 0, 'the child registration is released once absence is proven');
    } finally { world.done(); }
});

test('verifyAbsent: a process that still holds the sandbox pid, mount or stage-mount namespace (by link or by fd) is not absence', async () => {
    const world = rig();
    try {
        const sandbox = await world.launcher.launch(workloadSpec(world));
        await sandbox.gate.commit();
        world.spawned[0].finish(0, null);
        await sandbox.wait();
        world.view.add({ pid: 8001, pidNs: '1000', mntNs: '2000', netNs: '3000', fdNs: [sandbox.identity.stageMntNs] });
        assert.deepEqual((await sandbox.verifyAbsent()).problems, ['namespace_held']);
        world.view.drop(8001);
        world.view.add({ pid: 8002, pidNs: '1000', mntNs: sandbox.identity.mntNs, netNs: '3000' });
        assert.equal((await sandbox.verifyAbsent()).absent, false);
        world.view.drop(8002);
        world.view.add({ pid: 8003, pidNs: '1000', mntNs: '2000', netNs: '3000', cmdline: ['setpriv', '--', MARKER] });
        assert.deepEqual((await sandbox.verifyAbsent()).problems, ['marker_present']);
        world.view.drop(8003);
        assert.equal((await sandbox.verifyAbsent()).absent, true);
        const exit = await sandbox.wait();
        assert.equal(exit.code, 0);
    } finally { world.done(); }
});

test('wait reports the sandboxed command exit code from the json-status fd', async () => {
    const world = rig();
    try {
        const sandbox = await world.launcher.launch(workloadSpec(world));
        await sandbox.gate.commit();
        world.spawned[0].status.write('{ "exit-code": 3 }\n');
        await new Promise((resolve) => setImmediate(resolve));
        world.spawned[0].finish(3, null);
        assert.equal((await sandbox.wait()).exitCode, 3);
        let notified = null;
        sandbox.onExit((value) => { notified = value; });
        assert.deepEqual(notified, { code: 3, signal: null });
    } finally { world.done(); }
});

test('release removes the staging directory without recursion: a leaked file keeps it (never deleted through a mount)', async () => {
    const world = rig();
    try {
        const sandbox = await world.launcher.launch(workloadSpec(world));
        const stage = `${world.dir}/stage/${MARKER}`;
        assert.ok(fs.statSync(`${stage}/mask-dir`).mode & 0o555);
        assert.equal(fs.statSync(`${stage}/mask-file`).mode & 0o777, 0o444);
        assert.ok(fs.existsSync(`${stage}/projects/a`));
        fs.writeFileSync(`${stage}/projects/a/leaked`, 'robot data');
        await sandbox.release();
        assert.ok(fs.existsSync(`${stage}/projects/a/leaked`), 'a non-empty mountpoint is never deleted');
        fs.rmSync(`${stage}/projects/a/leaked`);
        const second = await world.launcher.launch(workloadSpec(world, { marker: 'rwOtherMarker0123456789' }));
        await second.release();
        await second.release();
        assert.ok(!fs.existsSync(`${world.dir}/stage/rwOtherMarker0123456789`));
        assert.deepEqual(fs.readdirSync(`${world.dir}/ctl`), [], 'descriptor files are unlinked at once');
    } finally { world.done(); }
});

test('invalid specs are refused before anything is spawned', async () => {
    const world = rig();
    try {
        const bad = [
            { ...workloadSpec(world), role: 'root' }, { ...workloadSpec(world), marker: '-x' }, { ...workloadSpec(world), netns: '/run/netns/../x' },
            { ...workloadSpec(world), home: { path: 'relative', fd: world.dirFd } }, { ...workloadSpec(world), runtimeDir: '/' },
            { ...workloadSpec(world), grants: [{ name: '../x', path: world.dir, fd: world.dirFd, mode: 'rw' }] }
        ];
        for (const spec of bad) await assert.rejects(world.launcher.launch(spec), { code: 'invalid_request' });
        assert.equal(world.spawned.length, 0);
        assert.equal(slotLayout('workload').size, 8);
        assert.equal(slotLayout('endpoint').size, 10);
    } finally { world.done(); }
});
