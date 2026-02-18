import { readJsonBody, sendError } from '../utils/http-helpers.mjs';
import { createLogger } from '../utils/logger.mjs';
import { authenticate } from './auth.mjs';
import { checkBlacklist } from './blacklist.mjs';
import { checkRateLimit, trackTokenUsage } from './rate-limiter.mjs';
import { resolveModel } from './model-router.mjs';
import { checkPromptSize } from './prompt-checker.mjs';
import { dispatchWithRetry } from './retry.mjs';
import { tapStream, handleNonStreaming } from './stream-tap.mjs';
import { calculateCost } from './cost-calculator.mjs';
import { checkResponse } from './response-checker.mjs';
import { insertLog } from '../db/logs-dao.mjs';
import { broadcastLog } from '../ws/log-stream.mjs';
import { broadcastToSoul } from '../ws/soul-stream.mjs';
import { BlacklistError, SoulGatewayError } from '../utils/errors.mjs';

const log = createLogger('pipeline');

/**
 * Full request lifecycle for /v1/chat/completions.
 */
export async function pipeline(req, res) {
  const startedAt = new Date();
  const startTime = Date.now();

  let authCtx = null;
  let body = null;
  let modelInfo = null;
  let logEntry = {
    started_at: startedAt,
  };

  try {
    // 1. Auth
    authCtx = await authenticate(req);
    logEntry.family_id = authCtx.family_id;
    logEntry.family_name = authCtx.family_name;
    logEntry.soul_id = authCtx.soul_id;
    logEntry.api_key_id = authCtx.api_key_id;

    // Parse body
    body = await readJsonBody(req);
    if (!body || !body.messages || !body.model) {
      return sendError(res, 400, 'Missing required fields: model, messages', 'invalid_request_error');
    }

    logEntry.requested_model = body.model;
    logEntry.is_streaming = !!body.stream;
    logEntry.request_messages = body.messages;

    // 2. Blacklist scan
    try {
      await checkBlacklist(body.messages, authCtx.family_id);
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

    // 3. Rate limit
    await checkRateLimit(authCtx.family_id, authCtx.rpm_limit, authCtx.tpm_limit);

    // 4. Model routing
    modelInfo = await resolveModel(body.model, authCtx);
    logEntry.resolved_model = modelInfo.resolvedModel;
    logEntry.mode = modelInfo.mode;

    // 5. Prompt size check
    const promptCheck = checkPromptSize(body.messages);
    logEntry.request_size_bytes = promptCheck.requestSizeBytes;
    logEntry.prompt_size_warning = promptCheck.promptSizeWarning;

    // 6. Build upstream body
    const upstreamBody = {
      ...body,
      model: modelInfo.upstreamModel,
    };

    // 7. Dispatch with retry
    const { response, retryCount, retryReason, retriesDetail, errorClassification } =
      await dispatchWithRetry(upstreamBody, !!body.stream);

    logEntry.retry_count = retryCount;
    logEntry.retry_reason = retryReason;
    logEntry.retries_detail = retriesDetail;

    // Handle upstream error (non-retryable or exhausted retries)
    if (!response.ok) {
      let errorBody;
      try { errorBody = await response.json(); } catch { errorBody = {}; }

      logEntry.status_code = response.status;
      logEntry.error_type = errorClassification?.type || 'upstream_error';
      logEntry.error_message = errorBody?.error?.message || `Upstream returned ${response.status}`;
      logEntry.completed_at = new Date();
      logEntry.latency_ms = Date.now() - startTime;
      await safeInsertLog(logEntry);

      // Forward the upstream error as-is
      const errStatus = response.status;
      const headers = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
      if (errStatus === 429) {
        const retryAfter = response.headers.get('retry-after');
        if (retryAfter) headers['Retry-After'] = retryAfter;
      }
      res.writeHead(errStatus, headers);
      res.end(JSON.stringify(errorBody));
      return;
    }

    // 8. Stream tap / non-streaming response
    let result;
    if (body.stream) {
      result = await tapStream(response, res, startTime);
    } else {
      result = await handleNonStreaming(response, res, startTime);
    }

    // 9. Cost calculation
    const costs = calculateCost(result.usage, modelInfo.inputPrice, modelInfo.outputPrice);

    // 10. Response checks
    const flags = checkResponse(result.stopReason, Date.now() - startTime);

    // 11. Write full call log
    logEntry.response_content = result.content;
    logEntry.status_code = result.error ? 502 : 200;
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
    logEntry.is_truncated = flags.is_truncated;
    logEntry.is_slow = flags.is_slow;
    logEntry.completed_at = new Date();

    if (result.error) {
      logEntry.error_type = result.error.type;
      logEntry.error_message = result.error.message;
    }

    const inserted = await safeInsertLog(logEntry);

    // 12. Broadcast to WebSocket subscribers
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

    log.error('Pipeline error', { error: err.message, stack: err.stack });
    logEntry.status_code = 500;
    logEntry.error_type = 'internal_error';
    logEntry.error_message = err.message;
    logEntry.latency_ms = latencyMs;
    logEntry.completed_at = new Date();
    await safeInsertLog(logEntry);

    if (!res.headersSent) {
      sendError(res, 500, 'Internal server error');
    }
  }
}

async function safeInsertLog(entry) {
  try {
    return await insertLog(entry);
  } catch (err) {
    log.error('Failed to insert log', { error: err.message });
    return null;
  }
}
