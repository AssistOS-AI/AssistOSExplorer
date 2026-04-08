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
        const { rows } = await this.pool.query(
            `
      SELECT
        date_trunc('hour', started_at AT TIME ZONE 'UTC') AS hour_utc,
        error_type,
        COUNT(*) AS error_count
      FROM soul_gateway.audit_logs
      WHERE started_at >= $1 AND started_at < $2
        AND status = 'failed'
      GROUP BY 1, 2
      ORDER BY 1, 2
    `,
            [from, to]
        );
        return rows;
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
