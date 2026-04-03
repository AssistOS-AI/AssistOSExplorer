/**
 * DAO for the providers table.
 * Pure data-access functions — no business logic.
 */

const TABLE = 'soul_gateway.providers';

export async function create(pool, {
  providerKey, displayName, kind, adapterKey, authStrategy,
  providerMode = 'external_api', executorKey = null,
  oauthAdapterKey = null, baseUrl = null, enabled = true,
  supportsStreaming = true, supportsTools = true,
  supportsMessagesApi = false, supportsResponsesApi = false,
  settings = {}, metadata = {},
}) {
  const { rows } = await pool.query(
    `INSERT INTO ${TABLE}
       (provider_key, display_name, kind, adapter_key, auth_strategy,
        provider_mode, executor_key,
        oauth_adapter_key, base_url, enabled,
        supports_streaming, supports_tools,
        supports_messages_api, supports_responses_api,
        settings, metadata)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
     RETURNING *`,
    [providerKey, displayName, kind, adapterKey, authStrategy,
     providerMode, executorKey,
     oauthAdapterKey, baseUrl, enabled,
     supportsStreaming, supportsTools,
     supportsMessagesApi, supportsResponsesApi,
     JSON.stringify(settings), JSON.stringify(metadata)],
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

export async function findByKey(pool, providerKey) {
  const { rows } = await pool.query(
    `SELECT * FROM ${TABLE} WHERE provider_key = $1`,
    [providerKey],
  );
  return rows[0] || null;
}

export async function list(pool, { enabled = null, kind = null, limit = 200, offset = 0 } = {}) {
  const conditions = [];
  const params = [];
  let idx = 1;

  if (enabled !== null) {
    conditions.push(`enabled = $${idx++}`);
    params.push(enabled);
  }
  if (kind !== null) {
    conditions.push(`kind = $${idx++}`);
    params.push(kind);
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

  const jsonFields = new Set(['settings', 'metadata']);
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

// ── helpers ──────────────────────────────────────────────────────────

function toSnake(camel) {
  return camel.replace(/[A-Z]/g, (ch) => '_' + ch.toLowerCase());
}
