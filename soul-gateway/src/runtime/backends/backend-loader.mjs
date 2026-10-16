/**
 * BackendLoader — discovers and loads built-in backend modules from disk.
 *
 * Scan locations:
 *
 *   src/runtime/backends/builtin/*.backend.mjs
 *
 * Modules must export `backendModule` conforming to the BackendModule
 * shape declared in `backend-interface.mjs`.
 *
 * @module runtime/backends/backend-loader
 */

import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ConfigurationError } from '../../core/errors.mjs';
import { validateBackendManifest } from './backend-interface.mjs';

export class BackendLoader {
    /**
     * @param {object} deps
     * @param {string} deps.builtinDir  Absolute path to backends/builtin
     * @param {object} deps.log
     */
    constructor({ builtinDir, log }) {
        this._builtinDir = builtinDir;
        this._log = log;
    }

    /**
     * Load every built-in backend module.
     *
     * @returns {Promise<Array<object>>}  BackendModule[]
     */
    async loadAll() {
        const modules = await this._scanDirectory(
            this._builtinDir,
            '.backend.mjs'
        );

        this._log.info('backend_loader_complete', {
            total: modules.length,
            keys: modules.map((m) => m.manifest.key),
        });

        return modules;
    }

    /**
     * Load a single backend module from disk.
     *
     * @param {string} filePath
     * @returns {Promise<object>}  BackendModule
     */
    async loadModule(filePath) {
        const mtime = statSync(filePath).mtimeMs;
        const url = pathToFileURL(filePath).href + '?v=' + mtime;

        const mod = await import(url);
        const backendModule =
            mod.backendModule || mod.default?.backendModule;

        if (!backendModule) {
            throw new ConfigurationError(
                `Module does not export backendModule: ${filePath}`
            );
        }

        validateBackendManifest(backendModule.manifest);
        this._validateModule(backendModule, filePath);

        return backendModule;
    }

    async _scanDirectory(dir, suffix) {
        const modules = [];

        let entries;
        try {
            entries = readdirSync(dir);
        } catch (err) {
            if (err.code === 'ENOENT') return modules;
            throw err;
        }

        for (const entry of entries) {
            if (!entry.endsWith(suffix)) continue;

            const filePath = join(dir, entry);
            try {
                const stat = statSync(filePath);
                if (!stat.isFile()) continue;

                const backendModule = await this.loadModule(filePath);
                modules.push(backendModule);

                this._log.info('backend_module_loaded', {
                    key: backendModule.manifest.key,
                    kind: backendModule.manifest.kind,
                    file: entry,
                });
            } catch (err) {
                this._log.error('backend_module_load_failed', {
                    file: entry,
                    error: err.message,
                });
            }
        }

        return modules;
    }

    _validateModule(backendModule, filePath) {
        if (typeof backendModule.execute !== 'function') {
            throw new ConfigurationError(
                `Backend module ${backendModule.manifest.key} (${filePath}) must export execute()`
            );
        }
        if (typeof backendModule.classifyError !== 'function') {
            throw new ConfigurationError(
                `Backend module ${backendModule.manifest.key} (${filePath}) must export classifyError()`
            );
        }

        const optionalFunctions = [
            'init',
            'shutdown',
            'validateProviderRecord',
            'validateModelRecord',
            'discoverModels',
            'testConnection',
        ];
        for (const method of optionalFunctions) {
            if (
                method in backendModule &&
                typeof backendModule[method] !== 'function'
            ) {
                throw new ConfigurationError(
                    `Backend module ${backendModule.manifest.key}: ${method} must be a function if present`
                );
            }
        }
    }
}
