import { query } from './init.mjs';

export async function listFamilies() {
  const { rows } = await query('SELECT * FROM soul_families ORDER BY created_at');
  return rows;
}

export async function getFamilyById(id) {
  const { rows } = await query('SELECT * FROM soul_families WHERE id = $1', [id]);
  return rows[0] || null;
}

export async function getFamilyByName(name) {
  const { rows } = await query('SELECT * FROM soul_families WHERE name = $1', [name]);
  return rows[0] || null;
}

export async function createFamily({ name, description, model_mapping, allowed_models, rpm_limit, tpm_limit, monthly_budget, metadata }) {
  const { rows } = await query(`
    INSERT INTO soul_families (name, description, model_mapping, allowed_models, rpm_limit, tpm_limit, monthly_budget, metadata)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
    RETURNING *
  `, [name, description, model_mapping || '{}', allowed_models || '[]', rpm_limit || 60, tpm_limit || 100000, monthly_budget ?? null, metadata || '{}']);
  return rows[0];
}

export async function updateFamily(id, fields) {
  const sets = [];
  const values = [];
  let idx = 1;

  for (const [key, value] of Object.entries(fields)) {
    if (value !== undefined && ['name', 'description', 'model_mapping', 'allowed_models', 'rpm_limit', 'tpm_limit', 'monthly_budget', 'loop_rpm_limit', 'loop_max_identical', 'metadata'].includes(key)) {
      sets.push(`${key} = $${idx}`);
      values.push(key === 'model_mapping' || key === 'allowed_models' || key === 'metadata'
        ? JSON.stringify(value) : value);
      idx++;
    }
  }

  if (sets.length === 0) return null;

  sets.push(`updated_at = now()`);
  values.push(id);
  const { rows } = await query(
    `UPDATE soul_families SET ${sets.join(', ')} WHERE id = $${idx} RETURNING *`,
    values
  );
  return rows[0] || null;
}

export async function deleteFamily(id) {
  const { rowCount } = await query('DELETE FROM soul_families WHERE id = $1', [id]);
  return rowCount > 0;
}
