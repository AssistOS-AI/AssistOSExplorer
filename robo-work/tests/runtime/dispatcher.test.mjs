import assert from 'node:assert/strict';
import { PassThrough, Writable } from 'node:stream';
import test from 'node:test';

import { createDispatcher, fitOutcome } from '../../server/runtime/dispatcher.mjs';
import { EVENT_PREFIX } from '../../server/runtime/alaStreams.mjs';
import { LIMITS, WORKSPACE, admitRequest, makeTempDir, newId, openStore, readyRobot, syntheticContext } from '../helpers/synthetic.mjs';

// The dispatcher over a real S1 store and a FAKE execution factory: the fake ALA child writes real stream bytes (event
// lines on stderr, the result on stdout) and the fake execution's end applies the outcome through beginAttemptEnd, the way
// the ledger's first step does. No sandbox and no process is involved.

const LIMITS_X = Object.freeze({ ...LIMITS, requestBytes: 65536, resultBytes: 2048, admissions: 64, receipts: 256, bindings: 8, controls: 32, tokenReplayEntries: 16 });
const ROBOTS = `workspace:${WORKSPACE}`;
const SESSION = '0f8c2f1e-3b53-4a56-9b0f-6b1f0d5e9a11';
const spec = (overrides = {}) => ({
    version: 2, prompt: 'native prompt', displayText: 'plain', sessionId: SESSION, turnId: 't1', cwd: '/ws/proj', permissions: 'full-access', ...overrides
});
const owner = (id) => syntheticContext({
    originNamespace: 'coordinator:agent:fixtures/roboteam', originKey: `owner:user:${id}`, ownerId: `user:${id}`, scope: `scope-co-${id}`, robotOwnerId: ROBOTS
});
const wait = async (predicate, label, ms = 2000) => {
    const deadline = Date.now() + ms;
    while (!predicate()) {
        if (Date.now() > deadline) assert.fail(`timed out: ${label}`);
        await new Promise((resolve) => setTimeout(resolve, 5));
    }
};

function rig(t, { openFails = null, startFails = null, maxConcurrent = 2, controlPollMs = 10, storeWrap = (store) => store } = {}) {
    const store = openStore(makeTempDir(t), { limits: LIMITS_X });
    t.after(() => store.close());
    const robotId = readyRobot(store, syntheticContext({ robotOwnerId: ROBOTS, scope: 'scope-robots' }));
    const runs = [];
    const logs = [];
    const factory = {
        async open({ item, plan, context }) {
            if (openFails) throw openFails;
            const run = {
                item, plan, ended: [], prompt: null, received: [], exitedControl: {}, stdinFlushMs: 0,
                stdout: new PassThrough(), stderr: new PassThrough()
            };
            // The bytes are seen at once; the write callback (the flush) comes `stdinFlushMs` later, like a slow consumer.
            run.stdin = new Writable({
                write(chunk, _encoding, callback) {
                    for (const line of chunk.toString().split('\n').filter(Boolean)) {
                        const record = JSON.parse(line);
                        if (run.prompt === null) run.prompt = record; else run.received.push(record);
                    }
                    setTimeout(callback, run.stdinFlushMs);
                }
            });
            run.exited = new Promise((resolve) => { run.exitedControl.resolve = resolve; });
            run.event = (event) => run.stderr.write(`${EVENT_PREFIX.toString()}${JSON.stringify(event)}\n`);
            run.finishWith = (text, exitCode = 0) => {
                if (text !== null) run.stdout.write(text);
                run.stdout.end();
                run.stderr.end();
                run.exitedControl.resolve({ exitCode, signal: null });
            };
            runs.push(run);
            return {
                exited: run.exited,
                async start() { if (startFails) throw startFails; return { stdin: run.stdin, stdout: run.stdout, stderr: run.stderr }; },
                async end(outcome) {
                    run.ended.push(outcome);
                    store.beginAttemptEnd(context, { executionId: item.executionId, attemptId: item.attemptId, expectedState: 'running', outcome });
                    for (const stream of [run.stdin, run.stdout, run.stderr]) stream.destroy();
                }
            };
        }
    };
    const dispatcher = createDispatcher({
        store: storeWrap(store), workspaceId: WORKSPACE, workspaceRoot: '/ws', factory, log: (event, fields) => logs.push({ event, ...fields }),
        options: { pollMs: 10, controlPollMs, drainMs: 100, maxConcurrent, resultBytes: 1500 }
    });
    t.after(() => dispatcher.close());
    const alice = owner('alice');
    const admit = (specification = spec(), overrides = {}) => store.admit(alice, admitRequest(robotId, { specification, ...overrides }, alice));
    const view = (admitted) => store.observeReference(alice, { referenceId: admitted.reference.id });
    return { store, robotId, runs, logs, dispatcher, alice, admit, view };
}

test('a task runs: the prompt record first, ALA records relayed in order, the stdout text is the result', async (t) => {
    const { dispatcher, runs, admit, view, store, alice } = rig(t);
    const admitted = admit();
    dispatcher.start();
    await wait(() => runs.length === 1, 'run opened');
    const run = runs[0];
    await wait(() => run.prompt !== null, 'prompt delivered');
    assert.deepEqual(run.prompt, { type: 'prompt', prompt: 'native prompt', displayText: 'plain' });
    assert.equal(view(admitted).state, 'running');
    assert.equal(run.plan.cwd, '/projects/g0');
    run.stderr.write('a diagnostic line\n');
    run.event({ type: 'session-ready', sessionId: SESSION });
    run.event({ type: 'coding-agent-final', agent: 'codex', message: 'done!' });
    run.finishWith('done!\n');
    await wait(() => view(admitted).state === 'completed', 'completed');
    const final = view(admitted);
    assert.deepEqual({ ...final.result, cleanup: undefined }, { status: 'completed', cleanup: undefined, outputText: 'done!', data: null });
    const events = store.listReferenceEvents(alice, { referenceId: admitted.reference.id, after: 0, limit: 1000 }).events;
    assert.deepEqual(events.map((event) => event.type), ['state', 'state', 'ala', 'ala', 'state', 'state']);
    assert.deepEqual(events.filter((event) => event.type === 'ala').map((event) => event.data.record.type), ['session-ready', 'coding-agent-final']);
    assert.equal(runs[0].ended.length, 1);
    assert.equal(runs[0].ended[0].classification, 'completed');
});

test('a pending message control is written to ALA stdin and acknowledged; a stop cancels without ALA', async (t) => {
    const { dispatcher, runs, admit, view, store, alice } = rig(t);
    const admitted = admit();
    dispatcher.start();
    await wait(() => runs.length === 1 && runs[0].prompt !== null, 'running');
    const referenceId = admitted.reference.id;
    store.controlReference(alice, { referenceId, operationId: newId(), op: 'message', payload: { message: 'wrapped', displayText: 'plain follow-up', id: 'm-1' } });
    await wait(() => runs[0].received.length === 1, 'message delivered');
    assert.deepEqual(runs[0].received[0], { type: 'message', id: 'm-1', message: 'wrapped', displayText: 'plain follow-up' });
    assert.equal(store.takePendingControls({ executionId: admitted.executionId, attemptId: admitted.attemptId }).length, 0);
    runs[0].stdout.write('partial text');
    store.controlReference(alice, { referenceId, operationId: newId(), op: 'stop' });
    await wait(() => view(admitted).state === 'cancelled', 'cancelled');
    assert.deepEqual(runs[0].ended.map((outcome) => [outcome.classification, outcome.outputText, outcome.data]), [['cancelled', 'partial text', { reason: 'stopped' }]]);
    assert.equal(store.takePendingControls({ executionId: admitted.executionId, attemptId: admitted.attemptId }).length, 0);
});

test('failures: a nonzero exit, an empty result, a control-stream violation and a refused plan each end with a bounded reason', async (t) => {
    const { dispatcher, runs, admit, view, logs } = rig(t, { maxConcurrent: 4 });
    const failed = admit();
    const empty = admit(spec({ sessionId: '1f8c2f1e-3b53-4a56-9b0f-6b1f0d5e9a11' }));
    const refused = admit(spec({ permissions: 'ask-for-approval' }));
    const hostile = admit(spec({ sessionId: '2f8c2f1e-3b53-4a56-9b0f-6b1f0d5e9a11' }));
    dispatcher.start();
    await wait(() => view(refused).state === 'failed', 'refused plan');
    assert.equal(view(refused).result.data.reason, 'approval_unsupported');
    assert.equal(runs.length <= 3, true, 'the refused plan never reached the factory');
    await wait(() => runs.length === 3 || (runs.length === 2 && view(failed).state === 'running'), 'runs');
    await wait(() => runs.length >= 2, 'two runs');
    runs[0].event({ type: 'x' });
    runs[0].finishWith('partial', 2);
    await wait(() => view(failed).state === 'failed', 'failed');
    assert.deepEqual(view(failed).result.data, { reason: 'ala_failed', exitCode: 2, signal: null });
    await wait(() => runs.length >= 3, 'third run');
    runs[1].finishWith(null, 0);
    await wait(() => view(empty).state === 'failed', 'empty result');
    assert.equal(view(empty).result.data.reason, 'no_result');
    await wait(() => runs.length >= 4 || view(hostile).state !== 'queued', 'fourth run');
    runs[2].stderr.write(`${EVENT_PREFIX.toString()}{broken\n`);
    await wait(() => view(hostile).state === 'failed', 'violation');
    assert.deepEqual(view(hostile).result.data, { reason: 'control_stream_violation', detail: 'malformed_record' });
    assert.ok(Array.isArray(logs));
});

test('a factory that cannot open or start fails the attempt with its reason; the worker keeps running', async (t) => {
    const opening = rig(t, { openFails: Object.assign(new Error('x'), { reason: 'grant_protected_component' }) });
    const first = opening.admit();
    opening.dispatcher.start();
    await wait(() => opening.view(first).state === 'failed', 'open failure');
    assert.deepEqual(opening.view(first).result.data, { reason: 'grant_protected_component' });
    const starting = rig(t, { startFails: new Error('sandbox') });
    const second = starting.admit();
    starting.dispatcher.start();
    await wait(() => starting.view(second).state === 'failed', 'start failure');
    assert.deepEqual(starting.view(second).result.data, { reason: 'start_failed' });
    assert.equal(starting.runs[0].ended.length, 1, 'the ledger end path ran for the partly published execution');
});

test('a result larger than the bound is cut and marked; shutdown interrupts a running attempt through the end path', async (t) => {
    const outcome = fitOutcome({ classification: 'completed', outputText: 'é'.repeat(5000), data: null }, 1500);
    assert.equal(outcome.data.truncated, true);
    assert.equal(outcome.data.originalBytes, 10000);
    assert.ok(Buffer.byteLength(JSON.stringify({ outputText: outcome.outputText, data: outcome.data })) <= 1500);
    assert.deepEqual(fitOutcome({ classification: 'completed', outputText: 'small', data: null }, 1500), { classification: 'completed', outputText: 'small', data: null });

    const { dispatcher, runs, admit, view } = rig(t);
    const big = admit();
    const waiting = admit(spec({ sessionId: '3f8c2f1e-3b53-4a56-9b0f-6b1f0d5e9a11' }));
    dispatcher.start();
    await wait(() => runs.length === 2 && runs[0].prompt !== null, 'two runs');
    runs[0].finishWith('z'.repeat(4000));
    await wait(() => view(big).state === 'completed', 'cut result');
    assert.equal(view(big).result.data.truncated, true);
    await dispatcher.close();
    assert.equal(view(waiting).state, 'interrupted');
    assert.deepEqual(runs[1].ended.map((entry) => [entry.classification, entry.data]), [['interrupted', { reason: 'worker_shutdown' }]]);
});

test('turns of one session start first in, first out', async (t) => {
    const { dispatcher, runs, store, robotId, alice, view } = rig(t);
    const turn = (n) => store.admit(alice, admitRequest(robotId, { kind: 'turn', logical: { sessionKey: 'chat-1' }, specification: spec({ turnId: `turn_${n}` }) }, alice));
    const one = turn(1);
    const two = turn(2);
    dispatcher.start();
    await wait(() => runs.length === 1 && runs[0].prompt !== null, 'first turn');
    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.equal(runs.length, 1, 'the second turn waits');
    assert.equal(view(two).state, 'queued');
    runs[0].finishWith('one');
    await wait(() => view(one).state === 'completed', 'first done');
    await wait(() => runs.length === 2, 'second turn starts');
    runs[1].finishWith('two');
    await wait(() => view(two).state === 'completed', 'second done');
});

test('a message control is delivered exactly once even when the stdin flush takes longer than the control poll interval', async (t) => {
    const { dispatcher, runs, admit, view, store, alice } = rig(t, { controlPollMs: 20 });
    const admitted = admit();
    dispatcher.start();
    await wait(() => runs.length === 1 && runs[0].prompt !== null, 'running');
    runs[0].stdinFlushMs = 400;
    store.controlReference(alice, { referenceId: admitted.reference.id, operationId: newId(), op: 'message', payload: { message: 'do X once', id: 'm-1' } });
    await wait(() => runs[0].received.length >= 1, 'delivered');
    await new Promise((resolve) => setTimeout(resolve, 900));
    assert.deepEqual(runs[0].received.map((record) => record.id), ['m-1'], 'one delivery, not one per interval tick');
    assert.equal(store.takePendingControls({ executionId: admitted.executionId, attemptId: admitted.attemptId }).length, 0, 'and it was acknowledged');
    runs[0].stdinFlushMs = 0;
    runs[0].finishWith('done');
    await wait(() => view(admitted).state === 'completed', 'completed');
});

test('a start the store refuses for a reason a retry cannot change fails the attempt once and is not retried at every poll', async (t) => {
    let transitions = 0;
    const { dispatcher, admit, view, logs } = rig(t, {
        storeWrap: (store) => new Proxy(store, { get(target, name) {
            if (name === 'transitionAttempt') return () => { transitions += 1; throw Object.assign(new Error('boom'), { code: 'EIO' }); };
            const value = target[name];
            return typeof value === 'function' ? value.bind(target) : value;
        } })
    });
    const admitted = admit();
    dispatcher.start();
    await wait(() => view(admitted).state === 'failed', 'failed');
    assert.deepEqual(view(admitted).result.data, { reason: 'start_refused' });
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(transitions, 1);
    assert.equal(logs.filter((entry) => entry.event === 'transition_refused').length, 1, 'logged once');
});
