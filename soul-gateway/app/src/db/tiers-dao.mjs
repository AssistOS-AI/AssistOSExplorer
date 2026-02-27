import { query } from './init.mjs';

export async function listTiers(enabledOnly = false) {
  let sql = 'SELECT * FROM model_tiers';
  if (enabledOnly) sql += ' WHERE is_enabled = true';
  sql += ' ORDER BY sort_order ASC, name ASC';
  const { rows } = await query(sql);
  return rows;
}

export async function getTierByName(name) {
  const { rows } = await query('SELECT * FROM model_tiers WHERE name = $1', [name]);
  return rows[0] || null;
}

export async function getTierById(id) {
  const { rows } = await query('SELECT * FROM model_tiers WHERE id = $1', [id]);
  return rows[0] || null;
}

export async function createTier({ name, display_name, models, fallback_tier, sort_order }) {
  const { rows } = await query(`
    INSERT INTO model_tiers (name, display_name, models, fallback_tier, sort_order)
    VALUES ($1, $2, $3, $4, $5)
    RETURNING *
  `, [name, display_name || name, models || [], fallback_tier || null, sort_order ?? 100]);
  return rows[0];
}

const UPDATABLE_FIELDS = ['name', 'display_name', 'models', 'fallback_tier', 'sort_order', 'is_enabled'];

export async function updateTier(id, fields) {
  const sets = [];
  const values = [];
  let idx = 1;
  for (const [key, value] of Object.entries(fields)) {
    if (value !== undefined && UPDATABLE_FIELDS.includes(key)) {
      sets.push(`${key} = $${idx}`);
      values.push(value);
      idx++;
    }
  }
  if (sets.length === 0) return null;
  values.push(id);
  const { rows } = await query(
    `UPDATE model_tiers SET ${sets.join(', ')} WHERE id = $${idx} RETURNING *`,
    values
  );
  return rows[0] || null;
}

export async function toggleTier(id) {
  const { rows } = await query(
    'UPDATE model_tiers SET is_enabled = NOT is_enabled WHERE id = $1 RETURNING *',
    [id]
  );
  return rows[0] || null;
}

export async function deleteTier(id) {
  const { rows } = await query('DELETE FROM model_tiers WHERE id = $1 RETURNING *', [id]);
  return rows[0] || null;
}
