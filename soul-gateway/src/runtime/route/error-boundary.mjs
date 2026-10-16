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
import { serializeSseError } from './canonical-stream-to-sse.mjs';

/**
 * Write a terminal SSE error event and end the response.
 *
 * Used when headers have already been sent (streaming in progress)
 * so we cannot use `sendError()` which sets status/headers.
 */
function emitSseError(res, routeKind, requestId, err) {
    res.write(serializeSseError(routeKind, requestId, err));
    res.end();
}

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
                if (res && !res.writableEnded) {
                    if (res.headersSent) {
                        emitSseError(
                            res,
                            ctx.route?.kind || 'openai_chat',
                            ctx.requestId,
                            err
                        );
                    } else {
                        sendError(res, err);
                    }
                }
                return;
            }

            ctx.log?.error?.('unhandled pipeline error', {
                requestId: ctx.requestId,
                error: err.message,
                stack: err.stack,
                durationMs: totalMs,
            });
            if (res && !res.writableEnded) {
                if (res.headersSent) {
                    emitSseError(
                        res,
                        ctx.route?.kind || 'openai_chat',
                        ctx.requestId,
                        new InternalServerError()
                    );
                } else {
                    sendError(res, new InternalServerError());
                }
            }
        }
    };
}
