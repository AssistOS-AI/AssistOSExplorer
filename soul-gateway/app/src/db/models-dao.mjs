import { query } from './init.mjs';

export async function listModels(enabledOnly = false) {
  let sql = 'SELECT * FROM model_configs';
  if (enabledOnly) sql += ' WHERE is_enabled = true';
  sql += ' ORDER BY name';
  const { rows } = await query(sql);
  return rows;
}

export async function getModelByName(name) {
  const { rows } = await query('SELECT * FROM model_configs WHERE name = $1', [name]);
  return rows[0] || null;
}

export async function getModelById(id) {
  const { rows } = await query('SELECT * FROM model_configs WHERE id = $1', [id]);
  return rows[0] || null;
}

export async function createModel({ name, display_name, provider_key, provider_model, mode, input_price, output_price, max_concurrency }) {
  const { rows } = await query(`
    INSERT INTO model_configs (name, display_name, provider_key, provider_model, mode, input_price, output_price, max_concurrency)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
    RETURNING *
  `, [name, display_name || name, provider_key, provider_model, mode || 'deep', input_price || 0, output_price || 0, max_concurrency ?? 3]);
  return rows[0];
}

const UPDATABLE_FIELDS = ['name', 'display_name', 'provider_key', 'provider_model', 'mode', 'input_price', 'output_price', 'is_enabled', 'max_concurrency'];

export async function updateModel(id, fields) {
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
    `UPDATE model_configs SET ${sets.join(', ')} WHERE id = $${idx} RETURNING *`,
    values
  );
  return rows[0] || null;
}

export async function toggleModel(id) {
  const { rows } = await query(
    'UPDATE model_configs SET is_enabled = NOT is_enabled WHERE id = $1 RETURNING *',
    [id]
  );
  return rows[0] || null;
}

export async function deleteModel(id) {
  const { rows } = await query('DELETE FROM model_configs WHERE id = $1 RETURNING *', [id]);
  return rows[0] || null;
}
