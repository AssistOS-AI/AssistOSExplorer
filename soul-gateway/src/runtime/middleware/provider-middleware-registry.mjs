/**
 * Provider middleware registry.
 *
 * Holds native provider middlewares keyed by middleware key. Every
 * module must expose:
 *
 *   - `meta`
 *   - `factory(settings) => async (ctx, next) => {}`
 */

import { BUILTIN_PROVIDER_MIDDLEWARES } from './provider-builtin/index.mjs';

export class ProviderMiddlewareRegistry {
    constructor() {
        /** @type {Map<string, { meta: object, factory: (settings: object) => Function }>} */
        this._modules = new Map();
    }

    register(module) {
        const key = module?.meta?.key;
        if (!key || typeof key !== 'string') {
            throw new TypeError(
                'ProviderMiddlewareRegistry: module must export meta.key'
            );
        }
        if (typeof module.factory !== 'function') {
            throw new TypeError(
                `ProviderMiddlewareRegistry: module ${key} must export factory()`
            );
        }
        this._modules.set(key, module);
    }

    loadBuiltins() {
        for (const module of BUILTIN_PROVIDER_MIDDLEWARES) {
            this.register(module);
        }
        return this;
    }

    get(key) {
        return this._modules.get(key) || null;
    }

    build(key, settings) {
        const module = this._modules.get(key);
        if (!module) return null;
        return module.factory(settings);
    }

    get size() {
        return this._modules.size;
    }

    listKeys() {
        return [...this._modules.keys()];
    }
}
