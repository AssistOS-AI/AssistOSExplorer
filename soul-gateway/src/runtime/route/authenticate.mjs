/**
 * Route middleware: API key authentication.
 *
 * Verifies the bearer token via the configured auth path.  When the
 * gateway is running without a database and `ALLOW_UNAUTHENTICATED=true`,
 * falls back to a permissive stub.
 *
 * Sets `ctx.auth` to the route auth view shape:
 *   { keyId, label, rpmLimit, tpmLimit, apiKeyRecord }
 *
 * Throws `AuthenticationRequiredError` when auth is required but not
 * configured and the permissive opt-in is missing.
 *
 * @module runtime/route/authenticate
 */

import { AuthenticationRequiredError, GatewayError } from '../../core/errors.mjs';
import { HTTP_STATUS } from '../../core/constants.mjs';
import { authenticateApiKey } from '../security/api-key-auth.mjs';

let _permissiveWarned = false;

/**
 * Legacy Soul Gateway identity headers. Identity now comes solely from the
 * signed-subject API key, so any request that still carries one of these is
 * rejected before authentication runs.
 */
const LEGACY_IDENTITY_HEADERS = ['x-soul-id', 'x-agent-name', 'x-soul-agent'];

/**
 * @returns {(ctx: object, next: () => Promise<void>) => Promise<void>}
 */
export function authenticateMiddleware() {
    return async function authenticate(ctx, next) {
        const headers = ctx.http?.req?.headers || {};
        for (const name of LEGACY_IDENTITY_HEADERS) {
            if (headers[name] !== undefined) {
                throw new GatewayError(
                    'Legacy Soul Gateway identity headers are not supported; ' +
                        'use the signed-subject API key.',
                    {
                        httpStatus: HTTP_STATUS.BAD_REQUEST,
                        errorType: 'invalid_request_error',
                    }
                );
            }
        }

        const start = Date.now();
        const env = ctx.appCtx?.config?.env || {};
        const pool = ctx.appCtx?.pool;

        const authHeader = ctx.http?.req?.headers?.['authorization'] || '';

        let apiKey = null;
        if (pool) {
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
                'API key authentication is not configured. Open the persistent database, ' +
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
