/**
 * Route middleware: resolve the requested model.
 *
 * Reads `ctx.request.model` and `ctx.snapshot`, runs the model name
 * normalizer, and looks up the unified model record from the snapshot.
 * Every addressable target is a model; cascade models are selected by
 * the same lookup path as direct models. The dispatcher branches on
 * `model.strategyKind` to choose between direct dispatch and cascade.
 *
 * Throws `ModelNotFoundError` if no matching model is found.
 *
 * @module runtime/route/resolve-model
 */

import { ModelNotFoundError } from '../../core/errors.mjs';
import { normalizeModelName } from '../registry/model-name-normalizer.mjs';
import { resolveModel } from '../registry/model-registry.mjs';

/**
 * @returns {(ctx: object, next: () => Promise<void>) => Promise<void>}
 */
export function resolveModelMiddleware() {
    return async function resolveModelMw(ctx, next) {
        const requestedModel = ctx.request?.model;

        if (!ctx.snapshot) {
            // Without a snapshot we cannot resolve models.  Surface a
            // placeholder so observability still has the requested name and
            // let the dispatcher's stub path handle the no-DB case.
            ctx.metadata.resolvedModel = {
                model: null,
                kind: 'unknown',
                requestedModel,
                resolvedVia: 'none',
            };
            await next();
            return;
        }

        const { normalized } = normalizeModelName(requestedModel, ctx.snapshot);
        const result = resolveModel(ctx.snapshot, normalized);
        if (!result) throw new ModelNotFoundError(requestedModel);

        const model = result.model;
        ctx.target = { ...(ctx.target || {}), model };

        // Expose a compact resolved-model summary for route egress and
        // observability without forcing every downstream layer to inspect
        // the full model record directly.
        ctx.metadata.resolvedModel = {
            model,
            kind: model.strategyKind === 'cascade' ? 'cascade' : 'model',
            strategyKind: model.strategyKind || 'direct',
            requestedModel,
            resolvedVia: result.resolvedVia,
        };

        await next();
    };
}
