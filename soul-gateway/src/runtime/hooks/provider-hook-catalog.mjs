/**
 * ProviderHookCatalog — registry of provider-scoped hook modules and
 * their per-provider assignments.
 *
 * Hook modules are registered at startup (from built-ins or extensions).
 * Assignments are loaded from the database and group hook instances by
 * provider ID and phase.
 *
 * The catalog exposes a `getProviderPipeline(providerId)` method that
 * returns the sorted hook arrays for each phase, ready for the
 * provider-hook-engine to execute.
 */

import * as dao from '../../db/dao/provider-hook-assignments-dao.mjs';

export class ProviderHookCatalog {
  constructor() {
    /** @type {Map<string, import('./hook-interface.mjs').HookModule>} hook_key -> HookModule */
    this._hooks = new Map();

    /**
     * provider_id -> { request: Assignment[], stream: Assignment[], response: Assignment[] }
     * Each Assignment has { hookKey, sortOrder, enabled, settings }.
     * @type {Map<string, { request: Array, stream: Array, response: Array }>}
     */
    this._assignments = new Map();
  }

  /**
   * Register a hook module that can be assigned to providers.
   *
   * @param {string} key
   * @param {import('./hook-interface.mjs').HookModule} hookModule
   */
  registerHook(key, hookModule) {
    this._hooks.set(key, hookModule);
  }

  /**
   * Return a registered hook module by key.
   *
   * @param {string} key
   * @returns {import('./hook-interface.mjs').HookModule | null}
   */
  getHook(key) {
    return this._hooks.get(key) || null;
  }

  /**
   * Return all registered hook keys.
   *
   * @returns {string[]}
   */
  listHookKeys() {
    return [...this._hooks.keys()];
  }

  /**
   * Load all provider_hook_assignments from the database and group
   * them by provider_id and phase.
   *
   * @param {import('pg').Pool} pool
   */
  async loadAssignments(pool) {
    this._assignments.clear();

    const { rows } = await pool.query(
      `SELECT * FROM soul_gateway.provider_hook_assignments
       WHERE enabled = true
       ORDER BY provider_id, phase, sort_order ASC`,
    );

    for (const row of rows) {
      const pid = row.provider_id;
      if (!this._assignments.has(pid)) {
        this._assignments.set(pid, { request: [], stream: [], response: [] });
      }
      const bucket = this._assignments.get(pid);
      const phase = row.phase; // 'request' | 'stream' | 'response'
      if (bucket[phase]) {
        bucket[phase].push({
          id: row.id,
          hookKey: row.hook_key,
          phase,
          sortOrder: row.sort_order,
          enabled: row.enabled,
          settings: row.settings || {},
        });
      }
    }
  }

  /**
   * Manually set assignments for a provider (useful for testing or
   * in-memory-only mode without a database).
   *
   * @param {string} providerId
   * @param {{ request?: Array, stream?: Array, response?: Array }} assignments
   */
  setAssignments(providerId, assignments) {
    const normalize = (phase, items = []) => items.map((item) => ({
      ...item,
      phase: item.phase || phase,
    }));

    this._assignments.set(providerId, {
      request: normalize('request', assignments.request || []),
      stream: normalize('stream', assignments.stream || []),
      response: normalize('response', assignments.response || []),
    });
  }

  /**
   * Returns the provider pipeline — resolved hook modules sorted by
   * sort_order for each phase.
   *
   * @param {string} providerId
   * @returns {{ request: Array<object>, stream: Array<object>, response: Array<object> } | null}
   */
  getProviderPipeline(providerId) {
    const bucket = this._assignments.get(providerId);
    if (!bucket) return null;

    const resolve = (assignments) => {
      const resolved = [];
      for (const a of assignments) {
        const hook = this._hooks.get(a.hookKey);
        if (hook) {
          resolved.push(Object.freeze({
            assignmentId: a.id ?? null,
            hookKey: a.hookKey,
            phase: a.phase ?? null,
            sortOrder: a.sortOrder ?? 100,
            hook,
            settings: Object.freeze({
              ...(hook.meta.defaultSettings || {}),
              ...(a.settings || {}),
            }),
          }));
        }
      }
      return resolved;
    };

    const request = resolve(bucket.request);
    const stream = resolve(bucket.stream);
    const response = resolve(bucket.response);

    if (request.length === 0 && stream.length === 0 && response.length === 0) {
      return null;
    }

    return { request, stream, response };
  }

  /**
   * Number of registered hook modules.
   */
  get hookCount() {
    return this._hooks.size;
  }

  /**
   * Number of providers with at least one assignment.
   */
  get assignedProviderCount() {
    return this._assignments.size;
  }
}
