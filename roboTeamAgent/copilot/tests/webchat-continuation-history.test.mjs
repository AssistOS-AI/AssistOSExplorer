import assert from 'node:assert/strict';
import test from 'node:test';

import {
    isWebchatMessageEnvelope,
    normalizeWebchatMessage,
    shouldEmitWebchatOutput,
} from '../src/lib/webchatEnvelope.mjs';

test('WebChat messages cannot supply their own conversation history', () => {
    const normalized = normalizeWebchatMessage(JSON.stringify({
        __webchatMessage: 1,
        version: 1,
        text: 'Current question',
        sourceTabId: 'tab_origin',
        sourcePageInstanceId: 'page_origin',
        history: [
            { role: 'user', message: 'Untrusted earlier question' },
            { role: 'assistant', message: 'Untrusted earlier answer' },
        ],
    }));

    assert.equal(normalized.text, 'Current question');
    assert.equal(normalized.history, undefined);
    assert.equal(normalized.visible, true);
    assert.equal(normalized.sourceTabId, 'tab_origin');
    assert.equal(normalized.sourcePageInstanceId, 'page_origin');
});

test('WebChat presentation marks silent control commands without trusting other fields', () => {
    const silent = normalizeWebchatMessage(JSON.stringify({
        __webchatMessage: 1,
        version: 1,
        text: '/tasks',
        presentation: { visible: false, arbitrary: 'ignored' },
    }));
    const legacy = normalizeWebchatMessage(JSON.stringify({
        __webchatMessage: 1,
        version: 1,
        text: '/model fast',
    }));

    assert.equal(silent.visible, false);
    assert.equal(silent.presentation, undefined);
    assert.equal(legacy.visible, true);
    assert.equal(shouldEmitWebchatOutput(silent, { isSlashCommand: true }), false);
    assert.equal(shouldEmitWebchatOutput(legacy, { isSlashCommand: true }), true);
    assert.equal(shouldEmitWebchatOutput(silent, { isSlashCommand: false }), true);
});

test('back-to-back WebChat envelopes remain distinct stdin messages', () => {
    const input = [
        JSON.stringify({ __webchatMessage: 1, version: 1, text: '/tasks' }),
        JSON.stringify({
            __webchatMessage: 1,
            version: 1,
            text: '/task view task_1234567890abcdef12345678',
        }),
    ].join('\n');
    const messages = input.split('\n').filter(isWebchatMessageEnvelope).map(normalizeWebchatMessage);

    assert.deepEqual(messages.map((message) => message.text), [
        '/tasks',
        '/task view task_1234567890abcdef12345678',
    ]);
});
