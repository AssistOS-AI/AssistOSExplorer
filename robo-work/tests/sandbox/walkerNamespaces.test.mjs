// B1 and B3 at the recovery walker: a namespace inode is trusted only while pinned or while the recorded init proves it, and an
// execution network is released only when its netns file, both veth ends and the nft table are all gone.
import assert from 'node:assert/strict';
import test from 'node:test';

import { createWalker } from '../../server/execution/recoveryWalk.mjs';
import { namesFor } from '../../server/sandbox/executionNetwork.mjs';
import { createRecoveryView } from '../../server/sandbox/executionSupervisor.mjs';

const clock = () => { let now = 0; return { now: () => now, sleep: async (ms) => { now += ms; } }; };
const proc = (pid, extra = {}) => ({ pid, ppid: 1, startTime: String(pid), cmdline: ['x'], pidNs: '1', netNs: '1', mntNs: '1', fdNs: [], ...extra });

function walkerOver(processes, { pinned = [], kills = [] } = {}) {
    const view = {
        listProcesses: () => processes.map((entry) => ({ ...entry })), listMounts: () => [], exists: () => false, remove: () => false, unmount: () => false,
        kill: ({ pid, startTime }) => { kills.push([pid, startTime]); const index = processes.findIndex((entry) => entry.pid === pid && entry.startTime === startTime); if (index >= 0) processes.splice(index, 1); return true; },
        isPinned: (type, inode) => pinned.includes(`${type}:${inode}`)
    };
    return createWalker({ view, clock: clock(), releaseDeadlineMs: 100, pollMs: 10, sandboxRecord: () => null });
}

const tree = (pidNs = '777', extra = {}) => ({ kind: 'process-tree', identity: { pid: 100, startTime: '100', pidNs, mntNs: '8', stageMntNs: '9', netNs: '5', init: { pid: 101, startTime: '101' }, ...extra }, locator: { marker: 'rw-marker0123456789abcd' } });

test('B1: a process that merely shows the recorded pid-namespace inode (a later sandbox) is neither killed nor counted as a member', async () => {
    const kills = [];
    const processes = [proc(500, { pidNs: '777' }), proc(501, { ppid: 500, pidNs: '777' })];
    const walker = walkerOver(processes, { kills });
    assert.equal(walker.prove(tree()).absent, true, 'the recorded sandbox is gone; the inode number now belongs to someone else');
    assert.equal(await walker.walk(tree()), 'released');
    assert.deepEqual(kills, [], 'nothing was killed');
    assert.equal(processes.length, 2);
});

test('B1: the inode seeds the walk only while the recorded init (pid and start time) is alive in that namespace, or while it is pinned', async () => {
    const withInit = [proc(101, { ppid: 100, pidNs: '777' }), proc(102, { ppid: 101, pidNs: '777' }), proc(103, { ppid: 1, pidNs: '777' }), proc(500, { pidNs: '999' })];
    const kills = [];
    const alive = walkerOver(withInit, { kills });
    assert.equal(alive.prove(tree()).absent, false);
    assert.equal(await alive.walk(tree()), 'released');
    assert.deepEqual(kills.map(([pid]) => pid).sort(), [101, 102, 103], 'every member, including a reparented setsid one; the other namespace is spared');
    // pinned: the init may be gone and the members still are found by the inode
    const pinnedKills = [];
    const members = [proc(103, { pidNs: '777' }), proc(500, { pidNs: '999' })];
    const pinned = walkerOver(members, { pinned: ['pid:777'], kills: pinnedKills });
    assert.equal(await pinned.walk(tree()), 'released');
    assert.deepEqual(pinnedKills.map(([pid]) => pid), [103]);
    // the init pid reused by a process with another start time does not prove the namespace
    const reusedKills = [];
    const reused = walkerOver([proc(101, { startTime: '5555', pidNs: '777' }), proc(500, { pidNs: '777' })], { kills: reusedKills });
    assert.equal(reused.prove(tree()).absent, true);
    await reused.walk(tree());
    assert.deepEqual(reusedKills, []);
});

test('B1: the recorded monitor and init are matched by pid AND start time; a descendant of the monitor is still found', async () => {
    const kills = [];
    const processes = [proc(100, { startTime: '100' }), proc(150, { ppid: 100 }), proc(100 + 5, { startTime: '1' })];
    const walker = walkerOver(processes, { kills });
    await walker.walk(tree());
    assert.deepEqual(kills.map(([pid]) => pid).sort(), [100, 150]);
});

test('B1 legacy identity (no init field): the recorded process anchors its namespace', async () => {
    const kills = [];
    const processes = [proc(100, { startTime: '100', pidNs: '777' }), proc(600, { pidNs: '777' })];
    const walker = walkerOver(processes, { kills });
    await walker.walk({ kind: 'process-tree', identity: { pid: 100, startTime: '100', pidNs: '777' }, locator: { marker: 'm' } });
    assert.deepEqual(kills.map(([pid]) => pid).sort(), [100, 600]);
});

// ---- B3 ---------------------------------------------------------------------------------------------------------------------

const LOCATOR = '0123456789abcdef0123456789abcdef';
const names = namesFor(LOCATOR);

function networkWorld({ stubborn = null } = {}) {
    const state = { file: true, host: true, peer: true, table: true };
    const runSync = (command, args) => {
        const line = `${command} ${args.join(' ')}`;
        if (line === 'ip -o link show') return { status: 0, stdout: `1: lo: <>\n${state.host ? `5: ${names.host}@if4: <UP>\n` : ''}${state.peer ? `4: ${names.peer}@if5: <UP>\n` : ''}`, stderr: '' };
        if (line === 'nft list tables') return { status: 0, stdout: state.table ? `table inet ${names.table}\n` : '', stderr: '' };
        if (stubborn === command) return { status: 1, stdout: '', stderr: 'boom' };
        if (line.startsWith('nft delete')) state.table = false;
        if (line.startsWith('ip link del')) { state.host = false; state.peer = false; }
        if (line.startsWith('ip netns del')) state.file = false;
        return { status: 0, stdout: '', stderr: '' };
    };
    const recovery = createRecoveryView({ exists: () => false, remove: () => true }, { runSync, exists: () => state.file });
    const walker = createWalker({ view: { ...recovery, listProcesses: () => [], listMounts: () => [] }, clock: clock(), releaseDeadlineMs: 50, pollMs: 10, sandboxRecord: () => null });
    return { state, recovery, walker };
}

const netns = (identity = { netNs: '12345' }) => ({ kind: 'netns', identity, locator: { netns: LOCATOR, keeper: 'k' } });

test('B3: a netns blocker is released only when the netns file, both veth ends and the nft table are all gone', async () => {
    const world = networkWorld();
    assert.equal(world.walker.prove(netns()).absent, false, 'nothing but the object checks hold it');
    for (const part of ['host', 'table']) {
        const partial = networkWorld();
        Object.assign(partial.state, { file: false, host: false, peer: false, table: false, [part]: true });
        assert.equal(partial.walker.prove(netns()).absent, false, `${part} alone keeps it present`);
        assert.equal(partial.walker.prove(netns(null)).absent, false, `uncommitted: ${part} alone keeps it present`);
    }
    assert.equal(await world.walker.walk(netns()), 'released');
    assert.deepEqual(world.state, { file: false, host: false, peer: false, table: false });
});

test('B3: a removal that leaves the nft table (or the veth) behind ends quarantined, never released', async () => {
    for (const stubborn of ['nft', 'ip']) {
        const world = networkWorld({ stubborn });
        assert.equal(await world.walker.walk(netns()), 'quarantined', stubborn);
        assert.equal(await world.walker.walk(netns(null)), 'quarantined', `${stubborn} (uncommitted)`);
    }
});
