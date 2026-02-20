import { query } from './init.mjs';
import { sha256, encrypt, decrypt, generateApiKey } from '../utils/crypto.mjs';

export async function findKeyByHash(hash) {
  const { rows } = await query(`
    SELECT k.*, f.name as family_name, f.rpm_limit, f.tpm_limit,
           f.model_mapping, f.allowed_models, f.metadata as family_metadata
    FROM api_keys k
    JOIN soul_families f ON k.family_id = f.id
    WHERE k.key_hash = $1 AND k.is_revoked = false
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

export async function listKeys(familyId) {
  let sql = `
    SELECT k.id, k.family_id, k.key_type, k.label, k.key_hint, k.expires_at,
           k.is_revoked, k.last_used_at, k.created_at, f.name as family_name
    FROM api_keys k
    JOIN soul_families f ON k.family_id = f.id
  `;
  const params = [];
  if (familyId) {
    sql += ' WHERE k.family_id = $1';
    params.push(familyId);
  }
  sql += ' ORDER BY k.created_at DESC';
  const { rows } = await query(sql, params);
  return rows;
}

export async function createKey({ family_id, key_type, label, expires_at, key }) {
  const rawKey = key || generateApiKey();
  const keyHash = sha256(rawKey);
  const encKey = encrypt(rawKey);
  const keyHint = rawKey.slice(0, 12) + '...' + rawKey.slice(-4);

  const { rows } = await query(`
    INSERT INTO api_keys (family_id, key_hash, encrypted_key, key_type, label, key_hint, expires_at)
    VALUES ($1, $2, $3, $4, $5, $6, $7)
    RETURNING id, family_id, key_type, label, key_hint, expires_at, is_revoked, created_at
  `, [family_id, keyHash, encKey, key_type || 'permanent', label, keyHint, expires_at || null]);

  return { ...rows[0], key: rawKey };
}

export async function revokeKey(id) {
  const { rowCount } = await query(
    'UPDATE api_keys SET is_revoked = true WHERE id = $1',
    [id]
  );
  return rowCount > 0;
}
