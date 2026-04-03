/**
 * DAO for the blacklist_rules table.
 * Pure data-access functions — no business logic.
 */

const TABLE = 'soul_gateway.blacklist_rules';

export async function create(pool, {
  ruleKey, description, matchType, pattern,
  caseSensitive = false, priority = 100, enabled = true,
  metadata = {},
}) {
  const { rows } = await pool.query(
    `INSERT INTO ${TABLE}
       (rule_key, description, match_type, pattern, case_sensitive, priority, enabled, metadata)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING *`,
    [ruleKey, description, matchType, pattern, caseSensitive, priority, enabled,
     JSON.stringify(metadata)],
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

export async function list(pool, { limit = 500, offset = 0 } = {}) {
  const { rows } = await pool.query(
    `SELECT * FROM ${TABLE} ORDER BY priority ASC, rule_key ASC LIMIT $1 OFFSET $2`,
    [limit, offset],
  );
  return rows;
}

export async function update(pool, id, fields) {
  const keys = Object.keys(fields);
  if (keys.length === 0) return null;

  const jsonFields = new Set(['metadata']);
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

export async function listEnabled(pool) {
  const { rows } = await pool.query(
    `SELECT * FROM ${TABLE} WHERE enabled = true ORDER BY priority ASC, rule_key ASC`,
  );
  return rows;
}

// ── helpers ──────────────────────────────────────────────────────────

function toSnake(camel) {
  return camel.replace(/[A-Z]/g, (ch) => '_' + ch.toLowerCase());
}
