import { ConfigurationError } from '../../core/errors.mjs';
import { validateTransportManifest } from '../transports/transport-interface.mjs';

export function adaptExtensionEntryToTransport(entry) {
    const mod = entry?.module || {};
    if (mod.transportPlugin) {
        validateTransportManifest(mod.transportPlugin.manifest);
        return mod.transportPlugin;
    }

    const manifest = mod.manifest || mod.meta || entry?.manifest || {};
    if (typeof mod.execute !== 'function') {
        throw new ConfigurationError(
            `Transport extension ${manifest.key || entry?.filePath || 'unknown'} must export execute() or transportPlugin`
        );
    }

    const transport = {
        manifest: normalizeTransportManifest(manifest, entry),
        execute: mod.execute.bind(mod),
        classifyError:
            typeof mod.classifyError === 'function'
                ? mod.classifyError.bind(mod)
                : (error) => error,
    };

    if (typeof mod.discoverModels === 'function') {
        transport.discoverModels = mod.discoverModels.bind(mod);
    }
    if (typeof mod.testConnection === 'function') {
        transport.testConnection = mod.testConnection.bind(mod);
    }
    if (typeof mod.init === 'function') {
        transport.init = mod.init.bind(mod);
    }
    if (typeof mod.shutdown === 'function') {
        transport.shutdown = mod.shutdown.bind(mod);
    }

    validateTransportManifest(transport.manifest);
    return transport;
}

function normalizeTransportManifest(manifest, entry) {
    return {
        key: manifest.key,
        name: manifest.name || manifest.displayName || manifest.key,
        transportType: manifest.transportType || inferTransportType(entry),
        supportsStreaming: manifest.supportsStreaming ?? true,
        supportsTools: manifest.supportsTools ?? false,
    };
}

function inferTransportType(_entry) {
    return 'custom';
}
