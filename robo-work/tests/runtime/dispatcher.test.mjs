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

function rig(t, { openFails = null, startFails = null, maxConcurrent = 2, controlPollMs = 10, storeWrap = (store) => store, timeouts = {}, quarantineOnEnd = false } = {}) {
    const store = openStore(makeTempDir(t), { limits: LIMITS_X });
    t.after(() => store.close());
    const robotId = readyRobot(store, syntheticContext({ robotOwnerId: ROBOTS, scope: 'scope-robots' }));
    const runs = [];
    const logs = [];
    const factory = {
        async open({ item, plan, context, channels, activity }) {
            if (openFails) throw openFails;
            const run = {
                item, plan, channels, activity, ended: [], prompt: null, received: [], exitedControl: {}, stdinFlushMs: 0,
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
            run.lost = new Promise((resolve) => { run.lose = resolve; });
            run.event = (event) => run.stderr.write(`${EVENT_PREFIX.toString()}${JSON.stringify(event)}\n`);
            run.finishWith = (text, exitCode = 0) => {
                if (text !== null) run.stdout.write(text);
                run.stdout.end();
                run.stderr.end();
                run.exitedControl.resolve({ exitCode, signal: null });
            };
            runs.push(run);
            return {
                exited: run.exited, lost: run.lost, lastModelError: () => run.lastModelError ?? null,
                async start() { if (startFails) throw startFails; return { stdin: run.stdin, stdout: run.stdout, stderr: run.stderr }; },
                async end(outcome) {
                    run.ended.push(outcome);
                    if (quarantineOnEnd) {
                        // A process tree whose absence cannot be proven when the stop is done.
                        const { resourceId } = store.reserveResource({ robotId, executionId: item.executionId, attemptId: item.attemptId, kind: 'process-tree', processBearing: true, locator: { cg: 'x' } });
                        store.commitResource({ resourceId, identity: { pid: 1, startTime: '1' } });
                        store.quarantineResource({ resourceId, generationId: store.generationId });
                    }
                    store.beginAttemptEnd(context, { executionId: item.executionId, attemptId: item.attemptId, expectedState: 'running', outcome });
                    for (const stream of [run.stdin, run.stdout, run.stderr]) stream.destroy();
                }
            };
        }
    };
    const dispatcher = createDispatcher({
        store: storeWrap(store), workspaceId: WORKSPACE, workspaceRoot: '/ws', factory, log: (event, fields) => logs.push({ event, ...fields }),
        options: { pollMs: 10, controlPollMs, drainMs: 100, exitGraceMs: 80, failureAbortMs: 20, humanInputGraceMs: 150, ...timeouts, maxConcurrent, resultBytes: 1500 }
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
    // The bytes are seen before the write callback, so the acknowledgement follows a moment later.
    await wait(() => store.takePendingControls({ executionId: admitted.executionId, attemptId: admitted.attemptId }).length === 0, 'acknowledged');
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
    assert.deepEqual(view(failed).result.data, { reason: 'ala_failed', exitCode: 2, signal: null, detail: 'ala_exit:2' });
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

test('worker log: attempt start and end lines carry ids, class and reason, never the prompt or the result text', async (t) => {
    const { dispatcher, runs, admit, view, logs } = rig(t);
    const admitted = admit();
    dispatcher.start();
    await wait(() => runs.length === 1 && runs[0].prompt !== null, 'running');
    runs[0].finishWith('secret result text');
    await wait(() => view(admitted).state === 'completed', 'completed');
    await wait(() => logs.some((entry) => entry.event === 'attempt_end'), 'end logged');
    const start = logs.find((entry) => entry.event === 'attempt_start');
    assert.deepEqual(Object.keys(start).sort(), ['attemptId', 'event', 'executionId', 'kind', 'robotId']);
    assert.equal(start.kind, 'task');
    assert.deepEqual(logs.find((entry) => entry.event === 'attempt_end'), { event: 'attempt_end', executionId: admitted.executionId, attemptId: admitted.attemptId, classification: 'completed', reason: null });
    assert.equal(JSON.stringify(logs).includes('native prompt'), false);
    assert.equal(JSON.stringify(logs).includes('secret result text'), false);
});

test('ALA dying makes the endpoint report its loss first: the exit code is the reason, and ALA\'s own last lines (redacted) go to the log', async (t) => {
    const { dispatcher, runs, admit, view, logs } = rig(t);
    const admitted = admit();
    dispatcher.start();
    await wait(() => runs.length === 1 && runs[0].prompt !== null, 'running');
    runs[0].stderr.write('coding agent noise with sk-ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789abcd\n');
    runs[0].stderr.write('ala: A system error occurred: uv_os_homedir returned ENOENT, token 0123456789abcdef0123456789abcdef0123\n');
    runs[0].lose('endpoint_ended:endpoint_lost');
    await new Promise((resolve) => setTimeout(resolve, 20));
    runs[0].stdout.end();
    runs[0].stderr.end();
    runs[0].exitedControl.resolve({ exitCode: 5, signal: null });
    await wait(() => view(admitted).state === 'failed', 'failed');
    assert.deepEqual(view(admitted).result.data, { reason: 'ala_failed', exitCode: 5, signal: null, detail: 'ala_exit:5' });
    const tail = logs.find((entry) => entry.event === 'ala_stderr_tail');
    assert.ok(tail, 'stderr tail logged');
    assert.match(tail.text, /^ala: A system error occurred: uv_os_homedir returned ENOENT, token \[redacted\]$/u);
    assert.equal(tail.text.includes('sk-'), false);
    assert.deepEqual(logs.find((entry) => entry.event === 'attempt_end'), { event: 'attempt_end', executionId: admitted.executionId, attemptId: admitted.attemptId, classification: 'failed', reason: 'ala_failed' });
});

test('a lost execution whose ALA never exits keeps the loss as the reason', async (t) => {
    const { dispatcher, runs, admit, view } = rig(t);
    const admitted = admit();
    dispatcher.start();
    await wait(() => runs.length === 1 && runs[0].prompt !== null, 'running');
    runs[0].lose('endpoint_ended:endpoint_lost');
    await wait(() => view(admitted).state === 'failed', 'failed');
    assert.deepEqual(view(admitted).result.data, { reason: 'execution_lost', detail: 'endpoint_ended:endpoint_lost' });
});

test('a sandbox launch failure is logged with its code and detail and recorded as the result detail', async (t) => {
    const failure = Object.assign(new Error('setup_failed: x'), { name: 'SandboxError', code: 'mask_unverified', detail: 'mask check' });
    const { dispatcher, admit, view, logs } = rig(t, { startFails: failure });
    const admitted = admit();
    dispatcher.start();
    await wait(() => view(admitted).state === 'failed', 'failed');
    assert.deepEqual(view(admitted).result.data, { reason: 'start_failed', detail: 'mask_unverified' });
    const entry = logs.find((line) => line.event === 'execution_failed');
    assert.equal(entry.error, 'mask_unverified');
    assert.equal(entry.detail, 'mask check');
});

// ---- M-14: the worker-hosted channels --------------------------------------------------------------------------------------

const events = (store, owner, admitted) => store.listReferenceEvents(owner, { referenceId: admitted.reference.id, after: 0, limit: 1000 }).events;

test('channels exist only for an execution admitted for them', async (t) => {
    const { dispatcher, runs, admit } = rig(t, { maxConcurrent: 4 });
    admit(spec());
    admit(spec({ sessionId: 'workflow-1', workflowExecution: true }));
    admit(spec({ sessionId: 'human-1', humanInput: true }));
    dispatcher.start();
    await wait(() => runs.length === 3, 'three runs');
    const shapes = runs.map((run) => [run.channels.taskFailure !== null, run.channels.humanInput !== null]);
    assert.deepEqual(shapes, [[false, false], [true, false], [false, true]]);
});

test('task-failure channel: the event is durable before the handler returns, and the attempt ends failed with task_blocked', async (t) => {
    const { dispatcher, runs, admit, view, store, alice } = rig(t);
    const admitted = admit(spec({ workflowExecution: true }));
    dispatcher.start();
    await wait(() => runs.length === 1 && runs[0].prompt !== null, 'running');
    runs[0].stdout.write('partial work');
    await runs[0].channels.taskFailure({ message: 'Missing access to the database' });
    const stored = events(store, alice, admitted).filter((event) => event.type === 'task-failed');
    assert.deepEqual(stored.map((event) => event.data), [{ message: 'Missing access to the database' }]);
    await runs[0].channels.taskFailure({ message: 'Missing access to the database' });
    assert.equal(events(store, alice, admitted).filter((event) => event.type === 'task-failed').length, 1, 'a repeat is one event');
    await wait(() => view(admitted).state === 'failed', 'failed');
    assert.deepEqual(view(admitted).result.data, { reason: 'task_blocked', message: 'Missing access to the database' });
    assert.equal(runs[0].ended.length, 1);
    await assert.rejects(runs[0].channels.taskFailure({ message: 'late' }), (error) => error.statusCode === 409);
});

test('human-input channel: the question is durable before the reply; ALA ending normally gives the human-input classification; one question per attempt', async (t) => {
    const { dispatcher, runs, admit, view, store, alice } = rig(t);
    const admitted = admit(spec({ humanInput: true }));
    dispatcher.start();
    await wait(() => runs.length === 1 && runs[0].prompt !== null, 'running');
    const question = { question: 'Ship it?', options: ['yes', 'no', 'later'] };
    const { id } = await runs[0].channels.humanInput(question);
    assert.match(id, /^[A-Za-z0-9_-]{22}$/u);
    const asked = events(store, alice, admitted).filter((event) => event.type === 'human-input-request');
    assert.deepEqual(asked.map((event) => event.data), [{ requestId: id, ...question }]);
    assert.deepEqual(await runs[0].channels.humanInput(question), { id }, 'the same question again: the same request');
    await assert.rejects(runs[0].channels.humanInput({ ...question, question: 'Other?' }), (error) => error.statusCode === 409);
    runs[0].finishWith('Waiting for your decision.');
    await wait(() => view(admitted).state === 'human-input', 'human-input');
    assert.deepEqual(view(admitted).result, { status: 'human-input', cleanup: 'released', outputText: 'Waiting for your decision.', data: { reason: 'human_input', requestId: id } });
});

test('human-input channel: a model that does not end by itself is ended after the grace period', async (t) => {
    const { dispatcher, runs, admit, view } = rig(t);
    const admitted = admit(spec({ humanInput: true }));
    dispatcher.start();
    await wait(() => runs.length === 1 && runs[0].prompt !== null, 'running');
    const { id } = await runs[0].channels.humanInput({ question: 'Ship it?', options: ['yes', 'no', 'later'] });
    await wait(() => view(admitted).state === 'human-input', 'ended by the worker');
    assert.equal(view(admitted).result.data.requestId, id);
    assert.equal(runs[0].ended.length, 1);
});

// ---- a recorded question keeps the attempt answerable -------------------------------------------------------------------------

const QUESTION = { question: 'Ship it?', options: ['yes', 'no', 'later'] };
async function asked(t, specOverrides = {}) {
    const world = rig(t);
    const admitted = world.admit(spec({ humanInput: true, workflowExecution: true, ...specOverrides }));
    world.dispatcher.start();
    await wait(() => world.runs.length === 1 && world.runs[0].prompt !== null, 'running');
    const { id } = await world.runs[0].channels.humanInput(QUESTION);
    return { ...world, admitted, requestId: id, run: world.runs[0] };
}
const answerOf = (world, answer = 'yes') => world.store.controlReference(world.alice, {
    referenceId: world.admitted.reference.id, operationId: newId(), op: 'answer', payload: { requestId: world.requestId, answer }
});

test('a question recorded, then ALA exits 1 or 130: the attempt ends human-input, keeps the exit code, and the answer is accepted', async (t) => {
    for (const exitCode of [1, 130]) {
        const world = await asked(t, { sessionId: `ask-${exitCode}` });
        world.run.finishWith(null, exitCode);
        await wait(() => world.view(world.admitted).state === 'human-input', `human-input after exit ${exitCode}`);
        const expected = exitCode === 130
            ? { reason: 'human_input', requestId: world.requestId, endedBy: 'ala_interrupted' }
            : { reason: 'human_input', requestId: world.requestId, endedBy: 'ala_failed', exitCode: 1, detail: 'ala_exit:1' };
        assert.deepEqual(world.view(world.admitted).result.data, expected);
        assert.equal(answerOf(world).outcome, 'accepted', `answerable after exit ${exitCode}`);
    }
});

test('a question recorded, then a stream violation: the attempt ends human-input and stays answerable', async (t) => {
    const world = await asked(t);
    world.run.stderr.write('@@ALA_EVENT@@{broken\n');
    await wait(() => world.view(world.admitted).state === 'human-input', 'human-input');
    assert.equal(world.view(world.admitted).result.data.endedBy, 'control_stream_violation');
    assert.equal(answerOf(world).outcome, 'accepted');
});

test('a question recorded, then a stop by the owner: the attempt ends cancelled and cannot be answered', async (t) => {
    const world = await asked(t);
    world.store.controlReference(world.alice, { referenceId: world.admitted.reference.id, operationId: newId(), op: 'stop' });
    await wait(() => world.view(world.admitted).state === 'cancelled', 'cancelled');
    assert.throws(() => answerOf(world), (error) => error.code === 'operation_conflict');
});

test('a question recorded, then a task failure: the attempt ends failed with task_blocked, not human-input, whichever timer fires', async (t) => {
    const world = await asked(t);
    await world.run.channels.taskFailure({ message: 'Cannot continue' });
    await wait(() => world.view(world.admitted).state === 'failed', 'failed');
    // The question's grace period (150 ms in this rig) would have ended it human-input if it were not replaced.
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(world.view(world.admitted).state, 'failed');
    assert.deepEqual(world.view(world.admitted).result.data, { reason: 'task_blocked', message: 'Cannot continue' });
    assert.equal(world.runs[0].ended.length, 1);
    assert.throws(() => answerOf(world), (error) => error.code === 'operation_conflict');
});

test('a task failure first and a question after it: the attempt still ends failed with task_blocked', async (t) => {
    const world = rig(t);
    const admitted = world.admit(spec({ humanInput: true, workflowExecution: true }));
    world.dispatcher.start();
    await wait(() => world.runs.length === 1 && world.runs[0].prompt !== null, 'running');
    const { id } = await world.runs[0].channels.humanInput(QUESTION);
    await world.runs[0].channels.taskFailure({ message: 'No access' });
    world.runs[0].finishWith(null, 0);
    await wait(() => world.view(admitted).state === 'failed', 'failed');
    assert.equal(world.view(admitted).result.data.reason, 'task_blocked');
    void id;
});

// ---- M-33: the time bounds of a task attempt ------------------------------------------------------------------------------------

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('inactivity: no activity for the bound ends the attempt failed / inactive_timeout, keeping the output so far, once, and the log names it', async (t) => {
    const { dispatcher, runs, admit, view, logs } = rig(t, { timeouts: { inactivityTimeoutMs: 120 } });
    const admitted = admit();
    dispatcher.start();
    await wait(() => runs.length === 1 && runs[0].prompt !== null, 'running');
    runs[0].stdout.write('output so far');
    await wait(() => view(admitted).state === 'failed', 'failed by inactivity');
    assert.deepEqual(view(admitted).result.data, { reason: 'inactive_timeout' });
    assert.equal(view(admitted).result.outputText, 'output so far');
    assert.equal(runs[0].ended.length, 1, 'one normal end path');
    const entry = logs.find((line) => line.event === 'attempt_timeout');
    assert.deepEqual([entry.executionId, entry.attemptId, entry.reason], [admitted.executionId, admitted.attemptId, 'inactive_timeout']);
    await pause(300);
    assert.equal(runs.length, 1, 'no automatic retry or replacement');
});

test('M-43 (a): an attempt that ends inactive_timeout carries the last upstream error of the model channel; a deadline does not, and none is absent', async (t) => {
    const world = rig(t, { timeouts: { inactivityTimeoutMs: 120 } });
    const admitted = world.admit();
    world.dispatcher.start();
    await wait(() => world.runs.length === 1 && world.runs[0].prompt !== null, 'running');
    world.runs[0].lastModelError = { status: 429, message: 'daily quota exceeded' };
    await wait(() => world.view(admitted).state === 'failed', 'failed by inactivity');
    assert.deepEqual(world.view(admitted).result.data, { reason: 'inactive_timeout', lastModelError: { status: 429, message: 'daily quota exceeded' } });

    const bounded = rig(t, { timeouts: { inactivityTimeoutMs: 150, maxAttemptMs: 300 } });
    const second = bounded.admit();
    bounded.dispatcher.start();
    await wait(() => bounded.runs.length === 1 && bounded.runs[0].prompt !== null, 'running');
    bounded.runs[0].lastModelError = { status: 500, message: 'x' };
    const started = Date.now();
    while (bounded.view(second).state === 'running' && Date.now() - started < 1500) { bounded.runs[0].activity(); await pause(40); }
    await wait(() => bounded.view(second).state === 'failed', 'failed by the deadline');
    assert.deepEqual(bounded.view(second).result.data, { reason: 'deadline_exceeded' });
});

test('activity resets the inactivity bound: ALA records, a delivered message and a provider request keep the attempt alive', async (t) => {
    const { dispatcher, runs, admit, view, store, alice } = rig(t, { timeouts: { inactivityTimeoutMs: 200 } });
    const admitted = admit();
    dispatcher.start();
    await wait(() => runs.length === 1 && runs[0].prompt !== null, 'running');
    const started = Date.now();
    let step = 0;
    while (Date.now() - started < 600) {
        step += 1;
        if (step % 3 === 1) runs[0].event({ type: 'progress', step });
        else if (step % 3 === 2) store.controlReference(alice, { referenceId: admitted.reference.id, operationId: newId(), op: 'message', payload: { message: `m${step}` } });
        else runs[0].activity();
        await pause(70);
    }
    assert.equal(view(admitted).state, 'running', '600 ms of activity every 70 ms against a 200 ms bound');
    await wait(() => view(admitted).state === 'failed', 'fires once the activity stops');
    assert.equal(view(admitted).result.data.reason, 'inactive_timeout');
});

test('the maximum duration ends the attempt failed / deadline_exceeded despite continuous activity', async (t) => {
    const { dispatcher, runs, admit, view, logs } = rig(t, { timeouts: { inactivityTimeoutMs: 150, maxAttemptMs: 500 } });
    const admitted = admit();
    dispatcher.start();
    await wait(() => runs.length === 1 && runs[0].prompt !== null, 'running');
    const ticker = setInterval(() => runs[0].event({ type: 'progress' }), 30);
    t.after(() => clearInterval(ticker));
    await wait(() => view(admitted).state === 'failed', 'deadline', 3000);
    clearInterval(ticker);
    assert.deepEqual(view(admitted).result.data, { reason: 'deadline_exceeded' });
    assert.equal(logs.find((line) => line.event === 'attempt_timeout').reason, 'deadline_exceeded');
});

test('a human-input wait does not count: the inactivity bound is suspended and the grace period ends the attempt human-input', async (t) => {
    const { dispatcher, runs, admit, view } = rig(t, { timeouts: { inactivityTimeoutMs: 100, humanInputGraceMs: 500 } });
    const admitted = admit(spec({ humanInput: true }));
    dispatcher.start();
    await wait(() => runs.length === 1 && runs[0].prompt !== null, 'running');
    const { id } = await runs[0].channels.humanInput({ question: 'Ship it?', options: ['yes', 'no', 'later'] });
    await pause(300);
    assert.equal(view(admitted).state, 'running', 'three times the inactivity bound, still waiting');
    await wait(() => view(admitted).state === 'human-input', 'ended by the grace period');
    assert.equal(view(admitted).result.data.requestId, id);
});

test('an unverified stop wins: the result is termination_unverified, with the timeout reason kept in the data', async (t) => {
    const { dispatcher, runs, admit, view } = rig(t, { timeouts: { inactivityTimeoutMs: 100 }, quarantineOnEnd: true });
    const admitted = admit();
    dispatcher.start();
    await wait(() => runs.length === 1 && runs[0].prompt !== null, 'running');
    await wait(() => view(admitted).state === 'failed', 'failed');
    const result = view(admitted).result;
    assert.deepEqual([result.status, result.reason, result.classification, result.cleanup], ['failed', 'termination_unverified', 'failed', 'quarantined']);
    assert.equal(result.data.reason, 'inactive_timeout');
});
