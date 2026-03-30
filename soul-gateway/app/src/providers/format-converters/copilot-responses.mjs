import { createLogger } from '../../utils/logger.mjs';

const log = createLogger('copilot-responses');

// ---- Endpoint cache: model -> 'completions' | 'responses' ----

const endpointCache = new Map();

function getEndpointForModel(modelId) {
  if (endpointCache.has(modelId)) return endpointCache.get(modelId);
  // Models containing 'codex' need the Responses API
  if (modelId.toLowerCase().includes('codex')) return 'responses';
  return 'completions';
}

function cacheEndpoint(modelId, endpoint) {
  endpointCache.set(modelId, endpoint);
}

// ---- SSE parsing (self-contained, zero deps) ----

/**
 * Parse an SSE stream from a fetch Response body.
 * Yields parsed JSON objects from `data:` lines.
 * Standard OpenAI format: no named events, just `data:` lines.
 */
async function* parseCompletionsSSE(body) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      const parts = buffer.split('\n\n');
      buffer = parts.pop();

      for (const part of parts) {
        if (!part.trim()) continue;

        let data = '';
        for (const line of part.split('\n')) {
          if (line.startsWith('data: ')) data += line.slice(6);
          else if (line.startsWith('data:')) data += line.slice(5);
        }

        if (!data || data.trim() === '[DONE]') continue;

        try {
          yield JSON.parse(data);
        } catch {
          log.warn('Malformed completions SSE JSON', { data: data.slice(0, 200) });
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}

/**
 * Parse an SSE stream with named events (Responses API format).
 * Yields { event, parsedData } for each frame.
 * The Responses API uses event-based completion (response.completed), not [DONE].
 */
async function* parseResponsesSSE(body) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      const frames = buffer.split('\n\n');
      buffer = frames.pop();

      for (const rawFrame of frames) {
        if (!rawFrame.trim()) continue;

        let event = '';
        const dataLines = [];

        for (const line of rawFrame.split('\n')) {
          if (line.startsWith(':')) continue;
          const colonIdx = line.indexOf(':');
          if (colonIdx === -1) continue;

          const field = line.slice(0, colonIdx);
          let value = line.slice(colonIdx + 1);
          if (value.startsWith(' ')) value = value.slice(1);

          if (field === 'event') event = value;
          else if (field === 'data') dataLines.push(value);
        }

        const data = dataLines.join('\n');
        let parsedData = null;
        if (data) {
          try { parsedData = JSON.parse(data); } catch {}
        }

        if (event || parsedData) {
          yield { event, parsedData };
        }
      }
    }

    // Flush remaining buffer
    if (buffer.trim()) {
      let event = '';
      const dataLines = [];

      for (const line of buffer.split('\n')) {
        if (line.startsWith(':')) continue;
        const colonIdx = line.indexOf(':');
        if (colonIdx === -1) continue;

        const field = line.slice(0, colonIdx);
        let value = line.slice(colonIdx + 1);
        if (value.startsWith(' ')) value = value.slice(1);

        if (field === 'event') event = value;
        else if (field === 'data') dataLines.push(value);
      }

      const data = dataLines.join('\n');
      let parsedData = null;
      if (data) {
        try { parsedData = JSON.parse(data); } catch {}
      }

      if (event || parsedData) {
        yield { event, parsedData };
      }
    }
  } finally {
    reader.releaseLock();
  }
}

// ---- Payload conversion: Chat Completions -> Responses API ----

const ROLE_MAP = { system: 'developer', user: 'user', assistant: 'assistant' };

function convertToResponsesPayload(chatPayload) {
  const { messages, max_tokens, stream, ...rest } = chatPayload;

  // Extract system messages as instructions (required by Codex Responses API)
  const systemMessages = messages.filter(m => m.role === 'system');
  const nonSystemMessages = messages.filter(m => m.role !== 'system');

  const input = nonSystemMessages.map(msg => ({
    role: ROLE_MAP[msg.role] || 'user',
    content: msg.content,
  }));

  const instructions = systemMessages.map(m =>
    typeof m.content === 'string' ? m.content : JSON.stringify(m.content)
  ).join('\n\n');

  const payload = { ...rest, input, instructions: instructions || '', stream: true, store: false };
  if (max_tokens !== undefined) {
    payload.max_output_tokens = max_tokens;
  }
  return payload;
}

// ---- Completions streaming -> typed chunks ----

/**
 * Stream from the standard /chat/completions endpoint.
 * Yields the same typed chunks as fetchLLMStreaming.
 */
async function* streamCompletions(baseUrl, payload, headers, signal) {
  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ ...payload, stream: true }),
    signal,
  });

  // Detect unsupported_api_for_model before streaming
  if (response.status === 400) {
    const data = await response.json().catch(() => null);
    const errorMsg = data?.error?.message || data?.message || '';
    if (errorMsg.includes('unsupported_api_for_model')) {
      const err = new Error('unsupported_api_for_model');
      err.code = 'UNSUPPORTED_API_FOR_MODEL';
      throw err;
    }
    throw new Error(`API Error (${response.status}): ${JSON.stringify(data)}`);
  }

  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(`API Error (${response.status}): ${errorBody}`);
  }

  let fullText = '';
  const toolCallAccum = [];
  let usage = null;
  let stopReason = null;

  try {
    for await (const data of parseCompletionsSSE(response.body)) {
      if (data.error) {
        yield { type: 'error', error: new Error(`API Error: ${JSON.stringify(data.error)}`) };
        return;
      }

      if (data.usage) {
        usage = data.usage;
      }

      const choice = data.choices?.[0];
      if (!choice) continue;

      if (choice.finish_reason) {
        stopReason = choice.finish_reason;
      }

      const delta = choice.delta;
      if (!delta) continue;

      // Content delta
      if (typeof delta.content === 'string' && delta.content.length > 0) {
        fullText += delta.content;
        yield { type: 'text_delta', text: delta.content };
      }

      // Tool calls delta
      if (Array.isArray(delta.tool_calls)) {
        for (const tc of delta.tool_calls) {
          const idx = tc.index ?? 0;
          if (!toolCallAccum[idx]) {
            toolCallAccum[idx] = {
              id: tc.id || '',
              type: tc.type || 'function',
              function: { name: tc.function?.name || '', arguments: '' },
            };
          } else {
            if (tc.id) toolCallAccum[idx].id = tc.id;
            if (tc.function?.name) toolCallAccum[idx].function.name = tc.function.name;
          }
          if (tc.function?.arguments) {
            toolCallAccum[idx].function.arguments += tc.function.arguments;
          }
        }
        yield { type: 'tool_calls_delta', toolCalls: delta.tool_calls };
      }
    }
  } catch (err) {
    yield { type: 'error', error: err };
    return;
  }

  const toolCalls = toolCallAccum.filter(Boolean);

  yield {
    type: 'done',
    fullText,
    toolCalls: toolCalls.length > 0 ? toolCalls : null,
    usage,
    stopReason: stopReason || 'stop',
  };
}

// ---- Responses API streaming -> typed chunks ----

/**
 * Stream from the Responses API (/responses), converting events back
 * to the typed chunk format expected by stream-tap / fetchLLMStreaming.
 */
async function* streamResponses(baseUrl, messages, payload, headers, signal) {
  const responsesPayload = convertToResponsesPayload(payload);

  const response = await fetch(`${baseUrl}/responses`, {
    method: 'POST',
    headers,
    body: JSON.stringify(responsesPayload),
    signal,
  });

  // Detect unsupported_api_for_model on responses endpoint too
  if (response.status === 400) {
    const data = await response.json().catch(() => null);
    const errorMsg = data?.error?.message || data?.message || '';
    if (errorMsg.includes('unsupported_api_for_model')) {
      const err = new Error('unsupported_api_for_model');
      err.code = 'UNSUPPORTED_API_FOR_MODEL';
      throw err;
    }
    throw new Error(`API Error (${response.status}): ${JSON.stringify(data)}`);
  }

  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(`API Error (${response.status}): ${errorBody}`);
  }

  let fullText = '';
  let usage = null;
  let stopReason = null;
  const toolCallAccum = []; // accumulate function calls by index

  try {
    for await (const { event, parsedData } of parseResponsesSSE(response.body)) {
      // Text content delta
      if (event === 'response.output_text.delta') {
        const text = parsedData?.delta || '';
        if (text) {
          fullText += text;
          yield { type: 'text_delta', text };
        }
        continue;
      }

      // Function call arguments delta — accumulate tool call arguments
      if (event === 'response.function_call_arguments.delta') {
        const delta = parsedData?.delta || '';
        const itemId = parsedData?.item_id || '';
        const outputIdx = parsedData?.output_index ?? 0;
        if (!toolCallAccum[outputIdx]) {
          toolCallAccum[outputIdx] = { id: itemId, type: 'function', function: { name: '', arguments: '' } };
        }
        toolCallAccum[outputIdx].function.arguments += delta;
        continue;
      }

      // Output item done — captures function call name and final state
      if (event === 'response.output_item.done') {
        const item = parsedData?.item;
        if (item?.type === 'function_call') {
          const outputIdx = parsedData?.output_index ?? toolCallAccum.length;
          toolCallAccum[outputIdx] = {
            id: item.call_id || item.id || '',
            type: 'function',
            function: {
              name: item.name || '',
              arguments: item.arguments || toolCallAccum[outputIdx]?.function?.arguments || '',
            },
          };
          // Yield tool_calls_delta chunk
          yield {
            type: 'tool_calls_delta',
            toolCalls: [{ index: outputIdx, ...toolCallAccum[outputIdx] }],
          };
        }
        continue;
      }

      // Response completed — extract usage and determine stop reason
      if (event === 'response.completed') {
        const resp = parsedData?.response;
        const respUsage = resp?.usage;
        if (respUsage) {
          const promptTokens = respUsage.input_tokens || 0;
          const completionTokens = respUsage.output_tokens || 0;
          usage = {
            prompt_tokens: promptTokens,
            completion_tokens: completionTokens,
            total_tokens: promptTokens + completionTokens,
          };
        }
        // Detect tool use from response output items
        const hasToolCalls = resp?.output?.some(item => item.type === 'function_call');
        stopReason = hasToolCalls ? 'tool_calls' : (resp?.status === 'completed' ? 'stop' : 'stop');
        continue;
      }

      // Error events
      if (event === 'response.failed' || event === 'error') {
        const errorMsg = parsedData?.error?.message || parsedData?.message || 'Unknown Copilot error';
        yield { type: 'error', error: new Error(errorMsg) };
        return;
      }

      // Other Responses API events (response.created, response.output_item.added,
      // response.content_part.added, response.output_text.done, etc.) — skip silently.
    }
  } catch (err) {
    yield { type: 'error', error: err };
    return;
  }

  const toolCalls = toolCallAccum.filter(Boolean);

  yield {
    type: 'done',
    fullText,
    toolCalls: toolCalls.length > 0 ? toolCalls : null,
    usage,
    stopReason: stopReason || (toolCalls.length > 0 ? 'tool_calls' : 'stop'),
  };
}

// ---- Main dispatch ----

export default {
  name: 'copilot-responses',

  /**
   * Dispatch a request to the Copilot API with smart endpoint routing.
   *
   * Tries the cached endpoint first (completions by default). If the model
   * returns `unsupported_api_for_model`, falls back to the other endpoint
   * and caches the result for future requests.
   *
   * @param {Array} messages - Chat messages array
   * @param {object} payload - Full request payload (model, messages, params)
   * @param {string} baseUrl - Copilot API base URL (e.g. 'https://api.githubcopilot.com')
   * @param {object} headers - Pre-built Copilot headers from adapter.getHeaders()
   * @param {AbortSignal} [signal] - Optional abort signal
   * @yields {{ type: 'text_delta', text } | { type: 'tool_calls_delta', toolCalls } |
   *          { type: 'done', fullText, toolCalls, usage, stopReason } |
   *          { type: 'error', error }}
   */
  async* dispatch(messages, payload, baseUrl, headers, signal) {
    const model = payload.model;
    const preferredEndpoint = getEndpointForModel(model);

    // First attempt: try the preferred endpoint
    try {
      if (preferredEndpoint === 'responses') {
        log.debug('Using Responses API for model', { model });
        yield* streamResponses(baseUrl, messages, payload, headers, signal);
        cacheEndpoint(model, 'responses');
        return;
      }

      log.debug('Using Completions API for model', { model });
      yield* streamCompletions(baseUrl, payload, headers, signal);
      cacheEndpoint(model, 'completions');
      return;
    } catch (err) {
      if (err.code !== 'UNSUPPORTED_API_FOR_MODEL') {
        throw err;
      }
      log.info('Model needs alternate endpoint, falling back', {
        model,
        tried: preferredEndpoint,
        fallback: preferredEndpoint === 'completions' ? 'responses' : 'completions',
      });
    }

    // Fallback: try the other endpoint
    if (preferredEndpoint === 'completions') {
      cacheEndpoint(model, 'responses');
      yield* streamResponses(baseUrl, messages, payload, headers, signal);
    } else {
      cacheEndpoint(model, 'completions');
      yield* streamCompletions(baseUrl, payload, headers, signal);
    }
  },
};
