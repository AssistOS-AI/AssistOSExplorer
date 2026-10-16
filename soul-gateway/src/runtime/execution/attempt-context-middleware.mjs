/**
 * Attempt context middleware.
 *
 * Initializes per-attempt state on the kernel context: a fresh
 * `ctx.attempt` counter view, a shallow-cloned request so provider
 * middleware can mutate without leaking back to the parent across
 * retries, and reset attempt-local response/metadata fields.
 *
 * The retry middleware forks the kernel context for each attempt and
 * binds this middleware first inside the per-attempt chain.
 *
 * Reads:
 *   - `ctx.request`
 *
 * Writes:
 *   - `ctx.request` — shallow-cloned with a fresh `messages` array
 *   - `ctx.response` — cleared to null at the start of every attempt
 *
 * @module runtime/execution/attempt-context-middleware
 */

/**
 * @returns {(ctx: object, next: () => Promise<void>) => Promise<void>}
 */
export function attemptContextMiddleware() {
    return async function attemptContext(ctx, next) {
        ctx.request = cloneRequest(ctx.request);
        ctx.response = null;
        await next();
    };
}

/**
 * Shallow-clone a normalized request so provider middleware can mutate
 * it without leaking changes back to the parent caller's view.
 */
function cloneRequest(request) {
    if (!request || typeof request !== 'object') return request;
    const next = { ...request };
    if (Array.isArray(request.messages)) {
        next.messages = [...request.messages];
    }
    return next;
}
