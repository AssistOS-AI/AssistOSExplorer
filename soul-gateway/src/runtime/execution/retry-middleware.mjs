/**
 * Retry middleware.
 *
 * Wraps an attempt subchain with HTTP-level retry semantics: the chain
 * is executed up to `policy.maxAttempts` times in forked contexts, and
 * the first successful run's response and metadata are merged back to
 * the parent ctx.  Failed attempts whose error is `retryable=true`
 * trigger a backoff sleep and another attempt; non-retryable errors
 * propagate immediately.
 *
 * The retry middleware is a wrapping middleware: it does call `next()`
 * once a successful attempt has populated the parent ctx, so additional
 * post-phase middlewares (like `finalizeDirectResultMiddleware`) can
 * still run.
 *
 * Reads:
 *   - `ctx.target.model.retryPolicy`
 *   - `ctx.appCtx.config.env.HTTP_RETRY_*`
 *
 * Writes:
 *   - `ctx.response` — copied from the successful attempt
 *   - `ctx.metadata.retryTrace` — error trace across attempts
 *   - `ctx.metadata.backendAccountId` — copied from the successful attempt
 *
 * @module runtime/execution/retry-middleware
 */

import { compose, forkKernelContext } from '../kernel/index.mjs';
import { executeWithHttpRetry } from './http-retry.mjs';

/**
 * @param {object} options
 * @param {Array<Function>} options.attemptChain - middlewares run inside one attempt
 * @returns {(ctx: object, next: () => Promise<void>) => Promise<void>}
 */
export function retryMiddleware(options = {}) {
    if (!Array.isArray(options.attemptChain)) {
        throw new TypeError(
            'retryMiddleware: options.attemptChain (Array) is required'
        );
    }
    const attemptChain = options.attemptChain;
    const dispatch = compose([...attemptChain]);

    return async function retry(ctx, next) {
        const env = ctx.appCtx?.config?.env || {};
        const model = ctx.target?.model || {};
        const retryPolicyConfig = model.retryPolicy || model.retry_policy || {};
        const policy = {
            maxAttempts:
                retryPolicyConfig.maxAttempts ?? env.HTTP_RETRY_MAX_ATTEMPTS,
            baseDelayMs:
                retryPolicyConfig.baseDelayMs ?? env.HTTP_RETRY_BASE_DELAY_MS,
            multiplier:
                retryPolicyConfig.multiplier ?? env.HTTP_RETRY_MULTIPLIER,
            maxDelayMs:
                retryPolicyConfig.maxDelayMs ?? env.HTTP_RETRY_MAX_DELAY_MS,
            jitterPct: retryPolicyConfig.jitterPct ?? env.HTTP_RETRY_JITTER_PCT,
        };

        const { result, error, trace } = await executeWithHttpRetry(
            policy,
            async (attemptIndex) => {
                const attemptCtx = forkKernelContext(ctx, {
                    request: ctx.request,
                    target: ctx.target,
                    attempt: { index: attemptIndex, previousErrors: [] },
                });
                // Forks reset state Map; carry over services and appCtx so
                // downstream middlewares see the same singletons.
                attemptCtx.services = ctx.services;
                attemptCtx.signal = ctx.signal;

                await dispatch(attemptCtx);

                return {
                    response: attemptCtx.response,
                    accountId: attemptCtx.metadata?.backendAccountId || null,
                    metadata: attemptCtx.metadata || {},
                };
            }
        );

        ctx.metadata.retryTrace = trace || [];

        if (error) throw error;

        // Promote the successful attempt's response and selected metadata
        // back to the parent ctx.
        ctx.response = result.response;
        if (result.accountId !== null && result.accountId !== undefined) {
            ctx.metadata.backendAccountId = result.accountId;
        }

        await next();
    };
}
