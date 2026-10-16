/**
 * Bind direct target middleware.
 *
 * For a direct-model attempt, looks up the provider record from the
 * runtime snapshot using `ctx.target.model.providerKey`, normalizes
 * both records, and stores the normalized pair on `ctx.target`.
 *
 * Reads:
 *   - `ctx.target.model`
 *   - `ctx.snapshot.providers`
 *
 * Writes:
 *   - `ctx.target.model` (normalized)
 *   - `ctx.target.provider` (normalized)
 *
 * @module runtime/execution/bind-direct-target-middleware
 */

import {
    normalizeModelRecord,
    normalizeProviderRecord,
} from '../providers/runtime-record-normalizer.mjs';

/**
 * @returns {(ctx: object, next: () => Promise<void>) => Promise<void>}
 */
export function bindDirectTargetMiddleware() {
    return async function bindDirectTarget(ctx, next) {
        const rawModel = ctx.target?.model;
        if (!rawModel) {
            throw new TypeError(
                'bindDirectTargetMiddleware: ctx.target.model is required'
            );
        }
        const model = normalizeModelRecord(rawModel);
        const providerKey = model.providerKey || model.provider_key;
        const providerRow = ctx.snapshot?.providers?.get?.(providerKey) || null;
        const provider = normalizeProviderRecord(providerRow);

        ctx.target = {
            ...ctx.target,
            model,
            provider,
        };

        await next();
    };
}
