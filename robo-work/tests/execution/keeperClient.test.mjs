import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';

import { createExecutionKeeper } from '../../server/execution/keeperClient.mjs';
import { resourceHandle } from '../../server/execution/keeperFrames.mjs';
import { createProcView } from '../../server/execution/procView.mjs';
import { deriveLocator } from '../../server/execution/resourceLocators.mjs';
import { createFakeKeeperHost, createFakeWorld, parseKeeperArgv } from './helpers/fakeKeeperProcess.mjs';

// CONFORMANCE of the production keeper client (keeper wire contract delta sections 2 to 6, R1) against a FAKE keeper: a
// real child process whose behaviour runs in this test process, judged through the production procView over a fake
// /proc. Unit evidence only, never G1: no namespace, pty or mount exists here.

// PROVISIONAL test limits: small deadlines so that the bounds are exercised quickly. Not G5 values.
const TEST_LIMITS = Object.freeze({
    requestDeadlineMs: 600, createDeadlineMs: 800, helloDeadlineMs: 5000, keeperExitWaitMs: 200, pingIntervalMs: 100,
    partialFrameDeadlineMs: 300, ptyInputStallMs: 400
});
const TEST_VIEW_LIMITS = Object.freeze({ rootLeaseRenewMs: 50, rootLeaseTtlMs: 600, rootRevokeGraceMs: 100, rootRevokeVerifyMs: 100 });
const newId = () => crypto.randomBytes(16).toString('base64url');
const dashId = () => { const bytes = crypto.randomBytes(16); bytes[0] = 0xf8 | (bytes[0] & 0x03); return bytes.toString('base64url'); };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor(condition, timeoutMs = 3000) {
    const until = Date.now() + timeoutMs;
    while (Date.now() < until) { if (condition()) return true; await sleep(10); }
    return condition();
}
const within = (promise, ms, label) => Promise.race([promise, sleep(ms).then(() => { throw new Error(`${label}: not settled within ${ms} ms`); })]);

async function setup(t, { host: hostOptions = {}, limits = {}, viewLimits = {}, grants = 0, home = false, ala = false, scope = 'execution', marker = newId(), commit = true, delegated = true, statfs, verifyGrant = async () => ({ state: 'bound' }) } = {}) {
    const world = createFakeWorld(t);
    const host = await createFakeKeeperHost(t, world, hostOptions);
    const view = createProcView({ procRoot: world.procRoot, signal: world.signal, runtimeRoot: world.runtimeRoot, cgroupSubtree: delegated ? world.cgroupSubtree : null, statfs: statfs ?? world.statfs, containerDevpts: '/dev' });
    const grantRoots = Array.from({ length: grants }, (_, index) => world.openDir(t, `grant${index}`));
    const homeRoot = home ? world.openDir(t, 'home') : null;
    const losses = [];
    const stalls = [];
    const quarantined = [];
    const client = createExecutionKeeper({
        executable: host.executable, scope, runtimeRoot: world.runtimeRoot, cgroupSubtree: delegated ? world.cgroupSubtree : null, ala,
        grantRoots: grantRoots.map(({ fd, identity }) => ({ fd, identity })), home: homeRoot ? { fd: homeRoot.fd, identity: homeRoot.identity } : null,
        limits: { ...TEST_LIMITS, ...limits }, viewLimits: { ...TEST_VIEW_LIMITS, ...viewLimits }, view,
        verifyGrant,
        onInfrastructureLoss: (reason) => losses.push(reason), onPtyInputStalled: (handle) => stalls.push(handle)
    });
    const rig = { world, host, view, client, losses, stalls, quarantined, grantRoots, homeRoot, marker };
    rig.keeperCreate = () => client.create({ kind: 'keeper', resourceId: marker, marker, locator: { role: 'keeper', id: '0'.repeat(32), marker } });
    if (commit) {
        const made = await rig.keeperCreate();
        rig.keeperIdentity = made.identity;
        assert.equal(await made.gate.commit(), true);
        rig.keeper = host.latest();
    }
    rig.locator = (kind, resourceMarker = null) => ({
        ...deriveLocator(kind, crypto.randomBytes(16).toString('hex'), { runtimeDir: world.runtimeRoot, cgroupSubtree: world.cgroupSubtree }),
        keeper: marker, ...(resourceMarker ? { marker: resourceMarker } : {})
    });
    // One create through the client, optionally committed.
    rig.make = async (kind, spec = {}, { commit: doCommit = true } = {}) => {
        const resourceId = newId();
        const processBearing = kind === 'endpoint' || kind === 'process-tree';
        const created = await client.create({ kind, resourceId, marker: processBearing ? resourceId : null, locator: rig.locator(kind, processBearing ? resourceId : null), spec });
        if (doCommit) assert.equal(await created.gate.commit(), true, `${kind} commit`);
        return { ...created, resourceId };
    };
    rig.mount = async () => {
        await rig.make('runtime-dir');
        const resourceId = newId();
        const created = await client.create({
            kind: 'mount', resourceId, marker: null, locator: { mount: crypto.randomBytes(16).toString('hex'), keeper: marker },
            spec: { grantId: 'proj', rootSlot: 8, expectedRootIdentity: grantRoots[0].identity, access: 'write', descriptorCap: 1024, rlimitNofile: 4096 }
        });
        assert.equal(await created.gate.commit(), true);
        const stop = client.startLeaseLoop(resourceId, { quarantineView: (id) => quarantined.push(id) });
        t.after(stop);
        return { ...created, resourceId, stop };
    };
    t.after(() => { try { rig.host.latest()?.kill(); } catch { /* gone */ } });
    return rig;
}

const framesOf = (keeper, op, kind = null) => keeper.frames.filter((entry) => entry.frame.op === op && (kind === null || entry.frame.kind === kind)).map((entry) => entry.frame);

test('argv carries the bound cgroup subtree', async (t) => {
    const rig = await setup(t);
    const bound = rig.view.cgroupSubtreeIdentity();
    assert.deepEqual(rig.keeper.parsed.cgroupSubtree, bound);
    const at = rig.keeper.argv.indexOf('--cgroup-subtree');
    assert.equal(rig.keeper.argv[at + 1], `${bound.dev}:${bound.ino}:${bound.path}`);
    const undelegated = await setup(t, { delegated: false });
    assert.equal(undelegated.keeper.argv.includes('--cgroup-subtree'), false);
    assert.equal(undelegated.keeper.parsed.cgroupSubtree, null);
});

test('an invalid subtree is refused before spawn', async (t) => {
    for (const statfs of [() => ({ type: 0 }), () => { throw new Error('statfs failed'); }]) {
        const rig = await setup(t, { statfs, commit: false });
        await assert.rejects(rig.keeperCreate(), (error) => error.code === 'cgroup_subtree_invalid');
        assert.equal(rig.client.stats().spawned, false);
        assert.equal(rig.host.latest(), null, 'fake spawn log remains empty');
        assert.equal(rig.host.log.keepers.length, 0);
    }
});

test('fake keeper rejects malformed or repeated subtree flags', () => {
    assert.deepEqual(parseKeeperArgv(['serve', '--cgroup-subtree', '1:2:/a:b']).cgroupSubtree, { dev: '1', ino: '2', path: '/a:b' });
    for (const argv of [
        ['--cgroup-subtree', '1:2:/a', '--cgroup-subtree', '1:2:/a'], ['--cgroup-subtree=1:2:/a', 'ignored'],
        ['--cgroup-subtree', '1:2:/a/'], ['--cgroup-subtree', '18446744073709551616:2:/a'],
        ['--cgroup-subtree', '1:18446744073709551616:/a'], ['--cgroup-subtree', `1:2:/${'a'.repeat(1023)}`],
        ['--cgroup-subtree', `1:2:/${'a'.repeat(1024)}`]
    ]) assert.throws(() => parseKeeperArgv(['serve', ...argv]));
});

test('an unmounted grant refuses leases and releases admission for the next lease', async (t) => {
    const rig = await setup(t, { grants: 1 });
    const mount = await rig.mount();
    mount.stop();
    await rig.client.unmountView(mount.resourceId);
    for (const epoch of [2, 3]) {
        const reply = await rig.client.requestRaw({ op: 'view_root_lease', grantId: 'proj', epoch, verdict: 'renew', ttlMs: 600 });
        assert.equal(reply.kind, 'refused');
        assert.equal(reply.error, 'wrong_grant');
    }
    assert.deepEqual(rig.keeper.violations, []);
});

test('eight grants renew beside four held mounts within the sixteen-request channel cap', async (t) => {
    const rig = await setup(t, { grants: 8, limits: { requestDeadlineMs: 3000, pingIntervalMs: 60000 }, host: {
        onRequest: (frame) => ['unmount_view', 'view_root_lease', 'inventory'].includes(frame.op) ? 'hold' : undefined
    } });
    await rig.make('runtime-dir');
    for (let index = 0; index < 8; index += 1) {
        const created = await rig.client.create({ kind: 'mount', resourceId: newId(), spec: {
            grantId: `g${index}`, rootSlot: 8 + index, expectedRootIdentity: rig.grantRoots[index].identity,
            access: 'write', descriptorCap: 1024, rlimitNofile: 4096
        } });
        assert.equal(await created.gate.commit(), true);
    }
    const pending = [1, 2, 3, 4].map((n) => rig.client.requestRaw({ op: 'unmount_view', resource: `m${n.toString(16).padStart(32, '0')}` }));
    for (let index = 0; index < 8; index += 1) pending.push(rig.client.requestRaw({ op: 'view_root_lease', grantId: `g${index}`, epoch: 2, verdict: 'renew', ttlMs: 600 }));
    for (let index = 0; index < 4; index += 1) pending.push(rig.client.inventory());
    pending.forEach((promise) => promise.catch(() => {}));
    assert.equal(await waitFor(() => rig.keeper.held.size === 16), true);
    assert.equal(framesOf(rig.keeper, 'view_root_lease').length, 8, 'all grants renew with four mount slots held');
    assert.equal(new Set(framesOf(rig.keeper, 'view_root_lease').map((frame) => frame.grantId)).size, 8);
    assert.equal(rig.client.stats().inFlight.mount, 4);
    assert.equal(rig.client.stats().peaks.total, 16);
    const extra = rig.client.requestRaw({ op: 'view_root_lease', grantId: 'g0', epoch: 3, verdict: 'renew', ttlMs: 600 });
    extra.catch(() => {});
    assert.equal(rig.client.stats().queued, 1);
    rig.host.options.onRequest = undefined;
    rig.keeper.releaseAll();
    await Promise.all([...pending, extra]);
    assert.equal(rig.keeper.maxOrdinaryInFlight, 16);
    assert.deepEqual(rig.keeper.violations, []);
});

test('client and procView cgroup configuration must match before construction', (t) => {
    const world = createFakeWorld(t);
    const view = createProcView({ procRoot: world.procRoot, signal: world.signal, cgroupSubtree: world.cgroupSubtree, statfs: world.statfs });
    for (const cgroupSubtree of [null, `${world.cgroupSubtree}-other`]) {
        assert.throws(() => createExecutionKeeper({ scope: 'execution', runtimeRoot: world.runtimeRoot, view, cgroupSubtree }), /cgroup_subtree_mismatch/u);
    }
    assert.doesNotThrow(() => createExecutionKeeper({ scope: 'execution', runtimeRoot: world.runtimeRoot, view, cgroupSubtree: world.cgroupSubtree }));
});

test('a subtree replaced after spawn fails create verification', async (t) => {
    const rig = await setup(t);
    fs.renameSync(rig.world.cgroupSubtree, `${rig.world.cgroupSubtree}-old`);
    fs.mkdirSync(rig.world.cgroupSubtree);
    await assert.rejects(rig.make('cgroup'), (error) => error.code === 'identity_mismatch');
    assert.equal(framesOf(rig.keeper, 'abort_uncommitted').length, 1);
    assert.equal(framesOf(rig.keeper, 'commit').length, 0);
});

test('a second lease loop for one view is refused', async (t) => {
    const rig = await setup(t, { grants: 1 });
    const mount = await rig.mount();
    assert.throws(() => rig.client.startLeaseLoop(mount.resourceId, {}), (error) => error.code === 'lease_loop_exists');
});

test('stopping and restarting a lease loop holds the second renewal until the first settles', async (t) => {
    const rig = await setup(t, { grants: 1, limits: { requestDeadlineMs: 2000 }, host: { onRequest: (frame) => frame.op === 'view_root_lease' ? 'hold' : undefined } });
    const mount = await rig.mount();
    assert.equal(await waitFor(() => framesOf(rig.keeper, 'view_root_lease').length === 1), true);
    mount.stop();
    const stop = rig.client.startLeaseLoop(mount.resourceId, {});
    t.after(stop);
    assert.equal(await waitFor(() => rig.client.stats().queued === 1), true, 'restarted loop queues behind outstanding lease');
    assert.equal(framesOf(rig.keeper, 'view_root_lease').length, 1, 'never sends two outstanding leases for one grant');
    rig.keeper.release(framesOf(rig.keeper, 'view_root_lease')[0].id);
    assert.equal(await waitFor(() => framesOf(rig.keeper, 'view_root_lease').length === 2), true);
    stop();
    rig.keeper.releaseAll();
    assert.deepEqual(rig.keeper.violations, []);
});

test('a stopped lease loop drops a tick whose issuer is still awaiting verification', async (t) => {
    let release;
    let calls = 0;
    const rig = await setup(t, { grants: 1, verifyGrant: async () => {
        calls += 1;
        if (calls === 1) return { state: 'bound' };
        return new Promise((resolve) => { release = () => resolve({ state: 'bound' }); });
    } });
    const mount = await rig.mount();
    assert.equal(await waitFor(() => release !== undefined), true);
    mount.stop();
    release();
    await sleep(100);
    assert.equal(framesOf(rig.keeper, 'view_root_lease').length, 0);
});

test('stop on created and aborted stages refuses without an exit; an already exited gate wins', async (t) => {
    const rig = await setup(t);
    const exits = [];
    rig.client.onExit((...args) => exits.push(args));
    const make = () => rig.make('process-tree', { role: 'orchestration', script: '/opt/o/main.mjs', args: [], env: {}, netns: null }, { commit: false });
    const created = await make();
    const stop = () => rig.client.requestRaw({ op: 'stop', resource: created.handle, graceMs: 0 });
    for (let n = 0; n < 2; n += 1) {
        const result = await stop();
        assert.equal(result.kind, 'refused');
        assert.equal(result.error, 'resource_not_committed');
        assert.equal(rig.world.exists(created.identity.pid), true);
    }
    assert.equal(await created.gate.abort(), true);
    const aborted = await stop();
    assert.equal(aborted.error, 'resource_not_committed');
    assert.equal(rig.keeper.handles.get(created.handle).aborted, true);
    assert.deepEqual(exits, []);
    assert.deepEqual(rig.world.signals, []);
    const gone = await make();
    rig.world.removeProcess(gone.identity.pid);
    assert.equal((await rig.client.requestRaw({ op: 'stop', resource: gone.handle, graceMs: 0 })).value.state, 'exited');
    assert.equal(rig.client.alive(), true);
});

test('repeated abort of a tombstone preserves a newer namespace using the same descriptor', async (t) => {
    const rig = await setup(t);
    const original = await rig.make('netns', {}, { commit: false });
    const oldEntry = rig.keeper.handles.get(original.handle);
    assert.equal(await original.gate.abort(), true);
    const newer = await rig.make('netns');
    const newEntry = rig.keeper.handles.get(newer.handle);
    assert.equal(newEntry.fd, oldEntry.fd, 'the fake descriptor is reused');
    assert.equal(newEntry.committed, true);
    assert.ok(rig.view.heldNamespaces(rig.keeper.pid).fdNs.includes(newer.identity.netNs));
    assert.equal(await original.gate.abort(), true);
    assert.ok(rig.view.heldNamespaces(rig.keeper.pid).fdNs.includes(newer.identity.netNs), 'repeat abort cannot close the newer resource');
    assert.equal(oldEntry.aborted, true);
    assert.equal(newEntry.committed, true);
});

// ---- spawn, hello, layout ---------------------------------------------------------------------------------------------

test('spawn: hello is verified through procView, commit_keeper is the first frame, and a periodic ping runs with the normal deadline', async (t) => {
    const rig = await setup(t);
    assert.equal(rig.client.alive(), true);
    assert.equal(rig.keeper.frames[0].frame.op, 'commit_keeper');
    assert.deepEqual(rig.keeperIdentity, { pid: rig.keeper.pid, startTime: rig.keeper.startTime });
    assert.equal(await waitFor(() => framesOf(rig.keeper, 'ping').length >= 3, 3000), true, 'pings are sent');
    assert.deepEqual(rig.losses, []);
    assert.deepEqual(rig.keeper.violations, []);
});

test('ping: an idle keeper that stops answering is detected within pingIntervalMs + requestDeadlineMs (N-B)', async (t) => {
    let silent = false;
    const rig = await setup(t, { host: { onRequest: (frame) => (silent && frame.op === 'ping' ? 'ignore' : undefined) } });
    await rig.make('runtime-dir');
    await rig.make('pty', { cols: 80, rows: 24 });
    const started = Date.now();
    silent = true;
    assert.equal(await waitFor(() => rig.losses.length > 0, 3000), true);
    assert.deepEqual(rig.losses, ['keeper_timeout:ping']);
    assert.ok(Date.now() - started <= TEST_LIMITS.pingIntervalMs + TEST_LIMITS.requestDeadlineMs + 300, `detected after ${Date.now() - started} ms`);
    assert.equal(rig.client.alive(), false);
});

test('argv: --reservation is followed by the exact resource id as its own element, and the descriptor layout matches section 3', async (t) => {
    for (const { ala, grants, home } of [
        { ala: false, grants: 0, home: false }, { ala: true, grants: 0, home: true }, { ala: false, grants: 2, home: true }, { ala: true, grants: 2, home: false }
    ]) {
        await t.test(`ala ${ala ? 1 : 0}, g = ${grants}, home ${home ? 'on' : 'off'}`, async (sub) => {
            const marker = dashId();
            assert.equal(marker[0], '-');
            const rig = await setup(sub, { ala, grants, home, marker });
            const argv = rig.keeper.argv;
            const at = argv.indexOf('--reservation');
            assert.ok(at > 0 && argv[at + 1] === marker, 'the marker follows --reservation unchanged');
            assert.ok(!argv.some((value) => value.startsWith('--reservation=')));
            assert.equal(rig.keeper.parsed.parentPid, process.pid);
            assert.equal(rig.keeper.parsed.grantRoots, grants);
            assert.deepEqual(rig.keeper.unknownChannelLimits, [], 'only contract channel limits are passed (RK-1)');
            assert.equal(Object.hasOwn(rig.keeper.parsed.channelLimits, 'pingIntervalMs'), false, 'pingIntervalMs is client-only');
            assert.equal(Object.keys(rig.keeper.parsed.channelLimits).length, 19);
            // The spawn passes an empty environment. The interpreters add their own (Python's locale coercion sets
            // LC_CTYPE, Darwin's CoreFoundation __CF_USER_TEXT_ENCODING); nothing of the supervisor's may arrive.
            const inherited = rig.keeper.layout.environ.filter((name) => !['LC_CTYPE', '__CF_USER_TEXT_ENCODING'].includes(name));
            assert.deepEqual(inherited, [], 'the keeper inherits no environment from the supervisor');
            assert.ok(Object.keys(process.env).length > 2, 'the supervisor does have an environment to leak');
            const fds = new Map(rig.keeper.layout.fds.map((entry) => [entry.fd, entry]));
            const expected = [[0, 'char'], [1, 'char'], [2, 'socket'], [3, 'socket']];
            for (let fd = 4; fd < 8; fd += 1) if (ala) expected.push([fd, 'socket']);
            rig.grantRoots.forEach((_, index) => expected.push([8 + index, 'dir']));
            if (home) expected.push([8 + grants, 'dir']);
            assert.deepEqual([...fds.values()].map((entry) => [entry.fd, entry.type]), expected, 'exactly the declared descriptors, nothing else');
            rig.grantRoots.forEach((root, index) => assert.equal(fds.get(8 + index).ino, root.identity.ino, `grant root ${index} at slot ${8 + index}`));
            if (home) {
                assert.equal(fds.get(8 + grants).ino, rig.homeRoot.identity.ino, 'HOME after the grant roots');
                assert.equal(rig.keeper.parsed.homeIdentity, `${rig.homeRoot.identity.dev}:${rig.homeRoot.identity.ino}`);
            }
            assert.equal(rig.client.endpointSocket !== null, ala);
        });
    }
});

test('thread: creating the keeper inside a worker thread rejects keeper_spawn_thread', async () => {
    const module = new URL('../../server/execution/keeperClient.mjs', import.meta.url).href;
    const source = `
        import { parentPort } from 'node:worker_threads';
        const { createExecutionKeeper } = await import(${JSON.stringify(module)});
        const view = { cgroupSubtree: null, process: () => null, registerKeeperChild: () => () => {}, selfNamespaces: () => ({ pidNs: '1' }) };
        const client = createExecutionKeeper({ executable: '/nonexistent/keeper', scope: 'execution', runtimeRoot: '/run/x', view });
        const id = 'AAECAwQFBgcICQoLDA0ODw';
        try { await client.create({ kind: 'keeper', resourceId: id, marker: id, locator: {} }); parentPort.postMessage('resolved'); }
        catch (error) { parentPort.postMessage(error.code); }`;
    const worker = new Worker(source, { eval: true, type: 'module' });
    const answer = await new Promise((resolve, reject) => { worker.once('message', resolve); worker.once('error', reject); });
    await worker.terminate();
    assert.equal(answer, 'keeper_spawn_thread');
});

test('hello: a wrong version, wrong limits, wrong marker or a pid that is not the child aborts the keeper before commit', async (t) => {
    const cases = [
        ['keeper_version_mismatch', (hello) => ({ ...hello, version: 2 })],
        ['keeper_version_mismatch', (hello) => ({ ...hello, protocol: 'other' })],
        ['keeper_limits_mismatch', (hello) => ({ ...hello, limits: { ...hello.limits, maxInFlight: 17 } })],
        ['keeper_limits_mismatch', (hello) => { const { ptyInputWindowFrames, ...rest } = hello.limits; return { ...hello, limits: rest }; }],
        ['keeper_limits_mismatch', (hello) => ({ ...hello, limits: { ...hello.limits, pingIntervalMs: 100 } })],
        ['identity_mismatch', (hello) => ({ ...hello, marker: 'AAECAwQFBgcICQoLDA0ODw' })],
        ['identity_mismatch', (hello) => ({ ...hello, startTime: '1' })],
        ['identity_mismatch', (hello) => ({ ...hello, pid: hello.pid + 1 })]
    ];
    for (const [code, hello] of cases) {
        await t.test(`${code}: ${hello.toString().slice(14, 80)}`, async (sub) => {
            const rig = await setup(sub, { host: { hello }, commit: false });
            await assert.rejects(rig.keeperCreate(), (error) => error.code === code);
            assert.equal(rig.client.alive(), false);
            assert.equal(await waitFor(() => rig.host.latest()?.gone === true, 2000), true, 'the keeper child was ended');
            assert.deepEqual(rig.host.latest().frames, [], 'not even commit_keeper was sent');
            assert.deepEqual(rig.losses, [], 'a refused keeper is a failed create, not an infrastructure loss');
        });
    }
});

test('hello: a keeper that sends no hello within helloDeadlineMs is aborted', async (t) => {
    const rig = await setup(t, { host: { sendHello: false }, commit: false, limits: { helloDeadlineMs: 400 } });
    await assert.rejects(rig.keeperCreate(), (error) => error.code === 'keeper_timeout:hello');
    // The real child is SIGKILLed at once (under load it may not even have reached the fake host yet).
    assert.equal(rig.client.stats().spawned, true);
    assert.equal(await waitFor(() => rig.client.stats().exited === true, 3000), true, 'the keeper child exited');
    assert.equal(rig.client.alive(), false);
});

// ---- identity custody (AC-8) ------------------------------------------------------------------------------------------

test('reused pid', async (t) => {
    let rigRef = null;
    const rig = await setup(t, {
        host: {
            onRequest: (frame, keeper) => {
                if (frame.op !== 'create' || frame.kind !== 'process-tree') return undefined;
                // A live fake process carries the marker, sits under the keeper in its own PID namespace; only its
                // start time differs from what the keeper reports.
                const pid = rigRef.world.newPid();
                const live = rigRef.world.writeProcess({ pid, ppid: keeper.pid, startTime: '700', pidNs: rigRef.world.newInode(), cmdline: ['/stage', '--reservation', frame.marker] });
                return { value: { resource: frame.resource, identity: { pid, startTime: '701', pidNs: live.pidNs } } };
            }
        }
    });
    rigRef = rig;
    const resourceId = newId();
    const create = rig.client.create({ kind: 'process-tree', resourceId, marker: resourceId, locator: rig.locator('process-tree', resourceId), spec: { role: 'orchestration', script: '/opt/o/main.mjs', args: [], env: {}, netns: null } });
    await assert.rejects(create, /identity_mismatch/u);
    assert.equal(rig.keeper.commits.length, 0, 'no commit was sent');
    assert.deepEqual(framesOf(rig.keeper, 'commit'), []);
    assert.deepEqual(framesOf(rig.keeper, 'abort_uncommitted').map((frame) => frame.resources), [[resourceHandle(resourceId)]]);
    assert.equal(rig.client.alive(), true, 'a lying reply aborts that creation only');
});

test('identity custody: every kind is verified through the view before it can be committed', async (t) => {
    const lies = {
        netns: () => ({ netNs: '4026500001' }), // not held by the keeper
        'runtime-dir': (frame) => ({ path: frame.locator.path, dev: '1', ino: '2' }), // never created
        pty: (frame) => ({ pty: frame.locator.pty, devptsDev: '12345', index: 0 }), // no descriptor has that device
        endpoint: () => ({ pid: 4999999, startTime: '1', pidNs: '2' })
    };
    const rig = await setup(t, { host: { onRequest: (frame) => (frame.op === 'create' && lies[frame.kind] ? { value: { resource: frame.resource, identity: lies[frame.kind](frame) } } : undefined) } });
    for (const kind of ['runtime-dir', 'netns', 'pty']) {
        await assert.rejects(rig.make(kind, kind === 'pty' ? { cols: 80, rows: 24 } : {}), /identity_mismatch/u, kind);
    }
    assert.deepEqual(rig.keeper.commits, []);
    assert.equal(framesOf(rig.keeper, 'abort_uncommitted').length, 3);
});

// ---- commit replies and exit events (review F-1, F-2) ----------------------------------------------------------------

const ORCHESTRATION = Object.freeze({ role: 'orchestration', script: '/opt/o/main.mjs', args: [], env: {}, netns: null });
// A fake keeper that answers the commit of a process tree with `answer` and the event in ONE write.
// Only the first commit of a handle is answered this way; a repeated commit gets the model's own answer.
const coalescedCommit = (answer, event = (frame) => ({ event: 'exit', resource: frame.resource, code: 0, signal: null })) => ({
    onRequest: (frame, keeper) => {
        if (frame.op !== 'commit' || keeper.handles.get(frame.resource)?.kind !== 'process-tree' || keeper.handles.get(frame.resource).committed) return undefined;
        keeper.replyThenEvent(frame, answer, event(frame));
        return 'ignore';
    }
});

test('a commit reply and an exit event in one read: the exit is accepted and delivered, and the keeper stays alive', async (t) => {
    const rig = await setup(t, { host: coalescedCommit({ value: { state: 'executed' } }) });
    const exits = [];
    rig.client.onExit((handle, code, signal) => exits.push([handle, code, signal]));
    const created = await rig.make('process-tree', ORCHESTRATION, { commit: false });
    assert.equal(await created.gate.commit(), true);
    assert.equal(await waitFor(() => exits.length === 1, 1000), true, 'the exit was delivered');
    assert.deepEqual(exits, [[created.handle, 0, null]]);
    assert.deepEqual(rig.losses, []);
    assert.equal(rig.client.alive(), true);
});

test('an exit after a failure commit reply is accepted once; after a refused reply, before any reply or twice it is a violation', async (t) => {
    await t.test('failure (exec_failed) then exit, in one read', async (sub) => {
        const rig = await setup(sub, { host: coalescedCommit({ ok: false, kind: 'failure', error: 'exec_failed' }) });
        const exits = [];
        rig.client.onExit((handle) => exits.push(handle));
        const created = await rig.make('process-tree', ORCHESTRATION, { commit: false });
        assert.equal(await created.gate.commit(), false, 'a failed commit releases no gate');
        assert.equal(await waitFor(() => exits.length === 1, 1000), true);
        assert.deepEqual(rig.losses, []);
        assert.equal(rig.client.alive(), true);
        // R2.1: a failure commit marks the resource committed (commit_failed): never listed in an abort, and a second
        // commit is refused already_committed.
        await rig.client.abortUncommitted([created.resourceId]);
        assert.deepEqual(framesOf(rig.keeper, 'abort_uncommitted'), []);
        const again = await rig.client.requestRaw({ op: 'commit', resource: created.handle });
        assert.deepEqual([again.ok, again.error], [false, 'already_committed']);
        assert.deepEqual(rig.losses, []);
    });
    await t.test('failure (stream_connect_failed) then exit, in one read', async (sub) => {
        const rig = await setup(sub, { host: coalescedCommit({ ok: false, kind: 'failure', error: 'stream_connect_failed' }) });
        const exits = [];
        rig.client.onExit((handle) => exits.push(handle));
        const created = await rig.make('process-tree', ORCHESTRATION, { commit: false });
        assert.equal(await created.gate.commit(), false);
        assert.equal(await waitFor(() => exits.length === 1, 1000), true);
        assert.deepEqual(exits, [created.handle]);
        assert.deepEqual(rig.losses, []);
        assert.equal(rig.client.alive(), true);
    });
    await t.test('a commit_failed resource is never aborted, also in a mixed abort list', async (sub) => {
        const rig = await setup(sub, { host: coalescedCommit({ ok: false, kind: 'failure', error: 'exec_failed' }) });
        const failed = await rig.make('process-tree', ORCHESTRATION, { commit: false });
        assert.equal(await failed.gate.commit(), false);
        const pending = await rig.make('process-tree', ORCHESTRATION, { commit: false });
        // The client lists only the uncommitted handle.
        await rig.client.abortUncommitted([failed.resourceId, pending.resourceId]);
        assert.deepEqual(framesOf(rig.keeper, 'abort_uncommitted').map((frame) => frame.resources), [[pending.handle]]);
        // A mixed list that names the commit_failed handle is refused whole by the keeper model; nothing is aborted.
        const third = await rig.make('process-tree', ORCHESTRATION, { commit: false });
        const reply = await rig.client.requestRaw({ op: 'abort_uncommitted', resources: [failed.handle, third.handle] });
        assert.deepEqual([reply.ok, reply.error], [false, 'already_committed']);
        assert.equal(rig.world.exists(third.identity.pid), true, 'the uncommitted stage of the refused list is untouched');
        assert.deepEqual(rig.losses, []);
    });
    await t.test('refused (gate_closed) then exit', async (sub) => {
        const rig = await setup(sub, { host: coalescedCommit({ ok: false, kind: 'refused', error: 'gate_closed' }) });
        const created = await rig.make('process-tree', ORCHESTRATION, { commit: false });
        assert.equal(await created.gate.commit(), false);
        assert.equal(await waitFor(() => rig.losses.length > 0, 1000), true);
        assert.deepEqual(rig.losses, ['keeper_violation:unsolicited_exit']);
    });
    await t.test('exit before any commit reply', async (sub) => {
        const rig = await setup(sub);
        const created = await rig.make('process-tree', ORCHESTRATION, { commit: false });
        rig.keeper.emit({ event: 'exit', resource: created.handle, code: 0, signal: null });
        assert.equal(await waitFor(() => rig.losses.length > 0, 1000), true);
        assert.deepEqual(rig.losses, ['keeper_violation:unsolicited_exit']);
    });
    await t.test('a second exit after an ok commit', async (sub) => {
        const rig = await setup(sub, { host: coalescedCommit({ value: { state: 'executed' } }) });
        const created = await rig.make('process-tree', ORCHESTRATION, { commit: false });
        assert.equal(await created.gate.commit(), true);
        rig.keeper.emit({ event: 'exit', resource: created.handle, code: 0, signal: null });
        assert.equal(await waitFor(() => rig.losses.length > 0, 1000), true);
        assert.deepEqual(rig.losses, ['keeper_violation:duplicate_exit']);
    });
});

// ---- stop and stop_timeout (R2.2, R2.6 A2) -----------------------------------------------------------------------------

const STOP_LIMITS = Object.freeze({ stopExtraMs: 400 });
// A stage whose commit reply is ok (executed) or failure (commit_failed, no exit yet), then hung: the keeper answers
// its stop with stop_timeout and nothing else; the test emits the one later exit itself.
async function hungStage(sub, commitAnswer) {
    const rig = await setup(sub, {
        limits: STOP_LIMITS,
        host: {
            onRequest: (frame, keeper) => {
                if (frame.op === 'stop') return { failure: 'stop_timeout' };
                if (frame.op === 'commit' && commitAnswer === 'failure' && keeper.handles.get(frame.resource)?.kind === 'process-tree') {
                    keeper.handles.get(frame.resource).committed = true;
                    return { failure: 'exec_failed' };
                }
                return undefined;
            }
        }
    });
    const created = await rig.make('process-tree', ORCHESTRATION, { commit: false });
    assert.equal(await created.gate.commit(), commitAnswer === 'ok');
    return { rig, created };
}

test('stop_timeout is accepted, then one later exit with no second stop reply; ping keeps the keeper judged (R2.2, A2)', async (t) => {
    for (const commitAnswer of ['ok', 'failure']) {
        await t.test(commitAnswer === 'ok' ? 'hung executed process' : 'hung commit_failed process', async (sub) => {
            const { rig, created } = await hungStage(sub, commitAnswer);
            const exits = [];
            rig.client.onExit((handle, code, signal) => exits.push([handle, code, signal]));
            const stop = rig.client.requestRaw({ op: 'stop', resource: created.handle, graceMs: 0 });
            const reply = await stop;
            assert.deepEqual([reply.ok, reply.kind, reply.error], [false, 'failure', 'stop_timeout'], 'a timeout, never a success');
            assert.deepEqual(exits, [], 'a stop_timeout is not an exit');
            const pings = framesOf(rig.keeper, 'ping').length;
            assert.equal(await waitFor(() => framesOf(rig.keeper, 'ping').length >= pings + 2, 2000), true, 'the keeper still answers ping');
            rig.keeper.emit({ event: 'exit', resource: created.handle, code: null, signal: 'SIGKILL' });
            assert.equal(await waitFor(() => exits.length === 1, 1000), true);
            await sleep(100);
            assert.deepEqual(exits, [[created.handle, null, 'SIGKILL']], 'exactly one exit');
            assert.equal(rig.keeper.replies.filter((entry) => entry.id === framesOf(rig.keeper, 'stop')[0].id).length, 1, 'one stop reply');
            assert.deepEqual(rig.losses, []);
            assert.equal(rig.client.alive(), true);
        });
    }
});

test('a duplicate stop reply is a violation', async (t) => {
    const rig = await setup(t, {
        limits: STOP_LIMITS,
        host: { onRequest: (frame, keeper) => { if (frame.op !== 'stop') return undefined; keeper.refuse(frame, 'stop_timeout', 'failure'); keeper.send({ id: frame.id, ok: true, value: { state: 'exited' } }); return 'ignore'; } }
    });
    const created = await rig.make('process-tree', ORCHESTRATION);
    const reply = await rig.client.requestRaw({ op: 'stop', resource: created.handle, graceMs: 0 });
    assert.equal(reply.error, 'stop_timeout');
    assert.equal(await waitFor(() => rig.losses.length > 0, 1000), true);
    assert.deepEqual(rig.losses, ['keeper_violation:unsolicited_reply']);
});

test('the client keeps its own fail-closed stop deadline: an unanswered stop ends the channel at graceMs + stopExtraMs', async (t) => {
    const rig = await setup(t, { limits: STOP_LIMITS, host: { onRequest: (frame) => (frame.op === 'stop' ? 'ignore' : undefined) } });
    const created = await rig.make('process-tree', ORCHESTRATION);
    const graceMs = 200;
    const started = Date.now();
    let settled = false;
    const stop = rig.client.requestRaw({ op: 'stop', resource: created.handle, graceMs }).finally(() => { settled = true; });
    await sleep(graceMs + STOP_LIMITS.stopExtraMs / 2);
    assert.equal(settled, false, 'no premature answer');
    await assert.rejects(within(stop, graceMs + STOP_LIMITS.stopExtraMs + 1500, 'stop'), (error) => error.code === 'keeper_timeout:stop');
    assert.ok(Date.now() - started >= graceMs + STOP_LIMITS.stopExtraMs - 20, `rejected after ${Date.now() - started} ms`);
    assert.deepEqual(rig.losses, ['keeper_timeout:stop']);
});

// ---- the mount bound (R2.3, R2.6 A4) ----------------------------------------------------------------------------------

test('a lease renewal is answered while four mount ops are held', async (t) => {
    const rig = await setup(t, {
        grants: 1, viewLimits: { rootLeaseRenewMs: 60000, rootLeaseTtlMs: 120000 },
        host: { onRequest: (frame) => (frame.op === 'unmount_view' ? 'hold' : undefined) }
    });
    await rig.mount();
    const unmount = (n) => rig.client.requestRaw({ op: 'unmount_view', resource: `m${n.toString(16).padStart(32, '0')}` });
    const five = [1, 2, 3, 4, 5].map(unmount);
    five.forEach((pending) => pending.catch(() => {}));
    // The client's own count, read synchronously after the calls: the keeper has not seen or rejected anything yet.
    assert.equal(rig.client.stats().inFlight.mount, 4, 'at most four mount ops outstanding');
    assert.equal(rig.client.stats().queued, 1, 'the fifth is queued by the client');
    // No mount reply is released until the lease has been answered.
    const lease = rig.client.requestRaw({ op: 'view_root_lease', grantId: 'proj', epoch: 2, verdict: 'renew', ttlMs: 1000 });
    lease.catch(() => {});
    const renewal = await within(lease, 350, 'lease answered while four mount ops are held');
    assert.equal(renewal.ok, true);
    assert.equal(renewal.value.state, 'live');
    assert.equal(rig.client.stats().inFlight.mount, 4);
    assert.equal(rig.client.stats().queued, 1, 'fifth mount stays queued throughout renewal');
    await rig.make('netns');
    assert.equal(framesOf(rig.keeper, 'create', 'netns').length, 1, 'non-mount traffic is not held behind the mount bound');
    assert.equal(await waitFor(() => framesOf(rig.keeper, 'unmount_view').length === 4), true);
    rig.keeper.release(framesOf(rig.keeper, 'unmount_view')[0].id);
    assert.equal(await waitFor(() => framesOf(rig.keeper, 'unmount_view').length === 5), true, 'the fifth advances after one settles');
    rig.host.options.onRequest = undefined;
    const release = setInterval(() => rig.keeper.releaseAll(), 20);
    t.after(() => clearInterval(release));
    await Promise.all([...five, lease]);
    clearInterval(release);
    assert.equal(rig.client.stats().peakMount, 4);
    assert.deepEqual(rig.keeper.violations, []);
    assert.deepEqual(rig.losses, []);
});

test('a gate never reports released once the channel was torn down in the same read', async (t) => {
    await t.test('resource commit', async (sub) => {
        const rig = await setup(sub, { host: coalescedCommit({ value: { state: 'executed' } }, () => ({ neither: true })) });
        const created = await rig.make('process-tree', ORCHESTRATION, { commit: false });
        assert.equal(await created.gate.commit(), false);
        assert.deepEqual(rig.losses, ['keeper_violation:bad_frame']);
    });
    await t.test('keeper commit', async (sub) => {
        const rig = await setup(sub, {
            commit: false,
            host: { onRequest: (frame, keeper) => { if (frame.op !== 'commit_keeper') return undefined; keeper.replyThenEvent(frame, { value: {} }, { neither: true }); return 'ignore'; } }
        });
        const made = await rig.keeperCreate();
        assert.equal(await made.gate.commit(), false);
        assert.equal(rig.client.alive(), false);
    });
});

// ---- the frame channel ------------------------------------------------------------------------------------------------

test('the client refuses to send an unknown op', async (t) => {
    const rig = await setup(t);
    await assert.rejects(rig.client.requestRaw({ op: 'frobnicate' }), /bad_request/u);
    await assert.rejects(rig.client.requestRaw({ op: 'ping', fd: 3 }), /bad_request/u);
    await sleep(50);
    assert.deepEqual(rig.keeper.frames.filter((entry) => !['commit_keeper', 'ping'].includes(entry.frame.op)), [], 'the fake keeper received no such frame');
    assert.equal(rig.client.alive(), true);
});

test('a request that misses its deadline ends the channel with keeper_timeout:<op> and is never resubmitted', async (t) => {
    const rig = await setup(t, { host: { onRequest: (frame) => (frame.op === 'create' ? 'ignore' : undefined) } });
    const started = Date.now();
    await assert.rejects(rig.make('runtime-dir'), (error) => error.code === 'keeper_timeout:create');
    assert.ok(Date.now() - started >= TEST_LIMITS.requestDeadlineMs - 20);
    assert.equal(rig.client.alive(), false);
    assert.deepEqual(rig.losses, ['keeper_timeout:create']);
    assert.equal(framesOf(rig.keeper, 'create').length, 1, 'never resubmitted');
    const after = Date.now();
    await assert.rejects(rig.client.endProcessTrees(), (error) => error.code === 'keeper_timeout:create');
    assert.ok(Date.now() - after < 50, 'a later call rejects at once');
    assert.equal(await waitFor(() => rig.keeper.gone, 2000), true, 'EOF, then the keeper is gone');
});

test('keeper death with 10 requests pending: all reject within 1 s and the infrastructure loss is reported once', async (t) => {
    const rig = await setup(t, { host: { onRequest: (frame) => (frame.op === 'create' ? 'hold' : undefined) }, limits: { requestDeadlineMs: 5000 } });
    const calls = Array.from({ length: 10 }, () => rig.make('netns').then(() => 'resolved', (error) => error.code));
    assert.equal(await waitFor(() => framesOf(rig.keeper, 'create').length === 10), true);
    const killed = Date.now();
    rig.keeper.kill();
    const results = await within(Promise.all(calls), 1000, 'pending calls');
    assert.ok(Date.now() - killed <= 1000);
    assert.deepEqual(results, Array(10).fill('keeper_lost'));
    assert.deepEqual(rig.losses, ['keeper_lost']);
});

test('keeper-to-supervisor violations end the channel: a reply to a non-pending id, a bad reply, a truncated frame, invalid UTF-8, an array payload', async (t) => {
    const cases = [
        ['keeper_violation:unsolicited_reply', (keeper) => keeper.send({ id: 999999, ok: true, value: {} })],
        ['keeper_violation:unknown_event', (keeper) => keeper.send({ event: 'frobnicate' })],
        ['keeper_violation:bad_frame', (keeper) => keeper.send({ neither: true })],
        ['keeper_violation:partial_frame_deadline', (keeper) => { const header = Buffer.alloc(4); header.writeUInt32BE(100, 0); keeper.writeRaw(Buffer.concat([header, Buffer.from('{"id"')])); }],
        ['keeper_violation:malformed_frame', (keeper) => { const body = Buffer.from([0xff, 0xfe, 0x7b]); const header = Buffer.alloc(4); header.writeUInt32BE(body.length, 0); keeper.writeRaw(Buffer.concat([header, body])); }],
        ['keeper_violation:malformed_frame', (keeper) => { const body = Buffer.from('[1,2]'); const header = Buffer.alloc(4); header.writeUInt32BE(body.length, 0); keeper.writeRaw(Buffer.concat([header, body])); }],
        ['keeper_violation:oversize_frame', (keeper) => { const header = Buffer.alloc(4); header.writeUInt32BE(10 * 1024 * 1024, 0); keeper.writeRaw(header); }],
        ['keeper_lost', (keeper) => { const header = Buffer.alloc(4); header.writeUInt32BE(100, 0); keeper.writeRaw(Buffer.concat([header, Buffer.from('{"id"')])); keeper.closeChannel(); }]
    ];
    for (const [reason, act] of cases) {
        await t.test(reason, async (sub) => {
            const rig = await setup(sub);
            act(rig.keeper);
            assert.equal(await waitFor(() => rig.losses.length > 0, 2000), true);
            assert.deepEqual(rig.losses, [reason]);
            assert.equal(rig.client.alive(), false);
        });
    }
});

test('a duplicate reply and an exit event for an unknown handle are violations', async (t) => {
    await t.test('duplicate reply', async (sub) => {
        const rig = await setup(sub, { host: { onRequest: (frame, keeper) => { if (frame.op === 'tempdir') { keeper.reply(frame, { path: '/tmp/ala-0123456789abcdef' }); keeper.reply(frame, { path: '/tmp/ala-0123456789abcdef' }); return 'ignore'; } return undefined; } } });
        await rig.make('runtime-dir');
        await rig.client.providerKeeper(null, { netnsHandle: null }).tempdir();
        assert.equal(await waitFor(() => rig.losses.length > 0), true);
        assert.deepEqual(rig.losses, ['keeper_violation:unsolicited_reply']);
    });
    await t.test('exit for an unknown handle', async (sub) => {
        const rig = await setup(sub);
        rig.keeper.emit({ event: 'exit', resource: 'a'.repeat(32), code: 0, signal: null });
        assert.equal(await waitFor(() => rig.losses.length > 0), true);
        assert.deepEqual(rig.losses, ['keeper_violation:unknown_resource']);
    });
});

test('in-flight bound: 20 parallel creates leave at most 14 ordinary ops outstanding at the keeper, and all complete', async (t) => {
    const rig = await setup(t, { host: { onRequest: (frame) => (frame.op === 'create' ? 'hold' : undefined) }, limits: { requestDeadlineMs: 5000 } });
    const calls = Array.from({ length: 20 }, () => rig.make('netns'));
    assert.equal(await waitFor(() => framesOf(rig.keeper, 'create').length === 14), true);
    await sleep(100);
    assert.equal(framesOf(rig.keeper, 'create').length, 14, 'the 15th waits for a slot');
    assert.equal(rig.client.stats().queued, 6);
    const release = setInterval(() => rig.keeper.releaseAll(), 20);
    t.after(() => clearInterval(release));
    await within(Promise.all(calls), 4000, 'creates');
    clearInterval(release);
    assert.ok(rig.keeper.maxOrdinaryInFlight <= 16, `keeper saw ${rig.keeper.maxOrdinaryInFlight}`);
    assert.equal(rig.client.stats().peaks.ordinary, 14);
    assert.deepEqual(rig.keeper.violations, []);
});

test('lease under load', async (t) => {
    const rig = await setup(t, { grants: 1, limits: { requestDeadlineMs: 4000 } });
    await rig.mount();
    let holding = false;
    rig.host.options.onRequest = (frame) => (holding && frame.op === 'create' ? 'hold' : undefined);
    holding = true;
    const calls = Array.from({ length: 16 }, () => rig.make('netns').catch((error) => error));
    assert.equal(await waitFor(() => framesOf(rig.keeper, 'create', 'netns').length === 14), true);
    const before = framesOf(rig.keeper, 'view_root_lease').length;
    const window = 10 * TEST_VIEW_LIMITS.rootLeaseRenewMs;
    await sleep(window);
    const renewed = framesOf(rig.keeper, 'view_root_lease').length - before;
    assert.ok(renewed >= 5, `renew frames sent while 14 creates were in flight and 2 queued: ${renewed} in ${window} ms`);
    assert.ok(framesOf(rig.keeper, 'view_root_lease').every((frame) => frame.verdict === 'renew'), 'never revoked');
    assert.deepEqual(rig.quarantined, []);
    holding = false;
    rig.keeper.releaseAll();
    const release = setInterval(() => rig.keeper.releaseAll(), 20);
    t.after(() => clearInterval(release));
    await within(Promise.all(calls), 4000, 'creates');
    clearInterval(release);
    assert.deepEqual(rig.keeper.violations, []);
});

// ---- PTY (AC-12, AC-19) -----------------------------------------------------------------------------------------------

async function ptyRig(t, options = {}) {
    const rig = await setup(t, options);
    const pty = await rig.make('pty', { cols: 80, rows: 24 });
    return { ...rig, handle: pty.handle };
}

test('pty: output is never accepted beyond the granted credit', async (t) => {
    const rig = await ptyRig(t);
    const seen = [];
    rig.client.onPtyOutput((handle, seq, bytes) => seen.push([handle, seq, bytes.toString()]));
    assert.equal(rig.keeper.ptyOutput(rig.handle, 'x'), false, 'output starts with credit 0');
    await rig.client.ptyCredit(rig.handle, 5);
    assert.equal(rig.keeper.ptyOutput(rig.handle, 'hello'), true);
    assert.equal(await waitFor(() => seen.length === 1), true);
    assert.deepEqual(seen, [[rig.handle, '1', 'hello']]);
    await assert.rejects(rig.client.ptyCredit(rig.handle, 262145), /credit_overflow/u);
    rig.keeper.ptyOutput(rig.handle, '!', { respectCredit: false });
    assert.equal(await waitFor(() => rig.losses.length > 0), true);
    assert.deepEqual(rig.losses, ['keeper_violation:credit_overrun']);
    assert.equal(seen.length, 1, 'the overrunning byte was not delivered');
});

test('pty: input resolves only after the keeper has written it, and a replayed input sequence is written once', async (t) => {
    let hold = true;
    const rig = await ptyRig(t, { host: { onRequest: (frame) => (hold && frame.op === 'pty_input' ? 'hold' : undefined) } });
    let settled = false;
    const input = rig.client.ptyInput(rig.handle, Buffer.from('ls\n')).then((seq) => { settled = true; return seq; });
    assert.equal(await waitFor(() => framesOf(rig.keeper, 'pty_input').length === 1), true);
    await sleep(100);
    assert.equal(settled, false, 'no ack before the write');
    hold = false;
    rig.keeper.releaseAll();
    assert.equal(await input, '1');
    assert.deepEqual(rig.keeper.ptyWrites.map((entry) => [entry.seq, entry.bytes.toString()]), [['1', 'ls\n']]);
    const replay = await rig.client.requestRaw({ op: 'pty_input', resource: rig.handle, seq: '1', data: Buffer.from('ls\n').toString('base64') });
    assert.deepEqual(replay.value, { seq: '1' });
    assert.equal(rig.keeper.ptyWrites.length, 1, 'the replay was acknowledged, not written again');
    // A 64 KiB input frame becomes four chunks with consecutive sequence numbers; the ack follows the last one.
    assert.equal(await rig.client.ptyInput(rig.handle, Buffer.alloc(65536, 0x41)), '5');
    assert.deepEqual(rig.keeper.ptyWrites.slice(1).map((entry) => [entry.seq, entry.bytes.length]), [['2', 16384], ['3', 16384], ['4', 16384], ['5', 16384]]);
    await rig.client.ptyResize(rig.handle, 120, 40);
    assert.deepEqual(rig.losses, []);
});

test('non-reading terminal', async (t) => {
    let hold = true;
    const rig = await ptyRig(t, { host: { onRequest: (frame) => (hold && frame.op === 'pty_input' ? 'hold' : undefined) } });
    const acks = [];
    const failures = [];
    const inputs = [1, 2, 3].map((n) => rig.client.ptyInput(rig.handle, Buffer.from(`k${n}`)).then((seq) => acks.push(seq), (error) => failures.push(error.code)));
    await sleep(3 * TEST_LIMITS.requestDeadlineMs);
    assert.equal(rig.client.alive(), true);
    assert.deepEqual(failures, []);
    assert.deepEqual(rig.losses, []);
    assert.deepEqual(rig.stalls, [rig.handle], 'the stall is reported once, for diagnosis only');
    assert.ok(framesOf(rig.keeper, 'ping').length >= 3, 'the keeper stays judged by its other requests');
    hold = false;
    rig.keeper.releaseAll();
    await within(Promise.all(inputs), 2000, 'inputs');
    assert.deepEqual(acks, ['1', '2', '3']);
});

test('stalled input does not block ordinary ops', async (t) => {
    const BARRIER = 14;
    let creates = 0;
    let renewsWhileFull = 0;
    const rig = await ptyRig(t, {
        grants: 1,
        host: {
            onRequest: (frame, keeper) => {
                if (frame.op === 'pty_input') return 'hold';
                if (frame.op === 'view_root_lease' && creates === BARRIER) renewsWhileFull += 1;
                if (frame.op === 'create' && frame.kind === 'netns') {
                    creates += 1;
                    // Every create is held until all 14 are outstanding at once, and then for several lease ticks, so
                    // that 8 stalled inputs, 14 ordinary ops, lease renewals and pings are all outstanding together.
                    if (creates === BARRIER) {
                        setTimeout(() => {
                            for (const [id, run] of [...keeper.held]) {
                                if (keeper.frames.find((entry) => entry.frame.id === id)?.frame.op === 'create') { keeper.held.delete(id); run(); }
                            }
                        }, 6 * TEST_VIEW_LIMITS.rootLeaseRenewMs);
                    }
                    return 'hold';
                }
                return undefined;
            }
        }
    });
    await rig.mount();
    assert.equal(await waitFor(() => framesOf(rig.keeper, 'view_root_lease').length > 0), true, 'the lease loop runs');
    const stalled = Array.from({ length: 8 }, (_, n) => rig.client.ptyInput(rig.handle, Buffer.from([n])).catch((error) => error));
    assert.equal(await waitFor(() => framesOf(rig.keeper, 'pty_input').length === 8), true, '8 chunks fill the window');
    const results = await Promise.allSettled(Array.from({ length: BARRIER }, () => within(rig.make('netns'), TEST_LIMITS.requestDeadlineMs + 1500, 'create')));
    const rejected = results.filter((result) => result.status === 'rejected').map((result) => result.reason.code ?? result.reason.message);
    assert.deepEqual(rejected, [], 'all 14 creates completed within their deadline');
    assert.equal(rig.keeper.maxPtyInFlight, 8);
    assert.deepEqual(rig.keeper.violations, [], 'no in_flight_overflow with 8 stalled inputs, 14 ordinary ops, lease renewals and ping');
    assert.ok(renewsWhileFull >= 2, `lease renewals while 14 creates and 8 inputs were outstanding: ${renewsWhileFull}`);
    rig.keeper.releaseAll();
    await within(Promise.all(stalled), 2000, 'stalled inputs');
});

test('window', async (t) => {
    const rig = await ptyRig(t, { host: { onRequest: (frame) => (frame.op === 'pty_input' ? 'hold' : undefined) } });
    const inputs = Array.from({ length: 9 }, (_, n) => rig.client.ptyInput(rig.handle, Buffer.from([n])));
    assert.equal(await waitFor(() => framesOf(rig.keeper, 'pty_input').length === 8), true);
    await sleep(150);
    assert.equal(framesOf(rig.keeper, 'pty_input').length, 8, 'the fake keeper never sees more than 8 outstanding');
    assert.equal(rig.keeper.maxPtyInFlight, 8);
    rig.keeper.release(framesOf(rig.keeper, 'pty_input')[0].id);
    assert.equal(await waitFor(() => framesOf(rig.keeper, 'pty_input').length === 9), true, 'a reply frees a slot');
    rig.host.options.onRequest = undefined;
    rig.keeper.releaseAll();
    assert.deepEqual(await within(Promise.all(inputs), 2000, 'inputs'), ['1', '2', '3', '4', '5', '6', '7', '8', '9']);
});

test('pty input beyond the window fails: the keeper treats a 9th outstanding chunk as a violation, and the client backlog is bounded', async (t) => {
    await t.test('keeper side', async (sub) => {
        const rig = await ptyRig(sub, { host: { onRequest: (frame) => (frame.op === 'pty_input' ? 'hold' : undefined) } });
        // Only the internal raw path can exceed the window; the client itself never does.
        const raw = Array.from({ length: 9 }, (_, n) => rig.client.requestRaw({ op: 'pty_input', resource: rig.handle, seq: String(n + 1), data: 'YQ==' }).catch((error) => error.code));
        assert.equal(await waitFor(() => rig.keeper.violations.length > 0, 2000), true);
        assert.deepEqual(rig.keeper.violations, ['pty_input_window']);
        assert.equal(await waitFor(() => rig.losses.length > 0, 2000), true);
        assert.deepEqual(rig.losses, ['keeper_lost']);
        assert.deepEqual([...new Set(await Promise.all(raw))], ['keeper_lost']);
    });
    await t.test('client side', async (sub) => {
        const rig = await ptyRig(sub, { host: { onRequest: (frame) => (frame.op === 'pty_input' ? 'hold' : undefined) }, limits: { ptyInputQueueBytes: 65536 } });
        const window = Array.from({ length: 4 }, () => rig.client.ptyInput(rig.handle, Buffer.alloc(16384, 1)).catch((error) => error));
        assert.equal(await waitFor(() => framesOf(rig.keeper, 'pty_input').length === 4), true);
        const queued = rig.client.ptyInput(rig.handle, Buffer.alloc(65536, 2)).catch((error) => error);
        const sent = rig.keeper.frames.length;
        await assert.rejects(rig.client.ptyInput(rig.handle, Buffer.alloc(1, 3)), /pty_input_backlog/u);
        await sleep(50);
        assert.equal(rig.keeper.frames.filter((entry) => entry.frame.op === 'pty_input').length, 4, 'nothing was sent for the refused input');
        assert.ok(rig.keeper.frames.length >= sent);
        assert.equal(rig.client.alive(), true);
        rig.host.options.onRequest = undefined;
        rig.keeper.releaseAll();
        await within(Promise.all([...window, queued]), 2000, 'inputs');
    });
});

test('pty_closed: pending input is refused, queued input is dropped, and output after it is a violation', async (t) => {
    const rig = await ptyRig(t);
    const closed = [];
    rig.client.onPtyClosed((handle) => closed.push(handle));
    rig.keeper.emit({ event: 'pty_closed', resource: rig.handle });
    assert.equal(await waitFor(() => closed.length === 1), true);
    rig.keeper.closedPtys.add(rig.handle);
    await assert.rejects(rig.client.ptyInput(rig.handle, Buffer.from('x')), /pty_closed/u);
    rig.keeper.emit({ event: 'pty_closed', resource: rig.handle });
    assert.equal(await waitFor(() => rig.losses.length > 0), true);
    assert.deepEqual(rig.losses, ['keeper_violation:pty_closed']);
});

// ---- idempotency, orphans, error injection ---------------------------------------------------------------------------

test('idempotency and orphans: commit twice, end steps twice, unknown handles, abort of an unknown handle', async (t) => {
    const rig = await setup(t);
    const netns = await rig.make('netns');
    const again = await rig.client.requestRaw({ op: 'commit', resource: netns.handle });
    assert.deepEqual([again.ok, again.kind, again.error], [false, 'refused', 'already_committed']);
    const ghost = 'f'.repeat(32);
    for (const frame of [
        { op: 'commit', resource: ghost }, { op: 'stop', resource: ghost, graceMs: 0 }, { op: 'pty_resize', resource: ghost, cols: 1, rows: 1 },
        { op: 'pty_credit', resource: ghost, bytes: 1 }, { op: 'pty_input', resource: ghost, seq: '1', data: 'YQ==' }, { op: 'unmount_view', resource: `m${ghost}` }
    ]) {
        const reply = await rig.client.requestRaw(frame);
        assert.deepEqual([reply.ok, reply.error], [false, 'unknown_resource'], frame.op);
    }
    await rig.client.abortUncommitted([newId()]);
    assert.equal((await rig.client.requestRaw({ op: 'end_process_trees' })).ok, true);
    assert.equal((await rig.client.requestRaw({ op: 'end_process_trees' })).ok, true, 'twice is a no-op');
    await assert.rejects(rig.make('netns'), /execution_ending/u, 'after an end step the keeper refuses creates');
    assert.deepEqual(rig.losses, []);
});

test('error injection: a keeper that exits between create and commit fails the gate, and an exit event before the stop reply is delivered first', async (t) => {
    await t.test('exit between create and commit', async (sub) => {
        const rig = await setup(sub);
        const created = await rig.client.create({ kind: 'netns', resourceId: newId(), marker: null, locator: rig.locator('netns'), spec: {} });
        rig.keeper.exit(9);
        assert.equal(await waitFor(() => rig.losses.length > 0), true);
        assert.equal(await created.gate.commit(), false);
        assert.deepEqual(rig.losses, ['keeper_lost']);
    });
    await t.test('exit before stop reply', async (sub) => {
        const rig = await setup(sub);
        await rig.make('runtime-dir');
        const netns = await rig.make('netns');
        const order = [];
        const ledger = { publish: async ({ kind, spec }) => rig.make(kind, spec) };
        const provider = rig.client.providerKeeper(ledger, { netnsHandle: netns.handle });
        provider.setExitHandler((process, code, signal) => order.push(['exit', process, code, signal]));
        const request = { processClass: 'run', executable: 'codex', args: ['run'], env: {}, home: '/home/robot', cwd: '/projects/g', folders: [], exclusions: [], communication: { kind: 'streams', stdin: 'ignore' }, lifecycle: { stopGraceMs: 2000 }, network: 'robot-egress', requirements: { privateProc: true } };
        await provider.start({ process: 3, request, streams: { stdout: '/run/s/a' } });
        await provider.stop({ process: 3, graceMs: 0 });
        order.push(['stop-resolved']);
        assert.deepEqual(order, [['exit', 3, null, 'SIGTERM'], ['stop-resolved']]);
        assert.match(await provider.tempdir(), /^\/tmp\/ala-[0-9a-f]{16}$/u);
    });
});

test('diagnostics: keeper stderr is kept as a bounded ring and never parsed', async (t) => {
    const rig = await setup(t, { limits: { stderrRingBytes: 64 } });
    rig.keeper.stderr(`${'x'.repeat(100)}tail-marker`);
    assert.equal(await waitFor(() => rig.client.stderrTail().includes('tail-marker')), true);
    assert.ok(rig.client.stderrTail().length <= 64);
    assert.deepEqual(rig.losses, []);
});

// ---- static checks ----------------------------------------------------------------------------------------------------

const executionDir = fileURLToPath(new URL('../../server/execution/', import.meta.url));

test('only keeperClient.mjs imports the child-process module in server/execution, and it never opens a Node message channel', () => {
    const importers = fs.readdirSync(executionDir).filter((name) => name.endsWith('.mjs') && fs.readFileSync(path.join(executionDir, name), 'utf8').includes('child_process'));
    assert.deepEqual(importers, ['keeperClient.mjs']);
    const source = fs.readFileSync(path.join(executionDir, 'keeperClient.mjs'), 'utf8');
    assert.equal(source.includes(`'${'ipc'}'`), false);
    assert.match(source, /env: \{\}/u);
    assert.match(source, /detached: false/u);
});

test('the Linux-only test file declares its exact test count', () => {
    const file = fileURLToPath(new URL('./keeperClient.linux-proc.mjs', import.meta.url));
    const expected = JSON.parse(fs.readFileSync(fileURLToPath(new URL('./keeperClient.linux-proc.expected.json', import.meta.url)), 'utf8'));
    const declared = fs.readFileSync(file, 'utf8').match(/^test\(/gmu)?.length ?? 0;
    assert.equal(declared, expected.tests);
    assert.ok(declared >= 4);
});
