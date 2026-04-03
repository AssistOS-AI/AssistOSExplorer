/**
 * Collect a NormalizedChunk async generator into a buffered result.
 *
 * Handles both streaming passthrough and buffered accumulation.
 */
export async function collectNormalizedStream(stream, options = {}) {
  const { maxExcerptChars = 2000 } = options;

  let textParts = [];
  let toolCalls = [];
  let usage = null;
  let finishReason = null;
  let rawResponse = null;
  let responseMeta = {};

  for await (const chunk of stream) {
    const payload = chunk.data || chunk;

    switch (chunk.type) {
      case 'message_start':
        break;

      case 'text_delta':
        if (payload.text) {
          textParts.push(payload.text);
        }
        break;

      case 'tool_call_delta':
        // Accumulate tool call deltas
        if (!toolCalls[payload.index]) {
          toolCalls[payload.index] = {
            id: payload.id,
            type: 'function',
            function: { name: payload.name || '', arguments: '' },
          };
        }
        if (payload.arguments) {
          toolCalls[payload.index].function.arguments += payload.arguments;
        }
        if (payload.name) {
          toolCalls[payload.index].function.name = payload.name;
        }
        break;

      case 'usage':
        usage = {
          input_tokens: payload.input_tokens || 0,
          output_tokens: payload.output_tokens || 0,
          total_tokens: payload.total_tokens || ((payload.input_tokens || 0) + (payload.output_tokens || 0)),
        };
        break;

      case 'done':
        finishReason = payload.finish_reason || chunk.finish_reason || 'stop';
        if (payload.rawResponse || chunk.rawResponse) rawResponse = payload.rawResponse || chunk.rawResponse;
        if (payload.responseMeta || chunk.responseMeta) responseMeta = payload.responseMeta || chunk.responseMeta;
        break;

      case 'error':
        throw payload.error || chunk.error || new Error(payload.message || chunk.message || 'stream error');
    }
  }

  const fullText = textParts.join('');
  const excerpt = fullText.length > maxExcerptChars
    ? fullText.slice(0, maxExcerptChars) + '...'
    : fullText;

  const content = fullText || null;
  const message = {
    role: 'assistant',
    content,
    ...(toolCalls.length > 0 ? { tool_calls: toolCalls.filter(Boolean) } : {}),
  };

  return {
    message,
    content,
    excerpt,
    finishReason,
    usage: usage || { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
    toolCalls: toolCalls.filter(Boolean),
    rawResponse,
    responseMeta,
  };
}

/**
 * Create a passthrough that yields chunks while also collecting them.
 */
export async function* streamAndCollect(stream, collector) {
  for await (const chunk of stream) {
    collector.push(chunk);
    yield chunk;
  }
}
