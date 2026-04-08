/**
 * Route middleware: error boundary.
 *
 * The outermost middleware in a route chain.  Catches any error thrown
 * downstream, classifies it (typed `GatewayError` vs unhandled), logs it,
 * and writes the appropriate HTTP error response to `ctx.http.res`.
 *
 * Bind this FIRST in the chain so its post-phase catch block sees every
 * error from every other middleware.
 *
 * @module runtime/route/error-boundary
 */

import { sendError } from '../../core/responses.mjs';
import { GatewayError, InternalServerError } from '../../core/errors.mjs';

/**
 * @returns {(ctx: object, next: () => Promise<void>) => Promise<void>}
 */
export function errorBoundaryMiddleware() {
    return async function errorBoundary(ctx, next) {
        try {
            await next();
        } catch (err) {
            const totalMs = Date.now() - ctx.startedAt;
            ctx.metadata.totalMs = totalMs;

            const res = ctx.http?.res;

            if (err instanceof GatewayError) {
                ctx.log?.warn?.('pipeline error', {
                    requestId: ctx.requestId,
                    errorType: err.errorType,
                    message: err.message,
                    durationMs: totalMs,
                });
                if (res && !res.writableEnded && !res.headersSent) {
                    sendError(res, err);
                }
                return;
            }

            ctx.log?.error?.('unhandled pipeline error', {
                requestId: ctx.requestId,
                error: err.message,
                stack: err.stack,
                durationMs: totalMs,
            });
            if (res && !res.writableEnded && !res.headersSent) {
                sendError(res, new InternalServerError());
            }
        }
    };
}
