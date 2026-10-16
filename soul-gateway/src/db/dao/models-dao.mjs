/**
 * DAO for the models table.
 * Pure data-access functions — no business logic.
 */
import { randomUUID } from 'node:crypto';
import { toSnake } from './helpers/case-convert.mjs';
import { updateRow } from './helpers/query-builder.mjs';

const TABLE = 'models';

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
    const id = randomUUID();
    const { rows } = await pool.query(
        `INSERT INTO ${TABLE}
       (model_key, display_name, provider_id, provider_model_id,
        execution_kind, enabled, concurrency_limit, queue_timeout_ms, request_timeout_ms,
        pricing_mode, input_price_per_million, output_price_per_million, request_price_usd,
        rate_limit_override, budget_override, loop_override, response_filter_override,
        retry_policy, capabilities, tags, is_free, discovery_source, metadata, id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24)
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
            JSON.stringify(tags),
            isFree,
            discoverySource,
            JSON.stringify(metadata),
            id,
        ]
    );
    return rows[0];
}

export async function createCascade(
    pool,
    {
        modelKey,
        displayName,
        enabled = true,
        maxAttempts = 5,
        discoverySource = 'manual',
        metadata = {},
    }
) {
    const id = randomUUID();
    const { rows } = await pool.query(
        `INSERT INTO ${TABLE}
       (model_key, display_name, enabled, strategy_kind, max_attempts,
        discovery_source, metadata, id)
     VALUES ($1, $2, $3, 'cascade', $4, $5, $6, $7)
     RETURNING *`,
        [
            modelKey,
            displayName,
            enabled,
            maxAttempts,
            discoverySource,
            JSON.stringify(metadata),
            id,
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
     LEFT JOIN providers p ON p.id = m.provider_id
     ${where}
     ORDER BY m.display_name ASC
     LIMIT $${idx++} OFFSET $${idx}`,
        params
    );
    return rows;
}

const ALLOWED_UPDATE_FIELDS = new Set([
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

const JSON_FIELDS = new Set([
    'rateLimitOverride',
    'budgetOverride',
    'loopOverride',
    'responseFilterOverride',
    'retryPolicy',
    'capabilities',
    'tags',
    'metadata',
]);

const ALLOWED_PROVIDER_SYNC_UPDATE_FIELDS = new Set([
    'displayName',
    'providerModelId',
    'executionKind',
    'pricingMode',
    'inputPricePerMillion',
    'outputPricePerMillion',
    'requestPriceUsd',
    'isFree',
    'capabilities',
    'tags',
    'metadata',
    'discoverySource',
]);

export async function update(pool, id, fields) {
    return updateRow(pool, TABLE, id, fields, {
        allowedFields: ALLOWED_UPDATE_FIELDS,
        jsonFields: JSON_FIELDS,
    });
}

export async function updateOperatorModel(pool, id, fields) {
    const keys = Object.keys(fields).filter((key) =>
        ALLOWED_UPDATE_FIELDS.has(key)
    );
    if (keys.length === 0) return null;

    const values = [];
    const setClauses = [];
    for (const key of keys) {
        const value =
            key === 'metadata' &&
            fields.metadata &&
            typeof fields.metadata === 'object' &&
            !Array.isArray(fields.metadata)
                ? { ...fields.metadata }
                : fields[key];
        if (
            key === 'metadata' &&
            value &&
            typeof value === 'object' &&
            !Array.isArray(value)
        ) {
            delete value.syncDisabled;
        }
        values.push(JSON_FIELDS.has(key) ? JSON.stringify(value) : value);
        const param = `$${values.length + 1}`;
        if (key === 'metadata') {
            setClauses.push(
                `metadata = json_remove(COALESCE(${param}, json_remove(metadata, '$.syncDisabled')), '$.syncDisabled')`
            );
        } else {
            setClauses.push(`${toSnake(key)} = ${param}`);
        }
    }

    if (!keys.includes('metadata')) {
        setClauses.push(`metadata = json_remove(metadata, '$.syncDisabled')`);
    }

    const { rows } = await pool.query(
        `UPDATE ${TABLE}
       SET ${setClauses.join(', ')},
           updated_at = now()
     WHERE id = $1
     RETURNING *`,
        [id, ...values]
    );
    return rows[0] || null;
}

export async function updateProviderSyncedModel(pool, id, fields) {
    const keys = Object.keys(fields).filter((key) =>
        ALLOWED_PROVIDER_SYNC_UPDATE_FIELDS.has(key)
    );
    if (keys.length === 0) return null;

    const values = [];
    const setClauses = [
        `enabled = CASE
            WHEN json_type(metadata, '$.syncDisabled') IS NOT NULL THEN true
            ELSE enabled
        END`,
    ];

    for (const key of keys) {
        const value = JSON_FIELDS.has(key)
            ? JSON.stringify(fields[key])
            : fields[key];
        values.push(value);
        const param = `$${values.length + 1}`;
        if (key === 'metadata') {
            setClauses.push(
                `metadata = CASE
                    WHEN json_type(metadata, '$.syncDisabled') IS NOT NULL THEN json_remove(${param}, '$.syncDisabled')
                    ELSE ${param}
                END`
            );
        } else {
            setClauses.push(`${toSnake(key)} = ${param}`);
        }
    }

    const { rows } = await pool.query(
        `UPDATE ${TABLE}
       SET ${setClauses.join(', ')},
           updated_at = now()
     WHERE id = $1
       AND discovery_source != 'manual'
     RETURNING *`,
        [id, ...values]
    );
    return rows[0] || null;
}

export async function disableMissingProviderSyncedModel(pool, id, syncDisabled) {
    const { rows } = await pool.query(
        `UPDATE ${TABLE}
       SET enabled = false,
           metadata = json_set(COALESCE(metadata, '{}'), '$.syncDisabled', json($2)),
           updated_at = now()
     WHERE id = $1
       AND enabled = true
       AND discovery_source != 'manual'
     RETURNING *`,
        [id, JSON.stringify(syncDisabled)]
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

export async function delByProvider(pool, providerId) {
    const { rowCount } = await pool.query(
        `DELETE FROM ${TABLE} WHERE provider_id = $1`,
        [providerId]
    );
    return rowCount;
}

export async function enable(pool, id) {
    const { rows } = await pool.query(
        `UPDATE ${TABLE}
       SET enabled = true,
           metadata = json_remove(metadata, '$.syncDisabled'),
           updated_at = now()
     WHERE id = $1
     RETURNING *`,
        [id]
    );
    return rows[0] || null;
}

export async function disable(pool, id) {
    const { rows } = await pool.query(
        `UPDATE ${TABLE}
       SET enabled = false,
           metadata = json_remove(metadata, '$.syncDisabled'),
           updated_at = now()
     WHERE id = $1
     RETURNING *`,
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
