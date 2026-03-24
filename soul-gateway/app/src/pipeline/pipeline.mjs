import { randomUUID } from 'node:crypto';
import { readJsonBody, sendError, sendJson } from '../utils/http-helpers.mjs';
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
import { insertLog, findCachedResponse } from '../db/logs-dao.mjs';
import { sha256 } from '../utils/crypto.mjs';
import { broadcastLog } from '../ws/log-stream.mjs';
import { broadcastToSoul } from '../ws/soul-stream.mjs';
import { parseAgentName } from '../utils/agent-parser.mjs';
import { checkLoopDetection } from './loop-detector.mjs';
import { acquireModelSlot } from './model-queue.mjs';
import { checkBudget, trackSpend } from './cost-throttler.mjs';
import { putModelInCooldown, shouldTriggerCooldown } from './model-cooldown.mjs';
import { config } from '../config.mjs';
import { BlacklistError, SoulGatewayError } from '../utils/errors.mjs';

const log = createLogger('pipeline');

/**
 * Full request lifecycle for /v1/chat/completions.
 */
export async function pipeline(req, res) {
  const startedAt = new Date();
  const startTime = Date.now();
  const requestId = `chatcmpl-${randomUUID()}`;

  let authCtx = null;
  let body = null;
  let modelInfo = null;
  let logEntry = {
    started_at: startedAt,
  };

  try {
    // 1. Auth
    authCtx = await authenticate(req);
    logEntry.soul_id = authCtx.soul_id;
    logEntry.api_key_id = authCtx.api_key_id;

    // 2. Agent & session identification
    const agentName = req.headers['x-soul-agent'] || parseAgentName(req.headers['user-agent'], req.headers['x-coding-assistant']);
    const sessionId = req.headers['x-soul-session'] || null;
    logEntry.agent_name = agentName;
    logEntry.session_id = sessionId;

    // Parse body
    body = await readJsonBody(req);
    if (!body || !body.messages || !body.model) {
      return sendError(res, 400, 'Missing required fields: model, messages', 'invalid_request_error');
    }

    logEntry.requested_model = body.model;
    logEntry.is_streaming = !!body.stream;
    logEntry.request_messages = body.messages;

    // 3. Loop detection (use key's rpm_limit for rapid-fire threshold)
    checkLoopDetection(sessionId, body.messages, body.model, { maxRpm: authCtx.rpm_limit });

    // 4. Blacklist scan
    try {
      await checkBlacklist(body.messages);
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

    // 5. Rate limit
    await checkRateLimit(authCtx.api_key_id, authCtx.rpm_limit, authCtx.tpm_limit);

    // 6. Budget check
    await checkBudget(authCtx);

    // 7. Model routing
    modelInfo = await resolveModel(body.model);
    logEntry.resolved_model = modelInfo.resolvedModel;
    logEntry.mode = modelInfo.mode;
    logEntry.is_free = modelInfo.isFree || false;

    // 8. Prompt hash
    const promptHash = sha256(JSON.stringify(body.messages) + '||' + modelInfo.resolvedModel);
    logEntry.prompt_hash = promptHash;

    // 9. Prompt size check
    const promptCheck = checkPromptSize(body.messages);
    logEntry.request_size_bytes = promptCheck.requestSizeBytes;
    logEntry.prompt_size_warning = promptCheck.promptSizeWarning;

    // 10. Extract LLM params from the request body
    const llmParams = {};
    if (body.temperature !== undefined) llmParams.temperature = body.temperature;
    if (body.max_tokens !== undefined) llmParams.max_tokens = body.max_tokens;
    if (body.top_p !== undefined) llmParams.top_p = body.top_p;
    if (body.frequency_penalty !== undefined) llmParams.frequency_penalty = body.frequency_penalty;
    if (body.presence_penalty !== undefined) llmParams.presence_penalty = body.presence_penalty;
    if (body.stop !== undefined) llmParams.stop = body.stop;

    // 11. Cache check (non-streaming only)
    if (!body.stream) {
      const cached = await findCachedResponse(promptHash, modelInfo.resolvedModel);
      if (cached) {
        logEntry.cache_hit = true;
        logEntry.response_content = cached.response_content;
        logEntry.status_code = 200;
        logEntry.stop_reason = cached.stop_reason;
        logEntry.response_size_bytes = Buffer.byteLength(cached.response_content || '', 'utf8');
        logEntry.latency_ms = Date.now() - startTime;
        logEntry.prompt_tokens = cached.prompt_tokens;
        logEntry.completion_tokens = cached.completion_tokens;
        logEntry.total_tokens = cached.total_tokens;

        const costs = calculateCost(
          { prompt_tokens: cached.prompt_tokens, completion_tokens: cached.completion_tokens, total_tokens: cached.total_tokens },
          modelInfo.inputPrice, modelInfo.outputPrice, modelInfo.pricingType, modelInfo.requestCost,
        );
        logEntry.input_cost = costs.input_cost;
        logEntry.output_cost = costs.output_cost;
        logEntry.total_cost = costs.total_cost;
        logEntry.completed_at = new Date();

        res.setHeader('X-Cache', 'HIT');
        sendJson(res, {
          id: requestId,
          object: 'chat.completion',
          choices: [{ index: 0, message: { role: 'assistant', content: cached.response_content }, finish_reason: cached.stop_reason || 'stop' }],
          usage: { prompt_tokens: cached.prompt_tokens || 0, completion_tokens: cached.completion_tokens || 0, total_tokens: cached.total_tokens || 0 },
        });

        const inserted = await safeInsertLog(logEntry);
        const broadcastEntry = { ...logEntry, id: inserted?.id };
        broadcastLog(broadcastEntry);
        if (authCtx.soul_id) broadcastToSoul(authCtx.soul_id, broadcastEntry);
        return;
      }
    }

    // 12. Dispatch with model cooldown fallback
    const attemptedModels = new Set();
    const cooldownSkipped = [];
    let result;
    let lastDispatchError = null;

    for (let modelAttempt = 0; modelAttempt <= config.maxModelRetries; modelAttempt++) {
      if (modelAttempt > 0) {
        // Re-resolve model after putting the previous one in cooldown
        try {
          modelInfo = await resolveModel(body.model);
        } catch {
          // No more models available in tier — throw the original dispatch error
          throw lastDispatchError;
        }

        // Guard against resolving a model we already tried
        if (attemptedModels.has(modelInfo.modelConfigName)) {
          throw lastDispatchError;
        }

        logEntry.resolved_model = modelInfo.resolvedModel;
        logEntry.mode = modelInfo.mode;
        logEntry.is_free = modelInfo.isFree || false;

        log.info('Cooldown fallback: trying next model', {
          model: modelInfo.modelConfigName,
          attempt: modelAttempt,
        });
      }

      attemptedModels.add(modelInfo.modelConfigName);

      const releaseSlot = await acquireModelSlot(modelInfo.resolvedModel, modelInfo.maxConcurrency);
      try {
        // 13. Dispatch with retry
        const { generator, retryCount, retryReason, retriesDetail } =
          await dispatchWithRetry(body.messages, modelInfo, llmParams);

        logEntry.retry_count = retryCount;
        logEntry.retry_reason = retryReason;
        logEntry.retries_detail = retriesDetail;

        // 14. Stream tap / non-streaming response
        if (body.stream) {
          result = await tapStream(generator, res, startTime, requestId);
        } else {
          result = await handleNonStreaming(generator, res, startTime, requestId);
        }

        break; // Success — exit model-retry loop
      } catch (err) {
        // Check if this error should trigger model cooldown
        if (shouldTriggerCooldown(err.errorClassification) && modelAttempt < config.maxModelRetries) {
          putModelInCooldown(modelInfo.modelConfigName, err.errorClassification.type, err.message);
          cooldownSkipped.push({
            model: modelInfo.modelConfigName,
            error_type: err.errorClassification.type,
            retry_count: err.retryCount,
          });
          lastDispatchError = err;
          continue; // Try next model in tier
        }
        throw err;
      } finally {
        releaseSlot();
      }
    }

    if (cooldownSkipped.length > 0) {
      logEntry.cooldown_skipped = cooldownSkipped;
    }

    // 15. Cost calculation
    const costs = calculateCost(result.usage, modelInfo.inputPrice, modelInfo.outputPrice, modelInfo.pricingType, modelInfo.requestCost);

    // 16. Response checks
    const flags = checkResponse(result.stopReason, Date.now() - startTime);

    // 17. Write full call log
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

    // 18. Broadcast to WebSocket subscribers
    const broadcastEntry = { ...logEntry, id: inserted?.id };
    broadcastLog(broadcastEntry);
    if (authCtx.soul_id) broadcastToSoul(authCtx.soul_id, broadcastEntry);

    // Track TPM and budget spend (post-response)
    if (costs.total_tokens > 0) {
      trackTokenUsage(authCtx.api_key_id, costs.total_tokens, authCtx.tpm_limit).catch(() => {});
    }
    if (costs.total_cost > 0) {
      trackSpend(authCtx, costs.total_cost, modelInfo?.isFree);
    }

  } catch (err) {
    const latencyMs = Date.now() - startTime;

    if (err instanceof SoulGatewayError) {
      logEntry.status_code = err.status;
      logEntry.error_type = err.type;
      logEntry.error_message = err.message;
      logEntry.latency_ms = latencyMs;
      logEntry.completed_at = new Date();
      // Use requested model when resolved model isn't available (error before routing)
      if (!logEntry.resolved_model && logEntry.requested_model) {
        logEntry.resolved_model = logEntry.requested_model;
      }
      logEntry.retry_count = err.retryCount ?? logEntry.retry_count;
      logEntry.retry_reason = err.retryReason ?? logEntry.retry_reason;
      logEntry.retries_detail = err.retriesDetail ?? logEntry.retries_detail;
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
