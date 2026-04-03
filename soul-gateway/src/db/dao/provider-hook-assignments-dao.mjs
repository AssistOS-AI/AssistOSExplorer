/**
 * DAO for the provider_hook_assignments table.
 * Pure data-access functions — no business logic.
 */

const TABLE = 'soul_gateway.provider_hook_assignments';

export async function create(pool, {
  providerId, hookKey, phase, sortOrder = 100, enabled = true, settings = {},
}) {
  const { rows } = await pool.query(
    `INSERT INTO ${TABLE}
       (provider_id, hook_key, phase, sort_order, enabled, settings)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING *`,
    [providerId, hookKey, phase, sortOrder, enabled, JSON.stringify(settings)],
  );
  return rows[0];
}

export async function listByProvider(pool, providerId) {
  const { rows } = await pool.query(
    `SELECT * FROM ${TABLE}
     WHERE provider_id = $1
     ORDER BY phase, sort_order ASC`,
    [providerId],
  );
  return rows;
}

export async function listByProviderAndPhase(pool, providerId, phase) {
  const { rows } = await pool.query(
    `SELECT * FROM ${TABLE}
     WHERE provider_id = $1 AND phase = $2
     ORDER BY sort_order ASC`,
    [providerId, phase],
  );
  return rows;
}

export async function update(pool, assignmentId, fields) {
  const keys = Object.keys(fields);
  if (keys.length === 0) return null;

  const jsonFields = new Set(['settings']);
  const setClauses = keys.map((k, i) => `${toSnake(k)} = $${i + 2}`);
  const values = keys.map((k) => jsonFields.has(k) ? JSON.stringify(fields[k]) : fields[k]);

  const { rows } = await pool.query(
    `UPDATE ${TABLE} SET ${setClauses.join(', ')}, updated_at = now() WHERE id = $1 RETURNING *`,
    [assignmentId, ...values],
  );
  return rows[0] || null;
}

export async function del(pool, assignmentId) {
  const { rowCount } = await pool.query(
    `DELETE FROM ${TABLE} WHERE id = $1`,
    [assignmentId],
  );
  return rowCount > 0;
}

/**
 * Reorder assignments for a given provider and phase.
 * Expects an ordered array of assignment IDs — the position in the array
 * becomes the new sort_order (starting at 1).
 */
export async function reorder(pool, providerId, phase, orderedIds) {
  const client = pool.connect ? await pool.connect() : pool;
  try {
    await client.query('BEGIN');
    for (let i = 0; i < orderedIds.length; i++) {
      await client.query(
        `UPDATE ${TABLE}
         SET sort_order = $3, updated_at = now()
         WHERE id = $1 AND provider_id = $2 AND phase = $4`,
        [orderedIds[i], providerId, i + 1, phase],
      );
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    if (pool.connect) client.release();
  }
}

// ── helpers ──────────────────────────────────────────────────────────

function toSnake(camel) {
  return camel.replace(/[A-Z]/g, (ch) => '_' + ch.toLowerCase());
}
