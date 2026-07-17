/**
 * Kiro (AWS) binary event-stream format converter.
 *
 * Kiro uses a binary event-stream protocol with a conversationState
 * payload.  This converter handles:
 *   - Building the conversationState from normalized requests
 *   - Parsing binary event-stream frames into NormalizedChunks
 */

// ── Request conversion ──────────────────────────────────────────────

/**
 * Convert a normalized request into a Kiro conversationState payload.
 *
 * @param {object} normalizedReq
 * @param {object} modelRecord
 * @param {object} providerRecord
 * @returns {object} Kiro-shaped request body
 */
export function toProviderRequest(normalizedReq, modelRecord, providerRecord) {
    const modelId = modelRecord.providerModelId || modelRecord.modelKey;

    const turns = [];
    const systemInstructions = [];

    for (const msg of normalizedReq.messages || []) {
        if (msg.role === 'system') {
            const systemInstruction =
                typeof msg.content === 'string'
                    ? msg.content
                    : extractText(msg.content);
            if (systemInstruction) {
                systemInstructions.push(systemInstruction);
            }
            continue;
        }

        turns.push({
            role: mapRoleToKiro(msg.role),
            content: convertContent(msg),
        });
    }

    const body = {
        modelId,
        conversationState: {
            turns,
        },
        inferenceConfig: {},
    };

    if (systemInstructions.length) {
        body.conversationState.systemInstruction = systemInstructions.join('\n');
    }

    if (normalizedReq.max_tokens != null) {
        body.inferenceConfig.maxTokens = normalizedReq.max_tokens;
    }
    if (normalizedReq.temperature != null) {
        body.inferenceConfig.temperature = normalizedReq.temperature;
    }
    if (normalizedReq.top_p != null) {
        body.inferenceConfig.topP = normalizedReq.top_p;
    }
    if (normalizedReq.stop != null) {
        body.inferenceConfig.stopSequences = Array.isArray(normalizedReq.stop)
            ? normalizedReq.stop
            : [normalizedReq.stop];
    }

    // Tools
    if (normalizedReq.tools && normalizedReq.tools.length > 0) {
        body.toolConfig = {
            tools: normalizedReq.tools.map(convertToolDef),
        };
    }

    // Provider-level settings
    const settings = providerRecord?.settings || {};
    if (settings.kiro_region) body.region = settings.kiro_region;

    return body;
}

// ── Binary event-stream parsing ─────────────────────────────────────

/**
 * Parse a binary event-stream frame buffer into a structured event.
 *
 * AWS event-stream binary protocol:
 *   [4 bytes total_length] [4 bytes headers_length] [4 bytes prelude CRC]
 *   [headers...] [payload...] [4 bytes message CRC]
 *
 * @param {Buffer} buffer  Raw frame bytes
 * @returns {{ headers: object, payload: object|string }|null}
 */
export function parseBinaryFrame(buffer) {
    if (!buffer || buffer.length < 16) return null;

    const totalLength = buffer.readUInt32BE(0);
    const headersLength = buffer.readUInt32BE(4);
    // Skip prelude CRC at offset 8 (4 bytes)

    const headersStart = 12;
    const headersEnd = headersStart + headersLength;
    const payloadStart = headersEnd;
    const payloadEnd = totalLength - 4; // exclude message CRC

    // Parse headers
    const headers = {};
    let pos = headersStart;
    while (pos < headersEnd) {
        const nameLen = buffer.readUInt8(pos);
        pos += 1;
        const name = buffer.toString('utf8', pos, pos + nameLen);
        pos += nameLen;
        const headerType = buffer.readUInt8(pos);
        pos += 1;

        if (headerType === 7) {
            // String type
            const valLen = buffer.readUInt16BE(pos);
            pos += 2;
            headers[name] = buffer.toString('utf8', pos, pos + valLen);
            pos += valLen;
        } else {
            // Skip unsupported header types — advance best-effort
            break;
        }
    }

    // Parse payload
    let payload;
    const payloadBytes = buffer.subarray(payloadStart, payloadEnd);
    if (payloadBytes.length > 0) {
        try {
            payload = JSON.parse(payloadBytes.toString('utf8'));
        } catch {
            payload = payloadBytes.toString('utf8');
        }
    } else {
        payload = null;
    }

    return { headers, payload };
}

// ── Chunk conversion ────────────────────────────────────────────────

/**
 * Convert a parsed Kiro event into NormalizedChunks.
 *
 * @param {object} rawChunk  Parsed event ({ headers, payload } or plain JSON)
 * @param {object} state     Mutable converter state
 * @returns {Array<import('../backend-interface.mjs').NormalizedChunk>}
 */
export function fromProviderChunk(rawChunk, state) {
    if (!state._initialized) {
        state._initialized = true;
        state.firstChunk = true;
        state.model = null;
        state.toolIndex = 0;
    }

    const chunks = [];

    // Handle both parsed binary frames and plain JSON events
    const event = rawChunk.payload || rawChunk;
    const eventType =
        rawChunk.headers?.[':event-type'] || event.type || event.event;

    switch (eventType) {
        case 'messageStart':
        case 'message_start': {
            state.model = event.model || event.modelId || state.model;
            if (state.firstChunk) {
                state.firstChunk = false;
                chunks.push({
                    type: 'message_start',
                    data: {
                        id: event.id || event.messageId || null,
                        model: state.model,
                        role: event.role || 'assistant',
                    },
                });
            }
            break;
        }

        case 'contentBlockStart':
        case 'content_block_start': {
            const block = event.contentBlock || event.content_block || {};
            if (block.type === 'tool_use' || block.toolUse) {
                const tu = block.toolUse || block;
                chunks.push({
                    type: 'tool_call_delta',
                    data: {
                        index: state.toolIndex++,
                        id: tu.toolUseId || tu.id,
                        name: tu.name,
                        arguments: '',
                    },
                });
            }
            break;
        }

        case 'contentBlockDelta':
        case 'content_block_delta': {
            const delta = event.delta || {};
            if (delta.type === 'text_delta' || delta.text != null) {
                chunks.push({
                    type: 'text_delta',
                    data: { text: delta.text || '' },
                });
            } else if (delta.type === 'tool_use' || delta.toolUse) {
                const tu = delta.toolUse || delta;
                chunks.push({
                    type: 'tool_call_delta',
                    data: {
                        index: state.toolIndex > 0 ? state.toolIndex - 1 : 0,
                        arguments: tu.input || '',
                    },
                });
            }
            break;
        }

        case 'contentBlockStop':
        case 'content_block_stop': {
            // Block done
            break;
        }

        case 'messageStop':
        case 'message_stop': {
            const reason = event.stopReason || event.stop_reason || 'stop';
            chunks.push({
                type: 'done',
                data: {
                    finish_reason: mapKiroStopReason(reason),
                    model: state.model,
                },
            });
            break;
        }

        case 'metadata': {
            const usage = event.usage || event.metrics;
            if (usage) {
                chunks.push({
                    type: 'usage',
                    data: {
                        input_tokens:
                            usage.inputTokens || usage.input_tokens || 0,
                        output_tokens:
                            usage.outputTokens || usage.output_tokens || 0,
                        total_tokens:
                            (usage.inputTokens || usage.input_tokens || 0) +
                            (usage.outputTokens || usage.output_tokens || 0),
                    },
                });
            }
            break;
        }

        case 'error':
        case 'exception': {
            chunks.push({
                type: 'error',
                data: {
                    message:
                        event.message || event.error?.message || 'Kiro error',
                    type: event.code || event.error?.code || 'provider_error',
                },
            });
            break;
        }

        default:
            break;
    }

    return chunks;
}

// ── Helpers ─────────────────────────────────────────────────────────

function mapRoleToKiro(role) {
    switch (role) {
        case 'assistant':
            return 'assistant';
        case 'user':
            return 'user';
        case 'tool':
            return 'user'; // tool results sent as user turns in Kiro
        default:
            return 'user';
    }
}

function convertContent(msg) {
    if (typeof msg.content === 'string') {
        return [{ text: msg.content }];
    }
    if (Array.isArray(msg.content)) {
        return msg.content.map((part) => {
            if (part.type === 'text') return { text: part.text };
            if (part.type === 'image_url') {
                return { image: { source: { url: part.image_url?.url } } };
            }
            return { text: JSON.stringify(part) };
        });
    }
    // Tool results
    if (msg.role === 'tool') {
        return [
            {
                toolResult: {
                    toolUseId: msg.tool_call_id,
                    content: [
                        {
                            text:
                                typeof msg.content === 'string'
                                    ? msg.content
                                    : JSON.stringify(msg.content),
                        },
                    ],
                },
            },
        ];
    }
    return [{ text: String(msg.content || '') }];
}

function convertToolDef(tool) {
    const fn = tool.function || tool;
    return {
        toolSpec: {
            name: fn.name,
            description: fn.description || '',
            inputSchema: {
                json: fn.parameters || { type: 'object', properties: {} },
            },
        },
    };
}

function mapKiroStopReason(reason) {
    switch (reason) {
        case 'end_turn':
            return 'stop';
        case 'max_tokens':
            return 'length';
        case 'stop_sequence':
            return 'stop';
        case 'tool_use':
            return 'tool_calls';
        default:
            return reason || 'stop';
    }
}

function extractText(content) {
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
        return content
            .filter((p) => p.type === 'text')
            .map((p) => p.text)
            .join('\n');
    }
    return String(content || '');
}
