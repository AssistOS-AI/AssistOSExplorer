/**
 * Fake LLM upstream server returning canned OpenAI-format responses.
 */
import { createServer } from 'node:http';
import { NON_STREAM_RESPONSE, STREAM_CHUNKS } from './fixtures.mjs';

let nextResponse = null;
let requestLog = [];

/**
 * Override the next response the mock upstream will return.
 * @param {{ status?, body?, latencyMs?, stream? }} opts
 */
export function setNextResponse(opts) {
  nextResponse = opts;
}

/** Get and clear the request log. */
export function getRequestLog() {
  const log = requestLog;
  requestLog = [];
  return log;
}

/** Reset mock state. */
export function resetMock() {
  nextResponse = null;
  requestLog = [];
}

function buildSSE(chunks) {
  let out = '';
  for (const chunk of chunks) {
    out += `data: ${JSON.stringify(chunk)}\n\n`;
  }
  out += 'data: [DONE]\n\n';
  return out;
}

export function createMockUpstream() {
  const server = createServer(async (req, res) => {
    // Collect request body
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const rawBody = Buffer.concat(chunks).toString('utf8');
    let body;
    try { body = JSON.parse(rawBody); } catch { body = rawBody; }

    requestLog.push({
      method: req.method,
      url: req.url,
      headers: { ...req.headers },
      body,
    });

    // Handle /v1/models
    if (req.url === '/v1/models' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        object: 'list',
        data: [
          { id: 'claude-opus-4.6', object: 'model' },
          { id: 'claude-sonnet-4.5', object: 'model' },
        ],
      }));
      return;
    }

    // Handle /v1/chat/completions
    if (req.url === '/v1/chat/completions' && req.method === 'POST') {
      const override = nextResponse;
      nextResponse = null; // consume

      const latency = override?.latencyMs || 0;
      if (latency > 0) await new Promise(r => setTimeout(r, latency));

      // Custom status code
      const status = override?.status || 200;
      if (status !== 200) {
        const errBody = override?.body || { error: { type: 'test_error', message: `Mock error ${status}` } };
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(errBody));
        return;
      }

      const isStreaming = body?.stream === true;

      if (isStreaming || override?.stream) {
        const chunks = override?.body || STREAM_CHUNKS;
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive',
        });
        res.end(buildSSE(chunks));
        return;
      }

      // Non-streaming
      const responseBody = override?.body || NON_STREAM_RESPONSE;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(responseBody));
      return;
    }

    // Unknown route
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { type: 'not_found', message: 'Not found' } }));
  });

  return server;
}

export function startMockUpstream(server) {
  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ server, port, url: `http://127.0.0.1:${port}` });
    });
  });
}

export function stopMockUpstream(server) {
  return new Promise(resolve => server.close(resolve));
}
