/**
 * ProviderLoader — scans and loads provider plugin modules.
 *
 * Scan locations:
 *   - src/runtime/providers/builtin/*.provider.mjs  (built-in providers)
 *
 * Modules must export `providerPlugin` conforming to ProviderPlugin.
 */

import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ConfigurationError } from '../../core/errors.mjs';
import { validateManifest } from './provider-interface.mjs';

export class ProviderLoader {
    /**
     * @param {object} deps
     * @param {string} deps.builtinDir    Absolute path to builtin/ directory
     * @param {string} [deps.extensionsDir]  Reserved for future use
     * @param {object} deps.log
     */
    constructor({ builtinDir, extensionsDir = null, log }) {
        this._builtinDir = builtinDir;
        this._extensionsDir = extensionsDir;
        this._log = log;
    }

    /**
     * Load all built-in provider plugins.
     *
     * @returns {Promise<Array<object>>} Array of ProviderPlugin objects
     */
    async loadAll() {
        const plugins = await this._scanDirectory(
            this._builtinDir,
            '.provider.mjs'
        );

        this._log.info('provider_loader_complete', {
            total: plugins.length,
            keys: plugins.map((p) => p.manifest.key),
        });

        return plugins;
    }

    /**
     * Load a single plugin module from a file path.
     *
     * @param {string} filePath  Absolute path to the .mjs file
     * @returns {Promise<object>} ProviderPlugin
     */
    async loadPlugin(filePath) {
        // Cache-bust by appending mtime
        const mtime = statSync(filePath).mtimeMs;
        const url = pathToFileURL(filePath).href + '?v=' + mtime;

        const mod = await import(url);
        const plugin = mod.providerPlugin || mod.default?.providerPlugin;

        if (!plugin) {
            throw new ConfigurationError(
                `Module does not export providerPlugin: ${filePath}`
            );
        }

        validateManifest(plugin.manifest, { log: this._log });
        this._validatePlugin(plugin, filePath);

        return plugin;
    }

    // ── Internal ────────────────────────────────────────────────────────

    /**
     * Scan a directory for files matching a suffix and load them.
     *
     * @param {string} dir     Directory path
     * @param {string} suffix  File suffix to match (e.g. '.provider.mjs')
     * @returns {Promise<Array<object>>}
     */
    async _scanDirectory(dir, suffix) {
        const plugins = [];

        let entries;
        try {
            entries = readdirSync(dir);
        } catch (err) {
            if (err.code === 'ENOENT') {
                // Directory doesn't exist — not an error
                return plugins;
            }
            throw err;
        }

        for (const entry of entries) {
            if (!entry.endsWith(suffix)) continue;

            const filePath = join(dir, entry);
            try {
                const stat = statSync(filePath);
                if (!stat.isFile()) continue;

                const plugin = await this.loadPlugin(filePath);
                plugins.push(plugin);

                this._log.info('provider_plugin_loaded', {
                    key: plugin.manifest.key,
                    kind: plugin.manifest.kind,
                    file: entry,
                });
            } catch (err) {
                this._log.error('provider_plugin_load_failed', {
                    file: entry,
                    error: err.message,
                });
            }
        }

        return plugins;
    }

    /**
     * Validate that a plugin has the required methods.
     *
     * @param {object} plugin
     * @param {string} filePath
     */
    _validatePlugin(plugin, filePath) {
        const requiredMethods = [
            'init',
            'shutdown',
            'execute',
            'classifyError',
        ];
        for (const method of requiredMethods) {
            if (typeof plugin[method] !== 'function') {
                throw new ConfigurationError(
                    `Provider plugin ${plugin.manifest.key} (${filePath}) missing required method: ${method}`
                );
            }
        }

        // Optional methods — validate type if present
        const optionalFunctions = [
            'validateProviderRecord',
            'validateModelRecord',
            'discoverModels',
            'testConnection',
        ];
        for (const method of optionalFunctions) {
            if (method in plugin && typeof plugin[method] !== 'function') {
                throw new ConfigurationError(
                    `Provider plugin ${plugin.manifest.key}: ${method} must be a function if present`
                );
            }
        }
    }
}
