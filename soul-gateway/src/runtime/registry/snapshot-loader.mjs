/**
 * Loads the full runtime snapshot from the database in minimal round-trips.
 *
 * The snapshot is an immutable, frozen object that represents the
 * complete routing state at a point in time.  Requests bind to a
 * snapshot at ingress and use it for the duration of the request —
 * no mid-flight mutations.
 *
 * The loader reads from:
 *
 *   - `models`              (direct and cascade models, strategy_kind)
 *   - `model_aliases`
 *   - `model_children`      (cascade fallback lists)
 *   - `providers`
 *   - `middleware_bindings` (unified scope / target / middleware_key)
 *   - `model_cooldowns`
 *
 * Cascade data lives in the database as `models(strategy_kind='cascade')`
 * plus `model_children` rows.
 */

let _generation = 0;

export async function loadRuntimeSnapshot(appCtx) {
    const { pool } = appCtx;

    const [
        modelsResult,
        aliasesResult,
        modelChildrenResult,
        providersResult,
        middlewareBindingsResult,
        cooldownsResult,
    ] = await Promise.all([
        pool.query(`
      SELECT m.*, p.provider_key
      FROM soul_gateway.models m
      LEFT JOIN soul_gateway.providers p ON p.id = m.provider_id
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
      SELECT mc.parent_model_id, mc.child_model_id, mc.priority,
             mc.enabled AS child_enabled, mc.settings,
             m.model_key AS child_model_key,
             m.enabled AS child_model_enabled
      FROM soul_gateway.model_children mc
      JOIN soul_gateway.models m ON m.id = mc.child_model_id
      WHERE mc.enabled = true
      ORDER BY mc.parent_model_id, mc.priority ASC
    `),
        pool.query(`
      SELECT * FROM soul_gateway.providers
      WHERE enabled = true
    `),
        pool.query(`
      SELECT mb.*, mw.module_path, mw.source_type,
             mw.default_settings AS middleware_default_settings
      FROM soul_gateway.middleware_bindings mb
      LEFT JOIN soul_gateway.middlewares mw ON mw.middleware_key = mb.middleware_key
      WHERE mb.enabled = true
      ORDER BY mb.scope, mb.target_id NULLS FIRST, mb.sort_order ASC
    `),
        pool.query(`
      SELECT cd.model_id, m.model_key
      FROM soul_gateway.model_cooldowns cd
      JOIN soul_gateway.models m ON m.id = cd.model_id
      WHERE cd.cleared_at IS NULL AND cd.expires_at > now()
    `),
    ]);

    // ── Build maps ────────────────────────────────────────────────────

    // Group model_children rows by parent_model_id so we can attach a
    // frozen children array to each cascade model record as we build it.
    const childrenByParentId = new Map();
    for (const row of modelChildrenResult.rows) {
        let list = childrenByParentId.get(row.parent_model_id);
        if (!list) {
            list = [];
            childrenByParentId.set(row.parent_model_id, list);
        }
        list.push({
            modelKey: row.child_model_key,
            modelId: row.child_model_id,
            priority: row.priority,
            enabled: row.child_enabled,
            settings: row.settings || {},
            childEnabled: row.child_model_enabled,
        });
    }

    const models = new Map();
    for (const row of modelsResult.rows) {
        const children = childrenByParentId.get(row.id) || [];
        models.set(row.model_key, freezeModelRecord(row, children));
    }

    const aliases = new Map();
    for (const row of aliasesResult.rows) {
        aliases.set(row.alias, row.model_key);
    }

    const providers = new Map();
    for (const row of providersResult.rows) {
        providers.set(row.provider_key, freezeProviderRecord(row));
    }

    // Group middleware bindings by scope → target.  The planner
    // (`MiddlewareCatalog.resolveBindings`) reads this shape to produce
    // ordered plans at request time.
    const gatewayBindings = [];
    const modelBindingsByModelId = new Map();
    const providerBindingsByProviderId = new Map();
    for (const row of middlewareBindingsResult.rows) {
        const entry = freezeBindingRecord(row);
        if (row.scope === 'gateway') {
            gatewayBindings.push(entry);
        } else if (row.scope === 'model') {
            let list = modelBindingsByModelId.get(row.target_id);
            if (!list) {
                list = [];
                modelBindingsByModelId.set(row.target_id, list);
            }
            list.push(entry);
        } else if (row.scope === 'provider') {
            let list = providerBindingsByProviderId.get(row.target_id);
            if (!list) {
                list = [];
                providerBindingsByProviderId.set(row.target_id, list);
            }
            list.push(entry);
        }
    }
    for (const [k, v] of modelBindingsByModelId) {
        modelBindingsByModelId.set(k, Object.freeze(v));
    }
    for (const [k, v] of providerBindingsByProviderId) {
        providerBindingsByProviderId.set(k, Object.freeze(v));
    }

    const cooldowns = new Set();
    for (const row of cooldownsResult.rows) {
        cooldowns.add(row.model_key);
    }

    // Build pricing map from model data
    const pricing = new Map();
    for (const row of modelsResult.rows) {
        pricing.set(
            row.model_key,
            Object.freeze({
                pricingMode: row.pricing_mode,
                inputPricePerMillion:
                    row.input_price_per_million != null
                        ? parseFloat(row.input_price_per_million)
                        : null,
                outputPricePerMillion:
                    row.output_price_per_million != null
                        ? parseFloat(row.output_price_per_million)
                        : null,
                requestPriceUsd:
                    row.request_price_usd != null
                        ? parseFloat(row.request_price_usd)
                        : null,
                isFree: row.is_free,
            })
        );
    }

    _generation += 1;

    const snapshot = Object.freeze({
        generation: _generation,
        models,
        aliases,
        providers,
        cooldowns,
        pricing,
        // Unified bindings, grouped by scope/target.  Workstream F3
        // replaces the legacy `middlewareAssignments: { byTier, byModel }`
        // shape.  Gateway-scope bindings are a flat array (no target).
        middlewareBindings: Object.freeze({
            gateway: Object.freeze(gatewayBindings),
            byModel: modelBindingsByModelId,
            byProvider: providerBindingsByProviderId,
        }),
        loadedAt: Date.now(),
    });

    return snapshot;
}

// ── Record freezers ─────────────────────────────────────────────────

function freezeModelRecord(row, children) {
    const strategyKind = row.strategy_kind || 'direct';
    // Direct models carry children = null; cascade models carry an
    // ordered frozen array of { modelKey, modelId, priority, settings }.
    const childrenView =
        strategyKind === 'cascade' && children.length > 0
            ? Object.freeze(
                  children.map((c) =>
                      Object.freeze({
                          modelKey: c.modelKey,
                          modelId: c.modelId,
                          priority: c.priority,
                          settings: c.settings,
                          // Carry the child's own enabled flag so the cascade middleware
                          // can filter it out without a second snapshot lookup.
                          childEnabled: c.childEnabled,
                      })
                  )
              )
            : strategyKind === 'cascade'
              ? Object.freeze([])
              : null;

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
        inputPricePerMillion:
            row.input_price_per_million != null
                ? parseFloat(row.input_price_per_million)
                : null,
        outputPricePerMillion:
            row.output_price_per_million != null
                ? parseFloat(row.output_price_per_million)
                : null,
        requestPriceUsd:
            row.request_price_usd != null
                ? parseFloat(row.request_price_usd)
                : null,
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
        // Strategy fields
        strategyKind,
        children: childrenView,
        maxAttempts: row.max_attempts,
    });
}

function freezeProviderRecord(row) {
    return Object.freeze({
        id: row.id,
        providerKey: row.provider_key,
        displayName: row.display_name,
        kind: row.kind,
        backendKey: row.adapter_key,
        authStrategy: row.auth_strategy,
        providerMode: row.provider_mode,
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

function freezeBindingRecord(row) {
    return Object.freeze({
        id: row.id,
        scope: row.scope,
        targetId: row.target_id,
        middlewareKey: row.middleware_key,
        modulePath: row.module_path,
        sourceType: row.source_type,
        sortOrder: row.sort_order,
        settings: row.settings || {},
        middlewareDefaultSettings: row.middleware_default_settings || {},
    });
}
