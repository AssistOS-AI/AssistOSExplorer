import assert from 'node:assert/strict';
import test from 'node:test';
import { renderAlaTurnLog } from '../copilot/src/lib/webchat/webchatTurnLog.mjs';

// LSR-11: ALA 0ef0a85 folds turns without a `tools` array; older transcripts
// carry one. Both render, in recording order.
test('a turn folded by current ALA (no tools array) renders its follow-ups and messages in order', () => {
    const turn = { turnId: 't', startedAt: 'now', user: 'question', followUps: [{ seq: 3, text: 'and also this' }],
        messages: [{ seq: 2, text: 'Reading files.\n' }, { seq: 4, text: 'Done.' }], final: 'Done.', status: 'completed',
        durationMs: 5, error: null, endedAt: 'later', firstSeq: 1, lastSeq: 4 };
    assert.equal(renderAlaTurnLog(turn), 'Reading files.\nyou> and also this\nDone.');
});

test('an older turn with tools keeps its tool lines', () => {
    const turn = { followUps: [], messages: [{ seq: 1, text: 'Start' }], tools: [{ seq: 2, reason: 'Ran the tests' }, { seq: 3 }] };
    assert.equal(renderAlaTurnLog(turn), 'Start\nRan the tests');
});

test('a turn without any recorded entries renders empty text', () => {
    assert.equal(renderAlaTurnLog({ final: 'x' }), '');
});

test('entries without a numeric sequence sort last, in recording order', () => {
    const turn = { messages: [{ text: 'no seq A' }, { seq: 2, text: 'second' }, { seq: 'x', text: 'no seq B' }, { seq: 1, text: 'first' }],
        followUps: [{ seq: 2, text: 'tied' }] };
    assert.equal(renderAlaTurnLog(turn), 'first\nyou> tied\nsecond\nno seq A\nno seq B');
    assert.equal(renderAlaTurnLog(turn), renderAlaTurnLog(structuredClone(turn)), 'deterministic');
});
