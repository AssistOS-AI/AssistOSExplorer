/**
 * Transport middleware contract.
 *
 * A transport is the terminal middleware in a provider chain.  It is what
 * actually talks to the upstream service (an HTTP API, a local process, a
 * search index, …).  In the unified kernel everything is middleware, and a
 * transport is just a middleware that:
 *
 *   1. Reads the canonical request from `ctx.request`
 *   2. Reads the bound model and provider from `ctx.target`
 *   3. Sends the request to the upstream
 *   4. Sets `ctx.response` to a `CanonicalStream` (or a buffered shape)
 *   5. Does NOT call `next()` — it is the bottom of the chain
 *
 * Transports do not run policy.  Rate limiting, budget enforcement, prompt
 * injection, content blocking, response caching, and so on all live in
 * non-terminal middlewares.  This module provides:
 *
 *   - `adaptProviderPluginToTransport(plugin)` — wraps a provider-backed
 *     transport module's `execute()` method as terminal middleware.
 *
 * Transport errors thrown out of `execute()` are classified through the
 * plugin's `classifyError(error, providerCtx)` so the surrounding chain
 * sees a typed `GatewayError` instead of a raw transport exception.
 *
 * @module runtime/kernel/transport
 */

import {
    createCanonicalStream,
    isCanonicalStream,
} from './canonical-stream.mjs';

/**
 * Adapt a provider-backed transport module into a kernel terminal middleware.
 *
 * The returned middleware reads everything it needs from `ctx`:
 *
 *   - `ctx.request`            — canonical request (mutated by upstream
 *                                middlewares before reaching us)
 *   - `ctx.target.model`       — resolved model record
 *   - `ctx.target.provider`    — normalized provider record
 *   - `ctx.target.credentialLease` — credentials leased for this attempt
 *   - `ctx.attempt`            — { index, previousErrors }
 *   - `ctx.signal`             — abort signal honored by the plugin
 *   - `ctx.services.extensionServices` — frozen services bag
 *   - `ctx.log`                — logger
 *
 * After the plugin's `execute()` returns, the transport stores either a
 * `CanonicalStream` (if the plugin produced an async iterable) or the raw
 * envelope on `ctx.response`.  The plugin's `accountId` is exposed via
 * `ctx.metadata.transportAccountId` so observability middlewares can read it.
 *
 * Errors are classified inside the transport and re-thrown as the typed
 * gateway error returned by `classifyError`.
 *
 * @param {object} plugin - a ProviderPlugin (manifest + execute + classifyError)
 * @param {object} [options]
 * @param {string} [options.transportKey] - identifier surfaced in logs/metadata
 * @returns {(ctx: object, next: () => Promise<void>) => Promise<void>}
 */
export function adaptProviderPluginToTransport(plugin, options = {}) {
    if (!plugin || typeof plugin !== 'object') {
        throw new TypeError(
            'adaptProviderPluginToTransport: plugin is required'
        );
    }
    if (typeof plugin.execute !== 'function') {
        throw new TypeError(
            'adaptProviderPluginToTransport: plugin.execute is required'
        );
    }

    const transportKey =
        options.transportKey || plugin.manifest?.key || 'unknown-transport';

    return async function transportTerminal(ctx /* no next: terminal */) {
        const target = ctx.target || {};
        if (!target.model) {
            throw new TypeError(
                `transport ${transportKey}: ctx.target.model is required`
            );
        }

        // Build the provider execution context consumed by built-in
        // provider-backed transport modules.
        const providerCtx = Object.freeze({
            requestId: ctx.requestId,
            request: ctx.request,
            resolvedModel: target.model,
            providerRecord: target.provider || null,
            credentialLease: target.credentialLease || null,
            attempt: ctx.attempt || { index: 0, previousErrors: [] },
            signal: ctx.signal,
            logger: ctx.log,
            services: ctx.services || Object.freeze({}),
        });

        let handle;
        try {
            handle = await plugin.execute(providerCtx);
        } catch (err) {
            throw classifyTransportError(plugin, err, providerCtx);
        }

        // Surface accountId via metadata so observability hooks can record it.
        if (handle?.accountId !== undefined) {
            ctx.metadata.transportAccountId = handle.accountId;
        }

        // The plugin returns a `handle` with `stream` (an async iterable of
        // canonical events).  Wrap as a CanonicalStream so downstream
        // middleware (buffering, stream-wrapping) can detect it.
        const rawStream = handle?.stream;
        if (
            rawStream &&
            typeof rawStream[Symbol.asyncIterator] === 'function'
        ) {
            ctx.response = isCanonicalStream(rawStream)
                ? rawStream
                : createCanonicalStream(rawStream, {
                      model:
                          target.model.modelKey || null,
                      transport: transportKey,
                  });
            return;
        }

        // No stream — surface whatever the plugin returned (some plugins might
        // produce a buffered shape directly).  Downstream middleware that
        // expects a stream will see this and decide how to handle it.
        ctx.response = handle;
    };
}

/**
 * Classify an error using the plugin's `classifyError` method, falling
 * back to the original error if the plugin lacks one or the classifier
 * itself throws.
 */
function classifyTransportError(plugin, error, providerCtx) {
    if (typeof plugin.classifyError !== 'function') return error;
    try {
        return plugin.classifyError(error, providerCtx);
    } catch {
        return error;
    }
}
