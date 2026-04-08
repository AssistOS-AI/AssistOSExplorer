/**
 * Backend terminal middleware factory.
 *
 * The single helper that turns a `BackendModule` into a kernel terminal
 * middleware.  The catalog calls this once at registration time and
 * stores the resulting terminal next to the module.  At dispatch time
 * the runtime just looks the terminal up — there is no per-request
 * adapter step.
 *
 * The returned terminal:
 *
 *   - reads `ctx.request`, `ctx.target.{model,provider,credentialLease}`,
 *     `ctx.attempt`, `ctx.signal`, `ctx.services`, `ctx.log`
 *   - calls `module.execute(executionCtx)` with a frozen
 *     `BackendExecutionContext`
 *   - wraps the returned async iterable as a `CanonicalStream`
 *   - records the upstream `accountId` on `ctx.metadata.backendAccountId`
 *   - classifies thrown errors via `module.classifyError`
 *   - does NOT call `next()` — it is the bottom of the chain
 *
 * @module runtime/backends/backend-terminal
 */

import {
    createCanonicalStream,
    isCanonicalStream,
} from '../kernel/canonical-stream.mjs';
import { createBackendExecutionContext } from './backend-context.mjs';

/**
 * Wrap a backend module's `execute()` method as a kernel terminal
 * middleware.  Performs the wrap once at catalog-registration time.
 *
 * @param {object} backendModule  A loaded BackendModule
 * @returns {(ctx: object) => Promise<void>}
 */
export function createBackendTerminal(backendModule) {
    if (!backendModule || typeof backendModule !== 'object') {
        throw new TypeError(
            'createBackendTerminal: backendModule is required'
        );
    }
    if (typeof backendModule.execute !== 'function') {
        throw new TypeError(
            'createBackendTerminal: backendModule.execute is required'
        );
    }

    const backendKey = backendModule.manifest?.key || 'unknown-backend';

    return async function backendTerminal(ctx /* terminal — no next */) {
        const target = ctx.target || {};
        if (!target.model) {
            throw new TypeError(
                `backend ${backendKey}: ctx.target.model is required`
            );
        }

        const executionCtx = createBackendExecutionContext({
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
            handle = await backendModule.execute(executionCtx);
        } catch (err) {
            throw classifyBackendError(backendModule, err, executionCtx);
        }

        if (handle?.accountId !== undefined) {
            ctx.metadata.backendAccountId = handle.accountId;
        }

        const rawStream = handle?.stream;
        if (
            rawStream &&
            typeof rawStream[Symbol.asyncIterator] === 'function'
        ) {
            ctx.response = isCanonicalStream(rawStream)
                ? rawStream
                : createCanonicalStream(rawStream, {
                      model: target.model.modelKey || null,
                      backend: backendKey,
                  });
            return;
        }

        // No stream — surface whatever the backend returned (some
        // backends might produce a buffered shape directly).  Downstream
        // middleware that expects a stream will see this and decide how
        // to handle it.
        ctx.response = handle;
    };
}

function classifyBackendError(backendModule, error, executionCtx) {
    if (typeof backendModule.classifyError !== 'function') return error;
    try {
        return backendModule.classifyError(error, executionCtx);
    } catch {
        return error;
    }
}
