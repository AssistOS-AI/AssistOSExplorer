/**
 * DAO for the provider_accounts table.
 * Pure data-access functions — no business logic.
 */

const TABLE = 'soul_gateway.provider_accounts';

export async function create(pool, {
  providerId, accountLabel, authType, status = 'active',
  externalAccountId = null,
  secretCiphertext = null, secretIv = null, secretAuthTag = null, secretHint = null,
  credentialsPath = null,
  accessTokenExpiresAt = null, refreshTokenExpiresAt = null,
  refreshMarginSeconds = 300, quotaResetsAt = null,
  metadata = {},
}) {
  const { rows } = await pool.query(
    `INSERT INTO ${TABLE}
       (provider_id, account_label, auth_type, status,
        external_account_id,
        secret_ciphertext, secret_iv, secret_auth_tag, secret_hint,
        credentials_path,
        access_token_expires_at, refresh_token_expires_at,
        refresh_margin_seconds, quota_resets_at,
        metadata)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
     RETURNING *`,
    [providerId, accountLabel, authType, status,
     externalAccountId,
     secretCiphertext, secretIv, secretAuthTag, secretHint,
     credentialsPath,
     accessTokenExpiresAt, refreshTokenExpiresAt,
     refreshMarginSeconds, quotaResetsAt,
     JSON.stringify(metadata)],
  );
  return rows[0];
}

export async function findById(pool, id) {
  const { rows } = await pool.query(
    `SELECT * FROM ${TABLE} WHERE id = $1 AND deleted_at IS NULL`,
    [id],
  );
  return rows[0] || null;
}

export async function findByProviderAndExternalAccount(pool, providerId, externalAccountId) {
  if (!externalAccountId) return null;
  const { rows } = await pool.query(
    `SELECT * FROM ${TABLE}
     WHERE provider_id = $1
       AND external_account_id = $2
       AND deleted_at IS NULL
     LIMIT 1`,
    [providerId, externalAccountId],
  );
  return rows[0] || null;
}

export async function listByProvider(pool, providerId, { includeDeleted = false } = {}) {
  const deletedFilter = includeDeleted ? '' : 'AND deleted_at IS NULL';
  const { rows } = await pool.query(
    `SELECT * FROM ${TABLE}
     WHERE provider_id = $1 ${deletedFilter}
     ORDER BY last_used_at ASC NULLS FIRST`,
    [providerId],
  );
  return rows;
}

export async function updateStatus(pool, id, status, { lastErrorType = null, lastErrorMessage = null } = {}) {
  const { rows } = await pool.query(
    `UPDATE ${TABLE}
     SET status = $2,
         last_error_type = COALESCE($3, last_error_type),
         last_error_message = COALESCE($4, last_error_message),
         last_error_at = CASE WHEN $3 IS NOT NULL THEN now() ELSE last_error_at END,
         updated_at = now()
     WHERE id = $1 AND deleted_at IS NULL
     RETURNING *`,
    [id, status, lastErrorType, lastErrorMessage],
  );
  return rows[0] || null;
}

export async function markExhausted(pool, id, quotaResetsAt = null) {
  const { rows } = await pool.query(
    `UPDATE ${TABLE}
     SET status = 'quota_exhausted',
         quota_resets_at = $2,
         updated_at = now()
     WHERE id = $1 AND deleted_at IS NULL
     RETURNING *`,
    [id, quotaResetsAt],
  );
  return rows[0] || null;
}

export async function markRefreshing(pool, id) {
  const { rows } = await pool.query(
    `UPDATE ${TABLE}
     SET status = 'refreshing', updated_at = now()
     WHERE id = $1 AND deleted_at IS NULL
     RETURNING *`,
    [id],
  );
  return rows[0] || null;
}

export async function updateTokenExpiry(pool, id, { accessTokenExpiresAt = null, refreshTokenExpiresAt = null }) {
  const { rows } = await pool.query(
    `UPDATE ${TABLE}
     SET access_token_expires_at = COALESCE($2, access_token_expires_at),
         refresh_token_expires_at = COALESCE($3, refresh_token_expires_at),
         status = 'active',
         updated_at = now()
     WHERE id = $1 AND deleted_at IS NULL
     RETURNING *`,
    [id, accessTokenExpiresAt, refreshTokenExpiresAt],
  );
  return rows[0] || null;
}

export async function upsertOAuth(pool, {
  providerId,
  accountLabel,
  externalAccountId = null,
  credentialsPath,
  accessTokenExpiresAt = null,
  refreshTokenExpiresAt = null,
  refreshMarginSeconds = 300,
  quotaResetsAt = null,
  metadata = {},
}) {
  const { rows } = await pool.query(
    `INSERT INTO ${TABLE}
       (provider_id, account_label, auth_type, status, external_account_id,
        credentials_path, access_token_expires_at, refresh_token_expires_at,
        refresh_margin_seconds, quota_resets_at, metadata)
     VALUES ($1, $2, 'oauth', 'active', $3, $4, $5, $6, $7, $8, $9)
     ON CONFLICT (provider_id, external_account_id)
       WHERE deleted_at IS NULL
     DO UPDATE SET
       account_label = EXCLUDED.account_label,
       credentials_path = EXCLUDED.credentials_path,
       access_token_expires_at = EXCLUDED.access_token_expires_at,
       refresh_token_expires_at = EXCLUDED.refresh_token_expires_at,
       refresh_margin_seconds = EXCLUDED.refresh_margin_seconds,
       quota_resets_at = EXCLUDED.quota_resets_at,
       metadata = EXCLUDED.metadata,
       status = 'active',
       deleted_at = NULL,
       updated_at = now()
     RETURNING *`,
    [
      providerId,
      accountLabel,
      externalAccountId,
      credentialsPath,
      accessTokenExpiresAt,
      refreshTokenExpiresAt,
      refreshMarginSeconds,
      quotaResetsAt,
      JSON.stringify(metadata),
    ],
  );
  return rows[0] || null;
}

export async function del(pool, id) {
  const { rows } = await pool.query(
    `UPDATE ${TABLE}
     SET deleted_at = now(), status = 'deleted', updated_at = now()
     WHERE id = $1 AND deleted_at IS NULL
     RETURNING *`,
    [id],
  );
  return rows[0] || null;
}

export async function listExpiringOAuth(pool, withinSeconds = 300) {
  const { rows } = await pool.query(`
    SELECT pa.id, pa.provider_id, pa.status, pa.access_token_expires_at, pa.refresh_margin_seconds,
           p.oauth_adapter_key
    FROM soul_gateway.provider_accounts pa
    JOIN soul_gateway.providers p ON p.id = pa.provider_id
    WHERE pa.auth_type = 'oauth'
      AND pa.status IN ('active', 'refreshing')
      AND pa.access_token_expires_at IS NOT NULL
      AND pa.access_token_expires_at <= now() + make_interval(secs => GREATEST(pa.refresh_margin_seconds, $1))
  `, [withinSeconds]);
  return rows;
}

export async function sweepExpiredQuotas(pool) {
  const { rows } = await pool.query(`
    UPDATE soul_gateway.provider_accounts
    SET status = 'active', quota_resets_at = NULL, updated_at = now()
    WHERE status = 'quota_exhausted'
      AND quota_resets_at IS NOT NULL
      AND quota_resets_at <= now()
    RETURNING id, provider_id
  `);
  return rows;
}
