import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { statSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { validateExtensionManifest } from './manifest-validator.mjs';
import { EXTENSION_SCOPES, EXTENSION_TYPES } from './extension-constants.mjs';

/**
 * ExtensionLoader — discovers and loads extension modules from directories.
 *
 * Canonical paths:
 *
 *   extensions/middlewares/*.middleware.mjs          — gateway-scope middleware
 *   extensions/provider-middlewares/*.middleware.mjs — provider-scope middleware
 *   extensions/backends/*.backend.mjs                — terminal backend extensions
 *
 * The runtime concepts are: gateway middleware, provider middleware,
 * and backends.
 */
export class ExtensionLoader {
    constructor(extensionsDir, log) {
        this.extensionsDir = extensionsDir;
        this.log = log;
        this._generation = 0;
    }

    /**
     * Scan all extension directories and load modules.
     * Returns a catalog of loaded extensions grouped by kind.
     *
     * Every catalog entry carries runtime metadata:
     *   scope  — 'gateway' | 'provider' (middleware only)
     *   type   — 'middleware' | 'backend'
     */
    async scan() {
        this._generation++;
        const catalog = {
            generation: this._generation,
            middlewares: [],
            providerMiddlewares: [],
            backends: [],
        };

        const kinds = [
            {
                dir: 'middlewares',
                suffix: '.middleware.mjs',
                target: 'middlewares',
                scope: EXTENSION_SCOPES.GATEWAY,
                type: EXTENSION_TYPES.MIDDLEWARE,
            },
            {
                dir: 'provider-middlewares',
                suffix: '.middleware.mjs',
                target: 'providerMiddlewares',
                scope: EXTENSION_SCOPES.PROVIDER,
                type: EXTENSION_TYPES.MIDDLEWARE,
            },
            {
                dir: 'backends',
                suffix: '.backend.mjs',
                target: 'backends',
                scope: null,
                type: EXTENSION_TYPES.BACKEND,
            },
        ];

        for (const { dir, suffix, target, scope, type } of kinds) {
            await this._scanDir(dir, suffix, target, scope, type, catalog);
        }

        return catalog;
    }

    /**
     * Scan a single subdirectory, loading every file that matches the suffix.
     * @private
     */
    async _scanDir(dir, suffix, target, scope, type, catalog) {
        const fullDir = join(this.extensionsDir, dir);
        const files = await safeReaddir(fullDir);

        for (const file of files) {
            if (!file.endsWith(suffix)) continue;
            const filePath = join(fullDir, file);

            try {
                const mtime = statSync(filePath).mtimeMs;
                const mod = await import(
                    pathToFileURL(filePath).href + `?v=${mtime}`
                );
                const manifest =
                    target === 'backends'
                        ? mod.backendModule?.manifest ||
                          mod.manifest ||
                          mod.meta
                        : mod.manifest || mod.meta;

                if (!manifest) {
                    this.log.warn('extension missing manifest', {
                        file: filePath,
                    });
                    continue;
                }

                validateExtensionManifest(manifest, target);

                const source = await readFile(filePath, 'utf-8');
                const checksum = createHash('sha256')
                    .update(source)
                    .digest('hex')
                    .slice(0, 16);

                catalog[target].push({
                    manifest,
                    module: mod,
                    filePath,
                    checksum,
                    loadedAt: Date.now(),
                    scope,
                    type,
                    target,
                });

                this.log.info('extension loaded', {
                    kind: target,
                    key: manifest.key,
                    file,
                    scope,
                    type,
                });
            } catch (err) {
                this.log.error('extension load failed', {
                    file: filePath,
                    error: err.message,
                });
            }
        }
    }

    get generation() {
        return this._generation;
    }
}

async function safeReaddir(dir) {
    try {
        return await readdir(dir);
    } catch (err) {
        if (err.code === 'ENOENT') return [];
        throw err;
    }
}
