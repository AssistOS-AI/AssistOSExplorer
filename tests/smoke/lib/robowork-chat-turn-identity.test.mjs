import assert from 'node:assert/strict';
import test from 'node:test';

import { pinChatTurnBaseline, currentChatTurnAnswer } from './robowork-chat-turn-identity.mjs';

const id = (n) => `${String(n).padStart(8, '0')}-1111-4111-8111-111111111111`;
const context = { sessionId: id(1), robotId: 'test-robot', cwd: '/workspace/c-project' };
const oldTurn = { turnId: id(2), userMessageId: id(3), assistantMessageId: id(4), status: 'completed' };
const newTurn = { turnId: id(5), userMessageId: id(6), assistantMessageId: id(7), status: 'completed' };
const metadata = (turns) => ({ sessionId: context.sessionId, cwd: context.cwd, engine: { ...context }, turns });
const baseline = () => pinChatTurnBaseline(metadata([oldTurn]), context);
const probe = (changes = {}) => currentChatTurnAnswer({ baseline: baseline(), metadata: metadata([oldTurn, newTurn]), currentContext: context,
    bubbles: [{ messageId: newTurn.assistantMessageId, text: 'DONE' }], busy: false, ...changes });

test('counterfactual C: one bubble is replaced by the completed current assistant without increasing count', () => {
    const initial = [{ messageId: oldTurn.assistantMessageId, text: 'old answer' }];
    const completed = [{ messageId: newTurn.assistantMessageId, text: 'DONE' }];
    assert.equal(completed.length > initial.length, false, 'The former count-growth gate would never complete');
    assert.equal(probe({ bubbles: completed }).answer, 'DONE');
    const pending = probe({ metadata: metadata([oldTurn, { ...newTurn, status: undefined }]) });
    assert.equal(pending.answer, null);
    assert.equal(probe({ binding: pending.binding, bubbles: completed }).answer, 'DONE');
});

test('changed or nonempty old text, old turn metadata and empty/unidentified current nodes cannot complete', () => {
    assert.equal(probe({ metadata: metadata([oldTurn]), bubbles: [{ messageId: oldTurn.assistantMessageId, text: 'changed old DONE' }] }).answer, null);
    assert.equal(probe({ bubbles: [{ messageId: oldTurn.assistantMessageId, text: 'changed old DONE' }] }).answer, null);
    assert.equal(probe({ bubbles: [{ messageId: null, text: 'DONE' }] }).answer, null);
    assert.equal(probe({ bubbles: [{ messageId: newTurn.assistantMessageId, text: ' \n' }] }).answer, null);
    assert.equal(probe({ bubbles: [] }).answer, null);
    assert.equal(probe({ busy: true }).answer, null);
});

test('conversation, robot and project identities stay pinned', () => {
    for (const currentContext of [{ ...context, sessionId: id(8) }, { ...context, robotId: 'another-robot' }]) {
        assert.throws(() => probe({ currentContext }));
    }
    for (const change of [{ sessionId: id(8) }, { cwd: '/workspace/another-project' },
        { engine: { ...context, robotId: 'another-robot' } }, { engine: { ...context, sessionId: id(8) } },
        { engine: { ...context, cwd: '/workspace/another-project' } }, { engine: undefined }]) {
        assert.throws(() => probe({ metadata: { ...metadata([oldTurn, newTurn]), ...change } }));
    }
});

test('duplicate new turns, reused message IDs and rewritten history are rejected', () => {
    const cases = [
        [oldTurn, newTurn, newTurn],
        [oldTurn, newTurn, { ...newTurn, turnId: id(8), userMessageId: id(9), assistantMessageId: id(10) }],
        [oldTurn, { ...newTurn, assistantMessageId: oldTurn.assistantMessageId }],
        [oldTurn, { ...newTurn, userMessageId: newTurn.assistantMessageId }],
        [{ ...oldTurn, assistantMessageId: id(8) }, newTurn],
        [newTurn],
        [oldTurn, { ...newTurn, assistantMessageId: null }],
    ];
    for (const turns of cases) assert.throws(() => probe({ metadata: metadata(turns) }));
    const duplicateDom = [{ messageId: newTurn.assistantMessageId, text: 'DONE' }, { messageId: newTurn.assistantMessageId, text: 'other' }];
    assert.throws(() => probe({ bubbles: duplicateDom }));
});

test('the first new turn binding cannot change, disappear or select a command/failed turn', () => {
    const binding = probe({ metadata: metadata([oldTurn, { ...newTurn, status: undefined }]) }).binding;
    assert.throws(() => probe({ binding, metadata: metadata([oldTurn]) }));
    assert.throws(() => probe({ binding, metadata: metadata([oldTurn, { ...newTurn, assistantMessageId: id(8) }]) }));
    assert.throws(() => probe({ metadata: metadata([oldTurn, { ...newTurn, context: false }]) }));
    for (const status of ['failed', 'interrupted', 'unknown']) assert.throws(() => probe({ metadata: metadata([oldTurn, { ...newTurn, status }]) }));
});

test('new empty conversations and multiple subsequent sends retain separate canonical identities', () => {
    const empty = pinChatTurnBaseline(metadata([]), context);
    const first = probe({ baseline: empty, metadata: metadata([newTurn]) });
    assert.equal(first.answer, 'DONE');
    const nextBaseline = pinChatTurnBaseline(metadata([newTurn]), context);
    const next = { turnId: id(8), userMessageId: id(9), assistantMessageId: id(10), status: 'completed' };
    const result = probe({ baseline: nextBaseline, metadata: metadata([newTurn, next]), bubbles: [
        { messageId: newTurn.assistantMessageId, text: 'old DONE' }, { messageId: next.assistantMessageId, text: 'current DONE' },
    ] });
    assert.equal(result.answer, 'current DONE');
});
