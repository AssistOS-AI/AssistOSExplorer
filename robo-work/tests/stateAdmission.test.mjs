import assert from 'node:assert/strict';
import test from 'node:test';
import crypto from 'node:crypto';
import { runtimeUnavailable } from '../server/workerState.mjs';
import { raceChildren, runChild } from './helpers/childRunner.mjs';
import {
    LIMITS, PROVIDER, WORKSPACE, admitRequest, count, endAttempt, expectCode, makeTempDir, newId, newOriginId, openStore, rawDb,
    readyRobot, robotConfig, syntheticContext, syntheticRuntime
} from './helpers/synthetic.mjs';
import { deriveOperationId, isPublicReferenceId } from '../server/stateProtocol.mjs';

const CONTEXT_FIELDS = {
    workspaceId: WORKSPACE, scope: 'scope-synthetic-a', ownerId: 'owner-synthetic-a',
    operations: ['provision', 'configure', 'delete', 'admit', 'lookup', 'read', 'attest', 'adapter_complete'], originNamespace: 'mcp', originKey: 'user:synthetic-a'
};

function tableCounts(dir) {
    return Object.fromEntries(['receipt', 'origin', 'reference', 'admission'].map((table) => [table, count(dir, table)]));
}

test('default runtime refuses admission and records no admission, reference, origin or receipt', (t) => {
    const dir = makeTempDir(t);
    const seeded = openStore(dir);
    const context = syntheticContext();
    const robotId = readyRobot(seeded, context);
    const before = tableCounts(dir);
    seeded.close();
    const store = openStore(dir, { create: false, runtime: runtimeUnavailable });
    expectCode(assert, () => store.admit(context, admitRequest(robotId)), 'runtime_unavailable');
    expectCode(assert, () => store.admit(context, admitRequest(newId())), 'runtime_unavailable');
    assert.deepEqual(tableCounts(dir), before);
    assert.equal(count(dir, 'admission'), 0);
    store.close();
});

test('a synthetic runtime that is not admission-ready refuses without recording anything', (t) => {
    const dir = makeTempDir(t);
    const runtime = syntheticRuntime();
    const store = openStore(dir, { runtime });
    const context = syntheticContext();
    const robotId = readyRobot(store, context);
    runtime.admit = false;
    expectCode(assert, () => store.admit(context, admitRequest(robotId)), 'runtime_unavailable');
    assert.equal(count(dir, 'admission'), 0);
    runtime.admit = true;
    assert.equal(store.admit(context, admitRequest(robotId)).status, 'admitted');
    store.close();
});

test('admission commits receipt, origin, reference and admission with distinct IDs; retry survives reopen', (t) => {
    const dir = makeTempDir(t);
    let store = openStore(dir);
    const context = syntheticContext();
    const robotId = readyRobot(store, context);
    const request = admitRequest(robotId);
    const admitted = store.admit(context, request);
    assert.equal(admitted.status, 'admitted');
    const ids = [admitted.executionId, admitted.attemptId, admitted.reference.id, admitted.logicalId];
    assert.equal(new Set(ids).size, 4);
    assert.equal(isPublicReferenceId(admitted.reference.id), true);
    assert.deepEqual([admitted.reference.version, admitted.reference.provider], [1, PROVIDER]);
    assert.deepEqual(store.admit(context, request), admitted);
    store.close();
    store = openStore(dir, { create: false });
    assert.deepEqual(store.admit(context, request), admitted);
    assert.deepEqual(tableCounts(dir), { receipt: 2, origin: 1, reference: 1, admission: 1 });
    const looked = store.lookupOrigin(context, { originRequestId: request.originRequestId });
    assert.deepEqual([looked.state, looked.result, looked.attemptId, looked.reference], ['queued', null, admitted.attemptId, admitted.reference]);
    assert.deepEqual(store.getReference(context, { referenceId: admitted.reference.id }).attemptId, admitted.attemptId);
    store.close();
});

test('changed payload, owner or robot conflict; a mismatched operation ID is refused; reused IDs conflict across types', (t) => {
    const dir = makeTempDir(t);
    const store = openStore(dir);
    const context = syntheticContext();
    const robotId = readyRobot(store, context);
    const otherRobot = readyRobot(store, context);
    const request = admitRequest(robotId);
    store.admit(context, request);
    expectCode(assert, () => store.admit(context, { ...request, specification: { prompt: 'changed' } }), 'operation_conflict');
    expectCode(assert, () => store.admit(context, { ...request, robotId: otherRobot }), 'operation_conflict');
    expectCode(assert, () => store.admit(context, { ...request, kind: 'continuation', logical: { logicalId: newId() } }), 'operation_conflict');
    expectCode(assert, () => store.admit(syntheticContext({ ownerId: 'owner-synthetic-b' }), request), 'operation_conflict');
    // an operation ID that is not the origin-derived one is refused, never recorded
    expectCode(assert, () => store.admit(context, { ...request, operationId: newId() }), 'operation_conflict');
    expectCode(assert, () => store.admit(context, admitRequest(robotId, { operationId: newId() })), 'operation_conflict');
    // an operation ID already used by a provision cannot be reused for admission
    const reusedOrigin = newOriginId();
    const provisionOp = deriveOperationId(context, reusedOrigin);
    store.beginProvision(context, { operationId: provisionOp, name: 'p', configuration: robotConfig() });
    expectCode(assert, () => store.admit(context, admitRequest(robotId, { originRequestId: reusedOrigin })), 'operation_conflict');
    assert.deepEqual(tableCounts(dir), { receipt: 4, origin: 1, reference: 1, admission: 1 });
    store.close();
});

test('the same origin re-invoked returns the recorded admission without a new receipt', (t) => {
    const dir = makeTempDir(t);
    const store = openStore(dir);
    const context = syntheticContext();
    const robotId = readyRobot(store, context);
    const request = admitRequest(robotId);
    const first = store.admit(context, request);
    const receipts = count(dir, 'receipt');
    // a re-invocation under a fresh transport, for example a consumed MCP origin token
    const again = store.admit(syntheticContext(), { ...request });
    assert.deepEqual(again, first);
    assert.equal(count(dir, 'receipt'), receipts);
    store.close();
});

test('operation-ID derivation covers the MCP, coordinator-API and background rows and depends on every input', (t) => {
    const origin = newOriginId();
    const rows = [
        syntheticContext({ originNamespace: 'mcp', originKey: 'user:u1' }),
        syntheticContext({ originNamespace: 'mcp', originKey: 'agent:a1' }),
        syntheticContext({ originNamespace: 'coordinator:svc1', originKey: 'owner:user:u1' }),
        syntheticContext({ originNamespace: 'coordinator:svc1', originKey: 'binding:flow1' }),
        syntheticContext({ originNamespace: 'coordinator:svc2', originKey: 'binding:flow1' })
    ];
    const derived = rows.map((context) => deriveOperationId(context, origin));
    assert.equal(new Set(derived).size, rows.length);
    for (const id of derived) assert.match(id, /^[A-Za-z0-9_-]{22}$/);
    // the documented construction: first 22 base64url characters of SHA-256 over canonical JSON
    const expected = crypto.createHash('sha256').update(JSON.stringify({ originKey: 'user:u1', originNamespace: 'mcp', originRequestId: origin })).digest('base64url').slice(0, 22);
    assert.equal(derived[0], expected);
    assert.notEqual(deriveOperationId(rows[0], newOriginId()), derived[0]);
    const dir = makeTempDir(t);
    const store = openStore(dir, { limits: { ...LIMITS, bindings: 8, controls: 8, tokenReplayEntries: 8 } });
    const robotId = readyRobot(store, rows[0]);
    // S1x: a background-row admission needs its binding registered (owner owner-synthetic-a).
    for (const coordinator of ['svc1', 'svc2']) {
        const binder = syntheticContext({ originNamespace: `coordinator:${coordinator}`, originKey: 'owner:user:u1', ownerId: 'owner-synthetic-a', scope: `scope-bind-${coordinator}` });
        store.registerBinding(binder, { operationId: newId(), bindingId: 'flow1', kind: 'flow' });
    }
    for (const context of rows) {
        const own = syntheticContext({ originNamespace: context.originNamespace, originKey: context.originKey, ownerId: 'owner-synthetic-a', scope: `scope-${context.originKey}` });
        const request = admitRequest(robotId, { originRequestId: origin }, own);
        assert.equal(request.operationId, deriveOperationId(context, origin));
        assert.equal(store.admit(own, request).status, 'admitted');
        assert.equal(store.lookupOrigin(own, { originRequestId: origin }).state, 'queued');
    }
    assert.equal(count(dir, 'admission'), rows.length);
    for (const bad of [{ originNamespace: 'mcp', originKey: 'owner:user:u1' }, { originNamespace: 'coordinator:svc', originKey: 'user:u1' },
        { originNamespace: 'other', originKey: 'user:u1' }, { originNamespace: 'mcp', originKey: 'user:' }]) {
        expectCode(assert, () => syntheticContext(bad), 'invalid_request');
    }
    store.close();
});

test('a second caller presenting the same originRequestId under another originKey admits independently and learns nothing', (t) => {
    const dir = makeTempDir(t);
    const store = openStore(dir);
    const first = syntheticContext({ originKey: 'user:synthetic-a' });
    const second = syntheticContext({ originKey: 'user:synthetic-b', scope: 'scope-synthetic-b', ownerId: 'owner-synthetic-a' });
    const robotId = readyRobot(store, first);
    const origin = newOriginId();
    const one = store.admit(first, admitRequest(robotId, { originRequestId: origin }, first));
    // before the second caller admits, nothing distinguishes the first origin
    expectCode(assert, () => store.lookupOrigin(second, { originRequestId: origin }), 'not_found');
    const two = store.admit(second, admitRequest(robotId, { originRequestId: origin, specification: { prompt: 'other' } }, second));
    assert.notEqual(one.reference.id, two.reference.id);
    assert.notEqual(one.operationId, two.operationId);
    assert.equal(store.lookupOrigin(first, { originRequestId: origin }).reference.id, one.reference.id);
    assert.equal(store.lookupOrigin(second, { originRequestId: origin }).reference.id, two.reference.id);
    // a third caller with a different namespace sees neither
    const third = syntheticContext({ originNamespace: 'coordinator:svc', originKey: 'binding:b1', scope: 'scope-third' });
    expectCode(assert, () => store.lookupOrigin(third, { originRequestId: origin }), 'not_found');
    assert.equal(count(dir, 'origin'), 2);
    store.close();
});

test('invalid admission requests are rejected by the strict schema', (t) => {
    const dir = makeTempDir(t);
    const store = openStore(dir);
    const context = syntheticContext();
    const robotId = readyRobot(store, context);
    const base = admitRequest(robotId);
    const bad = [{ ...base, extra: 1 }, { ...base, kind: 'other' }, { ...base, configRevision: 0 }, { ...base, originRequestId: 'AAAAAAAAAAAAAAAAAAAAAB' },
        { ...base, specification: { owner: 'x' } }, { ...base, specification: [] }, { ...base, logical: { logicalId: newId() } },
        { ...base, kind: 'continuation', logical: {} }, { ...base, robotId: 'x' }, { ...base, specification: { big: 'x'.repeat(LIMITS.requestBytes) } }];
    for (const request of bad) expectCode(assert, () => store.admit(context, request), 'invalid_request');
    const { specification, ...missing } = base;
    void specification;
    expectCode(assert, () => store.admit(context, missing), 'invalid_request');
    expectCode(assert, () => store.admit(syntheticContext({ operations: ['lookup'] }), base), 'forbidden');
    assert.equal(count(dir, 'receipt'), 1);
    store.close();
});

test('S6 turn admission requests are validated by the strict schema (logical {sessionKey}, specification version 1)', (t) => {
    const dir = makeTempDir(t);
    const store = openStore(dir);
    // SYNTHETIC coordinator-API row: the only row that may carry a turn.
    const context = syntheticContext({ originNamespace: 'coordinator:agent:RoboRepo/roboTeamAgent', originKey: 'owner:user:synthetic-a' });
    const robotId = readyRobot(store, context);
    const base = admitRequest(robotId, { kind: 'turn', logical: { sessionKey: 'conv-1' }, specification: { version: 1, prompt: 'synthetic turn' } }, context);
    const bad = [
        { ...base, logical: {} }, { ...base, logical: { logicalId: newId() } }, { ...base, logical: { sessionKey: 'conv-1', logicalId: newId() } },
        { ...base, logical: { sessionKey: '' } }, { ...base, logical: { sessionKey: 'a/b' } }, { ...base, logical: { sessionKey: 'k'.repeat(129) } },
        { ...base, specification: { prompt: 'synthetic task' } }, { ...base, specification: { version: 1, prompt: '' } },
        { ...base, specification: { version: 1, prompt: 'x', extra: 1 } }, { ...base, specification: { version: 1, prompt: 'x', cwd: '/abs' } },
        { ...base, specification: { version: 1, prompt: 'x', model: { token: 't' } } }, { ...base, kind: 'task' }
    ];
    for (const request of bad) expectCode(assert, () => store.admit(context, request), 'invalid_request');
    // A turn on the MCP row is refused, as is a task carrying a sessionKey.
    const mcp = syntheticContext();
    expectCode(assert, () => store.admit(mcp, admitRequest(robotId, { kind: 'turn', logical: { sessionKey: 'conv-1' }, specification: base.specification }, mcp)), 'invalid_request');
    assert.equal(count(dir, 'admission'), 0);
    assert.equal(store.admit(context, base).logicalKind, 'session');
    store.close();
});

test('unknown robot, foreign owner, stale revision and unready robots do not admit', (t) => {
    const dir = makeTempDir(t);
    const store = openStore(dir);
    const context = syntheticContext();
    const robotId = readyRobot(store, context);
    expectCode(assert, () => store.admit(context, admitRequest(newId())), 'not_found');
    expectCode(assert, () => store.admit(syntheticContext({ ownerId: 'owner-synthetic-b', scope: 'scope-b' }), admitRequest(robotId)), 'not_found');
    expectCode(assert, () => store.admit(context, admitRequest(robotId, { configRevision: 2 })), 'revision_conflict');
    const provisioning = newId();
    const pending = store.beginProvision(context, { operationId: provisioning, name: 'p', configuration: robotConfig() });
    expectCode(assert, () => store.admit(context, admitRequest(pending.robotId, { configRevision: 1 })), 'robot_busy');
    assert.equal(count(dir, 'admission'), 0);
    store.close();
});

test('origin rows are separate and foreign or unknown origins are indistinguishable', (t) => {
    const dir = makeTempDir(t);
    const store = openStore(dir);
    const mcp = syntheticContext({ originNamespace: 'mcp', originKey: 'user:u1' });
    const user = syntheticContext({ originNamespace: 'coordinator:svc', originKey: 'owner:user:u1' });
    const background = syntheticContext({ originNamespace: 'coordinator:svc', originKey: 'binding:flow1' });
    const robotId = readyRobot(store, mcp);
    const origin = newOriginId();
    const first = store.admit(mcp, admitRequest(robotId, { originRequestId: origin }, mcp));
    // the same origin ID in another row is an independent origin
    const second = store.admit(user, admitRequest(robotId, { originRequestId: origin }, user));
    assert.notEqual(first.reference.id, second.reference.id);
    assert.equal(store.lookupOrigin(mcp, { originRequestId: origin }).reference.id, first.reference.id);
    assert.equal(store.lookupOrigin(user, { originRequestId: origin }).reference.id, second.reference.id);
    const errors = [];
    for (const [context, id] of [
        [background, origin], [mcp, newOriginId()], [syntheticContext({ originKey: 'user:u1', scope: 'scope-other' }), origin],
        [syntheticContext({ originNamespace: 'coordinator:svc', originKey: 'binding:flow2', scope: 'scope-other' }), newOriginId()],
        [syntheticContext({ originNamespace: 'mcp', originKey: 'agent:u1' }), origin]
    ]) {
        try {
            store.lookupOrigin(context, { originRequestId: id });
            assert.fail('expected not_found');
        } catch (error) {
            errors.push({ code: error.code, message: error.message, name: error.name });
        }
    }
    assert.equal(new Set(errors.map((error) => JSON.stringify(error))).size, 1);
    assert.equal(errors[0].code, 'not_found');
    expectCode(assert, () => store.lookupOrigin(syntheticContext({ operations: ['admit'] }), { originRequestId: origin }), 'forbidden');
    expectCode(assert, () => store.lookupOrigin(mcp, { originRequestId: 'short' }), 'invalid_request');
    expectCode(assert, () => store.getReference(syntheticContext({ scope: 'scope-other' }), { referenceId: first.reference.id }), 'not_found');
    expectCode(assert, () => store.getReference(mcp, { referenceId: 'unknown' }), 'not_found');
    store.close();
});

test('continuation uses a new origin, attempt and reference on the same authorized logical work', (t) => {
    const dir = makeTempDir(t);
    const store = openStore(dir);
    const context = syntheticContext();
    const robotId = readyRobot(store, context);
    const first = store.admit(context, admitRequest(robotId));
    const continuation = (overrides = {}, as = context) => admitRequest(robotId, { kind: 'continuation', logical: { logicalId: first.logicalId }, ...overrides }, as);
    expectCode(assert, () => store.admit(context, continuation()), 'robot_busy');
    endAttempt(store, context, first, 'failed');
    const request = continuation();
    const second = store.admit(context, request);
    assert.equal(second.logicalId, first.logicalId);
    assert.notEqual(second.attemptId, first.attemptId);
    assert.notEqual(second.reference.id, first.reference.id);
    assert.notEqual(second.executionId, first.executionId);
    assert.deepEqual(store.admit(context, request), second, 'retry preserves the new identity');
    const foreign = syntheticContext({ scope: 'scope-other', ownerId: 'owner-other', originKey: 'user:other' });
    expectCode(assert, () => store.admit(foreign, continuation({}, foreign)), 'not_found');
    expectCode(assert, () => store.admit(context, admitRequest(robotId, { kind: 'continuation', logical: { logicalId: newId() } })), 'not_found');
    assert.equal(count(dir, 'admission'), 2);
    store.close();
});

test('attempt transitions are exact and terminal outcomes are immutable', (t) => {
    const dir = makeTempDir(t);
    const store = openStore(dir);
    const context = syntheticContext();
    const robotId = readyRobot(store, context);
    const admitted = store.admit(context, admitRequest(robotId));
    const ids = { executionId: admitted.executionId, attemptId: admitted.attemptId };
    expectCode(assert, () => store.transitionAttempt({ ...ids, expectedState: 'running', nextState: 'running' }), 'invalid_request');
    expectCode(assert, () => store.transitionAttempt({ ...ids, expectedState: 'queued', nextState: 'completed' }), 'invalid_request');
    expectCode(assert, () => store.transitionAttempt({ executionId: newId(), attemptId: newId(), expectedState: 'queued', nextState: 'running' }), 'not_found');
    store.transitionAttempt({ ...ids, expectedState: 'queued', nextState: 'running' });
    expectCode(assert, () => store.transitionAttempt({ ...ids, expectedState: 'queued', nextState: 'running' }), 'operation_conflict');
    const end = (outcome, expectedState = 'running') => store.beginAttemptEnd(context, { ...ids, expectedState, outcome });
    expectCode(assert, () => end({ classification: 'completed' }, 'queued'), 'operation_conflict');
    expectCode(assert, () => end({ classification: 'made-up' }), 'invalid_request');
    expectCode(assert, () => end({ classification: 'completed', extra: 1 }), 'invalid_request');
    expectCode(assert, () => end({ classification: 'completed', outputText: 'x'.repeat(LIMITS.resultBytes) }), 'invalid_request');
    expectCode(assert, () => end({ classification: 'completed', outputText: 5 }), 'invalid_request');
    expectCode(assert, () => store.beginAttemptEnd(context, { ...ids, expectedState: 'stopping', outcome: { classification: 'completed' } }), 'invalid_request');
    expectCode(assert, () => store.beginAttemptEnd(syntheticContext({ operations: ['read'] }), { ...ids, expectedState: 'running', outcome: { classification: 'completed' } }), 'forbidden');
    assert.equal(end({ classification: 'completed', outputText: 'done', data: { answer: 1 } }).state, 'completed');
    for (const [expectedState, outcome] of [['running', { classification: 'failed' }], ['completed', { classification: 'cancelled' }]]) {
        expectCode(assert, () => store.beginAttemptEnd(context, { ...ids, expectedState: expectedState === 'completed' ? 'running' : expectedState, outcome }), 'operation_conflict');
    }
    expectCode(assert, () => store.transitionAttempt({ ...ids, expectedState: 'queued', nextState: 'running' }), 'operation_conflict');
    const view = store.getReference(context, { referenceId: admitted.reference.id });
    assert.deepEqual([view.state, view.cleanup], ['completed', 'released']);
    assert.deepEqual(view.result, { status: 'completed', cleanup: 'released', outputText: 'done', data: { answer: 1 } });
    // database-level guards behind the API
    const db = rawDb(dir);
    assert.throws(() => db.exec("UPDATE admission SET state = 'running'"), /immutable/);
    assert.throws(() => db.exec("UPDATE admission SET result = '{}'"), /immutable/);
    assert.throws(() => db.exec("UPDATE admission SET end_payload = '{}'"), /immutable/);
    db.close();
    store.close();
});

test('admitted identity, specification and configuration are immutable in the database', (t) => {
    const dir = makeTempDir(t);
    const store = openStore(dir);
    const context = syntheticContext();
    const robotId = readyRobot(store, context);
    store.admit(context, admitRequest(robotId));
    const db = rawDb(dir);
    for (const column of ['specification', 'configuration', 'robot_id', 'attempt_id', 'logical_id', 'scope']) {
        assert.throws(() => db.exec(`UPDATE admission SET ${column} = ${column} || 'x'`), /immutable/, column);
    }
    for (const table of ['origin', 'reference']) {
        assert.throws(() => db.exec(`DELETE FROM ${table}`), /immutable/, table);
    }
    assert.throws(() => db.exec("UPDATE origin SET scope = 'x'"), /immutable/);
    assert.throws(() => db.exec('DELETE FROM admission'), /immutable/);
    db.close();
    store.close();
});

test('admission capacity is explicit and leaves no partial rows', (t) => {
    const dir = makeTempDir(t);
    const store = openStore(dir, { limits: { ...LIMITS, admissions: 2, receipts: 4 } });
    const context = syntheticContext();
    const robotId = readyRobot(store, context);
    store.admit(context, admitRequest(robotId));
    store.admit(context, admitRequest(robotId));
    const before = tableCounts(dir);
    expectCode(assert, () => store.admit(context, admitRequest(robotId)), 'capacity_exceeded');
    assert.deepEqual(tableCounts(dir), before);
    const limited = openStore(makeTempDir(t), { limits: { ...LIMITS, receipts: 1 } });
    const robot = readyRobot(limited, context);
    void robot;
    expectCode(assert, () => limited.beginProvision(context, { operationId: newId(), name: 'n', configuration: robotConfig() }), 'capacity_exceeded');
    limited.close();
    store.close();
});

test('two processes racing an identical admission produce exactly one record and equal responses', async (t) => {
    const dir = makeTempDir(t);
    const seeded = openStore(dir);
    const robotId = readyRobot(seeded, syntheticContext());
    seeded.close();
    const request = admitRequest(robotId);
    const spec = { dir, method: 'admit', context: CONTEXT_FIELDS, request };
    const results = await raceChildren([spec, spec, spec]);
    for (const result of results) assert.deepEqual([result.code, result.output?.ok], [0, true], JSON.stringify(result));
    assert.equal(new Set(results.map((result) => JSON.stringify(result.output.result))).size, 1);
    assert.deepEqual(tableCounts(dir), { receipt: 2, origin: 1, reference: 1, admission: 1 });
});

test('delete versus admission and backend configure versus admission: exactly one side wins', async (t) => {
    for (const mode of ['delete', 'configure']) {
        for (let round = 0; round < 3; round += 1) {
            const dir = makeTempDir(t);
            const seeded = openStore(dir);
            const robotId = readyRobot(seeded, syntheticContext());
            seeded.close();
            const admit = { dir, method: 'admit', context: CONTEXT_FIELDS, request: admitRequest(robotId) };
            const other = mode === 'delete'
                ? { dir, method: 'beginDelete', context: CONTEXT_FIELDS, request: { operationId: newId(), robotId, expectedRevision: 1 } }
                : { dir, method: 'configure', context: CONTEXT_FIELDS, request: { operationId: newId(), robotId, expectedRevision: 1, configuration: robotConfig({}, 'other') } };
            const [a, b] = await raceChildren(round % 2 === 0 ? [admit, other] : [other, admit]);
            const outcomes = [a, b].map((result) => (result.output?.ok ? 'ok' : result.output?.code ?? `crash:${result.code}`));
            assert.deepEqual(outcomes.toSorted(), ['ok', 'robot_busy'], `${mode} round ${round}: ${outcomes}`);
            const admissions = count(dir, 'admission');
            const db = rawDb(dir, { readOnly: true });
            const preparing = db.prepare('SELECT COUNT(*) AS c FROM preparation').get().c;
            const deleting = db.prepare("SELECT COUNT(*) AS c FROM robot WHERE lifecycle = 'deleting'").get().c;
            db.close();
            if (admissions === 1) assert.equal(preparing + deleting, 0);
            else assert.equal(preparing + deleting, 1);
        }
    }
});

test('crash before commit leaves nothing and a retry admits fresh', async (t) => {
    const dir = makeTempDir(t);
    const seeded = openStore(dir);
    const robotId = readyRobot(seeded, syntheticContext());
    seeded.close();
    const request = admitRequest(robotId);
    const crashed = await runChild({ dir, method: 'admit', context: CONTEXT_FIELDS, request, fault: { when: 'beforeCommit', label: 'admit' } });
    assert.equal(crashed.signal, 'SIGKILL');
    assert.equal(crashed.output, null);
    assert.deepEqual(tableCounts(dir), { receipt: 1, origin: 0, reference: 0, admission: 0 });
    const store = openStore(dir, { create: false });
    const context = syntheticContext();
    expectCode(assert, () => store.lookupOrigin(context, { originRequestId: request.originRequestId }), 'not_found');
    const admitted = store.admit(context, request);
    assert.equal(admitted.status, 'admitted');
    assert.deepEqual(tableCounts(dir), { receipt: 2, origin: 1, reference: 1, admission: 1 });
    store.close();
});

test('crash after commit before the response: the retry returns the recorded admission', async (t) => {
    const dir = makeTempDir(t);
    const seeded = openStore(dir);
    const robotId = readyRobot(seeded, syntheticContext());
    seeded.close();
    const request = admitRequest(robotId);
    const crashed = await runChild({ dir, method: 'admit', context: CONTEXT_FIELDS, request, fault: { when: 'afterCommit', label: 'admit' } });
    assert.equal(crashed.signal, 'SIGKILL');
    assert.equal(crashed.output, null);
    assert.deepEqual(tableCounts(dir), { receipt: 2, origin: 1, reference: 1, admission: 1 });
    const store = openStore(dir, { create: false });
    const context = syntheticContext();
    const looked = store.lookupOrigin(context, { originRequestId: request.originRequestId });
    const retried = store.admit(context, request);
    assert.equal(retried.reference.id, looked.reference.id);
    assert.equal(retried.executionId, looked.executionId);
    assert.deepEqual(tableCounts(dir), { receipt: 2, origin: 1, reference: 1, admission: 1 });
    store.close();
});

test('lifecycle crashes: provision before and after commit', async (t) => {
    const context = syntheticContext();
    const provision = { operationId: newId(), name: 'Crash robot', configuration: robotConfig() };
    const dir = makeTempDir(t);
    openStore(dir).close();
    const before = await runChild({ dir, method: 'beginProvision', context: CONTEXT_FIELDS, request: provision, fault: { when: 'beforeCommit', label: 'beginProvision' } });
    assert.equal(before.signal, 'SIGKILL');
    for (const table of ['robot', 'receipt', 'preparation', 'resource_blocker', 'completion']) assert.equal(count(dir, table), 0, table);
    const after = await runChild({ dir, method: 'beginProvision', context: CONTEXT_FIELDS, request: provision, fault: { when: 'afterCommit', label: 'beginProvision' } });
    assert.equal(after.signal, 'SIGKILL');
    for (const table of ['robot', 'receipt', 'preparation', 'resource_blocker', 'completion']) assert.equal(count(dir, table), 1, table);
    const store = openStore(dir, { create: false });
    const replay = store.beginProvision(context, provision);
    assert.equal(replay.status, 'accepted');
    assert.equal(count(dir, 'robot'), 1);
    assert.equal(store.getOperationOutcome(context, { operationId: provision.operationId }).status, 'pending');
    store.close();
});
