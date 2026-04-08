/**
 * Unified runtime context factory.
 *
 * Every middleware in the gateway sees the same context shape, regardless of
 * scope (route, gateway, model, provider, transport).  The context is the
 * single mutable object that flows through the kernel.
 *
 * Notable fields (all optional at construction time, populated by middlewares
 * as they run):
 *
 *   - `requestId`   - opaque correlation id, set on creation
 *   - `route`       - route metadata: { kind, path, format }
 *   - `request`     - canonical request payload (mutated by ingress middleware)
 *   - `response`    - canonical response (set by terminal transport, possibly
 *                     transformed by upstream middlewares on the way out)
 *   - `identity`    - { agentName, soulId, explicitSessionId, ... }
 *   - `auth`        - { keyId, label, rpmLimit, tpmLimit, apiKeyRecord }
 *   - `session`     - { id, key, agentName, soulId }
 *   - `target`      - { model, provider } — current invocation target
 *   - `attempt`     - { index, previousErrors } — used by retry/cascade
 *   - `snapshot`    - frozen runtime snapshot bound at ingress
 *   - `services`    - frozen view of `appCtx.services`
 *   - `state`       - per-request key/value bag for middleware coordination
 *   - `metadata`    - extensible bag for observability / cross-cutting data
 *   - `signal`      - AbortSignal honoured by transports
 *   - `log`         - logger
 *   - `abort`       - shared { success, error } surface (per-middleware
 *                     instances are created when chains run)
 *   - `invokeModel` - cascade re-entry hook (installed by request runtime)
 *
 * Construction does not freeze anything: middlewares are expected to mutate.
 * Frozen sub-objects (snapshot, services) come from the caller.
 *
 * @module runtime/kernel/context
 */

import { createAbortApi } from './abort.mjs';

const NOOP_LOG = Object.freeze({
    debug() {},
    info() {},
    warn() {},
    error() {},
    fatal() {},
});

/**
 * @typedef {Object} CreateKernelContextInput
 * @property {string}              requestId
 * @property {object|null}         [route]
 * @property {object|null}         [request]
 * @property {object|null}         [identity]
 * @property {object|null}         [auth]
 * @property {object|null}         [session]
 * @property {object|null}         [target]
 * @property {object|null}         [snapshot]
 * @property {object|null}         [services]
 * @property {AbortSignal|null}    [signal]
 * @property {object|null}         [log]
 * @property {object}              [metadata]
 * @property {object|null}         [appCtx]      application context
 * @property {object|null}         [http]        { req, res } when invoked from a route handler
 */

/**
 * Build a fresh kernel context object.  All fields default to safe values
 * so the kernel can run with a minimal context (e.g. inside a unit test).
 *
 * @param {CreateKernelContextInput} input
 * @returns {object}
 */
export function createKernelContext(input = {}) {
    if (!input.requestId || typeof input.requestId !== 'string') {
        throw new TypeError('createKernelContext: requestId is required');
    }

    return {
        // Identifiers
        requestId: input.requestId,
        startedAt:
            typeof input.startedAt === 'number' ? input.startedAt : Date.now(),

        // Routing
        route: input.route ?? null,

        // Canonical request/response
        request: input.request ?? null,
        response: input.response ?? null,

        // Identity / auth / session
        identity: input.identity ?? null,
        auth: input.auth ?? null,
        session: input.session ?? null,

        // Target / attempt
        target: input.target ?? null,
        attempt: input.attempt ?? { index: 0, previousErrors: [] },

        // Runtime state
        snapshot: input.snapshot ?? null,
        services: input.services ?? Object.freeze({}),
        state: new Map(),
        metadata: input.metadata ? { ...input.metadata } : {},

        // I/O
        signal: input.signal ?? null,
        log: input.log ?? NOOP_LOG,

        // Abort surface — middlewares typically receive a name-bound version
        // built by the planner, but we install a generic one for ad-hoc use.
        abort: createAbortApi('kernel'),

        // Cascade re-entry — installed by the request runtime so a cascade
        // middleware can dispatch a child model through the same kernel.
        invokeModel: input.invokeModel ?? null,

        // Application context. Route-scope middleware reads ctx.appCtx
        // for things like config.env and the pg pool.
        appCtx: input.appCtx ?? null,

        // Raw HTTP primitives, populated by the route handler.  Route-scope
        // middlewares (body parser, authenticate, respond, error boundary)
        // read these; deeper middlewares should not.  Optional — provider
        // chains and unit tests typically run without an http binding.
        http: input.http ?? null,
    };
}

/**
 * Build a child context for a sub-invocation (cascade fallback, retry).
 * Inherits the parent's identifiers and shared services but resets the
 * request-scoped state and attempt index.
 *
 * @param {object} parent
 * @param {object} [overrides]
 * @returns {object}
 */
export function forkKernelContext(parent, overrides = {}) {
    if (!parent || typeof parent !== 'object') {
        throw new TypeError('forkKernelContext: parent must be an object');
    }

    const child = createKernelContext({
        requestId: parent.requestId,
        route: parent.route,
        identity: parent.identity,
        auth: parent.auth,
        session: parent.session,
        snapshot: parent.snapshot,
        services: parent.services,
        signal: parent.signal,
        log: parent.log,
        appCtx: parent.appCtx,
        invokeModel: parent.invokeModel,
        request: parent.request,
        metadata: parent.metadata,
        ...overrides,
    });

    // Reset attempt to a fresh counter unless the caller specified one.
    if (!overrides.attempt) {
        child.attempt = { index: 0, previousErrors: [] };
    }

    return child;
}
