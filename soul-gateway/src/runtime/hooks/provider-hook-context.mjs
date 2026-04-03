/**
 * Build the mutable context used by provider-scoped hooks.
 *
 * Provider plugins still receive the narrower provider execution context,
 * but hooks need a mutable envelope so request wrappers can replace the
 * normalized request and response wrappers can inspect or rewrite the
 * buffered response and usage after collection.
 */

export function createProviderHookContext(providerCtx) {
  return {
    requestId: providerCtx.requestId,
    request: providerCtx.request,
    resolvedModel: providerCtx.resolvedModel,
    providerRecord: providerCtx.providerRecord,
    credentialLease: providerCtx.credentialLease,
    attempt: { ...(providerCtx.attempt || {}) },
    signal: providerCtx.signal,
    logger: providerCtx.logger,
    services: providerCtx.services,
    state: {},
    response: null,
    usage: null,
  };
}

export function applyCollectedResultToHookContext(hookCtx, collected) {
  hookCtx.response = collected;
  hookCtx.usage = collected?.usage || null;
  return hookCtx;
}

export function readCollectedResultFromHookContext(hookCtx, collected) {
  const nextCollected = hookCtx.response || collected;
  if (hookCtx.usage) {
    nextCollected.usage = hookCtx.usage;
  }
  return nextCollected;
}
