import { parseSSEStream } from '../utils/sse-parser.mjs';
import { createLogger } from '../utils/logger.mjs';

const log = createLogger('stream-tap');

/**
 * Tap into an SSE stream to accumulate content and extract metadata.
 * Pipes the stream through to the client response while collecting data.
 *
 * Returns: { content, usage, stopReason, ttfbMs }
 */
export async function tapStream(upstreamResponse, clientRes, startTime) {
  let content = '';
  let usage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
  let stopReason = null;
  let ttfbMs = null;
  let firstChunk = true;

  // Set SSE headers on client response
  clientRes.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'Access-Control-Allow-Origin': '*',
  });

  try {
    for await (const frame of parseSSEStream(upstreamResponse.body)) {
      if (firstChunk) {
        ttfbMs = Date.now() - startTime;
        firstChunk = false;
      }

      if (frame.done) {
        // Send [DONE] to client
        clientRes.write('data: [DONE]\n\n');
        break;
      }

      // Forward raw SSE frame to client
      const raw = frame.data;
      clientRes.write(`data: ${raw}\n\n`);

      // Extract metadata from parsed data
      if (frame.parsedData) {
        const data = frame.parsedData;

        // Accumulate content
        const delta = data.choices?.[0]?.delta;
        if (delta?.content) {
          content += delta.content;
        }

        // Check finish reason
        const finish = data.choices?.[0]?.finish_reason;
        if (finish) {
          stopReason = finish;
        }

        // Extract usage (usually in the last chunk)
        if (data.usage) {
          usage = {
            prompt_tokens: data.usage.prompt_tokens || usage.prompt_tokens,
            completion_tokens: data.usage.completion_tokens || usage.completion_tokens,
            total_tokens: data.usage.total_tokens || usage.total_tokens,
          };
        }
      }
    }
  } catch (err) {
    log.error('Stream tap error', { error: err.message });
    // Try to send error event to client
    try {
      clientRes.write(`data: ${JSON.stringify({ error: { type: 'mid_stream_error', message: err.message } })}\n\n`);
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
 * Handle non-streaming response: read full body, send to client.
 * Returns: { content, usage, stopReason }
 */
export async function handleNonStreaming(upstreamResponse, clientRes, startTime) {
  const body = await upstreamResponse.text();
  const ttfbMs = Date.now() - startTime;

  let data;
  try {
    data = JSON.parse(body);
  } catch {
    clientRes.writeHead(502, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    clientRes.end(JSON.stringify({ error: { type: 'upstream_error', message: 'Invalid upstream response' } }));
    return { content: '', usage: {}, stopReason: null, ttfbMs, error: { type: 'upstream_error', message: 'Invalid JSON from upstream' } };
  }

  clientRes.writeHead(upstreamResponse.status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
  });
  clientRes.end(body);

  const content = data.choices?.[0]?.message?.content || '';
  const usage = data.usage || {};
  const stopReason = data.choices?.[0]?.finish_reason || null;

  return { content, usage, stopReason, ttfbMs, error: null };
}
