/**
 * Transport dispatch middleware.
 *
 * Terminal middleware in the per-attempt provider chain.  Resolves the
 * concrete transport plugin from `ctx.appCtx.services.transportCatalog`
 * using the provider record's `adapterKey`, wraps the plugin via
 * `adaptProviderPluginToTransport`, and invokes it.
 *
 * Transport selection is part of middleware execution rather than
 * pre-composition orchestration: each attempt resolves the transport
 * fresh, picking up snapshot swaps that happen between retries.
 *
 * Reads:
 *   - `ctx.target.model`
 *   - `ctx.target.provider.adapterKey`
 *   - `ctx.appCtx.services.transportCatalog`
 *
 * Writes:
 *   - `ctx.response` — set by the wrapped transport via `adaptProviderPluginToTransport`
 *   - `ctx.metadata.transportAccountId` — set by the transport adapter
 *
 * @module runtime/execution/transport-dispatch-middleware
 */

import { ConfigurationError } from '../../core/errors.mjs';
import { adaptProviderPluginToTransport } from '../kernel/index.mjs';

/**
 * @returns {(ctx: object) => Promise<void>}
 */
export function transportDispatchMiddleware() {
    return async function transportDispatch(ctx /* terminal — no next */) {
        const target = ctx.target || {};
        const model = target.model;
        const provider = target.provider;
        if (!model) {
            throw new TypeError(
                'transportDispatchMiddleware: ctx.target.model is required'
            );
        }

        if (!provider) {
            throw new ConfigurationError(
                'transportDispatchMiddleware: ctx.target.provider is required'
            );
        }

        const transportCatalog = ctx.appCtx?.services?.transportCatalog || null;
        if (!transportCatalog) {
            throw new ConfigurationError(
                'transportDispatchMiddleware: transportCatalog is required'
            );
        }

        const transportLookupKey = provider.adapterKey || provider.adapter_key;
        if (!transportLookupKey) {
            throw new ConfigurationError(
                'transportDispatchMiddleware: provider adapterKey is required'
            );
        }

        const providerPlugin =
            transportCatalog.getTransport?.(transportLookupKey) || null;
        if (!providerPlugin) {
            throw new ConfigurationError(
                `Transport not loaded: ${transportLookupKey}`
            );
        }

        const transport = adaptProviderPluginToTransport(providerPlugin, {
            transportKey:
                providerPlugin?.manifest?.key || transportLookupKey,
        });

        await transport(ctx);
    };
}
