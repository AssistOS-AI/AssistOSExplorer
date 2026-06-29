/**
 * MetricsService — aggregated dashboard metrics from audit_logs.
 *
 * started_at is stored as an ISO-8601 UTC string, so time bucketing uses
 * strftime over the column directly; no time-zone conversion is needed.
 */

const TABLE = 'audit_logs';

// Map a bucket unit to the SQLite expression that truncates an ISO-8601 UTC
// started_at to the start of its bucket, formatted in the same ISO shape so
// the dashboard receives the period labels it already expects.
function periodExpr(unit) {
    switch (unit) {
        case 'minute':
            return `strftime('%Y-%m-%dT%H:%M:00.000Z', started_at)`;
        case 'hour':
            return `strftime('%Y-%m-%dT%H:00:00.000Z', started_at)`;
        case 'week':
            return `strftime('%Y-%m-%dT00:00:00.000Z', date(started_at, 'weekday 1', '-7 days'))`;
        case 'day':
        default:
            return `strftime('%Y-%m-%dT00:00:00.000Z', started_at)`;
    }
}

export class MetricsService {
    constructor(pool) {
        this.pool = pool;
    }

    async getCostMetrics({ from, to, groupBy = 'day' }) {
        const period = periodExpr(
            groupBy === 'hour' ? 'hour' : groupBy === 'week' ? 'week' : 'day'
        );
        const { rows } = await this.pool.query(
            `
      SELECT
        ${period} AS period,
        requested_model,
        SUM(total_cost_usd) AS total_cost_usd,
        COUNT(*) AS request_count
      FROM ${TABLE}
      WHERE started_at >= $1 AND started_at < $2
        AND status = 'succeeded'
      GROUP BY 1, 2
      ORDER BY 1, 2
    `,
            [from, to]
        );
        return rows;
    }

    async getUsageMetrics({ from, to, groupBy = 'day' }) {
        const period = periodExpr(
            groupBy === 'hour' ? 'hour' : groupBy === 'week' ? 'week' : 'day'
        );
        const { rows } = await this.pool.query(
            `
      SELECT
        ${period} AS period,
        requested_model,
        COUNT(*) AS request_count,
        COALESCE(SUM(input_tokens), 0) AS input_tokens,
        COALESCE(SUM(output_tokens), 0) AS output_tokens,
        COALESCE(SUM(total_tokens), 0) AS total_tokens,
        SUM(CASE WHEN cache_hit THEN 1 ELSE 0 END) AS cache_hits
      FROM ${TABLE}
      WHERE started_at >= $1 AND started_at < $2
      GROUP BY 1, 2
      ORDER BY 1, 2
    `,
            [from, to]
        );
        return rows;
    }

    async getUsageDashboardMetrics({
        from,
        to,
        groupBy = 'day',
        model = null,
        apiKeyId = null,
    }) {
        const period = periodExpr(
            groupBy === 'hour' ? 'hour' : groupBy === 'week' ? 'week' : 'day'
        );
        const { where, params } = buildLogFilters({ from, to, model, apiKeyId });
        const [dailyResult, totalResult, modelResult, modelRequestsResult] =
            await Promise.all([
                this.pool.query(
                    `
      SELECT
        ${period} AS period,
        COALESCE(NULLIF(logs.requested_model, ''), 'unknown') AS resolved_model,
        COUNT(*) AS request_count,
        COALESCE(SUM(logs.input_tokens), 0) AS input_tokens,
        COALESCE(SUM(logs.output_tokens), 0) AS output_tokens,
        COALESCE(SUM(logs.total_tokens), 0) AS total_tokens,
        COALESCE(SUM(logs.input_cost_usd), 0) AS input_cost,
        COALESCE(SUM(logs.output_cost_usd), 0) AS output_cost,
        COALESCE(SUM(logs.total_cost_usd), 0) AS total_cost,
        COALESCE(SUM(CASE WHEN logs.cache_hit THEN 1 ELSE 0 END), 0) AS cache_hits
      FROM ${TABLE} logs
      ${where}
      GROUP BY 1, 2
      ORDER BY 1, 2
    `,
                    params
                ),
                this.pool.query(
                    `
      SELECT
        COUNT(*) AS request_count,
        COALESCE(SUM(logs.input_tokens), 0) AS input_tokens,
        COALESCE(SUM(logs.output_tokens), 0) AS output_tokens,
        COALESCE(SUM(logs.total_tokens), 0) AS total_tokens,
        COALESCE(SUM(logs.input_cost_usd), 0) AS input_cost,
        COALESCE(SUM(logs.output_cost_usd), 0) AS output_cost,
        COALESCE(SUM(logs.total_cost_usd), 0) AS total_cost,
        COALESCE(SUM(CASE WHEN logs.cache_hit THEN 1 ELSE 0 END), 0) AS cache_hits
      FROM ${TABLE} logs
      ${where}
    `,
                    params
                ),
                this.pool.query(
                    `
      SELECT DISTINCT
        COALESCE(NULLIF(logs.requested_model, ''), 'unknown') AS resolved_model
      FROM ${TABLE} logs
      ${where}
      ORDER BY 1
    `,
                    params
                ),
                this.pool.query(
                    `
      SELECT
        COALESCE(NULLIF(logs.requested_model, ''), 'unknown') AS resolved_model,
        logs.api_key_id,
        COALESCE(
          keys.label,
          CASE
            WHEN logs.api_key_id IS NULL THEN 'Unknown key'
            ELSE 'Missing key'
          END
        ) AS key_label,
        COALESCE(keys.key_hint, '') AS key_hint,
        COUNT(*) AS total,
        COALESCE(SUM(CASE WHEN logs.cache_hit THEN 1 ELSE 0 END), 0) AS cached,
        COALESCE(SUM(CASE WHEN logs.cache_hit THEN 0 ELSE 1 END), 0) AS non_cached
      FROM ${TABLE} logs
      LEFT JOIN api_keys keys
        ON keys.id = logs.api_key_id
      ${where}
      GROUP BY
        COALESCE(NULLIF(logs.requested_model, ''), 'unknown'),
        logs.api_key_id,
        keys.label,
        keys.key_hint
      ORDER BY total DESC, resolved_model ASC, key_label ASC
    `,
                    params
                ),
            ]);

        return {
            data: dailyResult.rows,
            total: totalResult.rows[0] || emptyUsageTotal(),
            models: modelResult.rows.map((row) => row.resolved_model),
            daily_by_model: dailyResult.rows,
            model_requests: modelRequestsResult.rows,
        };
    }

    async getErrorMetrics({ from, to }) {
        const params = [from, to];
        const ratePeriod = periodExpr('hour');
        const [summaryResult, breakdownResult, modelResult, ratesResult] =
            await Promise.all([
                this.pool.query(
                    `
      SELECT
        COUNT(*) AS total_requests,
        SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS error_count,
        SUM(CASE WHEN blocked THEN 1 ELSE 0 END) AS blocked_count,
        SUM(CASE WHEN http_status = 429 OR error_type = 'rate_limit_error' THEN 1 ELSE 0 END) AS rate_limited_count,
        SUM(CASE WHEN truncated THEN 1 ELSE 0 END) AS truncated_count,
        SUM(CASE WHEN slow THEN 1 ELSE 0 END) AS slow_count
      FROM ${TABLE}
      WHERE started_at >= $1 AND started_at < $2
    `,
                    params
                ),
                this.pool.query(
                    `
      SELECT
        COALESCE(NULLIF(error_type, ''), 'unknown') AS error_type,
        COUNT(*) AS count
      FROM ${TABLE}
      WHERE started_at >= $1 AND started_at < $2
        AND status = 'failed'
      GROUP BY 1
      ORDER BY COUNT(*) DESC, 1
    `,
                    params
                ),
                this.pool.query(
                    `
      SELECT
        requested_model,
        COUNT(*) AS error_count
      FROM ${TABLE}
      WHERE started_at >= $1 AND started_at < $2
        AND status = 'failed'
        AND requested_model IS NOT NULL
        AND requested_model <> ''
      GROUP BY 1
      ORDER BY COUNT(*) DESC, 1
    `,
                    params
                ),
                this.pool.query(
                    `
      SELECT
        ${ratePeriod} AS period,
        COALESCE(NULLIF(requested_model, ''), 'unknown') AS resolved_model,
        COUNT(*) AS error_count
      FROM ${TABLE}
      WHERE started_at >= $1 AND started_at < $2
        AND status = 'failed'
      GROUP BY 1, 2
      ORDER BY 1, 2
    `,
                    params
                ),
            ]);

        return {
            summary: summaryResult.rows[0] || {
                total_requests: 0,
                error_count: 0,
                blocked_count: 0,
                rate_limited_count: 0,
                truncated_count: 0,
                slow_count: 0,
            },
            breakdown: breakdownResult.rows,
            models: modelResult.rows.map((row) => row.requested_model),
            rates: ratesResult.rows,
        };
    }

    async getActivityMetrics({ from, to, bucket = 'minute' }) {
        const period = periodExpr(
            bucket === 'hour' ? 'hour' : bucket === 'day' ? 'day' : 'minute'
        );
        const { rows } = await this.pool.query(
            `
      SELECT
        ${period} AS period,
        SUM(CASE WHEN status = 'succeeded' THEN 1 ELSE 0 END) AS succeeded,
        SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed,
        SUM(CASE WHEN status = 'aborted' THEN 1 ELSE 0 END) AS aborted,
        COUNT(*) AS total
      FROM ${TABLE}
      WHERE started_at >= $1 AND started_at < $2
      GROUP BY 1
      ORDER BY 1
    `,
            [from, to]
        );
        return rows;
    }

    async getActivityDashboardMetrics({ from, to, bucket = 'minute' }) {
        const [data, byKeyResult] = await Promise.all([
            this.getActivityMetrics({ from, to, bucket }),
            this.pool.query(
                `
      SELECT
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
        keys.daily_budget_usd,
        keys.monthly_budget_usd,
        COALESCE(keys.monthly_budget_usd, keys.daily_budget_usd) AS key_budget,
        COUNT(*) AS request_count,
        SUM(CASE WHEN logs.status <> 'succeeded' THEN 1 ELSE 0 END) AS error_count,
        COALESCE(SUM(logs.input_tokens), 0) AS prompt_tokens,
        COALESCE(SUM(logs.output_tokens), 0) AS completion_tokens,
        COALESCE(SUM(logs.total_tokens), 0) AS total_tokens,
        COALESCE(SUM(logs.input_cost_usd), 0) AS input_cost,
        COALESCE(SUM(logs.output_cost_usd), 0) AS output_cost,
        COALESCE(SUM(logs.total_cost_usd), 0) AS total_cost,
        MAX(logs.started_at) AS last_activity
      FROM ${TABLE} logs
      LEFT JOIN api_keys keys
        ON keys.id = logs.api_key_id
      WHERE logs.started_at >= $1 AND logs.started_at < $2
      GROUP BY
        logs.api_key_id,
        keys.label,
        keys.key_hint,
        keys.status,
        keys.daily_budget_usd,
        keys.monthly_budget_usd
      ORDER BY last_activity DESC NULLS LAST, request_count DESC, key_label ASC
    `,
                [from, to]
            ),
        ]);

        return {
            data,
            by_key: byKeyResult.rows,
        };
    }

    async getTokenMetrics({ from, to, groupBy = 'day' }) {
        const period = periodExpr(
            groupBy === 'hour' ? 'hour' : groupBy === 'week' ? 'week' : 'day'
        );
        const { rows } = await this.pool.query(
            `
      SELECT
        ${period} AS period,
        COALESCE(SUM(input_tokens), 0) AS input_tokens,
        COALESCE(SUM(output_tokens), 0) AS output_tokens,
        COALESCE(SUM(total_tokens), 0) AS total_tokens
      FROM ${TABLE}
      WHERE started_at >= $1 AND started_at < $2
        AND status = 'succeeded'
      GROUP BY 1
      ORDER BY 1
    `,
            [from, to]
        );
        return rows;
    }
}

function buildLogFilters({ from, to, model = null, apiKeyId = null }) {
    const conditions = ['logs.started_at >= $1', 'logs.started_at < $2'];
    const params = [from, to];
    let idx = 3;

    if (hasValue(model)) {
        conditions.push(`logs.requested_model = $${idx++}`);
        params.push(model);
    }
    if (hasValue(apiKeyId)) {
        conditions.push(`logs.api_key_id = $${idx++}`);
        params.push(apiKeyId);
    }

    return {
        where: `WHERE ${conditions.join(' AND ')}`,
        params,
    };
}

function hasValue(value) {
    return (
        value !== undefined &&
        value !== null &&
        value !== '' &&
        value !== 'undefined' &&
        value !== 'null'
    );
}

function emptyUsageTotal() {
    return {
        request_count: 0,
        input_tokens: 0,
        output_tokens: 0,
        total_tokens: 0,
        input_cost: 0,
        output_cost: 0,
        total_cost: 0,
        cache_hits: 0,
    };
}
