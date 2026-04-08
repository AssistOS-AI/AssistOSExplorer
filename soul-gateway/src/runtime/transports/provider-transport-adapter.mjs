/**
 * Adapter that wraps a ProviderPlugin into the catalog-friendly shape.
 *
 * Produces a TransportPlugin that the TransportCatalog can register
 * and that the runtime can dispatch to as the terminal of the kernel
 * middleware chain.
 *
 * @module provider-transport-adapter
 */

/**
 * Adapt a ProviderPlugin to the catalog plugin shape.
 *
 * @param {object} providerPlugin  A loaded ProviderPlugin (see provider-interface.mjs)
 * @returns {object} catalog-compatible plugin object
 */
export function adaptProviderToTransport(providerPlugin) {
    const pm = providerPlugin.manifest;

    const manifest = {
        key: pm.key,
        name: pm.displayName || pm.key,
        // Maps provider kind directly to transportType.
        transportType: pm.kind,
        supportsStreaming: pm.supportsStreaming,
        supportsTools: pm.supportsTools,
    };

    const transport = {
        manifest,
        execute: providerPlugin.execute.bind(providerPlugin),
        classifyError: providerPlugin.classifyError.bind(providerPlugin),
    };

    if (typeof providerPlugin.discoverModels === 'function') {
        transport.discoverModels =
            providerPlugin.discoverModels.bind(providerPlugin);
    }

    if (typeof providerPlugin.testConnection === 'function') {
        transport.testConnection =
            providerPlugin.testConnection.bind(providerPlugin);
    }

    if (typeof providerPlugin.init === 'function') {
        transport.init = providerPlugin.init.bind(providerPlugin);
    }

    if (typeof providerPlugin.shutdown === 'function') {
        transport.shutdown = providerPlugin.shutdown.bind(providerPlugin);
    }

    return transport;
}
