/**
 * Route middleware: API key authentication.
 *
 * Verifies the bearer token via the configured auth path.  When the
 * gateway is running without auth configured (no DATABASE_URL or no
 * encryption key) and `ALLOW_UNAUTHENTICATED=true`, falls back to a
 * permissive stub.
 *
 * Sets `ctx.auth` to the route auth view shape:
 *   { keyId, label, rpmLimit, tpmLimit, apiKeyRecord }
 *
 * Throws `AuthenticationRequiredError` when auth is required but not
 * configured and the permissive opt-in is missing.
 *
 * @module runtime/route/authenticate
 */

import { AuthenticationRequiredError } from '../../core/errors.mjs';
import { authenticateApiKey } from '../security/api-key-auth.mjs';

let _permissiveWarned = false;

/**
 * @returns {(ctx: object, next: () => Promise<void>) => Promise<void>}
 */
export function authenticateMiddleware() {
    return async function authenticate(ctx, next) {
        const start = Date.now();
        const env = ctx.appCtx?.config?.env || {};
        const pool = ctx.appCtx?.pool;

        const authHeader = ctx.http?.req?.headers?.['authorization'] || '';

        const hasDb = pool && env.DATABASE_URL;
        const hasKey = env.ENCRYPTION_KEY || env.API_KEY_HASH_PEPPER;

        let apiKey = null;
        if (hasDb && hasKey) {
            apiKey = await authenticateApiKey(authHeader, ctx.appCtx);
        } else if (env.ALLOW_UNAUTHENTICATED) {
            if (!_permissiveWarned) {
                ctx.appCtx?.log?.warn?.(
                    'ALLOW_UNAUTHENTICATED=true — API key auth disabled'
                );
                _permissiveWarned = true;
            }
            apiKey = {
                id: 'permissive-stub',
                label: 'unauthenticated',
                status: 'active',
                rpm_limit: env.DEFAULT_RPM_LIMIT,
                tpm_limit: env.DEFAULT_TPM_LIMIT,
                daily_budget_usd: null,
                monthly_budget_usd: null,
            };
        } else {
            throw new AuthenticationRequiredError(
                'API key authentication is not configured. Set ENCRYPTION_KEY or API_KEY_HASH_PEPPER, ' +
                    'or set ALLOW_UNAUTHENTICATED=true to disable auth (development only).'
            );
        }

        ctx.auth = {
            keyId: apiKey.id || 'anonymous',
            label: apiKey.label || null,
            rpmLimit: apiKey.rpm_limit ?? env.DEFAULT_RPM_LIMIT ?? null,
            tpmLimit: apiKey.tpm_limit ?? env.DEFAULT_TPM_LIMIT ?? null,
            apiKeyRecord: apiKey,
        };
        ctx.metadata.authMs = Date.now() - start;

        await next();
    };
}

/** Test helper — reset the "permissive mode" warning latch. */
export function _resetPermissiveWarning() {
    _permissiveWarned = false;
}
