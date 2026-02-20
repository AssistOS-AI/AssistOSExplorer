import { randomUUID } from 'node:crypto';
import { readBody, sendError } from '../utils/http-helpers.mjs';
import { createLogger } from '../utils/logger.mjs';
import { authenticate } from './auth.mjs';
import { checkBlacklist } from './blacklist.mjs';
import { checkRateLimit, trackTokenUsage } from './rate-limiter.mjs';
import { resolveModel } from './model-router.mjs';
import { calculateCost } from './cost-calculator.mjs';
import { insertLog } from '../db/logs-dao.mjs';
import { broadcastLog } from '../ws/log-stream.mjs';
import { broadcastToSoul } from '../ws/soul-stream.mjs';
import { parseAgentName } from '../utils/agent-parser.mjs';
import { resolveSession } from './session-resolver.mjs';
import { BlacklistError, SoulGatewayError } from '../utils/errors.mjs';
import { loadModelsConfiguration } from 'achillesAgentLib/utils/LLMClient.mjs';

const log = createLogger('openai-responses-proxy');
const modelsConfig = loadModelsConfiguration();

/**
 * OpenAI Responses API passthrough proxy (/v1/responses).
 * Authenticates, rate-limits, blacklist-checks, then proxies the raw
 * request/response to the upstream provider in OpenAI Responses format.
 */
export async function openaiResponsesProxy(req, res) {
  const startedAt = new Date();
  const startTime = Date.now();
  const requestId = `resp_${randomUUID()}`;

  let authCtx = null;
  let body = null;
  let modelInfo = null;
  let logEntry = { started_at: startedAt };

  try {
    // 1. Auth
    authCtx = await authenticate(req);
    logEntry.family_id = authCtx.family_id;
    logEntry.family_name = authCtx.family_name;
    logEntry.soul_id = authCtx.soul_id;
    logEntry.api_key_id = authCtx.api_key_id;

    // 2. Agent & session identification
    const agentName = req.headers['x-soul-agent'] || parseAgentName(req.headers['user-agent']);
    const sessionId = req.headers['x-soul-session'] || await resolveSession(authCtx.api_key_id, agentName);
    logEntry.agent_name = agentName;
    logEntry.session_id = sessionId;

    // 3. Parse body
    const rawBody = await readBody(req);
    if (!rawBody) return sendError(res, 400, 'Empty request body', 'invalid_request_error');
    body = JSON.parse(rawBody);

    // Debug: log raw request details
    log.info('Request body keys', { keys: Object.keys(body), stream: body.stream, model: body.model, hasInput: !!body.input });

    if (!body.model) {
      return sendError(res, 400, 'Missing required field: model', 'invalid_request_error');
    }

    logEntry.requested_model = body.model;
    logEntry.is_streaming = !!body.stream;
    // Responses API uses 'input' instead of 'messages'
    logEntry.request_messages = body.input;

    // 4. Blacklist scan — extract text from Responses API input format
    const messagesToScan = extractMessagesForScan(body);
    if (messagesToScan.length > 0) {
      try {
        await checkBlacklist(messagesToScan, authCtx.family_id);
      } catch (err) {
        if (err instanceof BlacklistError) {
          logEntry.blocked_by_blacklist = true;
          logEntry.blacklist_rule_id = err.ruleId;
          logEntry.blacklist_match = err.match;
          logEntry.status_code = 400;
          logEntry.error_type = 'content_blocked';
          logEntry.error_message = err.message;
          logEntry.completed_at = new Date();
          logEntry.latency_ms = Date.now() - startTime;
          await safeInsertLog(logEntry);
          return sendError(res, 400, err.message, 'content_blocked');
        }
        throw err;
      }
    }

    // 5. Rate limit
    await checkRateLimit(authCtx.family_id, authCtx.rpm_limit, authCtx.tpm_limit);

    // 6. Model routing
    modelInfo = await resolveModel(body.model, authCtx);
    logEntry.resolved_model = modelInfo.resolvedModel;
    logEntry.mode = modelInfo.mode;

    // 7. Resolve upstream provider config
    const providerConfig = modelsConfig.providers.get(modelInfo.providerKey);
    if (!providerConfig) {
      throw new SoulGatewayError(
        `Provider "${modelInfo.providerKey}" not configured`, 502, 'provider_not_configured'
      );
    }
    const baseURL = providerConfig.baseURL;
    if (!baseURL) {
      throw new SoulGatewayError(
        `Missing baseURL for provider "${modelInfo.providerKey}"`, 502, 'provider_not_configured'
      );
    }

    const apiKeyEnv = providerConfig.apiKeyEnv;
    const upstreamApiKey = apiKeyEnv ? process.env[apiKeyEnv] : process.env.LLM_API_KEY;
    if (!upstreamApiKey) {
      throw new SoulGatewayError(
        `Missing API key for provider "${modelInfo.providerKey}" (env: ${apiKeyEnv})`, 502, 'provider_not_configured'
      );
    }

    // 8. Build upstream URL — replace from /v1/ onwards with /v1/responses
    const parsed = new URL(baseURL);
    const v1Idx = parsed.pathname.indexOf('/v1/');
    const basePath = v1Idx >= 0 ? parsed.pathname.slice(0, v1Idx) : '';
    const upstreamUrl = parsed.origin + basePath + '/v1/responses';

    // Replace model with provider_model in the body
    const upstreamBody = JSON.stringify({ ...body, model: modelInfo.providerModel });

    const upstreamHeaders = {
      'content-type': 'application/json',
      'authorization': `Bearer ${upstreamApiKey}`,
    };

    log.info('Proxying to upstream', {
      url: upstreamUrl,
      model: modelInfo.providerModel,
      stream: !!body.stream,
    });

    // 9. Dispatch to upstream
    const upstreamRes = await fetch(upstreamUrl, {
      method: 'POST',
      headers: upstreamHeaders,
      body: upstreamBody,
    });

    // 10. Handle response
    let result;
    if (body.stream) {
      result = await pipeResponsesStream(upstreamRes, res, startTime);
    } else {
      result = await handleResponsesNonStreaming(upstreamRes, res, startTime);
    }

    // 11. Cost calculation
    const costs = calculateCost(result.usage, modelInfo.inputPrice, modelInfo.outputPrice);

    // 12. Write log
    logEntry.response_content = result.content;
    logEntry.status_code = result.error ? (upstreamRes.status || 502) : 200;
    logEntry.stop_reason = result.stopReason;
    logEntry.response_size_bytes = Buffer.byteLength(result.content || '', 'utf8');
    logEntry.latency_ms = Date.now() - startTime;
    logEntry.ttfb_ms = result.ttfbMs;
    logEntry.prompt_tokens = costs.prompt_tokens;
    logEntry.completion_tokens = costs.completion_tokens;
    logEntry.total_tokens = costs.total_tokens;
    logEntry.input_cost = costs.input_cost;
    logEntry.output_cost = costs.output_cost;
    logEntry.total_cost = costs.total_cost;
    logEntry.completed_at = new Date();

    if (result.error) {
      logEntry.error_type = result.error.type;
      logEntry.error_message = result.error.message;
    }

    const inserted = await safeInsertLog(logEntry);

    // 13. Broadcast to WebSocket subscribers
    const broadcastEntry = { ...logEntry, id: inserted?.id };
    broadcastLog(broadcastEntry);
    if (authCtx.soul_id) broadcastToSoul(authCtx.soul_id, broadcastEntry);

    // Track TPM (post-response)
    if (costs.total_tokens > 0) {
      trackTokenUsage(authCtx.family_id, costs.total_tokens, authCtx.tpm_limit).catch(() => {});
    }

  } catch (err) {
    const latencyMs = Date.now() - startTime;

    if (err instanceof SoulGatewayError) {
      logEntry.status_code = err.status;
      logEntry.error_type = err.type;
      logEntry.error_message = err.message;
      logEntry.latency_ms = latencyMs;
      logEntry.completed_at = new Date();
      await safeInsertLog(logEntry);

      if (!res.headersSent) {
        const headers = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
        if (err.retryAfter) headers['Retry-After'] = String(err.retryAfter);
        res.writeHead(err.status, headers);
        res.end(JSON.stringify({ error: { type: err.type, message: err.message } }));
      }
      return;
    }

    log.error('OpenAI responses proxy error', { error: err.message, stack: err.stack });
    logEntry.status_code = 500;
    logEntry.error_type = 'internal_error';
    logEntry.error_message = err.message;
    logEntry.latency_ms = latencyMs;
    logEntry.completed_at = new Date();
    await safeInsertLog(logEntry);

    if (!res.headersSent) {
      res.writeHead(500, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ error: { type: 'internal_error', message: 'Internal server error' } }));
    }
  }
}

/**
 * Extract messages in checkBlacklist-compatible format from Responses API input.
 * The 'input' field can be a string, or an array of message/item objects.
 */
function extractMessagesForScan(body) {
  const messages = [];

  // Scan instructions (system prompt)
  if (body.instructions) {
    messages.push({ role: 'system', content: body.instructions });
  }

  if (!body.input) return messages;

  // String input
  if (typeof body.input === 'string') {
    messages.push({ role: 'user', content: body.input });
    return messages;
  }

  // Array input — normalize to { role, content } for blacklist scanner
  if (Array.isArray(body.input)) {
    for (const item of body.input) {
      if (typeof item === 'string') {
        messages.push({ role: 'user', content: item });
      } else if (item.content) {
        // Standard message format or item with content
        messages.push({ role: item.role || 'user', content: item.content });
      } else if (item.type === 'message' && item.content) {
        messages.push({ role: item.role || 'user', content: item.content });
      }
    }
  }

  return messages;
}

/**
 * Pipe upstream OpenAI Responses SSE stream to client byte-for-byte,
 * while parsing SSE events to extract metrics for logging.
 */
async function pipeResponsesStream(upstreamRes, clientRes, startTime) {
  // If upstream returned an error, forward it as-is
  if (!upstreamRes.ok) {
    const errorBody = await upstreamRes.text();
    clientRes.writeHead(upstreamRes.status, {
      'Content-Type': upstreamRes.headers.get('content-type') || 'application/json',
      'Access-Control-Allow-Origin': '*',
    });
    clientRes.end(errorBody);

    let errorData;
    try { errorData = JSON.parse(errorBody); } catch {}
    return {
      content: '',
      usage: { prompt_tokens: 0, completion_tokens: 0 },
      stopReason: null,
      ttfbMs: Date.now() - startTime,
      error: {
        type: errorData?.error?.type || 'upstream_error',
        message: errorData?.error?.message || `Upstream returned ${upstreamRes.status}`,
      },
    };
  }

  // Forward SSE headers to client
  clientRes.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'Access-Control-Allow-Origin': '*',
  });

  let content = '';
  let usage = { prompt_tokens: 0, completion_tokens: 0 };
  let stopReason = null;
  let ttfbMs = null;
  let sseBuffer = '';

  try {
    const reader = upstreamRes.body.getReader();
    const decoder = new TextDecoder();

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      const text = decoder.decode(value, { stream: true });

      // Forward raw bytes to client
      clientRes.write(text);

      if (ttfbMs === null) ttfbMs = Date.now() - startTime;

      // Parse SSE events for metrics extraction
      sseBuffer += text;
      const { parsed, remaining } = parseSSEBuffer(sseBuffer);
      sseBuffer = remaining;

      for (const event of parsed) {
        if (!event.data) continue;
        try {
          const data = JSON.parse(event.data);

          if (event.type === 'response.output_text.delta') {
            content += data.delta || '';
          } else if (event.type === 'response.completed') {
            if (data.response?.usage) {
              usage.prompt_tokens = data.response.usage.input_tokens || 0;
              usage.completion_tokens = data.response.usage.output_tokens || 0;
            }
            if (data.response?.output_text) {
              content = data.response.output_text;
            }
            stopReason = 'stop';
          } else if (event.type === 'response.incomplete') {
            if (data.response?.usage) {
              usage.prompt_tokens = data.response.usage.input_tokens || 0;
              usage.completion_tokens = data.response.usage.output_tokens || 0;
            }
            stopReason = data.response?.incomplete_details?.reason || 'incomplete';
          } else if (event.type === 'response.failed') {
            stopReason = 'error';
          }
        } catch {
          // Non-JSON data line, ignore
        }
      }
    }
  } catch (err) {
    log.error('Stream pipe error', { error: err.message });
    return { content, usage, stopReason, ttfbMs, error: { type: 'mid_stream_error', message: err.message } };
  } finally {
    clientRes.end();
  }

  return { content, usage, stopReason, ttfbMs, error: null };
}

/**
 * Handle non-streaming OpenAI Responses response: forward as-is, extract metrics.
 */
async function handleResponsesNonStreaming(upstreamRes, clientRes, startTime) {
  const ttfbMs = Date.now() - startTime;
  const responseBody = await upstreamRes.text();

  // Forward the response as-is
  clientRes.writeHead(upstreamRes.status, {
    'Content-Type': upstreamRes.headers.get('content-type') || 'application/json',
    'Access-Control-Allow-Origin': '*',
  });
  clientRes.end(responseBody);

  // Parse for metrics
  let content = '';
  let usage = { prompt_tokens: 0, completion_tokens: 0 };
  let stopReason = null;
  let error = null;

  try {
    const data = JSON.parse(responseBody);

    if (data.error) {
      error = {
        type: data.error.type || 'upstream_error',
        message: data.error.message || 'Unknown error',
      };
    } else {
      content = data.output_text || '';
      stopReason = data.status === 'completed' ? 'stop'
        : data.status === 'incomplete' ? (data.incomplete_details?.reason || 'incomplete')
        : data.status;
      if (data.usage) {
        usage.prompt_tokens = data.usage.input_tokens || 0;
        usage.completion_tokens = data.usage.output_tokens || 0;
      }
    }
  } catch {
    if (!upstreamRes.ok) {
      error = { type: 'upstream_error', message: `Upstream returned ${upstreamRes.status}` };
    }
  }

  return { content, usage, stopReason, ttfbMs, error };
}

/**
 * Parse SSE events from a text buffer.
 * Returns { parsed: [{ type, data }], remaining: string }.
 */
function parseSSEBuffer(buffer) {
  const parsed = [];
  const blocks = buffer.split('\n\n');

  // Last block may be incomplete — keep it as remaining
  const remaining = blocks.pop() || '';

  for (const block of blocks) {
    if (!block.trim()) continue;
    let type = null;
    let data = null;
    for (const line of block.split('\n')) {
      if (line.startsWith('event: ')) {
        type = line.slice(7).trim();
      } else if (line.startsWith('data: ')) {
        data = line.slice(6);
      }
    }
    if (data !== null) {
      parsed.push({ type, data });
    }
  }

  return { parsed, remaining };
}

async function safeInsertLog(entry) {
  try {
    return await insertLog(entry);
  } catch (err) {
    log.error('Failed to insert log', { error: err.message });
    return null;
  }
}
