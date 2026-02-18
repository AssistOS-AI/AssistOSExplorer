import { query } from './init.mjs';

export async function getCostsByFamily({ from, to }) {
  const conditions = [];
  const params = [];
  let idx = 1;
  if (from) { conditions.push(`started_at >= $${idx++}`); params.push(from); }
  if (to) { conditions.push(`started_at <= $${idx++}`); params.push(to); }
  const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';

  const { rows } = await query(`
    SELECT family_name,
           SUM(total_cost) as total_cost,
           SUM(input_cost) as input_cost,
           SUM(output_cost) as output_cost,
           SUM(total_tokens) as total_tokens,
           SUM(prompt_tokens) as prompt_tokens,
           SUM(completion_tokens) as completion_tokens,
           COUNT(*) as request_count
    FROM call_logs ${where}
    GROUP BY family_name
    ORDER BY total_cost DESC
  `, params);
  return rows;
}

export async function getCostsByModel({ from, to }) {
  const conditions = [];
  const params = [];
  let idx = 1;
  if (from) { conditions.push(`started_at >= $${idx++}`); params.push(from); }
  if (to) { conditions.push(`started_at <= $${idx++}`); params.push(to); }
  const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';

  const { rows } = await query(`
    SELECT resolved_model,
           SUM(total_cost) as total_cost,
           SUM(total_tokens) as total_tokens,
           COUNT(*) as request_count
    FROM call_logs ${where}
    GROUP BY resolved_model
    ORDER BY total_cost DESC
  `, params);
  return rows;
}

export async function getCostTrend({ from, to, granularity }) {
  const conditions = [];
  const params = [];
  let idx = 1;
  if (from) { conditions.push(`started_at >= $${idx++}`); params.push(from); }
  if (to) { conditions.push(`started_at <= $${idx++}`); params.push(to); }
  const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';

  const trunc = granularity === 'hour' ? 'hour' : granularity === 'week' ? 'week' : 'day';
  const { rows } = await query(`
    SELECT date_trunc('${trunc}', started_at) as period,
           family_name,
           SUM(total_cost) as total_cost,
           SUM(total_tokens) as total_tokens,
           COUNT(*) as request_count
    FROM call_logs ${where}
    GROUP BY period, family_name
    ORDER BY period ASC
  `, params);
  return rows;
}

export async function getErrorRates({ from, to }) {
  const conditions = ['error_type IS NOT NULL'];
  const params = [];
  let idx = 1;
  if (from) { conditions.push(`started_at >= $${idx++}`); params.push(from); }
  if (to) { conditions.push(`started_at <= $${idx++}`); params.push(to); }
  const where = 'WHERE ' + conditions.join(' AND ');

  const { rows } = await query(`
    SELECT resolved_model,
           error_type,
           COUNT(*) as error_count,
           date_trunc('hour', started_at) as period
    FROM call_logs ${where}
    GROUP BY resolved_model, error_type, period
    ORDER BY period DESC
  `, params);
  return rows;
}

export async function getErrorSummary({ from, to }) {
  const conditions = [];
  const params = [];
  let idx = 1;
  if (from) { conditions.push(`started_at >= $${idx++}`); params.push(from); }
  if (to) { conditions.push(`started_at <= $${idx++}`); params.push(to); }
  const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';

  const { rows } = await query(`
    SELECT
      COUNT(*) as total_requests,
      COUNT(*) FILTER (WHERE error_type IS NOT NULL) as error_count,
      COUNT(*) FILTER (WHERE blocked_by_blacklist = true) as blocked_count,
      COUNT(*) FILTER (WHERE is_truncated = true) as truncated_count,
      COUNT(*) FILTER (WHERE is_slow = true) as slow_count,
      COUNT(*) FILTER (WHERE status_code = 429) as rate_limited_count
    FROM call_logs ${where}
  `, params);
  return rows[0];
}

export async function getTokenTrend({ from, to }) {
  const conditions = [];
  const params = [];
  let idx = 1;
  if (from) { conditions.push(`started_at >= $${idx++}`); params.push(from); }
  if (to) { conditions.push(`started_at <= $${idx++}`); params.push(to); }
  const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';

  const { rows } = await query(`
    SELECT date_trunc('day', started_at) as period,
           family_name,
           SUM(prompt_tokens) as prompt_tokens,
           SUM(completion_tokens) as completion_tokens,
           SUM(total_tokens) as total_tokens
    FROM call_logs ${where}
    GROUP BY period, family_name
    ORDER BY period ASC
  `, params);
  return rows;
}
