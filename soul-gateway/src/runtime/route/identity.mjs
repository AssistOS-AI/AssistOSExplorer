/**
 * Route middleware: caller identity resolution.
 *
 * Reads soul/agent/session headers from the incoming request and stores
 * the resolved identity on `ctx.identity`.  This is what later middlewares
 * (session resolver, observability) use to attribute the request.
 *
 * @module runtime/route/identity
 */

import { resolveIdentity } from '../../request/identity.mjs';

/**
 * @returns {(ctx: object, next: () => Promise<void>) => Promise<void>}
 */
export function identityMiddleware() {
    return async function identity(ctx, next) {
        const headers = ctx.http?.req?.headers || {};
        ctx.identity = resolveIdentity(headers, headers['user-agent']);
        await next();
    };
}
