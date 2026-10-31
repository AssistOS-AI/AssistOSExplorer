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

// ---- M-36 at the walker ------------------------------------------------------------------------------------------------------

test('M-36: a thread of a zombie leader that holds the network namespace holds it (by the thread\'s readable link); one that does not, does not', async () => {
    const recovery = (processes) => createRecoveryView({ exists: () => false, remove: () => true }, { runSync: () => ({ status: 0, stdout: '', stderr: '' }), exists: () => false });
    const make = (processes) => createWalker({ view: { ...recovery(processes), listProcesses: () => processes, listMounts: () => [] }, clock: clock(), releaseDeadlineMs: 50, pollMs: 10, sandboxRecord: () => null });
    const netns = { kind: 'netns', identity: { netNs: '4026539101' }, locator: { netns: '0123456789abcdef0123456789abcdef', keeper: 'k' } };
    const holder = proc(900, { pidNs: '5', netNs: '4026531000', mntNs: '6', threadNs: { pidNs: ['5'], netNs: ['4026531000', '4026539101'], mntNs: ['6'] } });
    assert.equal(make([holder]).prove(netns).absent, false, 'its second thread sits in the execution network');
    assert.ok(make([holder]).prove(netns).holders.some((entry) => entry.via === 'ns-link' && entry.pid === 900));
    const bystander = proc(901, { pidNs: '5', netNs: '4026531000', mntNs: '6', threadNs: { pidNs: ['5'], netNs: ['4026531000'], mntNs: ['6'] } });
    assert.equal(make([bystander]).prove(netns).absent, true);
});

test('M-36: robot A\'s long-lived opaque process cannot make execution B\'s netns, mount or tree release wait or quarantine', async () => {
    const hostile = proc(700, { ppid: 650, state: 'Z', pidNs: '4026534500', netNs: null, mntNs: null, fdNs: [], opaque: true, threadNs: { pidNs: ['4026534500'], netNs: [], mntNs: [] } });
    const aInit = proc(650, { pidNs: '4026534500', netNs: '4026539100', mntNs: '4026539200' });
    const view = { listProcesses: () => [hostile, aInit], listMounts: () => [], exists: () => false, remove: () => true, kill: () => false, unmount: () => false, isPinned: () => false };
    const walker = createWalker({ view, clock: clock(), releaseDeadlineMs: 50, pollMs: 10, sandboxRecord: () => null });
    assert.equal(await walker.walk({ kind: 'netns', identity: { netNs: '4026539999' }, locator: { netns: 'b'.repeat(32), keeper: 'kb' } }), 'released', 'B\'s network');
    assert.equal(await walker.walk({ kind: 'mount', identity: { mntNs: '4026539998', mountId: 9, mountpoint: '/b' }, locator: { mount: 'b' } }), 'released', 'B\'s mount');
    assert.equal(await walker.walk({ kind: 'process-tree', identity: { pid: 800, startTime: '800', pidNs: '4026534600', init: { pid: 801, startTime: '801' } }, locator: { marker: 'mb' } }), 'released', 'B\'s tree');
    // A's own network IS held by the opaque leader that descends from A's init (which readably holds it)
    assert.equal(walker.prove({ kind: 'netns', identity: { netNs: '4026539100' }, locator: { netns: 'a'.repeat(32), keeper: 'ka' } }).absent, false);
});

// ---- F-Q1: crash recovery with no pins must not act on a namespace inode alone ----------------------------------------------------------------------
// Observed: the net namespace recorded for an execution of a killed worker became the network namespace of the REPLACEMENT worker container itself
// (inode 4026532922, held by its pid 1, 2, 11 and 21). The holders were "live", the by-name proofs said everything was gone, and the interrupted
// execution's netns blocker was quarantined, leaving the robot nonready.

const OWN = { pidNs: '4026531836', mntNs: '4026531840', netNs: '4026532922' };
const LOCAL = '0123456789abcdef0123456789abcdef';
const netnsBlocker = (netNs = '4026532922') => ({ kind: 'netns', identity: { netNs, name: 'rwaaaaaaaaaaaaaaaa', host: 'rwaaaaaaaaah', peer: 'rwaaaaaaaaan', table: 'rw_aaaaaaaaaaaaaaaa' }, locator: { netns: LOCAL, keeper: 'K' } });
const worker = (pid, extra = {}) => proc(pid, { ppid: pid === 1 ? 0 : 1, pidNs: OWN.pidNs, netNs: OWN.netNs, mntNs: OWN.mntNs, ...extra });

function walkerWith(processes, { record = null, named = false, mounts = [], self = OWN } = {}) {
    const view = {
        listProcesses: () => processes, listMounts: () => mounts, exists: (kind) => (kind === 'netns' ? named : false), remove: () => true, kill: () => false, unmount: () => false,
        selfNamespaces: () => self, isPinned: () => false
    };
    return createWalker({ view, clock: clock(), releaseDeadlineMs: 50, pollMs: 10, sandboxRecord: () => record });
}

test('F-Q1: a recorded netns inode equal to the supervisor\'s OWN network namespace was reused by the worker container: its processes are not holders and the blocker is released', async () => {
    const containerLevel = [worker(1), worker(2, { ppid: 1 }), worker(11, { ppid: 2 }), worker(21, { ppid: 2 })];
    const walker = walkerWith(containerLevel, { record: { identity: { pid: 5, startTime: '5' }, locator: { marker: 'K' } } });
    const verdict = walker.prove(netnsBlocker(), true);
    assert.deepEqual(verdict, { absent: true, holders: [] });
    assert.equal(await walker.walk(netnsBlocker(), { recovery: true }), 'released');
    // also when the store gave no execution records at all
    assert.equal(await walkerWith(containerLevel).walk(netnsBlocker(), { recovery: true }), 'released');
    // and an nsfs mount of that same (own) namespace does not hold it either
    assert.equal(walkerWith(containerLevel, { mounts: [{ mountId: 1, mountpoint: '/run/netns/x', mntNs: OWN.mntNs, fstype: 'nsfs', nsInode: '4026532922' }] }).prove(netnsBlocker(), true).absent, true);
});

test('F-Q1: the same for a recorded mount namespace equal to the supervisor\'s own', async () => {
    const containerLevel = [worker(1), worker(21, { ppid: 1 })];
    const mount = { kind: 'mount', identity: { mntNs: OWN.mntNs, mountId: 7, mountpoint: '/stage' }, locator: { mount: 'm', keeper: 'K' } };
    assert.equal(await walkerWith(containerLevel).walk(mount, { recovery: true }), 'released');
});

test('F-Q1: without the execution\'s records, only processes in a pid namespace other than the supervisor\'s can be holders (a sandbox member is; a container process is not)', async () => {
    const reusedByOther = '4026539999';
    const container = worker(30, { netNs: reusedByOther }); // a container-level process in some namespace that happens to carry the number
    assert.equal(walkerWith([container]).prove(netnsBlocker(reusedByOther), true).absent, true);
    const member = proc(900, { ppid: 899, pidNs: '4026534100', netNs: reusedByOther, mntNs: '1' });
    assert.equal(walkerWith([member]).prove(netnsBlocker(reusedByOther), true).absent, false, 'a sandbox member in the recorded namespace is a holder');
});

test('F-Q1: with the execution\'s records, a holder must be attributable to it: marker, a recorded monitor/init (or a descendant), or a pid namespace its tree still owns', async () => {
    const inode = '4026539999';
    const record = {
        identity: { pid: 5, startTime: '5' }, locator: { marker: 'KEEPERMARKER0123456789' },
        siblings: [{ kind: 'process-tree', locator: { marker: 'TREEMARKER0123456789ab' }, identity: { pid: 100, startTime: '100', pidNs: '4026534500', init: { pid: 101, startTime: '101' } } }]
    };
    const theirs = (extra) => proc(extra.pid, { ppid: 1, pidNs: '4026534999', netNs: inode, mntNs: '1', ...extra });
    // a member of ANOTHER live execution that was handed the reused number: not this execution's
    assert.equal(walkerWith([theirs({ pid: 700 })], { record }).prove(netnsBlocker(inode), true).absent, true);
    // carrying this execution's marker
    assert.equal(walkerWith([theirs({ pid: 701, cmdline: ['/usr/bin/bwrap', 'TREEMARKER0123456789ab'] })], { record }).prove(netnsBlocker(inode), true).absent, false);
    // the recorded init itself (pid + start time), and a descendant of it (a double-forked member re-parented under the sandbox init)
    assert.equal(walkerWith([theirs({ pid: 101, startTime: '101' })], { record }).prove(netnsBlocker(inode), true).absent, false);
    assert.equal(walkerWith([theirs({ pid: 101, startTime: '101' }), theirs({ pid: 705, ppid: 101 })]).prove(netnsBlocker(inode), true).absent, false, 'without records the foreign pid namespace counts');
    assert.equal(walkerWith([theirs({ pid: 101, startTime: '101' }), theirs({ pid: 705, ppid: 101, pidNs: '4026534999' })], { record }).prove(netnsBlocker(inode), true).holders.length, 2);
    // the same pid with ANOTHER start time is a different process
    assert.equal(walkerWith([theirs({ pid: 101, startTime: '999' })], { record }).prove(netnsBlocker(inode), true).absent, true);
    // in a pid namespace one of its recorded trees proves it still owns (its init is alive in it)
    const init = proc(101, { startTime: '101', ppid: 1, pidNs: '4026534500', netNs: '1', mntNs: '1' });
    assert.equal(walkerWith([init, theirs({ pid: 702, pidNs: '4026534500' })], { record }).prove(netnsBlocker(inode), true).absent, false);
    // the number of the tree's pid namespace alone, init gone and unpinned, is a reused number: not a holder
    assert.equal(walkerWith([theirs({ pid: 703, pidNs: '4026534500' })], { record }).prove(netnsBlocker(inode), true).absent, true);
});

test('F-Q1: the by-name proofs still decide: a netns file, veth or table left behind keeps the blocker even with no holder, and a real attributable holder keeps it even when everything by name is gone', async () => {
    const processes = [worker(1), worker(21, { ppid: 1 })];
    assert.equal(walkerWith(processes, { named: true }).prove(netnsBlocker(), true).absent, false);
    assert.deepEqual(walkerWith(processes, { named: true }).prove(netnsBlocker(), true).holders, [{ via: 'locator' }]);
    const record = { identity: { pid: 5, startTime: '5' }, locator: { marker: 'KEEPERMARKER0123456789' }, siblings: [{ kind: 'endpoint', locator: { marker: 'EPMARKER0123456789abcd' }, identity: { pid: 50, startTime: '50', pidNs: '4026534600', init: { pid: 51, startTime: '51' } } }] };
    const live = proc(60, { ppid: 51, pidNs: '4026534600', netNs: '4026539001', mntNs: '1' });
    const init = proc(51, { startTime: '51', ppid: 1, pidNs: '4026534600', netNs: '4026539001', mntNs: '1' });
    assert.equal(walkerWith([...processes, init, live], { record }).prove(netnsBlocker('4026539001'), true).absent, false, 'a real member of the recorded endpoint tree holds the recorded network');
    assert.equal(await walkerWith([...processes, init, live], { record }).walk(netnsBlocker('4026539001'), { recovery: true }), 'quarantined');
});

test('F-Q1: sandboxRecordFor adds the execution\'s other unsettled blockers as `siblings` (same attempt only), and degrades to the bare record when the store cannot list them', async () => {
    const { sandboxRecordFor } = await import('../../server/sandbox/executionSupervisor.mjs');
    const keeper = { resourceId: 'K', attemptId: 'A1', kind: 'keeper', locator: { marker: 'K' }, identity: { pid: 5, startTime: '5' } };
    const state = {
        getResource: ({ resourceId }) => (resourceId === 'K' ? keeper : null),
        listUnsettledResources: () => [keeper, { resourceId: 'T', attemptId: 'A1', kind: 'process-tree' }, { resourceId: 'O', attemptId: 'A2', kind: 'process-tree' }]
    };
    const record = sandboxRecordFor(() => state)({ locator: { keeper: 'K' } });
    assert.deepEqual(record.siblings.map((entry) => entry.resourceId), ['T']);
    assert.equal(record.locator.marker, 'K');
    assert.equal('siblings' in sandboxRecordFor(() => ({ getResource: () => keeper }))({ locator: { keeper: 'K' } }), false);
    assert.equal('siblings' in sandboxRecordFor(() => ({ getResource: () => keeper, listUnsettledResources: () => { throw new Error('closed'); } }))({ locator: { keeper: 'K' } }), false);
});

test('M-47: the attribution rules are for RECOVERY only; the normal end path keeps the pin rule (every process naming the recorded inode is a holder)', async () => {
    const containerLevel = [worker(1), worker(21, { ppid: 1 })];
    const normal = walkerWith(containerLevel);
    assert.equal(normal.prove(netnsBlocker()).absent, false, 'end path: the supervisor pins its namespaces, so a process naming the inode is a real holder');
    assert.ok(normal.prove(netnsBlocker()).holders.some((holder) => holder.via === 'ns-link'));
    assert.equal(normal.prove(netnsBlocker(), true).absent, true, 'recovery: no pins, the same picture is a reused inode');
    assert.equal(await normal.walk(netnsBlocker()), 'quarantined');
    assert.equal(await normal.walk(netnsBlocker(), { recovery: true }), 'released');
    assert.equal(await normal.attempt(netnsBlocker()), null);
    assert.equal(await normal.attempt(netnsBlocker(), { recovery: true }), 'released');
});

test('M-47: generation recovery (recoverGeneration) walks with the recovery rules', async () => {
    const { recoverGeneration } = await import('../../server/execution/recoveryWalk.mjs');
    const containerLevel = [worker(1), worker(21, { ppid: 1 })];
    const walker = walkerWith(containerLevel, { record: { identity: { pid: 5, startTime: '5' }, locator: { marker: 'K' }, siblings: [] } });
    const blocker = { ...netnsBlocker(), resourceId: 'R1', generationId: 'G1' };
    const settled = [];
    const state = {
        generationId: 'G2',
        beginGenerationRecovery: () => ({ generationId: 'G2', priorGenerationId: 'G1', unsettledBlockers: [blocker] }),
        settleResource: (request) => settled.push(request), completeGenerationRecovery: () => ({ recovered: true })
    };
    const result = await recoverGeneration({ state, walker });
    assert.deepEqual(settled.map((request) => request.outcome), ['released']);
    assert.equal(result.completed.recovered, true);
});

test('M-47: a prep child (mount, umount) carries no marker, but descends from the marker-bearing prep: it is attributable; a stray process elsewhere is not', () => {
    const inode = '4026539999';
    const record = { identity: { pid: 5, startTime: '5' }, locator: { marker: 'KEEPERMARKER0123456789' }, siblings: [{ kind: 'process-tree', locator: { marker: 'TREEMARKER0123456789ab' }, identity: null }] };
    const prep = proc(300, { ppid: 21, pidNs: OWN.pidNs, netNs: inode, mntNs: '1', cmdline: ['node', '/opt/robo-work/sandboxPrep.mjs', 'TREEMARKER0123456789ab', '{}'] });
    const mountChild = proc(301, { ppid: 300, pidNs: OWN.pidNs, netNs: inode, mntNs: '1', cmdline: ['mount', '--bind', 'a', 'b'] });
    const stray = proc(302, { ppid: 21, pidNs: OWN.pidNs, netNs: inode, mntNs: '1', cmdline: ['mount', '--bind', 'x', 'y'] });
    assert.equal(walkerWith([prep, mountChild], { record }).prove(netnsBlocker(inode), true).absent, false);
    assert.deepEqual(walkerWith([prep, mountChild], { record }).prove(netnsBlocker(inode), true).holders.map((holder) => holder.pid).sort(), [300, 301]);
    assert.equal(walkerWith([stray], { record }).prove(netnsBlocker(inode), true).absent, true);
});

// ---- M-48: production order. recoverGeneration settles the keeper, endpoint and process trees BEFORE it reaches the netns, and the store lists only
// reserved/committed rows as unsettled, so the settled (or quarantined) rows are gone from sandboxRecordFor(..).siblings by then. The walker is
// given the records from before any settle. The fake store below drops every settled row exactly like listUnsettledResources.
function productionOrder({ members }) {
    const NS = '4026540001';
    const rows = [
        { resourceId: 'K', attemptId: 'A', kind: 'keeper', generationId: 'G1', locator: { marker: 'KMARK0123456789abcdef' }, identity: { pid: 5, startTime: '5' }, state: 'committed' },
        { resourceId: 'T', attemptId: 'A', kind: 'process-tree', generationId: 'G1', locator: { marker: 'TMARK0123456789abcdef', keeper: 'K' }, identity: { pid: 70, startTime: '70', pidNs: '4026540002', mntNs: '4026540003', netNs: NS, init: { pid: 71, startTime: '71' } }, state: 'committed' },
        { resourceId: 'E', attemptId: 'A', kind: 'endpoint', generationId: 'G1', locator: { marker: 'EMARK0123456789abcdef', keeper: 'K' }, identity: { pid: 50, startTime: '50', pidNs: '4026540004', mntNs: '4026540005', netNs: NS, init: { pid: 51, startTime: '51' } }, state: 'committed' },
        { resourceId: 'N', attemptId: 'A', kind: 'netns', generationId: 'G1', locator: { netns: LOCAL, keeper: 'K' }, identity: { netNs: NS }, state: 'committed' }
    ];
    const seenSiblings = [];
    const store = {
        generationId: 'G2',
        getResource: ({ resourceId }) => rows.find((row) => row.resourceId === resourceId),
        // the real listUnsettledResources: only reserved/committed
        listUnsettledResources: () => rows.filter((row) => row.state === 'committed' || row.state === 'reserved'),
        beginGenerationRecovery: () => ({ generationId: 'G2', priorGenerationId: 'G1', unsettledBlockers: rows.filter((row) => row.state === 'committed').map((row) => ({ ...row })) }),
        settleResource: ({ resourceId, outcome }) => { rows.find((row) => row.resourceId === resourceId).state = outcome; },
        completeGenerationRecovery: () => ({ recovered: true })
    };
    return { rows, store, seenSiblings, NS };
}

test('M-48: recoverGeneration in production order: a quarantined process tree whose members hold the recorded netns keeps the netns quarantined', async () => {
    const { recoverGeneration } = await import('../../server/execution/recoveryWalk.mjs');
    const { sandboxRecordFor } = await import('../../server/sandbox/executionSupervisor.mjs');
    const { store, seenSiblings, NS } = productionOrder({});
    // the tree's init (71) and a member (72) live in the tree's own pid namespace and the recorded netns; nothing can kill them. The endpoint is gone.
    const processes = [
        worker(1), worker(21, { ppid: 1 }),
        proc(71, { ppid: 1, pidNs: '4026540002', mntNs: '4026540003', netNs: NS, cmdline: ['sleep'] }),
        proc(72, { ppid: 71, pidNs: '4026540002', mntNs: '4026540003', netNs: NS, cmdline: ['sleep'] })
    ];
    const view = { listProcesses: () => processes, listMounts: () => [], exists: () => false, remove: () => true, kill: () => false, unmount: () => false, selfNamespaces: () => OWN, isPinned: () => false };
    const sandboxRecord = sandboxRecordFor(() => store);
    const spy = (blocker) => {
        const record = sandboxRecord(blocker);
        if (blocker.kind === 'netns') seenSiblings.push((record.siblings ?? []).map((entry) => entry.resourceId));
        return record;
    };
    const walker = createWalker({ view, clock: clock(), releaseDeadlineMs: 50, pollMs: 10, sandboxRecord: spy });
    const result = await recoverGeneration({ state: store, walker });
    const outcome = (id) => result.outcomes.find((entry) => entry.resourceId === id).outcome;
    assert.equal(outcome('T'), 'quarantined');
    assert.equal(outcome('N'), 'quarantined', 'the netns is held by the quarantined tree');
    // the order really is the production one: when the netns was walked, the tree and the endpoint were no longer listed as siblings
    assert.ok(seenSiblings.length > 0 && seenSiblings.every((ids) => !ids.includes('T') && !ids.includes('E')), JSON.stringify(seenSiblings));
});

test('M-48: recoverGeneration in production order: when the tree and endpoint are really gone, every blocker is released', async () => {
    const { recoverGeneration } = await import('../../server/execution/recoveryWalk.mjs');
    const { sandboxRecordFor } = await import('../../server/sandbox/executionSupervisor.mjs');
    const { store, NS } = productionOrder({});
    const processes = [worker(1), worker(21, { ppid: 1 })];
    const view = { listProcesses: () => processes, listMounts: () => [], exists: () => false, remove: () => true, kill: () => true, unmount: () => false, selfNamespaces: () => OWN, isPinned: () => false };
    const walker = createWalker({ view, clock: clock(), releaseDeadlineMs: 50, pollMs: 10, sandboxRecord: sandboxRecordFor(() => store) });
    const result = await recoverGeneration({ state: store, walker });
    assert.deepEqual(result.outcomes.map((entry) => entry.outcome), ['released', 'released', 'released', 'released']);
});

test('M-48: runtime/recovery recoverWorkerGeneration passes the same pre-settle records', async () => {
    const { recoverWorkerGeneration } = await import('../../server/runtime/recovery.mjs');
    const { sandboxRecordFor } = await import('../../server/sandbox/executionSupervisor.mjs');
    const { store, NS } = productionOrder({});
    const processes = [
        worker(1),
        proc(71, { ppid: 1, pidNs: '4026540002', mntNs: '4026540003', netNs: NS, cmdline: ['sleep'] })
    ];
    const view = { listProcesses: () => processes, listMounts: () => [], exists: () => false, remove: () => true, kill: () => false, unmount: () => false, selfNamespaces: () => OWN, isPinned: () => false };
    const walker = createWalker({ view, clock: clock(), releaseDeadlineMs: 50, pollMs: 10, sandboxRecord: sandboxRecordFor(() => store) });
    const result = await recoverWorkerGeneration({ state: store, walker });
    assert.equal(result.outcomes.find((entry) => entry.resourceId === 'N').outcome, 'quarantined');
});
