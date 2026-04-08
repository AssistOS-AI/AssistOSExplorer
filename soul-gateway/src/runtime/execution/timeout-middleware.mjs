/**
 * Timeout middleware.
 *
 * Installs a per-attempt `AbortSignal` on `ctx.signal` for the duration
 * of one downstream invocation.  After `next()` resolves (success or
 * error), the timer is cleared.
 *
 * Reads:
 *   - `ctx.target.model.requestTimeoutMs`
 *   - `ctx.appCtx.config.env.DEFAULT_REQUEST_TIMEOUT_MS`
 *
 * Writes:
 *   - `ctx.signal`
 *
 * @module runtime/execution/timeout-middleware
 */

import { withExecutionTimeout } from './timeout-controller.mjs';

/**
 * @returns {(ctx: object, next: () => Promise<void>) => Promise<void>}
 */
export function timeoutMiddleware() {
    return async function timeout(ctx, next) {
        const model = ctx.target?.model;
        if (!model) {
            throw new TypeError(
                'timeoutMiddleware: ctx.target.model is required'
            );
        }
        const env = ctx.appCtx?.config?.env || {};
        const timeoutMs =
            model.requestTimeoutMs ||
            model.request_timeout_ms ||
            env.DEFAULT_REQUEST_TIMEOUT_MS;
        const providerKey =
            model.providerKey || model.provider_key || model.modelKey;

        const previousSignal = ctx.signal;
        const { signal, clear } = withExecutionTimeout(timeoutMs, providerKey);
        ctx.signal = signal;

        try {
            await next();
        } finally {
            clear();
            ctx.signal = previousSignal;
        }
    };
}
