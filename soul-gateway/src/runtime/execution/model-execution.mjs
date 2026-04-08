/**
 * Model execution middleware.
 *
 * Top-level model dispatch boundary used by `gatewayDispatchMiddleware`.
 * Reads `ctx.target.model` (set by `resolveModel` route middleware) and
 * branches on `model.strategyKind`:
 *
 *   - `direct` — composes and runs the direct-model attempt chain
 *     (target binding → concurrency → retry-with-attempt-subchain →
 *     finalize result).
 *
 *   - `cascade` — composes and runs the cascade chain
 *     (invoke-model capability → cascade middleware which loops over
 *     child models via `ctx.invokeModel`).
 *
 * Both branches write `ctx.response` directly.  No helper return
 * envelope crosses this boundary; callers (the gateway dispatch
 * terminal) consume `ctx.response` and `ctx.metadata` only.
 *
 * @module runtime/execution/model-execution
 */

import { compose } from '../kernel/index.mjs';
import { InternalServerError } from '../../core/errors.mjs';
import { compileProviderBindingsChain } from '../middleware/compile-provider-bindings.mjs';
import { bindDirectTargetMiddleware } from './bind-direct-target-middleware.mjs';
import { concurrencyMiddleware } from './concurrency-middleware.mjs';
import { retryMiddleware } from './retry-middleware.mjs';
import { attemptContextMiddleware } from './attempt-context-middleware.mjs';
import { timeoutMiddleware } from './timeout-middleware.mjs';
import { credentialLeaseMiddleware } from './credential-lease-middleware.mjs';
import { transportDispatchMiddleware } from './transport-dispatch-middleware.mjs';
import { finalizeDirectResultMiddleware } from './finalize-direct-result-middleware.mjs';
import { invokeModelCapabilityMiddleware } from './invoke-model-capability-middleware.mjs';
import { cascadeMiddleware } from './cascade-middleware.mjs';
import { bufferingMiddleware } from '../kernel/index.mjs';

/**
 * Top-level model execution middleware.  Branches on model strategy
 * and runs the appropriate sub-chain.
 *
 * @returns {(ctx: object, next: () => Promise<void>) => Promise<void>}
 */
export function modelExecutionMiddleware() {
    return async function modelExecution(ctx /* terminal — no next */) {
        const model = ctx.target?.model;
        if (!model) {
            throw new InternalServerError(
                'modelExecutionMiddleware: ctx.target.model is required'
            );
        }
        const strategyKind =
            model.strategyKind || model.strategy_kind || 'direct';

        if (strategyKind === 'direct') {
            const chain = compose(composeDirectModelChain());
            await chain(ctx);
            return;
        }

        if (strategyKind === 'cascade') {
            const chain = compose(composeCascadeModelChain());
            await chain(ctx);
            return;
        }

        throw new InternalServerError(
            `modelExecutionMiddleware: unknown model strategy '${strategyKind}'`
        );
    };
}

/**
 * Build the ordered list of middlewares that runs a direct-model
 * attempt.  The retry middleware wraps an attempt subchain that
 * resolves provider middleware bindings at run time per attempt, so
 * provider middleware bound after the chain is composed will appear
 * on subsequent retries as well.
 *
 * @returns {Array<Function>}
 */
export function composeDirectModelChain() {
    return [
        bindDirectTargetMiddleware(),
        concurrencyMiddleware(),
        retryMiddleware({
            attemptChain: [
                attemptContextMiddleware(),
                timeoutMiddleware(),
                credentialLeaseMiddleware(),
                providerBindingsMiddleware(),
            ],
        }),
        finalizeDirectResultMiddleware(),
    ];
}

/**
 * Build the ordered list of middlewares that runs a cascade model.
 * Cascade chains do not need a target/credential/transport sub-chain
 * here because each child attempt is dispatched through
 * `ctx.invokeModel`, which composes a fresh direct chain for the
 * child model.  `finalizeDirectResultMiddleware` is bound first so
 * the buffered shape produced by the leaf attempt is converted into
 * a chat-completion envelope after the cascade unwinds.
 *
 * @returns {Array<Function>}
 */
export function composeCascadeModelChain() {
    return [
        finalizeDirectResultMiddleware(),
        invokeModelCapabilityMiddleware(),
        cascadeAdapterMiddleware(),
    ];
}

/**
 * Inner middleware that, per attempt, looks up the provider middleware
 * chain and the transport, then runs them as a kernel sub-chain.  This
 * sits inside the retry middleware's attempt chain so a new lookup
 * happens for every attempt — provider middleware bindings reload at
 * snapshot refresh time and a long-lived retry should pick up the
 * latest snapshot if the runtime swaps it under us.
 *
 * Buffering is conditional on `ctx.metadata.wantStream`.  When the
 * caller wants a streamed canonical response, the chain skips the
 * outer buffering middleware so `ctx.response` stays as a
 * `CanonicalStream`.
 *
 * @returns {(ctx: object) => Promise<void>}
 */
function providerBindingsMiddleware() {
    return async function providerBindings(ctx /* terminal */) {
        const providerId =
            ctx.target?.model?.providerId || ctx.target?.model?.provider_id;
        const registry = ctx.appCtx?.services?.providerMiddlewareRegistry || null;
        const providerMiddlewares = compileProviderBindingsChain({
            providerId,
            snapshot: ctx.snapshot,
            registry,
        });

        const wantStream = ctx.metadata?.wantStream === true;
        const responseExcerptChars =
            ctx.appCtx?.config?.defaults?.responseExcerptChars;
        const chainEntries = wantStream
            ? [...providerMiddlewares, transportDispatchMiddleware()]
            : [
                  bufferingMiddleware({
                      maxExcerptChars: responseExcerptChars,
                  }),
                  ...providerMiddlewares,
                  transportDispatchMiddleware(),
              ];

        const chain = compose(chainEntries);
        await chain(ctx);
    };
}

/**
 * Adapter that wires `cascadeMiddleware` into the model-execution
 * chain.  Reads the cascade model's children list, builds the
 * candidate resolver, and runs the cascade middleware as the terminal
 * of the cascade sub-chain.
 *
 * @returns {(ctx: object) => Promise<void>}
 */
function cascadeAdapterMiddleware() {
    return async function cascadeAdapter(ctx /* terminal */) {
        const model = ctx.target?.model;
        if (!model) {
            throw new InternalServerError(
                'cascadeAdapter: ctx.target.model is required'
            );
        }
        const env = ctx.appCtx?.config?.env || {};
        const maxAttempts =
            model.maxAttempts ||
            model.max_attempts ||
            env.DEFAULT_MODEL_ATTEMPTS ||
            (model.children?.length ?? 5);
        const onCooldown = ctx.metadata?.onCooldown || null;

        const cascade = cascadeMiddleware({
            model,
            resolveCandidates: (excludeModels) => {
                return (model.children || [])
                    .filter((child) => !excludeModels.has(child.modelKey))
                    .filter(
                        (child) => !ctx.snapshot?.cooldowns?.has?.(child.modelKey)
                    )
                    .map((child) => {
                        const childModel = ctx.snapshot?.models?.get?.(
                            child.modelKey
                        );
                        return childModel && childModel.enabled !== false
                            ? { model: childModel }
                            : null;
                    })
                    .filter(Boolean);
            },
            maxAttempts,
            onCooldown,
        });

        await cascade(ctx);
    };
}
