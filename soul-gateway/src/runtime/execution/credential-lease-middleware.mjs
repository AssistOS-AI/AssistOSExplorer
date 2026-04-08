/**
 * Credential lease middleware.
 *
 * Leases provider credentials for the duration of one downstream
 * invocation and stores the lease at `ctx.target.credentialLease` so
 * the transport terminal can use it.  The lease is released in the
 * `finally` block whether the attempt succeeds or fails.
 *
 * Reads:
 *   - `ctx.target.model.providerId`
 *   - `ctx.appCtx.services.credentialManager`
 *
 * Writes:
 *   - `ctx.target.credentialLease`
 *
 * If no credential manager is registered (test fixtures, dev mode), the
 * middleware passes through without leasing anything.  The transport is
 * then responsible for handling a `null` lease.
 *
 * @module runtime/execution/credential-lease-middleware
 */

/**
 * @returns {(ctx: object, next: () => Promise<void>) => Promise<void>}
 */
export function credentialLeaseMiddleware() {
    return async function credentialLease(ctx, next) {
        const credentialManager =
            ctx.appCtx?.services?.credentialManager || null;
        if (!credentialManager) {
            await next();
            return;
        }

        const model = ctx.target?.model;
        if (!model) {
            throw new TypeError(
                'credentialLeaseMiddleware: ctx.target.model is required'
            );
        }

        const providerId = model.providerId || model.provider_id;
        if (!providerId) {
            await next();
            return;
        }

        const lease = await credentialManager.getCredentials(providerId);
        const previousLease = ctx.target.credentialLease;
        ctx.target = { ...ctx.target, credentialLease: lease };

        try {
            await next();
        } finally {
            if (lease) credentialManager.release(lease);
            ctx.target = { ...ctx.target, credentialLease: previousLease };
        }
    };
}
