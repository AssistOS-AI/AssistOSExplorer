import { query } from './init.mjs';

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
           SUM(total_cost) as total_cost,
           SUM(total_tokens) as total_tokens,
           COUNT(*) as request_count
    FROM call_logs ${where}
    GROUP BY period
    ORDER BY period ASC
  `, params);
  return rows;
}

export async function getDailyCostByModel({ from, to, model, api_key_id }) {
  const conditions = [];
  const params = [];
  let idx = 1;
  if (from) { conditions.push(`started_at >= $${idx++}`); params.push(from); }
  if (to) { conditions.push(`started_at <= $${idx++}`); params.push(to); }
  if (model) { conditions.push(`resolved_model = $${idx++}`); params.push(model); }
  if (api_key_id) { conditions.push(`api_key_id = $${idx++}`); params.push(api_key_id); }
  const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';

  const { rows } = await query(`
    SELECT date_trunc('day', started_at) as period,
           resolved_model,
           SUM(total_cost) as total_cost
    FROM call_logs ${where}
    GROUP BY period, resolved_model
    ORDER BY period ASC
  `, params);
  return rows;
}

export async function getMonthTotal({ from, to, model, api_key_id }) {
  const conditions = [];
  const params = [];
  let idx = 1;
  if (from) { conditions.push(`started_at >= $${idx++}`); params.push(from); }
  if (to) { conditions.push(`started_at <= $${idx++}`); params.push(to); }
  if (model) { conditions.push(`resolved_model = $${idx++}`); params.push(model); }
  if (api_key_id) { conditions.push(`api_key_id = $${idx++}`); params.push(api_key_id); }
  const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';

  const { rows } = await query(`
    SELECT COALESCE(SUM(total_cost), 0) as total_cost,
           COALESCE(SUM(total_tokens), 0) as total_tokens,
           COUNT(*) as request_count
    FROM call_logs ${where}
  `, params);
  return rows[0];
}

export async function getDistinctModels({ from, to }) {
  const conditions = ['resolved_model IS NOT NULL'];
  const params = [];
  let idx = 1;
  if (from) { conditions.push(`started_at >= $${idx++}`); params.push(from); }
  if (to) { conditions.push(`started_at <= $${idx++}`); params.push(to); }
  const where = 'WHERE ' + conditions.join(' AND ');

  const { rows } = await query(`
    SELECT DISTINCT resolved_model FROM call_logs ${where} ORDER BY resolved_model
  `, params);
  return rows.map(r => r.resolved_model);
}

export async function getErrorBreakdown({ from, to }) {
  const conditions = ['error_type IS NOT NULL'];
  const params = [];
  let idx = 1;
  if (from) { conditions.push(`started_at >= $${idx++}`); params.push(from); }
  if (to) { conditions.push(`started_at <= $${idx++}`); params.push(to); }
  const where = 'WHERE ' + conditions.join(' AND ');

  const { rows } = await query(`
    SELECT error_type, COUNT(*) as count
    FROM call_logs ${where}
    GROUP BY error_type
    ORDER BY count DESC
  `, params);
  return rows;
}

export async function getErrorModels({ from, to }) {
  const conditions = ['error_type IS NOT NULL'];
  const params = [];
  let idx = 1;
  if (from) { conditions.push(`started_at >= $${idx++}`); params.push(from); }
  if (to) { conditions.push(`started_at <= $${idx++}`); params.push(to); }
  const where = 'WHERE ' + conditions.join(' AND ');

  const { rows } = await query(`
    SELECT DISTINCT resolved_model
    FROM call_logs ${where}
    ORDER BY resolved_model
  `, params);
  return rows.map(r => r.resolved_model).filter(Boolean);
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

export async function getCostsByKey({ from, to }) {
  const conditions = [];
  const params = [];
  let idx = 1;
  if (from) { conditions.push(`cl.started_at >= $${idx++}`); params.push(from); }
  if (to) { conditions.push(`cl.started_at <= $${idx++}`); params.push(to); }
  const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';

  const { rows } = await query(`
    SELECT cl.api_key_id,
           k.label as key_label,
           k.key_hint,
           k.monthly_budget as key_budget,
           SUM(cl.total_cost) as total_cost,
           SUM(cl.input_cost) as input_cost,
           SUM(cl.output_cost) as output_cost,
           SUM(cl.total_tokens) as total_tokens,
           SUM(cl.prompt_tokens) as prompt_tokens,
           SUM(cl.completion_tokens) as completion_tokens,
           COUNT(*) as request_count,
           COUNT(*) FILTER (WHERE cl.error_type IS NOT NULL) as error_count
    FROM call_logs cl
    JOIN api_keys k ON cl.api_key_id = k.id
    ${where}
    GROUP BY cl.api_key_id, k.label, k.key_hint, k.monthly_budget
    ORDER BY total_cost DESC
  `, params);
  return rows;
}

export async function getKeyTrend({ from, to }) {
  const conditions = [];
  const params = [];
  let idx = 1;
  if (from) { conditions.push(`cl.started_at >= $${idx++}`); params.push(from); }
  if (to) { conditions.push(`cl.started_at <= $${idx++}`); params.push(to); }
  const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';

  const { rows } = await query(`
    SELECT date_trunc('day', cl.started_at) as period,
           cl.api_key_id,
           k.label as key_label,
           k.key_hint,
           SUM(cl.total_cost) as total_cost,
           SUM(cl.total_tokens) as total_tokens,
           COUNT(*) as request_count
    FROM call_logs cl
    JOIN api_keys k ON cl.api_key_id = k.id
    ${where}
    GROUP BY period, cl.api_key_id, k.label, k.key_hint
    ORDER BY period ASC
  `, params);
  return rows;
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
           SUM(prompt_tokens) as prompt_tokens,
           SUM(completion_tokens) as completion_tokens,
           SUM(total_tokens) as total_tokens
    FROM call_logs ${where}
    GROUP BY period
    ORDER BY period ASC
  `, params);
  return rows;
}

export async function getModelRequestStats({ from, to, model, api_key_id }) {
  const conditions = ['cl.resolved_model IS NOT NULL'];
  const params = [];
  let idx = 1;
  if (from) { conditions.push(`cl.started_at >= $${idx++}`); params.push(from); }
  if (to) { conditions.push(`cl.started_at <= $${idx++}`); params.push(to); }
  if (model) { conditions.push(`cl.resolved_model = $${idx++}`); params.push(model); }
  if (api_key_id) { conditions.push(`cl.api_key_id = $${idx++}`); params.push(api_key_id); }
  const where = 'WHERE ' + conditions.join(' AND ');

  const { rows } = await query(`
    SELECT cl.resolved_model,
           cl.api_key_id,
           k.label as key_label,
           k.key_hint,
           COUNT(*)::int as total,
           COUNT(*) FILTER (WHERE cl.cache_hit = true)::int as cached,
           COUNT(*) FILTER (WHERE cl.cache_hit = false OR cl.cache_hit IS NULL)::int as non_cached
    FROM call_logs cl
    LEFT JOIN api_keys k ON cl.api_key_id = k.id
    ${where}
    GROUP BY cl.resolved_model, cl.api_key_id, k.label, k.key_hint
    ORDER BY non_cached DESC
  `, params);
  return rows;
}
