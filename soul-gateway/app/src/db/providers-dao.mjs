import { query } from './init.mjs';
import { encrypt, decrypt } from '../utils/crypto.mjs';

const SAFE_COLUMNS = 'id, name, display_name, protocol, base_url, key_hint, billing_type, is_enabled, created_at, updated_at';

export async function listProviders() {
  const { rows } = await query(`SELECT ${SAFE_COLUMNS} FROM provider_configs ORDER BY name ASC`);
  return rows;
}

export async function getProviderById(id) {
  const { rows } = await query(`SELECT ${SAFE_COLUMNS} FROM provider_configs WHERE id = $1`, [id]);
  return rows[0] || null;
}

export async function getProviderByName(name) {
  const { rows } = await query(`SELECT ${SAFE_COLUMNS} FROM provider_configs WHERE name = $1`, [name]);
  return rows[0] || null;
}

export async function getProviderApiKey(id) {
  const { rows } = await query('SELECT encrypted_api_key FROM provider_configs WHERE id = $1', [id]);
  if (!rows[0]?.encrypted_api_key) return null;
  return decrypt(rows[0].encrypted_api_key);
}

/**
 * Resolve a provider by name, returning config WITH decrypted API key.
 * Used by dispatch when provider_config_id is NULL but a DB provider exists.
 */
export async function resolveProviderByName(name) {
  const { rows } = await query(
    'SELECT id, name, protocol, base_url, encrypted_api_key, is_enabled FROM provider_configs WHERE name = $1',
    [name]
  );
  if (!rows[0]) return null;
  const row = rows[0];
  return {
    id: row.id,
    name: row.name,
    protocol: row.protocol,
    base_url: row.base_url,
    is_enabled: row.is_enabled,
    api_key: row.encrypted_api_key ? decrypt(row.encrypted_api_key) : null,
  };
}

export async function createProvider({ name, display_name, protocol, base_url, api_key, billing_type }) {
  const encKey = encrypt(api_key);
  const keyHint = api_key.length > 12
    ? api_key.slice(0, 8) + '...' + api_key.slice(-4)
    : api_key.slice(0, 4) + '...';

  const { rows } = await query(`
    INSERT INTO provider_configs (name, display_name, protocol, base_url, encrypted_api_key, key_hint, billing_type)
    VALUES ($1, $2, $3, $4, $5, $6, $7)
    RETURNING ${SAFE_COLUMNS}
  `, [name, display_name || name, protocol || 'openai', base_url, encKey, keyHint, billing_type || 'api_key']);
  return rows[0];
}

const UPDATABLE_FIELDS = ['name', 'display_name', 'protocol', 'base_url', 'billing_type', 'is_enabled'];

export async function updateProvider(id, fields) {
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

  // Handle API key re-encryption
  if (fields.api_key && typeof fields.api_key === 'string' && fields.api_key.length > 0) {
    const encKey = encrypt(fields.api_key);
    const keyHint = fields.api_key.length > 12
      ? fields.api_key.slice(0, 8) + '...' + fields.api_key.slice(-4)
      : fields.api_key.slice(0, 4) + '...';
    sets.push(`encrypted_api_key = $${idx}`);
    values.push(encKey);
    idx++;
    sets.push(`key_hint = $${idx}`);
    values.push(keyHint);
    idx++;
  }

  if (sets.length === 0) return null;

  sets.push(`updated_at = now()`);
  values.push(id);

  const { rows } = await query(
    `UPDATE provider_configs SET ${sets.join(', ')} WHERE id = $${idx} RETURNING ${SAFE_COLUMNS}`,
    values
  );
  return rows[0] || null;
}

export async function deleteProvider(id) {
  const { rows } = await query(
    `DELETE FROM provider_configs WHERE id = $1 RETURNING id, name`,
    [id]
  );
  return rows[0] || null;
}
