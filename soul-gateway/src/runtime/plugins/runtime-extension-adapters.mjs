import { ConfigurationError } from '../../core/errors.mjs';
import { validateBackendManifest } from '../backends/backend-interface.mjs';

/**
 * Adapt a backend extension entry into a BackendModule the catalog can
 * register.  Extension modules can either:
 *
 *   - export `backendModule` directly (preferred), or
 *   - export `execute()` plus optional lifecycle methods alongside a
 *     `manifest` / `meta` object.
 *
 * In either case the result is normalized to the `BackendModule`
 * shape declared in `runtime/backends/backend-interface.mjs`.
 *
 * @param {object} entry  ExtensionLoader catalog entry
 * @returns {object}      BackendModule
 */
export function adaptExtensionEntryToBackend(entry) {
    const mod = entry?.module || {};
    if (mod.backendModule) {
        validateBackendManifest(mod.backendModule.manifest);
        return mod.backendModule;
    }

    const manifest = mod.manifest || mod.meta || entry?.manifest || {};
    if (typeof mod.execute !== 'function') {
        throw new ConfigurationError(
            `Backend extension ${manifest.key || entry?.filePath || 'unknown'} must export execute() or backendModule`
        );
    }

    const normalizedManifest = normalizeBackendManifest(manifest);
    validateBackendManifest(normalizedManifest);

    const backendModule = {
        manifest: normalizedManifest,
        execute: mod.execute.bind(mod),
        classifyError:
            typeof mod.classifyError === 'function'
                ? mod.classifyError.bind(mod)
                : (error) => error,
    };

    if (typeof mod.discoverModels === 'function') {
        backendModule.discoverModels = mod.discoverModels.bind(mod);
    }
    if (typeof mod.testConnection === 'function') {
        backendModule.testConnection = mod.testConnection.bind(mod);
    }
    if (typeof mod.init === 'function') {
        backendModule.init = mod.init.bind(mod);
    }
    if (typeof mod.shutdown === 'function') {
        backendModule.shutdown = mod.shutdown.bind(mod);
    }

    return backendModule;
}

function normalizeBackendManifest(manifest) {
    return {
        key: manifest.key,
        kind: manifest.kind || 'custom',
        authStrategy: manifest.authStrategy || 'none',
        supportsStreaming: manifest.supportsStreaming ?? true,
        supportsTools: manifest.supportsTools ?? false,
        supportedFormats: Array.isArray(manifest.supportedFormats)
            ? manifest.supportedFormats
            : ['openai_chat'],
        displayName: manifest.displayName || manifest.name || manifest.key,
        defaultBaseUrl: manifest.defaultBaseUrl || null,
        oauthAdapterKey: manifest.oauthAdapterKey || null,
        hidden: manifest.hidden ?? false,
    };
}
