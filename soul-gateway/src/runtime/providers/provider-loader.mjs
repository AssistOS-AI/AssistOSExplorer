/**
 * ProviderLoader — scans and loads provider plugin modules.
 *
 * Scan locations (per design doc 5.7):
 *   - src/runtime/providers/builtin/*.provider.mjs  (built-in providers)
 *   - extensions/search/*.search.mjs                (custom search)
 *   - extensions/models/*.model.mjs                 (custom local models)
 *   - extensions/wrappers/*.wrapper.mjs             (custom wrappers)
 *
 * Modules must export `providerPlugin` conforming to ProviderPlugin.
 */

import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ConfigurationError } from '../../core/errors.mjs';
import { validateManifest, isDeprecatedKind } from './provider-interface.mjs';

export class ProviderLoader {
  /**
   * @param {object} deps
   * @param {string} deps.builtinDir    Absolute path to builtin/ directory
   * @param {string} [deps.extensionsDir]  Absolute path to extensions/ directory
   * @param {object} deps.log
   */
  constructor({ builtinDir, extensionsDir = null, log }) {
    this._builtinDir = builtinDir;
    this._extensionsDir = extensionsDir;
    this._log = log;
  }

  /**
   * Load all provider plugins from all scan locations.
   *
   * @returns {Promise<Array<object>>} Array of ProviderPlugin objects
   */
  async loadAll() {
    const plugins = [];

    // Built-in providers
    const builtinPlugins = await this._scanDirectory(
      this._builtinDir,
      '.provider.mjs',
    );
    plugins.push(...builtinPlugins);

    // Extension providers (if directory exists)
    if (this._extensionsDir) {
      const searchPlugins = await this._scanDirectory(
        join(this._extensionsDir, 'search'),
        '.search.mjs',
      );
      plugins.push(...searchPlugins);

      const modelPlugins = await this._scanDirectory(
        join(this._extensionsDir, 'models'),
        '.model.mjs',
      );
      plugins.push(...modelPlugins);

      const wrapperPlugins = await this._scanDirectory(
        join(this._extensionsDir, 'wrappers'),
        '.wrapper.mjs',
      );
      plugins.push(...wrapperPlugins);
    }

    this._log.info('provider_loader_complete', {
      total: plugins.length,
      keys: plugins.map((p) => p.manifest.key),
    });

    return plugins;
  }

  /**
   * Load a single plugin module from a file path.
   *
   * When a plugin declares kind='wrapper', the loader classifies it:
   *   - If the module exports hook functions (onRequest/onResponse/wrapStream),
   *     it is treated as a provider hook, not an executor.
   *   - If it only exports execute/classifyError, it is treated as an executor
   *     for backward compatibility.
   *
   * The classification is stored on plugin._wrapperClassification:
   *   'provider_hook' | 'executor' | null
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
      throw new ConfigurationError(`Module does not export providerPlugin: ${filePath}`);
    }

    validateManifest(plugin.manifest, { log: this._log });

    // Classify wrapper plugins: hook vs executor
    if (isDeprecatedKind(plugin.manifest.kind)) {
      const hasHookFunctions = (
        typeof mod.onRequest === 'function' ||
        typeof mod.onResponse === 'function' ||
        typeof mod.wrapStream === 'function' ||
        typeof plugin.onRequest === 'function' ||
        typeof plugin.onResponse === 'function' ||
        typeof plugin.wrapStream === 'function'
      );

      if (hasHookFunctions) {
        plugin._wrapperClassification = 'provider_hook';
        this._log.warn('wrapper_classified_as_provider_hook', {
          key: plugin.manifest.key,
          file: filePath,
          message: `Plugin '${plugin.manifest.key}' has kind='wrapper' and exports hook functions. ` +
            `It will be treated as a provider hook. Migrate to extensions/provider-hooks/ with the new hook contract.`,
        });
      } else {
        plugin._wrapperClassification = 'executor';
        this._log.warn('wrapper_classified_as_executor', {
          key: plugin.manifest.key,
          file: filePath,
          message: `Plugin '${plugin.manifest.key}' has kind='wrapper' but only exports execute/classifyError. ` +
            `It will be treated as an executor for backward compatibility.`,
        });
      }
    } else {
      plugin._wrapperClassification = null;
    }

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
    const requiredMethods = ['init', 'shutdown', 'execute', 'classifyError'];
    for (const method of requiredMethods) {
      if (typeof plugin[method] !== 'function') {
        throw new ConfigurationError(
          `Provider plugin ${plugin.manifest.key} (${filePath}) missing required method: ${method}`,
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
          `Provider plugin ${plugin.manifest.key}: ${method} must be a function if present`,
        );
      }
    }
  }
}
