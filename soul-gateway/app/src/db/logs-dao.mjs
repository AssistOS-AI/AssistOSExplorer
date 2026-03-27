import { query } from './init.mjs';

const SORTABLE_COLUMNS = new Set([
  'started_at', 'resolved_model', 'latency_ms',
  'total_tokens', 'total_cost', 'status_code',
  'prompt_tokens', 'completion_tokens',
]);

export async function insertLog(log) {
  const { rows } = await query(`
    INSERT INTO call_logs (
      soul_id, api_key_id,
      agent_name, session_id,
      requested_model, resolved_model, mode, is_streaming,
      request_messages, request_size_bytes,
      response_content, status_code, stop_reason, error_type, error_message,
      response_size_bytes, latency_ms, ttfb_ms,
      prompt_tokens, completion_tokens, total_tokens,
      input_cost, output_cost, total_cost,
      retry_count, retry_reason, retries_detail,
      blocked_by_blacklist, blacklist_rule_id, blacklist_match,
      is_truncated, is_slow, prompt_size_warning,
      prompt_hash, cache_hit, is_free,
      middlewares_applied,
      started_at, completed_at
    ) VALUES (
      $1, $2,
      $3, $4,
      $5, $6, $7, $8,
      $9, $10,
      $11, $12, $13, $14, $15,
      $16, $17, $18,
      $19, $20, $21,
      $22, $23, $24,
      $25, $26, $27,
      $28, $29, $30,
      $31, $32, $33,
      $34, $35, $36,
      $37,
      $38, $39
    ) RETURNING id, started_at
  `, [
    log.soul_id, log.api_key_id,
    log.agent_name, log.session_id,
    log.requested_model, log.resolved_model, log.mode, log.is_streaming,
    JSON.stringify(log.request_messages), log.request_size_bytes,
    log.response_content, log.status_code, log.stop_reason, log.error_type, log.error_message,
    log.response_size_bytes, log.latency_ms, log.ttfb_ms,
    log.prompt_tokens, log.completion_tokens, log.total_tokens,
    log.input_cost, log.output_cost, log.total_cost,
    log.retry_count || 0, log.retry_reason, log.retries_detail ? JSON.stringify(log.retries_detail) : null,
    log.blocked_by_blacklist || false, log.blacklist_rule_id, log.blacklist_match,
    log.is_truncated || false, log.is_slow || false, log.prompt_size_warning || false,
    log.prompt_hash || null, log.cache_hit || false, log.is_free || false,
    log.middlewares_applied || null,
    log.started_at, log.completed_at,
  ]);
  return rows[0];
}

export async function findCachedResponse(promptHash, resolvedModel) {
  const { rows } = await query(`
    SELECT response_content, prompt_tokens, completion_tokens, total_tokens, stop_reason, middlewares_applied
    FROM call_logs
    WHERE prompt_hash = $1 AND resolved_model = $2 AND status_code = 200 AND response_content IS NOT NULL
    ORDER BY started_at DESC LIMIT 1
  `, [promptHash, resolvedModel]);
  return rows[0] || null;
}

export async function queryLogs({ soul_id, model, from, to, status, error_type, keyword, session_id, agent_name, api_key_id, limit, offset, sort, order }) {
  const conditions = [];
  const params = [];
  let idx = 1;

  if (soul_id) { conditions.push(`soul_id = $${idx++}`); params.push(soul_id); }
  if (model) { conditions.push(`resolved_model = $${idx++}`); params.push(model); }
  if (from) { conditions.push(`started_at >= $${idx++}`); params.push(from); }
  if (to) { conditions.push(`started_at <= $${idx++}`); params.push(to); }
  if (session_id) { conditions.push(`session_id = $${idx++}`); params.push(session_id); }
  if (agent_name) { conditions.push(`agent_name = $${idx++}`); params.push(agent_name); }
  if (api_key_id) { conditions.push(`api_key_id = $${idx++}`); params.push(api_key_id); }
  if (error_type) { conditions.push(`error_type = $${idx++}`); params.push(error_type); }
  if (status === 'error') { conditions.push(`error_type IS NOT NULL`); }
  if (status === 'blocked') { conditions.push(`blocked_by_blacklist = true`); }
  if (status === 'success') { conditions.push(`error_type IS NULL AND blocked_by_blacklist = false`); }
  if (keyword) {
    conditions.push(`(
      resolved_model ILIKE $${idx} OR
      requested_model ILIKE $${idx} OR
      agent_name ILIKE $${idx} OR
      session_id::text ILIKE $${idx} OR
      error_type ILIKE $${idx} OR
      error_message ILIKE $${idx} OR
      request_messages::text ILIKE $${idx} OR
      response_content ILIKE $${idx}
    )`);
    params.push(`%${keyword}%`);
    idx++;
  }

  const where = conditions.length > 0 ? 'WHERE ' + conditions.join(' AND ') : '';
  const lim = Math.min(parseInt(limit) || 50, 500);
  const off = parseInt(offset) || 0;
  const sortCol = SORTABLE_COLUMNS.has(sort) ? sort : 'started_at';
  const sortDir = order === 'asc' ? 'ASC' : 'DESC';

  const [countResult, dataResult] = await Promise.all([
    query(`SELECT COUNT(*) as total FROM call_logs ${where}`, params),
    query(`
      SELECT id, soul_id, api_key_id,
             agent_name, session_id,
             requested_model, resolved_model, mode, is_streaming,
             status_code, stop_reason, error_type, error_message,
             latency_ms, ttfb_ms, prompt_tokens, completion_tokens, total_tokens,
             input_cost, output_cost, total_cost,
             retry_count, blocked_by_blacklist, blacklist_match,
             is_truncated, is_slow, prompt_size_warning, cache_hit,
             middlewares_applied,
             started_at, completed_at
      FROM call_logs ${where}
      ORDER BY ${sortCol} ${sortDir}
      LIMIT $${idx++} OFFSET $${idx++}
    `, [...params, lim, off]),
  ]);

  return {
    total: parseInt(countResult.rows[0].total),
    limit: lim,
    offset: off,
    rows: dataResult.rows,
  };
}

export async function getLogById(id) {
  const { rows } = await query('SELECT * FROM call_logs WHERE id = $1', [id]);
  return rows[0] || null;
}

export async function getLogsForExport({ from, to, format }) {
  const conditions = [];
  const params = [];
  let idx = 1;

  if (from) { conditions.push(`started_at >= $${idx++}`); params.push(from); }
  if (to) { conditions.push(`started_at <= $${idx++}`); params.push(to); }

  const where = conditions.length > 0 ? 'WHERE ' + conditions.join(' AND ') : '';
  const { rows } = await query(`SELECT * FROM call_logs ${where} ORDER BY started_at DESC`, params);
  return rows;
}

// --- Agent & Session queries ---

/**
 * List distinct agents seen, optionally filtered by API key.
 */
export async function listAgents({ api_key_id } = {}) {
  const conditions = [];
  const params = [];
  let idx = 1;

  if (api_key_id) { conditions.push(`api_key_id = $${idx++}`); params.push(api_key_id); }

  const where = conditions.length > 0 ? 'WHERE ' + conditions.join(' AND ') : '';
  const { rows } = await query(`
    SELECT agent_name,
           COUNT(*) as request_count,
           MIN(started_at) as first_seen,
           MAX(started_at) as last_seen
    FROM call_logs ${where}
    GROUP BY agent_name
    ORDER BY last_seen DESC
  `, params);
  return rows;
}

/**
 * List sessions for a given key+agent combination.
 */
export async function listSessions({ api_key_id, agent_name, limit, offset } = {}) {
  const conditions = [];
  const params = [];
  let idx = 1;

  if (api_key_id) { conditions.push(`api_key_id = $${idx++}`); params.push(api_key_id); }
  if (agent_name) { conditions.push(`agent_name = $${idx++}`); params.push(agent_name); }
  conditions.push(`session_id IS NOT NULL`);

  const where = 'WHERE ' + conditions.join(' AND ');
  const lim = Math.min(parseInt(limit) || 50, 200);
  const off = parseInt(offset) || 0;

  const { rows } = await query(`
    SELECT session_id,
           agent_name,
           api_key_id,
           COUNT(*) as request_count,
           SUM(total_tokens) as total_tokens,
           SUM(total_cost) as total_cost,
           MIN(started_at) as started_at,
           MAX(started_at) as last_request_at,
           COUNT(*) FILTER (WHERE error_type IS NOT NULL) as error_count
    FROM call_logs ${where}
    GROUP BY session_id, agent_name, api_key_id
    ORDER BY last_request_at DESC
    LIMIT $${idx++} OFFSET $${idx++}
  `, [...params, lim, off]);

  return rows;
}

/**
 * Get logs for a specific session.
 */
export async function getSessionLogs(sessionId, { limit, offset, sort, order } = {}) {
  const lim = Math.min(parseInt(limit) || 100, 500);
  const off = parseInt(offset) || 0;
  const sortCol = SORTABLE_COLUMNS.has(sort) ? sort : 'started_at';
  const sortDir = order === 'asc' ? 'ASC' : 'DESC';

  const [countResult, dataResult] = await Promise.all([
    query(`SELECT COUNT(*) as total FROM call_logs WHERE session_id = $1`, [sessionId]),
    query(`
      SELECT id, soul_id, api_key_id,
             agent_name, session_id,
             requested_model, resolved_model, mode, is_streaming,
             status_code, stop_reason, error_type, error_message,
             latency_ms, ttfb_ms, prompt_tokens, completion_tokens, total_tokens,
             input_cost, output_cost, total_cost,
             retry_count, blocked_by_blacklist, cache_hit,
             middlewares_applied,
             started_at, completed_at
      FROM call_logs
      WHERE session_id = $1
      ORDER BY ${sortCol} ${sortDir}
      LIMIT $2 OFFSET $3
    `, [sessionId, lim, off]),
  ]);

  return {
    total: parseInt(countResult.rows[0].total),
    limit: lim,
    offset: off,
    rows: dataResult.rows,
  };
}

/**
 * Tree-view aggregation: keys only (flat list).
 */
export async function getTreeData({ from, to } = {}) {
  const conditions = [];
  const params = [];
  let idx = 1;

  if (from) { conditions.push(`cl.started_at >= $${idx++}`); params.push(from); }
  else { conditions.push(`cl.started_at >= NOW() - INTERVAL '30 days'`); }
  if (to) { conditions.push(`cl.started_at <= $${idx++}`); params.push(to); }

  const where = 'WHERE ' + conditions.join(' AND ');

  const { rows } = await query(`
    SELECT
      ak.id as api_key_id,
      ak.label as key_label,
      ak.key_hint,
      COUNT(*) as request_count,
      SUM(cl.total_tokens)::bigint as total_tokens,
      SUM(cl.total_cost) as total_cost,
      MIN(cl.started_at) as first_request,
      MAX(cl.started_at) as last_request
    FROM call_logs cl
    LEFT JOIN soul_gateway.api_keys ak ON cl.api_key_id = ak.id
    ${where}
    GROUP BY ak.id, ak.label, ak.key_hint
    ORDER BY last_request DESC
  `, params);
  return rows;
}
