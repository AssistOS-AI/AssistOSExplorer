import { query } from './init.mjs';

// ---------------------------------------------------------------------------
// In-memory cache for hot-path getEnabledMiddlewaresForModel (30s TTL)
// ---------------------------------------------------------------------------
const CACHE_TTL_MS = 30_000;
const modelMwCache = new Map();

export function invalidateModelMwCache(modelConfigId) {
  if (modelConfigId) modelMwCache.delete(modelConfigId);
  else modelMwCache.clear();
}

// ---------------------------------------------------------------------------
// Middlewares table
// ---------------------------------------------------------------------------

export async function listMiddlewares() {
  const { rows } = await query('SELECT * FROM middlewares ORDER BY name ASC');
  return rows;
}

export async function getMiddlewareById(id) {
  const { rows } = await query('SELECT * FROM middlewares WHERE id = $1', [id]);
  return rows[0] || null;
}

export async function getMiddlewareByName(name) {
  const { rows } = await query('SELECT * FROM middlewares WHERE name = $1', [name]);
  return rows[0] || null;
}

export async function upsertMiddleware({ name, description, file_name, type, supports_streaming, default_settings, version }) {
  const { rows } = await query(`
    INSERT INTO middlewares (name, description, file_name, type, supports_streaming, default_settings, version, is_discovered)
    VALUES ($1, $2, $3, $4, $5, $6, $7, true)
    ON CONFLICT (name) DO UPDATE SET
      description = EXCLUDED.description,
      file_name = EXCLUDED.file_name,
      type = EXCLUDED.type,
      supports_streaming = EXCLUDED.supports_streaming,
      default_settings = EXCLUDED.default_settings,
      version = EXCLUDED.version,
      is_discovered = true,
      updated_at = now()
    RETURNING *
  `, [name, description || '', file_name, type || 'both', !!supports_streaming, JSON.stringify(default_settings || {}), version || '1.0.0']);
  return rows[0];
}

const MW_UPDATABLE_FIELDS = ['description', 'default_settings'];

export async function updateMiddleware(id, fields) {
  const sets = [];
  const values = [];
  let idx = 1;
  for (const [key, value] of Object.entries(fields)) {
    if (value !== undefined && MW_UPDATABLE_FIELDS.includes(key)) {
      sets.push(`${key} = $${idx}`);
      values.push(key === 'default_settings' ? JSON.stringify(value) : value);
      idx++;
    }
  }
  if (sets.length === 0) return null;
  sets.push(`updated_at = now()`);
  values.push(id);
  const { rows } = await query(
    `UPDATE middlewares SET ${sets.join(', ')} WHERE id = $${idx} RETURNING *`,
    values
  );
  return rows[0] || null;
}

export async function markUndiscovered(fileNames) {
  if (!fileNames || fileNames.length === 0) return;
  await query(
    `UPDATE middlewares SET is_discovered = false, updated_at = now() WHERE file_name = ANY($1)`,
    [fileNames]
  );
}

// ---------------------------------------------------------------------------
// Model-middleware assignments (also serves tier lookups — tiers are now model_configs with type='tier')
// ---------------------------------------------------------------------------

export async function getEnabledMiddlewaresForModel(modelConfigId) {
  const cached = modelMwCache.get(modelConfigId);
  if (cached && Date.now() - cached.ts < CACHE_TTL_MS) {
    return cached.data;
  }

  const { rows } = await query(`
    SELECT m.name, m.file_name, m.type, m.supports_streaming, m.default_settings,
           mm.sort_order, mm.settings AS override_settings
    FROM model_middlewares mm
    JOIN middlewares m ON m.id = mm.middleware_id
    WHERE mm.model_config_id = $1 AND mm.is_enabled = true AND m.is_discovered = true
    ORDER BY mm.sort_order ASC, m.name ASC
  `, [modelConfigId]);

  modelMwCache.set(modelConfigId, { data: rows, ts: Date.now() });
  return rows;
}

export async function getModelMiddlewares(modelConfigId) {
  const { rows } = await query(`
    SELECT mm.*, m.name AS middleware_name, m.description AS middleware_description,
           m.type AS middleware_type, m.supports_streaming, m.default_settings,
           m.version, m.file_name, m.is_discovered
    FROM model_middlewares mm
    JOIN middlewares m ON m.id = mm.middleware_id
    WHERE mm.model_config_id = $1
    ORDER BY mm.sort_order ASC, m.name ASC
  `, [modelConfigId]);
  return rows;
}

export async function assignMiddlewareToModel(modelConfigId, middlewareId, { is_enabled, sort_order, settings } = {}) {
  const { rows } = await query(`
    INSERT INTO model_middlewares (model_config_id, middleware_id, is_enabled, sort_order, settings)
    VALUES ($1, $2, $3, $4, $5)
    RETURNING *
  `, [modelConfigId, middlewareId, is_enabled ?? true, sort_order ?? 100, JSON.stringify(settings || {})]);
  invalidateModelMwCache(modelConfigId);
  return rows[0];
}

const MM_UPDATABLE_FIELDS = ['is_enabled', 'sort_order', 'settings'];

export async function updateModelMiddleware(modelMiddlewareId, fields) {
  const sets = [];
  const values = [];
  let idx = 1;
  for (const [key, value] of Object.entries(fields)) {
    if (value !== undefined && MM_UPDATABLE_FIELDS.includes(key)) {
      sets.push(`${key} = $${idx}`);
      values.push(key === 'settings' ? JSON.stringify(value) : value);
      idx++;
    }
  }
  if (sets.length === 0) return null;
  sets.push(`updated_at = now()`);
  values.push(modelMiddlewareId);
  const { rows } = await query(
    `UPDATE model_middlewares SET ${sets.join(', ')} WHERE id = $${idx} RETURNING *`,
    values
  );
  if (rows[0]) invalidateModelMwCache(rows[0].model_config_id);
  return rows[0] || null;
}

export async function removeModelMiddleware(modelMiddlewareId) {
  const { rows } = await query(
    'DELETE FROM model_middlewares WHERE id = $1 RETURNING *',
    [modelMiddlewareId]
  );
  if (rows[0]) invalidateModelMwCache(rows[0].model_config_id);
  return rows[0] || null;
}

export async function reorderModelMiddlewares(modelConfigId, orderedIds) {
  for (let i = 0; i < orderedIds.length; i++) {
    await query(
      'UPDATE model_middlewares SET sort_order = $1, updated_at = now() WHERE id = $2 AND model_config_id = $3',
      [i * 10, orderedIds[i], modelConfigId]
    );
  }
  invalidateModelMwCache(modelConfigId);
}
