import { query } from './init.mjs';

export async function listRules() {
  const sql = 'SELECT * FROM blacklist_rules ORDER BY created_at';
  const { rows } = await query(sql);
  return rows;
}

export async function getEnabledRules() {
  const { rows } = await query(`
    SELECT * FROM blacklist_rules
    WHERE is_enabled = true
    ORDER BY created_at
  `);
  return rows;
}

export async function createRule({ pattern, match_type, action, description }) {
  const { rows } = await query(`
    INSERT INTO blacklist_rules (pattern, match_type, action, description)
    VALUES ($1, $2, $3, $4)
    RETURNING *
  `, [pattern, match_type, action || 'block', description]);
  return rows[0];
}

export async function updateRule(id, fields) {
  const sets = [];
  const values = [];
  let idx = 1;
  for (const [key, value] of Object.entries(fields)) {
    if (value !== undefined && ['pattern', 'match_type', 'action', 'description', 'is_enabled'].includes(key)) {
      sets.push(`${key} = $${idx}`);
      values.push(value);
      idx++;
    }
  }
  if (sets.length === 0) return null;
  values.push(id);
  const { rows } = await query(
    `UPDATE blacklist_rules SET ${sets.join(', ')} WHERE id = $${idx} RETURNING *`,
    values
  );
  return rows[0] || null;
}

export async function deleteRule(id) {
  const { rowCount } = await query('DELETE FROM blacklist_rules WHERE id = $1', [id]);
  return rowCount > 0;
}
