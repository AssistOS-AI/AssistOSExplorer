/**
 * DAO for the middleware_assignments table.
 * Pure data-access functions — no business logic.
 */

const TABLE = 'soul_gateway.middleware_assignments';

export async function create(pool, {
  middlewareId, targetType, tierId = null, modelId = null,
  sortOrder = 100, enabled = true, settings = {},
}) {
  const { rows } = await pool.query(
    `INSERT INTO ${TABLE}
       (middleware_id, target_type, tier_id, model_id, sort_order, enabled, settings)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING *`,
    [middlewareId, targetType, tierId, modelId, sortOrder, enabled, JSON.stringify(settings)],
  );
  return rows[0];
}

export async function listForTier(pool, tierId, { enabledOnly = false } = {}) {
  const enabledFilter = enabledOnly ? 'AND ma.enabled = true' : '';
  const { rows } = await pool.query(
    `SELECT ma.*, mw.middleware_key, mw.display_name AS middleware_display_name,
            mw.hook_mode, mw.module_path, mw.source_type,
            mw.default_settings AS middleware_default_settings
     FROM ${TABLE} ma
     JOIN soul_gateway.middlewares mw ON mw.id = ma.middleware_id
     WHERE ma.tier_id = $1 AND ma.target_type = 'tier' ${enabledFilter}
     ORDER BY ma.sort_order ASC`,
    [tierId],
  );
  return rows;
}

export async function listForModel(pool, modelId, { enabledOnly = false } = {}) {
  const enabledFilter = enabledOnly ? 'AND ma.enabled = true' : '';
  const { rows } = await pool.query(
    `SELECT ma.*, mw.middleware_key, mw.display_name AS middleware_display_name,
            mw.hook_mode, mw.module_path, mw.source_type,
            mw.default_settings AS middleware_default_settings
     FROM ${TABLE} ma
     JOIN soul_gateway.middlewares mw ON mw.id = ma.middleware_id
     WHERE ma.model_id = $1 AND ma.target_type = 'model' ${enabledFilter}
     ORDER BY ma.sort_order ASC`,
    [modelId],
  );
  return rows;
}

export async function update(pool, id, fields) {
  const keys = Object.keys(fields);
  if (keys.length === 0) return null;

  const jsonFields = new Set(['settings']);
  const setClauses = keys.map((k, i) => `${toSnake(k)} = $${i + 2}`);
  const values = keys.map((k) => jsonFields.has(k) ? JSON.stringify(fields[k]) : fields[k]);

  const { rows } = await pool.query(
    `UPDATE ${TABLE} SET ${setClauses.join(', ')}, updated_at = now() WHERE id = $1 RETURNING *`,
    [id, ...values],
  );
  return rows[0] || null;
}

export async function del(pool, id) {
  const { rowCount } = await pool.query(
    `DELETE FROM ${TABLE} WHERE id = $1`,
    [id],
  );
  return rowCount > 0;
}

/**
 * Reorder assignments for a given target (tier or model).
 * Expects an array of { id, sortOrder }.
 */
export async function reorder(pool, assignments) {
  const client = pool.connect ? await pool.connect() : pool;
  try {
    await client.query('BEGIN');
    for (const { id, sortOrder } of assignments) {
      await client.query(
        `UPDATE ${TABLE} SET sort_order = $2, updated_at = now() WHERE id = $1`,
        [id, sortOrder],
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
