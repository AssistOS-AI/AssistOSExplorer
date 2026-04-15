/**
 * Compile provider-scope bindings into a kernel middleware chain.
 *
 * Reads from `snapshot.middlewareBindings.byProvider.get(providerId)`
 * (populated by the snapshot loader from the unified
 * `middleware_bindings` table) and turns each binding into a kernel
 * `(ctx, next)` middleware by asking `providerMiddlewareRegistry` for
 * the module's factory.
 *
 * @module runtime/middleware/compile-provider-bindings
 */

import { ConfigurationError } from '../../core/errors.mjs';
import { mergeMiddlewareSettings } from './settings-merge.mjs';
import { requireProviderMiddlewareModule } from '../providers/provider-composition-validator.mjs';

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
    if (!providerId) {
        throw new ConfigurationError(
            'compileProviderBindingsChain: providerId is required'
        );
    }
    if (!snapshot) {
        throw new ConfigurationError(
            'compileProviderBindingsChain: snapshot is required'
        );
    }
    if (!registry) {
        throw new ConfigurationError(
            'compileProviderBindingsChain: providerMiddlewareRegistry is required'
        );
    }

    const bindings =
        snapshot.middlewareBindings?.byProvider?.get?.(providerId) || [];
    if (bindings.length === 0) return [];

    const chain = [];
    for (const binding of bindings) {
        requireProviderMiddlewareModule(binding.middlewareKey, registry);
        const settings = mergeMiddlewareSettings(
            binding.middlewareDefaultSettings,
            binding.settings
        );
        const middleware = registry.build(binding.middlewareKey, settings);
        chain.push(middleware);
    }
    return chain;
}
