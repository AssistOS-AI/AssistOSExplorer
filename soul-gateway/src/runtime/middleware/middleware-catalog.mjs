/**
 * Middleware catalog.
 *
 * Loads, indexes, and instantiates gateway-scope middleware modules.
 * Every registered module must expose the native middleware contract:
 *
 *   - `meta`
 *   - `factory(settings) => async (ctx, next) => {}`
 *
 * The catalog keeps generation-based state so in-flight requests can
 * continue using an older snapshot while a new catalog is loaded.
 */

import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import * as middlewaresDao from '../../db/dao/middlewares-dao.mjs';
import { mergeMiddlewareSettings } from './settings-merge.mjs';
import { DEFAULTS } from '../../config/defaults.mjs';

export class MiddlewareCatalog {
    /** @type {Map<string, object>} */
    #definitions = new Map();

    /** @type {Map<string, Function>} */
    #factories = new Map();

    #generation = 0;

    /**
     * @type {{ definitions: Map, factories: Map, generation: number, expireTimer: any } | null}
     */
    #previous = null;

    #gcGraceMs = DEFAULTS.middlewareGenerationGcGraceMs;
    #pool = null;
    #builtinDir = null;

    constructor(gcGraceMs = DEFAULTS.middlewareGenerationGcGraceMs) {
        this.#gcGraceMs =
            typeof gcGraceMs === 'number'
                ? gcGraceMs
                : (gcGraceMs?.gcGraceMs ??
                  DEFAULTS.middlewareGenerationGcGraceMs);
        this.#pool = gcGraceMs?.pool ?? null;
        this.#builtinDir = gcGraceMs?.builtinDir ?? null;
    }

    async loadFromDb(pool) {
        if (pool) this.#pool = pool;
        const rows = await middlewaresDao.list(pool, { enabled: true });
        for (const row of rows) {
            const definition = {
                id: row.id,
                key: row.middleware_key,
                displayName: row.display_name,
                sourceType: row.source_type,
                modulePath: row.module_path,
                version: row.version,
                defaultSettings: row.default_settings || {},
                enabled: row.enabled,
                metadata: row.metadata || {},
            };
            this.#definitions.set(row.middleware_key, definition);

            if (!row.module_path) {
                continue;
            }

            try {
                const version = row.updated_at
                    ? new Date(row.updated_at).getTime()
                    : Date.now();
                const mod = await import(
                    pathToFileURL(row.module_path).href + `?v=${version}`
                );
                if (typeof mod.factory === 'function') {
                    this.#factories.set(row.middleware_key, mod.factory);
                }
            } catch {
                // Discovery rows may point at missing files during development rescans.
            }
        }
    }

    async loadBuiltins(builtinDir, pool = null) {
        if (builtinDir) this.#builtinDir = builtinDir;
        if (pool) this.#pool = pool;
        let entries;
        try {
            entries = await readdir(builtinDir);
        } catch {
            return;
        }

        for (const file of entries.sort()) {
            if (!file.endsWith('.mjs')) continue;
            const fullPath = join(builtinDir, file);
            const source = await readFile(fullPath, 'utf8').catch(() => '');
            const fileChecksum = createHash('sha256')
                .update(source)
                .digest('hex')
                .slice(0, 16);
            const mod = await import(pathToFileURL(fullPath).href);

            if (!mod.meta?.key || typeof mod.factory !== 'function') {
                continue;
            }

            const definition = {
                id: null,
                key: mod.meta.key,
                displayName: mod.meta.name || mod.meta.key,
                sourceType: 'builtin',
                modulePath: fullPath,
                version: mod.meta.version || '1.0.0',
                defaultSettings: mod.meta.defaultSettings || {},
                enabled: true,
                metadata: {},
            };

            this.#definitions.set(mod.meta.key, definition);
            this.#factories.set(mod.meta.key, mod.factory);

            if (pool) {
                const persisted = await middlewaresDao.upsertFromDiscovery(
                    pool,
                    {
                        middlewareKey: mod.meta.key,
                        displayName: definition.displayName,
                        sourceType: 'builtin',
                        modulePath: fullPath,
                        version: definition.version,
                        checksum: fileChecksum,
                        defaultSettings: definition.defaultSettings,
                        metadata: {},
                    }
                );
                definition.id = persisted.id;
            }
        }
    }

    async registerExtensionMiddleware(manifest, module, checksum, pool = null) {
        const key = manifest?.key;
        if (!key || typeof module?.factory !== 'function') {
            return;
        }

        const definition = {
            id: null,
            key,
            displayName: manifest.name || manifest.displayName || key,
            sourceType: 'custom',
            modulePath:
                manifest.filePath ||
                `extensions/middlewares/${key}.middleware.mjs`,
            version: manifest.version || '0.0.0',
            defaultSettings: manifest.defaultSettings || {},
            enabled: true,
            metadata: { checksum: checksum || 'extension' },
        };

        this.#definitions.set(key, definition);
        this.#factories.set(key, module.factory);

        const dbPool = pool ?? this.#pool;
        if (!dbPool) {
            return;
        }

        try {
            const persisted = await middlewaresDao.upsertFromDiscovery(
                dbPool,
                {
                    middlewareKey: key,
                    displayName: definition.displayName,
                    sourceType: 'custom',
                    modulePath: definition.modulePath,
                    version: definition.version,
                    checksum: checksum || 'extension',
                    defaultSettings: definition.defaultSettings,
                    metadata: definition.metadata,
                }
            );
            definition.id = persisted.id;
        } catch {
            // DB persistence is best-effort for extension middlewares.
        }
    }

    async rescan(options = {}) {
        const pool = options.pool ?? this.#pool ?? null;
        const builtinDir = options.builtinDir ?? this.#builtinDir ?? null;

        const oldDefinitions = this.#definitions;
        const oldFactories = this.#factories;
        const oldGeneration = this.#generation;

        try {
            this.#definitions = new Map();
            this.#factories = new Map();

            if (pool) {
                await this.loadFromDb(pool);
            }
            if (builtinDir) {
                await this.loadBuiltins(builtinDir, pool);
            }

            this.#rotatePreviousGeneration(
                oldDefinitions,
                oldFactories,
                oldGeneration
            );
            return this.#generation;
        } catch (err) {
            this.#definitions = oldDefinitions;
            this.#factories = oldFactories;
            this.#generation = oldGeneration;
            throw err;
        }
    }

    getMiddleware(key) {
        return (
            this.#definitions.get(key) ||
            (this.#previous && this.#previous.definitions.get(key)) ||
            null
        );
    }

    getFactory(key) {
        return (
            this.#factories.get(key) ||
            (this.#previous && this.#previous.factories.get(key)) ||
            null
        );
    }

    build(key, settings = {}) {
        const factory = this.getFactory(key);
        if (!factory) {
            return null;
        }
        return factory(settings);
    }

    resolveGatewayChain({ modelId, snapshot }) {
        const chain = [];
        const gatewayBindings = snapshot.middlewareBindings?.gateway || [];
        const modelBindings = modelId
            ? snapshot.middlewareBindings?.byModel.get(modelId) || []
            : [];

        for (const binding of [...gatewayBindings, ...modelBindings]) {
            const factory = this.getFactory(binding.middlewareKey);
            if (!factory) {
                continue;
            }

            const settings = mergeMiddlewareSettings(
                binding.middlewareDefaultSettings,
                binding.settings
            );
            const middleware = factory(settings);
            if (typeof middleware !== 'function') {
                continue;
            }
            chain.push(middleware);
        }

        return chain;
    }

    resolveProviderPlan({ providerId, snapshot }) {
        if (!providerId) return [];
        const bindings =
            snapshot.middlewareBindings?.byProvider.get(providerId) || [];
        const plan = [];
        for (const binding of bindings) {
            const settings = mergeMiddlewareSettings(
                binding.middlewareDefaultSettings,
                binding.settings
            );
            plan.push(
                Object.freeze({
                    middlewareKey: binding.middlewareKey,
                    settings,
                    sourceType: binding.sourceType,
                    sortOrder: binding.sortOrder,
                })
            );
        }
        return plan;
    }

    promoteGeneration() {
        const oldDefinitions = this.#definitions;
        const oldFactories = this.#factories;
        const oldGen = this.#generation;

        this.#generation += 1;
        this.#definitions = new Map(oldDefinitions);
        this.#factories = new Map(oldFactories);
        this.#rotatePreviousGeneration(oldDefinitions, oldFactories, oldGen);

        return this.#generation;
    }

    get generation() {
        return this.#generation;
    }

    get size() {
        return this.#definitions.size;
    }

    get hasPreviousGeneration() {
        return this.#previous !== null;
    }

    expirePreviousGeneration() {
        if (this.#previous) {
            if (this.#previous.expireTimer) {
                clearTimeout(this.#previous.expireTimer);
            }
            this.#previous = null;
        }
    }

    #rotatePreviousGeneration(oldDefinitions, oldFactories, oldGeneration) {
        if (this.#previous?.expireTimer) {
            clearTimeout(this.#previous.expireTimer);
            this.#previous = null;
        }

        this.#generation = oldGeneration + 1;
        this.#previous = {
            definitions: oldDefinitions,
            factories: oldFactories,
            generation: oldGeneration,
            expireTimer: setTimeout(() => {
                if (
                    this.#previous &&
                    this.#previous.generation === oldGeneration
                ) {
                    this.#previous = null;
                }
            }, this.#gcGraceMs),
        };

        if (this.#previous.expireTimer.unref) {
            this.#previous.expireTimer.unref();
        }
    }
}
