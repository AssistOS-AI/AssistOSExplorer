import { createLogger } from '../utils/logger.mjs';

const log = createLogger('llm-client');

/**
 * Parse an SSE stream from a fetch Response body.
 * Yields parsed JSON objects from `data:` lines.
 */
async function* parseSSE(body) {
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
          log.warn('Malformed SSE JSON', { data: data.slice(0, 200) });
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}

/**
 * Stream an OpenAI-compatible chat completion via direct fetch.
 *
 * Replaces achillesAgentLib's callLLMStreaming with a transparent proxy
 * that properly handles tool_calls, finish_reason, and all OpenAI features.
 *
 * Yields typed chunks:
 *   { type: 'text_delta', text }
 *   { type: 'tool_calls_delta', toolCalls }
 *   { type: 'done', fullText, toolCalls, usage, stopReason }
 *   { type: 'error', error }
 *
 * Error semantics: connection/auth errors throw (for retry logic).
 * Mid-stream errors yield { type: 'error' } (for graceful degradation).
 */
// Params safe to forward to OpenAI-compatible upstreams
const ALLOWED_PARAMS = new Set([
  'model', 'messages', 'temperature', 'top_p', 'max_tokens', 'stop',
  'tools', 'tool_choice', 'response_format', 'seed', 'n',
  'frequency_penalty', 'presence_penalty', 'logprobs', 'top_logprobs',
  'logit_bias', 'user', 'metadata',
]);

export async function* fetchLLMStreaming(baseURL, apiKey, payload, signal, extraHeaders) {
  // Whitelist known params — drop anything the upstream might reject
  const cleanPayload = {};
  for (const key of Object.keys(payload)) {
    if (ALLOWED_PARAMS.has(key)) cleanPayload[key] = payload[key];
  }

  const response = await fetch(baseURL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      ...(extraHeaders || {}),
    },
    body: JSON.stringify({ ...cleanPayload, stream: true }),
    signal,
  });

  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(`API Error (${response.status}): ${errorBody}`);
  }

  let fullText = '';
  const toolCallAccum = [];
  let usage = null;
  let stopReason = null;

  try {
    for await (const data of parseSSE(response.body)) {
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

      // Tool calls delta — accumulate incrementally
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
