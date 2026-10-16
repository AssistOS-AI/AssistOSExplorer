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
import {
    createCanonicalStream,
    isCanonicalStream,
} from '../kernel/index.mjs';

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

        const generation =
            typeof backendCatalog.acquireGeneration === 'function'
                ? backendCatalog.acquireGeneration()
                : null;
        let released = false;
        const releaseGeneration = () => {
            if (released || generation == null) return;
            released = true;
            backendCatalog.releaseGeneration(generation);
        };

        const terminal =
            generation != null &&
            typeof backendCatalog.getTerminalForGeneration === 'function'
                ? backendCatalog.getTerminalForGeneration(backendKey, generation)
                : backendCatalog.getTerminal(backendKey);
        if (!terminal) {
            releaseGeneration();
            throw new ConfigurationError(
                `Backend not loaded: ${backendKey}`
            );
        }

        try {
            await terminal(ctx);
            ctx.response = wrapResponseWithGenerationLease(
                ctx.response,
                releaseGeneration
            );
        } catch (err) {
            releaseGeneration();
            throw err;
        }
    };
}

function wrapResponseWithGenerationLease(response, releaseGeneration) {
    if (!response) {
        releaseGeneration();
        return response;
    }

    if (isCanonicalStream(response)) {
        return createCanonicalStream(
            releaseAfterStream(response, releaseGeneration),
            response.meta || {}
        );
    }

    if (response.stream && isCanonicalStream(response.stream)) {
        return {
            ...response,
            stream: createCanonicalStream(
                releaseAfterStream(response.stream, releaseGeneration),
                response.stream.meta || {}
            ),
        };
    }

    releaseGeneration();
    return response;
}

async function* releaseAfterStream(stream, releaseGeneration) {
    try {
        for await (const event of stream) {
            yield event;
        }
    } finally {
        releaseGeneration();
    }
}
