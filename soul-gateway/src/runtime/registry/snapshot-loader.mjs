/**
 * Loads the full runtime snapshot from the database in minimal round-trips.
 *
 * The snapshot is an immutable, frozen object that represents the complete
 * routing state at a point in time. Requests bind to a snapshot at ingress
 * and use it for the duration of the request — no mid-flight mutations.
 */

let _generation = 0;

/**
 * Query all enabled models, aliases, tiers (with tier_models), providers,
 * middleware assignments, active cooldowns, and pricing. Returns a deeply
 * frozen snapshot object.
 */
export async function loadRuntimeSnapshot(appCtx) {
  const { pool } = appCtx;

  // Run all queries in parallel for a single round-trip window.
  const [
    modelsResult,
    aliasesResult,
    tiersResult,
    tierModelsResult,
    providersResult,
    middlewareAssignmentsResult,
    cooldownsResult,
  ] = await Promise.all([
    pool.query(`
      SELECT m.*, p.provider_key
      FROM soul_gateway.models m
      JOIN soul_gateway.providers p ON p.id = m.provider_id
      WHERE m.enabled = true
      ORDER BY m.display_name ASC
    `),
    pool.query(`
      SELECT ma.alias, m.model_key
      FROM soul_gateway.model_aliases ma
      JOIN soul_gateway.models m ON m.id = ma.model_id
      WHERE m.enabled = true
    `),
    pool.query(`
      SELECT * FROM soul_gateway.tiers
      WHERE enabled = true
      ORDER BY display_name ASC
    `),
    pool.query(`
      SELECT tm.*, m.model_key, m.enabled AS model_enabled
      FROM soul_gateway.tier_models tm
      JOIN soul_gateway.models m ON m.id = tm.model_id
      WHERE tm.enabled = true
      ORDER BY tm.tier_id, tm.priority ASC
    `),
    pool.query(`
      SELECT * FROM soul_gateway.providers
      WHERE enabled = true
    `),
    pool.query(`
      SELECT ma.*, mw.middleware_key, mw.hook_mode, mw.module_path,
             mw.source_type, mw.default_settings AS middleware_default_settings
      FROM soul_gateway.middleware_assignments ma
      JOIN soul_gateway.middlewares mw ON mw.id = ma.middleware_id
      WHERE ma.enabled = true AND mw.enabled = true
      ORDER BY ma.sort_order ASC
    `),
    pool.query(`
      SELECT cd.model_id, m.model_key
      FROM soul_gateway.model_cooldowns cd
      JOIN soul_gateway.models m ON m.id = cd.model_id
      WHERE cd.cleared_at IS NULL AND cd.expires_at > now()
    `),
  ]);

  // ── Build maps ────────────────────────────────────────────────────

  const models = new Map();
  for (const row of modelsResult.rows) {
    models.set(row.model_key, freezeModelRecord(row));
  }

  const aliases = new Map();
  for (const row of aliasesResult.rows) {
    aliases.set(row.alias, row.model_key);
  }

  // Group tier_models by tier_id
  const tierModelsByTierId = new Map();
  for (const row of tierModelsResult.rows) {
    let list = tierModelsByTierId.get(row.tier_id);
    if (!list) {
      list = [];
      tierModelsByTierId.set(row.tier_id, list);
    }
    list.push({
      modelKey: row.model_key,
      modelId: row.model_id,
      priority: row.priority,
      modelEnabled: row.model_enabled,
      settings: row.settings || {},
    });
  }

  const tiers = new Map();
  for (const row of tiersResult.rows) {
    const tierModels = tierModelsByTierId.get(row.id) || [];
    tiers.set(row.tier_key, freezeTierRecord(row, tierModels));
  }

  const providers = new Map();
  for (const row of providersResult.rows) {
    providers.set(row.provider_key, freezeProviderRecord(row));
  }

  // Middleware assignments keyed by target
  const byTier = new Map();
  const byModel = new Map();
  for (const row of middlewareAssignmentsResult.rows) {
    const entry = freezeAssignmentRecord(row);
    if (row.target_type === 'tier' && row.tier_id) {
      let list = byTier.get(row.tier_id);
      if (!list) {
        list = [];
        byTier.set(row.tier_id, list);
      }
      list.push(entry);
    } else if (row.target_type === 'model' && row.model_id) {
      let list = byModel.get(row.model_id);
      if (!list) {
        list = [];
        byModel.set(row.model_id, list);
      }
      list.push(entry);
    }
  }
  // Freeze the inner arrays
  for (const [k, v] of byTier) byTier.set(k, Object.freeze(v));
  for (const [k, v] of byModel) byModel.set(k, Object.freeze(v));

  const cooldowns = new Set();
  for (const row of cooldownsResult.rows) {
    cooldowns.add(row.model_key);
  }

  // Build pricing map from model data
  const pricing = new Map();
  for (const row of modelsResult.rows) {
    pricing.set(row.model_key, Object.freeze({
      pricingMode: row.pricing_mode,
      inputPricePerMillion: row.input_price_per_million != null
        ? parseFloat(row.input_price_per_million) : null,
      outputPricePerMillion: row.output_price_per_million != null
        ? parseFloat(row.output_price_per_million) : null,
      requestPriceUsd: row.request_price_usd != null
        ? parseFloat(row.request_price_usd) : null,
      isFree: row.is_free,
    }));
  }

  _generation += 1;

  const snapshot = Object.freeze({
    generation: _generation,
    models,
    aliases,
    tiers,
    providers,
    middlewareAssignments: Object.freeze({ byTier, byModel }),
    cooldowns,
    pricing,
    loadedAt: Date.now(),
  });

  return snapshot;
}

// ── Record freezers ─────────────────────────────────────────────────

function freezeModelRecord(row) {
  return Object.freeze({
    id: row.id,
    modelKey: row.model_key,
    displayName: row.display_name,
    providerId: row.provider_id,
    providerKey: row.provider_key,
    providerModelId: row.provider_model_id,
    executionKind: row.execution_kind,
    enabled: row.enabled,
    concurrencyLimit: row.concurrency_limit,
    queueTimeoutMs: row.queue_timeout_ms,
    requestTimeoutMs: row.request_timeout_ms,
    pricingMode: row.pricing_mode,
    inputPricePerMillion: row.input_price_per_million != null
      ? parseFloat(row.input_price_per_million) : null,
    outputPricePerMillion: row.output_price_per_million != null
      ? parseFloat(row.output_price_per_million) : null,
    requestPriceUsd: row.request_price_usd != null
      ? parseFloat(row.request_price_usd) : null,
    rateLimitOverride: row.rate_limit_override || {},
    budgetOverride: row.budget_override || {},
    loopOverride: row.loop_override || {},
    responseFilterOverride: row.response_filter_override || {},
    retryPolicy: row.retry_policy || {},
    capabilities: row.capabilities || {},
    tags: row.tags || [],
    isFree: row.is_free,
    discoverySource: row.discovery_source,
    metadata: row.metadata || {},
  });
}

function freezeTierRecord(row, tierModels) {
  return Object.freeze({
    id: row.id,
    tierKey: row.tier_key,
    displayName: row.display_name,
    description: row.description,
    fallbackTierId: row.fallback_tier_id,
    maxModelAttempts: row.max_model_attempts,
    enabled: row.enabled,
    rateLimitOverride: row.rate_limit_override || {},
    budgetOverride: row.budget_override || {},
    loopOverride: row.loop_override || {},
    responseFilterOverride: row.response_filter_override || {},
    metadata: row.metadata || {},
    models: Object.freeze(tierModels.map((tm) => Object.freeze({
      modelKey: tm.modelKey,
      modelId: tm.modelId,
      priority: tm.priority,
      modelEnabled: tm.modelEnabled,
      settings: tm.settings,
    }))),
  });
}

function freezeProviderRecord(row) {
  return Object.freeze({
    id: row.id,
    providerKey: row.provider_key,
    displayName: row.display_name,
    kind: row.kind,
    adapterKey: row.adapter_key,
    authStrategy: row.auth_strategy,
    providerMode: row.provider_mode,
    executorKey: row.executor_key,
    oauthAdapterKey: row.oauth_adapter_key,
    baseUrl: row.base_url,
    enabled: row.enabled,
    supportsStreaming: row.supports_streaming,
    supportsTools: row.supports_tools,
    supportsMessagesApi: row.supports_messages_api,
    supportsResponsesApi: row.supports_responses_api,
    settings: row.settings || {},
    metadata: row.metadata || {},
  });
}

function freezeAssignmentRecord(row) {
  return Object.freeze({
    id: row.id,
    middlewareId: row.middleware_id,
    middlewareKey: row.middleware_key,
    hookMode: row.hook_mode,
    modulePath: row.module_path,
    sourceType: row.source_type,
    targetType: row.target_type,
    sortOrder: row.sort_order,
    settings: row.settings || {},
    middlewareDefaultSettings: row.middleware_default_settings || {},
  });
}
