import { randomUUID } from 'node:crypto';
import { query } from '../db/init.mjs';
import { config } from '../config.mjs';

/**
 * Resolve or auto-assign a session ID for a request.
 *
 * Looks up the most recent request from the same api_key_id + agent_name.
 * If it was within the session timeout, reuses its session_id.
 * Otherwise generates a new UUID.
 *
 * @param {string} apiKeyId - The API key ID
 * @param {string} agentName - The detected agent name
 * @returns {string} UUID session_id
 */
export async function resolveSession(apiKeyId, agentName) {
  if (!apiKeyId) return randomUUID();

  try {
    const cutoff = new Date(Date.now() - config.sessionTimeoutMs);
    const { rows } = await query(`
      SELECT session_id FROM call_logs
      WHERE api_key_id = $1 AND agent_name = $2 AND started_at >= $3
      ORDER BY started_at DESC
      LIMIT 1
    `, [apiKeyId, agentName, cutoff]);

    if (rows.length > 0 && rows[0].session_id) {
      return rows[0].session_id;
    }
  } catch {
    // If query fails (e.g. columns don't exist yet), fall through to new session
  }

  return randomUUID();
}
