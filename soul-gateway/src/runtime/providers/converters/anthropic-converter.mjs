/**
 * Anthropic Messages API format converter.
 *
 * Converts between the internal OpenAI-chat normalized representation
 * and the Anthropic Messages API request/response shapes.
 */

// ── Request conversion ──────────────────────────────────────────────

/**
 * Convert a normalized (internal OpenAI-chat) request into an Anthropic
 * Messages API request body.
 *
 * @param {object} normalizedReq  Internal request representation
 * @param {object} modelRecord    Model registry record
 * @param {object} providerRecord Provider registry record
 * @returns {object} Anthropic-shaped request body
 */
export function toProviderRequest(normalizedReq, modelRecord, providerRecord) {
  const body = {
    model: modelRecord.provider_model_id || modelRecord.model_key,
    max_tokens: normalizedReq.max_tokens ?? modelRecord.default_max_tokens ?? 4096,
  };

  // Anthropic: system is a top-level string or array, not a message role
  const systemMessages = [];
  const conversationMessages = [];

  for (const msg of normalizedReq.messages || []) {
    if (msg.role === 'system') {
      systemMessages.push(extractTextContent(msg));
    } else {
      conversationMessages.push(convertMessage(msg));
    }
  }

  if (systemMessages.length > 0) {
    body.system = systemMessages.join('\n\n');
  }

  body.messages = conversationMessages;

  // Optional parameters
  if (normalizedReq.temperature != null) body.temperature = normalizedReq.temperature;
  if (normalizedReq.top_p != null) body.top_p = normalizedReq.top_p;
  if (normalizedReq.stop != null) body.stop_sequences = Array.isArray(normalizedReq.stop) ? normalizedReq.stop : [normalizedReq.stop];

  // Tools
  if (normalizedReq.tools && normalizedReq.tools.length > 0) {
    body.tools = normalizedReq.tools.map(convertToolDefinition);
  }

  // Streaming
  if (normalizedReq.stream) {
    body.stream = true;
  }

  // Provider-specific settings override
  const settings = providerRecord?.settings || {};
  if (settings.anthropic_version) {
    // handled in headers, not body
  }

  return body;
}

// ── Chunk conversion (streaming) ────────────────────────────────────

/**
 * Convert an Anthropic SSE event into zero or more NormalizedChunks.
 *
 * @param {object} rawChunk  Parsed Anthropic SSE event data
 * @param {object} state     Mutable converter state (tracks current block indices)
 * @returns {Array<import('../provider-interface.mjs').NormalizedChunk>}
 */
export function fromProviderChunk(rawChunk, state) {
  if (!state._initialized) {
    state._initialized = true;
    state.currentBlockIndex = -1;
    state.toolCallMap = new Map();
    state.messageId = null;
    state.model = null;
  }

  const chunks = [];
  const type = rawChunk.type;

  switch (type) {
    case 'message_start': {
      const msg = rawChunk.message || {};
      state.messageId = msg.id || null;
      state.model = msg.model || null;
      chunks.push({
        type: 'message_start',
        data: { id: msg.id, model: msg.model, role: msg.role || 'assistant' },
      });
      // Emit input usage if present
      if (msg.usage) {
        chunks.push({
          type: 'usage',
          data: {
            input_tokens: msg.usage.input_tokens || 0,
            output_tokens: 0,
            total_tokens: msg.usage.input_tokens || 0,
          },
        });
      }
      break;
    }

    case 'content_block_start': {
      state.currentBlockIndex = rawChunk.index ?? state.currentBlockIndex + 1;
      const block = rawChunk.content_block || {};
      if (block.type === 'tool_use') {
        state.toolCallMap.set(state.currentBlockIndex, {
          id: block.id,
          name: block.name,
          arguments: '',
        });
        chunks.push({
          type: 'tool_call_delta',
          data: { index: state.currentBlockIndex, id: block.id, name: block.name, arguments: '' },
        });
      }
      break;
    }

    case 'content_block_delta': {
      const delta = rawChunk.delta || {};
      const idx = rawChunk.index ?? state.currentBlockIndex;
      if (delta.type === 'text_delta') {
        chunks.push({ type: 'text_delta', data: { text: delta.text } });
      } else if (delta.type === 'input_json_delta') {
        const toolCall = state.toolCallMap.get(idx);
        if (toolCall) {
          toolCall.arguments += delta.partial_json || '';
        }
        chunks.push({
          type: 'tool_call_delta',
          data: { index: idx, arguments: delta.partial_json || '' },
        });
      }
      break;
    }

    case 'content_block_stop': {
      // No specific action needed — block completed
      break;
    }

    case 'message_delta': {
      const delta = rawChunk.delta || {};
      if (delta.stop_reason) {
        // Map Anthropic stop reasons to OpenAI finish reasons
        const finishReason = mapStopReason(delta.stop_reason);
        chunks.push({
          type: 'done',
          data: { finish_reason: finishReason, model: state.model },
        });
      }
      if (rawChunk.usage) {
        chunks.push({
          type: 'usage',
          data: {
            input_tokens: rawChunk.usage.input_tokens || 0,
            output_tokens: rawChunk.usage.output_tokens || 0,
            total_tokens: (rawChunk.usage.input_tokens || 0) + (rawChunk.usage.output_tokens || 0),
          },
        });
      }
      break;
    }

    case 'message_stop': {
      // Final event — if we haven't emitted done yet, emit it
      if (!chunks.some((c) => c.type === 'done')) {
        chunks.push({
          type: 'done',
          data: { finish_reason: 'stop', model: state.model },
        });
      }
      break;
    }

    case 'ping': {
      // keepalive — ignore
      break;
    }

    case 'error': {
      chunks.push({
        type: 'error',
        data: {
          message: rawChunk.error?.message || 'Unknown Anthropic error',
          type: rawChunk.error?.type || 'api_error',
        },
      });
      break;
    }

    default:
      // Unknown event type — silently ignore for forward compatibility
      break;
  }

  return chunks;
}

// ── Buffered (non-streaming) response conversion ────────────────────

/**
 * Convert a complete Anthropic Messages API response into a normalized
 * completion.
 *
 * @param {object} raw  Full Anthropic response body
 * @returns {object} Normalized completion
 */
export function toBufferedResponse(raw) {
  const content = [];
  let textContent = '';

  for (const block of raw.content || []) {
    if (block.type === 'text') {
      textContent += block.text;
      content.push({ type: 'text', text: block.text });
    } else if (block.type === 'tool_use') {
      content.push({
        type: 'tool_call',
        id: block.id,
        name: block.name,
        arguments: typeof block.input === 'string' ? block.input : JSON.stringify(block.input),
      });
    }
  }

  return {
    id: raw.id,
    model: raw.model,
    role: raw.role || 'assistant',
    content: textContent,
    tool_calls: content.filter((c) => c.type === 'tool_call').map((tc, i) => ({
      index: i,
      id: tc.id,
      type: 'function',
      function: { name: tc.name, arguments: tc.arguments },
    })),
    finish_reason: mapStopReason(raw.stop_reason),
    usage: {
      input_tokens: raw.usage?.input_tokens || 0,
      output_tokens: raw.usage?.output_tokens || 0,
      total_tokens: (raw.usage?.input_tokens || 0) + (raw.usage?.output_tokens || 0),
    },
  };
}

// ── Helpers ─────────────────────────────────────────────────────────

function extractTextContent(msg) {
  if (typeof msg.content === 'string') return msg.content;
  if (Array.isArray(msg.content)) {
    return msg.content
      .filter((part) => part.type === 'text')
      .map((part) => part.text)
      .join('\n');
  }
  return '';
}

function convertMessage(msg) {
  const result = { role: msg.role };

  if (typeof msg.content === 'string') {
    result.content = msg.content;
  } else if (Array.isArray(msg.content)) {
    result.content = msg.content.map(convertContentPart);
  }

  // Handle tool results for Anthropic
  if (msg.role === 'tool') {
    return {
      role: 'user',
      content: [{
        type: 'tool_result',
        tool_use_id: msg.tool_call_id,
        content: typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content),
      }],
    };
  }

  // Handle assistant tool_calls
  if (msg.tool_calls && msg.tool_calls.length > 0) {
    const parts = [];
    if (msg.content) {
      parts.push({ type: 'text', text: typeof msg.content === 'string' ? msg.content : '' });
    }
    for (const tc of msg.tool_calls) {
      parts.push({
        type: 'tool_use',
        id: tc.id,
        name: tc.function?.name || tc.name,
        input: safeParseJson(tc.function?.arguments || tc.arguments || '{}'),
      });
    }
    result.content = parts;
  }

  return result;
}

function convertContentPart(part) {
  if (part.type === 'text') return { type: 'text', text: part.text };
  if (part.type === 'image_url') {
    const url = part.image_url?.url || '';
    if (url.startsWith('data:')) {
      const match = url.match(/^data:([^;]+);base64,(.+)$/);
      if (match) {
        return {
          type: 'image',
          source: { type: 'base64', media_type: match[1], data: match[2] },
        };
      }
    }
    return { type: 'image', source: { type: 'url', url } };
  }
  return part;
}

function convertToolDefinition(tool) {
  const fn = tool.function || tool;
  return {
    name: fn.name,
    description: fn.description || '',
    input_schema: fn.parameters || { type: 'object', properties: {} },
  };
}

function mapStopReason(anthropicReason) {
  switch (anthropicReason) {
    case 'end_turn': return 'stop';
    case 'max_tokens': return 'length';
    case 'stop_sequence': return 'stop';
    case 'tool_use': return 'tool_calls';
    default: return anthropicReason || 'stop';
  }
}

function safeParseJson(str) {
  try { return JSON.parse(str); } catch { return {}; }
}
