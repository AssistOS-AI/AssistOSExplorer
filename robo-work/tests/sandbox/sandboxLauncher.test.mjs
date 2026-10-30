import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createSandboxLauncher, slotLayout } from '../../server/sandbox/sandboxLauncher.mjs';
import { markerSlot } from '../../server/sandbox/marker.mjs';
import { readProcMasks } from '../../server/sandbox/procMasks.mjs';
import { SUPERVISOR_PID, createFakeSpawn, createFakeView, fakeClock, mntNsOf, pidNsOf } from './helpers/fakes.mjs';

const MARKER = 'rw-TestMarker0123456789_a';
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
    // Namespace pins: opening /proc/<pid>/ns/<type> is modelled by reading the fake process; `pins.open` lists what is held.
    const pins = { open: [], opened: [], inodeOf: (pid, type) => { const entry = view.process(pid); return entry ? (type === 'pid' ? entry.pidNs : entry.mntNs) : null; } };
    const openNamespace = (pid, type) => {
        const inode = pins.inodeOf(pid, type);
        if (inode === null) throw Object.assign(new Error('gone'), { code: 'ENOENT' });
        const handle = { pid, type, inode };
        pins.open.push(handle);
        pins.opened.push(handle);
        return { inode, close: () => { pins.open.splice(pins.open.indexOf(handle), 1); } };
    };
    const launcher = createSandboxLauncher({
        view, spawnImpl, signal: (pid, name) => signals.push([pid, name]), clock, procMasks: MASKS, tools: TOOLS, supervisorPid: SUPERVISOR_PID, openNamespace,
        stageScript: '/opt/robo-work/server/sandbox/stage.sh', arch: 'x86_64', fsImpl: fsWithBwrap, ...options
    });
    const dirFd = fs.openSync(dir, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY);
    return { dir, view, spawned, signals, launcher, dirFd, clock, pins, done: () => { fs.closeSync(dirFd); fs.rmSync(dir, { recursive: true, force: true }); } };
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
        assert.equal(prepSpec.stageDir, `${world.dir}/stage/${markerSlot(MARKER)}`);
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
        assert.ok(args.join(' ').includes(`--bind ${world.dir}/stage/${markerSlot(MARKER)}/binds/home /home/robot`));
        assert.ok(args.join(' ').includes('--ro-bind /dev/null /proc/kcore'), 'the worker /proc masks are re-applied');
        assert.ok(args.join(' ').includes(`--bind ${world.dir}/stage/${markerSlot(MARKER)}/projects/a /projects/a`));
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
        assert.ok(args.includes(`--bind ${world.dir}/stage/${markerSlot(MARKER)}/binds/session /session`));
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
            assert.ok(!fs.existsSync(`${world.dir}/stage/${markerSlot(MARKER)}`), 'the staging directory is removed after a failed start');
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
        const stage = `${world.dir}/stage/${markerSlot(MARKER)}`;
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
        assert.ok(!fs.existsSync(`${world.dir}/stage/${markerSlot('rwOtherMarker0123456789')}`));
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

test('namespaces are pinned from commit until release: pid and mount namespaces of the init and the stage mount namespace, each checked against the inode read', async () => {
    const world = rig();
    try {
        const sandbox = await world.launcher.launch(workloadSpec(world));
        const { identity } = sandbox;
        assert.deepEqual(world.pins.open.map((pin) => [pin.pid, pin.type, pin.inode]), [
            [identity.init.pid, 'pid', identity.pidNs], [identity.init.pid, 'mnt', identity.mntNs], [identity.pid, 'mnt', identity.stageMntNs]]);
        assert.ok(world.view.isPinned('pid', identity.pidNs) && world.view.isPinned('mnt', identity.stageMntNs), 'the walker can see the pins');
        await sandbox.gate.commit();
        world.spawned[0].finish(0, null);
        const stopped = await sandbox.stop({ graceMs: 1 });
        assert.equal(stopped.absent, true);
        assert.equal(world.pins.open.length, 3, 'stop alone keeps the pins: the blocker is not settled yet');
        const released = await sandbox.release();
        assert.equal(released.absent, true);
        assert.equal(released.stageRemoved, true);
        assert.equal(world.pins.open.length, 0);
        assert.equal(world.view.isPinned('pid', identity.pidNs), false);
    } finally { world.done(); }
});

test('a pin that does not show the inode just read fails the start with identity_mismatch and leaves no pin behind', async () => {
    const world = rig();
    const original = world.pins.inodeOf;
    world.pins.inodeOf = (pid, type) => (type === 'pid' ? '424242' : original(pid, type));
    try {
        // the rig's launcher reads its pins through pins.inodeOf, so this models the init being replaced between read and pin
        await assert.rejects(world.launcher.launch(workloadSpec(world)), { code: 'identity_mismatch' });
        assert.equal(world.pins.open.length, 0);
        assert.equal(world.view.pinned.size, 0);
        assert.ok(world.spawned[0].kills.length >= 1 && world.spawned[0].kills.every((name) => name === 'SIGKILL'));
    } finally { world.done(); }
});

test('B1: inode numbers prove nothing once unpinned: a second sandbox reusing the first one\'s inodes is not counted as holding, and our own pins are not holders', async () => {
    const world = rig();
    try {
        const first = await world.launcher.launch(workloadSpec(world));
        await first.gate.commit();
        const { identity } = first;
        // our own pins appear as fd links of this very process
        world.view.add({ pid: SUPERVISOR_PID, pidNs: '1000', mntNs: '2000', netNs: '3000', fdNs: [identity.pidNs, identity.mntNs, identity.stageMntNs] });
        world.spawned[0].finish(0, null);
        assert.equal((await first.stop({ graceMs: 1 })).absent, true, 'the supervisor holding the pins is not a holder');
        await first.release();
        // another sandbox now shows the recorded numbers (the kernel reuses them once the namespace is gone)
        world.view.add({ pid: 9100, pidNs: identity.pidNs, mntNs: identity.mntNs, netNs: '3001', cmdline: ['other-sandbox'] });
        world.view.add({ pid: 9101, pidNs: '1000', mntNs: identity.stageMntNs, netNs: '3000', cmdline: ['another'] });
        assert.deepEqual(await first.verifyAbsent(), { absent: true, problems: [] }, 'an unpinned inode is not a membership proof');
        assert.deepEqual(world.signals, [], 'nothing was signalled');
    } finally { world.done(); }
});

test('B1: while pinned, a foreign process showing the inode is a holder and SIGTERM goes only to verified members', async () => {
    const world = rig();
    try {
        const sandbox = await world.launcher.launch(workloadSpec(world));
        await sandbox.gate.commit();
        world.view.add({ pid: 9200, pidNs: sandbox.identity.pidNs, mntNs: sandbox.identity.mntNs, netNs: '3001', startTime: '5' });
        const stopping = sandbox.stop({ graceMs: 5 });
        world.view.drop(9200);
        assert.equal((await stopping).absent, true);
        assert.deepEqual(world.signals.filter(([pid]) => pid === 9200), [[9200, 'SIGTERM']]);
    } finally { world.done(); }
});

test('B2: a marker that begins with a dash (an S1 id does so about once in 64) is accepted by the launcher and carried verbatim', async () => {
    const dashed = '-Qs_9x-ZLk3mPaRt0wYh1A';
    const world = rig();
    try {
        const sandbox = await world.launcher.launch(workloadSpec(world, { marker: dashed }));
        const [record] = world.spawned;
        assert.equal(record.args[record.args.indexOf('prep') + 1], dashed);
        assert.equal(sandbox.identity.pid, record.child.pid);
        assert.ok(world.view.process(record.child.pid).cmdline.includes(dashed), 'the monitor carries it on its real argv');
        await sandbox.release();
    } finally { world.done(); }
    for (const bad of ['', 'short', 'has space 0123456789', 'semi;colon0123456789', 'x'.repeat(65), 'a/b/c/d/e/f/g/h']) {
        const w = rig();
        try { await assert.rejects(w.launcher.launch(workloadSpec(w, { marker: bad })), { code: 'invalid_request' }, bad); } finally { w.done(); }
    }
});

test('a launcher without the worker\'s /proc masks refuses to exist (no [] default)', () => {
    const base = { view: createFakeView(), tools: TOOLS, arch: 'x86_64' };
    assert.throws(() => createSandboxLauncher(base), { code: 'sandbox_unavailable' });
    assert.throws(() => createSandboxLauncher({ ...base, procMasks: null }), { code: 'sandbox_unavailable' });
    assert.doesNotThrow(() => createSandboxLauncher({ ...base, procMasks: [] }));
});

test('M-15: a workload environment with LD_PRELOAD or BASH_ENV (or any shell-honoured name) is refused before any spawn, and nothing is left behind', async () => {
    for (const name of ['LD_PRELOAD', 'BASH_ENV', 'LD_LIBRARY_PATH', 'IFS', 'ENV', 'BASH_FUNC_x%%']) {
        const world = rig();
        try {
            await assert.rejects(world.launcher.launch(workloadSpec(world, { env: { HOME: '/home/robot', [name]: 'x' } })), { code: 'invalid_request' }, name);
            assert.equal(world.spawned.length, 0, `spawns for ${name}`);
            assert.ok(!fs.existsSync(`${world.dir}/stage/${markerSlot(MARKER)}`), 'the staging directory made for it is removed');
        } finally { world.done(); }
    }
});

test('E: exclusions that are not plain grant-relative paths are refused before anything is spawned; a good one reaches prep', async () => {
    for (const bad of ['/etc/passwd', '../x', 'a/../b', './a', 'a//b', '', 'a\0b', 'x'.repeat(2000)]) {
        const world = rig();
        try {
            const spec = workloadSpec(world);
            spec.grants[0].exclusions = [bad];
            await assert.rejects(world.launcher.launch(spec), { code: 'invalid_request' }, JSON.stringify(bad).slice(0, 30));
            assert.equal(world.spawned.length, 0);
            assert.ok(!fs.existsSync(`${world.dir}/stage`), 'refused before the staging directory exists');
        } finally { world.done(); }
    }
    const world = rig();
    try {
        const spec = workloadSpec(world);
        spec.grants[0].exclusions = ['docs/private', 'notes.txt'];
        await world.launcher.launch(spec);
        const prep = world.spawned[0].args.indexOf('prep');
        assert.deepEqual(JSON.parse(world.spawned[0].args[prep + 5]).grants[0].exclusions, ['docs/private', 'notes.txt']);
    } finally { world.done(); }
    const refused = rig({ exitBefore: 24 });
    try { await assert.rejects(refused.launcher.launch(workloadSpec(refused)), { code: 'invalid_request' }, 'prep exit 24 (an exclusion through a symlink)'); } finally { refused.done(); }
});
