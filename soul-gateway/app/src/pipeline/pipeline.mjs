import { randomUUID } from 'node:crypto';
import { readJsonBody, sendError, sendJson } from '../utils/http-helpers.mjs';
import { createLogger } from '../utils/logger.mjs';
import { authenticate } from './auth.mjs';
import { resolveModel } from './model-router.mjs';
import { checkPromptSize } from './prompt-checker.mjs';
import { dispatchWithRetry } from './retry.mjs';
import { tapStream, handleNonStreaming } from './stream-tap.mjs';
import { calculateCost } from './cost-calculator.mjs';
import { checkResponse } from './response-checker.mjs';
import { insertLog } from '../db/logs-dao.mjs';
import { sha256 } from '../utils/crypto.mjs';
import { broadcastLog } from '../ws/log-stream.mjs';
import { broadcastToSoul } from '../ws/soul-stream.mjs';
import { parseAgentName } from '../utils/agent-parser.mjs';
import { acquireModelSlot } from './model-queue.mjs';
import { putModelInCooldown, shouldTriggerCooldown, shouldCascade } from './model-cooldown.mjs';
import { runPreMiddlewares, runPostMiddlewares } from './middleware-runner.mjs';
import { config } from '../config.mjs';
import { SoulGatewayError } from '../utils/errors.mjs';

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

    // 3. Model routing
    modelInfo = await resolveModel(body.model);
    logEntry.resolved_model = modelInfo.resolvedModel;
    logEntry.mode = modelInfo.mode;
    logEntry.is_free = modelInfo.isFree || false;

    // 8. Extract LLM params — pass through all params (tools, tool_choice, etc.)
    const { model: _m, messages: _msgs, stream: _s, ...llmParams } = body;

    // ---- PRE-DISPATCH MIDDLEWARES ----
    let mwCtx = null;
    const mwApplied = [];
    if (modelInfo.tierId || modelInfo.modelConfigId) {
      const preResult = await runPreMiddlewares(modelInfo.tierId, modelInfo.modelConfigId, {
        messages: body.messages,
        params: llmParams,
        model: modelInfo.resolvedModel,
        tier: modelInfo.tierName,
        apiKeyId: authCtx.api_key_id,
        agentName,
        sessionId,
        isStreaming: !!body.stream,
        authCtx,
      });
      mwCtx = preResult.ctx;
      mwApplied.push(...preResult.applied);

      if (preResult.aborted) {
        logEntry.middlewares_applied = mwApplied;
        logEntry.latency_ms = Date.now() - startTime;
        logEntry.completed_at = new Date();

        // Success abort: middleware short-circuits with a valid response (e.g., cache hit)
        if (mwCtx.abortStatus === 200 && mwCtx.abortResponse) {
          const ar = mwCtx.abortResponse;
          logEntry.status_code = 200;
          logEntry.response_content = ar.content;
          logEntry.stop_reason = ar.stopReason || 'stop';
          logEntry.prompt_tokens = ar.usage?.prompt_tokens;
          logEntry.completion_tokens = ar.usage?.completion_tokens;
          logEntry.total_tokens = ar.usage?.total_tokens;
          logEntry.response_size_bytes = Buffer.byteLength(ar.content || '', 'utf8');
          logEntry.cache_hit = ar.cacheHit ?? false;
          logEntry.prompt_hash = ar.promptHash || logEntry.prompt_hash;

          const costs = calculateCost(
            ar.usage || {},
            modelInfo.inputPrice, modelInfo.outputPrice,
            modelInfo.pricingType, modelInfo.requestCost,
          );
          logEntry.input_cost = costs.input_cost;
          logEntry.output_cost = costs.output_cost;
          logEntry.total_cost = costs.total_cost;

          if (ar.headers) {
            for (const [k, v] of Object.entries(ar.headers)) {
              res.setHeader(k, v);
            }
          }

          sendJson(res, {
            id: requestId,
            object: 'chat.completion',
            choices: [{ index: 0, message: { role: 'assistant', content: ar.content }, finish_reason: ar.stopReason || 'stop' }],
            usage: ar.usage || {},
          });

          const inserted = await safeInsertLog(logEntry);
          const broadcastEntry = { ...logEntry, id: inserted?.id };
          broadcastLog(broadcastEntry);
          if (authCtx.soul_id) broadcastToSoul(authCtx.soul_id, broadcastEntry);
          return;
        }

        // Error abort — merge middleware-provided log fields
        if (mwCtx.metadata?.logFields) {
          Object.assign(logEntry, mwCtx.metadata.logFields);
        }
        logEntry.status_code = mwCtx.abortStatus;
        logEntry.error_type = mwCtx.metadata?.errorType || 'middleware_abort';
        logEntry.error_message = mwCtx.abortMessage;
        await safeInsertLog(logEntry);

        if (!res.headersSent) {
          const headers = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
          if (mwCtx.metadata?.retryAfter) {
            headers['Retry-After'] = String(mwCtx.metadata.retryAfter);
          }
          res.writeHead(mwCtx.abortStatus, headers);
          res.end(JSON.stringify({ error: { type: logEntry.error_type, message: mwCtx.abortMessage } }));
        }
        return;
      }

      // Apply mutations from pre-middlewares
      if (mwCtx) {
        body.messages = mwCtx.messages;
      }
    }
    // ---- END PRE-DISPATCH MIDDLEWARES ----

    // 9. Prompt hash (uses potentially modified messages from middlewares)
    const promptHash = sha256(JSON.stringify(body.messages) + '||' + modelInfo.resolvedModel);
    logEntry.prompt_hash = promptHash;

    // 10. Prompt size check
    const promptCheck = checkPromptSize(body.messages);
    logEntry.request_size_bytes = promptCheck.requestSizeBytes;
    logEntry.prompt_size_warning = promptCheck.promptSizeWarning;

    // 11. Dispatch with model cooldown fallback
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
        if (modelAttempt < config.maxModelRetries) {
          // Cooldown cascade: transient quota/rate errors — cooldown + try next model
          if (shouldTriggerCooldown(err.errorClassification)) {
            putModelInCooldown(modelInfo.modelConfigName, err.errorClassification.type, err.message);
            cooldownSkipped.push({
              model: modelInfo.modelConfigName,
              error_type: err.errorClassification.type,
              retry_count: err.retryCount,
              cascade: 'cooldown',
            });
            lastDispatchError = err;
            continue;
          }
          // Immediate cascade: model/provider-level errors — try next model without cooldown
          if (shouldCascade(err.errorClassification)) {
            log.warn('Immediate cascade: skipping failed model', {
              model: modelInfo.modelConfigName,
              error_type: err.errorClassification.type,
              status: err.status,
            });
            cooldownSkipped.push({
              model: modelInfo.modelConfigName,
              error_type: err.errorClassification.type,
              retry_count: err.retryCount,
              cascade: 'immediate',
            });
            lastDispatchError = err;
            continue;
          }
        }
        throw err;
      } finally {
        releaseSlot();
      }
    }

    if (cooldownSkipped.length > 0) {
      logEntry.cooldown_skipped = cooldownSkipped;
    }

    // 15. Cost calculation (before post-middlewares so they have cost data)
    const costs = calculateCost(result.usage, modelInfo.inputPrice, modelInfo.outputPrice, modelInfo.pricingType, modelInfo.requestCost);

    // Set cost metadata for post-middlewares (budget tracking needs this)
    if (mwCtx) {
      mwCtx.metadata.totalCost = costs.total_cost;
      mwCtx.metadata.isFree = modelInfo?.isFree;
    }

    // ---- POST-DISPATCH MIDDLEWARES ----
    if ((modelInfo.tierId || modelInfo.modelConfigId) && mwCtx) {
      const postResult = await runPostMiddlewares(modelInfo.tierId, modelInfo.modelConfigId, mwCtx, result);
      mwApplied.push(...postResult.applied);
    }
    // ---- END POST-DISPATCH MIDDLEWARES ----

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
    logEntry.middlewares_applied = mwApplied.length > 0 ? mwApplied : null;
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
