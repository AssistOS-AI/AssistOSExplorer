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
import { requestRuntimeRefresh } from '../registry/runtime-refresh.mjs';
import * as cooldownsDao from '../../db/dao/cooldowns-dao.mjs';

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
            persistCooldown(appCtx, ctx, modelKey, error);
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

/**
 * Persist a cascade-child cooldown to the database and trigger an
 * async snapshot refresh so subsequent requests see the new cooldown
 * in `snapshot.cooldowns`.
 *
 * Fire-and-forget: cascade flow must not wait for the DB write.  Any
 * failure is logged at warn level — the in-flight request has already
 * moved on to the next child by the time this runs.
 *
 * Cooldown duration precedence:
 *   1. `error.cooldownMs` if the backend error attaches one
 *   2. `model.retryPolicy.cooldownMs` per-model override
 *   3. `appCtx.config.env.COOLDOWN_DURATION_MS` global default
 */
export function persistCooldown(appCtx, ctx, modelKey, error) {
    const pool = appCtx?.pool;
    if (!pool) return;

    const model = ctx.snapshot?.models?.get?.(modelKey);
    if (!model?.id) {
        appCtx?.log?.warn?.('cooldown write skipped: model not in snapshot', {
            modelKey,
        });
        return;
    }

    const cooldownMs =
        (Number.isFinite(error?.cooldownMs) && error.cooldownMs) ||
        (Number.isFinite(model.retryPolicy?.cooldownMs) &&
            model.retryPolicy.cooldownMs) ||
        appCtx?.config?.env?.COOLDOWN_DURATION_MS ||
        3_600_000;

    const expiresAt = new Date(Date.now() + cooldownMs);
    const reasonType = error?.errorType || 'unknown';
    const reasonMessage = error?.message || null;

    cooldownsDao
        .create(pool, {
            modelId: model.id,
            sourceAccountId: ctx.metadata?.sourceAccountId || null,
            requestId: ctx.requestId || null,
            reasonType,
            reasonMessage,
            expiresAt,
            metadata: { cooldownMs, modelKey },
        })
        .then(() =>
            requestRuntimeRefresh(appCtx, {
                snapshot: true,
                reason: `cooldown.${modelKey}`,
            })
        )
        .catch((err) => {
            appCtx?.log?.warn?.('cooldown write failed', {
                modelKey,
                error: err.message,
            });
        });
}
