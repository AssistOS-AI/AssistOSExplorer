/**
 * Route runtime entry point.
 *
 * Composes the canonical route chain for an LLM request and exposes a
 * single function — `runRouteRequest` — that the public API route
 * registration module calls per incoming request.  This module replaces the old hand-rolled
 * stage machine in `src/request/pipeline.mjs`; the same stages now run
 * as kernel middlewares composed by `compose([...])`.
 *
 * Chain order (around-style):
 *
 *   errorBoundary
 *     parseBody
 *     authenticate
 *     identity
 *     bindSnapshot
 *     normalizeIngress
 *     auditLog
 *     validateRequest
 *     resolveModel
 *     agentModelLoopGuard
 *     resolveSession
 *     respond            (post phase only)
 *     gatewayDispatch    (terminal — sets ctx.response)
 *
 * Why is `respond` placed before `gatewayDispatch`?  In around order, a
 * middleware that runs LATER in the chain runs its post phase EARLIER on
 * the way out.  We want gatewayDispatch to set `ctx.response` first, then
 * the respond middleware's post phase to serialize and send.  Since
 * respond is shallower (earlier in the array), its post fires AFTER the
 * dispatch, which is exactly what we want.
 *
 * @module runtime/route
 */

import { compose, createKernelContext } from '../kernel/index.mjs';
import { createRequestId } from '../../core/request-id.mjs';
import { MiddlewareAbortError } from '../../core/errors.mjs';

// Conventional status for a request the client abandoned (never sent,
// because the client is gone; used for logs and audit records).
const CLIENT_CLOSED_REQUEST_STATUS = 499;

import { errorBoundaryMiddleware } from './error-boundary.mjs';
import { auditLogMiddleware } from './audit-log.mjs';
import { parseBodyMiddleware } from './parse-body.mjs';
import { authenticateMiddleware } from './authenticate.mjs';
import { identityMiddleware } from './identity.mjs';
import { bindSnapshotMiddleware } from './bind-snapshot.mjs';
import { normalizeIngressMiddleware } from './normalize-ingress.mjs';
import { validateRequestMiddleware } from './validate-request.mjs';
import { resolveModelMiddleware } from './resolve-model.mjs';
import { agentModelLoopGuardMiddleware } from './agent-model-loop-guard.mjs';
import { resolveSessionMiddleware } from './resolve-session.mjs';
import { respondMiddleware } from './respond.mjs';
import { gatewayDispatchMiddleware } from './gateway-dispatch.mjs';

/**
 * Build a route chain.  The result is a single dispatch function that
 * accepts a kernel context and runs the entire request lifecycle.
 *
 * The chain is stateless and can be memoized — currently we build it
 * fresh per request because the cost is microseconds and several
 * middlewares carry small per-instance closures (timings, latches).
 *
 * @returns {(ctx: object) => Promise<void>}
 */
export function buildRouteChain() {
    return compose([
        errorBoundaryMiddleware(),
        parseBodyMiddleware(),
        authenticateMiddleware(),
        identityMiddleware(),
        bindSnapshotMiddleware(),
        normalizeIngressMiddleware(),
        auditLogMiddleware(),
        validateRequestMiddleware(),
        resolveModelMiddleware(),
        agentModelLoopGuardMiddleware(),
        resolveSessionMiddleware(),
        respondMiddleware(),
        gatewayDispatchMiddleware(),
    ]);
}

/**
 * Run a single LLM request through the route chain.
 *
 * Called by the public-API router for each /v1/chat/completions,
 * /v1/messages, and /v1/responses request.  Builds a kernel context
 * pinned to the HTTP req/res and the requested route kind, then runs
 * the chain.
 *
 * @param {object} args
 * @param {object} args.req           Node.js IncomingMessage
 * @param {object} args.res           Node.js ServerResponse
 * @param {object} args.appCtx        Application context
 * @param {string} args.routeKind     'openai_chat' | 'anthropic_messages' | 'openai_responses'
 */
export async function runRouteRequest({ req, res, appCtx, routeKind }) {
    const requestId = createRequestId(appCtx.config.defaults.requestIdPrefix);

    // Propagate the request ID to the response headers
    res.setHeader('X-Request-Id', requestId);

    // The request signal aborts upstream work when the client disconnects
    // before the response is complete; every attempt links to it.
    const clientAbort = new AbortController();
    const onClientClose = () => {
        if (!res.writableEnded && !clientAbort.signal.aborted) {
            clientAbort.abort(
                new MiddlewareAbortError(
                    'client-disconnect',
                    CLIENT_CLOSED_REQUEST_STATUS,
                    'Client closed the request'
                )
            );
        }
    };
    res.once?.('close', onClientClose);

    const ctx = createKernelContext({
        requestId,
        route: { kind: routeKind, format: routeKind },
        services: appCtx.services,
        log: appCtx.log,
        appCtx,
        http: { req, res },
        signal: clientAbort.signal,
    });

    const chain = buildRouteChain();
    await chain(ctx);
}

// ── re-exports of the individual middlewares for tests / extensions ───

export {
    errorBoundaryMiddleware,
    auditLogMiddleware,
    parseBodyMiddleware,
    authenticateMiddleware,
    identityMiddleware,
    bindSnapshotMiddleware,
    normalizeIngressMiddleware,
    validateRequestMiddleware,
    resolveModelMiddleware,
    agentModelLoopGuardMiddleware,
    resolveSessionMiddleware,
    respondMiddleware,
    gatewayDispatchMiddleware,
};
