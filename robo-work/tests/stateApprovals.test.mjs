import assert from 'node:assert/strict';
import test from 'node:test';
import {
    APPROVALS_PENDING_MAX, APPROVAL_FIELD_MAX, APPROVAL_LIMIT_FLOOR, CHANNEL_EVENT_RESERVE, OUTPUT_EVENTS_PER_REFERENCE, approvalRequestData, plainApprovalText
} from '../server/stateObservation.mjs';
import {
    LIMITS, WORKSPACE, admitRequest, expectCode, makeTempDir, newId, openStore, rawDb, readyRobot, syntheticContext
} from './helpers/synthetic.mjs';

// T2 approval relay, state side (SPEC t2-skills-approval, deltas M4 and M5; decision M-30, M-52 additions 1 and 2): the durable approval
// row, the owner-only `answer` control with its own grant, first-wins resolution, the attempt end, ALA's rejection and the event room.

const LIMITS_X = Object.freeze({ ...LIMITS, requestBytes: 65536, resultBytes: 4096, admissions: 64, receipts: 256, bindings: 8, controls: 16, tokenReplayEntries: 16 });
const ROBOTS = `workspace:${WORKSPACE}`;
const SESSION = '0f8c2f1e-3b53-4a56-9b0f-6b1f0d5e9a11';
const spec2 = (overrides = {}) => ({
    version: 2, prompt: 'do the thing', displayText: 'do the thing', sessionId: SESSION, turnId: 'turn_1', cwd: '/ws/project',
    permissions: 'ask-for-approval', ...overrides
});
const owner = (id) => syntheticContext({
    originNamespace: 'coordinator:agent:fixtures/roboteam', originKey: `owner:user:${id}`, ownerId: `user:${id}`, scope: `scope-co-${id}`, robotOwnerId: ROBOTS
});
const adapter = () => syntheticContext({ scope: 'scope-adapter' });

function setup(t, limits = LIMITS_X) {
    const dir = makeTempDir(t);
    const store = openStore(dir, { limits });
    t.after(() => store.close());
    const robotId = readyRobot(store, syntheticContext({ robotOwnerId: ROBOTS, scope: 'scope-robots' }));
    return { store, robotId, dir };
}

function running(store, robotId, who = owner('alice'), specification = spec2()) {
    const admitted = store.admit(who, admitRequest(robotId, { specification }, who));
    store.transitionAttempt({ executionId: admitted.executionId, attemptId: admitted.attemptId, expectedState: 'queued', nextState: 'running' });
    return { admitted, ids: { executionId: admitted.executionId, attemptId: admitted.attemptId }, referenceId: admitted.reference.id };
}

let uuidCounter = 0;
const uuid = () => `00000000-0000-4000-8000-${String(++uuidCounter).padStart(12, '0')}`;
const alaRequest = (id = uuid(), overrides = {}) => ({
    type: 'coding-agent-request', id, agent: 'opencode', kind: 'permission', method: 'edit', title: 'Edit a file', message: 'Allow writing a.txt?',
    options: [{ id: 'once', label: 'Allow once' }, { id: 'reject', label: 'Reject', description: 'Do not write' }], ...overrides
});
const answer = (referenceId, requestId, choice = { optionId: 'once' }, overrides = {}) => ({
    referenceId, operationId: newId(), op: 'answer', payload: { requestId, ...choice }, ...overrides
});
const events = (store, who, referenceId) => store.listReferenceEvents(who, { referenceId, after: 0, limit: 1000 }).events;
const approvalEvents = (store, who, referenceId) => events(store, who, referenceId).filter((row) => row.type.startsWith('approval-'));

test('A2: an answer is owner-only with its own grant; replay returns the same receipt; the request resolves once with its event', (t) => {
    const { store, robotId } = setup(t);
    const alice = owner('alice');
    const { ids, referenceId } = running(store, robotId, alice);
    const requestId = uuid();
    const recorded = store.recordApprovalRequest({ ...ids, record: alaRequest(requestId) });
    assert.equal(recorded.outcome, 'open');
    assert.deepEqual(recorded.data, {
        requestId, agent: 'opencode', tool: 'edit', title: 'Edit a file', message: 'Allow writing a.txt?',
        options: [{ id: 'once', label: 'Allow once' }, { id: 'reject', label: 'Reject', description: 'Do not write' }]
    });
    // Another user cannot even see the reference; an administrator who is not the owner, and the coordinator's background row, are refused.
    expectCode(assert, () => store.controlReference(owner('mallory'), answer(referenceId, requestId)), 'not_found');
    const admin = syntheticContext({ originNamespace: 'coordinator:agent:fixtures/roboteam', originKey: 'owner:user:root', ownerId: 'user:root', scope: 'scope-root', robotOwnerId: ROBOTS, administrator: true });
    expectCode(assert, () => store.controlReference(admin, answer(referenceId, requestId)), 'forbidden');
    // Unknown request, unadvertised option, extra key, both or neither of optionId / cancelled, a non-UUID id.
    expectCode(assert, () => store.controlReference(alice, answer(referenceId, uuid())), 'not_found');
    expectCode(assert, () => store.controlReference(alice, answer(referenceId, requestId, { optionId: 'always' })), 'invalid_request');
    for (const payload of [{ requestId, optionId: 'once', extra: 1 }, { requestId, optionId: 'once', cancelled: true }, { requestId }, { requestId, cancelled: false },
        { requestId: 'not-a-uuid', optionId: 'once' }, { requestId, optionId: '' }, { requestId, optionId: 'a\u0007b' }, { requestId, optionId: 'x'.repeat(129) }]) {
        expectCode(assert, () => store.controlReference(alice, { referenceId, operationId: newId(), op: 'answer', payload }), 'invalid_request');
    }
    const first = answer(referenceId, requestId);
    const receipt = store.controlReference(alice, first);
    assert.deepEqual(receipt, { operationId: first.operationId, op: 'answer', outcome: 'accepted', delivery: 'pending', state: 'running', requestId });
    assert.deepEqual(store.controlReference(alice, first), receipt, 'replay: the recorded receipt');
    assert.deepEqual(store.controlReference(alice, answer(referenceId, requestId)), receipt, 'the same answer under another operation: the first receipt');
    expectCode(assert, () => store.controlReference(alice, answer(referenceId, requestId, { optionId: 'reject' })), 'operation_conflict');
    expectCode(assert, () => store.controlReference(alice, { ...first, payload: { requestId, optionId: 'reject' } }), 'operation_conflict');
    // Durable before delivery: the control is pending with exactly the two fields, the request is resolved with ONE event.
    assert.deepEqual(store.takePendingControls(ids).map(({ op, payload }) => ({ op, payload })), [{ op: 'answer', payload: { requestId, optionId: 'once' } }]);
    assert.deepEqual(approvalEvents(store, alice, referenceId).map((row) => [row.type, row.data.reason ?? null, row.data.optionId ?? null]),
        [['approval-request', null, null], ['approval-resolved', 'answered', 'once']]);
    // ALA's later confirmation changes nothing.
    assert.deepEqual(store.resolveApproval({ ...ids, requestId, reason: 'cancelled' }), { resolved: false });
    assert.equal(approvalEvents(store, alice, referenceId).length, 2);
});

test('A2: two different answers in parallel: exactly one is accepted, the other is operation_conflict', async (t) => {
    const { store, robotId } = setup(t);
    const alice = owner('alice');
    const { ids, referenceId } = running(store, robotId, alice);
    const requestId = uuid();
    store.recordApprovalRequest({ ...ids, record: alaRequest(requestId) });
    const outcomes = await Promise.allSettled([
        Promise.resolve().then(() => store.controlReference(alice, answer(referenceId, requestId, { optionId: 'once' }))),
        Promise.resolve().then(() => store.controlReference(alice, answer(referenceId, requestId, { optionId: 'reject' })))
    ]);
    assert.equal(outcomes.filter((outcome) => outcome.status === 'fulfilled').length, 1);
    const refused = outcomes.find((outcome) => outcome.status === 'rejected');
    assert.equal(refused.reason.code, 'operation_conflict');
    assert.equal(store.takePendingControls(ids).length, 1);
});

test('A2: a coordinator-only answer (background binding row) is refused', (t) => {
    const { store, robotId } = setup(t);
    const coordinator = 'agent:fixtures/roboteam';
    const alice = owner('alice');
    store.registerBinding(alice, { operationId: newId(), bindingId: 'flow_0123456789abcdef01234567', kind: 'flow' });
    const background = syntheticContext({ originNamespace: `coordinator:${coordinator}`, originKey: 'binding:flow_0123456789abcdef01234567', ownerId: 'user:alice', scope: 'scope-bg', robotOwnerId: ROBOTS });
    const { ids, referenceId } = running(store, robotId, background);
    const requestId = uuid();
    store.recordApprovalRequest({ ...ids, record: alaRequest(requestId) });
    expectCode(assert, () => store.controlReference(background, answer(referenceId, requestId)), 'forbidden');
    assert.deepEqual(store.takePendingControls(ids), []);
});

test('M4: answer vs expiry: the first wins in one transaction; an answer after expiry or after ALA resolved it is operation_conflict', (t) => {
    const { store, robotId } = setup(t);
    const alice = owner('alice');
    const { ids, referenceId } = running(store, robotId, alice);
    // expiry first
    const expired = uuid();
    store.recordApprovalRequest({ ...ids, record: alaRequest(expired) });
    assert.deepEqual(store.resolveApproval({ ...ids, requestId: expired, reason: 'expired' }), { resolved: true });
    assert.deepEqual(store.resolveApproval({ ...ids, requestId: expired, reason: 'expired' }), { resolved: false }, 'resolved once');
    expectCode(assert, () => store.controlReference(alice, answer(referenceId, expired)), 'operation_conflict');
    // answer first: the deadline then finds nothing to do
    const answered = uuid();
    store.recordApprovalRequest({ ...ids, record: alaRequest(answered) });
    store.controlReference(alice, answer(referenceId, answered));
    assert.deepEqual(store.resolveApproval({ ...ids, requestId: answered, reason: 'expired' }), { resolved: false });
    // ALA's backend resolved it (recorded `cancelled`), then the owner answers
    const backend = uuid();
    store.recordApprovalRequest({ ...ids, record: alaRequest(backend) });
    assert.deepEqual(store.resolveApproval({ ...ids, requestId: backend, reason: 'cancelled' }), { resolved: true });
    expectCode(assert, () => store.controlReference(alice, answer(referenceId, backend)), 'operation_conflict');
    // an owner cancel is an answer too
    const cancelled = uuid();
    store.recordApprovalRequest({ ...ids, record: alaRequest(cancelled) });
    store.controlReference(alice, answer(referenceId, cancelled, { cancelled: true }));
    assert.deepEqual(approvalEvents(store, alice, referenceId).filter((row) => row.type === 'approval-resolved').map((row) => [row.data.requestId, row.data.reason]),
        [[expired, 'expired'], [answered, 'answered'], [backend, 'cancelled'], [cancelled, 'cancelled']]);
    assert.deepEqual(store.takePendingControls(ids).map((control) => control.payload), [{ requestId: answered, optionId: 'once' }, { requestId: cancelled, cancelled: true }]);
});

test('M4: the attempt end resolves open requests `ended` and makes a pending answer final `ended`; ALA rejection makes an answer `rejected`', (t) => {
    const { store, robotId, dir } = setup(t);
    const alice = owner('alice');
    const { ids, referenceId } = running(store, robotId, alice);
    const open = uuid();
    const answeredPending = uuid();
    const answeredWritten = uuid();
    for (const id of [open, answeredPending, answeredWritten]) store.recordApprovalRequest({ ...ids, record: alaRequest(id) });
    store.controlReference(alice, answer(referenceId, answeredPending));
    const written = store.controlReference(alice, answer(referenceId, answeredWritten));
    assert.equal(store.ackControl({ ...ids, actorKey: alice.scope, operationId: written.operationId }), true);
    assert.deepEqual(store.rejectApprovalAnswer({ ...ids, requestId: answeredWritten }), { rejected: true });
    assert.deepEqual(store.rejectApprovalAnswer({ ...ids, requestId: open }), { rejected: false }, 'no answer was written for it');
    store.beginAttemptEnd(adapter(), { ...ids, expectedState: 'running', outcome: { classification: 'completed', outputText: 'done' } });
    const db = rawDb(dir);
    t.after(() => db.close());
    const deliveries = db.prepare("SELECT payload, delivery FROM reference_control WHERE op = 'answer' ORDER BY rowid").all().map((row) => [JSON.parse(row.payload).requestId, row.delivery]);
    assert.deepEqual(deliveries, [[answeredPending, 'ended'], [answeredWritten, 'rejected']]);
    const resolved = approvalEvents(store, alice, referenceId).filter((row) => row.type === 'approval-resolved').map((row) => [row.data.requestId, row.data.reason]);
    assert.deepEqual(resolved, [[answeredPending, 'answered'], [answeredWritten, 'answered'], [open, 'ended']]);
    // Nothing is pending once the attempt is no longer running, and nothing more can be recorded or answered.
    assert.deepEqual(store.takePendingControls(ids), []);
    assert.equal(store.recordApprovalRequest({ ...ids, record: alaRequest() }).outcome, 'not_running');
    expectCode(assert, () => store.controlReference(alice, answer(referenceId, open)), 'operation_conflict');
    // The control's delivery may only move forward: a final state never returns to pending.
    assert.throws(() => db.prepare("UPDATE reference_control SET delivery = 'pending' WHERE op = 'answer'").run());
    assert.throws(() => db.prepare("UPDATE approval SET reason = 'expired' WHERE request_id = ?").run(open));
});

test('M4: generation recovery ends open requests too (the same end path)', (t) => {
    const dir = makeTempDir(t);
    const store = openStore(dir, { limits: LIMITS_X });
    t.after(() => store.close());
    const robotId = readyRobot(store, syntheticContext({ robotOwnerId: ROBOTS, scope: 'scope-robots' }));
    const alice = owner('alice');
    const { ids, referenceId } = running(store, robotId, alice);
    const requestId = uuid();
    const answered = uuid();
    store.recordApprovalRequest({ ...ids, record: alaRequest(requestId) });
    store.recordApprovalRequest({ ...ids, record: alaRequest(answered) });
    store.controlReference(alice, answer(referenceId, answered));
    assert.equal(store.takePendingControls(ids).length, 1, 'a pending answer before the rollover');
    store.beginGenerationRecovery(store.generationId);
    const resolved = approvalEvents(store, alice, referenceId).filter((row) => row.type === 'approval-resolved');
    assert.deepEqual(resolved.map((row) => row.data), [{ requestId: answered, reason: 'answered', optionId: 'once' }, { requestId, reason: 'ended' }]);
    // The answer was never delivered: final `ended`. The attempt belongs to the ended generation, so the engine cannot take it any more.
    const db = rawDb(dir);
    t.after(() => db.close());
    assert.deepEqual(db.prepare("SELECT delivery FROM reference_control WHERE op = 'answer'").all().map((row) => row.delivery), ['ended']);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM reference_control WHERE delivery = 'pending'").get().count, 0);
    expectCode(assert, () => store.takePendingControls(ids), 'stale_generation');
});

test('bounds: at most eight open requests; a ninth, or one with nine options, is resolved `limit` at once', (t) => {
    const { store, robotId } = setup(t);
    const alice = owner('alice');
    const { ids, referenceId } = running(store, robotId, alice);
    const opened = [];
    for (let i = 0; i < APPROVALS_PENDING_MAX; i += 1) {
        const id = uuid();
        opened.push(id);
        assert.equal(store.recordApprovalRequest({ ...ids, record: alaRequest(id) }).outcome, 'open');
    }
    const ninth = uuid();
    assert.deepEqual(store.recordApprovalRequest({ ...ids, record: alaRequest(ninth) }), { outcome: 'limit', eventRecorded: true, requestId: ninth });
    assert.deepEqual(store.recordApprovalRequest({ ...ids, record: alaRequest(ninth) }), { outcome: 'duplicate', state: 'resolved', reason: 'limit', requestId: ninth });
    // Answering one frees a place.
    store.controlReference(alice, answer(referenceId, opened[0]));
    const nineOptions = uuid();
    const many = Array.from({ length: 9 }, (_, i) => ({ id: `o${i}`, label: `Option ${i}` }));
    assert.equal(store.recordApprovalRequest({ ...ids, record: alaRequest(nineOptions, { options: many }) }).outcome, 'limit');
    expectCode(assert, () => store.controlReference(alice, answer(referenceId, nineOptions, { optionId: 'o0' })), 'invalid_request');
    assert.equal(store.recordApprovalRequest({ ...ids, record: alaRequest() }).outcome, 'open');
    assert.equal(store.recordApprovalRequest({ ...ids, record: { ...alaRequest(), id: 'not-a-uuid' } }).outcome, 'invalid');
    const resolved = approvalEvents(store, alice, referenceId).filter((row) => row.type === 'approval-resolved').map((row) => row.data);
    assert.deepEqual(resolved.filter((data) => data.reason === 'limit').map((data) => data.requestId), [ninth, nineOptions]);
});

test('M5: the event room: an approval-capable attempt keeps one place for a `limit` record; each open request holds its resolution', (t) => {
    const { store, robotId } = setup(t);
    const alice = owner('alice');
    const { ids, referenceId } = running(store, robotId, alice);
    const open = uuid();
    assert.equal(store.recordApprovalRequest({ ...ids, record: alaRequest(open) }).outcome, 'open');
    let stored = 0;
    for (let batch = 0; batch < 10; batch += 1) {
        stored += store.recordReferenceEvents({ ...ids, events: Array.from({ length: 1000 }, (_, i) => ({ type: 'ala', data: { record: { i } } })) }).stored;
    }
    // ala stops where room = floor: total - channel reserve - (request event) - (its held resolution) - floor, plus one event_limit marker.
    const capacity = OUTPUT_EVENTS_PER_REFERENCE - CHANNEL_EVENT_RESERVE - 1 - 1 - APPROVAL_LIMIT_FLOOR;
    assert.equal(stored, capacity + 1, 'every ala that fits, plus the first event_limit marker');
    // A new request finds no room for itself and its resolution: it is resolved `limit`, in the floor.
    const late = uuid();
    assert.deepEqual(store.recordApprovalRequest({ ...ids, record: alaRequest(late) }), { outcome: 'limit', eventRecorded: true, requestId: late });
    // The floor is now used: another is still resolved `limit` (row only), never left waiting.
    const later = uuid();
    assert.deepEqual(store.recordApprovalRequest({ ...ids, record: alaRequest(later) }), { outcome: 'limit', eventRecorded: false, requestId: later });
    // The open request still resolves into its held place, and so does the end of the attempt.
    store.controlReference(alice, answer(referenceId, open));
    const all = [];
    for (let after = 0; ;) {
        const page = store.listReferenceEvents(alice, { referenceId, after, limit: 1000 });
        all.push(...page.events);
        if (page.events.length === 0 || page.nextAfter === after) break;
        after = page.nextAfter;
    }
    const counted = all.filter((row) => row.type !== 'state' && row.type !== 'truncated');
    assert.ok(counted.length <= OUTPUT_EVENTS_PER_REFERENCE - CHANNEL_EVENT_RESERVE);
    assert.deepEqual(all.filter((row) => row.type === 'approval-resolved').map((row) => [row.data.requestId, row.data.reason]), [[late, 'limit'], [open, 'answered']]);
    assert.ok(all.some((row) => row.type === 'truncated' && row.data.reason === 'event_limit'), 'the drop is marked, never silent');
});

test('M5: a full-access attempt keeps its total unchanged (no floor)', (t) => {
    const { store, robotId } = setup(t);
    const alice = owner('alice');
    const { ids } = running(store, robotId, alice, spec2({ permissions: 'full-access' }));
    let stored = 0;
    for (let batch = 0; batch < 9; batch += 1) {
        stored += store.recordReferenceEvents({ ...ids, events: Array.from({ length: 1000 }, (_, i) => ({ type: 'ala', data: { record: { i } } })) }).stored;
    }
    assert.equal(stored, OUTPUT_EVENTS_PER_REFERENCE - CHANNEL_EVENT_RESERVE + 1);
});

test('M-52 addition 1: robot-controlled text is plain: markup kept as inert text, control characters stripped, fields bounded', () => {
    const markup = '<img src=x onerror="alert(1)"><script>alert(2)</script>**bold** [link](javascript:alert(3))';
    const data = approvalRequestData(alaRequest(uuid(), {
        title: `\u001b[31m${markup}\u0007\nnext`, message: `line1\r\nline2\u0000‮${markup}`, detail: { nested: markup },
        options: [{ id: 'once', label: `${markup}\u0085`, description: `d\u0001${markup}` }]
    }));
    assert.equal(data.title, `[31m${markup} next`);
    assert.equal(data.message, `line1\nline2${markup}`);
    assert.equal(data.detail, JSON.stringify({ nested: markup }));
    assert.equal(data.options[0].label, markup);
    assert.equal(data.options[0].description, `d${markup}`);
    // eslint-disable-next-line no-control-regex
    assert.ok(![data.title, data.options[0].label].some((text) => /[\u0000-\u001f\u007f-\u009f‮]/u.test(text)));
    const long = approvalRequestData(alaRequest(uuid(), { title: 'x'.repeat(500), message: 'm'.repeat(5000), detail: 'd'.repeat(9000) }));
    assert.deepEqual([long.title.length, long.message.length, long.detail.length], [APPROVAL_FIELD_MAX.title, APPROVAL_FIELD_MAX.message, APPROVAL_FIELD_MAX.detail]);
    assert.equal(plainApprovalText('😀'.repeat(300), 200).length, 400, 'cut on code points');
    for (const bad of [{ kind: 'question' }, { id: 'x' }, { options: [] }, { options: [{ id: 'a', label: 'A' }, { id: 'a', label: 'B' }] }, { options: [{ id: 'a' }] }]) {
        assert.equal(approvalRequestData(alaRequest(uuid(), bad)), null, JSON.stringify(bad));
    }
});

test('a request is recorded only for a running attempt of the current generation', (t) => {
    const { store, robotId } = setup(t);
    const alice = owner('alice');
    const queued = store.admit(alice, admitRequest(robotId, { specification: spec2() }, alice));
    assert.equal(store.recordApprovalRequest({ executionId: queued.executionId, attemptId: queued.attemptId, record: alaRequest() }).outcome, 'not_running');
    expectCode(assert, () => store.recordApprovalRequest({ executionId: newId(), attemptId: newId(), record: alaRequest() }), 'not_found');
    expectCode(assert, () => store.resolveApproval({ executionId: queued.executionId, attemptId: queued.attemptId, requestId: uuid(), reason: 'answered' }), 'invalid_request');
});
