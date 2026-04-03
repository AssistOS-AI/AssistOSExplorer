/**
 * DAO for the session_state table.
 * Pure data-access functions — no business logic.
 */

const TABLE = 'soul_gateway.session_state';

/**
 * Insert or update session state for a given session.
 * All fields are replaced on conflict (full upsert).
 */
export async function upsert(pool, {
  sessionId,
  summaryText = '',
  factsJson = [],
  recentFingerprints = [],
  recentSimilarity = [],
  recentTokenVolume = 0,
  responseCount = 0,
  lastResponseAt = null,
  lastLoopDetectedAt = null,
}) {
  const { rows } = await pool.query(
    `INSERT INTO ${TABLE}
       (session_id, summary_text, facts_json,
        recent_fingerprints, recent_similarity,
        recent_token_volume, response_count,
        last_response_at, last_loop_detected_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, now())
     ON CONFLICT (session_id) DO UPDATE SET
       summary_text = EXCLUDED.summary_text,
       facts_json = EXCLUDED.facts_json,
       recent_fingerprints = EXCLUDED.recent_fingerprints,
       recent_similarity = EXCLUDED.recent_similarity,
       recent_token_volume = EXCLUDED.recent_token_volume,
       response_count = EXCLUDED.response_count,
       last_response_at = EXCLUDED.last_response_at,
       last_loop_detected_at = EXCLUDED.last_loop_detected_at,
       updated_at = now()
     RETURNING *`,
    [sessionId, summaryText, JSON.stringify(factsJson),
     JSON.stringify(recentFingerprints), JSON.stringify(recentSimilarity),
     recentTokenVolume, responseCount,
     lastResponseAt, lastLoopDetectedAt],
  );
  return rows[0];
}

export async function findBySessionId(pool, sessionId) {
  const { rows } = await pool.query(
    `SELECT * FROM ${TABLE} WHERE session_id = $1`,
    [sessionId],
  );
  return rows[0] || null;
}
