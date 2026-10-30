import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import test from 'node:test';

import {
    createExecutionSupervisor, createRecoveryView, findMarkerProcesses, findNamespaceMembers, sandboxRecordFor
} from '../../server/sandbox/executionSupervisor.mjs';
import { namesFor } from '../../server/sandbox/executionNetwork.mjs';
import { createWalker } from '../../server/execution/recoveryWalk.mjs';
import { SUPERVISOR_PID, createFakeView } from './helpers/fakes.mjs';

const MARKER = 'rwTestMarker0123456789_a';
const LOCATOR_ID = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';

function fakeSandbox(role, extra = {}) {
    const exitListeners = [];
    const sandbox = {
        role, identity: { pid: 5000, startTime: '50', pidNs: '100', mntNs: '200', netNs: '300', stageMntNs: '201', init: { pid: 5001, startTime: '51' } },
        stdio: [new PassThrough(), new PassThrough(), new PassThrough()], channel: role === 'endpoint' ? new PassThrough() : null,
        commits: 0, aborts: 0, stops: [], releases: 0, verdict: { absent: true, problems: [] }, exited: null,
        gate: { commit: async () => { sandbox.commits += 1; return true; }, abort: async () => { sandbox.aborts += 1; } },
        stop: async ({ graceMs }) => { sandbox.stops.push(graceMs); return sandbox.verdict; },
        release: async () => { sandbox.releases += 1; return sandbox.verdict; },
        onExit: (fn) => exitListeners.push(fn),
        wait: async () => ({ code: 0, signal: null, exitCode: 7 }),
        emitExit: () => { for (const fn of exitListeners) fn({ code: 0, signal: null }); },
        ...extra
    };
    return sandbox;
}

function fakeNetwork() {
    const net_ = {
        setups: 0, releases: 0, verdict: { absent: true, problems: [] }, name: 'rw0123456789abcdef', nsPath: '/run/netns/rw0123456789abcdef',
        hostVeth: 'rw0123456789h', peerVeth: 'rw0123456789n', table: 'rw_0123456789abcdef', subnet: '10.213.0.4/30',
        setup: async () => { net_.setups += 1; }, release: async () => { net_.releases += 1; }, verifyAbsent: async () => net_.verdict, nsInode: () => '4026539999'
    };
    return net_;
}

async function rig({ grants = true, spawnImpl = null, view = createFakeView(), createNetwork = null, hook = null } = {}) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rw-sup-'));
    const homeFd = fs.openSync(dir, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY);
    const launched = [];
    const sandboxes = [];
    const launcher = { launch: async (spec) => { launched.push(spec); if (hook) await hook(spec); const sandbox = fakeSandbox(spec.role); sandboxes.push(sandbox); return sandbox; } };
    const network = fakeNetwork();
    const removed = [];
    view.remove = (kind, locator) => { removed.push([kind, locator]); fs.rmSync(locator.path, { recursive: true, force: true }); return true; };
    const losses = [];
    const supervisor = createExecutionSupervisor({
        launcher, view, createNetwork: createNetwork ?? (() => network), spawnImpl: spawnImpl ?? (() => { throw new Error('no spawn'); }),
        admission: { inventory: [{ name: 'codex' }], streamDirectory: '/stream' },
        roles: {
            orchestration: { roBinds: [{ source: '/usr', dest: '/usr' }], env: {}, argv: ['/usr/local/bin/node', '--import', '/fdTrim.mjs', '/ala.mjs'] },
            endpoint: { roBinds: [{ source: '/usr', dest: '/usr' }], env: {}, argv: ['/usr/local/bin/node', '--import', '/fdTrim.mjs', '/endpoint.mjs'] },
            workload: { roBinds: [{ source: '/usr', dest: '/usr' }] }
        },
        home: { path: dir, fd: homeFd }, grants: grants ? [
            { name: 'a', path: '/projects/a', hostPath: `${dir}/ga`, access: 'write', fd: homeFd }, { name: 'b', path: '/projects/b', hostPath: `${dir}/gb`, access: 'read', fd: homeFd },
            { name: 'c', path: '/projects/c', hostPath: `${dir}/gc`, access: 'write', fd: homeFd }
        ] : [],
        supervisorPid: SUPERVISOR_PID, onInfrastructureLoss: (reason) => losses.push(reason), limits: { stopGraceMs: 123, killWaitMs: 50 }
    });
    const runtimePath = `${dir}/x/${LOCATOR_ID}`;
    await supervisor.create({ kind: 'runtime-dir', resourceId: 'r1', marker: null, locator: { path: runtimePath } });
    return { dir, homeFd, launched, sandboxes, supervisor, network, removed, losses, view, runtimePath, done: () => { fs.closeSync(homeFd); fs.rmSync(dir, { recursive: true, force: true }); } };
}

// A ledger like the real one: create, then commit the identity (not modelled), then the gate.
const fakeLedger = (supervisor) => ({
    async publish({ kind, spec }) {
        const created = await supervisor.create({ kind, resourceId: `res-${Math.random()}`, marker: MARKER, locator: {}, spec });
        if (created.gate && (await created.gate.commit()) !== true) throw new Error('gate');
        return { handle: created.handle, identity: created.identity };
    }
});

function fakeAnchorSpawn(view) {
    const spawned = [];
    const state = { foreign: false };
    const impl = (file, args, options) => {
        const child = new EventEmitter();
        child.pid = 6000 + spawned.length;
        child.stdin = new PassThrough();
        child.kills = [];
        child.kill = (signal) => { child.kills.push(signal); view.drop(child.pid); setImmediate(() => child.emit('exit', null, signal)); return true; };
        view.add({ pid: child.pid, ppid: state.foreign ? 1 : SUPERVISOR_PID, cmdline: ['/bin/sh', '-c', 'script', 'rw-anchor', args.at(-1)] });
        spawned.push({ file, args, options, child });
        return child;
    };
    return { impl, spawned, state };
}

test('anchor: a gated holder carrying the marker as an argv element; commit releases it; exit() kills it and alive turns false', async () => {
    const view = createFakeView();
    const { impl, spawned } = fakeAnchorSpawn(view);
    const world = await rig({ view, spawnImpl: impl });
    try {
        const created = await world.supervisor.create({ kind: 'keeper', resourceId: 'k1', marker: MARKER, locator: {} });
        const [{ file, args, child }] = spawned;
        assert.equal(file, 'setpriv');
        assert.deepEqual(args.slice(0, 3), ['--pdeathsig', 'KILL', '--']);
        assert.ok(args.includes(MARKER));
        assert.deepEqual(created.identity, { pid: child.pid, startTime: String(child.pid * 10) });
        assert.equal(world.supervisor.alive(), true);
        assert.equal(view.registered.length, 1, 'the anchor is killed through its ChildProcess');
        assert.equal(view.registered[0].pid, child.pid);
        assert.equal(await created.gate.commit(), true);
        assert.equal(child.stdin.read().toString(), '1\n');
        await world.supervisor.exit();
        assert.deepEqual(child.kills, ['SIGKILL']);
        assert.equal(world.supervisor.alive(), false);
        assert.deepEqual(world.losses, [], 'ending it ourselves is not an infrastructure loss');
        await new Promise((resolve) => setImmediate(resolve));
        assert.equal(view.registered.length, 0, 'unregistered once it has exited');
    } finally { world.done(); }
});

test('anchor: an uncommitted anchor is aborted by SIGKILL; a committed anchor that dies unexpectedly is an infrastructure loss', async () => {
    const view = createFakeView();
    const { impl, spawned, state } = fakeAnchorSpawn(view);
    const world = await rig({ view, spawnImpl: impl });
    try {
        const first = await world.supervisor.create({ kind: 'keeper', resourceId: 'k1', marker: MARKER, locator: {} });
        await first.gate.abort();
        assert.deepEqual(spawned[0].child.kills, ['SIGKILL']);
        const second = await world.supervisor.create({ kind: 'keeper', resourceId: 'k2', marker: 'rwSecondMarker0123456789', locator: {} });
        await second.gate.commit();
        spawned[1].child.emit('exit', 1, null);
        assert.deepEqual(world.losses, ['anchor_lost']);
        assert.equal(world.supervisor.alive(), false);
        // an anchor that is not our child, or without its marker, is refused
        state.foreign = true;
        await assert.rejects(world.supervisor.create({ kind: 'keeper', resourceId: 'k3', marker: 'rwThirdMarker01234567890', locator: {} }), { code: 'identity_mismatch' });
    } finally { world.done(); }
});

test('runtime dir: private layout and identity; removed through the view (which refuses while a mount lies beneath it)', async () => {
    const world = await rig();
    try {
        for (const name of ['channels', 'stream', 'tmp', 'ctl', 'stage']) assert.equal(fs.statSync(`${world.runtimePath}/${name}`).mode & 0o777, 0o700, name);
        assert.equal(world.supervisor.runtimeDir, world.runtimePath);
        await world.supervisor.removeRuntime();
        assert.deepEqual(world.removed, [['runtime-dir', { path: world.runtimePath }]]);
        assert.ok(!fs.existsSync(world.runtimePath));
        assert.equal(world.supervisor.runtimeDir, null);
        const again = await rig();
        again.view.remove = () => false;
        await assert.rejects(again.supervisor.removeRuntime(), { code: 'setup_failed' });
        again.done();
    } finally { world.done(); }
});

test('netns: the network is built from the netns locator and released with proven absence; veth and nft-table are no-ops', async () => {
    const seen = [];
    const world = await rig({ createNetwork: (options) => { seen.push(options); return world.network; } }).catch(() => null);
    // createNetwork needs the rig's network, so build the rig first with a late-bound factory
    if (world) world.done();
    const late = { network: null };
    const real = await rig({ createNetwork: (options) => { seen.push(options); return late.network; } });
    late.network = real.network;
    try {
        const created = await real.supervisor.create({ kind: 'netns', resourceId: 'n1', marker: null, locator: { netns: LOCATOR_ID } });
        assert.deepEqual(seen.at(-1), { reservationId: LOCATOR_ID });
        assert.deepEqual(created.identity, { netNs: '4026539999', name: 'rw0123456789abcdef', host: 'rw0123456789h', peer: 'rw0123456789n', table: 'rw_0123456789abcdef', subnet: '10.213.0.4/30' });
        assert.equal(real.network.setups, 1);
        assert.deepEqual((await real.supervisor.create({ kind: 'veth', resourceId: 'v', locator: { host: 'h', peer: 'p' } })).gate, null);
        assert.deepEqual((await real.supervisor.create({ kind: 'nft-table', resourceId: 't', locator: { table: 'rw_x' } })).gate, null);
        await real.supervisor.releaseEgress();
        assert.equal(real.network.releases, 1);
        assert.equal(real.supervisor.network, null);
        real.supervisor.create({ kind: 'netns', resourceId: 'n2', locator: { netns: LOCATOR_ID } });
        await new Promise((resolve) => setImmediate(resolve));
        real.network.verdict = { absent: false, problems: ['veth'] };
        await assert.rejects(real.supervisor.releaseEgress(), { code: 'network_setup_failed' });
    } finally { real.done(); }
});

test('endpoint and orchestration share one pair socket pair; the endpoint needs the network; both copies close after the second spawn', async () => {
    const world = await rig();
    try {
        await assert.rejects(world.supervisor.create({ kind: 'endpoint', resourceId: 'e0', marker: MARKER, spec: {} }), { code: 'setup_failed' });
        await world.supervisor.create({ kind: 'netns', resourceId: 'n1', locator: { netns: LOCATOR_ID } });
        const endpoint = await world.supervisor.create({ kind: 'endpoint', resourceId: 'e1', marker: MARKER, spec: { config: { streamDirectory: '/stream', relays: [] } } });
        const spec = world.launched[0];
        assert.equal(spec.role, 'endpoint');
        assert.equal(spec.netns, '/run/netns/rw0123456789abcdef');
        assert.equal(spec.netnsInode, '4026539999');
        assert.equal(spec.argv.at(-1), JSON.stringify({ streamDirectory: '/stream', relays: [] }));
        assert.deepEqual(spec.binds.map((bind) => [bind.source, bind.dest, bind.mode]), [
            [`${world.runtimePath}/stream`, '/stream', 'rw'], [`${world.runtimePath}/channels`, '/run/robo-work/channels', 'rw']]);
        assert.ok(!('fdBinds' in spec), 'no inherited directory descriptors');
        assert.equal(spec.roleFds[4], 'pipe');
        assert.ok(spec.roleFds[3] instanceof net.Socket);
        assert.equal(world.supervisor.endpointSocket, world.sandboxes[0].channel);
        assert.ok(!fs.existsSync(`${world.runtimePath}/pair.sock`), 'the rendezvous path is unlinked');
        const client = spec.roleFds[3];
        assert.equal(client.destroyed, false, 'the client copy is still needed until ALA has spawned');
        const orchestration = await world.supervisor.create({ kind: 'process-tree', resourceId: 'o1', marker: 'rwOrchMarker012345678901', spec: { role: 'orchestration' } });
        const ala = world.launched[1];
        assert.equal(ala.role, 'orchestration');
        assert.ok(ala.roleFds[3] instanceof net.Socket && ala.roleFds[3] !== client);
        assert.deepEqual(ala.stdio, ['pipe', 'pipe', 'pipe']);
        assert.equal(world.supervisor.controlStreams.stdin, world.sandboxes[1].stdio[0]);
        assert.equal(client.destroyed, true);
        assert.equal(ala.roleFds[3].destroyed, true);
        assert.equal(typeof endpoint.gate.commit, 'function');
        assert.equal(orchestration.handle, world.sandboxes[1]);
    } finally { world.done(); }
});

test('the pair really connects the two ends (client and accepted are one connection)', async () => {
    let client = null;
    let received = null;
    const world = await rig({
        hook: async (spec) => {
            if (spec.role === 'endpoint') client = spec.roleFds[3];
            if (spec.role === 'orchestration') {
                const accepted = spec.roleFds[3];
                received = new Promise((resolve) => accepted.once('data', resolve));
                accepted.resume();
                client.write('ping');
                await received;
            }
        }
    });
    try {
        await world.supervisor.create({ kind: 'netns', resourceId: 'n1', locator: { netns: LOCATOR_ID } });
        await world.supervisor.create({ kind: 'endpoint', resourceId: 'e1', marker: MARKER, spec: {} });
        await world.supervisor.create({ kind: 'process-tree', resourceId: 'o1', marker: 'rwOrchMarker012345678901', spec: { role: 'orchestration' } });
        assert.equal((await received).toString(), 'ping');
    } finally { world.done(); }
});

async function streamServers(world, names) {
    const servers = [];
    const connections = {};
    for (const name of names) {
        const server = net.createServer((socket) => { connections[name] = socket; });
        await new Promise((resolve) => server.listen(`${world.runtimePath}/stream/${name}`, resolve));
        servers.push(server);
    }
    return { connections, close: () => servers.forEach((server) => server.close()) };
}

const request = (extra = {}) => ({
    processClass: 'run', executable: 'codex', args: ['exec', '--json'], env: { IS_SANDBOX: '1' }, home: '/home/robot', cwd: '/projects/a/src',
    folders: [{ path: '/projects/a', access: 'write' }, { path: '/projects/b', access: 'write' }], exclusions: [], network: 'robot-egress',
    requirements: { privateProc: true }, communication: { kind: 'stdio', stdin: 'pipe' }, ...extra
});

test('workload: spec from the admitted request, grants by folder with the narrower access, streams connected to the endpoint stream dir', async () => {
    const world = await rig();
    try {
        await world.supervisor.create({ kind: 'netns', resourceId: 'n1', locator: { netns: LOCATOR_ID } });
        const servers = await streamServers(world, ['stdinaaaa', 'stdoutbbbb', 'stderrcccc']);
        const sandbox = world.supervisor.providerSandbox(fakeLedger(world.supervisor));
        await sandbox.start({
            process: 1, request: request(), streams: { stdin: '/stream/stdinaaaa', stdout: '/stream/stdoutbbbb', stderr: '/stream/stderrcccc' }
        });
        const spec = world.launched.at(-1);
        assert.equal(spec.role, 'workload');
        assert.equal(spec.netMode, 'join');
        assert.equal(spec.netns, '/run/netns/rw0123456789abcdef');
        assert.deepEqual(spec.argv, ['codex', 'exec', '--json']);
        assert.equal(spec.cwd, '/projects/a/src');
        assert.deepEqual(spec.env, { HOME: '/home/robot', PATH: '/usr/local/bin:/usr/bin:/bin', TMPDIR: '/tmp', IS_SANDBOX: '1' });
        // a: write grant + write folder -> rw; b: read grant, write folder -> ro (the narrower); c: untouched -> absent
        assert.deepEqual(spec.grants.map((grant) => [grant.name, grant.path, grant.mode]), [['a', `${world.dir}/ga`, 'rw'], ['b', `${world.dir}/gb`, 'ro']]);
        assert.equal(spec.channelsDir, `${world.runtimePath}/channels`);
        assert.equal(spec.tmpDir, `${world.runtimePath}/tmp`);
        assert.deepEqual(spec.home, { path: world.dir, fd: world.homeFd });
        assert.ok(spec.stdio.every((entry) => entry instanceof net.Socket));
        await new Promise((resolve) => setTimeout(resolve, 20));
        assert.ok(spec.stdio.every((socket) => socket.destroyed), 'the supervisor closes its copies after the spawn');
        assert.equal(Object.keys(servers.connections).length, 3, 'each stream path was connected');
        servers.close();
    } finally { world.done(); }
});

test('workload: network none runs without the execution netns; a stream path outside the endpoint dir is refused; stdin ignore leaves slot 0 closed', async () => {
    const world = await rig();
    try {
        const sandbox = world.supervisor.providerSandbox(fakeLedger(world.supervisor));
        const servers = await streamServers(world, ['stdoutbbbb', 'stderrcccc']);
        await sandbox.start({ process: 1, request: request({ network: 'none', communication: { kind: 'stdio', stdin: 'ignore' } }), streams: { stdout: '/stream/stdoutbbbb', stderr: '/stream/stderrcccc' } });
        const spec = world.launched.at(-1);
        assert.equal(spec.netMode, 'none');
        assert.ok(!('netns' in spec) && !('netnsInode' in spec), 'no execution netns is named for network none (the init is in its own)');
        assert.equal(spec.stdio[0], 'ignore');
        await assert.rejects(sandbox.start({ process: 2, request: request({ network: 'none' }), streams: { stdin: '/etc/passwd', stdout: '/stream/stdoutbbbb', stderr: '/stream/stderrcccc' } }), { code: 'invalid_request' });
        await assert.rejects(sandbox.start({ process: 3, request: request(), streams: { stdin: '/stream/aaaaaaaa', stdout: '/stream/stdoutbbbb', stderr: '/stream/stderrcccc' } }), { code: 'setup_failed' });
        servers.close();
    } finally { world.done(); }
});

test('exit handler gets the exit code; stop is delegated with the grace and fails when absence is not proven; unknown process refused; tempdir shared', async () => {
    const world = await rig();
    try {
        const servers = await streamServers(world, ['stdoutbbbb', 'stderrcccc']);
        const exits = [];
        const sandbox = world.supervisor.providerSandbox(fakeLedger(world.supervisor));
        sandbox.setExitHandler((...args) => exits.push(args));
        await sandbox.start({ process: 4, request: request({ network: 'none', communication: { kind: 'stdio', stdin: 'ignore' } }), streams: { stdout: '/stream/stdoutbbbb', stderr: '/stream/stderrcccc' } });
        const tree = world.sandboxes.at(-1);
        tree.emitExit();
        await new Promise((resolve) => setImmediate(resolve));
        assert.deepEqual(exits, [[4, 7, null]]);
        await sandbox.stop({ process: 4, graceMs: 900 });
        assert.deepEqual(tree.stops, [900]);
        tree.verdict = { absent: false, problems: ['namespace_held'] };
        await assert.rejects(sandbox.stop({ process: 4, graceMs: 1 }), { code: 'setup_failed' });
        await assert.rejects(sandbox.stop({ process: 99, graceMs: 1 }), { code: 'invalid_request' });
        assert.deepEqual(await sandbox.inventory(), [{ name: 'codex' }]);
        const path1 = await sandbox.tempdir();
        const path2 = await sandbox.tempdir();
        assert.match(path1, /^\/tmp\/ala-[0-9a-f]{16}$/);
        assert.notEqual(path1, path2);
        assert.ok(fs.statSync(`${world.runtimePath}/tmp/${path1.slice(5)}`).isDirectory());
        servers.close();
    } finally { world.done(); }
});

test('end path: uncommitted creations are aborted, trees stopped with the grace, a tree that cannot be proven gone fails the step, views released', async () => {
    const world = await rig();
    try {
        await world.supervisor.create({ kind: 'netns', resourceId: 'n1', locator: { netns: LOCATOR_ID } });
        await world.supervisor.create({ kind: 'endpoint', resourceId: 'e1', marker: MARKER, spec: {} });
        const orchestration = await world.supervisor.create({ kind: 'process-tree', resourceId: 'o1', marker: 'rwOrchMarker012345678901', spec: { role: 'orchestration' } });
        const [endpoint, ala] = world.sandboxes;
        await world.supervisor.abortUncommitted(['o1', 'unknown']);
        assert.equal(ala.aborts, 1);
        await world.supervisor.abortUncommitted(['o1']);
        assert.equal(ala.aborts, 1, 'an abort is not repeated');
        await orchestration.gate.commit();
        await world.supervisor.endProcessTrees();
        assert.deepEqual(ala.stops, [123]);
        assert.deepEqual(endpoint.stops, [], 'the endpoint is a later step');
        await world.supervisor.endEndpoint();
        assert.deepEqual(endpoint.stops, [123]);
        ala.verdict = { absent: false, problems: ['init_present'] };
        await assert.rejects(world.supervisor.endProcessTrees(), { code: 'setup_failed' });
        await world.supervisor.releaseViews();
        assert.equal(ala.releases, 1);
        assert.equal(endpoint.releases, 1);
    } finally { world.done(); }
});

test('recovery helpers: the anchor record by locator, marker-bearing processes, and recorded namespace members', () => {
    const asked = [];
    const record = sandboxRecordFor(() => ({ getResource: (request) => { asked.push(request); return { identity: null, locator: { marker: MARKER } }; } }));
    assert.deepEqual(record({ locator: { keeper: 'K1' } }).locator, { marker: MARKER });
    assert.deepEqual(asked, [{ resourceId: 'K1' }]);
    const view = createFakeView();
    view.add({ pid: 1, cmdline: ['setpriv', '--', 'sh', 'stage.sh', 'prep', MARKER, '4000'] });
    view.add({ pid: 2, cmdline: ['/usr/bin/bwrap', '--hostname', MARKER] });
    view.add({ pid: 3, cmdline: ['node', `${MARKER}-longer`] });
    view.add({ pid: 4, pidNs: '100' });
    view.add({ pid: 5, mntNs: '201' });
    view.add({ pid: 6, fdNs: ['300'] });
    view.add({ pid: 7 });
    assert.deepEqual(findMarkerProcesses(view, MARKER).map((entry) => entry.pid), [1, 2]);
    assert.deepEqual(findNamespaceMembers(view, { pidNs: '100', mntNs: '200', stageMntNs: '201', netNs: '300' }).map((entry) => entry.pid), [4, 5, 6]);
});

test('recovery view: veth and nft are asked of ip and nft, never assumed present; removing a netns removes firewall, veth and netns by locator-derived names', () => {
    const calls = [];
    let links = '1: lo: <>\n9: rw1111111111h@if8: <UP>\n';
    let tables = 'table inet rw_aaaaaaaaaaaaaaaa\n';
    let nsFile = true;
    const runSync = (command, args) => {
        calls.push([command, ...args].join(' '));
        if (args.join(' ') === '-o link show') return { status: 0, stdout: links, stderr: '' };
        if (args.join(' ') === 'list tables') return { status: 0, stdout: tables, stderr: '' };
        if (args[0] === 'link' && args[1] === 'del') links = '1: lo: <>\n';
        if (args[0] === 'delete') tables = '';
        if (args[0] === 'netns') nsFile = false;
        return { status: 0, stdout: '', stderr: '' };
    };
    const base = { exists: () => 'base', remove: () => 'base-remove', cgroupSubtree: null };
    const view = createRecoveryView(base, { runSync, exists: () => nsFile });
    assert.equal(view.exists('veth', { host: 'rw1111111111h', peer: 'rw1111111111n' }), true);
    assert.equal(view.exists('veth', { host: 'rw2222222222h', peer: 'rw2222222222n' }), false);
    assert.equal(view.exists('nft-table', { table: 'rw_aaaaaaaaaaaaaaaa' }), true);
    assert.equal(view.exists('nft-table', { table: 'rw_bbbbbbbbbbbbbbbb' }), false);
    assert.equal(view.exists('runtime-dir', {}), 'base');
    assert.equal(view.remove('veth', { host: 'rw1111111111h', peer: 'rw1111111111n' }), true);
    assert.equal(view.remove('runtime-dir', {}), 'base-remove');
    const names = namesFor(LOCATOR_ID);
    links = `9: ${names.host}@if8: <UP>\n`;
    tables = `table inet ${names.table}\n`;
    nsFile = true;
    calls.length = 0;
    assert.equal(view.remove('netns', { netns: LOCATOR_ID }), true);
    assert.deepEqual(calls.filter((call) => /delete|link del|netns del/.test(call)), [`nft delete table inet ${names.table}`, `ip link del ${names.host}`, `ip netns del ${names.netns}`]);
    const stubborn = createRecoveryView(base, { runSync: (command, args) => ({ status: 0, stdout: args.join(' ') === 'list tables' ? `table inet ${names.table}\n` : '', stderr: '' }), exists: () => false });
    assert.equal(stubborn.remove('netns', { netns: LOCATOR_ID }), false, 'a table that is still listed is not a removal');
    assert.equal(view.remove('netns', {}), false);
    // the walker accepts the wrapped view and releases a leftover netns found only by its locator
    const walker = createWalker({
        view: { ...view, listProcesses: () => [], listMounts: () => [] }, clock: { now: () => 0, sleep: async () => {} }, releaseDeadlineMs: 10, pollMs: 1, sandboxRecord: () => null
    });
    return walker.attempt({ kind: 'netns', identity: { netNs: '1' }, locator: { netns: LOCATOR_ID } }).then((outcome) => assert.equal(outcome, 'released'));
});
