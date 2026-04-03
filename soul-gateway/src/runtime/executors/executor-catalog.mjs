/**
 * ExecutorCatalog — registry of loaded executor plugins.
 *
 * Mirrors the ProviderCatalog role but uses the new executor contract.
 * During migration both catalogs coexist; the execution engine still
 * resolves via the provider catalog.
 */

import { validateExecutorManifest } from './executor-interface.mjs';

/**
 * Maps provider adapter_key values to the protocol-family executor that handles them.
 * Copied from provider-catalog.mjs — kept in sync during migration.
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

export class ExecutorCatalog {
  constructor() {
    /** @type {Map<string, object>} */
    this._executors = new Map();
  }

  /**
   * Register an executor plugin.
   *
   * @param {string} key
   * @param {object} executorPlugin  ExecutorPlugin-compatible object
   */
  register(key, executorPlugin) {
    validateExecutorManifest(executorPlugin.manifest);
    this._executors.set(key, executorPlugin);
  }

  /**
   * Look up an executor by key, with fallback through ADAPTER_TO_PLUGIN mapping.
   *
   * @param {string} key
   * @returns {object|null} ExecutorPlugin or null
   */
  getExecutor(key) {
    return this._executors.get(key)
      || this._executors.get(ADAPTER_TO_PLUGIN[key])
      || null;
  }

  /**
   * Return all registered executor keys.
   *
   * @returns {string[]}
   */
  listKeys() {
    return [...this._executors.keys()];
  }

  /**
   * Number of registered executors.
   */
  get size() {
    return this._executors.size;
  }
}
