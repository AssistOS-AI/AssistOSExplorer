import test from 'node:test';
import './helpers/isolated-ala-home.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createWorkerEngine, normalizeEventRow, SPEC_VERSION } from '../src/lib/execution/workerEngine.mjs';
import { detachReason, stopReason } from '../src/lib/execution/abortReasons.mjs';
import { ConversationSessionStore } from '../src/lib/storage/conversationSessionStore.mjs';
import { ACHILLES_PRIVATE_DIRECTORY_NAME } from '../src/lib/storage/privateDataRoot.mjs';
import { WorkerError, stopOperationId } from '../../server/worker-coordinator/worker-client.mjs';
import { WorkerCoordinatorError } from '../../server/worker-coordinator/errors.mjs';
import { phaseOriginId } from '../../server/worker-coordinator/flow-origins.mjs';

// The worker engine against a fake coordinator hop (decision M-12): an interactive turn opens one event
// subscription with its admission grant and reattaches only with a grant the user supplies; each user
// control carries its own request's grant; a RoboFlow phase runs on the coordinator identity and its
// binding. Records go through the shared ALA record handler, so the streamed events are alaEngine's.
const ROBOT = 'AAAAAAAAAAAAAAAAAAAAAA';
const REFERENCE = 'r'.repeat(22);
const ORIGIN = 'BBBBBBBBBBBBBBBBBBBBBA';
const grantOf = (exp, mark = '') => `h.${Buffer.from(JSON.stringify({ sub: 'user:alice', exp, mark })).toString('base64url')}.s`;
const freshGrant = (mark = '') => grantOf(Math.floor(Date.now() / 1000) + 300, mark);
const evidenceOf = (grant) => ({ ok: true, principal: 'user:alice', grant });
const tick = (ms = 1) => new Promise((resolve) => setTimeout(resolve, ms));
const CONFIGURATION = { backend: 'codex', settings: { codingAgents: ['codex'] } };

const ala = (record, sequence) => ({ seq: sequence, at: new Date().toISOString(), kind: 'ala', record });
const state = (value, sequence, result) => ({ seq: sequence, at: new Date().toISOString(), kind: 'state', state: value, ...(result ? { result } : {}) });
const SELECTED = { type: 'coding-agent-selected', agent: 'codex', permissionMode: 'full-access', model: 'm' };
const MESSAGE = { type: 'coding-agent-message', agent: 'codex', message: 'Working' };
const FINAL = (message) => ({ type: 'coding-agent-final', agent: 'codex', message });
const DONE = { state: 'completed', result: { status: 'completed', outputText: 'Final answer' } };
const dropped = () => new WorkerCoordinatorError('worker_stream_dropped', 503);

// A fake worker client. `subscribe` serves the rows after the cursor; with `hold` it then stays open
// until aborted (a dropped stream), the way a running execution's stream does. `poll` serves pages.
function scripted(rows, { snapshot = DONE, hold = false } = {}) {
    const calls = { subscribe: [], events: [], read: [], control: [], admit: [], lookup: [], getRobot: 0 };
    const client = {
        calls, rows,
        async subscribe(referenceId, { after }, auth, { signal } = {}) {
            calls.subscribe.push({ referenceId, after, auth });
            return (async function* stream() {
                let cursor = after;
                for (;;) {
                    const next = rows.find((row) => row.seq > cursor);
                    if (next) { cursor = next.seq; yield next; continue; }
                    if (!hold) return;
                    if (signal?.aborted) throw dropped();
                    await tick(2);
                }
            }());
        },
        async events(referenceId, { after, limit }, auth) {
            calls.events.push({ referenceId, after, limit, auth });
            const page = rows.filter((row) => row.seq > after).slice(0, limit);
            return { events: page, nextAfter: page.length ? page.at(-1).seq : after };
        },
        async read(referenceId, auth) {
            calls.read.push({ referenceId, auth });
            return typeof snapshot === 'function' ? snapshot() : snapshot;
        },
        async control(referenceId, body, auth) { calls.control.push({ referenceId, body, auth }); return { outcome: 'accepted' }; },
        async admit(body, auth) { calls.admit.push({ body, auth }); return { referenceId: REFERENCE, state: 'queued', originRequestId: body.originRequestId }; },
        async lookup(origin, auth) { calls.lookup.push({ origin, auth }); return null; },
        async getRobot() { calls.getRobot += 1; return { configuration: CONFIGURATION }; },
    };
    return client;
}

const COMPLETE_ROWS = () => [state('queued', 1), state('running', 2), ala(SELECTED, 3), ala(MESSAGE, 4), ala(FINAL('Final answer'), 5), state('completed', 6)];

async function harness(t, { rows = COMPLETE_ROWS(), execution = {}, permission = 'full-access', client = scripted(rows), engineOptions = {},
    robot = { id: 'robo', name: 'default', codingAgents: ['codex'], worker: { robotId: ROBOT } }, grant = freshGrant('admission'), freshest = null } = {}) {
    const workingDir = await fs.mkdtemp(path.join(os.tmpdir(), 'worker-engine-'));
    const oldRoot = process.env.PLOINKY_WORKSPACE_ROOT;
    process.env.PLOINKY_WORKSPACE_ROOT = path.dirname(workingDir);
    const store = new ConversationSessionStore({ workingDir });
    const session = await store.createSession();
    const ensured = [];
    const provisioner = {
        async ensureReady(current, auth) { ensured.push({ robot: current, auth }); return { robotId: ROBOT, configRevision: 3, configuration: CONFIGURATION }; },
        desiredConfiguration: () => CONFIGURATION,
    };
    const catalog = { async refresh() { return { skills: [{ name: 'bash', skillDir: workingDir, enabled: true }], taskRepositories: [] }; } };
    const admitted = [];
    const coordinator = {
        async admitTurn(evidence, request) {
            admitted.push({ evidence, request });
            return { status: 200, body: { taskRef: { version: 1, provider: 'p', id: REFERENCE }, state: 'queued', originRequestId: ORIGIN } };
        },
        ...engineOptions.coordinator,
    };
    const engine = createWorkerEngine({ workingDir, sessionStore: store, skillCatalog: catalog, client, provisioner, getRobot: async () => robot,
        settings: { readAchillesSettings: () => ({}), getPermissionMode: () => permission },
        interactions: { cancelTurn() {}, resolve() {}, request: async () => null },
        execution: { robotId: 'robo', ...execution }, sleep: tick, pollMinMs: 1, pollMaxMs: 2, stopWaitMs: 50, evidenceWaitMs: 0,
        ...engineOptions.engine });
    t.after(async () => {
        await engine.close();
        if (oldRoot === undefined) delete process.env.PLOINKY_WORKSPACE_ROOT; else process.env.PLOINKY_WORKSPACE_ROOT = oldRoot;
        await fs.rm(workingDir, { recursive: true, force: true });
    });
    const owner = { coordinator, evidence: evidenceOf(grant), freshest };
    return { engine, client, store, workingDir, sessionId: session.sessionId, ensured, admitted, owner, coordinator, grant };
}

test('a turn is admitted as a version-2 specification and the relayed ALA records produce the events alaEngine emits', async (t) => {
    const h = await harness(t);
    const events = [];
    const result = await h.engine.executeTurn({ sessionId: h.sessionId, prompt: 'Summarize the repo', context: { rawText: 'Summarize the repo' },
        owner: h.owner, onEvent: (event) => events.push(event) });
    assert.equal(result.outputText, 'Final answer');
    assert.equal(h.admitted.length, 1);
    const { request } = h.admitted[0];
    assert.equal(request.conversationId, h.sessionId);
    assert.equal(request.robotId, ROBOT);
    assert.equal(request.configRevision, 3);
    const spec = request.specification;
    assert.equal(spec.version, SPEC_VERSION);
    assert.equal(spec.sessionId, h.sessionId);
    assert.equal(spec.cwd, await fs.realpath(h.workingDir));
    assert.equal(spec.permissions, 'full-access');
    assert.equal(spec.displayText, 'Summarize the repo');
    assert.match(spec.prompt, /Summarize the repo/);
    assert.ok(spec.ignore.includes(path.resolve(spec.cwd, ACHILLES_PRIVATE_DIRECTORY_NAME)));
    assert.equal(Object.hasOwn(spec, 'home'), false, 'no robot home is sent');
    assert.equal(JSON.stringify(spec).includes('/robots/'), false);
    assert.equal(spec.resume, undefined);
    assert.ok(events.some((event) => event.type === 'progress' && /Connecting to robot/.test(event.reason)));
    assert.ok(events.some((event) => event.type === 'progress' && event.reason === 'Starting ALA'));
    assert.ok(events.some((event) => event.type === 'turn-started' && event.turnId));
    assert.deepEqual(events.find((event) => event.type === 'coding-agent-selected'), { ...SELECTED, effort: null });
    assert.deepEqual(events.find((event) => event.type === 'coding-agent-message'), MESSAGE);
    assert.deepEqual(events.find((event) => event.type === 'coding-agent-final'), FINAL('Final answer'));
    // ONE subscription, opened with the admission grant and no polling.
    assert.equal(h.client.calls.subscribe.length, 1);
    assert.deepEqual(h.client.calls.subscribe[0], { referenceId: REFERENCE, after: 0, auth: { grant: h.grant } });
    assert.equal(h.client.calls.events.length, 0, 'an interactive turn never polls with per-request grants');
    assert.equal(h.admitted[0].evidence.grant, h.grant);
    const stored = h.store.loadSession(h.sessionId);
    assert.equal(stored.messages.at(-1).role, 'assistant');
    assert.equal(stored.messages.at(-1).status, 'completed');
    assert.equal(stored.engine.backend, 'codex');
    assert.equal(stored.engine.robotId, 'robo');
    h.admitted.length = 0;
    h.client.calls.subscribe.length = 0;
    await h.engine.executeTurn({ sessionId: h.sessionId, prompt: 'Next', owner: h.owner });
    assert.equal(h.admitted[0].request.specification.resume, true);
});

test('a dropped stream is reattached from its cursor with the newest grant the user supplied', async (t) => {
    const rows = COMPLETE_ROWS();
    const base = scripted(rows);
    let opens = 0;
    const original = base.subscribe;
    base.subscribe = async (referenceId, window, auth, options) => {
        opens += 1;
        if (opens === 1) {
            base.calls.subscribe.push({ referenceId, ...window, auth });
            return (async function* first() { yield rows[0]; yield rows[1]; yield rows[2]; supplied = evidenceOf(later); throw dropped(); }());
        }
        return original(referenceId, window, auth, options);
    };
    const later = freshGrant('later-envelope');
    let supplied = null;
    const h = await harness(t, { client: base, freshest: () => supplied });
    const events = [];
    // The user's next envelope arrives while the stream is down (set as the first stream breaks).
    const result = await h.engine.executeTurn({ sessionId: h.sessionId, prompt: 'p', owner: h.owner, onEvent: (event) => events.push(event) });
    assert.equal(result.outputText, 'Final answer');
    assert.equal(opens, 2);
    assert.equal(base.calls.subscribe[0].auth.grant, h.grant, 'opened with the admission grant');
    assert.equal(base.calls.subscribe[1].after, 3, 'reattached from the cursor');
    assert.equal(base.calls.subscribe[1].auth.grant, later, 'with the grant of the later envelope, not a stored one');
    assert.equal(events.filter((event) => event.type === 'coding-agent-selected').length, 1, 'a row is never replayed');
    assert.equal(base.calls.events.length, 0);
});

test('a grant that expires while the stream is down ends the call with a named error; the execution keeps running', async (t) => {
    const rows = [state('running', 1), ala(SELECTED, 2)];
    const base = scripted(rows);
    base.subscribe = async (referenceId, window, auth) => {
        base.calls.subscribe.push({ referenceId, ...window, auth });
        return (async function* shortLived() { yield rows[0]; await tick(1300); throw dropped(); }());
    };
    // Usable when admitted, past the 1-second margin by the time the stream drops.
    const h = await harness(t, { client: base, grant: grantOf(Math.floor(Date.now() / 1000) + 2, 'short') });
    await assert.rejects(h.engine.executeTurn({ sessionId: h.sessionId, prompt: 'p', owner: h.owner }),
        (error) => error.code === 'owner_evidence_expired' && error.execution === 'may_still_run');
    assert.equal(base.calls.subscribe.length, 1);
    assert.equal(base.calls.control.length, 0, 'ending the call sends no stop');
});

test('a finished turn whose result needs a fresh grant says it is finished and retrievable', async (t) => {
    const rows = [state('running', 1), ala(SELECTED, 2), ala(FINAL('Final answer'), 3)];
    const base = scripted(rows);
    base.subscribe = async (referenceId, window, auth) => {
        base.calls.subscribe.push({ referenceId, ...window, auth });
        return (async function* late() { yield rows[0]; yield rows[1]; yield rows[2]; await tick(1300); yield state('completed', 4); }());
    };
    const h = await harness(t, { client: base, grant: grantOf(Math.floor(Date.now() / 1000) + 2, 'short') });
    await assert.rejects(h.engine.executeTurn({ sessionId: h.sessionId, prompt: 'p', owner: h.owner }),
        (error) => error.code === 'owner_evidence_expired' && error.execution === 'finished');
    assert.equal(base.calls.read.length, 0);

    // A terminal row that carries its result needs no read at all.
    const embedded = scripted([state('running', 1), ala(SELECTED, 2), ala(FINAL('Embedded'), 3), state('completed', 4, { status: 'completed', outputText: 'Embedded' })]);
    const g = await harness(t, { client: embedded });
    assert.equal((await g.engine.executeTurn({ sessionId: g.sessionId, prompt: 'p', owner: g.owner })).outputText, 'Embedded');
    assert.equal(embedded.calls.read.length, 0);
});

test('a bounded stream is reported, never silent: truncated rows and retention gaps become diagnostics', async (t) => {
    const client = scripted([state('running', 1), { seq: 2, at: 'x', kind: 'truncated', dropped: 7, reason: 'event-bound' }, ala(SELECTED, 3), ala(FINAL('Final answer'), 4), state('completed', 5)]);
    const h = await harness(t, { client });
    const events = [];
    await h.engine.executeTurn({ sessionId: h.sessionId, prompt: 'p', owner: h.owner, onEvent: (event) => events.push(event) });
    const truncated = events.filter((event) => event.type === 'diagnostic' && event.category === 'worker-stream');
    assert.equal(truncated.length, 1);
    assert.match(truncated[0].message, /7 dropped.*event-bound/);

    const rows = [state('running', 10), ala(SELECTED, 11), ala(FINAL('Final answer'), 12), state('completed', 13)];
    const gap = scripted(rows);
    const original = gap.subscribe;
    let first = true;
    gap.subscribe = async (...args) => (first ? (first = false, (async function* gapFirst() { yield { gap: true, snapshotSequence: 9 }; yield* await original(...args); }())) : original(...args));
    const second = await harness(t, { client: gap });
    const seen = [];
    await second.engine.executeTurn({ sessionId: second.sessionId, prompt: 'p', owner: second.owner, onEvent: (event) => seen.push(event) });
    assert.ok(seen.some((event) => event.type === 'diagnostic' && /truncated/.test(event.message)));
});

test('event rows are read in the contract form and in the worker state-event form', () => {
    assert.deepEqual(normalizeEventRow({ seq: 2, kind: 'ala', record: { type: 'x' } }), { sequence: 2, kind: 'ala', record: { type: 'x' } });
    assert.deepEqual(normalizeEventRow({ seq: 3, kind: 'truncated', dropped: 4, reason: 'r' }), { sequence: 3, kind: 'truncated', dropped: 4, reason: 'r' });
    assert.deepEqual(normalizeEventRow({ sequence: 4, type: 'state', data: { state: 'running' } }), { sequence: 4, kind: 'state', state: 'running', result: undefined });
    assert.deepEqual(normalizeEventRow({ sequence: 6, at: 'x', type: 'ala', data: { record: { type: 'y' } } }), { sequence: 6, kind: 'ala', record: { type: 'y' } });
    assert.deepEqual(normalizeEventRow({ sequence: 7, type: 'truncated', data: { dropped: 2, reason: 'record_too_large' } }), { sequence: 7, kind: 'truncated', dropped: 2, reason: 'record_too_large' });
    assert.equal(normalizeEventRow({ sequence: 5, type: 'other' }).kind, 'unknown');
});

test('a failed result is an explicit error and termination_unverified is marked as such', async (t) => {
    const failed = await harness(t, { client: scripted(COMPLETE_ROWS(), { snapshot: { state: 'failed', result: { status: 'failed', reason: 'termination_unverified', outputText: 'partial' } } }) });
    await assert.rejects(failed.engine.executeTurn({ sessionId: failed.sessionId, prompt: 'p', owner: failed.owner }),
        (error) => error.terminationUnverified === true && /termination_unverified/.test(error.message));
    assert.equal(failed.store.loadSession(failed.sessionId).messages.at(-1).status, 'failed');
    const cancelled = await harness(t, { client: scripted(COMPLETE_ROWS(), { snapshot: { state: 'cancelled', result: { status: 'cancelled', outputText: '' } } }) });
    await assert.rejects(cancelled.engine.executeTurn({ sessionId: cancelled.sessionId, prompt: 'p', owner: cancelled.owner }),
        (error) => error.name === 'AbortError' && error.exitCode === 130);
});

// An execution that runs until it is stopped: the stop control ends it on the worker.
function endsOnStop(rows) {
    const client = scripted(rows, { hold: true, snapshot: () => (rows.some((row) => row.state === 'cancelled')
        ? { state: 'cancelled', result: { status: 'cancelled', outputText: '' } } : { state: 'running' }) });
    const control = client.control;
    client.control = async (referenceId, body, auth) => {
        const result = await control(referenceId, body, auth);
        if (body.op === 'stop') rows.push(state('cancelled', rows.at(-1).seq + 1));
        return result;
    };
    return client;
}

test('a user stop carries its own request grant; a detach sends nothing', async (t) => {
    const stopClient = endsOnStop([state('running', 1), ala(SELECTED, 2)]);
    const stopped = await harness(t, { client: stopClient });
    const controller = new AbortController();
    const pending = stopped.engine.executeTurn({ sessionId: stopped.sessionId, prompt: 'p', owner: stopped.owner, signal: controller.signal });
    await tick(30);
    const stopGrant = freshGrant('stop-request');
    controller.abort(stopReason({ owner: { evidence: evidenceOf(stopGrant) } }));
    await assert.rejects(pending, (error) => error.name === 'AbortError');
    assert.equal(stopClient.calls.control.length, 1);
    assert.deepEqual(stopClient.calls.control[0].auth, { grant: stopGrant }, 'the stopping request\'s own grant, not the admission grant');
    assert.equal(stopClient.calls.control[0].body.op, 'stop');
    assert.equal(stopClient.calls.control[0].body.operationId, stopOperationId(REFERENCE));

    const holdClient = scripted([state('running', 1), ala(SELECTED, 2)], { hold: true });
    const detached = await harness(t, { client: holdClient });
    const second = new AbortController();
    const pending2 = detached.engine.executeTurn({ sessionId: detached.sessionId, prompt: 'p', owner: detached.owner, signal: second.signal });
    await tick(30);
    second.abort(detachReason());
    await assert.rejects(pending2, (error) => error.code === 'ROBOTEAM_DETACH');
    assert.equal(holdClient.calls.control.length, 0, 'detaching sends no control');
    assert.equal(detached.store.loadSession(detached.sessionId).messages.at(-1).status, 'pending');
});

test('a stop with no usable grant of its own, or one the worker refuses, is reported as not delivered', async (t) => {
    // Escape key or Live Sessions abort: no envelope, so no grant. Nothing is sent under another credential.
    const bare = scripted([state('running', 1)], { hold: true });
    const a = await harness(t, { client: bare });
    const controller = new AbortController();
    const pending = a.engine.executeTurn({ sessionId: a.sessionId, prompt: 'p', owner: a.owner, signal: controller.signal });
    await tick(30);
    controller.abort('esc');
    await assert.rejects(pending, (error) => error.code === 'worker_stop_not_authorized' && error.execution === 'may_still_run');
    assert.equal(bare.calls.control.length, 0);

    const refused = scripted([state('running', 1)], { hold: true });
    refused.control = async () => { throw new WorkerError('forbidden', 403); };
    const b = await harness(t, { client: refused });
    const second = new AbortController();
    const pending2 = b.engine.executeTurn({ sessionId: b.sessionId, prompt: 'p', owner: b.owner, signal: second.signal });
    await tick(30);
    second.abort(stopReason({ owner: { evidence: evidenceOf(freshGrant('stop')) } }));
    await assert.rejects(pending2, (error) => error.code === 'worker_stop_not_authorized' && error.execution === 'may_still_run');
});

test('a worker failure at any step is an explicit error; nothing runs locally', async (t) => {
    const refusedAdmission = await harness(t, { engineOptions: { coordinator: { admitTurn: async () => ({ status: 503, body: { error: 'worker_unreachable' } }) } } });
    await assert.rejects(refusedAdmission.engine.executeTurn({ sessionId: refusedAdmission.sessionId, prompt: 'p', owner: refusedAdmission.owner }),
        (error) => error instanceof WorkerError && error.code === 'worker_unreachable' && error.status === 503);
    assert.equal(refusedAdmission.client.calls.subscribe.length, 0);

    const provisioning = await harness(t);
    const failing = createWorkerEngine({ workingDir: provisioning.workingDir, sessionStore: provisioning.store, skillCatalog: { async refresh() { return { skills: [] }; } },
        client: provisioning.client, getRobot: async () => ({ id: 'robo' }),
        provisioner: { ensureReady: async () => { throw new WorkerError('worker_robot_not_ready', 503); }, desiredConfiguration: () => CONFIGURATION },
        settings: { readAchillesSettings: () => ({}), getPermissionMode: () => 'full-access' }, execution: { robotId: 'robo' }, sleep: tick });
    await assert.rejects(failing.executeTurn({ sessionId: provisioning.sessionId, prompt: 'p', owner: provisioning.owner }), (error) => error.code === 'worker_robot_not_ready');
    await failing.close();
});

test('ask-for-approval and a missing owner are refused before anything is admitted', async (t) => {
    const approval = await harness(t, { permission: 'ask-for-approval' });
    await assert.rejects(approval.engine.executeTurn({ sessionId: approval.sessionId, prompt: 'p', owner: approval.owner }), (error) => error.code === 'worker_permissions_unsupported');
    assert.equal(approval.admitted.length, 0);
    const none = await harness(t);
    await assert.rejects(none.engine.executeTurn({ sessionId: none.sessionId, prompt: 'p' }), (error) => error.code === 'owner_evidence_unavailable' && error.status === 403);
    assert.equal(none.admitted.length, 0);
    assert.equal(none.ensured.length, 0);
    await assert.rejects(none.engine.executeTurn({ sessionId: none.sessionId, prompt: 'p', owner: { coordinator: none.coordinator, evidence: { ok: false, code: 'owner_evidence_unavailable' } } }),
        (error) => error.code === 'owner_evidence_unavailable');
});

test('a RoboFlow phase runs on the coordinator identity and its binding: admission, polling and stop with no user grant', async (t) => {
    const flowId = `flow_${'ab'.repeat(12)}`;
    const origin = phaseOriginId({ flowId, instanceId: 'inv_1', runtimeTaskId: 'task-1' });
    const h = await harness(t, { execution: { workflowExecution: true, worker: { bindingId: flowId, originRequestId: origin } } });
    const result = await h.engine.executeTurn({ sessionId: h.sessionId, prompt: 'Phase work' });
    assert.equal(result.outputText, 'Final answer');
    assert.equal(h.admitted.length, 0, 'no WebChat admission');
    assert.deepEqual(h.client.calls.admit[0].auth, { bindingId: flowId });
    assert.equal(h.client.calls.admit[0].body.originRequestId, origin);
    assert.equal(h.client.calls.admit[0].body.kind, 'task');
    assert.equal(h.client.calls.admit[0].body.specification.workflowExecution, true);
    assert.deepEqual(h.client.calls.events[0].auth, { bindingId: flowId });
    assert.equal(h.client.calls.subscribe.length, 0, 'a background phase polls under its binding');
    assert.ok(h.client.calls.read.every((call) => call.auth.grant === undefined));
    assert.equal(origin, phaseOriginId({ flowId, instanceId: 'inv_1', runtimeTaskId: 'task-1' }));
    assert.notEqual(origin, phaseOriginId({ flowId, instanceId: 'inv_1', runtimeTaskId: 'task-2' }));

    // The system-initiated stop of a phase carries the coordinator identity and the binding.
    const open = endsOnStop([state('running', 1), ala(SELECTED, 2)]);
    open.events = async (referenceId, { after }, auth) => { open.calls.events.push({ referenceId, after, auth }); const page = open.rows.filter((row) => row.seq > after); return { events: page, nextAfter: page.length ? page.at(-1).seq : after }; };
    const g = await harness(t, { client: open, execution: { worker: { bindingId: flowId, originRequestId: origin } } });
    const controller = new AbortController();
    const pending = g.engine.executeTurn({ sessionId: g.sessionId, prompt: 'p', signal: controller.signal });
    await tick(30);
    controller.abort(stopReason());
    await assert.rejects(pending, (error) => error.name === 'AbortError');
    assert.deepEqual(open.calls.control[0].auth, { bindingId: flowId });
    assert.equal(open.calls.control[0].body.op, 'stop');
});

test('a lost admission reply is recovered by lookup of the persisted origin with the admission grant', async (t) => {
    const client = scripted(COMPLETE_ROWS());
    client.lookup = async (origin, auth) => { client.calls.lookup.push({ origin, auth }); return { referenceId: REFERENCE, state: 'running', originRequestId: origin }; };
    const h = await harness(t, { client, engineOptions: { coordinator: { admitTurn: async () => ({ status: 503, body: { error: 'worker_reply_unknown', originRequestId: ORIGIN } }) } } });
    const result = await h.engine.executeTurn({ sessionId: h.sessionId, prompt: 'p', owner: h.owner });
    assert.equal(result.outputText, 'Final answer');
    assert.deepEqual(client.calls.lookup, [{ origin: ORIGIN, auth: { grant: h.grant } }]);
    assert.equal(client.calls.subscribe[0].referenceId, REFERENCE);
});

test('an expired grant is refused at the start unless a later envelope supplied a fresh one', async (t) => {
    const expired = grantOf(Math.floor(Date.now() / 1000) - 5, 'old');
    const none = await harness(t, { grant: expired });
    await assert.rejects(none.engine.executeTurn({ sessionId: none.sessionId, prompt: 'p', owner: none.owner }), (error) => error.code === 'owner_evidence_expired');
    assert.equal(none.admitted.length, 0);
    const fresh = freshGrant('fresh');
    const later = await harness(t, { grant: expired, freshest: () => evidenceOf(fresh) });
    await later.engine.executeTurn({ sessionId: later.sessionId, prompt: 'p', owner: later.owner });
    assert.equal(later.admitted[0].evidence.grant, fresh);
    assert.equal(later.client.calls.subscribe[0].auth.grant, fresh);
});

test('a message control carries the grant of its own request; one without is rejected, never sent under another credential', async (t) => {
    const client = scripted([state('running', 1), ala(SELECTED, 2)], { hold: true });
    const h = await harness(t, { client });
    let send;
    const events = [];
    const controller = new AbortController();
    const pending = h.engine.executeTurn({ sessionId: h.sessionId, prompt: 'p', owner: h.owner, signal: controller.signal, onEvent: (event) => events.push(event), onControl: (writer) => { send = writer; } });
    await tick(30);
    const messageGrant = freshGrant('message-request');
    assert.equal(send({ type: 'message', id: 'msg-1', message: 'Also check the tests', owner: { evidence: evidenceOf(messageGrant) } }), true);
    assert.equal(send({ type: 'message', id: 'msg-2', message: 'No grant of its own' }), true);
    assert.equal(send({ type: 'interaction-response', id: 'x' }), false);
    await tick(30);
    assert.equal(client.calls.control.length, 1);
    const control = client.calls.control[0];
    assert.deepEqual(control.auth, { grant: messageGrant });
    assert.equal(control.body.op, 'message');
    assert.deepEqual(Object.keys(control.body.payload).sort(), ['displayText', 'id', 'message']);
    assert.equal(control.body.payload.displayText, 'Also check the tests');
    assert.ok(events.some((event) => event.type === 'message-rejected' && event.id === 'msg-2' && event.error === 'owner_evidence_unavailable'));
    controller.abort(detachReason());
    await assert.rejects(pending, (error) => error.code === 'ROBOTEAM_DETACH');
});

test('model reads come from the worker robot, never from a RoboTeam home', async (t) => {
    const info = await harness(t);
    assert.deepEqual(await info.engine.getModel({ sessionId: info.sessionId }), { backend: 'codex', model: null, effort: null });
    assert.equal(info.client.calls.getRobot, 1, 'read from robots/get');
    const set = await info.engine.setModel({ sessionId: info.sessionId, backend: 'codex', model: 'gpt-x', effort: 'high' });
    assert.deepEqual(set, { backend: 'codex', model: 'gpt-x', effort: 'high' });
    await assert.rejects(info.engine.listModels({ sessionId: info.sessionId }), (error) => error.code === 'worker_model_listing_unavailable');
    await assert.rejects(info.engine.setModel({ sessionId: info.sessionId, backend: 'opencode', model: 'x' }), /backend changed/);
});

test('a protocol failure stops the worker execution first; an undelivered stop says it may still run', async (t) => {
    const mismatch = scripted([state('running', 1), ala({ ...SELECTED, agent: 'claude' }, 2), state('completed', 3)], { hold: true });
    const h = await harness(t, { client: mismatch });
    await assert.rejects(h.engine.executeTurn({ sessionId: h.sessionId, prompt: 'p', owner: h.owner }), /unexpected backend or permission policy/);
    assert.deepEqual(mismatch.calls.control.map((call) => call.body.op), ['stop'], 'one stop, sent before the error surfaced');
    assert.ok(mismatch.calls.control[0].auth.grant, 'with the best grant available');

    const undelivered = scripted([state('running', 1), ala({ ...SELECTED, agent: 'claude' }, 2)], { hold: true });
    undelivered.control = async () => { throw new WorkerError('forbidden', 403); };
    const g = await harness(t, { client: undelivered });
    await assert.rejects(g.engine.executeTurn({ sessionId: g.sessionId, prompt: 'p', owner: g.owner }),
        (error) => /unexpected backend/.test(error.message) && error.execution === 'may_still_run');
});

test('a transient stream or open failure reattaches within a bound; anything else ends the turn', async (t) => {
    const rows = [state('running', 1), ala(SELECTED, 2), ala(FINAL('Final answer'), 3), state('completed', 4)];
    const flaky = scripted(rows);
    const original = flaky.subscribe;
    let failures = 0;
    flaky.subscribe = async (...args) => { if (failures < 2) { failures += 1; throw new WorkerError(failures === 1 ? 'worker_reply_unknown' : 'worker_route_unavailable', 503); } return original(...args); };
    const h = await harness(t, { client: flaky });
    assert.equal((await h.engine.executeTurn({ sessionId: h.sessionId, prompt: 'p', owner: h.owner })).outputText, 'Final answer');
    assert.equal(failures, 2);
    assert.equal(flaky.calls.control.length, 0, 'a read failure never becomes a control');

    const down = scripted([state('running', 1)]);
    let attempts = 0;
    down.subscribe = async () => { attempts += 1; throw new WorkerError('worker_unreachable', 503); };
    const bounded = await harness(t, { client: down, engineOptions: { engine: { transientWaitMs: 30 } } });
    await assert.rejects(bounded.engine.executeTurn({ sessionId: bounded.sessionId, prompt: 'p', owner: bounded.owner }),
        (error) => error.code === 'worker_unreachable' && error.execution === 'may_still_run');
    assert.ok(attempts > 1);
    assert.equal(down.calls.control.length, 0);

    const missing = scripted([state('running', 1)]);
    let tries = 0;
    missing.subscribe = async () => { tries += 1; throw new WorkerError('not_found', 404); };
    const gone = await harness(t, { client: missing });
    await assert.rejects(gone.engine.executeTurn({ sessionId: gone.sessionId, prompt: 'p', owner: gone.owner }), (error) => error.code === 'not_found');
    assert.equal(tries, 1, 'not retried');
});

test('inputs the worker cannot use are refused or reported, never dropped silently', async (t) => {
    const loopback = await harness(t, { execution: { mcpServers: 'desktop=http://127.0.0.1:3100/mcp' } });
    await assert.rejects(loopback.engine.executeTurn({ sessionId: loopback.sessionId, prompt: 'p', owner: loopback.owner }), (error) => error.code === 'worker_mcp_loopback_unsupported');
    assert.equal(loopback.admitted.length, 0);

    const old = process.env.ROBOTEAM_HUMAN_INPUT_DIRECTORY;
    process.env.ROBOTEAM_HUMAN_INPUT_DIRECTORY = '/var/lib/roboteam-human-input-test';
    t.after(() => { if (old === undefined) delete process.env.ROBOTEAM_HUMAN_INPUT_DIRECTORY; else process.env.ROBOTEAM_HUMAN_INPUT_DIRECTORY = old; });
    const outside = await harness(t);
    const events = [];
    await outside.engine.executeTurn({ sessionId: outside.sessionId, prompt: 'p', owner: outside.owner, onEvent: (event) => events.push(event) });
    assert.ok(events.some((event) => event.type === 'diagnostic' && /human-input channel is outside the shared workspace/.test(event.message)));
    assert.equal(JSON.stringify(outside.admitted[0].request.specification).includes('roboteam-human-input-test'), false);
});
