import { query } from './init.mjs';

export async function listRules(familyId) {
  let sql = 'SELECT * FROM blacklist_rules';
  const params = [];
  if (familyId) {
    sql += ' WHERE family_id = $1 OR family_id IS NULL';
    params.push(familyId);
  }
  sql += ' ORDER BY created_at';
  const { rows } = await query(sql, params);
  return rows;
}

export async function getEnabledRules(familyId) {
  const { rows } = await query(`
    SELECT * FROM blacklist_rules
    WHERE is_enabled = true AND (family_id IS NULL OR family_id = $1)
    ORDER BY created_at
  `, [familyId]);
  return rows;
}

export async function createRule({ family_id, pattern, match_type, action, description }) {
  const { rows } = await query(`
    INSERT INTO blacklist_rules (family_id, pattern, match_type, action, description)
    VALUES ($1, $2, $3, $4, $5)
    RETURNING *
  `, [family_id || null, pattern, match_type, action || 'block', description]);
  return rows[0];
}

export async function updateRule(id, fields) {
  const sets = [];
  const values = [];
  let idx = 1;
  for (const [key, value] of Object.entries(fields)) {
    if (value !== undefined && ['family_id', 'pattern', 'match_type', 'action', 'description', 'is_enabled'].includes(key)) {
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
