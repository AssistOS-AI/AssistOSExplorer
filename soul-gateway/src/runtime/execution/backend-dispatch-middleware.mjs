/**
 * Backend dispatch middleware.
 *
 * Terminal middleware in the per-attempt provider chain.  Resolves the
 * precompiled terminal middleware for the bound provider's backend
 * from `ctx.appCtx.services.backendCatalog`, and runs it.
 *
 * Backend lookup is part of middleware execution rather than
 * pre-composition orchestration: each attempt resolves the terminal
 * fresh from the catalog, picking up snapshot swaps that happen
 * between retries.
 *
 * Reads:
 *   - `ctx.target.model`
 *   - `ctx.target.provider.backendKey`
 *   - `ctx.appCtx.services.backendCatalog`
 *
 * Writes:
 *   - `ctx.response`                    — set by the backend terminal
 *   - `ctx.metadata.backendAccountId`   — set by the backend terminal
 *
 * @module runtime/execution/backend-dispatch-middleware
 */

import { ConfigurationError } from '../../core/errors.mjs';

/**
 * @returns {(ctx: object) => Promise<void>}
 */
export function backendDispatchMiddleware() {
    return async function backendDispatch(ctx /* terminal — no next */) {
        const target = ctx.target || {};
        const model = target.model;
        const provider = target.provider;
        if (!model) {
            throw new TypeError(
                'backendDispatchMiddleware: ctx.target.model is required'
            );
        }
        if (!provider) {
            throw new ConfigurationError(
                'backendDispatchMiddleware: ctx.target.provider is required'
            );
        }

        const backendCatalog = ctx.appCtx?.services?.backendCatalog || null;
        if (!backendCatalog) {
            throw new ConfigurationError(
                'backendDispatchMiddleware: backendCatalog is required'
            );
        }

        const backendKey = provider.backendKey;
        if (!backendKey) {
            throw new ConfigurationError(
                'backendDispatchMiddleware: provider backendKey is required'
            );
        }

        const terminal = backendCatalog.getTerminal(backendKey);
        if (!terminal) {
            throw new ConfigurationError(
                `Backend not loaded: ${backendKey}`
            );
        }

        await terminal(ctx);
    };
}
