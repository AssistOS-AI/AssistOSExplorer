/**
 * BackendCatalog — single registry of loaded backend modules.
 *
 * Replaces the historical pair `ProviderCatalog` + `TransportCatalog`.
 * Below routing, every external call goes through one terminal
 * middleware looked up here by `getTerminal(key)`.  The same catalog
 * is used by lifecycle/admin operations (`testConnection`,
 * `discoverModels`, `getTemplates`) — there is no parallel "provider
 * lifecycle" registry.
 *
 * For each registered module the catalog stores:
 *
 *   - the BackendModule itself (used by lifecycle/admin operations)
 *   - a precompiled kernel terminal middleware built once via
 *     `createBackendTerminal(module)` (used by the dispatch hot path)
 *
 * Generation-based hot reload is supported: a fresh catalog generation
 * can be assembled and swapped in atomically while in-flight requests
 * keep running on the previous generation's terminals.
 *
 * @module runtime/backends/backend-catalog
 */

import { validateBackendManifest } from './backend-interface.mjs';
import { createBackendTerminal } from './backend-terminal.mjs';
import { createBackendLifecycleContext } from './backend-context.mjs';
import { normalizeProviderRecord } from '../providers/runtime-record-normalizer.mjs';
import { PROVIDER_PRESETS } from '../providers/provider-presets.mjs';

export class BackendCatalog {
    constructor({ log }) {
        this._log = log;
        this._generation = 0;
        this._inflightCount = 0;

        /** @type {Map<string, { module: object, terminal: Function }>} */
        this._entries = new Map();

        /** @type {Map<number, { entries: Map, inflightCount: number }>} */
        this._oldGenerations = new Map();
    }

    // ── Loading ─────────────────────────────────────────────────────────

    /**
     * Atomically load a fresh generation of backend modules.
     *
     * @param {Array<object>} modules  BackendModule[]
     */
    load(modules) {
        const newGen = this._generation + 1;
        /** @type {Map<string, { module: object, terminal: Function }>} */
        const newEntries = new Map();

        for (const backendModule of modules) {
            validateBackendManifest(backendModule.manifest);
            const key = backendModule.manifest.key;
            if (newEntries.has(key)) {
                throw new Error(`Duplicate backend key in catalog: ${key}`);
            }
            newEntries.set(key, {
                module: backendModule,
                terminal: createBackendTerminal(backendModule),
            });
        }

        if (this._entries.size > 0) {
            this._oldGenerations.set(this._generation, {
                entries: this._entries,
                inflightCount: this._inflightCount,
            });
        }

        this._inflightCount = 0;

        this._entries = newEntries;
        this._generation = newGen;

        this._log.info('backend_catalog_loaded', {
            generation: newGen,
            backendCount: newEntries.size,
            keys: [...newEntries.keys()],
        });
    }

    /**
     * Register one extension-shipped backend module after the initial
     * load.  Used during reload when extension modules are merged into
     * the current generation.
     *
     * @param {object} backendModule
     */
    registerExtension(backendModule) {
        validateBackendManifest(backendModule.manifest);
        const key = backendModule.manifest.key;
        if (this._entries.has(key)) {
            throw new Error(
                `Backend key collision with built-in: ${key}`
            );
        }
        this._entries.set(key, {
            module: backendModule,
            terminal: createBackendTerminal(backendModule),
        });
    }

    // ── Lookups ─────────────────────────────────────────────────────────

    /**
     * Get the precompiled kernel terminal middleware for the given
     * backend key.  Used by `backendDispatchMiddleware`.
     *
     * @param {string} key
     * @returns {Function|null}
     */
    getTerminal(key) {
        return this._entries.get(key)?.terminal || null;
    }

    /**
     * Get the precompiled kernel terminal middleware for a specific
     * catalog generation. Used by the request path to pin an in-flight
     * request to the generation it started on while reloads happen.
     *
     * @param {string} key
     * @param {number} generation
     * @returns {Function|null}
     */
    getTerminalForGeneration(key, generation) {
        if (generation === this._generation) {
            return this._entries.get(key)?.terminal || null;
        }
        return this._oldGenerations.get(generation)?.entries.get(key)?.terminal || null;
    }

    /**
     * Get the BackendModule for the given key.  Used by lifecycle/admin
     * operations and template rendering.
     *
     * @param {string} key
     * @returns {object|null}
     */
    getBackend(key) {
        return this._entries.get(key)?.module || null;
    }

    /**
     * @returns {string[]}  All registered backend keys
     */
    listKeys() {
        return [...this._entries.keys()];
    }

    /**
     * @returns {Map<string, object>}  Snapshot of `key -> BackendModule`
     */
    getAllBackends() {
        const out = new Map();
        for (const [key, entry] of this._entries) {
            out.set(key, entry.module);
        }
        return out;
    }

    get generation() {
        return this._generation;
    }

    get size() {
        return this._entries.size;
    }

    acquireGeneration() {
        this._inflightCount++;
        return this._generation;
    }

    releaseGeneration(generation) {
        if (generation === this._generation) {
            this._inflightCount = Math.max(0, this._inflightCount - 1);
            return;
        }

        const old = this._oldGenerations.get(generation);
        if (!old) return;

        old.inflightCount = Math.max(0, old.inflightCount - 1);
        if (old.inflightCount > 0) return;

        for (const [key, entry] of old.entries) {
            const shutdown = entry.module.shutdown;
            if (typeof shutdown === 'function') {
                shutdown.call(entry.module).catch((err) => {
                    this._log.error('old_backend_shutdown_failed', {
                        key,
                        error: err.message,
                    });
                });
            }
        }
        this._oldGenerations.delete(generation);
        this._log.info('old_backend_generation_cleaned', { generation });
    }

    // ── Templates ───────────────────────────────────────────────────────

    /**
     * Built-in dashboard templates for the "Add Provider" picker.
     *
     * Returns a `key -> template` object that merges:
     *
     *   1. Vendor presets from `provider-presets.mjs`, filtered to
     *      those whose backend module is currently loaded.  This is
     *      how generic dispatchers (`openai-api`, `anthropic-api`)
     *      surface as multiple vendor-labelled dropdown entries
     *      (NVIDIA, Groq, …) without code
     *      duplication.
     *
     *   2. Module-derived templates for non-hidden backend modules.
     *      OAuth-backed modules (`codex-api`, `copilot-api`, …) leave
     *      `hidden` unset and surface as their own picker entries
     *      because no presets exist for them.  Protocol-family
     *      dispatchers set `hidden: true` and never surface here.
     *
     * Module-derived templates win on key collisions (manifests are
     * authoritative code; presets are configuration).
     *
     * @returns {object}
     */
    getTemplates() {
        const templates = {};

        // 1. Presets first so module entries can override on collision.
        for (const preset of PROVIDER_PRESETS) {
            if (!this.getBackend(preset.adapter_key)) continue;
            templates[preset.key] = { ...preset };
        }

        // 2. Non-hidden module-derived templates.
        for (const [key, entry] of this._entries) {
            const manifest = entry.module.manifest;
            if (manifest.hidden) continue;
            templates[key] = {
                key: manifest.key,
                adapter_key: manifest.key,
                kind: manifest.kind,
                display_name: manifest.displayName || key,
                auth_strategy: manifest.authStrategy || 'api_key',
                auth_type:
                    manifest.authStrategy === 'oauth' ? 'managed' : 'api_key',
                oauth_adapter_key: manifest.oauthAdapterKey || null,
                base_url: manifest.defaultBaseUrl || null,
                supports_streaming: manifest.supportsStreaming ?? true,
                supports_tools: manifest.supportsTools ?? true,
                supported_formats: manifest.supportedFormats || ['openai_chat'],
            };
        }
        return templates;
    }

    // ── Lifecycle/admin ─────────────────────────────────────────────────

    /**
     * Probe upstream connectivity for a provider record by routing the
     * call through that provider's backend module.
     *
     * @param {object} providerRecord  raw or normalized provider record
     * @param {object} [options]
     * @param {object} [options.credentialManager]
     * @param {object} [options.services]
     * @param {object} [options.logger]
     * @param {AbortSignal} [options.signal]
     * @returns {Promise<{ok: boolean, detail: any}>}
     */
    async testConnection(providerRecord, options = {}) {
        const backendModule = this._resolveModuleForRecord(providerRecord);
        if (
            !backendModule ||
            typeof backendModule.testConnection !== 'function'
        ) {
            return {
                ok: false,
                detail: 'Backend module not loaded or does not support testConnection',
            };
        }

        const { ctx, releaseLease } =
            await this._buildLifecycleContext(providerRecord, options);
        try {
            return await backendModule.testConnection(ctx);
        } finally {
            releaseLease();
        }
    }

    /**
     * Discover models for a provider record by routing the call
     * through that provider's backend module.
     *
     * @param {object} providerRecord
     * @param {object} [options]
     * @returns {Promise<Array>}
     */
    async discoverModels(providerRecord, options = {}) {
        const backendModule = this._resolveModuleForRecord(providerRecord);
        if (
            !backendModule ||
            typeof backendModule.discoverModels !== 'function'
        ) {
            return [];
        }

        const { ctx, releaseLease } =
            await this._buildLifecycleContext(providerRecord, options);
        try {
            return await backendModule.discoverModels(ctx);
        } finally {
            releaseLease();
        }
    }

    /**
     * Shutdown every backend module in the current generation and any
     * old generations still being drained.
     */
    async shutdownAll() {
        const shutdowns = [];
        for (const [key, entry] of this._entries) {
            const shutdown = entry.module.shutdown;
            if (typeof shutdown === 'function') {
                shutdowns.push(
                    shutdown.call(entry.module).catch((err) => {
                        this._log.error('backend_shutdown_failed', {
                            key,
                            error: err.message,
                        });
                    })
                );
            }
        }
        await Promise.allSettled(shutdowns);
        this._entries.clear();

        for (const [, old] of this._oldGenerations) {
            for (const [key, entry] of old.entries) {
                const shutdown = entry.module.shutdown;
                if (typeof shutdown === 'function') {
                    await shutdown.call(entry.module).catch((err) => {
                        this._log.error('old_backend_shutdown_failed', {
                            key,
                            error: err.message,
                        });
                    });
                }
            }
        }
        this._oldGenerations.clear();
    }

    // ── Internals ───────────────────────────────────────────────────────

    _resolveModuleForRecord(providerRecord) {
        const normalized = normalizeProviderRecord(providerRecord);
        const key = normalized.backendKey;
        if (!key) {
            return null;
        }
        return this.getBackend(key);
    }

    async _buildLifecycleContext(providerRecord, options = {}) {
        const credentialManager = options.credentialManager || null;
        const normalized = normalizeProviderRecord(providerRecord);
        let credentialLease = null;

        if (credentialManager && normalized?.id) {
            credentialLease = await credentialManager.getCredentials(
                normalized.id
            );
        }

        const ctx = createBackendLifecycleContext({
            providerRecord: normalized,
            credentialLease,
            signal: options.signal || AbortSignal.timeout?.(10_000),
            logger: options.logger || this._log,
            services: options.services || Object.freeze({}),
        });

        const releaseLease = () => {
            if (credentialLease && credentialManager) {
                credentialManager.release(credentialLease);
            }
        };

        return { ctx, releaseLease };
    }
}
