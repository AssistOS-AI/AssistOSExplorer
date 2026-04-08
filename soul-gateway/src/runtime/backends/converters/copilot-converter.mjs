/**
 * GitHub Copilot format converter.
 *
 * Copilot exposes two endpoints:
 *   - /chat/completions (OpenAI-compatible — most models)
 *   - /models/{model}/responses (Responses API — select models)
 *
 * This converter handles routing logic and chunk normalization for both.
 */

// Models known to support the Responses API
const RESPONSES_API_MODELS = new Set([
    'o1-preview',
    'o1-mini',
    'o3-mini',
    'gpt-4.1',
    'gpt-4.1-mini',
    'gpt-4.1-nano',
]);

// ── Endpoint routing ────────────────────────────────────────────────

/**
 * Determine which Copilot endpoint to use for a given model.
 *
 * @param {string} modelId  The provider-side model identifier
 * @param {object} [providerRecord]  Provider record with optional settings
 * @returns {'completions'|'responses'}
 */
export function resolveEndpoint(modelId, providerRecord) {
    // Explicit override in provider settings
    const forceEndpoint = providerRecord?.settings?.force_endpoint;
    if (forceEndpoint === 'responses') return 'responses';
    if (forceEndpoint === 'completions') return 'completions';

    return RESPONSES_API_MODELS.has(modelId) ? 'responses' : 'completions';
}

// ── Request conversion ──────────────────────────────────────────────

/**
 * Convert a normalized request to a Copilot completions request body.
 * This is nearly pass-through since Copilot uses OpenAI chat format.
 *
 * @param {object} normalizedReq
 * @param {object} modelRecord
 * @param {object} _providerRecord
 * @returns {object} Request body for /chat/completions
 */
export function toCompletionsRequest(
    normalizedReq,
    modelRecord,
    _providerRecord
) {
    const body = {
        model: modelRecord.providerModelId || modelRecord.modelKey,
        messages: normalizedReq.messages || [],
        stream: normalizedReq.stream ?? true,
    };

    if (normalizedReq.max_tokens != null)
        body.max_tokens = normalizedReq.max_tokens;
    if (normalizedReq.temperature != null)
        body.temperature = normalizedReq.temperature;
    if (normalizedReq.top_p != null) body.top_p = normalizedReq.top_p;
    if (normalizedReq.stop != null) body.stop = normalizedReq.stop;
    if (normalizedReq.tools && normalizedReq.tools.length > 0)
        body.tools = normalizedReq.tools;
    if (normalizedReq.tool_choice != null)
        body.tool_choice = normalizedReq.tool_choice;

    return body;
}

/**
 * Convert a normalized request to a Copilot Responses API request body.
 *
 * @param {object} normalizedReq
 * @param {object} modelRecord
 * @param {object} _providerRecord
 * @returns {object} Request body for /models/{model}/responses
 */
export function toResponsesRequest(
    normalizedReq,
    modelRecord,
    _providerRecord
) {
    const model = modelRecord.providerModelId || modelRecord.modelKey;

    // The Responses API takes a flat input, not messages array
    const input = [];
    for (const msg of normalizedReq.messages || []) {
        input.push({
            role: msg.role,
            content:
                typeof msg.content === 'string'
                    ? msg.content
                    : Array.isArray(msg.content)
                      ? msg.content.map(formatResponsesContentPart)
                      : String(msg.content || ''),
        });
    }

    const body = {
        model,
        input,
        stream: normalizedReq.stream ?? true,
    };

    if (normalizedReq.max_tokens != null)
        body.max_output_tokens = normalizedReq.max_tokens;
    if (normalizedReq.temperature != null)
        body.temperature = normalizedReq.temperature;
    if (normalizedReq.top_p != null) body.top_p = normalizedReq.top_p;
    if (normalizedReq.tools && normalizedReq.tools.length > 0) {
        body.tools = normalizedReq.tools.map(convertToolForResponses);
    }

    return body;
}

/**
 * Build the Copilot request — auto-selects endpoint and returns both
 * the body and endpoint path.
 *
 * @param {object} normalizedReq
 * @param {object} modelRecord
 * @param {object} providerRecord
 * @returns {{ endpoint: string, body: object, path: string }}
 */
export function toProviderRequest(normalizedReq, modelRecord, providerRecord) {
    const modelId = modelRecord.providerModelId || modelRecord.modelKey;
    const endpoint = resolveEndpoint(modelId, providerRecord);

    if (endpoint === 'responses') {
        return {
            endpoint,
            body: toResponsesRequest(
                normalizedReq,
                modelRecord,
                providerRecord
            ),
            path: `/models/${modelId}/responses`,
        };
    }

    return {
        endpoint,
        body: toCompletionsRequest(normalizedReq, modelRecord, providerRecord),
        path: '/chat/completions',
    };
}

// ── Chunk conversion (completions) ──────────────────────────────────

/**
 * Convert a Copilot completions SSE chunk into NormalizedChunks.
 * Copilot completions uses standard OpenAI streaming format.
 *
 * @param {object} rawChunk  Parsed chunk data
 * @param {object} state     Mutable converter state
 * @returns {Array<import('../backend-interface.mjs').NormalizedChunk>}
 */
export function fromCompletionsChunk(rawChunk, state) {
    if (!state._initialized) {
        state._initialized = true;
        state.firstChunk = true;
        state.model = null;
    }

    const chunks = [];

    // [DONE] marker
    if (rawChunk === '[DONE]' || rawChunk?.done) {
        chunks.push({
            type: 'done',
            data: {
                finish_reason: state.lastFinishReason || 'stop',
                model: state.model,
            },
        });
        return chunks;
    }

    const id = rawChunk.id;
    const model = rawChunk.model;
    if (model) state.model = model;

    // Emit message_start on first data chunk
    if (state.firstChunk) {
        state.firstChunk = false;
        chunks.push({
            type: 'message_start',
            data: { id, model: state.model, role: 'assistant' },
        });
    }

    for (const choice of rawChunk.choices || []) {
        const delta = choice.delta || {};

        if (delta.content) {
            chunks.push({ type: 'text_delta', data: { text: delta.content } });
        }

        if (delta.tool_calls) {
            for (const tc of delta.tool_calls) {
                chunks.push({
                    type: 'tool_call_delta',
                    data: {
                        index: tc.index ?? 0,
                        id: tc.id || undefined,
                        name: tc.function?.name || undefined,
                        arguments: tc.function?.arguments || undefined,
                    },
                });
            }
        }

        if (choice.finish_reason) {
            state.lastFinishReason = choice.finish_reason;
        }
    }

    // Usage if present
    if (rawChunk.usage) {
        chunks.push({
            type: 'usage',
            data: {
                input_tokens: rawChunk.usage.prompt_tokens || 0,
                output_tokens: rawChunk.usage.completion_tokens || 0,
                total_tokens: rawChunk.usage.total_tokens || 0,
            },
        });
    }

    return chunks;
}

// ── Chunk conversion (responses) ────────────────────────────────────

/**
 * Convert a Copilot Responses API SSE chunk into NormalizedChunks.
 *
 * @param {object} rawChunk  Parsed Responses API event
 * @param {object} state     Mutable converter state
 * @returns {Array<import('../backend-interface.mjs').NormalizedChunk>}
 */
export function fromResponsesChunk(rawChunk, state) {
    if (!state._initialized) {
        state._initialized = true;
        state.firstChunk = true;
        state.model = null;
    }

    const chunks = [];
    const eventType = rawChunk.type || rawChunk.event;

    switch (eventType) {
        case 'response.created':
        case 'response.in_progress': {
            const resp = rawChunk.response || rawChunk;
            state.model = resp.model || state.model;
            if (state.firstChunk) {
                state.firstChunk = false;
                chunks.push({
                    type: 'message_start',
                    data: {
                        id: resp.id,
                        model: state.model,
                        role: 'assistant',
                    },
                });
            }
            break;
        }

        case 'response.output_text.delta': {
            const text = rawChunk.delta || '';
            if (text) {
                chunks.push({ type: 'text_delta', data: { text } });
            }
            break;
        }

        case 'response.function_call_arguments.delta': {
            chunks.push({
                type: 'tool_call_delta',
                data: {
                    index: rawChunk.output_index ?? 0,
                    arguments: rawChunk.delta || '',
                },
            });
            break;
        }

        case 'response.output_item.added': {
            const item = rawChunk.item || {};
            if (item.type === 'function_call') {
                chunks.push({
                    type: 'tool_call_delta',
                    data: {
                        index: rawChunk.output_index ?? 0,
                        id: item.call_id || item.id,
                        name: item.name,
                        arguments: '',
                    },
                });
            }
            break;
        }

        case 'response.completed': {
            const resp = rawChunk.response || {};
            if (resp.usage) {
                chunks.push({
                    type: 'usage',
                    data: {
                        input_tokens: resp.usage.input_tokens || 0,
                        output_tokens: resp.usage.output_tokens || 0,
                        total_tokens:
                            (resp.usage.input_tokens || 0) +
                            (resp.usage.output_tokens || 0),
                    },
                });
            }
            const reason =
                resp.status === 'completed' ? 'stop' : resp.status || 'stop';
            chunks.push({
                type: 'done',
                data: { finish_reason: reason, model: state.model },
            });
            break;
        }

        case 'error': {
            chunks.push({
                type: 'error',
                data: {
                    message:
                        rawChunk.error?.message ||
                        rawChunk.message ||
                        'Copilot Responses API error',
                    type: rawChunk.error?.type || 'api_error',
                },
            });
            break;
        }

        default:
            // Unknown event — skip for forward compat
            break;
    }

    return chunks;
}

/**
 * Route to the correct chunk converter based on endpoint.
 *
 * @param {object} rawChunk
 * @param {object} state
 * @param {'completions'|'responses'} endpoint
 * @returns {Array}
 */
export function fromProviderChunk(rawChunk, state, endpoint) {
    if (endpoint === 'responses') {
        return fromResponsesChunk(rawChunk, state);
    }
    return fromCompletionsChunk(rawChunk, state);
}

// ── Helpers ─────────────────────────────────────────────────────────

function formatResponsesContentPart(part) {
    if (part.type === 'text') return { type: 'input_text', text: part.text };
    if (part.type === 'image_url')
        return { type: 'input_image', image_url: part.image_url?.url || '' };
    return part;
}

function convertToolForResponses(tool) {
    const fn = tool.function || tool;
    return {
        type: 'function',
        name: fn.name,
        description: fn.description || '',
        parameters: fn.parameters || { type: 'object', properties: {} },
    };
}
