import { query } from './init.mjs';
import { sha256, encrypt, decrypt, generateApiKey } from '../utils/crypto.mjs';

export async function findKeyByHash(hash) {
  const { rows } = await query(`
    SELECT * FROM api_keys
    WHERE key_hash = $1 AND is_revoked = false
  `, [hash]);
  const row = rows[0];
  if (!row) return null;
  // Check expiry
  if (row.expires_at && new Date(row.expires_at) < new Date()) return null;
  return row;
}

export async function resolveApiKey(rawKey) {
  const hash = sha256(rawKey);
  const keyRow = await findKeyByHash(hash);
  if (!keyRow) return null;
  // Update last_used_at
  await query('UPDATE api_keys SET last_used_at = now() WHERE id = $1', [keyRow.id]);
  return keyRow;
}

export async function listKeys() {
  const sql = `
    SELECT id, label, key_hint, daily_budget, rpm_limit, tpm_limit,
           expires_at, is_revoked, last_used_at, created_at
    FROM api_keys
    ORDER BY created_at DESC
  `;
  const { rows } = await query(sql);
  return rows;
}

export async function createKey({ label, daily_budget, rpm_limit, tpm_limit, expires_at, key }) {
  const rawKey = key || generateApiKey();
  const keyHash = sha256(rawKey);
  const encKey = encrypt(rawKey);
  const keyHint = rawKey.slice(0, 12) + '...' + rawKey.slice(-4);

  const { rows } = await query(`
    INSERT INTO api_keys (key_hash, encrypted_key, label, key_hint, daily_budget, rpm_limit, tpm_limit, expires_at)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
    RETURNING id, label, key_hint, daily_budget, rpm_limit, tpm_limit, expires_at, is_revoked, created_at
  `, [keyHash, encKey, label, keyHint, daily_budget ?? 2, rpm_limit ?? 60, tpm_limit ?? 100000, expires_at || null]);

  return { ...rows[0], key: rawKey };
}

export async function updateKey(id, fields) {
  const allowed = ['label', 'daily_budget', 'rpm_limit', 'tpm_limit'];
  const sets = [];
  const params = [];
  let idx = 1;
  for (const key of allowed) {
    if (key in fields) {
      sets.push(`${key} = $${idx++}`);
      params.push(fields[key] ?? null);
    }
  }
  if (sets.length === 0) return null;
  params.push(id);
  const { rows } = await query(
    `UPDATE api_keys SET ${sets.join(', ')} WHERE id = $${idx} RETURNING id, label, key_hint, daily_budget, rpm_limit, tpm_limit, expires_at, is_revoked, created_at`,
    params
  );
  return rows[0] || null;
}

export async function revokeKey(id) {
  const { rowCount } = await query(
    'UPDATE api_keys SET is_revoked = true WHERE id = $1',
    [id]
  );
  return rowCount > 0;
}

export async function resetBudget(id) {
  const { rows } = await query(
    `UPDATE api_keys SET budget_reset_at = now() WHERE id = $1
     RETURNING id, label, key_hint, daily_budget, budget_reset_at`,
    [id]
  );
  return rows[0] || null;
}
