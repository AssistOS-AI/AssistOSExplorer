/**
 * MetricsService — aggregated dashboard metrics from audit_logs.
 */
export class MetricsService {
    constructor(pool) {
        this.pool = pool;
    }

    async getCostMetrics({ from, to, groupBy = 'day' }) {
        const trunc =
            groupBy === 'hour' ? 'hour' : groupBy === 'week' ? 'week' : 'day';
        const { rows } = await this.pool.query(
            `
      SELECT
        date_trunc($3, started_at AT TIME ZONE 'UTC') AS period,
        requested_model,
        SUM(total_cost_usd) AS total_cost_usd,
        COUNT(*) AS request_count
      FROM soul_gateway.audit_logs
      WHERE started_at >= $1 AND started_at < $2
        AND status = 'succeeded'
      GROUP BY 1, 2
      ORDER BY 1, 2
    `,
            [from, to, trunc]
        );
        return rows;
    }

    async getUsageMetrics({ from, to, groupBy = 'day' }) {
        const trunc =
            groupBy === 'hour' ? 'hour' : groupBy === 'week' ? 'week' : 'day';
        const { rows } = await this.pool.query(
            `
      SELECT
        date_trunc($3, started_at AT TIME ZONE 'UTC') AS period,
        requested_model,
        COUNT(*) AS request_count,
        COALESCE(SUM(input_tokens), 0) AS input_tokens,
        COALESCE(SUM(output_tokens), 0) AS output_tokens,
        COALESCE(SUM(total_tokens), 0) AS total_tokens,
        COUNT(*) FILTER (WHERE cache_hit = true) AS cache_hits
      FROM soul_gateway.audit_logs
      WHERE started_at >= $1 AND started_at < $2
      GROUP BY 1, 2
      ORDER BY 1, 2
    `,
            [from, to, trunc]
        );
        return rows;
    }

    async getErrorMetrics({ from, to }) {
        const params = [from, to];
        const [summaryResult, breakdownResult, modelResult, ratesResult] =
            await Promise.all([
                this.pool.query(
                    `
      SELECT
        COUNT(*) AS total_requests,
        COUNT(*) FILTER (WHERE status = 'failed') AS error_count,
        COUNT(*) FILTER (WHERE blocked = true) AS blocked_count,
        COUNT(*) FILTER (
          WHERE http_status = 429
             OR error_type = 'rate_limit_error'
        ) AS rate_limited_count,
        COUNT(*) FILTER (WHERE truncated = true) AS truncated_count,
        COUNT(*) FILTER (WHERE slow = true) AS slow_count
      FROM soul_gateway.audit_logs
      WHERE started_at >= $1 AND started_at < $2
    `,
                    params
                ),
                this.pool.query(
                    `
      SELECT
        COALESCE(NULLIF(error_type, ''), 'unknown') AS error_type,
        COUNT(*) AS count
      FROM soul_gateway.audit_logs
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
      FROM soul_gateway.audit_logs
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
        date_trunc('hour', started_at AT TIME ZONE 'UTC') AS period,
        COALESCE(NULLIF(requested_model, ''), 'unknown') AS resolved_model,
        COUNT(*) AS error_count
      FROM soul_gateway.audit_logs
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
        const trunc =
            bucket === 'hour' ? 'hour' : bucket === 'day' ? 'day' : 'minute';
        const { rows } = await this.pool.query(
            `
      SELECT
        date_trunc($3, started_at AT TIME ZONE 'UTC') AS period,
        COUNT(*) FILTER (WHERE status = 'succeeded') AS succeeded,
        COUNT(*) FILTER (WHERE status = 'failed') AS failed,
        COUNT(*) FILTER (WHERE status = 'aborted') AS aborted,
        COUNT(*) AS total
      FROM soul_gateway.audit_logs
      WHERE started_at >= $1 AND started_at < $2
      GROUP BY 1
      ORDER BY 1
    `,
            [from, to, trunc]
        );
        return rows;
    }

    async getTokenMetrics({ from, to, groupBy = 'day' }) {
        const trunc =
            groupBy === 'hour' ? 'hour' : groupBy === 'week' ? 'week' : 'day';
        const { rows } = await this.pool.query(
            `
      SELECT
        date_trunc($3, started_at AT TIME ZONE 'UTC') AS period,
        COALESCE(SUM(input_tokens), 0) AS input_tokens,
        COALESCE(SUM(output_tokens), 0) AS output_tokens,
        COALESCE(SUM(total_tokens), 0) AS total_tokens
      FROM soul_gateway.audit_logs
      WHERE started_at >= $1 AND started_at < $2
        AND status = 'succeeded'
      GROUP BY 1
      ORDER BY 1
    `,
            [from, to, trunc]
        );
        return rows;
    }
}
