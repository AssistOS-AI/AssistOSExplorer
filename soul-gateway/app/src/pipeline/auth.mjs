import { resolveApiKey } from '../db/keys-dao.mjs';
import { AuthError } from '../utils/errors.mjs';

/**
 * Authenticate the request and resolve the API key.
 * Returns: { api_key_id, rpm_limit, tpm_limit, key_monthly_budget, soul_id }
 */
export async function authenticate(req) {
  const authHeader = req.headers['authorization'];
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    throw new AuthError('Missing or invalid Authorization header');
  }
  const rawKey = authHeader.slice(7).trim();
  if (!rawKey) throw new AuthError('Empty API key');

  const keyInfo = await resolveApiKey(rawKey);
  if (!keyInfo) {
    throw new AuthError('Invalid, expired, or revoked API key');
  }

  const soulId = req.headers['x-soul-id'] || 'anonymous';

  return {
    api_key_id: keyInfo.id,
    rpm_limit: keyInfo.rpm_limit,
    tpm_limit: keyInfo.tpm_limit,
    key_monthly_budget: keyInfo.monthly_budget != null ? Number(keyInfo.monthly_budget) : null,
    budget_reset_at: keyInfo.budget_reset_at || null,
    soul_id: soulId,
  };
}
