/**
 * Route middleware: gateway dispatch terminal.
 *
 * Composes the gateway-scope middleware chain over the model execution
 * middleware.  This is the bridge between the route layer and the
 * gateway/model execution layers — both run on the same kernel
 * composer over the same `ctx`.
 *
 * Reads from `ctx`:
 *   - `ctx.request`, `ctx.snapshot`, `ctx.services`
 *   - `ctx.target.model` (set by `resolveModel` route middleware)
 *
 * Writes to `ctx.response`:
 *   - a chat-completion envelope (buffered mode)
 *   - a `CanonicalStream` (streaming mode)
 *
 * @module runtime/route/gateway-dispatch
 */

import { compose } from '../kernel/index.mjs';
import { modelExecutionMiddleware } from '../execution/model-execution.mjs';

/**
 * @returns {(ctx: object) => Promise<void>}
 */
export function gatewayDispatchMiddleware() {
    return async function gatewayDispatch(ctx /* terminal — no next */) {
        const appCtx = ctx.appCtx;
        const catalog = appCtx?.services?.middlewareCatalog;
        const snapshot = ctx.snapshot;
        const resolvedModel = ctx.metadata.resolvedModel;
        if (!resolvedModel) {
            throw new Error(
                'gateway-dispatch: ctx.metadata.resolvedModel is missing'
            );
        }

        // 1. Resolve the gateway middleware chain (may be empty).  Gateway-
        //    scope bindings run for every request, and model-scope bindings
        //    apply to the resolved model (direct or cascade).
        let gatewayKernelMiddlewares = [];
        if (catalog && snapshot) {
            const modelId = resolvedModel.model?.id || null;
            gatewayKernelMiddlewares = catalog.resolveGatewayChain({
                modelId,
                snapshot,
            });
        }

        // 2. Bind the resolved model and per-request execution flags onto
        //    ctx so the model execution chain can read them directly.
        ctx.target = { ...(ctx.target || {}), model: resolvedModel.model };
        ctx.metadata.wantStream = ctx.request?.stream === true;
        ctx.metadata.onCooldown = (modelKey, error) => {
            appCtx?.log?.info?.('model cooldown triggered', {
                modelKey,
                errorType: error.errorType,
            });
        };

        // 3. Compose the gateway middleware chain over the model execution
        //    terminal and run it.  Time the whole dispatch so observability
        //    sees a single end-to-end measurement (legacy `dispatchMs`).
        const dispatchStart = Date.now();
        const chain = compose([
            ...gatewayKernelMiddlewares,
            modelExecutionMiddleware(),
        ]);
        await chain(ctx);
        ctx.metadata.dispatchMs = Date.now() - dispatchStart;
    };
}
