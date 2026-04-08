/**
 * Egress format serialization.
 *
 * Converts internal completion results (OpenAI Chat Completions format)
 * back into the format the client expects based on the ingress route.
 *
 * Supports:
 *   - openai_chat:         pass through (already in correct format)
 *   - anthropic_messages:  convert to Anthropic Messages API shape
 *   - openai_responses:    convert to OpenAI Responses API shape
 */

/**
 * Serialize a buffered (non-streaming) completion into the client's expected format.
 *
 * @param {object} completion - internal completion object (OpenAI chat format)
 * @param {'openai_chat' | 'anthropic_messages' | 'openai_responses'} responseFormat
 * @param {string} requestId
 * @returns {object} serialized response body
 */
export function serializeBufferedResponse(
    completion,
    responseFormat,
    requestId
) {
    switch (responseFormat) {
        case 'openai_chat':
            return serializeOpenAiChat(completion, requestId);
        case 'anthropic_messages':
            return serializeAnthropicMessages(completion, requestId);
        case 'openai_responses':
            return serializeOpenAiResponses(completion, requestId);
        default:
            return serializeOpenAiChat(completion, requestId);
    }
}

/**
 * Serialize a single stream chunk into an SSE data line in the client's format.
 *
 * @param {object} chunk - internal stream chunk (OpenAI chat delta format)
 * @param {'openai_chat' | 'anthropic_messages' | 'openai_responses'} responseFormat
 * @param {string} requestId
 * @returns {string} serialized SSE data payload (JSON string)
 */
export function serializeStreamChunk(chunk, responseFormat, requestId) {
    switch (responseFormat) {
        case 'openai_chat':
            return JSON.stringify(serializeOpenAiStreamChunk(chunk, requestId));
        case 'anthropic_messages':
            return JSON.stringify(
                serializeAnthropicStreamChunk(chunk, requestId)
            );
        case 'openai_responses':
            return JSON.stringify(
                serializeResponsesStreamChunk(chunk, requestId)
            );
        default:
            return JSON.stringify(serializeOpenAiStreamChunk(chunk, requestId));
    }
}

// ── OpenAI Chat Completions ─────────────────────────────────────────

function serializeOpenAiChat(completion, requestId) {
    return {
        id: requestId,
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: completion.model || '',
        choices: (completion.choices || []).map((choice, idx) => ({
            index: idx,
            message: {
                role: choice.message?.role || 'assistant',
                content: choice.message?.content ?? null,
                ...(choice.message?.tool_calls
                    ? { tool_calls: choice.message.tool_calls }
                    : {}),
            },
            finish_reason: choice.finish_reason || null,
        })),
        usage: completion.usage || null,
    };
}

function serializeOpenAiStreamChunk(chunk, requestId) {
    return {
        id: requestId,
        object: 'chat.completion.chunk',
        created: Math.floor(Date.now() / 1000),
        model: chunk.model || '',
        choices: (chunk.choices || []).map((choice, idx) => ({
            index: idx,
            delta: choice.delta || {},
            finish_reason: choice.finish_reason || null,
        })),
        ...(chunk.usage ? { usage: chunk.usage } : {}),
    };
}

// ── Anthropic Messages ──────────────────────────────────────────────

function serializeAnthropicMessages(completion, requestId) {
    const choice = completion.choices?.[0];
    const message = choice?.message || {};
    const content = [];

    // Convert text content
    if (message.content) {
        content.push({ type: 'text', text: message.content });
    }

    // Convert tool_calls to tool_use blocks
    if (message.tool_calls) {
        for (const tc of message.tool_calls) {
            content.push({
                type: 'tool_use',
                id: tc.id,
                name: tc.function?.name || '',
                input: safeJsonParse(tc.function?.arguments),
            });
        }
    }

    return {
        id: requestId,
        type: 'message',
        role: 'assistant',
        model: completion.model || '',
        content,
        stop_reason: mapFinishReasonToAnthropicStop(choice?.finish_reason),
        stop_sequence: null,
        usage: completion.usage
            ? {
                  input_tokens: completion.usage.prompt_tokens || 0,
                  output_tokens: completion.usage.completion_tokens || 0,
              }
            : { input_tokens: 0, output_tokens: 0 },
    };
}

function serializeAnthropicStreamChunk(chunk, requestId) {
    const choice = chunk.choices?.[0];
    const delta = choice?.delta || {};

    // Anthropic stream events have different types depending on content
    if (choice?.finish_reason) {
        return {
            type: 'message_delta',
            delta: {
                stop_reason: mapFinishReasonToAnthropicStop(
                    choice.finish_reason
                ),
                stop_sequence: null,
            },
            usage: chunk.usage
                ? {
                      output_tokens: chunk.usage.completion_tokens || 0,
                  }
                : {},
        };
    }

    if (delta.tool_calls) {
        const tc = delta.tool_calls[0];
        return {
            type: 'content_block_delta',
            index: tc.index || 0,
            delta: {
                type: 'input_json_delta',
                partial_json: tc.function?.arguments || '',
            },
        };
    }

    if (delta.content) {
        return {
            type: 'content_block_delta',
            index: 0,
            delta: {
                type: 'text_delta',
                text: delta.content,
            },
        };
    }

    // Fallback: empty delta
    return {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: '' },
    };
}

function mapFinishReasonToAnthropicStop(reason) {
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

// ── OpenAI Responses API ────────────────────────────────────────────

function serializeOpenAiResponses(completion, requestId) {
    const choice = completion.choices?.[0];
    const message = choice?.message || {};
    const output = [];

    // Build output items
    if (message.content) {
        output.push({
            type: 'message',
            id: `msg_${requestId}`,
            role: 'assistant',
            status: 'completed',
            content: [{ type: 'output_text', text: message.content }],
        });
    }

    if (message.tool_calls) {
        for (const tc of message.tool_calls) {
            output.push({
                type: 'function_call',
                id: tc.id,
                call_id: tc.id,
                name: tc.function?.name || '',
                arguments: tc.function?.arguments || '{}',
                status: 'completed',
            });
        }
    }

    return {
        id: requestId,
        object: 'response',
        created_at: Math.floor(Date.now() / 1000),
        model: completion.model || '',
        status: 'completed',
        output,
        usage: completion.usage
            ? {
                  input_tokens: completion.usage.prompt_tokens || 0,
                  output_tokens: completion.usage.completion_tokens || 0,
                  total_tokens:
                      (completion.usage.prompt_tokens || 0) +
                      (completion.usage.completion_tokens || 0),
              }
            : null,
    };
}

function serializeResponsesStreamChunk(chunk, requestId) {
    const choice = chunk.choices?.[0];
    const delta = choice?.delta || {};

    if (choice?.finish_reason) {
        return {
            type: 'response.completed',
            response: {
                id: requestId,
                object: 'response',
                status: 'completed',
            },
        };
    }

    if (delta.content) {
        return {
            type: 'response.output_text.delta',
            delta: delta.content,
            item_id: `msg_${requestId}`,
            output_index: 0,
            content_index: 0,
        };
    }

    // Fallback
    return {
        type: 'response.output_text.delta',
        delta: '',
        item_id: `msg_${requestId}`,
        output_index: 0,
        content_index: 0,
    };
}

// ── Helpers ─────────────────────────────────────────────────────────

function safeJsonParse(str) {
    if (typeof str !== 'string') return str || {};
    try {
        return JSON.parse(str);
    } catch {
        return {};
    }
}
