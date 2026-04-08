/**
 * Canonical stream → SSE framing.
 *
 * Converts a `CanonicalStream` (or any async iterable of canonical
 * events) into a stream of Server-Sent-Event wire bytes appropriate
 * for each public route kind.  The terminator and framing style differ:
 *
 *   - **openai_chat** — each event is serialized as `data: {json}\n\n`
 *     where the JSON shape is what the existing `serializeStreamChunk`
 *     returns for `openai_chat`.  The stream ends with `data: [DONE]\n\n`.
 *   - **anthropic_messages** — each event is an `event: <name>\ndata: {json}\n\n`
 *     frame where the event name is drawn from the Anthropic event
 *     taxonomy (`message_start`, `content_block_delta`, `message_delta`,
 *     `message_stop`).  No `[DONE]` sentinel.
 *   - **openai_responses** — each event is an `event: <name>\ndata: {json}\n\n`
 *     frame using the Responses event names (`response.output_text.delta`,
 *     `response.completed`).
 *
 * This module deliberately does NOT talk to `ctx.http.res` directly.
 * It yields byte chunks so the caller (a route middleware) controls
 * when writes happen, when to flush, and when to abort.
 *
 * Canonical events supported:
 *   message_start  { id, model, role }
 *   text_delta     { text }
 *   tool_call_delta { index, id?, name?, arguments? }
 *   usage          { input_tokens, output_tokens, total_tokens }
 *   done           { finish_reason, model }
 *   error          { message, type? }
 *
 * @module runtime/route/canonical-stream-to-sse
 */

import { serializeStreamChunk } from '../../request/format-serializers.mjs';

/**
 * Build the SSE byte iterator for a canonical stream.
 *
 * @param {AsyncIterable<object>} canonicalStream
 * @param {'openai_chat'|'anthropic_messages'|'openai_responses'} routeKind
 * @param {string} requestId
 * @returns {AsyncGenerator<string>} yields SSE wire-format strings
 */
export async function* canonicalStreamToSse(
    canonicalStream,
    routeKind,
    requestId
) {
    if (routeKind === 'anthropic_messages') {
        yield* toAnthropicSse(canonicalStream, requestId);
        return;
    }
    if (routeKind === 'openai_responses') {
        yield* toResponsesSse(canonicalStream, requestId);
        return;
    }
    yield* toOpenAiChatSse(canonicalStream, requestId);
}

// ── OpenAI Chat Completions ────────────────────────────────────────────

async function* toOpenAiChatSse(stream, requestId) {
    let model = null;
    let startedEmitted = false;

    for await (const event of stream) {
        switch (event.type) {
            case 'message_start': {
                model = event.data?.model || model;
                // Emit the conventional OpenAI "start" chunk with role: 'assistant'
                const startChunk = {
                    model,
                    choices: [
                        { delta: { role: event.data?.role || 'assistant' } },
                    ],
                };
                yield `data: ${serializeStreamChunk(startChunk, 'openai_chat', requestId)}\n\n`;
                startedEmitted = true;
                break;
            }

            case 'text_delta': {
                if (!startedEmitted) {
                    yield `data: ${serializeStreamChunk({ model, choices: [{ delta: { role: 'assistant' } }] }, 'openai_chat', requestId)}\n\n`;
                    startedEmitted = true;
                }
                const chunk = {
                    model,
                    choices: [{ delta: { content: event.data?.text || '' } }],
                };
                yield `data: ${serializeStreamChunk(chunk, 'openai_chat', requestId)}\n\n`;
                break;
            }

            case 'tool_call_delta': {
                if (!startedEmitted) {
                    yield `data: ${serializeStreamChunk({ model, choices: [{ delta: { role: 'assistant' } }] }, 'openai_chat', requestId)}\n\n`;
                    startedEmitted = true;
                }
                const chunk = {
                    model,
                    choices: [
                        {
                            delta: {
                                tool_calls: [
                                    {
                                        index: event.data?.index ?? 0,
                                        ...(event.data?.id
                                            ? { id: event.data.id }
                                            : {}),
                                        function: {
                                            ...(event.data?.name
                                                ? { name: event.data.name }
                                                : {}),
                                            ...(event.data?.arguments
                                                ? {
                                                      arguments:
                                                          event.data.arguments,
                                                  }
                                                : {}),
                                        },
                                    },
                                ],
                            },
                        },
                    ],
                };
                yield `data: ${serializeStreamChunk(chunk, 'openai_chat', requestId)}\n\n`;
                break;
            }

            case 'usage': {
                const chunk = {
                    model,
                    choices: [],
                    usage: {
                        prompt_tokens: event.data?.input_tokens || 0,
                        completion_tokens: event.data?.output_tokens || 0,
                        total_tokens: event.data?.total_tokens || 0,
                    },
                };
                yield `data: ${serializeStreamChunk(chunk, 'openai_chat', requestId)}\n\n`;
                break;
            }

            case 'done': {
                model = event.data?.model || model;
                const chunk = {
                    model,
                    choices: [
                        {
                            delta: {},
                            finish_reason: event.data?.finish_reason || 'stop',
                        },
                    ],
                };
                yield `data: ${serializeStreamChunk(chunk, 'openai_chat', requestId)}\n\n`;
                yield 'data: [DONE]\n\n';
                return;
            }

            case 'error': {
                const payload = {
                    error: {
                        message:
                            event.error?.message ||
                            event.message ||
                            'stream error',
                        type: event.error?.type || event.type || 'stream_error',
                    },
                };
                yield `data: ${JSON.stringify(payload)}\n\n`;
                return;
            }
        }
    }

    // Stream ended without an explicit `done` — emit a synthetic one
    // then the [DONE] sentinel so clients see a clean close.
    yield `data: ${serializeStreamChunk({ model, choices: [{ delta: {}, finish_reason: 'stop' }] }, 'openai_chat', requestId)}\n\n`;
    yield 'data: [DONE]\n\n';
}

// ── Anthropic Messages ─────────────────────────────────────────────────

async function* toAnthropicSse(stream, requestId) {
    let model = null;
    let started = false;
    let contentBlockStarted = false;

    for await (const event of stream) {
        switch (event.type) {
            case 'message_start': {
                model = event.data?.model || model;
                if (!started) {
                    started = true;
                    yield sseEvent('message_start', {
                        type: 'message_start',
                        message: {
                            id: requestId,
                            type: 'message',
                            role: 'assistant',
                            model,
                            content: [],
                            stop_reason: null,
                            stop_sequence: null,
                            usage: { input_tokens: 0, output_tokens: 0 },
                        },
                    });
                }
                break;
            }

            case 'text_delta': {
                if (!started) {
                    started = true;
                    yield sseEvent('message_start', {
                        type: 'message_start',
                        message: {
                            id: requestId,
                            type: 'message',
                            role: 'assistant',
                            model,
                            content: [],
                            stop_reason: null,
                            stop_sequence: null,
                            usage: { input_tokens: 0, output_tokens: 0 },
                        },
                    });
                }
                if (!contentBlockStarted) {
                    contentBlockStarted = true;
                    yield sseEvent('content_block_start', {
                        type: 'content_block_start',
                        index: 0,
                        content_block: { type: 'text', text: '' },
                    });
                }
                yield sseEvent('content_block_delta', {
                    type: 'content_block_delta',
                    index: 0,
                    delta: { type: 'text_delta', text: event.data?.text || '' },
                });
                break;
            }

            case 'tool_call_delta': {
                yield sseEvent('content_block_delta', {
                    type: 'content_block_delta',
                    index: event.data?.index ?? 0,
                    delta: {
                        type: 'input_json_delta',
                        partial_json: event.data?.arguments || '',
                    },
                });
                break;
            }

            case 'usage': {
                yield sseEvent('message_delta', {
                    type: 'message_delta',
                    delta: {},
                    usage: { output_tokens: event.data?.output_tokens || 0 },
                });
                break;
            }

            case 'done': {
                if (contentBlockStarted) {
                    yield sseEvent('content_block_stop', {
                        type: 'content_block_stop',
                        index: 0,
                    });
                }
                yield sseEvent('message_delta', {
                    type: 'message_delta',
                    delta: {
                        stop_reason: mapFinishReasonToAnthropic(
                            event.data?.finish_reason
                        ),
                        stop_sequence: null,
                    },
                    usage: {},
                });
                yield sseEvent('message_stop', { type: 'message_stop' });
                return;
            }

            case 'error': {
                yield sseEvent('error', {
                    type: 'error',
                    error: {
                        type: event.error?.type || 'api_error',
                        message:
                            event.error?.message ||
                            event.message ||
                            'stream error',
                    },
                });
                return;
            }
        }
    }

    if (contentBlockStarted) {
        yield sseEvent('content_block_stop', {
            type: 'content_block_stop',
            index: 0,
        });
    }
    yield sseEvent('message_delta', {
        type: 'message_delta',
        delta: { stop_reason: 'end_turn', stop_sequence: null },
        usage: {},
    });
    yield sseEvent('message_stop', { type: 'message_stop' });
}

function mapFinishReasonToAnthropic(reason) {
    switch (reason) {
        case 'stop':
            return 'end_turn';
        case 'length':
            return 'max_tokens';
        case 'tool_calls':
            return 'tool_use';
        case 'content_filter':
            return 'end_turn';
        default:
            return reason || 'end_turn';
    }
}

// ── OpenAI Responses API ───────────────────────────────────────────────

async function* toResponsesSse(stream, requestId) {
    let model = null;
    const itemId = `msg_${requestId}`;
    let startedItem = false;

    for await (const event of stream) {
        switch (event.type) {
            case 'message_start': {
                model = event.data?.model || model;
                yield sseEvent('response.created', {
                    type: 'response.created',
                    response: {
                        id: requestId,
                        object: 'response',
                        status: 'in_progress',
                        model,
                    },
                });
                break;
            }

            case 'text_delta': {
                if (!startedItem) {
                    startedItem = true;
                    yield sseEvent('response.output_item.added', {
                        type: 'response.output_item.added',
                        output_index: 0,
                        item: {
                            type: 'message',
                            id: itemId,
                            role: 'assistant',
                            status: 'in_progress',
                            content: [{ type: 'output_text', text: '' }],
                        },
                    });
                }
                yield sseEvent('response.output_text.delta', {
                    type: 'response.output_text.delta',
                    item_id: itemId,
                    output_index: 0,
                    content_index: 0,
                    delta: event.data?.text || '',
                });
                break;
            }

            case 'tool_call_delta': {
                yield sseEvent('response.function_call_arguments.delta', {
                    type: 'response.function_call_arguments.delta',
                    item_id: event.data?.id || itemId,
                    output_index: event.data?.index ?? 0,
                    delta: event.data?.arguments || '',
                });
                break;
            }

            case 'usage': {
                // Responses API carries usage on the final completion frame; we
                // stash it and emit it at done time.
                break;
            }

            case 'done': {
                if (startedItem) {
                    yield sseEvent('response.output_item.done', {
                        type: 'response.output_item.done',
                        output_index: 0,
                        item: { id: itemId, status: 'completed' },
                    });
                }
                yield sseEvent('response.completed', {
                    type: 'response.completed',
                    response: {
                        id: requestId,
                        object: 'response',
                        status: 'completed',
                        model,
                    },
                });
                return;
            }

            case 'error': {
                yield sseEvent('response.failed', {
                    type: 'response.failed',
                    response: {
                        id: requestId,
                        object: 'response',
                        status: 'failed',
                        error: {
                            message:
                                event.error?.message ||
                                event.message ||
                                'stream error',
                            type: event.error?.type || 'api_error',
                        },
                    },
                });
                return;
            }
        }
    }

    yield sseEvent('response.completed', {
        type: 'response.completed',
        response: {
            id: requestId,
            object: 'response',
            status: 'completed',
            model,
        },
    });
}

// ── shared helpers ─────────────────────────────────────────────────────

function sseEvent(name, payload) {
    return `event: ${name}\ndata: ${JSON.stringify(payload)}\n\n`;
}
