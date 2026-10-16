/**
 * Concurrency middleware.
 *
 * Acquires a per-model concurrency slot before downstream execution and
 * releases it after.  This is the outermost wrap around a direct-model
 * attempt chain — slots stay held across retries inside one
 * `concurrencyMiddleware()` invocation, matching the legacy semantics.
 *
 * Reads:
 *   - `ctx.target.model.modelKey` / `concurrencyLimit`
 *   - `ctx.appCtx.services.concurrencyController`
 *   - `ctx.appCtx.config.env.DEFAULT_MODEL_CONCURRENCY` /
 *     `DEFAULT_QUEUE_TIMEOUT_MS`
 *
 * Writes:
 *   - `ctx.metadata.queueWaitMs`
 *
 * If no controller is registered, this middleware is a no-op.  That keeps
 * test fixtures and dev runs simple — they can omit the controller and
 * still exercise the rest of the chain.
 *
 * @module runtime/execution/concurrency-middleware
 */

/**
 * @returns {(ctx: object, next: () => Promise<void>) => Promise<void>}
 */
export function concurrencyMiddleware() {
    return async function concurrency(ctx, next) {
        const controller = ctx.appCtx?.services?.concurrencyController || null;
        if (!controller) {
            await next();
            return;
        }

        const model = ctx.target?.model;
        if (!model) {
            throw new TypeError(
                'concurrencyMiddleware: ctx.target.model is required'
            );
        }

        const env = ctx.appCtx?.config?.env || {};
        const modelKey = model.modelKey || model.model_key;
        const max =
            model.concurrencyLimit ||
            model.concurrency_limit ||
            env.DEFAULT_MODEL_CONCURRENCY;
        const queueTimeoutMs =
            model.queueTimeoutMs ||
            model.queue_timeout_ms ||
            env.DEFAULT_QUEUE_TIMEOUT_MS;

        controller.configure(modelKey, max);

        const queueStartMs = Date.now();
        const release = await controller.acquire(modelKey, queueTimeoutMs);
        ctx.metadata.queueWaitMs = Date.now() - queueStartMs;

        try {
            await next();
        } finally {
            release();
        }
    };
}
