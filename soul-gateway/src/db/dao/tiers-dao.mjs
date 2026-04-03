/**
 * DAO for the tiers and tier_models tables.
 * Pure data-access functions — no business logic.
 */

const TIERS = 'soul_gateway.tiers';
const TIER_MODELS = 'soul_gateway.tier_models';

// ── tiers CRUD ──────────────────────────────────────────────────────

export async function create(pool, {
  tierKey, displayName, description = null,
  fallbackTierId = null, maxModelAttempts = 5, enabled = true,
  rateLimitOverride = {}, budgetOverride = {},
  loopOverride = {}, responseFilterOverride = {},
  metadata = {},
}) {
  const { rows } = await pool.query(
    `INSERT INTO ${TIERS}
       (tier_key, display_name, description, fallback_tier_id, max_model_attempts,
        enabled, rate_limit_override, budget_override, loop_override,
        response_filter_override, metadata)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
     RETURNING *`,
    [tierKey, displayName, description, fallbackTierId, maxModelAttempts,
     enabled, JSON.stringify(rateLimitOverride), JSON.stringify(budgetOverride),
     JSON.stringify(loopOverride), JSON.stringify(responseFilterOverride),
     JSON.stringify(metadata)],
  );
  return rows[0];
}

export async function findById(pool, id) {
  const { rows } = await pool.query(
    `SELECT * FROM ${TIERS} WHERE id = $1`,
    [id],
  );
  return rows[0] || null;
}

export async function findByKey(pool, tierKey) {
  const { rows } = await pool.query(
    `SELECT * FROM ${TIERS} WHERE tier_key = $1`,
    [tierKey],
  );
  return rows[0] || null;
}

export async function list(pool, { enabled = null, limit = 200, offset = 0 } = {}) {
  if (enabled !== null) {
    const { rows } = await pool.query(
      `SELECT * FROM ${TIERS} WHERE enabled = $1 ORDER BY display_name ASC LIMIT $2 OFFSET $3`,
      [enabled, limit, offset],
    );
    return rows;
  }
  const { rows } = await pool.query(
    `SELECT * FROM ${TIERS} ORDER BY display_name ASC LIMIT $1 OFFSET $2`,
    [limit, offset],
  );
  return rows;
}

export async function update(pool, id, fields) {
  const keys = Object.keys(fields);
  if (keys.length === 0) return null;

  const jsonFields = new Set([
    'rateLimitOverride', 'budgetOverride', 'loopOverride',
    'responseFilterOverride', 'metadata',
  ]);

  const setClauses = keys.map((k, i) => `${toSnake(k)} = $${i + 2}`);
  const values = keys.map((k) => jsonFields.has(k) ? JSON.stringify(fields[k]) : fields[k]);

  const { rows } = await pool.query(
    `UPDATE ${TIERS} SET ${setClauses.join(', ')}, updated_at = now() WHERE id = $1 RETURNING *`,
    [id, ...values],
  );
  return rows[0] || null;
}

export async function del(pool, id) {
  const { rowCount } = await pool.query(
    `DELETE FROM ${TIERS} WHERE id = $1`,
    [id],
  );
  return rowCount > 0;
}

export async function enable(pool, id) {
  const { rows } = await pool.query(
    `UPDATE ${TIERS} SET enabled = true, updated_at = now() WHERE id = $1 RETURNING *`,
    [id],
  );
  return rows[0] || null;
}

export async function disable(pool, id) {
  const { rows } = await pool.query(
    `UPDATE ${TIERS} SET enabled = false, updated_at = now() WHERE id = $1 RETURNING *`,
    [id],
  );
  return rows[0] || null;
}

// ── tier_models ─────────────────────────────────────────────────────

export async function addModel(pool, { tierId, modelId, priority, enabled = true, settings = {} }) {
  const { rows } = await pool.query(
    `INSERT INTO ${TIER_MODELS}
       (tier_id, model_id, priority, enabled, settings)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING *`,
    [tierId, modelId, priority, enabled, JSON.stringify(settings)],
  );
  return rows[0];
}

export async function removeModel(pool, tierId, modelId) {
  const { rowCount } = await pool.query(
    `DELETE FROM ${TIER_MODELS} WHERE tier_id = $1 AND model_id = $2`,
    [tierId, modelId],
  );
  return rowCount > 0;
}

export async function reorderModels(pool, tierId, modelPriorities) {
  const client = pool.connect ? await pool.connect() : pool;
  try {
    await client.query('BEGIN');
    for (const { modelId, priority } of modelPriorities) {
      await client.query(
        `UPDATE ${TIER_MODELS}
         SET priority = $3, updated_at = now()
         WHERE tier_id = $1 AND model_id = $2`,
        [tierId, modelId, priority],
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

export async function listModelsForTier(pool, tierId, { enabledOnly = false } = {}) {
  const enabledFilter = enabledOnly ? 'AND tm.enabled = true' : '';
  const { rows } = await pool.query(
    `SELECT tm.*, m.model_key, m.display_name AS model_display_name,
            m.enabled AS model_enabled, m.provider_id
     FROM ${TIER_MODELS} tm
     JOIN soul_gateway.models m ON m.id = tm.model_id
     WHERE tm.tier_id = $1 ${enabledFilter}
     ORDER BY tm.priority ASC`,
    [tierId],
  );
  return rows;
}

// ── helpers ──────────────────────────────────────────────────────────

function toSnake(camel) {
  return camel.replace(/[A-Z]/g, (ch) => '_' + ch.toLowerCase());
}
