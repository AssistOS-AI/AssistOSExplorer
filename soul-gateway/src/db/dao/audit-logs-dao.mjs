/**
 * DAO for the audit_logs partitioned table.
 * Pure data-access functions — no business logic.
 */
import { toSnake } from './helpers/case-convert.mjs';

const TABLE = 'soul_gateway.audit_logs';

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
        request_headers, request_payload)
     VALUES ($1, $2, $3, 'in_progress', $4, $5, $6, $7, $8, $9, $10, $11, $12)
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
        ]
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

    const jsonFields = new Set([
        'retryTrace',
        'middlewareTrace',
        'responsePayload',
        'flags',
        'metadata',
    ]);

    const setClauses = [];
    const values = [startedAt, logId];
    let idx = 3;

    for (const k of keys) {
        setClauses.push(`${toSnake(k)} = $${idx++}`);
        values.push(jsonFields.has(k) ? JSON.stringify(fields[k]) : fields[k]);
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
        `SELECT COUNT(*)::int AS total FROM ${TABLE} ${where}`,
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
           COUNT(*)::int AS request_count,
           COUNT(*) FILTER (WHERE logs.status <> 'succeeded')::int AS error_count,
           COALESCE(SUM(logs.total_cost_usd), 0)::float AS total_cost,
           MAX(logs.started_at) AS last_activity
         FROM ${TABLE} logs
         LEFT JOIN soul_gateway.api_keys keys
           ON keys.id = logs.api_key_id
         ${where}
         GROUP BY logs.api_key_id, keys.label, keys.key_hint, keys.status
         ORDER BY last_activity DESC NULLS LAST, request_count DESC, key_label ASC`,
        params
    );
    return rows;
}

/**
 * Ensure a monthly partition exists for the given date.
 * Partitions are named audit_logs_YYYY_MM.
 */
export async function ensurePartition(pool, date) {
    const year = date.getUTCFullYear();
    const month = String(date.getUTCMonth() + 1).padStart(2, '0');
    const partName = `audit_logs_${year}_${month}`;

    const nextMonth = new Date(Date.UTC(year, date.getUTCMonth() + 1, 1));
    const fromStr = `${year}-${month}-01`;
    const toStr = `${nextMonth.getUTCFullYear()}-${String(nextMonth.getUTCMonth() + 1).padStart(2, '0')}-01`;

    await pool.query(
        `CREATE TABLE IF NOT EXISTS soul_gateway.${partName}
     PARTITION OF ${TABLE}
     FOR VALUES FROM ('${fromStr}') TO ('${toStr}')`
    );
    return partName;
}

/**
 * Drop partitions older than the given retention cutoff date.
 * Returns the names of dropped partitions.
 */
export async function dropExpiredPartitions(pool, cutoffDate) {
    const { rows } = await pool.query(
        `SELECT schemaname, tablename FROM pg_tables
     WHERE schemaname = 'soul_gateway'
       AND tablename LIKE 'audit_logs_%'
     ORDER BY tablename ASC`
    );

    const cutoffYear = cutoffDate.getUTCFullYear();
    const cutoffMonth = cutoffDate.getUTCMonth() + 1;
    const dropped = [];

    for (const row of rows) {
        const match = row.tablename.match(/^audit_logs_(\d{4})_(\d{2})$/);
        if (!match) continue;

        const partYear = parseInt(match[1], 10);
        const partMonth = parseInt(match[2], 10);

        if (
            partYear < cutoffYear ||
            (partYear === cutoffYear && partMonth < cutoffMonth)
        ) {
            await pool.query(
                `DROP TABLE IF EXISTS soul_gateway.${row.tablename}`
            );
            dropped.push(row.tablename);
        }
    }

    return dropped;
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
            `(response_excerpt ILIKE $${idx} OR error_message ILIKE $${idx})`
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
