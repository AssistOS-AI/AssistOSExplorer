import { query } from './init.mjs';

export async function insertLog(log) {
  const { rows } = await query(`
    INSERT INTO call_logs (
      family_id, family_name, soul_id, api_key_id,
      requested_model, resolved_model, mode, is_streaming,
      request_messages, request_size_bytes,
      response_content, status_code, stop_reason, error_type, error_message,
      response_size_bytes, latency_ms, ttfb_ms,
      prompt_tokens, completion_tokens, total_tokens,
      input_cost, output_cost, total_cost,
      retry_count, retry_reason, retries_detail,
      blocked_by_blacklist, blacklist_rule_id, blacklist_match,
      is_truncated, is_slow, prompt_size_warning,
      started_at, completed_at
    ) VALUES (
      $1, $2, $3, $4,
      $5, $6, $7, $8,
      $9, $10,
      $11, $12, $13, $14, $15,
      $16, $17, $18,
      $19, $20, $21,
      $22, $23, $24,
      $25, $26, $27,
      $28, $29, $30,
      $31, $32, $33,
      $34, $35
    ) RETURNING id, started_at
  `, [
    log.family_id, log.family_name, log.soul_id, log.api_key_id,
    log.requested_model, log.resolved_model, log.mode, log.is_streaming,
    JSON.stringify(log.request_messages), log.request_size_bytes,
    log.response_content, log.status_code, log.stop_reason, log.error_type, log.error_message,
    log.response_size_bytes, log.latency_ms, log.ttfb_ms,
    log.prompt_tokens, log.completion_tokens, log.total_tokens,
    log.input_cost, log.output_cost, log.total_cost,
    log.retry_count || 0, log.retry_reason, log.retries_detail ? JSON.stringify(log.retries_detail) : null,
    log.blocked_by_blacklist || false, log.blacklist_rule_id, log.blacklist_match,
    log.is_truncated || false, log.is_slow || false, log.prompt_size_warning || false,
    log.started_at, log.completed_at,
  ]);
  return rows[0];
}

export async function queryLogs({ family_id, soul_id, model, from, to, status, keyword, limit, offset }) {
  const conditions = [];
  const params = [];
  let idx = 1;

  if (family_id) { conditions.push(`family_id = $${idx++}`); params.push(family_id); }
  if (soul_id) { conditions.push(`soul_id = $${idx++}`); params.push(soul_id); }
  if (model) { conditions.push(`resolved_model = $${idx++}`); params.push(model); }
  if (from) { conditions.push(`started_at >= $${idx++}`); params.push(from); }
  if (to) { conditions.push(`started_at <= $${idx++}`); params.push(to); }
  if (status === 'error') { conditions.push(`error_type IS NOT NULL`); }
  if (status === 'blocked') { conditions.push(`blocked_by_blacklist = true`); }
  if (status === 'success') { conditions.push(`error_type IS NULL AND blocked_by_blacklist = false`); }
  if (keyword) {
    conditions.push(`(
      request_messages::text ILIKE $${idx} OR
      response_content ILIKE $${idx}
    )`);
    params.push(`%${keyword}%`);
    idx++;
  }

  const where = conditions.length > 0 ? 'WHERE ' + conditions.join(' AND ') : '';
  const lim = Math.min(parseInt(limit) || 50, 500);
  const off = parseInt(offset) || 0;

  const [countResult, dataResult] = await Promise.all([
    query(`SELECT COUNT(*) as total FROM call_logs ${where}`, params),
    query(`
      SELECT id, family_id, family_name, soul_id,
             requested_model, resolved_model, mode, is_streaming,
             status_code, stop_reason, error_type, error_message,
             latency_ms, ttfb_ms, prompt_tokens, completion_tokens, total_tokens,
             input_cost, output_cost, total_cost,
             retry_count, blocked_by_blacklist, blacklist_match,
             is_truncated, is_slow, prompt_size_warning,
             started_at, completed_at
      FROM call_logs ${where}
      ORDER BY started_at DESC
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

export async function getLogsForExport({ family_id, from, to, format }) {
  const conditions = [];
  const params = [];
  let idx = 1;

  if (family_id) { conditions.push(`family_id = $${idx++}`); params.push(family_id); }
  if (from) { conditions.push(`started_at >= $${idx++}`); params.push(from); }
  if (to) { conditions.push(`started_at <= $${idx++}`); params.push(to); }

  const where = conditions.length > 0 ? 'WHERE ' + conditions.join(' AND ') : '';
  const { rows } = await query(`SELECT * FROM call_logs ${where} ORDER BY started_at DESC`, params);
  return rows;
}
