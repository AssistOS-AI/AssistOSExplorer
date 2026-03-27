import { createLogger } from '../utils/logger.mjs';

const log = createLogger('stream-tap');

/**
 * Consume achillesAgentLib typed chunks from a streaming generator,
 * re-encode them as OpenAI SSE, and pipe to the client.
 *
 * @param {AsyncGenerator} generator - achillesAgentLib streaming generator
 * @param {http.ServerResponse} clientRes
 * @param {number} startTime - Date.now() at request start
 * @param {string} requestId - Unique ID for the SSE response
 * @returns {{ content, usage, stopReason, ttfbMs, error }}
 */
export async function tapStream(generator, clientRes, startTime, requestId) {
  clientRes.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'Access-Control-Allow-Origin': '*',
  });

  let content = '';
  let usage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
  let stopReason = null;
  let ttfbMs = null;

  try {
    for await (const chunk of generator) {
      if (chunk.type === 'text_delta') {
        if (ttfbMs === null) ttfbMs = Date.now() - startTime;
        content += chunk.text;

        // Re-encode as OpenAI SSE chunk
        clientRes.write(`data: ${JSON.stringify({
          id: requestId,
          object: 'chat.completion.chunk',
          choices: [{ index: 0, delta: { content: chunk.text }, finish_reason: null }],
        })}\n\n`);

      } else if (chunk.type === 'tool_calls_delta') {
        if (ttfbMs === null) ttfbMs = Date.now() - startTime;

        clientRes.write(`data: ${JSON.stringify({
          id: requestId,
          object: 'chat.completion.chunk',
          choices: [{ index: 0, delta: { tool_calls: chunk.toolCalls }, finish_reason: null }],
        })}\n\n`);

      } else if (chunk.type === 'done') {
        content = chunk.fullText || content;
        if (chunk.usage) {
          usage = {
            prompt_tokens: chunk.usage.prompt_tokens || 0,
            completion_tokens: chunk.usage.completion_tokens || 0,
            total_tokens: chunk.usage.total_tokens || (chunk.usage.prompt_tokens || 0) + (chunk.usage.completion_tokens || 0),
          };
        }
        stopReason = chunk.stopReason || 'stop';

        // Send finish chunk with usage
        const finishChunk = {
          id: requestId,
          object: 'chat.completion.chunk',
          choices: [{ index: 0, delta: {}, finish_reason: stopReason }],
        };
        if (chunk.usage) finishChunk.usage = chunk.usage;
        clientRes.write(`data: ${JSON.stringify(finishChunk)}\n\n`);
        clientRes.write('data: [DONE]\n\n');

      } else if (chunk.type === 'error') {
        const errMsg = chunk.error?.message || 'Unknown streaming error';
        log.error('Mid-stream error from provider', { error: errMsg });
        try {
          clientRes.write(`data: ${JSON.stringify({
            id: requestId,
            object: 'chat.completion.chunk',
            choices: [{ index: 0, delta: {}, finish_reason: 'error' }],
            error: { type: 'mid_stream_error', message: errMsg },
          })}\n\n`);
          clientRes.write('data: [DONE]\n\n');
        } catch { /* client may have disconnected */ }

        return {
          content,
          usage,
          stopReason: null,
          ttfbMs,
          error: { type: 'mid_stream_error', message: errMsg },
        };
      }
      // Ignore thinking_delta and other unknown chunk types
    }
  } catch (err) {
    log.error('Stream tap error', { error: err.message });
    try {
      clientRes.write(`data: ${JSON.stringify({
        error: { type: 'mid_stream_error', message: err.message },
      })}\n\n`);
      clientRes.write('data: [DONE]\n\n');
    } catch { /* client may have disconnected */ }

    return {
      content,
      usage,
      stopReason: null,
      ttfbMs,
      error: { type: 'mid_stream_error', message: err.message },
    };
  } finally {
    clientRes.end();
  }

  return { content, usage, stopReason, ttfbMs, error: null };
}

/**
 * Handle a non-streaming request by buffering all chunks from the generator
 * and returning a complete OpenAI JSON response.
 *
 * @param {AsyncGenerator} generator - achillesAgentLib streaming generator
 * @param {http.ServerResponse} clientRes
 * @param {number} startTime
 * @param {string} requestId
 * @returns {{ content, usage, stopReason, ttfbMs, error }}
 */
export async function handleNonStreaming(generator, clientRes, startTime, requestId) {
  let content = '';
  let usage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
  let stopReason = 'stop';
  let ttfbMs = null;
  let toolCalls = null;

  try {
    for await (const chunk of generator) {
      if (chunk.type === 'text_delta') {
        if (ttfbMs === null) ttfbMs = Date.now() - startTime;
        content += chunk.text;
      } else if (chunk.type === 'done') {
        content = chunk.fullText || content;
        toolCalls = chunk.toolCalls || null;
        stopReason = chunk.stopReason || 'stop';
        if (chunk.usage) {
          usage = {
            prompt_tokens: chunk.usage.prompt_tokens || 0,
            completion_tokens: chunk.usage.completion_tokens || 0,
            total_tokens: chunk.usage.total_tokens || (chunk.usage.prompt_tokens || 0) + (chunk.usage.completion_tokens || 0),
          };
        }
      } else if (chunk.type === 'error') {
        const errMsg = chunk.error?.message || 'Unknown error';
        clientRes.writeHead(502, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
        clientRes.end(JSON.stringify({ error: { type: 'upstream_error', message: errMsg } }));
        return { content, usage, stopReason: null, ttfbMs, error: { type: 'upstream_error', message: errMsg } };
      }
    }
  } catch (err) {
    clientRes.writeHead(502, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    clientRes.end(JSON.stringify({ error: { type: 'upstream_error', message: err.message } }));
    return { content: '', usage, stopReason: null, ttfbMs, error: { type: 'upstream_error', message: err.message } };
  }

  // Build complete OpenAI response
  const responseBody = JSON.stringify({
    id: requestId,
    object: 'chat.completion',
    choices: [{
      index: 0,
      message: { role: 'assistant', content, ...(toolCalls ? { tool_calls: toolCalls } : {}) },
      finish_reason: stopReason,
    }],
    usage,
  });

  clientRes.writeHead(200, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
  });
  clientRes.end(responseBody);

  return { content, usage, stopReason, ttfbMs, error: null };
}
