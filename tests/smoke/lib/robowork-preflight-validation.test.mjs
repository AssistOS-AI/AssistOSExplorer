import assert from 'node:assert/strict';
import test from 'node:test';

import { validatePreflightExecution } from './robowork-preflight-validation.mjs';

const scope = { robotName: 'e2e-bot', cwd: '/workspace/e2e-preflight-current', startedMs: 1000, observedAtMs: 2000 };
function completed(overrides = {}) {
    return {
        execution_id: 'current-execution', attempt_id: 'current-attempt', robotName: scope.robotName,
        kind: 'turn', created_at: 1500, specification: { cwd: scope.cwd, sessionId: 'current-session', turnId: 'current-turn' },
        state: 'completed', end_classification: 'completed',
        result: JSON.stringify({ status: 'completed', cleanup: 'released', outputText: 'The model can answer a question.' }),
        blockers: [{ release_state: 'released', retained: 0 }], ...overrides,
    };
}
const validate = (executions, extra = {}) => validatePreflightExecution({ ...scope, executions, ...extra });

test('a completed worker model answer proves liveness without requiring the literal word OK', () => {
    const evidence = validate([completed()]);
    assert.deepEqual(evidence, { executionId: 'current-execution', attemptId: 'current-attempt', outputChars: 32 });
});

test('counterfactual: FAILED worker with a nonempty UI error bubble cannot select a working model', () => {
    const uiAnswer = 'Could not execute the turn: model_unavailable';
    assert.ok(uiAnswer.length > 0, 'The former UI-only success condition would have accepted this error');
    const failed = completed({ execution_id: 'Hix60G40IY_CckfGongtnw', state: 'failed', end_classification: 'failed',
        result: JSON.stringify({ status: 'failed', cleanup: 'released', outputText: uiAnswer, data: { reason: 'model_unavailable' } }) });
    assert.throws(() => validate([failed]), /worker execution completed/);
});

test('failed, pending, interrupted and human-input worker states never prove preflight liveness', async (t) => {
    for (const state of ['failed', 'queued', 'running', 'stopping', 'paused', 'human-input', 'cancelled', 'interrupted', 'unknown']) {
        await t.test(state, () => assert.throws(() => validate([completed({ state })]), /worker execution completed/));
    }
});

test('the result and cleanup must independently confirm completed nonempty output', async (t) => {
    const cases = [
        ['failed classification', { end_classification: 'failed' }],
        ['failed result status', { result: JSON.stringify({ status: 'failed', cleanup: 'released', outputText: 'text' }) }],
        ['quarantine', { result: JSON.stringify({ status: 'completed', cleanup: 'quarantined', outputText: 'text' }) }],
        ['unknown cleanup', { result: JSON.stringify({ status: 'completed', outputText: 'text' }) }],
        ['empty output', { result: JSON.stringify({ status: 'completed', cleanup: 'released', outputText: '' }) }],
        ['whitespace output', { result: JSON.stringify({ status: 'completed', cleanup: 'released', outputText: ' \n\t' }) }],
        ['missing output', { result: JSON.stringify({ status: 'completed', cleanup: 'released' }) }],
        ['malformed result', { result: '{invalid' }],
        ['missing result', { result: null }],
        ['no resource proof', { blockers: [] }],
        ['quarantined blocker', { blockers: [{ release_state: 'quarantined', retained: 0 }] }],
        ['pending blocker', { blockers: [{ release_state: 'committed', retained: 0 }] }],
        ['retained blocker', { blockers: [{ release_state: 'released', retained: 1 }] }],
        ['utility', { kind: 'utility' }],
        ['terminal', { kind: 'terminal' }],
        ['unknown execution kind', { kind: 'unknown' }],
    ];
    for (const [name, overrides] of cases) await t.test(name, () => assert.throws(() => validate([completed(overrides)])));
});

test('stale, different-robot/cwd, missing and duplicate-attempt evidence cannot validate the current candidate', async (t) => {
    const cases = [
        ['older completed execution', [completed({ created_at: 999 })]],
        ['different robot', [completed({ robotName: 'another-robot' })]],
        ['different cwd', [completed({ specification: { cwd: '/workspace/other-project' } })]],
        ['future execution', [completed({ created_at: 2001 })]],
        ['missing execution', []],
        ['duplicate attempts', [completed(), completed({ attempt_id: 'another-attempt' })]],
        ['two new executions', [completed(), completed({ execution_id: 'another-execution', attempt_id: 'another-attempt' })]],
        ['missing attempt identity', [completed({ attempt_id: null })]],
    ];
    for (const [name, executions] of cases) await t.test(name, () => assert.throws(() => validate(executions)));
    await t.test('execution already present in the pre-turn snapshot', () => {
        assert.throws(() => validate([completed()], { previousExecutionIds: ['current-execution'] }), /Exactly one new worker execution/);
    });
});

test('unrelated concurrent executions cannot substitute for or invalidate the single scoped success', () => {
    assert.equal(validate([
        completed({ execution_id: 'old', created_at: 999 }),
        completed({ execution_id: 'other-robot', robotName: 'another-robot', state: 'failed' }),
        completed({ execution_id: 'other-project', specification: { cwd: '/workspace/other' }, state: 'failed' }),
        completed(),
    ]).executionId, 'current-execution');
});
