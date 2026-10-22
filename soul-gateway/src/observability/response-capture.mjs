/**
 * Response capture helpers for durable audit logging.
 *
 * Streaming requests are observed incrementally as canonical events pass
 * through the response writer. Buffered requests are shaped from the
 * already-built completion envelope.
 *
 * @module observability/response-capture
 */

import { redactPayload } from './redaction.mjs';

const DEFAULT_EXCERPT_CHARS = 2000;
const DEFAULT_MAX_PAYLOAD_BYTES = 131_072;
const TRUNCATED_MARKER = '...[truncated]';

export function createStreamCapture({
    maxExcerptChars = DEFAULT_EXCERPT_CHARS,
} = {}) {
    const state = {
        textParts: [],
        toolCalls: [],
        usage: null,
        finishReason: null,
        error: null,
    };

    return {
        observe(event) {
            reduceStreamEvent(state, event);
        },
        result() {
            const content = state.textParts.join('');
            const { excerpt } = redactPayload(content, maxExcerptChars);
            return {
                excerpt,
                payload: buildNormalizedPayload({
                    content: content || null,
                    toolCalls: state.toolCalls.filter(Boolean),
                    finishReason: state.finishReason,
                    usage: state.usage,
                }),
                usage: state.usage,
                finishReason: state.finishReason,
                error: state.error,
            };
        },
    };
}

export function buildBufferedCapture(
    envelope,
    { maxExcerptChars = DEFAULT_EXCERPT_CHARS } = {}
) {
    if (!envelope || typeof envelope !== 'object') {
        return { excerpt: null, payload: null };
    }

    const message = envelope.choices?.[0]?.message || envelope.message || null;
    const content =
        typeof message?.content === 'string' ? message.content : null;
    const { excerpt } = redactPayload(content, maxExcerptChars);
    return { excerpt, payload: envelope };
}

export function shapeStoredPayload(
    payload,
    { maxPayloadBytes = DEFAULT_MAX_PAYLOAD_BYTES } = {}
) {
    if (payload == null) return { payload: null, truncated: false };

    let serialized;
    try {
        serialized = JSON.stringify(payload);
    } catch {
        return { payload: null, truncated: false };
    }

    if (Buffer.byteLength(serialized, 'utf8') <= maxPayloadBytes) {
        return { payload, truncated: false };
    }

    const clone = JSON.parse(serialized);
    const message = clone.choices?.[0]?.message;
    if (message && typeof message.content === 'string') {
        const overage =
            Buffer.byteLength(serialized, 'utf8') - maxPayloadBytes;
        const keep = Math.max(
            0,
            message.content.length - overage - TRUNCATED_MARKER.length - 32
        );
        message.content = `${message.content.slice(0, keep)}${TRUNCATED_MARKER}`;
    }

    return { payload: clone, truncated: true };
}

function reduceStreamEvent(state, event) {
    if (!event || typeof event !== 'object') return;
    const payload = event.data || event;

    switch (event.type) {
        case 'text_delta':
            if (typeof payload.text === 'string' && payload.text.length > 0) {
                state.textParts.push(payload.text);
            }
            break;

        case 'tool_call_delta':
            reduceToolCallDelta(state.toolCalls, payload);
            break;

        case 'usage':
            state.usage = normalizeUsage(payload);
            break;

        case 'done':
            state.finishReason =
                payload.finish_reason || event.finish_reason || 'stop';
            break;

        case 'error':
            state.error = normalizeStreamError(event);
            break;
    }
}

function reduceToolCallDelta(toolCalls, payload) {
    const index = payload.index ?? 0;
    if (!toolCalls[index]) {
        toolCalls[index] = {
            id: payload.id,
            type: 'function',
            function: { name: payload.name || '', arguments: '' },
        };
    }
    if (payload.arguments) {
        toolCalls[index].function.arguments += payload.arguments;
    }
    if (payload.name) {
        toolCalls[index].function.name = payload.name;
    }
    if (payload.id) {
        toolCalls[index].id = payload.id;
    }
}

function normalizeUsage(payload) {
    const inputTokens =
        payload.input_tokens ??
        payload.inputTokens ??
        payload.prompt_tokens ??
        payload.promptTokens ??
        0;
    const outputTokens =
        payload.output_tokens ??
        payload.outputTokens ??
        payload.completion_tokens ??
        payload.completionTokens ??
        0;
    return {
        input_tokens: inputTokens,
        output_tokens: outputTokens,
        total_tokens:
            payload.total_tokens ??
            payload.totalTokens ??
            inputTokens + outputTokens,
    };
}

function buildNormalizedPayload({ content, toolCalls, finishReason, usage }) {
    const message = {
        role: 'assistant',
        content,
        ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
    };

    return {
        choices: [
            {
                index: 0,
                message,
                finish_reason: finishReason ?? null,
            },
        ],
        usage: {
            prompt_tokens: usage?.input_tokens ?? 0,
            completion_tokens: usage?.output_tokens ?? 0,
            total_tokens: usage?.total_tokens ?? 0,
        },
    };
}

function normalizeStreamError(event) {
    const source = event.error || event.data?.error || event.data || event;
    const error =
        source instanceof Error
            ? source
            : new Error(source.message || event.message || 'stream error');
    error.errorType =
        source.errorType ||
        source.type ||
        event.errorType ||
        event.data?.type ||
        'stream_error';
    return error;
}
