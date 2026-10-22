/**
 * Backend execution and lifecycle context factories.
 *
 * Backend modules are deliberately decoupled from the kernel ctx
 * shape: they receive a small, frozen `BackendExecutionContext`
 * (request-time) or `BackendLifecycleContext` (admin/management) and
 * never see raw HTTP objects, the broader appCtx, or kernel internals.
 *
 * The execution-context factory is used by `createBackendTerminal`.
 * The lifecycle-context factory is used by `BackendCatalog`'s
 * `testConnection` / `discoverModels` helpers.
 *
 * @module runtime/backends/backend-context
 */

/**
 * Build the request-time backend execution context that
 * `module.execute()` is called with.
 *
 * @param {object} input
 * @param {string} input.requestId
 * @param {object} input.request          Normalized request object
 * @param {object} input.resolvedModel    Model registry record
 * @param {object} input.providerRecord   Provider registry record
 * @param {object|null} input.credentialLease
 * @param {{ index: number, previousErrors: Array }} [input.attempt]
 * @param {AbortSignal} input.signal
 * @param {object} input.logger
 * @param {object} [input.services]       Frozen services bag
 * @returns {object}                      Frozen BackendExecutionContext
 */
export function createBackendExecutionContext(input) {
    const {
        requestId,
        request,
        resolvedModel,
        providerRecord,
        credentialLease = null,
        attempt = { index: 0, previousErrors: [] },
        signal,
        logger,
        services = Object.freeze({}),
    } = input;

    return Object.freeze({
        requestId,
        request,
        resolvedModel,
        providerRecord,
        credentialLease,
        attempt: Object.freeze({ ...attempt }),
        signal,
        logger,
        services,
    });
}

/**
 * Build the lifecycle context passed to `discoverModels` /
 * `testConnection`.  Same shape as the execution context but with no
 * normalized request — those calls do not run a request, they only
 * probe the upstream.
 *
 * @param {object} input
 * @param {object} input.providerRecord
 * @param {object|null} input.credentialLease
 * @param {AbortSignal} [input.signal]
 * @param {object} input.logger
 * @param {object} [input.services]
 * @returns {object}                     Frozen BackendLifecycleContext
 */
export function createBackendLifecycleContext(input) {
    const {
        providerRecord,
        credentialLease = null,
        signal,
        logger,
        services = Object.freeze({}),
    } = input;

    return Object.freeze({
        requestId: null,
        request: {},
        resolvedModel: null,
        providerRecord,
        credentialLease,
        attempt: Object.freeze({ index: 0, previousErrors: [] }),
        signal,
        logger,
        services,
    });
}
