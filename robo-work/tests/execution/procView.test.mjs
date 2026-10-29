import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { ProcUnreadable, createProcView, devMajorMinor, parseMountinfoLine, parseStatLine } from '../../server/execution/procView.mjs';
import { confirmRevocation } from '../../server/views/rootLease.mjs';
import { SELF_MNT_NS, SELF_NET_NS, SELF_PID_NS, createFakeWorld } from './helpers/fakeKeeperProcess.mjs';

// The supervisor's own /proc reader over a FAKE procRoot (keeper wire contract delta section 6, R1.1, R1.7). Unit
// evidence only: real /proc, AppArmor reads and devpts devices are Linux and G1 work.

const view = (world, extra = {}) => createProcView({
    procRoot: world.procRoot, signal: world.signal, runtimeRoot: world.runtimeRoot, cgroupSubtree: world.cgroupSubtree, statfs: world.statfs, containerDevpts: '/dev', ...extra
});
const hex = (character) => character.repeat(32);

test('cgroup identity gates absence and removal under a shadow filesystem', (t) => {
    const world = createFakeWorld(t);
    const locator = { path: path.join(world.cgroupSubtree, `x-${hex('a')}`) };
    const good = view(world);
    const stat = fs.statSync(world.cgroupSubtree, { bigint: true });
    assert.deepEqual(good.cgroupSubtreeIdentity(), { path: world.cgroupSubtree, dev: String(stat.dev), ino: String(stat.ino) });
    assert.equal(good.exists('cgroup', locator), false);
    for (const statfs of [() => ({ type: 0 }), () => { throw new Error('statfs failed'); }]) {
        const bad = view(world, { statfs });
        assert.equal(bad.cgroupSubtreeIdentity(), null);
        assert.equal(bad.exists('cgroup', locator), true, 'absence on a shadow cannot release a blocker');
        fs.mkdirSync(locator.path, { recursive: true });
        assert.equal(bad.remove('cgroup', locator), false, 'invalid subtree cannot remove a leaf');
        assert.equal(fs.existsSync(locator.path), true);
    }
    assert.equal(good.remove('cgroup', locator), true);
    const alias = `${world.cgroupSubtree}-link`;
    fs.symlinkSync(world.cgroupSubtree, alias);
    assert.equal(view(world, { cgroupSubtree: alias, statfs: () => ({ type: 0x63677270 }) }).cgroupSubtreeIdentity(), null);
    assert.throws(() => createProcView({ statfs: world.statfs }), /fake procRoot/u);
    for (const cgroupSubtree of ['relative', '/', '/a//b', '/a/../b', '/a/', 7]) assert.throws(() => view(world, { cgroupSubtree }), /Invalid cgroup subtree/u);
});

test('stat parsing takes the fields after the LAST closing parenthesis, so a hostile comm cannot shift them', () => {
    assert.deepEqual(parseStatLine('4201 (x) R 1 (y) S 4100 4201 4201 0 -1 0 0 0 0 0 0 0 0 0 20 0 1 0 5550003 0 0 0\n'), { pid: 4201, ppid: 4100, startTime: '5550003' });
    assert.deepEqual(parseStatLine('7 (a b) c) S 2 7 7 0 -1 0 0 0 0 0 0 0 0 0 20 0 1 0 18446744073709551615 0'), { pid: 7, ppid: 2, startTime: '18446744073709551615' });
    assert.deepEqual(parseStatLine('8 ()) S 3 8 8 0 -1 0 0 0 0 0 0 0 0 0 20 0 1 0 00042 0'), { pid: 8, ppid: 3, startTime: '42' }, 'canonical decimal');
    for (const line of ['8 (short) S 3', 'x (bad) S 1 1 1 0 -1 0 0 0 0 0 0 0 0 0 20 0 1 0 1 0', '9 no-parens S 1', '', '10 (z)S 1 1 1 0 -1 0 0 0 0 0 0 0 0 0 20 0 1 0 1 0']) {
        assert.equal(parseStatLine(line), null, JSON.stringify(line));
    }
});

test('a procRoot other than /proc needs an explicit signal, so fake entries can never signal real pids (R1.7)', (t) => {
    const world = createFakeWorld(t);
    assert.throws(() => createProcView({ procRoot: world.procRoot }), /explicit signal/u);
    assert.doesNotThrow(() => createProcView({ procRoot: world.procRoot, signal: () => {} }));
});

test('listProcesses: integer pids, canonical string start times and namespace inodes, and namespace descriptors as strings', (t) => {
    const world = createFakeWorld(t);
    world.writeProcess({ pid: 300001, ppid: 1, startTime: '777', cmdline: ['/bin/x', '--reservation', '-abc'], comm: 'x) R 1 (y', pidNs: '4026599001', netNs: '4026599002' });
    world.addFd(300001, 7, 'net:[4026599003]');
    world.addFd(300001, 8, 'socket:[123]');
    world.addFd(300001, 9, '/nonexistent/closed-file');
    const [entry] = view(world).listProcesses();
    assert.deepEqual(entry, {
        pid: 300001, ppid: 1, startTime: '777', cmdline: ['/bin/x', '--reservation', '-abc'], pidNs: '4026599001', netNs: '4026599002', mntNs: SELF_MNT_NS, fdNs: ['4026599003']
    });
    assert.deepEqual(view(world).selfNamespaces(), { pidNs: SELF_PID_NS, netNs: SELF_NET_NS, mntNs: SELF_MNT_NS });
});

test('read errors: a vanished process is skipped, an unreadable one throws proc_unreadable (fail closed)', (t) => {
    const world = createFakeWorld(t);
    world.writeProcess({ pid: 300010, ppid: 1, startTime: '1', cmdline: ['a'] });
    world.writeProcess({ pid: 300011, ppid: 1, startTime: '2', cmdline: ['b'] });
    fs.rmSync(path.join(world.procRoot, '300011', 'stat'));
    assert.deepEqual(view(world).listProcesses().map((entry) => entry.pid), [300010], 'ENOENT on stat: the process vanished');
    world.writeProcess({ pid: 300012, ppid: 1, startTime: '3', cmdline: ['c'] });
    // Any errno other than ENOENT/ESRCH: EISDIR always, and EACCES where permissions bind (not for root).
    fs.rmSync(path.join(world.procRoot, '300012', 'stat'));
    fs.mkdirSync(path.join(world.procRoot, '300012', 'stat'));
    assert.throws(() => view(world).listProcesses(), (error) => error instanceof ProcUnreadable && error.code === 'proc_unreadable' && error.errno === 'EISDIR');
    fs.rmSync(path.join(world.procRoot, '300012', 'stat'), { recursive: true });
    fs.writeFileSync(path.join(world.procRoot, '300012', 'stat'), world.readStat(300010));
    if (process.getuid?.() !== 0) {
        fs.chmodSync(path.join(world.procRoot, '300012', 'stat'), 0o000);
        t.after(() => { try { fs.chmodSync(path.join(world.procRoot, '300012', 'stat'), 0o644); } catch { /* removed */ } });
        assert.throws(() => view(world).listProcesses(), (error) => error instanceof ProcUnreadable && error.errno === 'EACCES');
        fs.chmodSync(path.join(world.procRoot, '300012', 'stat'), 0o644);
    }
    fs.writeFileSync(path.join(world.procRoot, '300012', 'stat'), 'garbage\n');
    assert.throws(() => view(world).listProcesses(), ProcUnreadable, 'a malformed stat is not "absent"');
    fs.rmSync(path.join(world.procRoot, '300012'), { recursive: true });
    fs.rmSync(path.join(world.procRoot, '300010', 'ns', 'net'));
    fs.writeFileSync(path.join(world.procRoot, '300010', 'ns', 'net'), 'not a link');
    assert.throws(() => view(world).listProcesses(), ProcUnreadable, 'EINVAL from readlink is unreadable');
});

test('listMounts: the supervisor table plus one representative per other mount namespace, with nsfs inodes and unescaped mountpoints', (t) => {
    const world = createFakeWorld(t);
    world.appendSelfMount('40 22 0:4 net:[4026599100] /run/netns/a\\040b rw - nsfs nsfs rw\n');
    world.writeProcess({ pid: 300020, ppid: 1, startTime: '1', cmdline: ['fs'], mntNs: '4026599200', mountinfo: '512 22 0:91 / /views/g rw - fuse.rw rw rw\n' });
    world.writeProcess({ pid: 300021, ppid: 1, startTime: '2', cmdline: ['fs2'], mntNs: '4026599200', mountinfo: '513 22 0:92 / /views/other rw - fuse.rw rw rw\n' });
    const mounts = view(world).listMounts();
    assert.deepEqual(mounts.map((mount) => [mount.mountId, mount.mountpoint, mount.mntNs, mount.fstype, mount.nsInode, mount.majorMinor]), [
        [22, '/', SELF_MNT_NS, 'apfs', null, '0:21'],
        [40, '/run/netns/a b', SELF_MNT_NS, 'nsfs', '4026599100', '0:4'],
        [512, '/views/g', '4026599200', 'fuse.rw', null, '0:91']
    ]);
    assert.equal(parseMountinfoLine('1 2 3', null), null);
    world.writeSelfMountinfo('broken line\n');
    assert.throws(() => view(world).listMounts(), ProcUnreadable);
});

test('exists(runtime-dir | cgroup): absent only for an exact locator path whose parent is a real directory and whose lstat is ENOENT', (t) => {
    const world = createFakeWorld(t);
    const v = view(world);
    const runtime = path.join(world.runtimeRoot, 'x', hex('a'));
    assert.equal(v.exists('runtime-dir', { path: runtime }), false);
    fs.mkdirSync(runtime);
    assert.equal(v.exists('runtime-dir', { path: runtime }), true);
    fs.rmSync(runtime, { recursive: true });
    fs.symlinkSync('/', runtime);
    assert.equal(v.exists('runtime-dir', { path: runtime }), true, 'a link is present');
    fs.rmSync(runtime);
    fs.writeFileSync(runtime, '');
    assert.equal(v.exists('runtime-dir', { path: runtime }), true, 'a non-directory is present');
    fs.rmSync(runtime);
    assert.equal(v.exists('runtime-dir', { path: `${world.runtimeRoot}/y/${hex('a')}` }), true, 'not the locator form');
    assert.equal(v.exists('runtime-dir', { path: `${runtime}0` }), true, '33 hex digits');
    const moved = `${world.runtimeRoot}/x.real`;
    fs.renameSync(path.join(world.runtimeRoot, 'x'), moved);
    fs.symlinkSync(moved, path.join(world.runtimeRoot, 'x'));
    assert.equal(v.exists('runtime-dir', { path: runtime }), true, 'the x directory is a link');
    const cgroup = `${world.cgroupSubtree}/x-${hex('b')}`;
    assert.equal(v.exists('cgroup', { path: cgroup }), false);
    fs.mkdirSync(cgroup);
    assert.equal(v.exists('cgroup', { path: cgroup }), true);
    assert.equal(createProcView({ procRoot: world.procRoot, signal: world.signal }).exists('cgroup', { path: cgroup }), true, 'no cgroup subtree configured: present');
    for (const kind of ['veth', 'nft-table', 'gui-container', 'frob']) assert.equal(v.exists(kind, {}), true, kind);
});

test('exists(pty), committed: present while any process descriptor or mount has the devpts device; a throwing resolver is present', (t) => {
    const world = createFakeWorld(t);
    const pty = world.newPtyFile(0);
    let identity = { pty: hex('c'), devptsDev: pty.dev, index: 0 };
    let throws = false;
    const v = view(world, { identityForLocator: () => { if (throws) throw new Error('no blocker'); return identity; }, keeperRecord: () => null });
    world.writeProcess({ pid: 300030, ppid: 1, startTime: '5', cmdline: ['k'] });
    world.writeProcess({ pid: 300031, ppid: 1, startTime: '6', cmdline: ['other'] });
    world.addFd(300031, 9, '/nonexistent/closed');
    world.addFd(300031, 10, pty.file);
    assert.equal(v.exists('pty', { pty: hex('c') }), true, 'a holder with a closed descriptor beside the pty one is still a holder');
    world.removeFd(300031, 10);
    assert.equal(v.exists('pty', { pty: hex('c') }), false);
    world.appendSelfMount(`41 22 ${devMajorMinor(pty.dev)} / /dev/pts-x rw - devpts devpts rw\n`);
    assert.equal(v.exists('pty', { pty: hex('c') }), true, 'still mounted somewhere');
    world.writeSelfMountinfo('22 1 0:21 / / rw - apfs /dev/root rw\n');
    throws = true;
    assert.equal(v.exists('pty', { pty: hex('c') }), true, 'no blocker for the locator: present');
    throws = false;
    identity = { pty: hex('c'), devptsDev: 136314880, index: 0 };
    assert.equal(v.exists('pty', { pty: hex('c') }), true, 'an unusable identity falls back to the keeper, which cannot be read here: present');
});

test('exists(pty), uncommitted: absent only when the keeper named by the locator is absent, judged from its own record', (t) => {
    const world = createFakeWorld(t);
    const marker = 'AAECAwQFBgcICQoLDA0ODw';
    let record = { locator: { marker }, identity: null };
    let throws = false;
    const v = view(world, { identityForLocator: () => null, keeperRecord: () => { if (throws) throw new Error('unreadable'); return record; } });
    world.writeProcess({ pid: 300040, ppid: 1, startTime: '9', cmdline: ['keeper', '--reservation', marker] });
    assert.equal(v.exists('pty', { pty: hex('d'), keeper: marker }), true, 'the uncommitted keeper carries its marker');
    record = { locator: { marker }, identity: { pid: 300040, startTime: '9' } };
    assert.equal(v.exists('pty', { pty: hex('d'), keeper: marker }), true, 'the committed keeper is alive');
    record = { locator: { marker }, identity: { pid: 300040, startTime: '10' } };
    assert.equal(v.exists('pty', { pty: hex('d'), keeper: marker }), false, 'another start time is another process');
    throws = true;
    assert.equal(v.exists('pty', { pty: hex('d'), keeper: marker }), true);
    throws = false;
    record = null;
    assert.equal(v.exists('pty', { pty: hex('d'), keeper: marker }), true, 'no record: present');
    record = { locator: { marker }, identity: null };
    world.removeProcess(300040);
    assert.equal(v.exists('pty', { pty: hex('d'), keeper: marker }), false);
});

test('kill re-reads the start time; the registered keeper child goes through its ChildProcess, never through signal', (t) => {
    const world = createFakeWorld(t);
    const v = view(world);
    world.writeProcess({ pid: 300050, ppid: 1, startTime: '50', cmdline: ['t'] });
    assert.equal(v.kill({ pid: 300050, startTime: '49' }), false);
    assert.deepEqual(world.signals, []);
    assert.equal(v.kill({ pid: 300050, startTime: '50' }), true);
    assert.deepEqual(world.signals, [{ pid: 300050, name: 'SIGKILL' }]);
    world.writeProcess({ pid: 300051, ppid: 1, startTime: '51', cmdline: ['keeper'] });
    const kills = [];
    const unregister = v.registerKeeperChild({ pid: 300051, startTime: '51', kill: () => kills.push('child') });
    assert.equal(v.kill({ pid: 300051, startTime: '51' }), true);
    assert.deepEqual(kills, ['child']);
    assert.equal(world.signals.length, 1, 'no signal for the keeper');
    unregister();
    assert.equal(v.kill({ pid: 300052, startTime: '1' }), false, 'no such process');
});

test('remove(runtime-dir) removes only an exact locator directory with no mount beneath it; pty, egress and unmount answer false', (t) => {
    const world = createFakeWorld(t);
    const v = view(world);
    const runtime = path.join(world.runtimeRoot, 'x', hex('e'));
    fs.mkdirSync(path.join(runtime, 'tmp'), { recursive: true });
    fs.symlinkSync('/etc', path.join(runtime, 'link'));
    world.appendSelfMount(`45 22 0:60 / ${runtime}/views/g rw - fuse.rw rw rw\n`);
    assert.equal(v.remove('runtime-dir', { path: runtime }), false, 'a mount beneath it');
    world.writeSelfMountinfo('22 1 0:21 / / rw - apfs /dev/root rw\n');
    assert.equal(v.remove('runtime-dir', { path: runtime }), true);
    assert.equal(fs.existsSync(runtime), false);
    assert.equal(fs.existsSync('/etc'), true, 'the link was unlinked, not followed');
    assert.equal(v.remove('runtime-dir', { path: '/etc' }), false);
    assert.equal(v.remove('pty', { pty: hex('e') }), false);
    assert.equal(v.remove('veth', {}), false);
    assert.equal(v.unmount({ mountId: 1, mountpoint: '/' }), false);
});

test('processIdentity has exactly the shape the root lease accepts, and heldNamespaces reports descriptor-held namespaces', async (t) => {
    const world = createFakeWorld(t);
    world.writeProcess({ pid: 300060, ppid: 1, startTime: '60', cmdline: ['fs'], pidNs: '4026599300' });
    world.addFd(300060, 7, 'mnt:[4026599301]');
    const v = view(world);
    const identity = v.processIdentity(300060);
    assert.deepEqual(identity, { pid: 300060, startTime: '60', pidNamespaceInode: '4026599300' });
    assert.deepEqual(await confirmRevocation({ identity, probe: (pid) => v.processIdentity(pid) }), { state: 'alive', action: 'kill_keeper_and_quarantine' });
    assert.deepEqual(v.heldNamespaces(300060), { pidNs: '4026599300', netNs: SELF_NET_NS, mntNs: SELF_MNT_NS, fdNs: ['4026599301'] });
    world.removeProcess(300060);
    assert.equal(v.processIdentity(300060), null);
    assert.deepEqual(await confirmRevocation({ identity, probe: (pid) => v.processIdentity(pid) }), { state: 'gone', action: 'none' });
});

test('devMajorMinor uses the Linux dev_t encoding', () => {
    assert.equal(devMajorMinor('34816'), '136:0');
    assert.equal(devMajorMinor(String((0x2c) | (0x100 << 12))), '0:300');
    assert.equal(devMajorMinor('50'), '0:50');
});
