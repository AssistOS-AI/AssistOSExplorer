/**
 * Middleware Catalog — loads, indexes, and resolves middleware definitions
 * and their assignment plans for a given tier/model pair.
 *
 * Supports generation-based swap: in-flight requests keep their pinned
 * generation while a new one is loaded. The old generation is garbage-
 * collected after a configurable grace period.
 */

import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import * as middlewaresDao from '../../db/dao/middlewares-dao.mjs';
import { mergeMiddlewareSettings } from './settings-merge.mjs';
import { DEFAULTS } from '../../config/defaults.mjs';
import { adaptMiddlewareToHook } from '../hooks/hook-adapter.mjs';

export class MiddlewareCatalog {
  /** @type {Map<string, Object>} middleware_key -> definition */
  #definitions = new Map();

  /** @type {Map<string, { pre?: Function, post?: Function }>} middleware_key -> loaded hooks */
  #hooks = new Map();

  /** @type {Map<string, import('../hooks/hook-interface.mjs').HookModule>} middleware_key -> hook-contract view */
  #hookViews = new Map();

  /** Current generation counter — incremented on every reload. */
  #generation = 0;

  /**
   * Previous generation state kept alive for in-flight requests.
   * @type {{ definitions: Map, hooks: Map, generation: number, expireTimer: any } | null}
   */
  #previous = null;

  /** Grace period before the old generation is discarded. */
  #gcGraceMs = DEFAULTS.middlewareGenerationGcGraceMs;

  /** Remembered reload sources for hot rescans. */
  #pool = null;
  #builtinDir = null;

  constructor(gcGraceMs = DEFAULTS.middlewareGenerationGcGraceMs) {
    this.#gcGraceMs = typeof gcGraceMs === 'number'
      ? gcGraceMs
      : gcGraceMs?.gcGraceMs ?? DEFAULTS.middlewareGenerationGcGraceMs;
    this.#pool = gcGraceMs?.pool ?? null;
    this.#builtinDir = gcGraceMs?.builtinDir ?? null;
  }

  // ── Loading ──────────────────────────────────────────────────────────

  /**
   * Load all enabled middleware records from the database and register
   * their definitions in the catalog.
   */
  async loadFromDb(pool) {
    if (pool) this.#pool = pool;
    const rows = await middlewaresDao.list(pool, { enabled: true });
    for (const row of rows) {
      const definition = {
        id: row.id,
        key: row.middleware_key,
        displayName: row.display_name,
        sourceType: row.source_type,
        hookMode: row.hook_mode,
        modulePath: row.module_path,
        version: row.version,
        defaultSettings: row.default_settings || {},
        enabled: row.enabled,
        metadata: row.metadata || {},
      };
      this.#definitions.set(row.middleware_key, definition);

      if (row.module_path) {
        try {
          const version = row.updated_at
            ? new Date(row.updated_at).getTime()
            : Date.now();
          const mod = await import(pathToFileURL(row.module_path).href + `?v=${version}`);
          const hooks = {};
          if (typeof mod.pre === 'function') hooks.pre = mod.pre;
          if (typeof mod.post === 'function') hooks.post = mod.post;
          if (Object.keys(hooks).length > 0) {
            this.#hooks.set(row.middleware_key, hooks);
          }
        } catch {
          // Discovery rows may point at missing files during development rescans.
        }
      }
    }
  }

  /**
   * Scan a directory for built-in middleware modules, import them,
   * register their definitions + hooks, and upsert into the DB.
   *
   * Each module must export `meta` and optionally `pre` / `post`.
   */
  async loadBuiltins(builtinDir, pool = null) {
    if (builtinDir) this.#builtinDir = builtinDir;
    if (pool) this.#pool = pool;
    let entries;
    try {
      entries = await readdir(builtinDir);
    } catch {
      return; // directory missing — nothing to load
    }

    for (const file of entries.sort()) {
      if (!file.endsWith('.mjs')) continue;
      const fullPath = join(builtinDir, file);
      const source = await readFile(fullPath, 'utf8').catch(() => '');
      const fileChecksum = createHash('sha256').update(source).digest('hex').slice(0, 16);
      const mod = await import(pathToFileURL(fullPath).href);

      if (!mod.meta || !mod.meta.key) continue;

      const { meta } = mod;
      const hooks = {};
      if (typeof mod.pre === 'function') hooks.pre = mod.pre;
      if (typeof mod.post === 'function') hooks.post = mod.post;
      this.#hooks.set(meta.key, hooks);

      // Expose the shared hook-contract view alongside the legacy hooks.
      try {
        this.#hookViews.set(meta.key, adaptMiddlewareToHook(mod));
      } catch {
        // Non-fatal — hook view is supplementary.
      }

      const definition = {
        id: null,
        key: meta.key,
        displayName: meta.name || meta.key,
        sourceType: 'builtin',
        hookMode: meta.hooks || 'both',
        modulePath: fullPath,
        version: meta.version || '1.0.0',
        defaultSettings: meta.defaultSettings || {},
        enabled: true,
        metadata: {},
      };
      this.#definitions.set(meta.key, definition);

      // Persist to DB if pool provided
      if (pool) {
        const persisted = await middlewaresDao.upsertFromDiscovery(pool, {
          middlewareKey: meta.key,
          displayName: definition.displayName,
          sourceType: 'builtin',
          hookMode: definition.hookMode,
          modulePath: fullPath,
          version: definition.version,
          checksum: fileChecksum,
          defaultSettings: definition.defaultSettings,
          metadata: {},
        });
        definition.id = persisted.id;
      }
    }
  }

  /**
   * Register a middleware discovered by the ExtensionLoader.
   *
   * Extracts pre/post hooks from the module and registers the definition
   * in the internal maps. Optionally upserts a row in the DB so the
   * middleware appears in management listings.
   *
   * @param {object} manifest  Extension manifest (must have .key)
   * @param {object} module    Imported module (may export pre/post)
   * @param {string} checksum  Content hash of the source file
   * @param {object} [pool]    Optional PG pool for DB persistence
   */
  async registerExtensionMiddleware(manifest, module, checksum, pool = null) {
    const key = manifest.key;
    const hooks = {};
    if (typeof module.pre === 'function') hooks.pre = module.pre;
    if (typeof module.post === 'function') hooks.post = module.post;

    if (!hooks.pre && !hooks.post) return; // nothing to register

    this.#hooks.set(key, hooks);

    // Expose the shared hook-contract view alongside the legacy hooks.
    try {
      this.#hookViews.set(key, adaptMiddlewareToHook(module));
    } catch {
      // Non-fatal — hook view is supplementary.
    }

    const definition = {
      id: null,
      key,
      displayName: manifest.name || manifest.displayName || key,
      sourceType: 'custom',
      hookMode: manifest.hooks || (hooks.pre && hooks.post ? 'both' : hooks.pre ? 'pre' : 'post'),
      modulePath: manifest.filePath || `extensions/middlewares/${key}.middleware.mjs`,
      version: manifest.version || '0.0.0',
      defaultSettings: manifest.defaultSettings || {},
      enabled: true,
      metadata: { checksum: checksum || 'extension' },
    };
    this.#definitions.set(key, definition);

    // Persist to DB so the middleware appears in management
    const dbPool = pool ?? this.#pool;
    if (dbPool) {
      try {
        const persisted = await middlewaresDao.upsertFromDiscovery(dbPool, {
          middlewareKey: key,
          displayName: definition.displayName,
          sourceType: 'custom',
          hookMode: definition.hookMode,
          modulePath: definition.modulePath,
          version: definition.version,
          checksum: checksum || 'extension',
          defaultSettings: definition.defaultSettings,
          metadata: definition.metadata,
        });
        definition.id = persisted.id;
      } catch {
        // DB persistence is best-effort for extension middlewares
      }
    }
  }

  /**
   * Rebuild the catalog from its configured sources and atomically swap
   * the current generation once the new state is fully loaded.
   */
  async rescan(options = {}) {
    const pool = options.pool ?? this.#pool ?? null;
    const builtinDir = options.builtinDir ?? this.#builtinDir ?? null;

    const oldDefinitions = this.#definitions;
    const oldHooks = this.#hooks;
    const oldHookViews = this.#hookViews;
    const oldGeneration = this.#generation;

    try {
      this.#definitions = new Map();
      this.#hooks = new Map();
      this.#hookViews = new Map();

      if (pool) {
        await this.loadFromDb(pool);
      }
      if (builtinDir) {
        await this.loadBuiltins(builtinDir, pool);
      }

      this.#rotatePreviousGeneration(oldDefinitions, oldHooks, oldGeneration);
      return this.#generation;
    } catch (err) {
      this.#definitions = oldDefinitions;
      this.#hooks = oldHooks;
      this.#hookViews = oldHookViews;
      this.#generation = oldGeneration;
      throw err;
    }
  }

  // ── Lookup ───────────────────────────────────────────────────────────

  /**
   * Return the definition for a given middleware key, or null.
   * Checks current generation first, then falls back to previous.
   */
  getMiddleware(key) {
    return this.#definitions.get(key)
      || (this.#previous && this.#previous.definitions.get(key))
      || null;
  }

  /**
   * Return the loaded hook functions for a middleware key.
   */
  getHooks(key) {
    return this.#hooks.get(key)
      || (this.#previous && this.#previous.hooks.get(key))
      || null;
  }

  /**
   * Return the hook-contract view for a middleware key, or null.
   *
   * The hook view is a HookModule-compatible object generated via
   * adaptMiddlewareToHook. It exposes onRequest/onResponse/wrapStream
   * alongside the canonical meta (scope, phases, defaultSettings).
   *
   * @param {string} key
   * @returns {import('../hooks/hook-interface.mjs').HookModule | null}
   */
  getHookView(key) {
    return this.#hookViews.get(key) || null;
  }

  // ── Plan Resolution ──────────────────────────────────────────────────

  /**
   * Build an ordered middleware execution plan for a request targeting
   * a specific tier + model.
   *
   * Plan = tier-level assignments (sorted by sort_order) followed by
   *        model-level assignments (sorted by sort_order).
   *
   * Each plan entry has: { middlewareKey, hookMode, hooks, settings }.
   *
   * @param {string|null} tierId  - ID of the resolved tier (or null).
   * @param {string|null} modelId - ID of the resolved model (or null).
   * @param {Object}      snapshot - Runtime snapshot (contains middlewareAssignments).
   * @returns {Array<Object>} Ordered plan entries.
   */
  resolveAssignmentPlan(tierId, modelId, snapshot) {
    const plan = [];

    const tierAssignments = tierId
      ? (snapshot.middlewareAssignments.byTier.get(tierId) || [])
      : [];
    const modelAssignments = modelId
      ? (snapshot.middlewareAssignments.byModel.get(modelId) || [])
      : [];

    // Tier first, then model — both already sorted by sort_order in the snapshot.
    for (const assignment of [...tierAssignments, ...modelAssignments]) {
      const hooks = this.#hooks.get(assignment.middlewareKey);
      if (!hooks) continue; // no loaded module — skip silently

      const settings = mergeMiddlewareSettings(
        assignment.middlewareDefaultSettings,
        assignment.settings,
      );

      plan.push(Object.freeze({
        middlewareKey: assignment.middlewareKey,
        hookMode: assignment.hookMode,
        hooks,
        settings,
        sourceType: assignment.sourceType,
      }));
    }

    return plan;
  }

  // ── Generation Swap ──────────────────────────────────────────────────

  /**
   * Promote the current state to a new generation.
   * The previous generation is kept alive for gcGraceMs so in-flight
   * requests that pinned it can finish.
   */
  promoteGeneration() {
    const oldDefinitions = this.#definitions;
    const oldHooks = this.#hooks;
    const oldGen = this.#generation;

    this.#generation += 1;
    this.#definitions = new Map(oldDefinitions);
    this.#hooks = new Map(oldHooks);
    this.#rotatePreviousGeneration(oldDefinitions, oldHooks, oldGen);

    return this.#generation;
  }

  /** Current generation number. */
  get generation() {
    return this.#generation;
  }

  /** Number of registered middleware definitions. */
  get size() {
    return this.#definitions.size;
  }

  /** Whether a previous generation is still alive. */
  get hasPreviousGeneration() {
    return this.#previous !== null;
  }

  /**
   * Force-expire the previous generation (for shutdown / tests).
   */
  expirePreviousGeneration() {
    if (this.#previous) {
      if (this.#previous.expireTimer) clearTimeout(this.#previous.expireTimer);
      this.#previous = null;
    }
  }

  #rotatePreviousGeneration(oldDefinitions, oldHooks, oldGeneration) {
    if (this.#previous && this.#previous.expireTimer) {
      clearTimeout(this.#previous.expireTimer);
      this.#previous = null;
    }

    this.#generation = oldGeneration + 1;
    this.#previous = {
      definitions: oldDefinitions,
      hooks: oldHooks,
      generation: oldGeneration,
      expireTimer: setTimeout(() => {
        if (this.#previous && this.#previous.generation === oldGeneration) {
          this.#previous = null;
        }
      }, this.#gcGraceMs),
    };

    if (this.#previous.expireTimer.unref) {
      this.#previous.expireTimer.unref();
    }
  }
}
