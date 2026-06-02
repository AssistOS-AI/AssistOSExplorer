/**
 * DAO for the audit_logs partitioned table.
 * Pure data-access functions — no business logic.
 */
import { randomUUID } from 'node:crypto';
import { toSnake } from './helpers/case-convert.mjs';

const TABLE = 'audit_logs';

const INSERTABLE_FIELDS = [
    'startedAt',
    'requestId',
    'requestFormat',
    'status',
    'apiKeyId',
    'soulId',
    'agentName',
    'userAgent',
    'sessionId',
    'requestedModel',
    'resolvedModelId',
    'resolvedProviderId',
    'tierId',
    'providerAccountId',
    'httpStatus',
    'errorType',
    'errorMessage',
    'retryable',
    'cascaded',
    'cacheHit',
    'blocked',
    'loopDetected',
    'truncated',
    'slow',
    'oversized',
    'streaming',
    'queueWaitMs',
    'latencyMs',
    'ttfbMs',
    'completedAt',
    'attemptCount',
    'retryTrace',
    'middlewareTrace',
    'requestHeaders',
    'requestPayload',
    'responsePayload',
    'responseExcerpt',
    'responseFingerprint',
    'inputTokens',
    'outputTokens',
    'totalTokens',
    'inputCostUsd',
    'outputCostUsd',
    'totalCostUsd',
    'budgetExempt',
    'flags',
    'metadata',
];

const JSON_FIELDS = new Set([
    'retryTrace',
    'middlewareTrace',
    'requestHeaders',
    'requestPayload',
    'responsePayload',
    'flags',
    'metadata',
]);

const REQUIRED_COMPLETED_FIELDS = [
    'startedAt',
    'requestId',
    'requestFormat',
    'status',
    'apiKeyId',
    'requestedModel',
];

/**
 * Insert the initial "in_progress" audit log row when a request starts.
 */
export async function insertStart(
    pool,
    {
        startedAt,
        requestId,
        requestFormat,
        apiKeyId,
        soulId = null,
        agentName = null,
        userAgent = null,
        sessionId = null,
        requestedModel,
        streaming = false,
        requestHeaders = {},
        requestPayload = {},
    }
) {
    const { rows } = await pool.query(
        `INSERT INTO ${TABLE}
       (started_at, request_id, request_format, status,
        api_key_id, soul_id, agent_name, user_agent,
        session_id, requested_model, streaming,
        request_headers, request_payload, log_id)
     VALUES ($1, $2, $3, 'in_progress', $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
     RETURNING *`,
        [
            startedAt,
            requestId,
            requestFormat,
            apiKeyId,
            soulId,
            agentName,
            userAgent,
            sessionId,
            requestedModel,
            streaming,
            JSON.stringify(requestHeaders),
            JSON.stringify(requestPayload),
            randomUUID(),
        ]
    );
    return rows[0];
}

/**
 * Insert one completed audit log row after the request finishes or fails.
 */
export async function insertCompleted(pool, fields) {
    for (const key of REQUIRED_COMPLETED_FIELDS) {
        if (fields[key] == null) {
            throw new Error(`insertCompleted missing required field: ${key}`);
        }
    }

    const keys = INSERTABLE_FIELDS.filter(
        (key) => Object.hasOwn(fields, key) && fields[key] !== undefined
    );
    const columns = [];
    const placeholders = [];
    const values = [];

    for (const key of keys) {
        columns.push(toSnake(key));
        placeholders.push(`$${values.length + 1}`);
        values.push(JSON_FIELDS.has(key) ? JSON.stringify(fields[key]) : fields[key]);
    }

    // SQLite has no DB-side id default; generate the audit row's log_id here.
    columns.push('log_id');
    placeholders.push(`$${values.length + 1}`);
    values.push(fields.logId || randomUUID());

    const { rows } = await pool.query(
        `INSERT INTO ${TABLE}
       (${columns.join(', ')})
     VALUES (${placeholders.join(', ')})
     RETURNING *`,
        values
    );
    return rows[0];
}

/**
 * Finalize an audit log row after the request completes or fails.
 * Uses the composite PK (started_at, log_id) for the update.
 */
const ALLOWED_FINALIZE_FIELDS = new Set([
    'status', 'httpStatus', 'errorType', 'errorMessage',
    'latencyMs', 'ttfbMs', 'inputTokens', 'outputTokens', 'totalTokens',
    'inputCostUsd', 'outputCostUsd', 'totalCostUsd', 'budgetExempt',
    'cacheHit', 'blocked', 'cascaded', 'streaming', 'queueWaitMs',
    'resolvedModelId', 'resolvedProviderId', 'providerAccountId',
    'completedAt',
    'responseExcerpt', 'retryTrace', 'middlewareTrace',
    'responsePayload', 'flags', 'metadata',
    'apiKeyId', 'soulId', 'agentName', 'sessionId', 'requestedModel',
]);

export async function finalize(pool, startedAt, logId, fields) {
    const keys = Object.keys(fields).filter((k) => ALLOWED_FINALIZE_FIELDS.has(k));
    if (keys.length === 0) return null;

    const setClauses = [];
    const values = [startedAt, logId];
    let idx = 3;

    for (const k of keys) {
        setClauses.push(`${toSnake(k)} = $${idx++}`);
        values.push(JSON_FIELDS.has(k) ? JSON.stringify(fields[k]) : fields[k]);
    }

    const { rows } = await pool.query(
        `UPDATE ${TABLE}
     SET ${setClauses.join(', ')}
     WHERE started_at = $1 AND log_id = $2
     RETURNING *`,
        values
    );
    return rows[0] || null;
}

export async function findByRequestId(pool, requestId) {
    const { rows } = await pool.query(
        `SELECT * FROM ${TABLE} WHERE request_id = $1 ORDER BY started_at DESC`,
        [requestId]
    );
    return rows;
}

/**
 * Flexible query with filters for the logs listing API.
 * Supported filters: soulId, model, from, to, status, errorType,
 * keyword, sessionId, agentName, apiKeyId
 */
export async function query(
    pool,
    filters = {},
    { limit = 50, offset = 0, sort = 'started_at', order = 'DESC' } = {}
) {
    const { conditions, params, idx } = buildFilterClauses(filters);

    const allowedSorts = new Set([
        'started_at',
        'latency_ms',
        'total_cost_usd',
        'total_tokens',
        'requested_model',
    ]);
    const sortCol = allowedSorts.has(sort) ? sort : 'started_at';
    const sortDir = order.toUpperCase() === 'ASC' ? 'ASC' : 'DESC';
    const orderBy = [`${sortCol} ${sortDir}`];
    if (sortCol !== 'started_at') {
        orderBy.push(`started_at ${sortDir}`);
    }
    orderBy.push(`log_id ${sortDir}`);

    const where =
        conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    params.push(limit, offset);

    const { rows } = await pool.query(
        `SELECT * FROM ${TABLE} ${where}
     ORDER BY ${orderBy.join(', ')}
     LIMIT $${idx} OFFSET $${idx + 1}`,
        params
    );
    return rows;
}

/**
 * Count matching rows for the same filters as query().
 */
export async function countByFilters(pool, filters = {}) {
    const { conditions, params } = buildFilterClauses(filters);
    const where =
        conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    const { rows } = await pool.query(
        `SELECT COUNT(*) AS total FROM ${TABLE} ${where}`,
        params
    );
    return rows[0].total;
}

export async function summarizeByApiKey(pool, filters = {}) {
    const { conditions, params } = buildFilterClauses(filters);
    const where =
        conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    const { rows } = await pool.query(
        `SELECT
           logs.api_key_id,
           COALESCE(
             keys.label,
             CASE
               WHEN logs.api_key_id IS NULL THEN 'Unknown key'
               ELSE 'Missing key'
             END
           ) AS key_label,
           COALESCE(keys.key_hint, '') AS key_hint,
           COALESCE(keys.status, 'unknown') AS key_status,
           COUNT(*) AS request_count,
           SUM(CASE WHEN logs.status <> 'succeeded' THEN 1 ELSE 0 END) AS error_count,
           COALESCE(SUM(logs.total_cost_usd), 0) AS total_cost,
           MAX(logs.started_at) AS last_activity
         FROM ${TABLE} logs
         LEFT JOIN api_keys keys
           ON keys.id = logs.api_key_id
         ${where}
         GROUP BY logs.api_key_id, keys.label, keys.key_hint, keys.status
         ORDER BY last_activity DESC NULLS LAST, request_count DESC, key_label ASC`,
        params
    );
    return rows;
}

/**
 * SQLite stores audit logs in a single table; there is no monthly partition
 * to create. Kept as a no-op returning the table name so callers that expected
 * a partition name during the partitioned-table era keep working.
 */
export async function ensurePartition() {
    return 'audit_logs';
}

/**
 * Delete audit rows older than the given retention cutoff date.
 * Returns ['audit_logs'] when rows were removed, [] otherwise, mirroring the
 * old "dropped partitions" contract for callers/logs.
 */
export async function dropExpiredPartitions(pool, cutoffDate) {
    const result = await pool.query(
        `DELETE FROM ${TABLE} WHERE started_at < $1`,
        [cutoffDate.toISOString()]
    );
    return result.rowCount > 0 ? ['audit_logs'] : [];
}

// ── internal helpers ─────────────────────────────────────────────────

function buildFilterClauses(filters) {
    const conditions = [];
    const params = [];
    let idx = 1;

    if (filters.soulId) {
        conditions.push(`soul_id = $${idx++}`);
        params.push(filters.soulId);
    }
    if (filters.model) {
        conditions.push(`requested_model = $${idx++}`);
        params.push(filters.model);
    }
    if (filters.from) {
        conditions.push(`started_at >= $${idx++}`);
        params.push(filters.from);
    }
    if (filters.to) {
        conditions.push(`started_at <= $${idx++}`);
        params.push(filters.to);
    }
    if (filters.status) {
        conditions.push(`status = $${idx++}`);
        params.push(filters.status);
    }
    if (filters.errorType) {
        conditions.push(`error_type = $${idx++}`);
        params.push(filters.errorType);
    }
    if (filters.keyword) {
        conditions.push(
            `(response_excerpt LIKE $${idx} COLLATE NOCASE OR error_message LIKE $${idx} COLLATE NOCASE)`
        );
        params.push(`%${filters.keyword}%`);
        idx++;
    }
    if (filters.sessionId) {
        conditions.push(`session_id = $${idx++}`);
        params.push(filters.sessionId);
    }
    if (filters.agentName) {
        conditions.push(`agent_name = $${idx++}`);
        params.push(filters.agentName);
    }
    if (filters.apiKeyId) {
        conditions.push(`api_key_id = $${idx++}`);
        params.push(filters.apiKeyId);
    }

    return { conditions, params, idx };
}
