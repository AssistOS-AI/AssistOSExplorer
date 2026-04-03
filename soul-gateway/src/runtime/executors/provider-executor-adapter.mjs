/**
 * Adapter that wraps a current ProviderPlugin into the ExecutorPlugin shape.
 *
 * During migration this allows the executor catalog to be populated from
 * existing provider plugins without rewriting any of them.
 *
 * @module provider-executor-adapter
 */

/**
 * Adapt a ProviderPlugin to the ExecutorPlugin contract.
 *
 * @param {object} providerPlugin  A loaded ProviderPlugin (see provider-interface.mjs)
 * @returns {object} ExecutorPlugin-compatible object
 */
export function adaptProviderToExecutor(providerPlugin) {
  const pm = providerPlugin.manifest;

  const manifest = {
    key: pm.key,
    name: pm.displayName || pm.key,
    // Maps provider kind directly to executorType.
    // Note: kind='wrapper' is deprecated but still mapped 1:1 for backward compat.
    // New wrapping behavior should use provider hooks, not executor wrappers.
    executorType: pm.kind,
    supportsStreaming: pm.supportsStreaming,
    supportsTools: pm.supportsTools,
  };

  const executor = {
    manifest,
    execute: providerPlugin.execute.bind(providerPlugin),
    classifyError: providerPlugin.classifyError.bind(providerPlugin),
  };

  if (typeof providerPlugin.discoverModels === 'function') {
    executor.discoverModels = providerPlugin.discoverModels.bind(providerPlugin);
  }

  if (typeof providerPlugin.testConnection === 'function') {
    executor.testConnection = providerPlugin.testConnection.bind(providerPlugin);
  }

  if (typeof providerPlugin.init === 'function') {
    executor.init = providerPlugin.init.bind(providerPlugin);
  }

  if (typeof providerPlugin.shutdown === 'function') {
    executor.shutdown = providerPlugin.shutdown.bind(providerPlugin);
  }

  return executor;
}
