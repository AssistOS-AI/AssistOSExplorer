import assert from 'node:assert/strict';
import test from 'node:test';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { PRUNE_BATCH } from '../server/stateReplay.mjs';
import {
    LIMITS, PROVIDER, WORKSPACE, admitRequest, count, expectCode, makeTempDir, newId, openStore, rawDb, readyRobot, syntheticContext
} from './helpers/synthetic.mjs';

// S1x durable token-replay keys. Contexts and runtime are SYNTHETIC (state evidence only).

const EXTENDED = Object.freeze({ ...LIMITS, bindings: 8, controls: 8, tokenReplayEntries: 16 });
const ROBOTS = `workspace:${WORKSPACE}`;
const T0 = 1_800_000_000_000;

function key() {
    return crypto.createHash('sha256').update(crypto.randomBytes(16)).digest('base64url');
}

function item(retainUntilMs = T0 + 60_000, k = key()) {
    return { key: k, retainUntilMs };
}

function clocked(dir, limits = EXTENDED, create = true) {
    const clock = { now: T0 };
    const store = openStore(dir, { limits, now: () => clock.now, create });
    return { store, clock };
}

function replayed(fn) {
    assert.throws(fn, (error) => {
        assert.equal(error.name, 'WorkerStateError');
        assert.equal(error.code, 'forbidden');
        assert.equal(error.reason, 'token_replayed');
        return true;
    });
}

test('consumption is all-or-nothing; a duplicate key within one request is refused', (t) => {
    const dir = makeTempDir(t);
    const { store } = clocked(dir);
    t.after(() => store.close());
    const seen = item();
    store.consumeTokenIds({ items: [seen] });
    const fresh = item();
    replayed(() => store.consumeTokenIds({ items: [fresh, seen] }));
    assert.equal(count(dir, 'token_replay'), 1);
    replayed(() => store.consumeTokenIds({ items: [fresh, { ...fresh }] }));
    assert.equal(count(dir, 'token_replay'), 1);
    assert.deepEqual(store.consumeTokenIds({ items: [fresh, item()] }), { consumed: 2 });
    assert.equal(count(dir, 'token_replay'), 3);
    for (const bad of [undefined, {}, { items: [] }, { items: [{ key: 'short', retainUntilMs: T0 }] }, { items: [{ key: key(), retainUntilMs: 1.5 }] },
        { items: [{ key: key(), retainUntilMs: T0, extra: 1 }] }, { items: Array.from({ length: 9 }, () => item()) }, { items: [item()], other: 1 }]) {
        expectCode(assert, () => store.consumeTokenIds(bad), 'invalid_request');
    }
});

test('a consumed key stays refused across close and reopen until its retention ends, then is pruned', (t) => {
    const dir = makeTempDir(t);
    let { store, clock } = clocked(dir);
    const kept = item(T0 + 1000);
    store.consumeTokenIds({ items: [kept] });
    store.close();
    ({ store, clock } = clocked(dir, EXTENDED, false));
    t.after(() => store.close());
    clock.now = T0 + 999;
    replayed(() => store.consumeTokenIds({ items: [kept] }));
    clock.now = T0 + 1000;
    // Expired: the key may be recorded again with a new retention end.
    store.consumeTokenIds({ items: [{ ...kept, retainUntilMs: T0 + 5000 }] });
    replayed(() => store.consumeTokenIds({ items: [{ ...kept, retainUntilMs: T0 + 6000 }] }));
    store.close();
    // Pruning is bounded: at most PRUNE_BATCH expired rows per consumption.
    const db = rawDb(dir);
    try {
        const insert = db.prepare('INSERT INTO token_replay (key, retain_until_ms) VALUES (?, ?)');
        for (let index = 0; index < PRUNE_BATCH + 10; index += 1) insert.run(key(), T0 + 2000);
    } finally {
        db.close();
    }
    ({ store, clock } = clocked(dir, { ...EXTENDED, tokenReplayEntries: 1000 }, false));
    t.after(() => store.close());
    clock.now = T0 + 3000;
    store.consumeTokenIds({ items: [item(T0 + 9000)] });
    // 1 live (T0+5000) + 10 expired left over + 1 new.
    assert.equal(count(dir, 'token_replay'), 12);
});

test('a full replay table refuses new keys and never evicts a live one; an absent limit refuses', (t) => {
    const dir = makeTempDir(t);
    const { store } = clocked(dir, { ...EXTENDED, tokenReplayEntries: 2 });
    t.after(() => store.close());
    const first = item();
    store.consumeTokenIds({ items: [first, item()] });
    expectCode(assert, () => store.consumeTokenIds({ items: [item()] }), 'capacity_exceeded');
    replayed(() => store.consumeTokenIds({ items: [first] }));
    assert.equal(count(dir, 'token_replay'), 2);
    const base = makeTempDir(t);
    const baseStore = openStore(base);
    t.after(() => baseStore.close());
    expectCode(assert, () => baseStore.consumeTokenIds({ items: [item()] }), 'capacity_exceeded');
});

test('mutating methods consume in the same transaction: committed keys stay consumed, refused operations roll back', (t) => {
    const dir = makeTempDir(t);
    const { store } = clocked(dir);
    t.after(() => store.close());
    const robotId = readyRobot(store, syntheticContext({ robotOwnerId: ROBOTS, scope: 'scope-robots' }));
    const alice = syntheticContext({ originKey: 'user:alice', ownerId: 'user:alice', scope: 'scope-alice', robotOwnerId: ROBOTS });
    const request = admitRequest(robotId, {}, alice);
    const committed = item();
    const admitted = store.admit(alice, request, { items: [committed] });
    const receipts = count(dir, 'receipt');
    // The same request under the consumed key is refused before receipt replay.
    replayed(() => store.admit(alice, request, { items: [committed] }));
    // A fresh key replays the recorded admission without a new receipt.
    assert.deepEqual(store.admit(alice, request, { items: [item()] }), admitted);
    assert.equal(count(dir, 'receipt'), receipts);
    // A refused admission (unknown robot) rolls its consumption back with it.
    const refusedKey = item();
    expectCode(assert, () => store.admit(alice, admitRequest(newId(), {}, alice), { items: [refusedKey] }), 'not_found');
    store.consumeTokenIds({ items: [refusedKey] });
    replayed(() => store.consumeTokenIds({ items: [refusedKey] }));
    // Binding, control and lifecycle methods consume the same way.
    const bindKey = item();
    store.registerBinding(syntheticContext({ originNamespace: 'coordinator:svc1', originKey: 'owner:user:alice', ownerId: 'user:alice', scope: 'scope-bind' }),
        { operationId: newId(), bindingId: 'flow1', kind: 'flow' }, { items: [bindKey] });
    replayed(() => store.consumeTokenIds({ items: [bindKey] }));
    const controlKey = item();
    store.controlReference(alice, { referenceId: admitted.reference.id, operationId: newId(), op: 'stop' }, { items: [controlKey] });
    replayed(() => store.consumeTokenIds({ items: [controlKey] }));
    const lifecycleKey = item();
    store.beginProvision(syntheticContext({ robotOwnerId: ROBOTS, scope: 'scope-robots' }), { operationId: newId(), name: 'Second', configuration: { backend: 'synthetic' } }, { items: [lifecycleKey] });
    replayed(() => store.consumeTokenIds({ items: [lifecycleKey] }));
    expectCode(assert, () => store.admit(alice, request, { items: [] }), 'invalid_request');
});

test('the replay key commits atomically with the admission it belongs to (crash right after commit)', (t) => {
    const dir = makeTempDir(t);
    const setup = openStore(dir, { limits: EXTENDED });
    const robotId = readyRobot(setup, syntheticContext({ robotOwnerId: ROBOTS, scope: 'scope-robots' }));
    setup.close();
    // Test-only fault hook: the process "dies" immediately after the admit transaction commits,
    // before anything else could run in a later transaction.
    const store = openStore(dir, { limits: EXTENDED, create: false, faults: { afterCommit: (label) => { if (label === 'admit') throw new Error('crash after commit'); } } });
    t.after(() => store.close());
    const alice = syntheticContext({ originKey: 'user:alice', ownerId: 'user:alice', scope: 'scope-alice', robotOwnerId: ROBOTS });
    const request = admitRequest(robotId, {}, alice);
    const consumed = item(Date.now() + 60_000);
    assert.throws(() => store.admit(alice, request, { items: [consumed] }), /crash after commit/);
    const db = rawDb(dir, { readOnly: true });
    try {
        assert.equal(db.prepare("SELECT COUNT(*) AS c FROM receipt WHERE op_type = 'admit' AND operation_id = ?").get(request.operationId).c, 1);
        assert.equal(db.prepare('SELECT COUNT(*) AS c FROM token_replay WHERE key = ?').get(consumed.key).c, 1);
    } finally {
        db.close();
    }
});

test('F2: a key that would be expired on arrival is refused, never a silent pass', (t) => {
    const dir = makeTempDir(t);
    const { store } = clocked(dir);
    t.after(() => store.close());
    expectCode(assert, () => store.consumeTokenIds({ items: [item(T0)] }), 'invalid_request');
    expectCode(assert, () => store.consumeTokenIds({ items: [item(T0 + 60_000), item(T0 - 1)] }), 'invalid_request');
    assert.equal(count(dir, 'token_replay'), 0);
    const robotId = readyRobot(store, syntheticContext({ robotOwnerId: ROBOTS, scope: 'scope-robots' }));
    const alice = syntheticContext({ originKey: 'user:alice', ownerId: 'user:alice', scope: 'scope-alice', robotOwnerId: ROBOTS });
    expectCode(assert, () => store.admit(alice, admitRequest(robotId, {}, alice), { items: [item(1)] }), 'invalid_request');
    assert.equal(count(dir, 'admission'), 0);
    assert.equal(count(dir, 'token_replay'), 0);
});

test('R5: bind and control roll back consumption when refused; a same-token retry is refused, a fresh-token retry replays the record', (t) => {
    const dir = makeTempDir(t);
    const { store } = clocked(dir);
    t.after(() => store.close());
    const binder = syntheticContext({ originNamespace: 'coordinator:svc1', originKey: 'owner:user:alice', ownerId: 'user:alice', scope: 'scope-bind' });
    // Refused (missing parent): rolled back, so the key is still unconsumed afterwards.
    const refusedBind = item();
    expectCode(assert, () => store.registerBinding(syntheticContext({ originNamespace: 'coordinator:svc1', originKey: 'binding:none', ownerId: 'user:alice', scope: 'scope-x' }),
        { operationId: newId(), bindingId: 'child', kind: 'flow', parentBindingId: 'none' }, { items: [refusedBind] }), 'not_found');
    store.consumeTokenIds({ items: [refusedBind] });
    const bindRequest = { operationId: newId(), bindingId: 'flow1', kind: 'flow' };
    const bindKey = item();
    const bound = store.registerBinding(binder, bindRequest, { items: [bindKey] });
    replayed(() => store.registerBinding(binder, { ...bindRequest }, { items: [bindKey] }));
    assert.deepEqual(store.registerBinding(binder, { ...bindRequest }, { items: [item()] }), bound);
    assert.equal(count(dir, 'binding'), 1);
    const robotId = readyRobot(store, syntheticContext({ robotOwnerId: ROBOTS, scope: 'scope-robots' }));
    const alice = syntheticContext({ originKey: 'user:alice', ownerId: 'user:alice', scope: 'scope-alice', robotOwnerId: ROBOTS });
    const admitted = store.admit(alice, admitRequest(robotId, {}, alice));
    const bob = syntheticContext({ originKey: 'user:bob', ownerId: 'user:bob', scope: 'scope-bob' });
    const refusedControl = item();
    expectCode(assert, () => store.controlReference(bob, { referenceId: admitted.reference.id, operationId: newId(), op: 'stop' }, { items: [refusedControl] }), 'not_found');
    store.consumeTokenIds({ items: [refusedControl] });
    const stop = { referenceId: admitted.reference.id, operationId: newId(), op: 'stop' };
    const stopKey = item();
    const stopped = store.controlReference(alice, stop, { items: [stopKey] });
    replayed(() => store.controlReference(alice, { ...stop }, { items: [stopKey] }));
    assert.deepEqual(store.controlReference(alice, { ...stop }, { items: [item()] }), stopped);
    assert.equal(count(dir, 'reference_control'), 1);
});

// Inline SYNTHETIC child (the shared stateChild helper opens base limits without the replay
// table limit): opens the store, prints "ready", waits for "go", consumes one key.
const CHILD = `
import readline from 'node:readline';
import { openWorkerState } from ${JSON.stringify(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'server', 'workerState.mjs'))};
import { syntheticRuntime } from ${JSON.stringify(path.join(path.dirname(fileURLToPath(import.meta.url)), 'helpers', 'synthetic.mjs'))};
const spec = JSON.parse(process.argv[1]);
const store = openWorkerState({ dataDir: spec.dir, workspaceId: spec.workspace, provider: spec.provider, limits: spec.limits, runtime: syntheticRuntime() });
process.stdout.write('ready\\n');
readline.createInterface({ input: process.stdin }).once('line', () => {
    let output;
    try { output = { ok: true, result: store.consumeTokenIds({ items: spec.items }) }; }
    catch (error) { output = { ok: false, code: error.code, reason: error.reason }; }
    store.close();
    process.stdout.write(JSON.stringify(output) + '\\n');
    process.exit(0);
});
`;

function startChild(spec) {
    const child = spawn(process.execPath, ['--input-type=module', '-e', CHILD, JSON.stringify(spec)], { stdio: ['pipe', 'pipe', 'pipe'] });
    const lines = [];
    const waiters = [];
    readline.createInterface({ input: child.stdout }).on('line', (line) => {
        if (waiters.length > 0) waiters.shift()(line);
        else lines.push(line);
    });
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    const next = () => new Promise((resolve) => (lines.length > 0 ? resolve(lines.shift()) : waiters.push(resolve)));
    const exited = new Promise((resolve) => child.on('close', resolve));
    return { child, next, exited, stderr: () => stderr };
}

test('two processes racing one key: exactly one consumes it', async (t) => {
    const dir = makeTempDir(t);
    openStore(dir, { limits: EXTENDED }).close();
    const shared = item(Date.now() + 60_000);
    const spec = { dir, workspace: WORKSPACE, provider: PROVIDER, limits: EXTENDED, items: [shared] };
    const children = [startChild(spec), startChild(spec)];
    for (const entry of children) {
        const first = await Promise.race([entry.next(), entry.exited.then(() => 'exited')]);
        assert.equal(first, 'ready', entry.stderr().slice(0, 300));
    }
    for (const entry of children) entry.child.stdin.write('go\n');
    const results = [];
    for (const entry of children) {
        results.push(JSON.parse(await entry.next()));
        await entry.exited;
    }
    const wins = results.filter((result) => result.ok);
    const losses = results.filter((result) => !result.ok);
    assert.equal(wins.length, 1, JSON.stringify(results));
    assert.deepEqual(losses, [{ ok: false, code: 'forbidden', reason: 'token_replayed' }]);
    assert.equal(count(dir, 'token_replay'), 1);
});
