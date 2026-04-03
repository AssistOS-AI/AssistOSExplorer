/**
 * Session resolution.
 *
 * Resolves or creates a session for the current request, based on
 * explicit session IDs or implicit grouping by (apiKeyId, agentName).
 */

import * as sessionsDao from '../db/dao/sessions-dao.mjs';

/**
 * Resolve the session for the current request.
 *
 * - If an explicit session ID is provided, looks it up or creates a new session with that ID.
 * - Otherwise, uses implicit grouping: finds an open session for (apiKeyId, agentName)
 *   within the session timeout window.
 * - Updates the session's activity timestamp.
 *
 * @param {object} reqCtx - request context
 * @param {object} reqCtx.identity - { soulId, agentName, explicitSessionId }
 * @param {object} reqCtx.apiKey - the authenticated API key record
 * @param {object} reqCtx.appCtx - application context
 * @returns {Promise<object>} session record
 */
export async function resolveSession(reqCtx) {
  const { identity, apiKey, appCtx } = reqCtx;
  const { pool, config } = appCtx;
  const timeoutMinutes = config.env.SESSION_TIMEOUT_MINUTES;

  let session;

  if (identity.explicitSessionId) {
    session = await resolveExplicitSession(pool, {
      explicitSessionId: identity.explicitSessionId,
      apiKeyId: apiKey.id,
      agentName: identity.agentName,
      soulId: identity.soulId,
    });
  } else {
    const result = await sessionsDao.findOrCreateImplicit(pool, {
      apiKeyId: apiKey.id,
      agentName: identity.agentName,
      soulId: identity.soulId,
      timeoutMinutes,
    });
    session = result.session;
  }

  // Update activity timestamp
  await sessionsDao.updateActivity(pool, session.id);

  return session;
}

// ── Explicit session resolution ─────────────────────────────────────

/**
 * Find a session by explicit session ID, or create one if it doesn't exist.
 */
async function resolveExplicitSession(pool, { explicitSessionId, apiKeyId, agentName, soulId }) {
  // First, try to find an existing session with this explicit ID
  const existing = await findByExplicitId(pool, explicitSessionId, apiKeyId);
  if (existing) return existing;

  // Create a new session with the explicit ID
  const groupKey = `explicit:${apiKeyId}:${explicitSessionId}`;
  return sessionsDao.create(pool, {
    groupKey,
    groupDisplay: `${agentName} (${explicitSessionId})`,
    sequenceNo: 1,
    apiKeyId,
    soulId,
    agentName,
    explicitSessionId,
  });
}

/**
 * Look up an existing session by explicit_session_id and api_key_id.
 */
async function findByExplicitId(pool, explicitSessionId, apiKeyId) {
  const { rows } = await pool.query(
    `SELECT * FROM soul_gateway.sessions
     WHERE explicit_session_id = $1
       AND api_key_id = $2
       AND status = 'open'
     ORDER BY last_activity_at DESC
     LIMIT 1`,
    [explicitSessionId, apiKeyId],
  );
  return rows[0] || null;
}
