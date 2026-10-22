/**
 * Route middleware: bind the runtime snapshot for this request.
 *
 * Captures `appCtx.services.snapshot` once at request entry and pins it on
 * `ctx.snapshot` so the rest of the chain sees a consistent view even if
 * a hot reload swaps the snapshot mid-flight.
 *
 * @module runtime/route/bind-snapshot
 */

/**
 * @returns {(ctx: object, next: () => Promise<void>) => Promise<void>}
 */
export function bindSnapshotMiddleware() {
    return async function bindSnapshot(ctx, next) {
        ctx.snapshot = ctx.appCtx?.services?.snapshot || null;
        await next();
    };
}
