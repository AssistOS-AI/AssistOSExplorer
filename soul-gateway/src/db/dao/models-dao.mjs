/**
 * DAO for the models table.
 * Pure data-access functions — no business logic.
 */

const TABLE = 'soul_gateway.models';

export async function create(
    pool,
    {
        modelKey,
        displayName,
        providerId,
        providerModelId,
        executionKind = 'provider_model',
        enabled = true,
        concurrencyLimit = 3,
        queueTimeoutMs = 60000,
        requestTimeoutMs = 120000,
        pricingMode = 'external_directory',
        inputPricePerMillion = null,
        outputPricePerMillion = null,
        requestPriceUsd = null,
        rateLimitOverride = {},
        budgetOverride = {},
        loopOverride = {},
        responseFilterOverride = {},
        retryPolicy = {},
        capabilities = {},
        tags = [],
        isFree = false,
        discoverySource = 'manual',
        metadata = {},
    }
) {
    const { rows } = await pool.query(
        `INSERT INTO ${TABLE}
       (model_key, display_name, provider_id, provider_model_id,
        execution_kind, enabled, concurrency_limit, queue_timeout_ms, request_timeout_ms,
        pricing_mode, input_price_per_million, output_price_per_million, request_price_usd,
        rate_limit_override, budget_override, loop_override, response_filter_override,
        retry_policy, capabilities, tags, is_free, discovery_source, metadata)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23)
     RETURNING *`,
        [
            modelKey,
            displayName,
            providerId,
            providerModelId,
            executionKind,
            enabled,
            concurrencyLimit,
            queueTimeoutMs,
            requestTimeoutMs,
            pricingMode,
            inputPricePerMillion,
            outputPricePerMillion,
            requestPriceUsd,
            JSON.stringify(rateLimitOverride),
            JSON.stringify(budgetOverride),
            JSON.stringify(loopOverride),
            JSON.stringify(responseFilterOverride),
            JSON.stringify(retryPolicy),
            JSON.stringify(capabilities),
            tags,
            isFree,
            discoverySource,
            JSON.stringify(metadata),
        ]
    );
    return rows[0];
}

export async function findById(pool, id) {
    const { rows } = await pool.query(`SELECT * FROM ${TABLE} WHERE id = $1`, [
        id,
    ]);
    return rows[0] || null;
}

export async function findByKey(pool, modelKey) {
    const { rows } = await pool.query(
        `SELECT * FROM ${TABLE} WHERE model_key = $1`,
        [modelKey]
    );
    return rows[0] || null;
}

export async function list(
    pool,
    { enabled = null, executionKind = null, limit = 500, offset = 0 } = {}
) {
    const conditions = [];
    const params = [];
    let idx = 1;

    if (enabled !== null) {
        conditions.push(`m.enabled = $${idx++}`);
        params.push(enabled);
    }
    if (executionKind !== null) {
        conditions.push(`m.execution_kind = $${idx++}`);
        params.push(executionKind);
    }

    const where =
        conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    params.push(limit, offset);

    // LEFT JOIN providers so the dashboard's Models tab can render
    // provider-derived billing info (auth_strategy, provider_key,
    // provider_kind) without a second round-trip. The dashboard renders
    // the "Billing" badge from `auth_strategy`; models don't have that
    // column of their own — it lives on the provider record — so it has
    // to be denormalized here. LEFT JOIN (not INNER) so orphan model
    // rows still appear with `auth_strategy = null` if their provider
    // was deleted out from under them.
    const { rows } = await pool.query(
        `SELECT m.*,
            p.provider_key,
            p.auth_strategy,
            p.kind AS provider_kind
     FROM ${TABLE} m
     LEFT JOIN soul_gateway.providers p ON p.id = m.provider_id
     ${where}
     ORDER BY m.display_name ASC
     LIMIT $${idx++} OFFSET $${idx}`,
        params
    );
    return rows;
}

export async function update(pool, id, fields) {
    const keys = Object.keys(fields);
    if (keys.length === 0) return null;

    const jsonFields = new Set([
        'rateLimitOverride',
        'budgetOverride',
        'loopOverride',
        'responseFilterOverride',
        'retryPolicy',
        'capabilities',
        'metadata',
    ]);

    // Only allow columns the models table actually has.  `maxAttempts`
    // and `strategyKind` are post-F2 additions used by cascade models.
    const allowed = new Set([
        'modelKey',
        'displayName',
        'providerId',
        'providerModelId',
        'executionKind',
        'enabled',
        'concurrencyLimit',
        'queueTimeoutMs',
        'requestTimeoutMs',
        'pricingMode',
        'inputPricePerMillion',
        'outputPricePerMillion',
        'requestPriceUsd',
        'rateLimitOverride',
        'budgetOverride',
        'loopOverride',
        'responseFilterOverride',
        'retryPolicy',
        'capabilities',
        'tags',
        'isFree',
        'discoverySource',
        'metadata',
        'strategyKind',
        'maxAttempts',
    ]);
    const filtered = keys.filter((k) => allowed.has(k));
    if (filtered.length === 0) return null;

    const setClauses = filtered.map((k, i) => `${toSnake(k)} = $${i + 2}`);
    const values = filtered.map((k) =>
        jsonFields.has(k) ? JSON.stringify(fields[k]) : fields[k]
    );

    const { rows } = await pool.query(
        `UPDATE ${TABLE} SET ${setClauses.join(', ')}, updated_at = now() WHERE id = $1 RETURNING *`,
        [id, ...values]
    );
    return rows[0] || null;
}

export async function del(pool, id) {
    const { rowCount } = await pool.query(
        `DELETE FROM ${TABLE} WHERE id = $1`,
        [id]
    );
    return rowCount > 0;
}

export async function enable(pool, id) {
    const { rows } = await pool.query(
        `UPDATE ${TABLE} SET enabled = true, updated_at = now() WHERE id = $1 RETURNING *`,
        [id]
    );
    return rows[0] || null;
}

export async function disable(pool, id) {
    const { rows } = await pool.query(
        `UPDATE ${TABLE} SET enabled = false, updated_at = now() WHERE id = $1 RETURNING *`,
        [id]
    );
    return rows[0] || null;
}

export async function listByProvider(
    pool,
    providerId,
    { enabled = null } = {}
) {
    if (enabled !== null) {
        const { rows } = await pool.query(
            `SELECT * FROM ${TABLE} WHERE provider_id = $1 AND enabled = $2 ORDER BY display_name ASC`,
            [providerId, enabled]
        );
        return rows;
    }
    const { rows } = await pool.query(
        `SELECT * FROM ${TABLE} WHERE provider_id = $1 ORDER BY display_name ASC`,
        [providerId]
    );
    return rows;
}

/**
 * Upsert a model discovered from an external source.
 * Inserts if the model_key does not exist, otherwise updates provider-side fields.
 */
export async function syncFromDiscovery(
    pool,
    {
        modelKey,
        displayName,
        providerId,
        providerModelId,
        executionKind = 'provider_model',
        pricingMode = 'external_directory',
        inputPricePerMillion = null,
        outputPricePerMillion = null,
        requestPriceUsd = null,
        isFree = false,
        capabilities = {},
        tags = [],
    }
) {
    const { rows } = await pool.query(
        `INSERT INTO ${TABLE}
       (model_key, display_name, provider_id, provider_model_id,
        execution_kind, pricing_mode,
        input_price_per_million, output_price_per_million, request_price_usd,
        is_free, capabilities, tags, discovery_source)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'synced')
     ON CONFLICT (model_key) DO UPDATE SET
       display_name = EXCLUDED.display_name,
       provider_model_id = EXCLUDED.provider_model_id,
       pricing_mode = EXCLUDED.pricing_mode,
       input_price_per_million = EXCLUDED.input_price_per_million,
       output_price_per_million = EXCLUDED.output_price_per_million,
       request_price_usd = EXCLUDED.request_price_usd,
       is_free = EXCLUDED.is_free,
       capabilities = EXCLUDED.capabilities,
       tags = EXCLUDED.tags,
       discovery_source = 'synced',
       updated_at = now()
     RETURNING *`,
        [
            modelKey,
            displayName,
            providerId,
            providerModelId,
            executionKind,
            pricingMode,
            inputPricePerMillion,
            outputPricePerMillion,
            requestPriceUsd,
            isFree,
            JSON.stringify(capabilities),
            tags,
        ]
    );
    return rows[0];
}

// ── helpers ──────────────────────────────────────────────────────────

function toSnake(camel) {
    return camel.replace(/[A-Z]/g, (ch) => '_' + ch.toLowerCase());
}
