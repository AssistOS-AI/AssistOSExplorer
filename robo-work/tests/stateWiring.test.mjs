import assert from 'node:assert/strict';
import test from 'node:test';
import {
    CHANNEL_EVENT_RESERVE, EVENTS_PAGE_MAX_BYTES, OUTPUT_EVENTS_PER_REFERENCE, OUTPUT_EVENT_MAX_BYTES, RESERVED_MARKER_SLOTS, TRUNCATED_EVENTS_PER_REFERENCE
} from '../server/stateObservation.mjs';
import { ANSWER_MAX_CHARS, CHANNEL_EVENT_MAX_BYTES } from '../server/stateObservation.mjs';
import { SPECIFICATION_VERSION_2, refuseEnvironmentSelection, validateSpecification, validateSpecificationV2 } from '../server/stateProtocol.mjs';
import {
    LIMITS, WORKSPACE, admitRequest, expectCode, makeTempDir, newId, openStore, readyRobot, robotConfig, syntheticContext
} from './helpers/synthetic.mjs';

// RoboWork r10 wiring, state side: the version-2 execution specification, output events (`ala`, `truncated`) with their
// bounds, pending-control delivery and the trusted-adapter reads of the execution engine.

const LIMITS_X = Object.freeze({ ...LIMITS, requestBytes: 65536, resultBytes: 4096, admissions: 64, receipts: 256, bindings: 8, controls: 16, tokenReplayEntries: 16 });
const ROBOTS = `workspace:${WORKSPACE}`;
const SESSION = '0f8c2f1e-3b53-4a56-9b0f-6b1f0d5e9a11';

const spec2 = (overrides = {}) => ({
    version: 2, prompt: 'do the thing', displayText: 'do the thing', sessionId: SESSION, turnId: 'turn_1', cwd: '/ws/project',
    permissions: 'full-access', ...overrides
});
const user = (id) => syntheticContext({ originKey: `user:${id}`, ownerId: `user:${id}`, scope: `scope-${id}`, robotOwnerId: ROBOTS });
// The coordinator-API row, the only row that admits session turns.
const owner = (id) => syntheticContext({
    originNamespace: 'coordinator:agent:fixtures/roboteam', originKey: `owner:user:${id}`, ownerId: `user:${id}`, scope: `scope-co-${id}`, robotOwnerId: ROBOTS
});
const adapter = () => syntheticContext({ scope: 'scope-adapter' });

function setup(t) {
    const store = openStore(makeTempDir(t), { limits: LIMITS_X });
    t.after(() => store.close());
    const robotId = readyRobot(store, syntheticContext({ robotOwnerId: ROBOTS, scope: 'scope-robots' }));
    return { store, robotId };
}

function running(store, robotId, owner = user('alice'), overrides = {}) {
    const admitted = store.admit(owner, admitRequest(robotId, { specification: spec2(), ...overrides }, owner));
    store.transitionAttempt({ executionId: admitted.executionId, attemptId: admitted.attemptId, expectedState: 'queued', nextState: 'running' });
    return { owner, admitted, ids: { executionId: admitted.executionId, attemptId: admitted.attemptId } };
}

test('r10 Q1 = A: refuseEnvironmentSelection refuses a nonempty Environment only; the specification validators leave the key alone', () => {
    refuseEnvironmentSelection(spec2({ environment: '' }));
    refuseEnvironmentSelection(spec2());
    refuseEnvironmentSelection('not an object');
    for (const environment of ['Repo/agent', ' ', 'x'.repeat(5000)]) {
        assert.throws(() => refuseEnvironmentSelection(spec2({ environment })), (error) => error.code === 'environment_unavailable', JSON.stringify(environment).slice(0, 20));
    }
    for (const environment of [7, null, true, ['a/b'], { ref: 'a/b' }]) {
        assert.throws(() => refuseEnvironmentSelection(spec2({ environment })), (error) => error.code === 'invalid_request', JSON.stringify(environment));
    }
    // Recorded data (outbox) goes through validateSpecification and must not be refused by the admission rule.
    validateSpecificationV2(spec2({ environment: 'Repo/agent' }), LIMITS_X);
    validateSpecification(spec2({ environment: 'Repo/agent' }), LIMITS_X);
    validateSpecification({ environment: 'Repo/agent', step: 1 }, LIMITS_X);
});

test('version 2 specification: every field is checked, optional fields and folders are accepted', () => {
    assert.equal(spec2().version, SPECIFICATION_VERSION_2);
    validateSpecificationV2(spec2(), LIMITS_X);
    validateSpecificationV2(spec2({
        model: 'gpt-5', effort: 'high', codingAgent: 'codex', resume: true, mcpServers: 'a=http://x:1', workflowExecution: true,
        folders: [{ path: '/ws/skills', access: 'read', as: 'skills' }, { path: '/ws/out', access: 'write' }, { path: '/ws/s', access: 'read', at: '/ws/project/.agents/skills', expose: true }],
        ignore: ['/ws/project/.achilles'], sessionId: 'session:chat-1.v2', turnId: 'turn:1'
    }), LIMITS_X);
    // M-20: no cwd means no project selected.
    const { cwd, ...withoutCwd } = spec2();
    void cwd;
    validateSpecificationV2(withoutCwd, LIMITS_X);
    const big = { requestBytes: 8 * 1024 * 1024 };
    validateSpecificationV2(spec2({ prompt: 'x'.repeat(1024 * 1024), displayText: 'y'.repeat(256 * 1024) }), big);
    assert.throws(() => validateSpecificationV2(spec2({ prompt: 'x'.repeat(1024 * 1024 + 1) }), big), (error) => error.code === 'invalid_request', 'prompt over 1 MiB');
    assert.throws(() => validateSpecificationV2(spec2({ displayText: 'y'.repeat(256 * 1024 + 1) }), big), (error) => error.code === 'invalid_request', 'displayText over 256 KiB');
    const bad = {
        version: { version: 3 }, prompt: { prompt: '' }, displayText: { displayText: 5 }, sessionId: { sessionId: 'has space' }, sessionLong: { sessionId: 'x'.repeat(129) },
        turnId: { turnId: 'has space' }, relativeCwd: { cwd: 'ws/project' }, dotdot: { cwd: '/ws/../etc' }, permissions: { permissions: 'root' },
        agent: { codingAgent: 'vim' }, extra: { surprise: 1 }, folderAccess: { folders: [{ path: '/ws/a', access: 'rw' }] },
        folderPath: { folders: [{ path: 'ws/a', access: 'read' }] }, folderKey: { folders: [{ path: '/ws/a', access: 'read', home: '/x' }] },
        alias: { folders: [{ path: '/ws/a', access: 'read', as: 'a' }, { path: '/ws/b', access: 'read', as: 'a' }] },
        atAndAs: { folders: [{ path: '/ws/a', access: 'read', as: 'a', at: '/ws/b' }] }, atRelative: { folders: [{ path: '/ws/a', access: 'read', at: 'b' }] },
        exposeWrite: { folders: [{ path: '/ws/a', access: 'write', as: 'a', expose: true }] }, exposeBare: { folders: [{ path: '/ws/a', access: 'read', expose: true }] },
        ignore: { ignore: ['rel'] }, mcp: { mcpServers: 'a\nb' }, flag: { resume: 'yes' }, long: { prompt: 'x'.repeat(200 * 1024) }
    };
    for (const [name, overrides] of Object.entries(bad)) {
        assert.throws(() => validateSpecificationV2(spec2(overrides), LIMITS_X), (error) => error.code === 'invalid_request', name);
    }
    assert.throws(() => validateSpecificationV2(spec2({ prompt: 'x'.repeat(70000) }), LIMITS_X), (error) => error.code === 'invalid_request', 'requestBytes bound');
});

test('admission accepts a version 2 specification for task and turn kinds and keeps version 1 and generic tasks', (t) => {
    const { store, robotId } = setup(t);
    const alice = owner('alice');
    store.admit(alice, admitRequest(robotId, { specification: spec2() }, alice));
    store.admit(alice, admitRequest(robotId, { kind: 'turn', logical: { sessionKey: 'chat-1' }, specification: spec2() }, alice));
    store.admit(alice, admitRequest(robotId, { specification: { prompt: 'generic' } }, alice));
    expectCode(assert, () => store.admit(alice, admitRequest(robotId, { specification: spec2({ cwd: 'relative' }) }, alice)), 'invalid_request');
    expectCode(assert, () => store.admit(alice, admitRequest(robotId, { kind: 'turn', logical: { sessionKey: 'chat-2' }, specification: spec2({ permissions: 'x' }) }, alice)), 'invalid_request');
    const queued = store.listQueuedAdmissions();
    assert.equal(queued.length, 3);
    assert.equal(queued[0].specification.version, 2);
    assert.equal(queued[0].robotId, robotId);
    assert.deepEqual(queued[0].configuration, robotConfig());
    assert.match(queued[0].referenceId, /^[A-Za-z0-9_-]{22}$/u);
});

test('output events are stored after state events, with sequence continuity; bounds produce truncated events', (t) => {
    const { store, robotId } = setup(t);
    const { owner, admitted, ids } = running(store, robotId);
    const referenceId = admitted.reference.id;
    const first = store.recordReferenceEvents({ ...ids, events: [
        { type: 'ala', data: { record: { type: 'progress', reason: 'one' } } },
        { type: 'truncated', data: { dropped: 3, reason: 'relay_backlog' } },
        { type: 'ala', data: { record: { type: 'big', text: 'x'.repeat(OUTPUT_EVENT_MAX_BYTES) } } }
    ] });
    assert.deepEqual(first, { stored: 3, dropped: 0 });
    const listed = store.listReferenceEvents(owner, { referenceId, after: 0, limit: 100 });
    assert.deepEqual(listed.events.map((event) => [event.sequence, event.type]), [[1, 'state'], [2, 'state'], [3, 'ala'], [4, 'truncated'], [5, 'truncated']]);
    assert.deepEqual(listed.events[2].data, { record: { type: 'progress', reason: 'one' } });
    assert.deepEqual(listed.events[3].data, { dropped: 3, reason: 'relay_backlog' });
    assert.deepEqual(listed.events[4].data, { dropped: 1, reason: 'record_too_large' });
    assert.equal(store.observeReference(owner, { referenceId }).sequence, 5);
    // A record too deep for canonical JSON is dropped, never stored half-way, and the batch is not lost.
    let deep = { v: 1 };
    for (let i = 0; i < 30; i += 1) deep = { v: deep };
    assert.deepEqual(store.recordReferenceEvents({ ...ids, events: [{ type: 'ala', data: { record: deep } }, { type: 'ala', data: { record: { type: 'ok' } } }] }), { stored: 1, dropped: 1 });
    expectCode(assert, () => store.recordReferenceEvents({ ...ids, events: [{ type: 'state', data: {} }] }), 'invalid_request');
    expectCode(assert, () => store.recordReferenceEvents({ ...ids, events: [] }), 'invalid_request');
});

test('per-reference caps: ala events stop at the cap, but every drop stays visible in the reserved marker room', (t) => {
    const { store, robotId, owner } = ((ctx) => ({ ...ctx, owner: user('alice') }))(setup(t));
    const { admitted, ids } = running(store, robotId, owner);
    let stored = 0;
    let dropped = 0;
    for (let batch = 0; batch * 1000 < OUTPUT_EVENTS_PER_REFERENCE + 500; batch += 1) {
        const result = store.recordReferenceEvents({ ...ids, events: Array.from({ length: 1000 }, (_, i) => ({ type: 'ala', data: { record: { type: 'n', i } } })) });
        stored += result.stored;
        dropped += result.dropped;
    }
    // The total less the places kept for channel events, and the store's own marker at the first refusal; the rest are counted in `dropped` for the relay's total.
    assert.equal(stored, OUTPUT_EVENTS_PER_REFERENCE - CHANNEL_EVENT_RESERVE + 1);
    assert.equal(dropped, 9000 - (OUTPUT_EVENTS_PER_REFERENCE - CHANNEL_EVENT_RESERVE));
    const markers = () => {
        const found = [];
        for (let after = 0; ;) {
            const page = store.listReferenceEvents(owner, { referenceId: admitted.reference.id, after, limit: 1000 });
            if (page.events.length === 0) return found;
            found.push(...page.events.filter((event) => event.type === 'truncated'));
            after = page.nextAfter;
        }
    };
    assert.deepEqual(markers().map((event) => event.data.reason), ['event_limit']);
    // Ordinary markers cannot take the two reserved slots, so the relay's final total always fits.
    const ordinary = Array.from({ length: TRUNCATED_EVENTS_PER_REFERENCE + 4 }, () => ({ type: 'truncated', data: { dropped: 1, reason: 'relay_backlog' } }));
    const result = store.recordReferenceEvents({ ...ids, events: ordinary });
    assert.equal(result.stored, TRUNCATED_EVENTS_PER_REFERENCE - RESERVED_MARKER_SLOTS - 1);
    assert.deepEqual(store.recordReferenceEvents({ ...ids, events: [{ type: 'truncated', data: { dropped: 808, reason: 'event_limit' } }] }), { stored: 1, dropped: 0 });
    assert.equal(markers().length, TRUNCATED_EVENTS_PER_REFERENCE - 1, 'the store marker, the ordinary markers and the final total');
    assert.deepEqual(markers().at(-1).data, { dropped: 808, reason: 'event_limit' });
    assert.deepEqual(store.recordReferenceEvents({ ...ids, events: [{ type: 'truncated', data: { dropped: 1, reason: 'event_limit' } }] }), { stored: 1, dropped: 0 }, 'one slot is still reserved');
    assert.deepEqual(store.recordReferenceEvents({ ...ids, events: [{ type: 'truncated', data: { dropped: 1, reason: 'event_limit' } }] }), { stored: 0, dropped: 1 });
});

test('an events page is bounded by bytes and still makes progress; output is refused for a queued or terminal attempt', (t) => {
    const { store, robotId } = setup(t);
    const { owner, admitted, ids } = running(store, robotId);
    const text = 'y'.repeat(40 * 1024);
    store.recordReferenceEvents({ ...ids, events: Array.from({ length: 30 }, (_, i) => ({ type: 'ala', data: { record: { type: 't', i, text } } })) });
    const page = store.listReferenceEvents(owner, { referenceId: admitted.reference.id, after: 0, limit: 1000 });
    assert.ok(page.events.length > 1 && page.events.length < 32, `page of ${page.events.length}`);
    assert.ok(Buffer.byteLength(JSON.stringify(page)) < EVENTS_PAGE_MAX_BYTES + 80 * 1024);
    assert.equal(page.nextAfter, page.events.at(-1).sequence);
    let total = page.events.length;
    let after = page.nextAfter;
    for (let pages = 0; pages < 10 && total < 32; pages += 1) {
        const next = store.listReferenceEvents(owner, { referenceId: admitted.reference.id, after, limit: 1000 });
        assert.ok(next.events.length > 0);
        total += next.events.length;
        after = next.nextAfter;
    }
    assert.equal(total, 32);
    const queued = store.admit(owner, admitRequest(robotId, { specification: spec2() }, owner));
    expectCode(assert, () => store.recordReferenceEvents({ executionId: queued.executionId, attemptId: queued.attemptId, events: [{ type: 'ala', data: { record: {} } }] }), 'operation_conflict');
    store.beginAttemptEnd(adapter(), { ...ids, expectedState: 'running', outcome: { classification: 'completed', outputText: 'ok' } });
    // Without unsettled blockers the attempt is terminal at once, and a terminal attempt takes no more output.
    expectCode(assert, () => store.recordReferenceEvents({ ...ids, events: [{ type: 'ala', data: { record: { late: true } } }] }), 'operation_conflict');
});

test('controls: the message payload shape, pending delivery in order, acknowledgement and stop', (t) => {
    const { store, robotId } = setup(t);
    const { owner, admitted, ids } = running(store, robotId);
    const referenceId = admitted.reference.id;
    const control = (op, payload) => store.controlReference(owner, { referenceId, operationId: newId(), op, ...(payload ? { payload } : {}) });
    for (const payload of [undefined, {}, { text: 'x' }, { message: '' }, { message: 'x', extra: 1 }, { message: 'x', id: '' }]) {
        expectCode(assert, () => control('message', payload), 'invalid_request');
    }
    control('message', { message: 'wrapped prompt', displayText: 'plain', id: 'req-1' });
    control('message', { message: 'second' });
    const pending = store.takePendingControls(ids);
    assert.deepEqual(pending.map((entry) => [entry.op, entry.payload]), [['message', { message: 'wrapped prompt', displayText: 'plain', id: 'req-1' }], ['message', { message: 'second' }]]);
    assert.equal(store.ackControl({ ...ids, actorKey: pending[0].actorKey, operationId: pending[0].operationId }), true);
    assert.equal(store.ackControl({ ...ids, actorKey: pending[0].actorKey, operationId: pending[0].operationId }), false, 'idempotent');
    assert.equal(store.takePendingControls(ids).length, 1);
    const stop = control('stop');
    assert.equal(stop.delivery, 'pending');
    const next = store.takePendingControls(ids);
    assert.deepEqual(next.map((entry) => [entry.op, entry.payload]), [['message', { message: 'second' }], ['stop', null]]);
    for (const entry of next) store.ackControl({ ...ids, actorKey: entry.actorKey, operationId: entry.operationId });
    assert.deepEqual(store.takePendingControls(ids), []);
    store.beginAttemptEnd(adapter(), { ...ids, expectedState: 'running', outcome: { classification: 'cancelled' } });
    assert.deepEqual(store.takePendingControls(ids), [], 'nothing is delivered to an ending attempt');
});

test('engine reads: running admissions, pending completions and unattested robots', (t) => {
    const dir = makeTempDir(t);
    const store = openStore(dir, { limits: LIMITS_X });
    t.after(() => store.close());
    const lifecycle = syntheticContext({ robotOwnerId: ROBOTS, scope: 'scope-robots' });
    const operationId = newId();
    const { robotId } = store.beginProvision(lifecycle, { operationId, name: 'R', configuration: robotConfig() });
    const pending = store.listPendingCompletions();
    assert.equal(pending.length, 1);
    assert.deepEqual({ ...pending[0], candidate: pending[0].candidate }, {
        scope: 'scope-robots', operationId, opType: 'provision', robotId, ownerId: ROBOTS, lifecycle: 'provisioning', candidate: robotConfig()
    });
    assert.deepEqual(store.listUnattestedRobots(), []);
    store.completePreparation(lifecycle, { operationId, outcome: 'succeeded' });
    assert.deepEqual(store.listPendingCompletions(), []);
    assert.deepEqual(store.listUnattestedRobots(), []);
    const { ids } = running(store, robotId);
    assert.equal(store.listRunningAdmissions().length, 1);
    assert.equal(store.listRunningAdmissions()[0].executionId, ids.executionId);
    assert.equal(store.listQueuedAdmissions().length, 0);
    store.beginGenerationRecovery(store.generationId);
    assert.deepEqual(store.listRunningAdmissions(), []);
    assert.deepEqual(store.listUnattestedRobots().map((entry) => [entry.robotId, entry.ownerId]), [[robotId, ROBOTS]], 'the rollover cleared the attestation');
    store.completeGenerationRecovery(store.generationId);
    store.attestReadiness(syntheticContext({ robotOwnerId: ROBOTS, scope: 'scope-reattest' }), { robotId });
    assert.deepEqual(store.listUnattestedRobots(), []);
});

// ---- M-14: channel events and the `answer` control ---------------------------------------------------------------------------

const REQUEST_ID = 'rQ0123456789abcdefghij';

function askedAndEnded(store, robotId, owner) {
    const { admitted, ids } = running(store, robotId, owner);
    const asked = store.recordChannelEvent({ ...ids, type: 'human-input-request', data: { requestId: REQUEST_ID, question: 'Ship it?', options: ['yes', 'no', 'later'] } });
    return { admitted, ids, asked };
}
const answerRequest = (referenceId, overrides = {}) => ({ referenceId, operationId: newId(), op: 'answer', payload: { requestId: REQUEST_ID, answer: 'yes' }, ...overrides });

test('channel events: one per kind per attempt, durable, bounded; a different second request conflicts', (t) => {
    const { store, robotId } = setup(t);
    const owner = user('alice');
    const { admitted, ids, asked } = askedAndEnded(store, robotId, owner);
    assert.equal(asked.duplicate, false);
    assert.deepEqual(store.recordChannelEvent({ ...ids, type: 'human-input-request', data: { requestId: REQUEST_ID, question: 'Ship it?', options: ['yes', 'no', 'later'] } }), { ...asked, duplicate: true });
    expectCode(assert, () => store.recordChannelEvent({ ...ids, type: 'human-input-request', data: { requestId: 'other0123456789abcdefg', question: 'x', options: [] } }), 'operation_conflict');
    store.recordChannelEvent({ ...ids, type: 'task-failed', data: { message: 'blocked' } });
    expectCode(assert, () => store.recordChannelEvent({ ...ids, type: 'task-failed', data: { message: 'x'.repeat(250 * 1024) } }), 'operation_conflict');
    expectCode(assert, () => store.recordChannelEvent({ ...ids, type: 'ala', data: {} }), 'invalid_request');
    const rows = store.listReferenceEvents(owner, { referenceId: admitted.reference.id, after: 0, limit: 100 }).events;
    assert.deepEqual(rows.map((row) => row.type), ['state', 'state', 'human-input-request', 'task-failed']);
    const big = running(store, robotId, user('bob'));
    expectCode(assert, () => store.recordChannelEvent({ ...big.ids, type: 'task-failed', data: { message: 'x'.repeat(250 * 1024) } }), 'invalid_request');
    const queued = store.admit(owner, admitRequest(robotId, { specification: spec2() }, owner));
    expectCode(assert, () => store.recordChannelEvent({ executionId: queued.executionId, attemptId: queued.attemptId, type: 'task-failed', data: { message: 'x' } }), 'operation_conflict');
});

test('answer: owner-only, only after the attempt ended human-input, recorded once with its event, replayable; conflicting answers fail', (t) => {
    const { store, robotId } = setup(t);
    const alice = user('alice');
    const { admitted, ids } = askedAndEnded(store, robotId, alice);
    const referenceId = admitted.reference.id;
    expectCode(assert, () => store.controlReference(alice, answerRequest(referenceId)), 'operation_conflict');
    store.beginAttemptEnd(adapter(), { ...ids, expectedState: 'running', outcome: { classification: 'human-input', outputText: 'waiting', data: { reason: 'human_input', requestId: REQUEST_ID } } });
    expectCode(assert, () => store.controlReference(user('mallory'), answerRequest(referenceId)), 'not_found');
    expectCode(assert, () => store.controlReference(syntheticContext({ originKey: 'user:root', ownerId: 'user:root', scope: 'scope-root', robotOwnerId: ROBOTS, administrator: true }), answerRequest(referenceId)), 'forbidden');
    expectCode(assert, () => store.controlReference(alice, answerRequest(referenceId, { payload: { requestId: 'unknown0123456789abcd', answer: 'yes' } })), 'not_found');
    for (const payload of [{ requestId: REQUEST_ID }, { requestId: REQUEST_ID, answer: '' }, { requestId: REQUEST_ID, answer: 'x'.repeat(ANSWER_MAX_CHARS + 1) }, { requestId: 'short', answer: 'yes' }, { requestId: REQUEST_ID, answer: 'yes', extra: 1 }]) {
        expectCode(assert, () => store.controlReference(alice, answerRequest(referenceId, { payload })), 'invalid_request');
    }
    // M-14 (ii): the largest answer is 32,000 characters; it fits the request bound, the control row and the event, even in the worst
    // JSON expansion (every character escaped to six bytes) and with four-byte characters.
    assert.equal(ANSWER_MAX_CHARS, 32000);
    assert.ok(Buffer.byteLength(JSON.stringify({ requestId: REQUEST_ID, answer: '\u0001'.repeat(ANSWER_MAX_CHARS) })) < CHANNEL_EVENT_MAX_BYTES);
    assert.ok(Buffer.byteLength(JSON.stringify({ requestId: REQUEST_ID, answer: '😀'.repeat(ANSWER_MAX_CHARS / 2) })) < CHANNEL_EVENT_MAX_BYTES);
    const first = answerRequest(referenceId, { payload: { requestId: REQUEST_ID, answer: 'y'.repeat(ANSWER_MAX_CHARS) } });
    const receipt = store.controlReference(alice, first);
    assert.deepEqual(receipt, { operationId: first.operationId, op: 'answer', outcome: 'accepted', delivery: 'applied', state: 'human-input', requestId: REQUEST_ID });
    assert.deepEqual(store.controlReference(alice, first), receipt, 'the same operation: the recorded receipt');
    const again = store.controlReference(alice, answerRequest(referenceId, { payload: { requestId: REQUEST_ID, answer: 'y'.repeat(ANSWER_MAX_CHARS) } }));
    assert.equal(again.outcome, 'accepted', 'the same answer under another operation ID: the same receipt');
    expectCode(assert, () => store.controlReference(alice, answerRequest(referenceId, { payload: { requestId: REQUEST_ID, answer: 'no' } })), 'operation_conflict');
    expectCode(assert, () => store.controlReference(alice, { ...first, payload: { requestId: REQUEST_ID, answer: 'no' } }), 'operation_conflict');
    const rows = store.listReferenceEvents(alice, { referenceId, after: 0, limit: 100 }).events;
    assert.deepEqual(rows.filter((row) => row.type === 'human-input-answered').map((row) => row.data), [{ requestId: REQUEST_ID, answer: 'y'.repeat(ANSWER_MAX_CHARS) }], 'a single answered event');
    assert.deepEqual(store.takePendingControls({ ...ids }), [], 'an answer is applied, not pending delivery');
});

test('the per-reference total counts channel events: a 32,000-character multibyte answer after a full ala stream still ends with the truncation marker and nothing is dropped silently', (t) => {
    const { store, robotId } = setup(t);
    const alice = user('alice');
    const { admitted, ids } = running(store, robotId, alice);
    const referenceId = admitted.reference.id;
    // A full stream: more ala records than the total allows.
    const SENT = OUTPUT_EVENTS_PER_REFERENCE + 700;
    let stored = 0;
    let dropped = 0;
    for (let sent = 0; sent < SENT; sent += 1000) {
        const count = Math.min(1000, SENT - sent);
        const result = store.recordReferenceEvents({ ...ids, events: Array.from({ length: count }, (_, i) => ({ type: 'ala', data: { record: { type: 'n', i: sent + i } } })) });
        stored += result.stored;
        dropped += result.dropped;
    }
    // The question and the failure still fit, in the places kept for channel events.
    store.recordChannelEvent({ ...ids, type: 'human-input-request', data: { requestId: REQUEST_ID, question: 'Ship it?', options: ['yes', 'no', 'later'] } });
    store.recordChannelEvent({ ...ids, type: 'task-failed', data: { message: 'blocked' } });
    // The relay's final marker carries the total of what was refused.
    assert.deepEqual(store.recordReferenceEvents({ ...ids, events: [{ type: 'truncated', data: { dropped, reason: 'event_limit' } }] }), { stored: 1, dropped: 0 });
    store.beginAttemptEnd(adapter(), { ...ids, expectedState: 'running', outcome: { classification: 'human-input', outputText: '', data: { requestId: REQUEST_ID } } });
    // A 32,000-character answer of four-byte characters (16,000 emoji), recorded after the stream was full.
    const answer = '😀'.repeat(ANSWER_MAX_CHARS / 2);
    assert.equal(answer.length, ANSWER_MAX_CHARS);
    store.controlReference(alice, answerRequest(referenceId, { payload: { requestId: REQUEST_ID, answer } }));
    const all = [];
    for (let after = 0; ;) {
        const page = store.listReferenceEvents(alice, { referenceId, after, limit: 1000 });
        if (page.events.length === 0) break;
        all.push(...page.events);
        after = page.nextAfter;
    }
    const ala = all.filter((event) => event.type === 'ala');
    const channel = all.filter((event) => ['human-input-request', 'task-failed', 'human-input-answered'].includes(event.type));
    const markers = all.filter((event) => event.type === 'truncated');
    assert.equal(channel.length, 3);
    assert.ok(ala.length + channel.length <= OUTPUT_EVENTS_PER_REFERENCE, 'ala and channel events share the total');
    assert.equal(ala.length, OUTPUT_EVENTS_PER_REFERENCE - CHANNEL_EVENT_RESERVE);
    assert.equal(channel.find((event) => event.type === 'human-input-answered').data.answer, answer);
    assert.deepEqual(markers.map((event) => event.data.reason), ['event_limit', 'event_limit'], 'the marker at the first refusal and the final total');
    assert.equal(ala.length + dropped, SENT, 'every record sent is stored or counted in the final marker: nothing is dropped silently');
    assert.equal(markers.at(-1).data.dropped, dropped);
});
