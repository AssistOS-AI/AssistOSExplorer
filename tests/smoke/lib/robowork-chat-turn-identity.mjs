import assert from 'node:assert/strict';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const identity = ({ turnId, userMessageId, assistantMessageId }) => ({ turnId, userMessageId, assistantMessageId });

function inspectMetadata(metadata, context) {
    assert.equal(metadata.sessionId, context.sessionId, 'Chat metadata belongs to the pinned conversation');
    assert.equal(metadata.cwd, context.cwd, 'Chat metadata belongs to the exact scenario project');
    if (metadata.engine) {
        assert.equal(metadata.engine.sessionId, context.sessionId, 'Chat engine stays on the pinned conversation');
        assert.equal(metadata.engine.cwd, context.cwd, 'Chat engine stays in the scenario project');
        if (metadata.engine.robotId) assert.equal(metadata.engine.robotId, context.robotId, 'Chat engine belongs to the pinned robot');
    }
    assert.ok(Array.isArray(metadata.turns), 'Conversation turn metadata is available');
    const ids = new Set();
    const messages = new Set();
    for (const turn of metadata.turns) {
        for (const value of [turn.turnId, turn.userMessageId, turn.assistantMessageId]) assert.match(value || '', UUID, 'Conversation turn/message identities are valid');
        assert.ok(!ids.has(turn.turnId), 'Conversation has no duplicate turn IDs');
        ids.add(turn.turnId);
        for (const value of [turn.userMessageId, turn.assistantMessageId]) {
            assert.ok(!messages.has(value), 'Conversation has no reused or duplicate message IDs');
            messages.add(value);
        }
    }
}

export function pinChatTurnBaseline(metadata, context) {
    inspectMetadata(metadata, context);
    return { ...context, turns: metadata.turns.map(identity) };
}

// History rendering can replace the whole DOM without increasing bubble count. The saved turn tuple binds its current assistant node.
export function currentChatTurnAnswer({ baseline, metadata, currentContext, bubbles, busy, binding = null }) {
    assert.equal(currentContext.sessionId, baseline.sessionId, 'WebChat stayed on the pinned conversation');
    assert.equal(currentContext.robotId, baseline.robotId, 'WebChat stayed on the pinned robot');
    inspectMetadata(metadata, baseline);
    for (const previous of baseline.turns) {
        const saved = metadata.turns.find((turn) => turn.turnId === previous.turnId);
        assert.ok(saved, 'Previous turn metadata was not removed');
        assert.deepEqual(identity(saved), previous, 'Previous turn/message identities were not rewritten');
    }
    const previousIds = new Set(baseline.turns.map((turn) => turn.turnId));
    const added = metadata.turns.filter((turn) => !previousIds.has(turn.turnId));
    assert.ok(added.length <= 1, 'Exactly one new turn may belong to this send');
    if (!added.length) {
        assert.equal(binding, null, 'The bound current turn did not disappear');
        return { binding: null, answer: null };
    }
    const turn = added[0];
    assert.notEqual(turn.context, false, 'The new turn is an AI turn, not a silent command');
    const selected = identity(turn);
    if (binding) assert.deepEqual(selected, binding, 'Current turn/message binding is stable');
    assert.ok(turn.status === undefined || ['pending', 'completed'].includes(turn.status), `Current turn did not complete successfully: ${turn.status}`);
    if (turn.status === 'completed') assert.equal(metadata.engine?.robotId, baseline.robotId, 'The completed turn is bound to the pinned robot');
    const matching = bubbles.filter((bubble) => bubble.messageId === turn.assistantMessageId);
    assert.ok(matching.length <= 1, 'The bound assistant message has no duplicate DOM nodes');
    const text = matching[0]?.text;
    return { binding: selected, answer: turn.status === 'completed' && !busy && typeof text === 'string' && text.trim() ? text : null };
}
