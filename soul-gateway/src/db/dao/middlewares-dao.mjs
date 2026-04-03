/**
 * DAO for the middlewares table.
 * Pure data-access functions — no business logic.
 */

const TABLE = 'soul_gateway.middlewares';

export async function create(pool, {
  middlewareKey, displayName, sourceType, hookMode,
  modulePath, version, checksum,
  defaultSettings = {}, enabled = true, metadata = {},
}) {
  const { rows } = await pool.query(
    `INSERT INTO ${TABLE}
       (middleware_key, display_name, source_type, hook_mode,
        module_path, version, checksum,
        default_settings, enabled, metadata)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
     RETURNING *`,
    [middlewareKey, displayName, sourceType, hookMode,
     modulePath, version, checksum,
     JSON.stringify(defaultSettings), enabled, JSON.stringify(metadata)],
  );
  return rows[0];
}

export async function findById(pool, id) {
  const { rows } = await pool.query(
    `SELECT * FROM ${TABLE} WHERE id = $1`,
    [id],
  );
  return rows[0] || null;
}

export async function findByKey(pool, middlewareKey) {
  const { rows } = await pool.query(
    `SELECT * FROM ${TABLE} WHERE middleware_key = $1`,
    [middlewareKey],
  );
  return rows[0] || null;
}

export async function list(pool, { enabled = null, sourceType = null, limit = 200, offset = 0 } = {}) {
  const conditions = [];
  const params = [];
  let idx = 1;

  if (enabled !== null) {
    conditions.push(`enabled = $${idx++}`);
    params.push(enabled);
  }
  if (sourceType !== null) {
    conditions.push(`source_type = $${idx++}`);
    params.push(sourceType);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  params.push(limit, offset);

  const { rows } = await pool.query(
    `SELECT * FROM ${TABLE} ${where} ORDER BY display_name ASC LIMIT $${idx++} OFFSET $${idx}`,
    params,
  );
  return rows;
}

export async function update(pool, id, fields) {
  const keys = Object.keys(fields);
  if (keys.length === 0) return null;

  const jsonFields = new Set(['defaultSettings', 'metadata']);
  const setClauses = keys.map((k, i) => `${toSnake(k)} = $${i + 2}`);
  const values = keys.map((k) => jsonFields.has(k) ? JSON.stringify(fields[k]) : fields[k]);

  const { rows } = await pool.query(
    `UPDATE ${TABLE} SET ${setClauses.join(', ')}, updated_at = now() WHERE id = $1 RETURNING *`,
    [id, ...values],
  );
  return rows[0] || null;
}

/**
 * Insert or update a middleware discovered at boot/scan time.
 * Uses middleware_key as the conflict target.
 */
export async function upsertFromDiscovery(pool, {
  middlewareKey, displayName, sourceType, hookMode,
  modulePath, version, checksum,
  defaultSettings = {}, metadata = {},
}) {
  const { rows } = await pool.query(
    `INSERT INTO ${TABLE}
       (middleware_key, display_name, source_type, hook_mode,
        module_path, version, checksum,
        default_settings, metadata)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     ON CONFLICT (middleware_key) DO UPDATE SET
       display_name = EXCLUDED.display_name,
       source_type = EXCLUDED.source_type,
       hook_mode = EXCLUDED.hook_mode,
       module_path = EXCLUDED.module_path,
       version = EXCLUDED.version,
       checksum = EXCLUDED.checksum,
       default_settings = EXCLUDED.default_settings,
       metadata = EXCLUDED.metadata,
       updated_at = now()
     RETURNING *`,
    [middlewareKey, displayName, sourceType, hookMode,
     modulePath, version, checksum,
     JSON.stringify(defaultSettings), JSON.stringify(metadata)],
  );
  return rows[0];
}

// ── helpers ──────────────────────────────────────────────────────────

function toSnake(camel) {
  return camel.replace(/[A-Z]/g, (ch) => '_' + ch.toLowerCase());
}
