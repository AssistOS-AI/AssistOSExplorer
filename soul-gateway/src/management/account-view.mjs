/**
 * Provider-account view transforms.
 *
 * The dashboard expects OAuth account rows in a flattened, camelCase
 * shape (email at top level, derived quota/reauth booleans, computed
 * expiryWarning/daysUntilExpiry, aggregate provider status). The
 * database stores accounts in snake_case with the email nested inside
 * the metadata JSON column and secrets alongside it.
 *
 * These helpers bridge the two shapes without leaking secrets to the
 * client.
 */

const DAY_MS = 86_400_000;
const EXPIRY_WARNING_DAYS = 30;
const SECRET_METADATA_KEYS = new Set([
  'access_token',
  'refresh_token',
  'github_access_token',
  'githubAccessToken',
  'id_token',
  'idToken',
]);

/**
 * Transform a provider_accounts DB row into the dashboard view model.
 *
 * @param {object} row  Raw DB row
 * @returns {object}    Sanitised view with flat, camelCase fields
 */
export function toAccountView(row) {
  if (!row) return null;

  const metadata = row.metadata || {};
  const email = metadata.email || metadata.login || null;
  const expiresAt = row.access_token_expires_at || null;
  const expiresAtMs = expiresAt ? new Date(expiresAt).getTime() : null;
  const nowMs = Date.now();
  const daysUntilExpiry = expiresAtMs != null
    ? Math.floor((expiresAtMs - nowMs) / DAY_MS)
    : null;

  const quotaExhausted = row.status === 'quota_exhausted';
  const needsReauth = row.status === 'reauth_required' || row.status === 'disabled';
  const hasRefreshToken = Boolean(
    metadata.refresh_token
      || metadata.refreshToken
      || metadata.github_access_token
      || metadata.githubAccessToken,
  );
  const noRefreshToken = !hasRefreshToken && expiresAtMs != null;
  const expiryWarning = daysUntilExpiry != null
    && daysUntilExpiry > 0
    && daysUntilExpiry <= EXPIRY_WARNING_DAYS;

  // Strip secret-bearing keys from metadata before exposing it.
  const safeMetadata = {};
  for (const [key, value] of Object.entries(metadata)) {
    if (SECRET_METADATA_KEYS.has(key)) continue;
    safeMetadata[key] = value;
  }

  return {
    id: row.id,
    label: row.account_label || null,
    email,
    authType: row.auth_type,
    status: row.status,
    externalAccountId: row.external_account_id || null,
    expiresAt,
    refreshTokenExpiresAt: row.refresh_token_expires_at || null,
    quotaExhausted,
    quotaResetAt: row.quota_resets_at || null,
    needsReauth,
    expiryWarning,
    noRefreshToken,
    daysUntilExpiry,
    lastUsedAt: row.last_used_at || null,
    lastErrorType: row.last_error_type || null,
    lastErrorMessage: row.last_error_message || null,
    metadata: safeMetadata,
  };
}

/**
 * Derive the aggregate dashboard status ('active', 'expiring',
 * 'all_exhausted', 'needs_reauth', 'no_accounts') from a set of
 * account view models, plus an activeIndex pointing at the preferred
 * account (the first non-exhausted, non-errored one).
 *
 * @param {Array<object>} views  Account view models (from toAccountView)
 * @returns {{ status: string, activeIndex: string|null }}
 */
export function deriveAggregateStatus(views) {
  if (!views.length) {
    return { status: 'no_accounts', activeIndex: null };
  }
  if (views.every((v) => v.quotaExhausted)) {
    return { status: 'all_exhausted', activeIndex: null };
  }

  const primary = views.find((v) => !v.quotaExhausted && !v.needsReauth) || null;
  const activeIndex = primary ? primary.id : null;

  if (!primary) {
    if (views.some((v) => v.needsReauth)) {
      return { status: 'needs_reauth', activeIndex: null };
    }
    return { status: 'no_accounts', activeIndex: null };
  }

  if (primary.expiryWarning) {
    return { status: 'expiring', activeIndex };
  }
  return { status: 'active', activeIndex };
}

/**
 * Build the full accounts payload the dashboard consumes. Returns both
 * `data` (legacy compat) and `accounts` (dashboard reads this) pointing
 * to the same transformed list.
 *
 * @param {Array<object>} rows  Raw DB rows
 * @returns {object}            Payload ready for sendJson
 */
export function buildAccountsPayload(rows) {
  const views = (rows || []).map(toAccountView).filter(Boolean);
  const { status, activeIndex } = deriveAggregateStatus(views);
  return {
    status,
    activeIndex,
    accounts: views,
    data: views,
  };
}
