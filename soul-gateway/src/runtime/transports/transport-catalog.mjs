/**
 * Transport catalog.
 *
 * The registry of provider plugins that the runtime resolves to per
 * dispatch.  The runtime hot path (`transportDispatchMiddleware`) reads
 * from `appCtx.services.transportCatalog` via `getTransport(key)`.  Provider
 * lifecycle (`testConnection`, `discoverModels`), the management API,
 * and tests all use the same `transportCatalog` binding and the same
 * `getTransport(key)` lookup.
 *
 * The runtime hot path, provider lifecycle helpers, and management APIs
 * all resolve transports through this one catalog.
 */

import { validateTransportManifest } from './transport-interface.mjs';

export class TransportCatalog {
    constructor() {
        /** @type {Map<string, object>} */
        this._plugins = new Map();
    }

    /**
     * Register a transport plugin.
     *
     * @param {string} key
     * @param {object} plugin  TransportPlugin-shaped (see transport-interface.mjs)
     */
    register(key, plugin) {
        validateTransportManifest(plugin.manifest);
        this._plugins.set(key, plugin);
    }

    /**
     * Look up a transport by its registered key.  Callers MUST pass the
     * canonical plugin key (which on a real provider record lives in
     * `providers.adapter_key`).
     *
     * @param {string} key  e.g. `openai-api`, `anthropic-api`
     * @returns {object|null} the registered transport plugin, or null
     */
    getTransport(key) {
        return this._plugins.get(key) || null;
    }

    /**
     * Return all registered transport keys.
     *
     * @returns {string[]}
     */
    listKeys() {
        return [...this._plugins.keys()];
    }

    /**
     * Number of registered transports.
     */
    get size() {
        return this._plugins.size;
    }
}
