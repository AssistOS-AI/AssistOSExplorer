import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { LiveSessionsFullError, LiveSessionsRegistry, REGISTRY_DEFAULTS } from '../server/live-sessions/registry.mjs';
import { frameViolation, rowViolation } from '../server/live-sessions/contract.mjs';

const ALICE = { principal: 'user:alice', canAdmin: false };
const BOB = { principal: 'user:bob', canAdmin: false };
const ADMIN = { principal: 'user:root', canAdmin: true };
const URL_BASE = '/base-agent-additional-server/roboTeamAgent/3001';
const HOUR = 60 * 60 * 1000;

// A response double: write() returns `accept`, writableLength grows while
// the peer is not draining, and every chunk is recorded.
class FakeResponse extends EventEmitter {
    constructor({ accept = true } = {}) {
        super();
        this.accept = accept;
        this.chunks = [];
        this.writableLength = 0;
        this.ended = false;
        this.destroyed = false;
    }
    writeHead(status, headers) { this.status = status; this.headers = headers; }
    write(chunk) {
        this.chunks.push(chunk);
        if (!this.accept) this.writableLength += Buffer.byteLength(chunk);
        return this.accept;
    }
    drain() { this.accept = true; this.writableLength = 0; this.emit('drain'); }
    end() { this.ended = true; this.emit('close'); }
    destroy() { this.destroyed = true; this.emit('close'); }
    text() { return this.chunks.join(''); }
}

function parseFrames(text) {
    return text.split('\n\n').filter(Boolean).filter((block) => !block.startsWith(':')).map((block) => {
        const frame = {};
        for (const line of block.split('\n')) {
            const index = line.indexOf(': ');
            frame[line.slice(0, index)] = line.slice(index + 2);
        }
        return { id: frame.id === undefined ? null : Number(frame.id), event: frame.event, data: JSON.parse(frame.data) };
    });
}

function registry(options = {}) {
    let clock = 1_700_000_000_000;
    const logs = [];
    const instance = new LiveSessionsRegistry({ now: () => clock, log: (line) => logs.push(line), urlBase: URL_BASE, ...options });
    return { registry: instance, logs, advance: (ms) => { clock += ms; }, now: () => clock };
}

function admitAlice(target, extra = {}) {
    return target.admit({ kind: 'robot-task', title: 'Robot task', detail: 'simple', cwdDisplay: 'project', access: 'rw', ownerState: 'verified',
        ownerPrincipal: 'user:alice', controls: { message: async () => 'delivered', stop: async () => {} }, ...extra }).id;
}

test('byte and event rollover announce replay-truncated before the whole ring', () => {
    for (const [name, options, chunk, count] of [
        ['bytes', { ringBytes: 4096 }, 'x'.repeat(1000), 10],
        ['events', { ringEvents: 5 }, 'line', 12],
    ]) {
        const { registry: target } = registry(options);
        const id = admitAlice(target);
        for (let index = 0; index < count; index += 1) target.output(id, `${index}:${chunk}`);
        const res = new FakeResponse();
        assert.deepEqual(target.attach(id, ALICE, res), { ok: true }, name);
        const frames = parseFrames(res.text());
        assert.equal(frames[0].event, 'replay-truncated', name);
        assert.deepEqual(frames[0].data, {}, name);
        const outputs = frames.filter((frame) => frame.event === 'output');
        assert.ok(outputs.length < count, `${name} ring rolled over`);
        assert.equal(outputs.at(-1).id, count, `${name} keeps the newest frame`);
        assert.deepEqual(outputs.map((frame) => frame.id), outputs.map((_, index) => count - outputs.length + 1 + index), `${name} contiguous`);
        for (const frame of frames) assert.equal(frameViolation(frame.event, frame.data), null, `${name} ${frame.event}`);
    }
    // Without rollover, no marker.
    const { registry: target } = registry();
    const id = admitAlice(target);
    target.output(id, 'one');
    const res = new FakeResponse();
    target.attach(id, ALICE, res);
    assert.deepEqual(parseFrames(res.text()).map((frame) => frame.event), ['output', 'status']);
});

test('Last-Event-ID inside the ring replays the delta; stale, future or malformed cursors resync', () => {
    const { registry: target } = registry({ ringEvents: 4 });
    const id = admitAlice(target);
    for (let index = 1; index <= 6; index += 1) target.output(id, `line ${index}`);
    const ids = (cursor) => {
        const res = new FakeResponse();
        target.attach(id, ALICE, res, cursor);
        const frames = parseFrames(res.text());
        res.end();
        return frames.filter((frame) => frame.event !== 'status').map((frame) => frame.event === 'output' ? frame.id : frame.event);
    };
    assert.deepEqual(ids('4'), [5, 6]);
    assert.deepEqual(ids('2'), [3, 4, 5, 6]);
    assert.deepEqual(ids('6'), []);
    assert.deepEqual(ids('1'), ['resync', 3, 4, 5, 6]);
    assert.deepEqual(ids('7'), ['resync', 3, 4, 5, 6]);
    assert.deepEqual(ids('abc'), ['resync', 3, 4, 5, 6]);
    assert.deepEqual(ids(''), ['replay-truncated', 3, 4, 5, 6]);
});

test('a finished run stays listed until one hour after it ended', () => {
    const { registry: target, advance } = registry();
    const id = admitAlice(target);
    advance(5000);
    assert.equal(target.end(id, 'finished', { reason: 'completed', code: 0 }), true);
    advance(HOUR - 1);
    const rows = target.list(ALICE);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].status, 'finished');
    assert.deepEqual(rows[0].exit, { reason: 'completed', code: 0 });
    assert.deepEqual(rows[0].capabilities, { watch: true, input: false, stop: false, message: false });
    advance(1);
    assert.deepEqual(target.list(ALICE), []);
    assert.deepEqual(target.list(ADMIN), []);
});

test('users see only their own verified runs; administrators see every run but message none they do not own', () => {
    const { registry: target } = registry();
    const alice = admitAlice(target);
    const system = target.admit({ kind: 'workflow-phase', title: 'Phase', ownerState: 'system', controls: { stop: async () => {} } }).id;
    const unverified = target.admit({ kind: 'copilot-turn', title: 'Turn', ownerState: 'unverified' }).id;
    assert.deepEqual(target.list(ALICE).map((row) => row.id), [alice]);
    assert.deepEqual(target.list(BOB), []);
    assert.deepEqual(new Set(target.list(ADMIN).map((row) => row.id)), new Set([alice, system, unverified]));
    const own = target.list(ALICE)[0];
    assert.equal(own.isOwner, true);
    assert.equal(own.access, 'rw');
    assert.equal(own.ownerLabel, 'alice');
    assert.deepEqual(own.capabilities, { watch: true, input: false, stop: true, message: true });
    assert.equal(own.viewUrl, `${URL_BASE}/live-sessions/${alice}`);
    const adminRows = Object.fromEntries(target.list(ADMIN).map((row) => [row.id, row]));
    assert.equal(adminRows[alice].isOwner, false);
    // access is the run's folder access, the same for every viewer.
    assert.equal(adminRows[alice].access, 'rw');
    assert.equal(adminRows[system].access, 'ro', 'folder access defaults to read-only');
    assert.deepEqual(adminRows[alice].capabilities, { watch: true, input: false, stop: true, message: false });
    assert.equal(adminRows[system].ownerLabel, 'system');
    assert.equal(adminRows[unverified].ownerLabel, 'owner unverified');
    assert.equal(adminRows[unverified].capabilities.stop, false);
    for (const row of target.list(ADMIN)) assert.equal(rowViolation(row, 'roboTeamAgent'), null, row.id);
    // Hidden runs are absent, not forbidden.
    assert.equal(target.authorize(system, ALICE).status, 404);
    assert.equal(target.authorize(alice, BOB).status, 404);
    assert.equal(target.authorize('rt_unknown', ADMIN).status, 404);
    assert.equal(target.authorize('../x', ADMIN).status, 404);
    assert.equal(target.authorize(alice, ADMIN, 'message').status, 403);
    assert.equal(target.authorize(alice, ADMIN, 'stop').ok, true);
    // A verified run needs a signed principal.
    assert.throws(() => target.admit({ kind: 'robot-task', title: 'x', ownerState: 'verified', ownerPrincipal: 'alice' }), /signed principal/);
});

test('the live cap refuses the 257th run without evicting; finished runs are capped oldest first', () => {
    const { registry: target, advance } = registry();
    const ids = [];
    for (let index = 0; index < 256; index += 1) ids.push(admitAlice(target));
    assert.throws(() => admitAlice(target), LiveSessionsFullError);
    assert.equal(target.list(ADMIN).length, 256);
    assert.ok(ids.every((id) => target.get(id) && !target.get(id).ended));
    for (const id of ids) { advance(1); target.end(id, 'finished'); }
    const extra = admitAlice(target);
    advance(1);
    target.end(extra, 'failed', { reason: 'boom' });
    assert.equal(target.get(ids[0]), null, 'oldest finished run evicted');
    assert.notEqual(target.get(ids[1]), null);
    assert.notEqual(target.get(extra), null);
    assert.equal(target.list(ADMIN).length, 256);
});

test('a run ends exactly once and its viewers receive the exit frame', () => {
    const { registry: target } = registry();
    const id = admitAlice(target);
    const res = new FakeResponse();
    target.attach(id, ALICE, res);
    target.output(id, 'working');
    assert.equal(target.end(id, 'stopped', { reason: 'stopped\nby user', signal: 'SIGTERM' }), true);
    assert.equal(target.end(id, 'failed'), false);
    assert.equal(target.output(id, 'late'), false);
    const frames = parseFrames(res.text());
    assert.deepEqual(frames.at(-1), { id: null, event: 'exit', data: { status: 'stopped', exit: { reason: 'stopped', signal: 'SIGTERM' } } });
    assert.equal(frames.filter((frame) => frame.event === 'exit').length, 1);
    assert.equal(res.ended, true);
    assert.equal(target.get(id).viewerCount, 0);
    // Watching a finished run replays it and ends with the same exit.
    const later = new FakeResponse();
    target.attach(id, ALICE, later);
    const replay = parseFrames(later.text());
    assert.deepEqual(replay.map((frame) => frame.event), ['output', 'exit']);
    assert.equal(later.ended, true);
});

test('viewers are paced: queued frames wait for drain, slow viewers are cut off, the run continues', async () => {
    const { registry: target } = registry({ viewerQueueBytes: 4096, drainTimeoutMs: 20 });
    const id = admitAlice(target);
    const res = new FakeResponse({ accept: false });
    target.attach(id, ALICE, res);
    const written = res.chunks.length;
    target.output(id, 'a'.repeat(100));
    target.output(id, 'b'.repeat(100));
    assert.equal(res.chunks.length, written, 'nothing is written while the peer is not draining');
    assert.ok(res.writableLength > 0);
    res.drain();
    assert.match(res.text(), /bbbb/);
    assert.equal(target.get(id).viewerCount, 1);
    // Slow by queued bytes.
    res.accept = false;
    res.write('');
    for (let index = 0; index < 50; index += 1) target.output(id, 'c'.repeat(200));
    assert.equal(res.destroyed, true);
    assert.equal(target.get(id).viewerCount, 0);
    assert.equal(target.output(id, 'still running'), true);
    // Slow by drain timeout.
    const stalled = new FakeResponse({ accept: false });
    target.attach(id, ALICE, stalled);
    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.equal(stalled.destroyed, true);
    assert.equal(target.get(id).ended, false);
});

test('viewer quotas are 8 per run and 64 in total', () => {
    const { registry: target } = registry();
    const first = admitAlice(target);
    const responses = [];
    for (let index = 0; index < 8; index += 1) {
        const res = new FakeResponse();
        assert.equal(target.attach(first, ALICE, res).ok, true);
        responses.push(res);
    }
    assert.equal(target.attach(first, ALICE, new FakeResponse()).status, 429);
    responses[0].emit('close');
    assert.equal(target.attach(first, ALICE, new FakeResponse()).ok, true, 'a closed viewer frees its slot');
    const runs = Array.from({ length: 7 }, () => admitAlice(target));
    for (const id of runs) for (let index = 0; index < 8; index += 1) target.attach(id, ALICE, new FakeResponse());
    assert.equal(target.viewerTotal, 64);
    assert.equal(target.attach(admitAlice(target), ALICE, new FakeResponse()).status, 429);
});

test('heartbeat comments reach every viewer', () => {
    const { registry: target } = registry();
    const id = admitAlice(target);
    const res = new FakeResponse();
    target.attach(id, ALICE, res);
    target.heartbeat();
    assert.ok(res.text().endsWith(': keepalive\n\n'));
    assert.ok(target.heartbeatTimer, 'the periodic heartbeat runs while viewers exist');
    res.emit('close');
    assert.equal(target.heartbeatTimer, null);
});

test('messages are owner-only, typed, and concurrent receipts stay with their message', async () => {
    const { registry: target } = registry();
    const pending = new Map();
    const id = admitAlice(target, { controls: { message: (text) => new Promise((resolve, reject) => pending.set(text, { resolve, reject })), stop: async () => {} } });
    assert.equal((await target.message(id, ADMIN, 'hi')).status, 403);
    assert.equal((await target.message(id, BOB, 'hi')).status, 404);
    assert.equal((await target.message(id, ALICE, '')).status, 400);
    assert.equal((await target.message(id, ALICE, 'x'.repeat(32769))).status, 400);
    const first = target.message(id, ALICE, 'first');
    const second = target.message(id, ALICE, 'second');
    const third = target.message(id, ALICE, 'third');
    const fourth = target.message(id, ALICE, 'fourth');
    const fifth = target.message(id, ALICE, 'fifth');
    await new Promise((resolve) => setImmediate(resolve));
    pending.get('second').resolve('queued');
    pending.get('first').resolve('delivered');
    pending.get('third').reject(Object.assign(new Error('busy'), { liveOutcome: 'rejected' }));
    pending.get('fourth').reject(Object.assign(new Error('timeout'), { liveOutcome: 'unknown' }));
    pending.get('fifth').reject(new Error('anything else'));
    assert.deepEqual(await first, { ok: true, outcome: 'delivered' });
    assert.deepEqual(await second, { ok: true, outcome: 'queued' });
    assert.deepEqual(await third, { ok: true, outcome: 'rejected', detail: 'busy' });
    assert.deepEqual(await fourth, { ok: true, outcome: 'unknown' });
    assert.deepEqual(await fifth, { ok: true, outcome: 'unknown' });
    target.end(id, 'finished');
    assert.deepEqual(await target.message(id, ALICE, 'late'), { ok: true, outcome: 'run_ended' });
});

test('stop is for the owner or an administrator and calls the control once', async () => {
    const { registry: target } = registry();
    let stops = 0;
    const id = admitAlice(target, { controls: { stop: async () => { stops += 1; } } });
    assert.equal((await target.stop(id, BOB)).status, 404);
    assert.deepEqual(await target.stop(id, ADMIN), { ok: true });
    assert.equal(stops, 1);
    assert.equal(target.get(id).ended, false, 'the run ends only when its lifecycle reports it');
    target.end(id, 'stopped');
    assert.equal((await target.stop(id, ALICE)).status, 409);
    assert.equal(stops, 1);
});

test('an invalid row is dropped and logged instead of sent', () => {
    const { registry: target, logs } = registry();
    const good = admitAlice(target);
    const bad = admitAlice(target);
    const original = target._row.bind(target);
    target._row = (run, viewer) => run.id === bad ? { ...original(run, viewer), extra: true } : original(run, viewer);
    assert.deepEqual(target.list(ALICE).map((row) => row.id), [good]);
    assert.deepEqual(logs, [`[live-sessions] dropped invalid row ${bad}: keys`]);
});

test('row text is cleaned and URLs outside the agent are never published', () => {
    const { registry: target } = registry({ urlBase: '/base-agent-additional-server/otherAgent/3001' });
    const id = target.admit({ kind: 'robot-task', title: `tab\there\u0007${'é'.repeat(200)}`, ownerState: 'verified', ownerPrincipal: 'user:alice',
        transcript: async () => 'x' }).id;
    const [row] = target.list(ALICE);
    assert.equal(row.id, id);
    assert.equal(row.viewUrl, undefined);
    assert.equal(row.transcriptUrl, undefined);
    assert.ok(Buffer.byteLength(row.title) <= 256);
    assert.equal(rowViolation(row, 'roboTeamAgent'), null);
});

test('escape-heavy output is split into frames a fast viewer can take, and finished replays still end with exit', () => {
    const { registry: target } = registry();
    const id = admitAlice(target);
    const live = new FakeResponse();
    target.attach(id, ALICE, live);
    const ansi = '\u001b[0m'.repeat(Math.floor((1024 * 1024) / 4));
    assert.equal(target.output(id, ansi), true);
    assert.equal(live.destroyed, false, 'a fast viewer survives 1 MiB of escape-heavy text');
    const frames = parseFrames(live.text()).filter((frame) => frame.event === 'output');
    assert.ok(frames.length > 1, 'the text was split');
    assert.equal(frames.map((frame) => frame.data.text).join(''), ansi.slice(-frames.map((frame) => frame.data.text).join('').length));
    for (const chunk of live.chunks) assert.ok(Buffer.byteLength(chunk) < REGISTRY_DEFAULTS.viewerQueueBytes / 4, 'every frame is small');
    const ringBytes = target.runs.get(id).ring.reduce((sum, entry) => sum + Buffer.byteLength(entry.frame), 0);
    assert.equal(target.runs.get(id).ringBytes, ringBytes, 'ring accounting uses encoded bytes');
    assert.ok(ringBytes <= REGISTRY_DEFAULTS.ringBytes);
    target.end(id, 'finished');
    for (const cursor of [undefined, '1']) {
        const replay = new FakeResponse();
        target.attach(id, ALICE, replay, cursor);
        assert.equal(replay.destroyed, false, `replay ${cursor}`);
        assert.equal(replay.ended, true, `replay ${cursor}`);
        assert.equal(parseFrames(replay.text()).at(-1).event, 'exit', `replay ${cursor}`);
    }
    // Surrogate pairs are never split.
    const target2 = registry().registry;
    const emoji = admitAlice(target2);
    const res = new FakeResponse();
    target2.attach(emoji, ALICE, res);
    target2.output(emoji, `a${'😀'.repeat(40000)}`);
    const text = parseFrames(res.text()).filter((frame) => frame.event === 'output').map((frame) => frame.data.text);
    assert.ok(text.every((part) => !/[\ud800-\udbff]$/u.test(part) && !/^[\udc00-\udfff]/u.test(part)));
    assert.equal(text.join(''), `a${'😀'.repeat(40000)}`);
});

test('attach and transcript on a run the viewer may not see are absent, write nothing and call nothing', async () => {
    const { registry: target } = registry();
    let transcriptCalls = 0;
    const alice = admitAlice(target, { transcript: async () => { transcriptCalls += 1; return 'secret'; } });
    const system = target.admit({ kind: 'workflow-phase', title: 'Phase', ownerState: 'system' }).id;
    const unverified = target.admit({ kind: 'copilot-turn', title: 'Turn', ownerState: 'unverified' }).id;
    for (const [viewer, id] of [[BOB, alice], [ALICE, system], [ALICE, unverified]]) {
        const res = new FakeResponse();
        assert.equal(target.attach(id, viewer, res).status, 404);
        assert.equal(res.status, undefined, 'no headers written');
        assert.deepEqual(res.chunks, []);
        assert.equal(target.get(id).viewerCount, 0);
    }
    assert.equal(target.viewerTotal, 0);
    assert.equal((await target.transcript(alice, BOB)).status, 404);
    assert.equal(transcriptCalls, 0, 'the resolver is never called for a hidden run');
    assert.deepEqual(await target.transcript(alice, ALICE), { ok: true, text: 'secret' });
    assert.equal(transcriptCalls, 1);
});

test('the default heartbeat is at most 20 s and a closed registry never restarts it', () => {
    assert.ok(REGISTRY_DEFAULTS.heartbeatMs <= 20000);
    assert.ok(new LiveSessionsRegistry().limits.heartbeatMs <= 20000);
    const { registry: target } = registry();
    const id = admitAlice(target);
    target.close();
    target.attach(id, ALICE, new FakeResponse());
    assert.equal(target.heartbeatTimer, null);
});

test('a message after the run ended does not change its activity time', async () => {
    const { registry: target, advance } = registry();
    const id = admitAlice(target);
    target.end(id, 'finished');
    const before = target.list(ALICE)[0].lastActivityAt;
    advance(1000);
    await target.message(id, ALICE, 'late');
    assert.equal(target.list(ALICE)[0].lastActivityAt, before);
});
