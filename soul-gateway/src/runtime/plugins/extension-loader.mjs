import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { statSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { validateExtensionManifest } from './manifest-validator.mjs';
import { HOOK_SCOPES, HOOK_TYPES } from '../hooks/hook-constants.mjs';

/**
 * ExtensionLoader — discovers and loads extension modules from directories.
 *
 * First-class paths (recommended):
 *   extensions/gateway-hooks/*.hook.mjs   — gateway-scoped hooks
 *   extensions/provider-hooks/*.hook.mjs  — provider-scoped hooks
 *   extensions/executors/*.executor.mjs   — terminal executor extensions
 *
 * DEPRECATED legacy paths (still scanned for backward compatibility):
 *   extensions/middlewares/*.middleware.mjs  -> scope=gateway, type=hook
 *   extensions/search/*.search.mjs          -> type=executor
 *   extensions/models/*.model.mjs           -> type=executor
 *   extensions/wrappers/*.wrapper.mjs       -> scope=provider, type=hook
 *
 * The legacy 'wrappers' directory maps to provider hooks, not to executor
 * plugins. The kind='wrapper' concept is deprecated: wrapping behavior
 * belongs in provider hooks; terminal execution belongs in executors.
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
   *   scope  — 'gateway' | 'provider' (hooks only)
   *   type   — 'hook' | 'executor'
   */
  async scan() {
    this._generation++;
    const catalog = {
      generation: this._generation,
      middlewares: [],
      search: [],
      models: [],
      wrappers: [],
      gatewayHooks: [],
      providerHooks: [],
      executors: [],
    };

    // ── legacy paths (DEPRECATED — kept for backward compatibility) ──
    // New extensions should use gateway-hooks/, provider-hooks/, or executors/.
    // These paths will continue to be scanned but are not the primary model.
    const legacyKinds = [
      {
        dir: 'middlewares', suffix: '.middleware.mjs', target: 'middlewares',
        scope: HOOK_SCOPES.GATEWAY, type: HOOK_TYPES.HOOK,
      },
      {
        dir: 'search', suffix: '.search.mjs', target: 'search',
        scope: null, type: HOOK_TYPES.EXECUTOR,
      },
      {
        dir: 'models', suffix: '.model.mjs', target: 'models',
        scope: null, type: HOOK_TYPES.EXECUTOR,
      },
      // DEPRECATED: wrappers directory. Wrapping behavior is now expressed as
      // provider hooks (extensions/provider-hooks/*.hook.mjs). This path maps
      // wrappers to scope='provider', type='hook' for backward compat.
      {
        dir: 'wrappers', suffix: '.wrapper.mjs', target: 'wrappers',
        scope: HOOK_SCOPES.PROVIDER, type: HOOK_TYPES.HOOK,
      },
    ];

    for (const { dir, suffix, target, scope, type } of legacyKinds) {
      await this._scanDir(dir, suffix, target, scope, type, catalog);
    }

    // ── new paths ───────────────────────────────────────────────────
    const newKinds = [
      {
        dir: 'gateway-hooks', suffix: '.hook.mjs', target: 'gatewayHooks',
        scope: HOOK_SCOPES.GATEWAY, type: HOOK_TYPES.HOOK,
      },
      {
        dir: 'provider-hooks', suffix: '.hook.mjs', target: 'providerHooks',
        scope: HOOK_SCOPES.PROVIDER, type: HOOK_TYPES.HOOK,
      },
      {
        dir: 'executors', suffix: '.executor.mjs', target: 'executors',
        scope: null, type: HOOK_TYPES.EXECUTOR,
      },
    ];

    for (const { dir, suffix, target, scope, type } of newKinds) {
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
        const mod = await import(pathToFileURL(filePath).href + `?v=${mtime}`);
        const manifest = mod.manifest || mod.meta;

        if (!manifest) {
          this.log.warn('extension missing manifest', { file: filePath });
          continue;
        }

        validateExtensionManifest(manifest, target);

        const source = await readFile(filePath, 'utf-8');
        const checksum = createHash('sha256').update(source).digest('hex').slice(0, 16);

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

        this.log.info('extension loaded', { kind: target, key: manifest.key, file, scope, type });
      } catch (err) {
        this.log.error('extension load failed', { file: filePath, error: err.message });
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
