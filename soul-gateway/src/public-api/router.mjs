/**
 * Public API router.
 *
 * Registers all public-facing routes: the three ingress formats
 * (OpenAI Chat, Anthropic Messages, OpenAI Responses) plus
 * compatibility aliases and the models listing endpoint.
 */

import { createRequestContext } from '../request/request-context.mjs';
import { executeRequestPipeline } from '../request/pipeline.mjs';
import { sendJson } from '../core/responses.mjs';

/**
 * Register public API routes on an existing router.
 *
 * @param {object} router - router to add routes to
 * @param {object} appCtx - application context
 */
export function registerPublicApiRoutes(router, appCtx) {
  // Canonical routes
  router.add('POST', '/v1/chat/completions', (ctx) =>
    handleCompletionRoute(ctx, 'openai_chat'));
  router.add('POST', '/v1/messages', (ctx) =>
    handleCompletionRoute(ctx, 'anthropic_messages'));
  router.add('POST', '/v1/responses', (ctx) =>
    handleCompletionRoute(ctx, 'openai_responses'));
  router.add('GET', '/v1/models', (ctx) => handleListModels(ctx));
  router.add('GET', '/v1/tiers', (ctx) => handleListTiers(ctx));

  // Compatibility aliases (without /v1 prefix) — required by EXECUTION-BACKLOG §0.1
  router.add('POST', '/chat/completions', (ctx) =>
    handleCompletionRoute(ctx, 'openai_chat'));
  router.add('POST', '/messages', (ctx) =>
    handleCompletionRoute(ctx, 'anthropic_messages'));
  router.add('POST', '/responses', (ctx) =>
    handleCompletionRoute(ctx, 'openai_responses'));
  router.add('GET', '/models', (ctx) => handleListModels(ctx));
}

// ── Route handlers ──────────────────────────────────────────────────

/**
 * Handle a completion request for any ingress format.
 * Creates a request context, sets the route kind, and enters the pipeline.
 */
async function handleCompletionRoute(ctx, routeKind) {
  const reqCtx = createRequestContext(
    { req: ctx.req, res: ctx.res },
    ctx.appCtx,
  );

  // Set route metadata
  reqCtx.routeKind = routeKind;
  reqCtx.responseFormat = routeKind;

  // Propagate the request ID to the response headers
  ctx.res.setHeader('X-Request-Id', reqCtx.requestId);

  await executeRequestPipeline(reqCtx);
}

/**
 * Handle GET /v1/models — return the list of available models from the snapshot.
 */
function handleListModels(ctx) {
  const snapshot = ctx.appCtx.services.snapshot;

  if (!snapshot) {
    sendJson(ctx.res, 200, { object: 'list', data: [] });
    return;
  }

  const data = [];

  // Add all enabled models
  for (const [modelKey, model] of snapshot.models) {
    data.push({
      id: modelKey,
      object: 'model',
      created: Math.floor(snapshot.loadedAt / 1000),
      owned_by: model.providerKey || 'soul-gateway',
      permission: [],
      root: modelKey,
      parent: null,
    });
  }

  // Add tiers as virtual models (they're addressable by clients)
  for (const [tierKey, tier] of snapshot.tiers) {
    data.push({
      id: tierKey,
      object: 'model',
      created: Math.floor(snapshot.loadedAt / 1000),
      owned_by: 'soul-gateway',
      permission: [],
      root: tierKey,
      parent: null,
      _tier: true,
      _description: tier.description || tier.displayName,
      _model_count: tier.models.length,
    });
  }

  // Add aliases
  for (const [alias, target] of snapshot.aliases) {
    data.push({
      id: alias,
      object: 'model',
      created: Math.floor(snapshot.loadedAt / 1000),
      owned_by: 'soul-gateway',
      permission: [],
      root: target,
      parent: target,
      _alias: true,
    });
  }

  sendJson(ctx.res, 200, { object: 'list', data });
}

/**
 * Handle GET /v1/tiers — return enabled tiers with model membership.
 */
function handleListTiers(ctx) {
  const snapshot = ctx.appCtx.services.snapshot;
  if (!snapshot) {
    sendJson(ctx.res, 200, []);
    return;
  }

  const tiers = [];
  for (const [tierKey, tier] of snapshot.tiers) {
    tiers.push({
      id: tier.id,
      tier_key: tierKey,
      display_name: tier.displayName,
      enabled: true,
      models: tier.models.map(m => m.model_key || m.modelKey),
      fallback_tier: tier.fallbackTierKey || null,
      model_count: tier.models.length,
    });
  }
  sendJson(ctx.res, 200, tiers);
}
