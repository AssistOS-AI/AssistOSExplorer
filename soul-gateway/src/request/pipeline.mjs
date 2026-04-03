/**
 * Public request pipeline.
 *
 * Orchestrates the stages of a public API request in order:
 *   1. Parse body
 *   2. Authenticate (real API key auth or permissive fallback)
 *   3. Identify caller (headers + User-Agent inference)
 *   4. Bind runtime snapshot
 *   5. Normalize ingress format to internal OpenAI chat representation
 *   6. Validate normalized request
 *   7. Resolve model or tier from snapshot
 *   8. Resolve session
 *   9. Pre-middleware → Dispatch → Post-middleware (integrated via middleware engine)
 *  10. Respond (serialize to client's requested format)
 */

import { readJsonBody } from '../core/json-body.mjs';
import { sendJson, sendError } from '../core/responses.mjs';
import { GatewayError, InternalServerError, ModelNotFoundError, SyntheticResponseAbort } from '../core/errors.mjs';
import { normalizeIncomingFormat } from './format-normalizer.mjs';
import { serializeBufferedResponse } from './format-serializers.mjs';
import { resolveIdentity } from './identity.mjs';
import { resolveSession } from './session.mjs';
import { validateNormalizedRequest } from './validator.mjs';
import { normalizeModelName } from '../runtime/registry/model-name-normalizer.mjs';
import { resolveModel, resolveTier } from '../runtime/registry/model-registry.mjs';
import { authenticateApiKey } from '../runtime/security/api-key-auth.mjs';
import { executeResolvedRequest } from '../runtime/execution/execution-engine.mjs';
import { runMiddlewarePlan } from '../runtime/middleware/middleware-engine.mjs';

/**
 * Execute the full request pipeline for a public API request.
 *
 * @param {object} reqCtx - request context created by createRequestContext
 */
export async function executeRequestPipeline(reqCtx) {
  const { appCtx } = reqCtx;
  const { log } = appCtx;

  try {
    // ── 1. Parse body ─────────────────────────────────────────────
    const parseStart = Date.now();
    reqCtx.body = await readJsonBody(reqCtx.req, appCtx.config.env.BODY_LIMIT_BYTES);
    reqCtx.timings.parseMs = Date.now() - parseStart;

    // ── 2. Authenticate ───────────────────────────────────────────
    const authStart = Date.now();
    await stageAuthenticate(reqCtx);
    reqCtx.timings.authMs = Date.now() - authStart;

    // ── 3. Identify caller ────────────────────────────────────────
    reqCtx.identity = resolveIdentity(reqCtx.req.headers, reqCtx.req.headers['user-agent']);

    // ── 4. Bind runtime snapshot ──────────────────────────────────
    reqCtx.snapshot = appCtx.services.snapshot || null;

    // ── 5. Normalize format ───────────────────────────────────────
    const normalizeStart = Date.now();
    reqCtx.normalizedRequest = normalizeIncomingFormat(reqCtx.routeKind, reqCtx.body);
    reqCtx.request = reqCtx.normalizedRequest;
    reqCtx.timings.normalizeMs = Date.now() - normalizeStart;

    // ── 6. Validate ───────────────────────────────────────────────
    validateNormalizedRequest(reqCtx.normalizedRequest);

    // ── 7. Resolve model/tier ─────────────────────────────────────
    stageResolveModel(reqCtx);

    // ── 8. Resolve session ────────────────────────────────────────
    if (reqCtx.apiKey && appCtx.pool && appCtx.config.env.DATABASE_URL) {
      reqCtx.session = await resolveSession(reqCtx);
    }

    // ── 9-11. Pre-middleware + Dispatch + Post-middleware ──────────
    await stageMiddlewareAndDispatch(reqCtx);

    // ── 12. Respond ───────────────────────────────────────────────
    stageRespond(reqCtx);

  } catch (err) {
    reqCtx.timings.totalMs = Date.now() - reqCtx.startedAt;

    if (err instanceof GatewayError) {
      log.warn('pipeline error', {
        requestId: reqCtx.requestId,
        errorType: err.errorType,
        message: err.message,
        durationMs: reqCtx.timings.totalMs,
      });
      sendError(reqCtx.res, err);
    } else {
      log.error('unhandled pipeline error', {
        requestId: reqCtx.requestId,
        error: err.message,
        stack: err.stack,
        durationMs: reqCtx.timings.totalMs,
      });
      sendError(reqCtx.res, new InternalServerError());
    }
  }
}

// ── Stage: Authenticate ─────────────────────────────────────────────

/**
 * Authenticate the request via API key.
 * If no DB or no encryption key is configured, falls back to permissive mode
 * (allows requests with default limits). This supports running the gateway
 * without a database for development/testing.
 */
async function stageAuthenticate(reqCtx) {
  const { appCtx } = reqCtx;
  const authHeader = reqCtx.req.headers['authorization'] || '';

  // Real auth: DB available and encryption key exists (needed for HMAC pepper)
  const hasDb = appCtx.pool && appCtx.config.env.DATABASE_URL;
  const hasKey = appCtx.config.env.ENCRYPTION_KEY || appCtx.config.env.API_KEY_HASH_PEPPER;

  if (hasDb && hasKey) {
    reqCtx.apiKey = await authenticateApiKey(authHeader, appCtx);
    return;
  }

  // Permissive mode must be explicitly opted into via ALLOW_UNAUTHENTICATED=true.
  // Without this, missing auth config is a hard error — the gateway should not
  // silently serve requests without verifying the caller's identity.
  if (appCtx.config.env.ALLOW_UNAUTHENTICATED) {
    if (!stageAuthenticate._warned) {
      appCtx.log.warn('ALLOW_UNAUTHENTICATED=true — API key auth disabled');
      stageAuthenticate._warned = true;
    }
    reqCtx.apiKey = {
      id: 'permissive-stub',
      label: 'unauthenticated',
      status: 'active',
      rpm_limit: appCtx.config.env.DEFAULT_RPM_LIMIT,
      tpm_limit: appCtx.config.env.DEFAULT_TPM_LIMIT,
      daily_budget_usd: null,
      monthly_budget_usd: null,
    };
    return;
  }

  // No auth config and no explicit opt-out — enforce bearer token requirement
  const { AuthenticationRequiredError } = await import('../core/errors.mjs');
  throw new AuthenticationRequiredError(
    'API key authentication is not configured. Set ENCRYPTION_KEY or API_KEY_HASH_PEPPER, ' +
    'or set ALLOW_UNAUTHENTICATED=true to disable auth (development only).'
  );
}
stageAuthenticate._warned = false;

// ── Stage: Resolve Model ────────────────────────────────────────────

function stageResolveModel(reqCtx) {
  const { normalizedRequest, snapshot } = reqCtx;
  const requestedModel = normalizedRequest.model;

  if (!snapshot) {
    // Without a snapshot, we can't resolve models. Store the raw model name.
    reqCtx.resolvedModel = {
      model: null,
      kind: 'unknown',
      requestedModel,
      resolvedVia: 'none',
    };
    return;
  }

  // Normalize the model name through the name normalizer
  const { normalized, kind } = normalizeModelName(requestedModel, snapshot);

  if (kind === 'model') {
    const result = resolveModel(snapshot, normalized);
    if (!result) throw new ModelNotFoundError(requestedModel);

    reqCtx.resolvedModel = {
      model: result.model,
      kind: 'model',
      requestedModel,
      resolvedVia: result.resolvedVia,
    };
  } else if (kind === 'tier') {
    const result = resolveTier(snapshot, normalized);
    if (!result) throw new ModelNotFoundError(requestedModel);

    reqCtx.resolvedModel = {
      tier: result.tier,
      candidates: result.candidates,
      kind: 'tier',
      requestedModel,
      resolvedVia: 'tier',
      fallbackChain: result.fallbackChain,
      exhausted: result.exhausted,
    };
  } else {
    throw new ModelNotFoundError(requestedModel);
  }
}

// ── Stage: Middleware + Dispatch (integrated) ──────────────────────

/**
 * Run pre-middlewares, dispatch to provider, run post-middlewares.
 *
 * The middleware engine wraps the dispatch function, so all three stages
 * are executed together via runMiddlewarePlan. If no middleware catalog
 * is available (no DB, no middlewares loaded), dispatch runs directly.
 */
async function stageMiddlewareAndDispatch(reqCtx) {
  const { appCtx, resolvedModel, normalizedRequest, snapshot } = reqCtx;
  const catalog = appCtx.services.middlewareCatalog;

  // Build the dispatch function that the middleware engine will call
  const dispatchFn = async () => {
    return executeProviderDispatch(reqCtx);
  };

  // If we have a catalog and a snapshot with assignments, run through the engine
  if (catalog && snapshot) {
    const tierId = resolvedModel.tier?.id || null;
    const modelId = resolvedModel.model?.id || (resolvedModel.candidates?.[0]?.model?.id) || null;
    const plan = catalog.resolveAssignmentPlan(tierId, modelId, snapshot);

    if (plan.length > 0) {
      reqCtx.middlewareState = new Map();
      const mwResult = await runMiddlewarePlan({
        reqCtx,
        plan,
        dispatch: dispatchFn,
      });

      if (mwResult.synthetic) {
        // Middleware returned a cached/synthetic response
        reqCtx.completion = mwResult.result;
        reqCtx._cacheHit = true;
        return;
      }

      // Normal dispatch happened inside runMiddlewarePlan
      return;
    }
  }

  // No middleware — dispatch directly
  await dispatchFn();
}

/**
 * Execute the actual provider dispatch via the execution engine.
 */
async function executeProviderDispatch(reqCtx) {
  const { appCtx, resolvedModel, normalizedRequest, snapshot } = reqCtx;

  const execCtx = {
    requestId: reqCtx.requestId,
    resolvedModel: resolvedModel.kind === 'model' ? resolvedModel.model : null,
    resolvedTier: resolvedModel.kind === 'tier' ? resolvedModel.tier : null,
    normalizedRequest,
    snapshot,
    appCtx,
    concurrencyController: appCtx.services.concurrencyController,
    providerCatalog: appCtx.services.providerCatalog || null,
    credentialManager: appCtx.services.credentialManager || null,
    onCooldown: (modelKey, error) => {
      appCtx.log.info('model cooldown triggered', { modelKey, errorType: error.errorType });
    },
    log: appCtx.log,
  };

  const result = await executeResolvedRequest(execCtx);

  // Map execution result to the completion shape expected by stageRespond
  const collected = result.collected;
  const model = result.model?.modelKey || result.model?.model_key || normalizedRequest.model;

  reqCtx.completion = {
    id: reqCtx.requestId,
    object: 'chat.completion',
    model,
    choices: [{
      index: 0,
      message: collected.message,
      finish_reason: collected.finishReason || 'stop',
    }],
    usage: {
      prompt_tokens: collected.usage.input_tokens,
      completion_tokens: collected.usage.output_tokens,
      total_tokens: collected.usage.total_tokens,
    },
  };

  reqCtx._retryTrace = result.retryTrace || [];
  reqCtx._queueWaitMs = result.queueWaitMs || 0;

  return {
    response: reqCtx.completion,
    usage: reqCtx.completion.usage,
    execution: result,
  };
}

// ── Stage: Respond ──────────────────────────────────────────────────

function stageRespond(reqCtx) {
  reqCtx.timings.totalMs = Date.now() - reqCtx.startedAt;

  const { log } = reqCtx.appCtx;
  log.info('request complete', {
    requestId: reqCtx.requestId,
    model: reqCtx.normalizedRequest?.model,
    agent: reqCtx.identity?.agentName,
    durationMs: reqCtx.timings.totalMs,
  });

  // If the response has already been sent (e.g., streaming), don't send again
  if (reqCtx.res.writableEnded || reqCtx.res.headersSent) return;

  // Serialize the completion into the client's expected format
  const serialized = serializeBufferedResponse(
    reqCtx.completion,
    reqCtx.responseFormat,
    reqCtx.requestId,
  );

  sendJson(reqCtx.res, 200, serialized);
}
