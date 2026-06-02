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
