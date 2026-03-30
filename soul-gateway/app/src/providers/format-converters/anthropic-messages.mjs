import { createLogger } from '../../utils/logger.mjs';

const log = createLogger('anthropic-messages');

// ---- SSE parsing for Anthropic Messages API ----

/**
 * Parse Anthropic SSE stream (event: + data: format).
 * Yields { event, parsedData } for each frame.
 */
async function* parseAnthropicSSE(body) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      const blocks = buffer.split('\n\n');
      buffer = blocks.pop();

      for (const block of blocks) {
        if (!block.trim()) continue;

        let event = '';
        let data = '';

        for (const line of block.split('\n')) {
          if (line.startsWith('event: ')) event = line.slice(7).trim();
          else if (line.startsWith('data: ')) data = line.slice(6);
          else if (line.startsWith('data:')) data = line.slice(5);
        }

        if (!data) continue;

        let parsedData = null;
        try { parsedData = JSON.parse(data); } catch {}

        if (event || parsedData) {
          yield { event, parsedData };
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}

function safeParseJson(str) {
  if (!str) return {};
  try { return JSON.parse(str); } catch { return {}; }
}

// ---- Payload conversion: OpenAI Chat Completions -> Anthropic Messages ----

function convertToAnthropicPayload(chatPayload) {
  const { messages, max_tokens, stream, tools, tool_choice, temperature, top_p, stop, ...rest } = chatPayload;

  // Extract system messages into top-level system field
  const systemMessages = messages.filter(m => m.role === 'system');
  const nonSystemMessages = messages.filter(m => m.role !== 'system');

  const system = systemMessages
    .map(m => typeof m.content === 'string' ? m.content : JSON.stringify(m.content))
    .join('\n\n');

  // Convert messages: map 'assistant' tool_calls to Anthropic format
  const anthropicMessages = nonSystemMessages.map(msg => {
    // Tool call results from OpenAI format
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

    // Assistant messages with tool_calls
    if (msg.role === 'assistant' && msg.tool_calls) {
      const content = [];
      if (msg.content) {
        content.push({ type: 'text', text: msg.content });
      }
      for (const tc of msg.tool_calls) {
        content.push({
          type: 'tool_use',
          id: tc.id,
          name: tc.function?.name || '',
          input: safeParseJson(tc.function?.arguments),
        });
      }
      return { role: 'assistant', content };
    }

    return { role: msg.role, content: msg.content };
  });

  const payload = {
    model: chatPayload.model,
    messages: anthropicMessages,
    max_tokens: max_tokens || 8192,
    stream: true,
  };

  // Build system as array of content blocks (Anthropic format).
  // The Claude Agent SDK marker is required for OAuth tokens to access paid models —
  // Anthropic gates paid-model OAuth access on this system block.
  const AGENT_SDK_MARKER = { type: 'text', text: 'You are a Claude agent, built on Anthropic\'s Claude Agent SDK.' };
  const systemBlocks = [AGENT_SDK_MARKER];
  if (system) {
    systemBlocks.push({ type: 'text', text: system });
  }
  payload.system = systemBlocks;
  if (temperature !== undefined) payload.temperature = temperature;
  if (top_p !== undefined) payload.top_p = top_p;
  if (stop) payload.stop_sequences = Array.isArray(stop) ? stop : [stop];

  // Convert tools from OpenAI format to Anthropic format
  if (tools && Array.isArray(tools) && tools.length > 0) {
    payload.tools = tools.map(t => {
      if (t.type === 'function' && t.function) {
        return {
          name: t.function.name,
          description: t.function.description || '',
          input_schema: t.function.parameters || { type: 'object', properties: {} },
        };
      }
      return t;
    });
  }

  if (tool_choice) {
    if (tool_choice === 'auto') payload.tool_choice = { type: 'auto' };
    else if (tool_choice === 'none') payload.tool_choice = { type: 'none' };
    else if (tool_choice === 'required') payload.tool_choice = { type: 'any' };
    else if (typeof tool_choice === 'object' && tool_choice.function?.name) {
      payload.tool_choice = { type: 'tool', name: tool_choice.function.name };
    }
  }

  return payload;
}

// ---- Streaming: Anthropic SSE -> typed chunks ----

async function* streamAnthropicMessages(baseUrl, messages, payload, headers, signal) {
  const anthropicPayload = convertToAnthropicPayload(payload);
  const bodyJson = JSON.stringify(anthropicPayload);

  const response = await fetch(baseUrl, {
    method: 'POST',
    headers,
    body: bodyJson,
    signal,
  });

  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(`API Error (${response.status}): ${errorBody}`);
  }

  let fullText = '';
  let usage = null;
  let stopReason = null;
  const toolCallAccum = []; // index -> { id, name, arguments }

  try {
    for await (const { event, parsedData } of parseAnthropicSSE(response.body)) {
      // message_start: extract input tokens
      if (event === 'message_start') {
        const msgUsage = parsedData?.message?.usage;
        if (msgUsage) {
          usage = {
            prompt_tokens: msgUsage.input_tokens || 0,
            completion_tokens: 0,
            total_tokens: msgUsage.input_tokens || 0,
          };
        }
        continue;
      }

      // content_block_start: detect tool_use blocks
      if (event === 'content_block_start') {
        const block = parsedData?.content_block;
        if (block?.type === 'tool_use') {
          const idx = parsedData?.index ?? toolCallAccum.length;
          toolCallAccum[idx] = {
            id: block.id || '',
            type: 'function',
            function: { name: block.name || '', arguments: '' },
          };
        }
        continue;
      }

      // content_block_delta: text or tool input
      if (event === 'content_block_delta') {
        const delta = parsedData?.delta;
        if (delta?.type === 'text_delta') {
          const text = delta.text || '';
          if (text) {
            fullText += text;
            yield { type: 'text_delta', text };
          }
        } else if (delta?.type === 'input_json_delta') {
          const idx = parsedData?.index ?? 0;
          if (toolCallAccum[idx]) {
            toolCallAccum[idx].function.arguments += delta.partial_json || '';
          }
        }
        continue;
      }

      // content_block_stop: emit tool call delta
      if (event === 'content_block_stop') {
        const idx = parsedData?.index;
        if (idx !== undefined && toolCallAccum[idx]) {
          yield {
            type: 'tool_calls_delta',
            toolCalls: [{ index: idx, ...toolCallAccum[idx] }],
          };
        }
        continue;
      }

      // message_delta: stop reason and output tokens
      if (event === 'message_delta') {
        if (parsedData?.delta?.stop_reason) {
          const reason = parsedData.delta.stop_reason;
          stopReason = reason === 'end_turn' ? 'stop' : reason === 'tool_use' ? 'tool_calls' : reason;
        }
        if (parsedData?.usage?.output_tokens) {
          if (!usage) usage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
          usage.completion_tokens = parsedData.usage.output_tokens;
          usage.total_tokens = usage.prompt_tokens + usage.completion_tokens;
        }
        continue;
      }

      // Error events
      if (event === 'error') {
        const errorMsg = parsedData?.error?.message || 'Unknown Anthropic error';
        yield { type: 'error', error: new Error(errorMsg) };
        return;
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
    stopReason: stopReason || (toolCalls.length > 0 ? 'tool_calls' : 'stop'),
  };
}

// ---- Main dispatch ----

export default {
  name: 'anthropic-messages',

  /**
   * Dispatch a request to the Anthropic Messages API.
   * Converts OpenAI chat format to Anthropic format, streams the response,
   * and yields typed chunks compatible with the rest of the pipeline.
   */
  async* dispatch(messages, payload, baseUrl, headers, signal) {
    log.debug('Dispatching to Anthropic Messages API', { model: payload.model, baseUrl });
    yield* streamAnthropicMessages(baseUrl, messages, payload, headers, signal);
  },
};
