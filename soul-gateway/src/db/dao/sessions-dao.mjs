/**
 * DAO for the sessions table.
 * Pure data-access functions — no business logic.
 */

const TABLE = 'soul_gateway.sessions';

export async function create(pool, {
  groupKey, groupDisplay, sequenceNo,
  apiKeyId, soulId = null, agentName,
  explicitSessionId = null, metadata = {},
}) {
  const { rows } = await pool.query(
    `INSERT INTO ${TABLE}
       (group_key, group_display, sequence_no,
        api_key_id, soul_id, agent_name,
        explicit_session_id, metadata)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING *`,
    [groupKey, groupDisplay, sequenceNo,
     apiKeyId, soulId, agentName,
     explicitSessionId, JSON.stringify(metadata)],
  );
  return rows[0];
}

export async function findById(pool, id) {
  const { rows } = await pool.query(
    `SELECT * FROM ${TABLE} WHERE id = $1`,
    [id],
  );
  return rows[0] || null;
}

/**
 * Find or create an implicit session for the given api key + agent pair.
 * An implicit session is the most recent open session without an explicit session ID,
 * that has had activity within the timeout window.
 *
 * If none exists, creates a new one.
 */
export async function findOrCreateImplicit(pool, {
  apiKeyId, agentName, soulId = null,
  timeoutMinutes = 30,
}) {
  // Try to find an existing open implicit session within the activity window
  const { rows: existing } = await pool.query(
    `SELECT * FROM ${TABLE}
     WHERE api_key_id = $1
       AND agent_name = $2
       AND explicit_session_id IS NULL
       AND status = 'open'
       AND last_activity_at > now() - ($3 || ' minutes')::interval
     ORDER BY last_activity_at DESC
     LIMIT 1`,
    [apiKeyId, agentName, String(timeoutMinutes)],
  );

  if (existing.length > 0) {
    return { session: existing[0], created: false };
  }

  // Determine the next sequence_no for this group
  const groupKey = `implicit:${apiKeyId}:${agentName}`;
  const { rows: seqRows } = await pool.query(
    `SELECT COALESCE(MAX(sequence_no), 0) + 1 AS next_seq
     FROM ${TABLE}
     WHERE group_key = $1`,
    [groupKey],
  );
  const nextSeq = seqRows[0].next_seq;

  const { rows: newRows } = await pool.query(
    `INSERT INTO ${TABLE}
       (group_key, group_display, sequence_no,
        api_key_id, soul_id, agent_name)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING *`,
    [groupKey, `${agentName} #${nextSeq}`, nextSeq,
     apiKeyId, soulId, agentName],
  );

  return { session: newRows[0], created: true };
}

export async function updateActivity(pool, id, { inputTokens = 0, outputTokens = 0 } = {}) {
  const { rows } = await pool.query(
    `UPDATE ${TABLE}
     SET last_activity_at = now(),
         request_count = request_count + 1,
         input_tokens_total = input_tokens_total + $2,
         output_tokens_total = output_tokens_total + $3
     WHERE id = $1
     RETURNING *`,
    [id, inputTokens, outputTokens],
  );
  return rows[0] || null;
}

export async function close(pool, id) {
  const { rows } = await pool.query(
    `UPDATE ${TABLE}
     SET status = 'closed', ended_at = now()
     WHERE id = $1 AND status = 'open'
     RETURNING *`,
    [id],
  );
  return rows[0] || null;
}

export async function listRecent(pool, { limit = 50, offset = 0, status = null } = {}) {
  if (status) {
    const { rows } = await pool.query(
      `SELECT * FROM ${TABLE}
       WHERE status = $1
       ORDER BY last_activity_at DESC
       LIMIT $2 OFFSET $3`,
      [status, limit, offset],
    );
    return rows;
  }
  const { rows } = await pool.query(
    `SELECT * FROM ${TABLE}
     ORDER BY last_activity_at DESC
     LIMIT $1 OFFSET $2`,
    [limit, offset],
  );
  return rows;
}

export async function listByAgent(pool, agentName, { limit = 50, offset = 0 } = {}) {
  const { rows } = await pool.query(
    `SELECT * FROM ${TABLE}
     WHERE agent_name = $1
     ORDER BY last_activity_at DESC
     LIMIT $2 OFFSET $3`,
    [agentName, limit, offset],
  );
  return rows;
}
