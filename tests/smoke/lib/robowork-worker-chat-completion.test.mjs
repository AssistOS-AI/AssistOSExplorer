import assert from 'node:assert/strict';
import test from 'node:test';
import { pinWorkerChatBaseline, selectWorkerChatExecution, matchWorkerChatAnswer } from './robowork-worker-chat-completion.mjs';

const uuid = (n) => `${String(n).padStart(8, '0')}-1111-4111-8111-111111111111`;
const scope = { robotName: 'e2e-bot', robotId: 'roboteam-public-id', workerCwd: '/workspace/project', metadataCwd: '/workspace/project', previousDomIds: [], startedMs: 1000 };
const worker = { id: 'different-worker-id', name: scope.robotName };
const ledger = (executions) => ({ robot: worker, executions });
const baseline = (extra = {}, prior = []) => pinWorkerChatBaseline(ledger(prior), { ...scope, ...extra });
const turn = { turnId: uuid(2), userMessageId: uuid(3), assistantMessageId: uuid(4), status: 'completed' };
const metadata = () => ({ sessionId: uuid(1), cwd: scope.metadataCwd, engine: { sessionId: uuid(1), cwd: scope.metadataCwd, robotId: scope.robotId }, turns: [{ ...turn }] });
const execution = (extra = {}) => ({ execution_id: 'new-execution', attempt_id: 'new-attempt', robot_id: worker.id, kind: 'turn', created_at: 1100,
    state: 'completed', end_classification: 'completed', specification: { cwd: scope.workerCwd, sessionId: uuid(1), turnId: uuid(2) },
    result: JSON.stringify({ status: 'completed', cleanup: 'released', outputText: 'DONE' }), blockers: [{ release_state: 'released', retained: 0 }], ...extra });
const match = (extra = {}) => matchWorkerChatAnswer({ baseline: baseline(), execution: execution(), metadata: metadata(),
    bubbles: [{ messageId: turn.assistantMessageId, text: 'DONE' }], busy: false, ...extra });

test('same-count current assistant completes only through the fresh worker→turn→message binding', () => {
    const initial = [{ messageId: null, text: 'initial status' }];
    const current = [{ messageId: turn.assistantMessageId, text: 'DONE' }];
    assert.equal(current.length > initial.length, false, 'The previous count rule would time out');
    const row = selectWorkerChatExecution(ledger([execution()]), baseline());
    const done = match({ execution: row, bubbles: current });
    assert.equal(done.answer, 'DONE');
    assert.equal(done.binding.assistantMessageId, turn.assistantMessageId);
    assert.equal(done.binding.turnId, row.specification.turnId);
    assert.notEqual(worker.id, scope.robotId);
});

test('missing, stale, utility-only and terminal-only admissions wait and cannot prove an answer', () => {
    for (const rows of [[], [execution({ created_at: 999 })], [execution({ kind: 'utility' })], [execution({ kind: 'terminal' })]]) {
        assert.equal(selectWorkerChatExecution(ledger(rows), baseline()), null);
    }
    const old = execution({ execution_id: 'old', created_at: 900 });
    assert.equal(selectWorkerChatExecution(ledger([old]), baseline({}, [old])), null);
});

test('ordinary worker, metadata and cleanup progress remain wait states', () => {
    for (const state of ['queued', 'running', 'stopping']) {
        const row = execution({ state, end_classification: state === 'stopping' ? 'completed' : null, result: null, blockers: [{ release_state: 'committed', retained: 0 }] });
        assert.equal(match({ execution: row }).answer, null);
    }
    assert.equal(match({ execution: execution({ blockers: [{ release_state: 'committed', retained: 0 }] }) }).answer, null);
    for (const status of [undefined, 'pending']) assert.equal(match({ metadata: { ...metadata(), turns: [{ ...turn, status }] } }).answer, null);
    assert.equal(match({ busy: true }).answer, null);
    assert.equal(match({ bubbles: [{ messageId: uuid(99), text: 'stale nonempty answer' }] }).answer, null);
    assert.equal(match({ bubbles: [{ messageId: turn.assistantMessageId, text: '' }] }).answer, null);
});

test('duplicate, wrong-worker/project and reused admission identities fail', () => {
    for (const rows of [[execution(), execution({ execution_id: 'another' })], [execution({ robot_id: 'another-worker' })],
        [execution({ specification: { ...execution().specification, cwd: '/other' } })], [execution({ kind: 'unknown' })],
        [execution({ specification: { ...execution().specification, sessionId: undefined } })]]) {
        assert.throws(() => selectWorkerChatExecution(ledger(rows), baseline()));
    }
    const old = execution({ execution_id: 'old', created_at: 900 });
    assert.throws(() => selectWorkerChatExecution(ledger([old, execution()]), baseline({}, [old])));
    const binding = match().binding;
    assert.throws(() => selectWorkerChatExecution(ledger([execution({ execution_id: 'swapped' })]), baseline(), binding));
});

test('failed/unsafe/empty completed worker results never accept a nonempty UI bubble', () => {
    const bad = [{ state: 'failed' }, { state: 'cancelled' }, { state: 'human-input' }, { end_classification: 'failed' },
        { blockers: [{ release_state: 'quarantined', retained: 0 }] }, { blockers: [{ release_state: 'released', retained: 1 }] },
        { result: JSON.stringify({ status: 'completed', cleanup: 'released', outputText: '' }) },
        { result: JSON.stringify({ status: 'failed', cleanup: 'released', outputText: 'error' }) }, { result: null }, { blockers: [] }];
    for (const override of bad) assert.throws(() => match({ execution: execution(override) }));
});

test('exact metadata session/turn/public robot/message binding cannot be replaced by stale or duplicate history', () => {
    for (const override of [{ sessionId: uuid(99) }, { cwd: '/other' }, { engine: { ...metadata().engine, robotId: worker.id } },
        { turns: [] }, { turns: [turn, turn] }, { turns: [{ ...turn, turnId: uuid(99) }] }, { turns: [{ ...turn, status: 'failed' }] }]) {
        assert.throws(() => match({ metadata: { ...metadata(), ...override } }));
    }
    assert.throws(() => match({ baseline: baseline({ previousDomIds: [turn.assistantMessageId] }) }));
    assert.throws(() => match({ bubbles: [{ messageId: turn.assistantMessageId, text: 'one' }, { messageId: turn.assistantMessageId, text: 'two' }] }));
    const bound = match().binding;
    assert.throws(() => match({ binding: bound, metadata: { ...metadata(), turns: [{ ...turn, assistantMessageId: uuid(99) }] } }));
});

test('root metadata is read at the workspace while the worker receives no project cwd or folders', () => {
    const rootBaseline = baseline({ metadataCwd: '/workspace', workerCwd: '' });
    const row = execution({ specification: { sessionId: uuid(1), turnId: uuid(2) } });
    assert.equal(selectWorkerChatExecution(ledger([row]), rootBaseline), row);
    const rootMetadata = { ...metadata(), cwd: '/workspace', engine: { ...metadata().engine, cwd: '/workspace' } };
    assert.equal(match({ baseline: rootBaseline, execution: row, metadata: rootMetadata }).answer, 'DONE');
    assert.throws(() => selectWorkerChatExecution(ledger([execution()]), rootBaseline));
    assert.throws(() => selectWorkerChatExecution(ledger([execution({ specification: { ...row.specification, folders: [{ path: '/workspace' }] } })]), rootBaseline));
});
