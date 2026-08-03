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

/**
 * Serialize a terminal stream error using the same route-specific wire
 * format that the normal streaming path emits for canonical `error`
 * events.
 *
 * @param {'openai_chat'|'anthropic_messages'|'openai_responses'} routeKind
 * @param {string} requestId
 * @param {{ message?: string, errorType?: string }} err
 * @returns {string}
 */
export function serializeSseError(routeKind, requestId, err) {
    if (routeKind === 'anthropic_messages') {
        return sseEvent('error', {
            type: 'error',
            error: {
                type: err.errorType || 'api_error',
                message: err.message || 'stream error',
            },
        });
    }

    if (routeKind === 'openai_responses') {
        return sseEvent('response.failed', {
            type: 'response.failed',
            sequence_number: Number.isInteger(err.sequenceNumber)
                ? err.sequenceNumber
                : 0,
            response: {
                id: requestId,
                object: 'response',
                status: 'failed',
                output: [],
                error: {
                    message: err.message || 'stream error',
                    type: err.errorType || 'api_error',
                },
            },
        });
    }

    return `data: ${JSON.stringify({
        error: {
            message: err.message || 'stream error',
            type: err.errorType || 'stream_error',
        },
    })}\n\n`;
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
                yield serializeSseError('openai_chat', requestId, {
                    message:
                        event.error?.message ||
                        event.message ||
                        'stream error',
                    errorType: event.error?.type || event.type || 'stream_error',
                });
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
                yield serializeSseError('anthropic_messages', requestId, {
                    message:
                        event.error?.message ||
                        event.message ||
                        'stream error',
                    errorType: event.error?.type || 'api_error',
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
    const createdAt = Math.floor(Date.now() / 1000);
    let sequenceNumber = 0;
    let responseStarted = false;
    let textState = null;
    const toolStates = new Map();
    const outputStates = [];
    let usage = { input_tokens: 0, output_tokens: 0, total_tokens: 0 };

    const emit = (name, payload = {}) =>
        sseEvent(name, {
            type: name,
            ...payload,
            sequence_number: sequenceNumber++,
        });

    const completedUsage = () => ({
        input_tokens: usage.input_tokens,
        input_tokens_details: { cached_tokens: 0 },
        output_tokens: usage.output_tokens,
        output_tokens_details: { reasoning_tokens: 0 },
        total_tokens:
            usage.total_tokens || usage.input_tokens + usage.output_tokens,
    });

    const completedItem = (state) => {
        if (state.kind === 'text') {
            return {
                id: state.itemId,
                type: 'message',
                status: 'completed',
                role: 'assistant',
                content: [
                    {
                        type: 'output_text',
                        text: state.text,
                        annotations: [],
                    },
                ],
            };
        }
        return {
            id: state.itemId,
            type: 'function_call',
            status: 'completed',
            arguments: state.arguments,
            call_id: state.callId,
            name: state.name,
        };
    };

    const responseObject = (status) => ({
        id: requestId,
        object: 'response',
        created_at: createdAt,
        ...(status === 'completed'
            ? { completed_at: Math.floor(Date.now() / 1000) }
            : {}),
        status,
        error: null,
        incomplete_details: null,
        model: model || '',
        output:
            status === 'completed' ? outputStates.map(completedItem) : [],
        parallel_tool_calls: false,
        metadata: {},
        usage: status === 'completed' ? completedUsage() : null,
    });

    const startResponseFrames = () => {
        if (responseStarted) return [];
        responseStarted = true;
        return [
            emit('response.created', {
                response: responseObject('in_progress'),
            }),
            emit('response.in_progress', {
                response: responseObject('in_progress'),
            }),
        ];
    };

    const finishFrames = () => {
        const frames = [];
        for (const state of outputStates) {
            if (state.kind === 'text') {
                const part = {
                    type: 'output_text',
                    text: state.text,
                    annotations: [],
                };
                frames.push(
                    emit('response.output_text.done', {
                        item_id: state.itemId,
                        output_index: state.outputIndex,
                        content_index: 0,
                        text: state.text,
                        logprobs: [],
                    }),
                    emit('response.content_part.done', {
                        item_id: state.itemId,
                        output_index: state.outputIndex,
                        content_index: 0,
                        part,
                    })
                );
            } else {
                frames.push(
                    emit('response.function_call_arguments.done', {
                        item_id: state.itemId,
                        output_index: state.outputIndex,
                        name: state.name,
                        arguments: state.arguments,
                    })
                );
            }
            frames.push(
                emit('response.output_item.done', {
                    output_index: state.outputIndex,
                    item: completedItem(state),
                })
            );
        }
        frames.push(
            emit('response.completed', {
                response: responseObject('completed'),
            })
        );
        return frames;
    };

    for await (const event of stream) {
        switch (event.type) {
            case 'message_start': {
                model = event.data?.model || model;
                for (const frame of startResponseFrames()) yield frame;
                break;
            }

            case 'text_delta': {
                for (const frame of startResponseFrames()) yield frame;
                if (!textState) {
                    textState = {
                        kind: 'text',
                        itemId: `msg_${requestId}`,
                        outputIndex: outputStates.length,
                        text: '',
                    };
                    outputStates.push(textState);
                    yield emit('response.output_item.added', {
                        output_index: textState.outputIndex,
                        item: {
                            type: 'message',
                            id: textState.itemId,
                            role: 'assistant',
                            status: 'in_progress',
                            content: [],
                        },
                    });
                    yield emit('response.content_part.added', {
                        item_id: textState.itemId,
                        output_index: textState.outputIndex,
                        content_index: 0,
                        part: {
                            type: 'output_text',
                            text: '',
                            annotations: [],
                        },
                    });
                }
                const delta = event.data?.text || '';
                textState.text += delta;
                yield emit('response.output_text.delta', {
                    item_id: textState.itemId,
                    output_index: textState.outputIndex,
                    content_index: 0,
                    delta,
                    logprobs: [],
                });
                break;
            }

            case 'tool_call_delta': {
                for (const frame of startResponseFrames()) yield frame;
                const canonicalIndex = event.data?.index ?? 0;
                let state = toolStates.get(canonicalIndex);
                if (!state) {
                    state = {
                        kind: 'tool',
                        itemId: `fc_${requestId}_${canonicalIndex}`,
                        outputIndex: outputStates.length,
                        callId:
                            event.data?.id ||
                            `call_${requestId}_${canonicalIndex}`,
                        name: event.data?.name || '',
                        arguments: '',
                    };
                    toolStates.set(canonicalIndex, state);
                    outputStates.push(state);
                    yield emit('response.output_item.added', {
                        output_index: state.outputIndex,
                        item: {
                            id: state.itemId,
                            type: 'function_call',
                            status: 'in_progress',
                            arguments: '',
                            call_id: state.callId,
                            name: state.name,
                        },
                    });
                }
                if (event.data?.id) state.callId = event.data.id;
                if (event.data?.name) state.name = event.data.name;
                const delta = event.data?.arguments || '';
                state.arguments += delta;
                yield emit('response.function_call_arguments.delta', {
                    item_id: state.itemId,
                    output_index: state.outputIndex,
                    delta,
                });
                break;
            }

            case 'usage': {
                usage = {
                    input_tokens: event.data?.input_tokens || 0,
                    output_tokens: event.data?.output_tokens || 0,
                    total_tokens: event.data?.total_tokens || 0,
                };
                break;
            }

            case 'done': {
                model = event.data?.model || model;
                for (const frame of startResponseFrames()) yield frame;
                for (const frame of finishFrames()) yield frame;
                return;
            }

            case 'error': {
                yield serializeSseError('openai_responses', requestId, {
                    message:
                        event.error?.message ||
                        event.message ||
                        'stream error',
                    errorType: event.error?.type || 'api_error',
                    sequenceNumber,
                });
                return;
            }
        }
    }

    for (const frame of startResponseFrames()) yield frame;
    for (const frame of finishFrames()) yield frame;
}

// ── shared helpers ─────────────────────────────────────────────────────

function sseEvent(name, payload) {
    return `event: ${name}\ndata: ${JSON.stringify(payload)}\n\n`;
}
