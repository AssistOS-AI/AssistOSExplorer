/**
 * Dispatch a single provider attempt.
 * This is the integration point between execution engine and provider plugins.
 *
 * Called by executeModelAttempt → executeWithHttpRetry.
 */
export async function dispatchProviderAttempt(attemptCtx) {
  const { plugin, request, resolvedModel, providerRecord, credentialLease, signal, services, logger } = attemptCtx;

  const handle = await plugin.execute({
    request,
    resolvedModel,
    providerRecord,
    credentialLease,
    signal,
    services,
    logger,
  });

  return handle;
}
