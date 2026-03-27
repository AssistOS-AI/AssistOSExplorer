import { query } from './init.mjs';

export async function listModels(enabledOnly = false, typeFilter = null) {
  let sql = `SELECT mc.*, COALESCE(pc.billing_type, 'api_key') AS billing_type
    FROM model_configs mc
    LEFT JOIN provider_configs pc ON mc.provider_config_id = pc.id`;
  const conditions = [];
  const params = [];
  if (enabledOnly) conditions.push('mc.is_enabled = true');
  if (typeFilter) {
    params.push(typeFilter);
    conditions.push(`mc.type = $${params.length}`);
  }
  if (conditions.length > 0) sql += ' WHERE ' + conditions.join(' AND ');
  sql += ' ORDER BY mc.sort_order ASC, mc.name ASC';
  const { rows } = await query(sql, params);
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

export async function createModel({ name, display_name, provider_key, provider_model, upstream_source, mode, input_price, output_price, pricing_type, request_cost, is_free, is_enabled, max_concurrency, sort_order, context_window, provider_config_id, tags }) {
  const { rows } = await query(`
    INSERT INTO model_configs (name, display_name, provider_key, provider_model, upstream_source, mode, input_price, output_price, pricing_type, request_cost, is_free, is_enabled, max_concurrency, sort_order, context_window, provider_config_id, tags)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
    RETURNING *
  `, [name, display_name || name, provider_key, provider_model, upstream_source || null, mode || 'deep', input_price || 0, output_price || 0, pricing_type || 'token', request_cost || 0, is_free ?? false, is_enabled ?? true, max_concurrency ?? 3, sort_order ?? 100, context_window || null, provider_config_id || null, tags || []]);
  return rows[0];
}

const UPDATABLE_FIELDS = ['name', 'display_name', 'provider_key', 'provider_model', 'upstream_source', 'mode', 'input_price', 'output_price', 'pricing_type', 'request_cost', 'is_enabled', 'is_free', 'max_concurrency', 'sort_order', 'context_window', 'provider_config_id', 'tags', 'model_refs', 'fallback_model'];

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
export async function upsertModel({ name, display_name, provider_key, provider_model, mode, input_price, output_price, pricing_type, request_cost, is_free, sort_order, provider_config_id, tags }) {
  const { rows } = await query(`
    INSERT INTO model_configs (name, display_name, provider_key, provider_model, mode, input_price, output_price, pricing_type, request_cost, is_free, sort_order, provider_config_id, tags)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
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
  `, [name, display_name || name, provider_key, provider_model || name, mode || 'fast', input_price || 0, output_price || 0, pricing_type || 'token', request_cost || 0, is_free ?? false, sort_order ?? 100, provider_config_id || null, tags || []]);
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

export async function listTiers(enabledOnly = false) {
  return listModels(enabledOnly, 'tier');
}

export async function getTierByName(name) {
  const { rows } = await query("SELECT * FROM model_configs WHERE name = $1 AND type = 'tier'", [name]);
  return rows[0] || null;
}

export async function getTierById(id) {
  const { rows } = await query("SELECT * FROM model_configs WHERE id = $1 AND type = 'tier'", [id]);
  return rows[0] || null;
}

export async function createTier({ name, display_name, model_refs, fallback_model, sort_order }) {
  const { rows } = await query(`
    INSERT INTO model_configs (name, display_name, type, model_refs, fallback_model, sort_order)
    VALUES ($1, $2, 'tier', $3, $4, $5)
    RETURNING *
  `, [name, display_name || name, model_refs || [], fallback_model || null, sort_order ?? 100]);
  return rows[0];
}
