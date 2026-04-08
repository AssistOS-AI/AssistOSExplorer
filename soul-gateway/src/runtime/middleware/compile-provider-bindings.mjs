/**
 * Compile provider-scope bindings into a kernel middleware chain.
 *
 * Reads from `snapshot.middlewareBindings.byProvider.get(providerId)`
 * (populated by the snapshot loader from the unified
 * `middleware_bindings` table) and turns each binding into a kernel
 * `(ctx, next)` middleware by asking `providerMiddlewareRegistry` for
 * the module's factory.
 *
 * Bindings whose `middleware_key` is not registered are silently
 * skipped so a bad assignment does not take down the whole request.
 *
 * @module runtime/middleware/compile-provider-bindings
 */

import { mergeMiddlewareSettings } from './settings-merge.mjs';

/**
 * @param {object} args
 * @param {string|null} args.providerId
 * @param {object} args.snapshot   - runtime snapshot
 * @param {object} args.registry   - ProviderMiddlewareRegistry instance
 * @returns {Array<Function>} ordered kernel middlewares
 */
export function compileProviderBindingsChain({
    providerId,
    snapshot,
    registry,
}) {
    if (!providerId || !snapshot || !registry) return [];

    const bindings =
        snapshot.middlewareBindings?.byProvider?.get?.(providerId) || [];
    if (bindings.length === 0) return [];

    const chain = [];
    for (const binding of bindings) {
        const settings = mergeMiddlewareSettings(
            binding.middlewareDefaultSettings,
            binding.settings
        );
        const middleware = registry.build(binding.middlewareKey, settings);
        if (!middleware) continue;
        chain.push(middleware);
    }
    return chain;
}
