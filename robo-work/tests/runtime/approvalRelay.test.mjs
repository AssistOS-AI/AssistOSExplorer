import assert from 'node:assert/strict';
import { PassThrough, Writable } from 'node:stream';
import test from 'node:test';

import { createDispatcher } from '../../server/runtime/dispatcher.mjs';
import { EVENT_PREFIX } from '../../server/runtime/alaStreams.mjs';
import { LIMITS, WORKSPACE, admitRequest, makeTempDir, newId, openStore, rawDb, readyRobot, syntheticContext } from '../helpers/synthetic.mjs';

// T2 approval relay, dispatcher side (decision M-30; SPEC deltas M3/M4/M5; M-52 addition 2), over a real S1 store and a FAKE ALA child
// that writes real control-stream bytes and records exactly what reaches its stdin.

const LIMITS_X = Object.freeze({ ...LIMITS, requestBytes: 65536, resultBytes: 2048, admissions: 64, receipts: 256, bindings: 8, controls: 32, tokenReplayEntries: 16 });
const ROBOTS = `workspace:${WORKSPACE}`;
const SESSION = '0f8c2f1e-3b53-4a56-9b0f-6b1f0d5e9a11';
const spec = (overrides = {}) => ({
    version: 2, prompt: 'native prompt', displayText: 'plain', sessionId: SESSION, turnId: 't1', cwd: '/ws/proj', permissions: 'ask-for-approval', ...overrides
});
const owner = (id) => syntheticContext({
    originNamespace: 'coordinator:agent:fixtures/roboteam', originKey: `owner:user:${id}`, ownerId: `user:${id}`, scope: `scope-co-${id}`, robotOwnerId: ROBOTS
});
const wait = async (predicate, label, ms = 3000) => {
    const deadline = Date.now() + ms;
    while (!predicate()) {
        if (Date.now() > deadline) assert.fail(`timed out: ${label}`);
        await new Promise((resolve) => setTimeout(resolve, 5));
    }
};
let counter = 0;
const uuid = () => `00000000-0000-4000-9000-${String(++counter).padStart(12, '0')}`;
const request = (id, overrides = {}) => ({
    type: 'coding-agent-request', id, agent: 'opencode', kind: 'permission', method: 'edit', title: 'Write a.txt', message: 'Allow?',
    options: [{ id: 'once', label: 'Allow once' }, { id: 'reject', label: 'Reject' }], ...overrides
});

function rig(t, { approvalTimeoutMs = 60000, inactivityTimeoutMs = 60000, maxAttemptMs = 120000, controlPollMs = 10 } = {}) {
    const dir = makeTempDir(t);
    const store = openStore(dir, { limits: LIMITS_X });
    t.after(() => store.close());
    const robotId = readyRobot(store, syntheticContext({ robotOwnerId: ROBOTS, scope: 'scope-robots' }));
    const runs = [];
    const logs = [];
    const factory = {
        async open({ item, context }) {
            const run = { item, ended: [], prompt: null, received: [], stdout: new PassThrough(), stderr: new PassThrough(), exitedControl: {} };
            run.stdin = new Writable({
                write(chunk, _encoding, callback) {
                    for (const line of chunk.toString().split('\n').filter(Boolean)) {
                        const record = JSON.parse(line);
                        if (run.prompt === null) run.prompt = record; else run.received.push(record);
                    }
                    callback();
                }
            });
            run.exited = new Promise((resolve) => { run.exitedControl.resolve = resolve; });
            run.event = (event) => run.stderr.write(`${EVENT_PREFIX.toString()}${JSON.stringify(event)}\n`);
            run.finishWith = (text, exitCode = 0) => { run.stdout.write(text); run.stdout.end(); run.stderr.end(); run.exitedControl.resolve({ exitCode, signal: null }); };
            runs.push(run);
            return {
                exited: run.exited,
                async start() { return { stdin: run.stdin, stdout: run.stdout, stderr: run.stderr }; },
                async end(outcome) {
                    run.ended.push(outcome);
                    store.beginAttemptEnd(context, { executionId: item.executionId, attemptId: item.attemptId, expectedState: 'running', outcome });
                    for (const stream of [run.stdin, run.stdout, run.stderr]) stream.destroy();
                }
            };
        }
    };
    const dispatcher = createDispatcher({
        store, workspaceId: WORKSPACE, workspaceRoot: '/ws', factory, log: (event, fields) => logs.push({ event, ...fields }),
        options: { pollMs: 10, controlPollMs, drainMs: 100, exitGraceMs: 80, approvalTimeoutMs, inactivityTimeoutMs, maxAttemptMs }
    });
    t.after(() => dispatcher.close());
    const alice = owner('alice');
    const admit = (specification = spec(), who = alice) => store.admit(who, admitRequest(robotId, { specification }, who));
    const events = (admitted) => store.listReferenceEvents(alice, { referenceId: admitted.reference.id, after: 0, limit: 1000 }).events;
    const view = (admitted) => store.observeReference(alice, { referenceId: admitted.reference.id });
    return { dir, store, runs, logs, dispatcher, alice, admit, events, view };
}

async function started(world) {
    const admitted = world.admit();
    world.dispatcher.start();
    await wait(() => world.runs.length === 1 && world.runs[0].prompt !== null, 'run started');
    return { admitted, run: world.runs[0] };
}

test('A2 (M-52 add. 2): the request is recorded, never relayed as `ala`; the answer is durable BEFORE the single stdin record, which carries exactly {type, id, optionId}', async (t) => {
    const world = rig(t);
    const { admitted, run } = await started(world);
    const id = uuid();
    run.event(request(id));
    await wait(() => world.events(admitted).some((row) => row.type === 'approval-request'), 'request recorded');
    assert.deepEqual(run.received, [], 'nothing is sent to ALA before the owner answers');
    // Durability ordering: at the moment the stdin record arrives, the control row and the resolution are already committed.
    let committedAtWrite = null;
    const original = run.stdin._write.bind(run.stdin);
    run.stdin._write = (chunk, encoding, callback) => {
        const db = rawDb(world.dir, { readOnly: true });
        try {
            committedAtWrite = {
                control: db.prepare("SELECT delivery FROM reference_control WHERE op = 'answer'").get()?.delivery ?? null,
                approval: db.prepare('SELECT state, reason, option_id FROM approval WHERE request_id = ?').get(id)
            };
        } finally { db.close(); }
        original(chunk, encoding, callback);
    };
    world.store.controlReference(world.alice, { referenceId: admitted.reference.id, operationId: newId(), op: 'answer', payload: { requestId: id, optionId: 'once' } });
    await wait(() => run.received.length === 1, 'answer written');
    assert.deepEqual(run.received, [{ type: 'interaction-response', id, optionId: 'once' }]);
    assert.deepEqual({ ...committedAtWrite, approval: { ...committedAtWrite.approval } }, { control: 'pending', approval: { state: 'resolved', reason: 'answered', option_id: 'once' } });
    await wait(() => world.store.takePendingControls({ executionId: admitted.executionId, attemptId: admitted.attemptId }).length === 0, 'acknowledged');
    // ALA confirms: recorded nowhere new, relayed nowhere; nothing is written again.
    run.event({ type: 'coding-agent-request-resolved', id, reason: 'answered' });
    run.event({ type: 'coding-agent-message', agent: 'opencode', message: 'writing' });
    run.finishWith('done\n');
    await wait(() => world.view(admitted).state === 'completed', 'completed');
    const rows = world.events(admitted);
    assert.deepEqual(rows.filter((row) => row.type === 'ala').map((row) => row.data.record.type), ['coding-agent-message'], 'no approval record is an ala event');
    assert.deepEqual(rows.filter((row) => row.type.startsWith('approval-')).map((row) => [row.type, row.data.reason ?? null]), [['approval-request', null], ['approval-resolved', 'answered']]);
    assert.equal(run.received.length, 1, 'exactly one stdin record');
});

test('A2: the 15-minute deadline (configurable) resolves `expired` and writes one cancel record; a late answer is operation_conflict', async (t) => {
    const world = rig(t, { approvalTimeoutMs: 60 });
    const { admitted, run } = await started(world);
    const id = uuid();
    run.event(request(id));
    await wait(() => run.received.length === 1, 'cancel written at the deadline');
    assert.deepEqual(run.received, [{ type: 'interaction-response', id, cancelled: true }]);
    assert.ok(world.events(admitted).some((row) => row.type === 'approval-resolved' && row.data.reason === 'expired'));
    assert.throws(() => world.store.controlReference(world.alice, { referenceId: admitted.reference.id, operationId: newId(), op: 'answer', payload: { requestId: id, optionId: 'once' } }),
        (error) => error.code === 'operation_conflict');
    run.event({ type: 'coding-agent-request-resolved', id, reason: 'cancelled' });
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(run.received.length, 1, 'never a second response');
    run.finishWith('ok\n');
});

test('M5: a request past the eight-open bound is cancelled `limit` at once, with one cancel record', async (t) => {
    const world = rig(t);
    const { admitted, run } = await started(world);
    const ids = Array.from({ length: 9 }, () => uuid());
    for (const id of ids) run.event(request(id));
    await wait(() => run.received.length === 1, 'limit cancel');
    assert.deepEqual(run.received, [{ type: 'interaction-response', id: ids[8], cancelled: true }]);
    const resolved = world.events(admitted).filter((row) => row.type === 'approval-resolved');
    assert.deepEqual(resolved.map((row) => [row.data.requestId, row.data.reason]), [[ids[8], 'limit']]);
    run.finishWith('ok\n');
    await wait(() => world.view(admitted).state === 'completed', 'completed');
    // The end resolves the eight still-open requests `ended`.
    assert.equal(world.events(admitted).filter((row) => row.type === 'approval-resolved' && row.data.reason === 'ended').length, 8);
});

test('ALA resolution and rejection: backend-resolved is recorded `cancelled` with no stdin write; a rejected answer makes its control final `rejected`', async (t) => {
    const world = rig(t);
    const { admitted, run } = await started(world);
    const backend = uuid();
    run.event(request(backend));
    await wait(() => world.events(admitted).some((row) => row.type === 'approval-request'), 'recorded');
    run.event({ type: 'coding-agent-request-resolved', id: backend, reason: 'backend-resolved' });
    await wait(() => world.events(admitted).some((row) => row.type === 'approval-resolved'), 'resolved');
    assert.deepEqual(world.events(admitted).filter((row) => row.type === 'approval-resolved').map((row) => row.data), [{ requestId: backend, reason: 'cancelled' }]);
    assert.throws(() => world.store.controlReference(world.alice, { referenceId: admitted.reference.id, operationId: newId(), op: 'answer', payload: { requestId: backend, optionId: 'once' } }),
        (error) => error.code === 'operation_conflict', 'backend-resolved then answer');
    const rejected = uuid();
    run.event(request(rejected));
    await wait(() => world.events(admitted).filter((row) => row.type === 'approval-request').length === 2, 'second recorded');
    world.store.controlReference(world.alice, { referenceId: admitted.reference.id, operationId: newId(), op: 'answer', payload: { requestId: rejected, optionId: 'reject' } });
    await wait(() => run.received.length === 1, 'written');
    run.event({ type: 'interaction-response-rejected', id: rejected, error: 'Unknown or stale interaction response' });
    const db = rawDb(world.dir, { readOnly: true });
    t.after(() => db.close());
    await wait(() => db.prepare("SELECT delivery FROM reference_control WHERE op = 'answer'").get().delivery === 'rejected', 'final rejected');
    assert.deepEqual(world.events(admitted).filter((row) => row.type === 'ala'), [], 'none of these records is relayed');
    run.finishWith('ok\n');
});

test('M3 through the dispatcher: an open request holds the inactivity bound; the answer releases it and the bound restarts', async (t) => {
    const world = rig(t, { inactivityTimeoutMs: 120 });
    const { admitted, run } = await started(world);
    const id = uuid();
    run.event(request(id));
    await wait(() => world.events(admitted).some((row) => row.type === 'approval-request'), 'recorded');
    await new Promise((resolve) => setTimeout(resolve, 400));
    assert.equal(world.view(admitted).state, 'running', 'idle well past the bound while the request is open');
    world.store.controlReference(world.alice, { referenceId: admitted.reference.id, operationId: newId(), op: 'answer', payload: { requestId: id, cancelled: true } });
    await wait(() => run.received.length === 1, 'cancel answer written');
    assert.deepEqual(run.received, [{ type: 'interaction-response', id, cancelled: true }]);
    await wait(() => world.view(admitted).state === 'failed', 'the bound fires once released and idle');
    assert.equal(world.view(admitted).result.data.reason, 'inactive_timeout');
});

test('the attempt end with a request still open resolves it `ended`; nothing is written after the end', async (t) => {
    const world = rig(t);
    const { admitted, run } = await started(world);
    const id = uuid();
    run.event(request(id));
    await wait(() => world.events(admitted).some((row) => row.type === 'approval-request'), 'recorded');
    run.finishWith('done\n');
    await wait(() => world.view(admitted).state === 'completed', 'completed');
    assert.deepEqual(world.events(admitted).filter((row) => row.type === 'approval-resolved').map((row) => row.data.reason), ['ended']);
    assert.deepEqual(run.received, []);
});

test('review item 4: an answer recorded, then ALA resolves the request before delivery: the control is final `ended`, never `applied`, and nothing is written', async (t) => {
    const world = rig(t, { controlPollMs: 400 });
    const { admitted, run } = await started(world);
    const id = uuid();
    run.event(request(id));
    await wait(() => world.events(admitted).some((row) => row.type === 'approval-request'), 'recorded');
    world.store.controlReference(world.alice, { referenceId: admitted.reference.id, operationId: newId(), op: 'answer', payload: { requestId: id, optionId: 'once' } });
    run.event({ type: 'coding-agent-request-resolved', id, reason: 'backend-resolved' });
    const db = rawDb(world.dir, { readOnly: true });
    t.after(() => db.close());
    await wait(() => db.prepare("SELECT delivery FROM reference_control WHERE op = 'answer'").get().delivery !== 'pending', 'finalized', 4000);
    assert.equal(db.prepare("SELECT delivery FROM reference_control WHERE op = 'answer'").get().delivery, 'ended');
    assert.deepEqual(run.received, [], 'never written to ALA');
    run.finishWith('ok\n');
});

test('review item 6: an approval request recorded after ALA records keeps their order (the relay is flushed first)', async (t) => {
    const world = rig(t);
    const { admitted, run } = await started(world);
    const id = uuid();
    run.event({ type: 'coding-agent-message', agent: 'opencode', message: 'before 1' });
    run.event({ type: 'coding-agent-message', agent: 'opencode', message: 'before 2' });
    run.event(request(id));
    run.event({ type: 'coding-agent-message', agent: 'opencode', message: 'after' });
    await wait(() => world.events(admitted).filter((row) => row.type === 'ala').length === 3 && world.events(admitted).some((row) => row.type === 'approval-request'), 'all recorded');
    const rows = world.events(admitted);
    const request_ = rows.find((row) => row.type === 'approval-request').sequence;
    const before = rows.filter((row) => row.type === 'ala' && row.data.record.message.startsWith('before')).map((row) => row.sequence);
    assert.ok(before.every((sequence) => sequence < request_), JSON.stringify({ before, request_ }));
    run.finishWith('ok\n');
});
