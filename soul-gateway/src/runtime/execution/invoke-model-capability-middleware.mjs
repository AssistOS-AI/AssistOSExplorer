/**
 * Invoke-model capability middleware.
 *
 * Installs `ctx.invokeModel` so any downstream middleware (most
 * notably `cascadeMiddleware`) can dispatch a child model attempt
 * against the same kernel.  Each invocation runs the model-execution
 * middleware in a forked context so the child has its own
 * `ctx.target`, `ctx.attempt`, and `ctx.response` while sharing the
 * snapshot, services, and request payload.
 *
 * Reads:
 *   - `ctx.snapshot.models`
 *   - `ctx.appCtx`
 *
 * Writes:
 *   - `ctx.invokeModel`
 *
 * @module runtime/execution/invoke-model-capability-middleware
 */

import { compose, forkKernelContext } from '../kernel/index.mjs';
import { ConfigurationError } from '../../core/errors.mjs';
import {
    composeDirectModelChain,
    composeCascadeModelChain,
} from './model-execution.mjs';

/**
 * @returns {(ctx: object, next: () => Promise<void>) => Promise<void>}
 */
export function invokeModelCapabilityMiddleware() {
    return async function invokeModelCapability(ctx, next) {
        ctx.invokeModel = async (modelOrKey, options = {}) => {
            const snapshot = options.snapshot || ctx.snapshot;
            if (!snapshot) {
                throw new ConfigurationError(
                    'invokeModel: no snapshot pinned on ctx'
                );
            }

            const model =
                typeof modelOrKey === 'string'
                    ? snapshot.models.get(modelOrKey)
                    : modelOrKey;
            if (!model) {
                throw new ConfigurationError(
                    `invokeModel: model not found: ${modelOrKey}`
                );
            }

            const wantStream =
                options.wantStream ?? ctx.metadata?.wantStream ?? false;
            const strategyKind =
                model.strategyKind || model.strategy_kind || 'direct';

            // Build a child ctx scoped to one model dispatch.  We share
            // request/snapshot/services with the parent but reset target
            // and response so the child does not contaminate the parent's
            // direct or cascade state.
            const childCtx = forkKernelContext(ctx, {
                request: ctx.request,
                target: { model },
            });
            childCtx.services = ctx.services;
            childCtx.metadata.wantStream = wantStream;
            if (options.onCooldown !== undefined) {
                childCtx.metadata.onCooldown = options.onCooldown;
            } else if (ctx.metadata?.onCooldown) {
                childCtx.metadata.onCooldown = ctx.metadata.onCooldown;
            }
            // Make the capability available recursively for nested cascades.
            childCtx.invokeModel = ctx.invokeModel;

            const chain =
                strategyKind === 'cascade'
                    ? compose(composeCascadeModelChain())
                    : compose(composeDirectModelChain());
            await chain(childCtx);
            return childCtx;
        };

        await next();
    };
}
