import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
    buildBufferedCapture,
    createStreamCapture,
    shapeStoredPayload,
} from '../../observability/response-capture.mjs';

describe('response capture', () => {
    it('accumulates streamed text, usage, and finish reason into a payload', () => {
        const capture = createStreamCapture({ maxExcerptChars: 2000 });

        capture.observe({
            type: 'message_start',
            data: { id: 'm1', model: 'stub-model', role: 'assistant' },
        });
        capture.observe({ type: 'text_delta', data: { text: 'streamed ' } });
        capture.observe({ type: 'text_delta', data: { text: 'answer' } });
        capture.observe({
            type: 'usage',
            data: { input_tokens: 2, output_tokens: 5, total_tokens: 7 },
        });
        capture.observe({ type: 'done', data: { finish_reason: 'stop' } });

        const result = capture.result();

        assert.equal(result.excerpt, 'streamed answer');
        assert.equal(
            result.payload.choices[0].message.content,
            'streamed answer'
        );
        assert.equal(result.payload.choices[0].finish_reason, 'stop');
        assert.deepEqual(result.payload.usage, {
            prompt_tokens: 2,
            completion_tokens: 5,
            total_tokens: 7,
        });
    });

    it('keeps partial streamed text when an error event arrives', () => {
        const capture = createStreamCapture({ maxExcerptChars: 2000 });

        capture.observe({
            type: 'text_delta',
            data: { text: 'partial before error' },
        });
        capture.observe({
            type: 'error',
            error: { message: 'upstream exploded', type: 'provider_error' },
        });

        const result = capture.result();

        assert.equal(result.excerpt, 'partial before error');
        assert.equal(
            result.payload.choices[0].message.content,
            'partial before error'
        );
        assert.equal(result.error.message, 'upstream exploded');
        assert.equal(result.error.errorType, 'provider_error');
    });

    it('builds capped excerpts from buffered completion envelopes', () => {
        const capture = buildBufferedCapture(
            {
                choices: [
                    {
                        message: {
                            role: 'assistant',
                            content: 'buffered response body',
                        },
                    },
                ],
            },
            { maxExcerptChars: 8 }
        );

        assert.equal(capture.excerpt, 'buffered...');
        assert.equal(
            capture.payload.choices[0].message.content,
            'buffered response body'
        );
    });

    it('truncates oversized stored payloads', () => {
        const shaped = shapeStoredPayload(
            {
                choices: [
                    {
                        message: {
                            role: 'assistant',
                            content: 'x'.repeat(300),
                        },
                    },
                ],
            },
            { maxPayloadBytes: 120 }
        );

        assert.equal(shaped.truncated, true);
        assert.match(
            shaped.payload.choices[0].message.content,
            /\.\.\.\[truncated\]$/
        );
    });
});
