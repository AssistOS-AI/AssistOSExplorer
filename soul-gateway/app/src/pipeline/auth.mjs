import { resolveApiKey } from '../db/keys-dao.mjs';
import { AuthError } from '../utils/errors.mjs';

/**
 * Authenticate the request and resolve the soul family.
 * Returns: { family_id, family_name, api_key_id, rpm_limit, tpm_limit, model_mapping, allowed_models, soul_id }
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
    family_id: keyInfo.family_id,
    family_name: keyInfo.family_name,
    api_key_id: keyInfo.id,
    rpm_limit: keyInfo.rpm_limit,
    tpm_limit: keyInfo.tpm_limit,
    family_monthly_budget: keyInfo.family_monthly_budget != null ? Number(keyInfo.family_monthly_budget) : null,
    key_monthly_budget: keyInfo.monthly_budget != null ? Number(keyInfo.monthly_budget) : null,
    loop_rpm_limit: keyInfo.loop_rpm_limit != null ? Number(keyInfo.loop_rpm_limit) : null,
    loop_max_identical: keyInfo.loop_max_identical != null ? Number(keyInfo.loop_max_identical) : null,
    model_mapping: typeof keyInfo.model_mapping === 'string' ? JSON.parse(keyInfo.model_mapping) : (keyInfo.model_mapping || {}),
    allowed_models: typeof keyInfo.allowed_models === 'string' ? JSON.parse(keyInfo.allowed_models) : (keyInfo.allowed_models || []),
    soul_id: soulId,
  };
}
