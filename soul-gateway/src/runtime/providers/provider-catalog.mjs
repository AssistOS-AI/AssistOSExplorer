/**
 * ProviderCatalog — registry of loaded provider plugins.
 *
 * Supports generation-based hot reload: a new catalog generation can be
 * assembled and swapped in atomically while in-flight requests continue
 * using the old generation.
 */

import { validateManifest } from './provider-interface.mjs';
import { createProviderContext } from './provider-context.mjs';
import { withProviderFieldAliases } from './record-aliases.mjs';

/**
 * Maps provider adapter_key values to the protocol-family plugin that handles them.
 * Providers like nvidia, mistral, openrouter all use OpenAI-compatible APIs.
 */
const ADAPTER_TO_PLUGIN = Object.freeze({
  openai: 'openai-api',
  nvidia: 'openai-api',
  mistral: 'openai-api',
  openrouter: 'openai-api',
  anthropic: 'anthropic-api',
  copilot: 'copilot-api',
  axiologic_kiro: 'kiro-api',
  kiro: 'kiro-api',
  codex: 'codex-api',
  gemini: 'gemini-openai',
  search: 'search-builtin',
});

export class ProviderCatalog {
  constructor({ log }) {
    this._log = log;
    /** Current generation number. */
    this._generation = 0;
    /** Map<providerKey, ProviderPlugin> — current generation. */
    this._plugins = new Map();
    /** Map<generation, { plugins: Map, inflightCount: number }> — old generations being drained. */
    this._oldGenerations = new Map();
  }

  /**
   * Load a set of provider plugins, incrementing the generation.
   *
   * @param {Array<object>} plugins  Array of ProviderPlugin objects
   */
  load(plugins) {
    const newGen = this._generation + 1;
    const newMap = new Map();

    for (const plugin of plugins) {
      validateManifest(plugin.manifest);
      const key = plugin.manifest.key;
      if (newMap.has(key)) {
        throw new Error(`Duplicate provider key in catalog: ${key}`);
      }
      newMap.set(key, plugin);
    }

    // Move current generation to old generations (if it has plugins)
    if (this._plugins.size > 0) {
      this._oldGenerations.set(this._generation, {
        plugins: this._plugins,
        inflightCount: 0,
      });
    }

    this._plugins = newMap;
    this._generation = newGen;

    this._log.info('provider_catalog_loaded', {
      generation: newGen,
      pluginCount: newMap.size,
      keys: [...newMap.keys()],
    });
  }

  /**
   * Get a plugin by provider adapter key.
   * Falls back to protocol-family mapping for providers that use standard protocols
   * (e.g., nvidia -> openai-api, mistral -> openai-api, openrouter -> openai-api).
   *
   * @param {string} providerKey
   * @returns {object|null} ProviderPlugin or null
   */
  getPlugin(providerKey) {
    return this._plugins.get(providerKey)
      || this._plugins.get(ADAPTER_TO_PLUGIN[providerKey])
      || null;
  }

  /**
   * Get all loaded plugins.
   *
   * @returns {Map<string, object>}
   */
  getAllPlugins() {
    return new Map(this._plugins);
  }

  /**
   * List all registered provider keys.
   *
   * @returns {string[]}
   */
  listKeys() {
    return [...this._plugins.keys()];
  }

  /**
   * Current catalog generation number.
   */
  get generation() {
    return this._generation;
  }

  /**
   * Number of plugins in the current generation.
   */
  get size() {
    return this._plugins.size;
  }

  /**
   * Increment in-flight count for the current generation.
   * Called when a request starts using a plugin.
   *
   * @returns {number} The generation number the request is using
   */
  acquireGeneration() {
    return this._generation;
  }

  /**
   * Decrement in-flight count for a generation.
   * If an old generation reaches zero, its plugins can be shutdown.
   *
   * @param {number} generation
   */
  releaseGeneration(generation) {
    if (generation === this._generation) return;

    const old = this._oldGenerations.get(generation);
    if (!old) return;

    old.inflightCount = Math.max(0, old.inflightCount - 1);

    if (old.inflightCount <= 0) {
      // Shutdown old plugins
      for (const [key, plugin] of old.plugins) {
        if (typeof plugin.shutdown === 'function') {
          plugin.shutdown().catch((err) => {
            this._log.error('old_plugin_shutdown_failed', { key, error: err.message });
          });
        }
      }
      this._oldGenerations.delete(generation);
      this._log.info('old_generation_cleaned', { generation });
    }
  }

  /**
   * Return built-in provider templates (manifests with metadata).
   *
   * @returns {object} key -> template info
   */
  getTemplates() {
    const templates = {};
    for (const [key, plugin] of this._plugins) {
      templates[key] = {
        key: plugin.manifest.key,
        adapter_key: plugin.manifest.key,
        kind: plugin.manifest.kind,
        display_name: plugin.manifest.displayName || key,
        auth_strategy: plugin.manifest.authStrategy || 'api_key',
        auth_type: plugin.manifest.authStrategy === 'oauth' ? 'managed' : 'api_key',
        oauth_adapter_key: plugin.manifest.oauthAdapterKey || null,
        base_url: plugin.manifest.defaultBaseUrl || null,
        supports_streaming: plugin.manifest.supportsStreaming ?? true,
        supports_tools: plugin.manifest.supportsTools ?? true,
        supported_formats: plugin.manifest.supportedFormats || ['openai_chat'],
      };
    }
    return templates;
  }

  /**
   * Test connectivity for a provider record via its plugin.
   *
   * @param {object} providerRecord
   * @returns {Promise<{ok: boolean, detail: any}>}
   */
  async testConnection(providerRecord, options = {}) {
    const target = this._resolveLifecycleTarget(providerRecord, options);
    if (!target || typeof target.testConnection !== 'function') {
      return { ok: false, detail: 'Provider plugin not loaded or does not support testConnection' };
    }

    const providerCtx = await this._buildProviderLifecycleContext(providerRecord, options);
    try {
      return target.testConnection(providerCtx);
    } finally {
      this._releaseLifecycleLease(providerCtx.credentialLease, options);
    }
  }

  /**
   * Discover models for a provider record via its plugin.
   *
   * @param {object} providerRecord
   * @returns {Promise<Array>}
   */
  async discoverModels(providerRecord, options = {}) {
    const target = this._resolveLifecycleTarget(providerRecord, options);
    if (!target || typeof target.discoverModels !== 'function') {
      return [];
    }

    const providerCtx = await this._buildProviderLifecycleContext(providerRecord, options);
    try {
      return target.discoverModels(providerCtx);
    } finally {
      this._releaseLifecycleLease(providerCtx.credentialLease, options);
    }
  }

  /**
   * Shutdown all plugins in the current generation.
   * Called during graceful server shutdown.
   */
  async shutdownAll() {
    const shutdowns = [];
    for (const [key, plugin] of this._plugins) {
      if (typeof plugin.shutdown === 'function') {
        shutdowns.push(
          plugin.shutdown().catch((err) => {
            this._log.error('plugin_shutdown_failed', { key, error: err.message });
          }),
        );
      }
    }
    await Promise.allSettled(shutdowns);
    this._plugins.clear();

    // Also shutdown any remaining old generations
    for (const [gen, old] of this._oldGenerations) {
      for (const [key, plugin] of old.plugins) {
        if (typeof plugin.shutdown === 'function') {
          await plugin.shutdown().catch(() => {});
        }
      }
    }
    this._oldGenerations.clear();
  }

  async _buildProviderLifecycleContext(providerRecord, options = {}) {
    const credentialManager = options.credentialManager || null;
    const normalizedProvider = withProviderFieldAliases(providerRecord);
    let credentialLease = null;

    if (credentialManager && normalizedProvider?.id) {
      credentialLease = await credentialManager.getCredentials(normalizedProvider.id);
    }

    return createProviderContext({
      requestId: null,
      request: {},
      resolvedModel: null,
      providerRecord: normalizedProvider,
      credentialLease,
      signal: options.signal || AbortSignal.timeout?.(10_000),
      logger: options.logger || this._log,
      services: options.services || Object.freeze({}),
    });
  }

  _releaseLifecycleLease(credentialLease, options = {}) {
    const credentialManager = options.credentialManager || null;
    if (credentialLease && credentialManager) {
      credentialManager.release(credentialLease);
    }
  }

  _resolveLifecycleTarget(providerRecord, options = {}) {
    const normalizedProvider = withProviderFieldAliases(providerRecord);
    const key = normalizedProvider.adapterKey || normalizedProvider.providerKey || normalizedProvider.name;
    const plugin = this.getPlugin(key);
    if (plugin) {
      return plugin;
    }

    if (normalizedProvider.providerMode === 'custom' && options.executorCatalog) {
      return options.executorCatalog.getExecutor(normalizedProvider.executorKey || key);
    }

    return null;
  }
}
