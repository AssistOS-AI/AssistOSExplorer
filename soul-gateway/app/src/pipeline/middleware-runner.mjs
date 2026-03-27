import { getEnabledMiddlewaresForModel } from '../db/middlewares-dao.mjs';
import { getLoadedMiddleware } from './middleware-loader.mjs';
import { createLogger } from '../utils/logger.mjs';

const log = createLogger('middleware');

/**
 * Build the middleware context object.
 */
function buildCtx({ messages, params, model, tier, apiKeyId, agentName, sessionId, isStreaming, authCtx }) {
  return {
    // Mutable by pre middlewares
    messages,
    params,
    // Read-only request info
    model,
    tier,
    apiKeyId,
    agentName,
    sessionId,
    isStreaming,
    authCtx,    // { api_key_id, rpm_limit, tpm_limit, key_daily_budget, soul_id }
    // State flowing from before() to after()
    metadata: {},
    // Response data (populated in post-dispatch)
    response: null,
    isChunk: false,
    usage: null,
    // Abort control
    abort: false,
    abortStatus: 400,
    abortMessage: '',
    abortResponse: null, // When set with abortStatus=200, pipeline sends as success response
  };
}

/**
 * Merge default settings with per-tier/model overrides.
 */
function mergeSettings(defaultSettings, overrideSettings) {
  const defaults = typeof defaultSettings === 'string' ? JSON.parse(defaultSettings) : (defaultSettings || {});
  const overrides = typeof overrideSettings === 'string' ? JSON.parse(overrideSettings) : (overrideSettings || {});
  return { ...defaults, ...overrides };
}

/**
 * Load and merge middlewares from tier and model levels.
 * Tier middlewares run first (broad), then model middlewares (specific).
 */
async function loadMergedMiddlewares(tierId, modelConfigId) {
  let tierMws = [];
  let modelMws = [];

  if (tierId) {
    try {
      tierMws = await getEnabledMiddlewaresForModel(tierId);
    } catch (err) {
      log.error('Failed to load tier middlewares', { tierId, error: err.message });
    }
  }

  if (modelConfigId) {
    try {
      modelMws = await getEnabledMiddlewaresForModel(modelConfigId);
    } catch (err) {
      log.error('Failed to load model middlewares', { modelConfigId, error: err.message });
    }
  }

  // Tier first, then model (broad before specific)
  return [...tierMws, ...modelMws];
}

/**
 * Run pre-dispatch middlewares (before hooks).
 * Returns { ctx, applied, aborted }.
 */
export async function runPreMiddlewares(tierId, modelConfigId, requestData) {
  if (!tierId && !modelConfigId) return { ctx: null, applied: [], aborted: false };

  const allMiddlewares = await loadMergedMiddlewares(tierId, modelConfigId);
  const preMiddlewares = allMiddlewares.filter(m => m.type === 'pre' || m.type === 'both');
  if (preMiddlewares.length === 0) return { ctx: null, applied: [], aborted: false };

  const ctx = buildCtx(requestData);
  const applied = [];

  for (const mwConfig of preMiddlewares) {
    const mw = getLoadedMiddleware(mwConfig.file_name);
    if (!mw || typeof mw.before !== 'function') continue;

    const settings = mergeSettings(mwConfig.default_settings, mwConfig.override_settings);

    try {
      await mw.before(ctx, settings);
      applied.push(mw.name);

      if (ctx.abort) {
        log.info(`Middleware ${mw.name} aborted request`, {
          status: ctx.abortStatus,
          message: ctx.abortMessage,
          hasResponse: !!ctx.abortResponse,
        });
        return { ctx, applied, aborted: true };
      }
    } catch (err) {
      log.error(`Middleware ${mw.name} before() error`, { error: err.message, stack: err.stack });
      // Non-critical: skip and continue
    }
  }

  return { ctx, applied, aborted: false };
}

/**
 * Run post-dispatch middlewares (after hooks).
 * Returns { applied }.
 */
export async function runPostMiddlewares(tierId, modelConfigId, ctx, result) {
  if ((!tierId && !modelConfigId) || !ctx) return { applied: [] };

  const allMiddlewares = await loadMergedMiddlewares(tierId, modelConfigId);
  const postMiddlewares = allMiddlewares.filter(m => m.type === 'post' || m.type === 'both');
  if (postMiddlewares.length === 0) return { applied: [] };

  // Populate response fields on ctx
  ctx.response = result.content;
  ctx.usage = result.usage;

  const applied = [];

  for (const mwConfig of postMiddlewares) {
    const mw = getLoadedMiddleware(mwConfig.file_name);
    if (!mw || typeof mw.after !== 'function') continue;

    // For streaming responses, skip non-streaming middlewares since
    // chunks have already been sent to the client — modifications can't reach them.
    // Streaming-capable middlewares still run (for observation/logging).
    if (ctx.isStreaming && !mwConfig.supports_streaming) continue;

    const settings = mergeSettings(mwConfig.default_settings, mwConfig.override_settings);

    try {
      const prevResponse = ctx.response;
      await mw.after(ctx, settings);
      applied.push(mw.name);

      // If middleware modified the response, propagate back to result
      // (only meaningful for non-streaming; streaming has already been sent)
      if (ctx.response !== prevResponse && !ctx.isStreaming) {
        result.content = ctx.response;
      }
    } catch (err) {
      log.error(`Middleware ${mw.name} after() error`, { error: err.message, stack: err.stack });
      // Non-critical: skip and continue
    }
  }

  return { applied };
}
