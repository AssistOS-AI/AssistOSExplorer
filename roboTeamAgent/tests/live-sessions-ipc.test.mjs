import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { IPC_SOCKET_PATH, LiveSessionsIpcServer } from '../server/live-sessions/ipc-server.mjs';
import { LiveSessionsRegistry } from '../server/live-sessions/registry.mjs';
import { ipcClient, socketFixture } from './helpers/live-sessions-ipc-client.mjs';

// IPC trust and lifecycle. Owner verification is a deterministic stand-in
// here; tests/live-sessions-owner.test.mjs covers it with real Router tokens.
const ADMIN = { principal: 'user:root', canAdmin: true };
const ALICE = { principal: 'user:alice', canAdmin: false };

function fakeVerifier(token) {
    const match = /^valid:(.+)$/u.exec(token);
    return match ? { ok: true, payload: { sub: `user:${match[1]}`, actor: { kind: 'user', id: `user:${match[1]}`, roles: ['user'] } } } : { ok: false };
}

async function startIpc(t, options = {}) {
    const { socketPath, root, cleanup } = await socketFixture();
    const logs = [];
    const registry = new LiveSessionsRegistry({ log: (line) => logs.push(line), urlBase: '/base-agent-additional-server/roboTeamAgent/3001' });
    const server = new LiveSessionsIpcServer({ registry, verifyOwner: fakeVerifier, log: (line) => logs.push(line), ...options });
    await server.listen(socketPath);
    const clients = [];
    const connect = async () => { const client = await ipcClient(socketPath); clients.push(client); return client; };
    t.after(async () => {
        await Promise.all(clients.map((client) => client.close()));
        await server.close();
        registry.close();
        await cleanup();
    });
    return { server, registry, socketPath, root, logs, connect };
}

async function claim(client, user, claimId = `claim-${user}-${Math.random().toString(36).slice(2)}`) {
    client.send({ type: 'owner-claim', claimId, token: `valid:${user}`, args: { surface: 'webchat' } });
    return client.next((message) => message.claimId === claimId);
}

function row(registry, runId) {
    return registry.list(ADMIN).find((item) => item.id === runId);
}

test('the socket is private, exclusive and cleaned up only by its own identity', async (t) => {
    assert.equal(IPC_SOCKET_PATH, '/dev/shm/roboteam-live/registry.sock');
    const { socketPath, server, registry } = await startIpc(t);
    assert.equal((await fs.stat(path.dirname(socketPath))).mode & 0o777, 0o700);
    assert.equal((await fs.lstat(socketPath)).mode & 0o777, 0o600);
    assert.ok((await fs.lstat(socketPath)).isSocket());
    // A second listener refuses the existing path and leaves it in place.
    const second = new LiveSessionsIpcServer({ registry, verifyOwner: fakeVerifier });
    await assert.rejects(second.listen(socketPath), { code: 'EEXIST' });
    assert.ok((await fs.lstat(socketPath)).isSocket());
    await server.close();
    await assert.rejects(fs.lstat(path.dirname(socketPath)), { code: 'ENOENT' });
});

test('preexisting directories, files, links and unsafe parents are refused, never adopted or removed', async (t) => {
    const registry = new LiveSessionsRegistry();
    const { root, socketPath, cleanup } = await socketFixture();
    t.after(async () => { registry.close(); await cleanup(); });
    const directory = path.dirname(socketPath);
    await fs.mkdir(directory, { mode: 0o700 });
    await assert.rejects(new LiveSessionsIpcServer({ registry }).listen(socketPath), { code: 'EEXIST' });
    assert.ok((await fs.lstat(directory)).isDirectory(), 'existing directory kept');
    await fs.rmdir(directory);
    await fs.writeFile(directory, 'not a directory');
    await assert.rejects(new LiveSessionsIpcServer({ registry }).listen(socketPath), { code: 'EEXIST' });
    assert.equal(await fs.readFile(directory, 'utf8'), 'not a directory');
    await fs.rm(directory);
    await fs.mkdir(path.join(root, 'elsewhere'));
    await fs.symlink(path.join(root, 'elsewhere'), directory);
    await assert.rejects(new LiveSessionsIpcServer({ registry }).listen(socketPath), { code: 'EEXIST' });
    assert.ok((await fs.lstat(directory)).isSymbolicLink(), 'link kept');
    // A symlinked parent is refused before anything is created.
    const linkedParent = path.join(root, 'parent-link');
    await fs.symlink(path.join(root, 'elsewhere'), linkedParent);
    await assert.rejects(new LiveSessionsIpcServer({ registry }).listen(path.join(linkedParent, 'roboteam-live', 'registry.sock')), /real directory/);
    assert.deepEqual(await fs.readdir(path.join(root, 'elsewhere')), []);
});

test('messages before hello, malformed JSON and oversized lines close only the offending connection', async (t) => {
    const { connect, registry } = await startIpc(t, { lineBytes: 1024 });
    const healthy = await connect();
    await healthy.hello();
    const kept = await healthy.start({ localRef: 'kept' });
    const early = await connect();
    early.send({ type: 'run-start', localRef: 'x', kind: 'copilot-turn' });
    await early.closedPromise;
    const malformed = await connect();
    await malformed.hello();
    malformed.raw('{not json}\n');
    await malformed.closedPromise;
    const oversized = await connect();
    await oversized.hello();
    oversized.raw(`${JSON.stringify({ type: 'run-event', runId: kept.runId, seq: 1, text: 'x'.repeat(2048) })}\n`);
    await oversized.closedPromise;
    const unterminated = await connect();
    await unterminated.hello();
    unterminated.raw('x'.repeat(4096));
    await unterminated.closedPromise;
    assert.equal(healthy.closed, false);
    assert.equal(row(registry, kept.runId).status, 'running');
});

test('events and ends for a run owned by another connection are rejected', async (t) => {
    const { connect, registry } = await startIpc(t);
    const owner = await connect();
    await owner.hello();
    const { runId } = await owner.start({ localRef: 'one' });
    const other = await connect();
    await other.hello();
    other.send({ type: 'run-event', runId, seq: 1, text: 'injected' });
    assert.deepEqual(await other.next('rejected'), { type: 'rejected', runId, reason: 'not-owner' });
    other.send({ type: 'run-end', runId, status: 'finished' });
    await other.next('rejected');
    assert.equal(row(registry, runId).status, 'running');
    owner.send({ type: 'run-event', runId, seq: 1, text: 'own' });
    owner.send({ type: 'run-end', runId, status: 'finished', code: 0 });
    await delay(30);
    assert.equal(row(registry, runId).status, 'finished');
});

test('publisher-declared identity is ignored; only a handle from a verified claim makes an owner', async (t) => {
    const { connect, registry } = await startIpc(t);
    const client = await connect();
    await client.hello();
    const declared = await client.start({ localRef: 'declared', ownerPrincipal: 'user:alice', principal: 'user:alice', owner: 'user:alice', ownerState: 'verified' });
    assert.equal(row(registry, declared.runId).ownerState, 'unverified');
    assert.deepEqual(registry.list(ALICE), []);
    assert.equal((await claim(client, 'mallory', 'bad')).type, 'owner-handle', 'control: the stand-in verifier accepts valid tokens');
    client.send({ type: 'owner-claim', claimId: 'forged', token: 'forged', args: {} });
    assert.equal((await client.next((message) => message.claimId === 'forged')).type, 'owner-rejected');
    const unknownHandle = await client.start({ localRef: 'unknown-handle', ownerHandle: 'not-a-handle' });
    assert.equal(row(registry, unknownHandle.runId).ownerState, 'unverified');
    const handle = await claim(client, 'alice');
    const verified = await client.start({ localRef: 'verified', ownerHandle: handle.ownerHandle, ownerPrincipal: 'user:bob' });
    assert.deepEqual(registry.list(ALICE).map((item) => item.id), [verified.runId]);
    assert.equal(registry.list(ALICE)[0].isOwner, true);
    // A handle from one incarnation proves nothing on another.
    const stranger = await connect();
    await stranger.hello();
    const borrowed = await stranger.start({ localRef: 'borrowed', ownerHandle: handle.ownerHandle });
    assert.equal(row(registry, borrowed.runId).ownerState, 'unverified');
    // Publishers cannot publish in-process kinds.
    assert.equal((await client.start({ localRef: 'kind', kind: 'robot-task' })).type, 'run-refused');
});

test('per-connection caps: 17th run per handle and 65th per connection refused; other connections untouched', async (t) => {
    const { connect, registry } = await startIpc(t);
    const client = await connect();
    await client.hello();
    const handles = [];
    for (let index = 0; index < 4; index += 1) handles.push((await claim(client, `user${index}`)).ownerHandle);
    const accepted = [];
    for (let index = 0; index < 16; index += 1) accepted.push((await client.start({ localRef: `h0-${index}`, ownerHandle: handles[0] })).runId);
    const seventeenth = await client.start({ localRef: 'h0-16', ownerHandle: handles[0] });
    assert.deepEqual(seventeenth, { type: 'run-refused', localRef: 'h0-16', reason: 'owner-limit' });
    for (const handle of handles.slice(1)) {
        for (let index = 0; index < 16; index += 1) {
            const started = await client.start({ localRef: `${handle.slice(0, 6)}-${index}`, ownerHandle: handle });
            assert.equal(started.type, 'run-id');
            accepted.push(started.runId);
        }
    }
    assert.equal(accepted.length, 64, '64 runs spread across handles are accepted');
    const other = await connect();
    await other.hello();
    const othersRun = await other.start({ localRef: 'other' });
    assert.deepEqual(await client.start({ localRef: 'sixty-fifth' }), { type: 'run-refused', localRef: 'sixty-fifth', reason: 'connection-limit' });
    assert.ok(accepted.every((runId) => row(registry, runId).status === 'running'));
    assert.equal(row(registry, othersRun.runId).status, 'running');
    // Ending a run frees a slot.
    client.send({ type: 'run-end', runId: accepted[0], status: 'finished' });
    await delay(20);
    assert.equal((await client.start({ localRef: 'after-end' })).type, 'run-id');
});

test('a run-start whose acknowledgement was lost resumes to the same run id without a duplicate row', async (t) => {
    const { connect, registry } = await startIpc(t);
    const first = await connect();
    const welcome = await first.hello();
    first.send({ type: 'run-start', localRef: 'turn-1', kind: 'copilot-turn', title: 'Turn' });
    await delay(30);
    first.messages.length = 0;
    await first.close();
    const second = await connect();
    second.send({ type: 'resume', publisherId: welcome.publisherId, resumeToken: welcome.resumeToken, runs: [] });
    const resumed = await second.next('resumed');
    const runId = (await second.next('run-id')).runId;
    assert.deepEqual(resumed.runs, [{ runId, lastSeq: 0 }]);
    assert.equal((await second.start({ localRef: 'turn-1' })).runId, runId, 'a repeated run-start keeps its id');
    assert.equal(registry.list(ADMIN).length, 1);
    assert.equal(row(registry, runId).status, 'running');
});

test('resume moves runs and handles; the old connection loses all authority', async (t) => {
    const { connect, registry } = await startIpc(t);
    const old = await connect();
    const welcome = await old.hello();
    const handle = await claim(old, 'alice');
    const { runId } = await old.start({ localRef: 'one', ownerHandle: handle.ownerHandle });
    const fresh = await connect();
    fresh.send({ type: 'resume', publisherId: welcome.publisherId, resumeToken: welcome.resumeToken, runs: [{ runId, lastSeq: 0 }] });
    await fresh.next('resumed');
    await old.closedPromise;
    assert.equal(row(registry, runId).status, 'running', 'a takeover is not a disconnect');
    const moved = await fresh.start({ localRef: 'two', ownerHandle: handle.ownerHandle });
    assert.equal(row(registry, moved.runId).ownerState, 'verified', 'handles move with the incarnation');
    fresh.send({ type: 'run-event', runId, seq: 1, text: 'from the new connection' });
    await delay(20);
    const viewer = { chunks: [], writeHead() {}, write(chunk) { this.chunks.push(chunk); return true; }, on() {}, once() {}, removeListener() {}, end() {} };
    registry.attach(runId, ADMIN, viewer);
    assert.match(viewer.chunks.join(''), /from the new connection/);
    // The old connection is gone; nothing it sent can be accepted.
    assert.equal(old.closed, true);
});

test('disconnect marks runs reconnecting; resume dedups sequences, marks gaps and delivers outage run-ends', async (t) => {
    const { connect, registry } = await startIpc(t, { reconnectMs: 2000 });
    const first = await connect();
    const welcome = await first.hello();
    const one = await first.start({ localRef: 'one' });
    const two = await first.start({ localRef: 'two' });
    first.send({ type: 'run-event', runId: one.runId, seq: 1, text: 'alpha\n' });
    first.send({ type: 'run-event', runId: one.runId, seq: 2, text: 'beta\n' });
    await delay(20);
    await first.close();
    await delay(20);
    assert.equal(row(registry, one.runId).status, 'reconnecting');
    const second = await connect();
    second.send({ type: 'resume', publisherId: welcome.publisherId, resumeToken: welcome.resumeToken, runs: [] });
    const resumed = await second.next('resumed');
    assert.deepEqual(resumed.runs.find((item) => item.runId === one.runId), { runId: one.runId, lastSeq: 2 });
    assert.equal(row(registry, one.runId).status, 'running');
    second.send({ type: 'run-event', runId: one.runId, seq: 2, text: 'beta\n' });
    second.send({ type: 'run-event', runId: one.runId, seq: 5, text: 'epsilon\n' });
    second.send({ type: 'run-end', runId: two.runId, status: 'failed', reason: 'ended during outage' });
    await delay(30);
    const viewer = { chunks: [], writeHead() {}, write(chunk) { this.chunks.push(chunk); return true; }, on() {}, once() {}, removeListener() {}, end() {} };
    registry.attach(one.runId, ADMIN, viewer);
    const text = viewer.chunks.join('');
    assert.equal(text.match(/beta/gu).length, 1, 'duplicate sequence dropped');
    assert.match(text, /2 output event\(s\) were lost/u);
    assert.match(text, /epsilon/u);
    assert.deepEqual(row(registry, two.runId).exit, { reason: 'ended during outage' });
    assert.equal(row(registry, two.runId).status, 'failed');
});

test('without a resume the runs are lost; a stale or forged resume is rejected', async (t) => {
    const { connect, registry } = await startIpc(t, { reconnectMs: 50 });
    const first = await connect();
    const welcome = await first.hello();
    const { runId } = await first.start({ localRef: 'one' });
    const forged = await connect();
    forged.send({ type: 'resume', publisherId: welcome.publisherId, resumeToken: 'x'.repeat(32), runs: [] });
    assert.equal((await forged.next('resume-rejected')).type, 'resume-rejected');
    await forged.closedPromise;
    assert.equal(first.closed, false, 'a forged resume does not take over');
    await first.close();
    await delay(120);
    assert.equal(row(registry, runId).status, 'lost');
    assert.deepEqual(row(registry, runId).exit, { reason: 'publisher disconnected' });
    const late = await connect();
    late.send({ type: 'resume', publisherId: welcome.publisherId, resumeToken: welcome.resumeToken, runs: [] });
    await late.next('resume-rejected');
    await late.closedPromise;
});

test('controls are correlated by request id, never replayed, and pending ones become unknown on disconnect', async (t) => {
    const { connect, registry } = await startIpc(t, { reconnectMs: 2000 });
    const client = await connect();
    const welcome = await client.hello();
    const handle = await claim(client, 'alice');
    const { runId } = await client.start({ localRef: 'one', ownerHandle: handle.ownerHandle });
    const first = registry.message(runId, ALICE, 'first');
    const second = registry.message(runId, ALICE, 'second');
    const controlA = await client.next((message) => message.type === 'control' && message.message === 'first');
    const controlB = await client.next((message) => message.type === 'control' && message.message === 'second');
    assert.equal(controlA.action, 'message');
    assert.equal(controlA.runId, runId);
    // Another incarnation cannot answer this run's control.
    const intruder = await connect();
    await intruder.hello();
    intruder.send({ type: 'control-result', requestId: controlA.requestId, outcome: 'delivered' });
    client.send({ type: 'control-result', requestId: controlB.requestId, outcome: 'rejected', detail: 'busy' });
    client.send({ type: 'control-result', requestId: controlA.requestId, outcome: 'queued' });
    assert.deepEqual(await first, { ok: true, outcome: 'queued' });
    assert.deepEqual(await second, { ok: true, outcome: 'rejected', detail: 'busy' });
    // Pending control, then disconnect: unknown, and not resent on resume.
    const pending = registry.message(runId, ALICE, 'third');
    await client.next((message) => message.type === 'control' && message.message === 'third');
    await client.close();
    assert.deepEqual(await pending, { ok: true, outcome: 'unknown' });
    const resumed = await connect();
    resumed.send({ type: 'resume', publisherId: welcome.publisherId, resumeToken: welcome.resumeToken, runs: [] });
    await resumed.next('resumed');
    await delay(30);
    assert.equal(resumed.messages.filter((message) => message.type === 'control').length, 0);
    // Stop reaches the publisher; the run ends only on its run-end.
    assert.deepEqual(await registry.stop(runId, ADMIN), { ok: true });
    const stop = await resumed.next((message) => message.type === 'control' && message.action === 'stop');
    assert.equal(stop.runId, runId);
    assert.equal(row(registry, runId).status, 'running');
    // A control pending when the run ends resolves run_ended.
    const racing = registry.message(runId, ALICE, 'fourth');
    await resumed.next((message) => message.type === 'control' && message.message === 'fourth');
    resumed.send({ type: 'run-end', runId, status: 'stopped' });
    assert.deepEqual(await racing, { ok: true, outcome: 'run_ended' });
});

test('stop while the publisher is reconnecting is refused instead of queued', async (t) => {
    const { connect, registry } = await startIpc(t, { reconnectMs: 2000 });
    const client = await connect();
    await client.hello();
    const { runId } = await client.start({ localRef: 'one' });
    await client.close();
    await delay(20);
    await assert.rejects(registry.stop(runId, ADMIN), (error) => error.statusCode === 409);
});

test('a control without any answer times out as unknown', async (t) => {
    const { connect, registry } = await startIpc(t, { controlTimeoutMs: 50 });
    const client = await connect();
    await client.hello();
    const handle = await claim(client, 'alice');
    const { runId } = await client.start({ localRef: 'one', ownerHandle: handle.ownerHandle });
    assert.deepEqual(await registry.message(runId, ALICE, 'hello'), { ok: true, outcome: 'unknown' });
});

test('main.mjs always starts the production IPC listener and no server or copilot module imports tests', async () => {
    const source = await fs.readFile(new URL('../server/main.mjs', import.meta.url), 'utf8');
    assert.match(source, /^const liveSessionsIpc = await startProductionIpc\(\);$/mu);
    assert.doesNotMatch(source, /ROBOTEAM_LIVE_SESSIONS_SPIKE/u);
    const walk = async (directory) => (await Promise.all((await fs.readdir(directory, { withFileTypes: true })).map((entry) => {
        const child = new URL(`${entry.name}${entry.isDirectory() ? '/' : ''}`, directory);
        return entry.isDirectory() ? walk(child) : entry.name.endsWith('.mjs') ? [child] : [];
    }))).flat();
    const files = [...await walk(new URL('../server/', import.meta.url)), ...await walk(new URL('../copilot/src/', import.meta.url))];
    assert.ok(files.length > 100);
    for (const file of files) assert.doesNotMatch(await fs.readFile(file, 'utf8'), /['"`][./]*tests\//u, file.pathname);
});

test('close refuses to remove a socket path that was replaced after binding', async (t) => {
    const registry = new LiveSessionsRegistry();
    const { socketPath, cleanup } = await socketFixture();
    t.after(async () => { registry.close(); await cleanup(); });
    const server = new LiveSessionsIpcServer({ registry });
    await server.listen(socketPath);
    await fs.rm(socketPath);
    await fs.writeFile(socketPath, 'replacement');
    await assert.rejects(server.close(), /changed socket identity/);
    assert.equal(await fs.readFile(socketPath, 'utf8'), 'replacement');
});

// Owner handle lifecycle: unused handles are bounded and evicted oldest first,
// released on request, dropped with their last run, and expire after 24 h.
function clock() {
    let now = 1_700_000_000_000;
    return { now: () => now, advance: (ms) => { now += ms; } };
}

async function ownerStateOf(client, registry, handle, localRef) {
    const started = await client.start({ localRef, ownerHandle: handle });
    return row(registry, started.runId).ownerState;
}

test('one principal\'s unused claims never block another principal', async (t) => {
    const time = clock();
    const { connect, registry } = await startIpc(t, { now: time.now });
    const client = await connect();
    await client.hello();
    const alice = [];
    for (let index = 0; index < 64; index += 1) {
        const handle = await claim(client, 'alice');
        assert.equal(handle.type, 'owner-handle');
        alice.push(handle.ownerHandle);
    }
    time.advance(23 * 60 * 60 * 1000);
    const bob = await claim(client, 'bob');
    assert.equal(bob.type, 'owner-handle', 'bob is never refused');
    assert.equal(await ownerStateOf(client, registry, bob.ownerHandle, 'bob'), 'verified');
    assert.equal(await ownerStateOf(client, registry, alice[47], 'alice-old'), 'unverified', 'alice keeps only her newest 16 unused handles');
    assert.equal(await ownerStateOf(client, registry, alice[48], 'alice-new'), 'verified');
});

test('at the incarnation cap a new proof evicts the oldest unused handle', async (t) => {
    const { connect, registry } = await startIpc(t, { pendingClaims: 3 });
    const client = await connect();
    await client.hello();
    const handles = [];
    for (const user of ['a', 'b', 'c', 'd']) handles.push((await claim(client, user)).ownerHandle);
    assert.equal(await ownerStateOf(client, registry, handles[0], 'a'), 'unverified', 'the oldest unused handle was evicted');
    for (const [index, user] of ['b', 'c', 'd'].entries()) assert.equal(await ownerStateOf(client, registry, handles[index + 1], user), 'verified');
});

test('the per-principal cap evicts that principal\'s oldest unused handle only', async (t) => {
    const { connect, registry } = await startIpc(t, { principalPendingClaims: 2 });
    const client = await connect();
    await client.hello();
    const bob = (await claim(client, 'bob')).ownerHandle;
    const alice = [];
    for (let index = 0; index < 3; index += 1) alice.push((await claim(client, 'alice')).ownerHandle);
    assert.equal(await ownerStateOf(client, registry, alice[0], 'a0'), 'unverified');
    assert.equal(await ownerStateOf(client, registry, alice[1], 'a1'), 'verified');
    assert.equal(await ownerStateOf(client, registry, alice[2], 'a2'), 'verified');
    assert.equal(await ownerStateOf(client, registry, bob, 'b'), 'verified');
});

test('a released handle proves nothing; other handles are untouched', async (t) => {
    const { connect, registry } = await startIpc(t);
    const client = await connect();
    await client.hello();
    const released = (await claim(client, 'alice')).ownerHandle;
    const kept = (await claim(client, 'alice')).ownerHandle;
    client.send({ type: 'owner-release', ownerHandle: released });
    client.send({ type: 'owner-release', ownerHandle: 'unknown' });
    assert.equal(await ownerStateOf(client, registry, released, 'released'), 'unverified');
    assert.equal(await ownerStateOf(client, registry, kept, 'kept'), 'verified');
    const stranger = await connect();
    await stranger.hello();
    stranger.send({ type: 'owner-release', ownerHandle: kept });
    assert.equal(await ownerStateOf(client, registry, kept, 'kept-again'), 'verified', 'another incarnation cannot release a handle');
});

test('a used handle lives while one of its runs is live and is dropped with its last run', async (t) => {
    const { connect, registry } = await startIpc(t);
    const client = await connect();
    await client.hello();
    const handle = (await claim(client, 'alice')).ownerHandle;
    const first = await client.start({ localRef: 'turn', ownerHandle: handle });
    const second = await client.start({ localRef: 'task', ownerHandle: handle });
    assert.equal(row(registry, second.runId).ownerState, 'verified');
    client.send({ type: 'run-end', runId: first.runId, status: 'finished' });
    const third = await client.start({ localRef: 'while-live', ownerHandle: handle });
    assert.equal(row(registry, third.runId).ownerState, 'verified', 'a live run keeps the handle');
    client.send({ type: 'run-end', runId: second.runId, status: 'finished' });
    client.send({ type: 'run-end', runId: third.runId, status: 'finished' });
    await delay(20);
    assert.equal(await ownerStateOf(client, registry, handle, 'after'), 'unverified', 'the handle ended with its last run');
});

test('owner handles expire 24 h after the claim', async (t) => {
    const time = clock();
    const { connect, registry } = await startIpc(t, { now: time.now });
    const client = await connect();
    await client.hello();
    const kept = (await claim(client, 'alice')).ownerHandle;
    const expiring = (await claim(client, 'bob')).ownerHandle;
    time.advance(24 * 60 * 60 * 1000 - 1);
    assert.equal(await ownerStateOf(client, registry, kept, 'before'), 'verified');
    time.advance(1);
    assert.equal(await ownerStateOf(client, registry, expiring, 'after'), 'unverified');
});

test('the number of publisher incarnations is bounded; only the extra hello is refused', async (t) => {
    const { connect, registry } = await startIpc(t, { maxPublishers: 2 });
    const first = await connect();
    await first.hello();
    const second = await connect();
    await second.hello();
    const kept = await first.start({ localRef: 'kept' });
    const third = await connect();
    third.send({ type: 'hello', pid: process.pid });
    assert.deepEqual(await third.next('hello-refused'), { type: 'hello-refused', reason: 'publisher-limit' });
    await third.closedPromise;
    assert.equal(first.closed, false);
    assert.equal(row(registry, kept.runId).status, 'running');
});

test('a resume that replaces a live connection settles its pending controls as unknown at once', async (t) => {
    const { connect, registry } = await startIpc(t, { controlTimeoutMs: 60000 });
    const old = await connect();
    const welcome = await old.hello();
    const handle = (await claim(old, 'alice')).ownerHandle;
    const { runId } = await old.start({ localRef: 'one', ownerHandle: handle });
    const pending = registry.message(runId, ALICE, 'hello');
    await old.next((message) => message.type === 'control');
    const fresh = await connect();
    fresh.send({ type: 'resume', publisherId: welcome.publisherId, resumeToken: welcome.resumeToken, runs: [] });
    await fresh.next('resumed');
    const started = Date.now();
    assert.deepEqual(await pending, { ok: true, outcome: 'unknown' });
    assert.ok(Date.now() - started < 1000);
});

test('a failure after listen closes the listener and leaves no socket or directory', async (t) => {
    const registry = new LiveSessionsRegistry();
    const { socketPath, cleanup } = await socketFixture();
    t.after(async () => { registry.close(); await cleanup(); });
    const server = new LiveSessionsIpcServer({ registry, chmod: async () => { throw Object.assign(new Error('chmod refused'), { code: 'EPERM' }); } });
    await assert.rejects(server.listen(socketPath), { code: 'EPERM' });
    assert.equal(server.server.listening, false);
    assert.equal(server.closed, true);
    await assert.rejects(fs.lstat(socketPath), { code: 'ENOENT' });
    await assert.rejects(fs.lstat(path.dirname(socketPath)), { code: 'ENOENT' });
    await assert.rejects(ipcClient(socketPath));
});

test('only the full WebChat log path binds a transcript, read through the registry authorization', async (t) => {
    const reads = [];
    const { connect, registry } = await startIpc(t, { readTranscript: (sessionId, messageId) => { reads.push([sessionId, messageId]); return 'turn text'; } });
    const client = await connect();
    await client.hello();
    const handle = (await claim(client, 'alice')).ownerHandle;
    const session = '11111111-2222-4333-8444-555555555555';
    const message = '66666666-7777-4888-8999-aaaaaaaaaaaa';
    const full = `/base-agent-additional-server/roboTeamAgent/3001/webchat-logs/${session}/${message}`;
    for (const [localRef, transcriptUrl] of [['short', `/webchat-logs/${session}/${message}`], ['prefixed', `/x/../${full}`],
        ['suffix', `${full}/extra`], ['query', `${full}?x=1`], ['upper', full.toUpperCase()]]) {
        const started = await client.start({ localRef, ownerHandle: handle, transcriptUrl });
        assert.equal(row(registry, started.runId).transcriptUrl, undefined, localRef);
    }
    const bound = await client.start({ localRef: 'full', ownerHandle: handle, transcriptUrl: full });
    assert.ok(row(registry, bound.runId).transcriptUrl);
    assert.deepEqual(await registry.transcript(bound.runId, { principal: 'user:bob', canAdmin: false }), { ok: false, status: 404, error: 'live session not found' });
    assert.deepEqual(reads, [], 'a foreign viewer never triggers a read');
    assert.deepEqual(await registry.transcript(bound.runId, ALICE), { ok: true, text: 'turn text' });
    assert.deepEqual(reads, [[session, message]]);
});
