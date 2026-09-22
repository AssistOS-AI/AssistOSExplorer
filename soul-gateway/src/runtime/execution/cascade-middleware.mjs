/**
 * Cascade middleware.
 *
 * A cascade is a model strategy that tries a list of child models in
 * priority order until one succeeds. In the kernel model, this is just
 * a middleware that loops over candidates and calls
 * `ctx.invokeModel(model)` for each attempt, applying these rules:
 *
 *   - Quota / rate-limit errors with `cooldown=true`: model enters
 *     cooldown via `ctx.invokeModelOptions.onCooldown(modelKey, err)`.
 *   - Errors with `cascade=true`: try the next candidate.
 *   - Errors with `cascade=false`: fail without cascading.
 *   - Unclassified errors: fail without cascading.
 *   - Errors with `failureScope='provider-account'` (bad key, exhausted
 *     account quota): the remaining children on that same provider are
 *     skipped for this request, because they share the failed account.
 *   - An aborted `ctx.signal` (client disconnect or cascade budget) stops
 *     the loop before the next child is tried.
 *
 * The cascade re-resolves its candidate list against the snapshot on
 * each iteration so newly cooled-down models are excluded.
 *
 * `ctx.invokeModel` must be installed by an upstream middleware before
 * this middleware runs. In the standard model-execution chain, that
 * is `invokeModelCapabilityMiddleware()` in
 * `runtime/execution/invoke-model-capability-middleware.mjs`. The
 * capability returns the finished child kernel ctx so cascade can read
 * the child `response` and `metadata` directly.
 *
 * @module runtime/execution/cascade-middleware
 */

import {
    GatewayError,
    TierExhaustedError,
    InternalServerError,
} from '../../core/errors.mjs';

/**
 * Stable identity of the provider account a model runs on.
 *
 * @param {object} model
 * @returns {string|null}
 */
export function providerRefOf(model) {
    return (
        model?.providerId ||
        model?.provider_id ||
        model?.providerKey ||
        model?.provider_key ||
        null
    );
}

function abortReason(signal, lastError, modelKey) {
    const reason = signal?.reason;
    if (reason instanceof GatewayError) return reason;
    if (lastError instanceof GatewayError && !lastError.cascade) return lastError;
    return new TierExhaustedError(modelKey);
}

/**
 * Build a cascade middleware for a tier resolution.
 *
 * @param {object} options
 * @param {object} options.model              - cascade model record
 * @param {function} options.resolveCandidates - (excludeModels) => Array<{ model }>
 * @param {number} options.maxAttempts        - cap on iterations
 * @param {function} [options.onCooldown]     - (modelKey, err) => void
 * @returns {(ctx: object, next: () => Promise<void>) => Promise<void>}
 */
export function cascadeMiddleware(options) {
    if (!options?.model) {
        throw new TypeError('cascadeMiddleware: options.model is required');
    }
    if (typeof options.resolveCandidates !== 'function') {
        throw new TypeError(
            'cascadeMiddleware: options.resolveCandidates is required'
        );
    }

    const { model, resolveCandidates, maxAttempts = 5, onCooldown } = options;
    const modelKey = model.modelKey;

    return async function cascade(ctx /* terminal — no next */) {
        if (typeof ctx.invokeModel !== 'function') {
            throw new InternalServerError(
                'cascade middleware: ctx.invokeModel is not installed'
            );
        }

        const failedModels = new Set();
        const failedProviders = new Set();
        const trace = [];
        let lastError = null;

        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
            if (ctx.signal?.aborted) {
                throw abortReason(ctx.signal, lastError, modelKey);
            }
            const candidates = resolveCandidates(failedModels, {
                excludeProviders: failedProviders,
            });
            if (!candidates || candidates.length === 0) {
                // When the walk ended because a provider account failed
                // (bad key, exhausted shared quota), report that cause
                // instead of a generic exhausted tier.
                if (lastError?.failureScope === 'provider-account') {
                    throw lastError;
                }
                throw new TierExhaustedError(modelKey);
            }

            // Pick the highest-priority candidate not already failed
            const { model } = candidates[0];
            ctx.log?.info?.('cascade attempt', {
                cascadeModel: options.model.modelKey,
                model: model.modelKey,
                attempt,
            });

            try {
                const childCtx = await ctx.invokeModel(model);
                const childMetadata = childCtx?.metadata || {};

                ctx.metadata.cascadeTrace = trace;
                ctx.metadata.cascadeAttempt = attempt;
                ctx.metadata.cascadeModel =
                    childMetadata.cascadeModel || childCtx?.target?.model || model;
                ctx.metadata.cascadeAccountId =
                    childMetadata.cascadeAccountId ??
                    childMetadata.backendAccountId ??
                    null;
                ctx.metadata.cascadeRetryTrace =
                    childMetadata.cascadeRetryTrace ||
                    childMetadata.retryTrace ||
                    [];
                ctx.metadata.cascadeQueueWaitMs =
                    childMetadata.cascadeQueueWaitMs ||
                    childMetadata.queueWaitMs ||
                    0;
                ctx.response = childCtx?.response ?? null;
                return;
            } catch (err) {
                const failedModelKey = model.modelKey || modelKey;

                failedModels.add(failedModelKey);
                trace.push({
                    attempt,
                    model: failedModelKey,
                    error_type: err.errorType || 'unknown',
                    cascade: !!err.cascade,
                    cooldown: !!err.cooldown,
                    timestamp: new Date().toISOString(),
                });

                lastError = err;
                if (err.cooldown && typeof onCooldown === 'function') {
                    onCooldown(failedModelKey, err);
                }
                if (err.failureScope === 'provider-account') {
                    const providerRef = providerRefOf(model);
                    if (providerRef) failedProviders.add(providerRef);
                }

                // Only cascade if the error is classified and allows it
                if (!err.cascade) {
                    throw err;
                }
                // else: continue to the next candidate
            }
        }

        throw new TierExhaustedError(modelKey);
    };
}
