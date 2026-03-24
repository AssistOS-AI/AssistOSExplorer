import { query } from './init.mjs';

export async function listModels(enabledOnly = false) {
  let sql = 'SELECT * FROM model_configs';
  if (enabledOnly) sql += ' WHERE is_enabled = true';
  sql += ' ORDER BY sort_order ASC, name ASC';
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

export async function createModel({ name, display_name, provider_key, provider_model, upstream_source, mode, input_price, output_price, pricing_type, request_cost, max_concurrency, sort_order, context_window, provider_config_id }) {
  const { rows } = await query(`
    INSERT INTO model_configs (name, display_name, provider_key, provider_model, upstream_source, mode, input_price, output_price, pricing_type, request_cost, max_concurrency, sort_order, context_window, provider_config_id)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
    RETURNING *
  `, [name, display_name || name, provider_key, provider_model, upstream_source || null, mode || 'deep', input_price || 0, output_price || 0, pricing_type || 'token', request_cost || 0, max_concurrency ?? 3, sort_order ?? 100, context_window || null, provider_config_id || null]);
  return rows[0];
}

const UPDATABLE_FIELDS = ['name', 'display_name', 'provider_key', 'provider_model', 'upstream_source', 'mode', 'input_price', 'output_price', 'pricing_type', 'request_cost', 'is_enabled', 'is_free', 'max_concurrency', 'sort_order', 'context_window', 'provider_config_id'];

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

/**
 * Upsert a model — insert or update on name conflict.
 * Used by provider sync to auto-create/update discovered models.
 */
export async function upsertModel({ name, display_name, provider_key, provider_model, mode, input_price, output_price, pricing_type, request_cost, is_free, sort_order, provider_config_id }) {
  const { rows } = await query(`
    INSERT INTO model_configs (name, display_name, provider_key, provider_model, mode, input_price, output_price, pricing_type, request_cost, is_free, sort_order, provider_config_id)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
    ON CONFLICT (name) DO UPDATE SET
      display_name = COALESCE(EXCLUDED.display_name, model_configs.display_name),
      provider_key = EXCLUDED.provider_key,
      provider_model = EXCLUDED.provider_model,
      mode = EXCLUDED.mode,
      input_price = EXCLUDED.input_price,
      output_price = EXCLUDED.output_price,
      pricing_type = EXCLUDED.pricing_type,
      request_cost = EXCLUDED.request_cost,
      is_free = EXCLUDED.is_free,
      sort_order = EXCLUDED.sort_order,
      provider_config_id = EXCLUDED.provider_config_id,
      is_enabled = true
    RETURNING *
  `, [name, display_name || name, provider_key, provider_model || name, mode || 'fast', input_price || 0, output_price || 0, pricing_type || 'token', request_cost || 0, is_free ?? false, sort_order ?? 100, provider_config_id || null]);
  return rows[0];
}

/**
 * Get all models linked to a specific provider config.
 */
export async function getModelsByProviderConfigId(providerConfigId) {
  const { rows } = await query(
    'SELECT * FROM model_configs WHERE provider_config_id = $1',
    [providerConfigId]
  );
  return rows;
}
