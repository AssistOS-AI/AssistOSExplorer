/**
 * ExecutorCatalog — registry of loaded executor plugins.
 *
 * Mirrors the ProviderCatalog role but uses the new executor contract.
 * During migration both catalogs coexist; the execution engine still
 * resolves via the provider catalog.
 */

import { validateExecutorManifest } from './executor-interface.mjs';

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
   * Look up an executor by its registered key. Callers MUST pass
   * the canonical plugin key (which on a real provider record lives
   * in `providers.adapter_key`); legacy short-name fallbacks
   * (`nvidia` → `openai-api`, etc.) were removed once every caller
   * was migrated to pass `adapter_key` directly. The schema declares
   * `providers.adapter_key` as `text NOT NULL`, so a fallback table
   * would only mask routing bugs without serving any real provider
   * row.
   *
   * @param {string} key  e.g. `openai-api`, `anthropic-api`
   * @returns {object|null} ExecutorPlugin or null
   */
  getExecutor(key) {
    return this._executors.get(key) || null;
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
