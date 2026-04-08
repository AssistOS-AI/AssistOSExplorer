/**
 * Builds the execution context object passed to provider execute().
 *
 * The context is a narrow, read-only view over the broader execution
 * state.  Providers never see raw HTTP objects or the full appCtx.
 */

/**
 * Create a provider execution context from the pipeline's execution context.
 *
 * @param {object} execCtx
 * @param {string} execCtx.requestId
 * @param {object} execCtx.request          Normalized request
 * @param {object} execCtx.resolvedModel    Model registry record
 * @param {object} execCtx.providerRecord   Provider registry record
 * @param {object|null} execCtx.credentialLease
 * @param {object} execCtx.attempt          { index, previousErrors }
 * @param {AbortSignal} execCtx.signal
 * @param {object} execCtx.logger
 * @param {object} execCtx.services
 * @returns {object} ExecuteContext for the provider plugin
 */
export function createProviderContext(execCtx) {
    const {
        requestId,
        request,
        resolvedModel,
        providerRecord,
        credentialLease = null,
        attempt = { index: 0, previousErrors: [] },
        signal,
        logger,
        services = {},
    } = execCtx;

    return Object.freeze({
        requestId,
        request,
        resolvedModel,
        providerRecord,
        credentialLease,
        attempt: Object.freeze({ ...attempt }),
        signal,
        logger,
        services: Object.freeze({ ...services }),
    });
}
