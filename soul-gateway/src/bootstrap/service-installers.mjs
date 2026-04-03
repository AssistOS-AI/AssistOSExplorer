import { SystemMetricsStore } from '../observability/system-metrics.mjs';
import { AuditLogWriter } from '../observability/audit-log-writer.mjs';
import { BroadcastHub } from '../observability/broadcast-hub.mjs';
import { MetricsService } from '../observability/metrics-service.mjs';
import { ExportService } from '../observability/export-service.mjs';
import { ConcurrencyController } from '../runtime/execution/concurrency-controller.mjs';
import { ensureEncryptionKey } from '../runtime/security/encryption.mjs';
import { MiddlewareCatalog } from '../runtime/middleware/middleware-catalog.mjs';
import { ProviderCatalog } from '../runtime/providers/provider-catalog.mjs';
import { ProviderLoader } from '../runtime/providers/provider-loader.mjs';
import { ExecutorCatalog } from '../runtime/executors/executor-catalog.mjs';
import { adaptProviderToExecutor } from '../runtime/executors/provider-executor-adapter.mjs';
import { ProviderHookCatalog } from '../runtime/hooks/provider-hook-catalog.mjs';
import { adaptHookToMiddleware } from '../runtime/hooks/hook-adapter.mjs';
import { ExtensionLoader } from '../runtime/plugins/extension-loader.mjs';
import {
  adaptExtensionEntryToExecutor,
  adaptExtensionEntryToHook,
} from '../runtime/plugins/runtime-extension-adapters.mjs';
import { createExtensionContext } from '../runtime/providers/extension-sdk.mjs';
import { installRuntimeRefreshServices } from '../runtime/registry/runtime-refresh.mjs';
import { loadRuntimeSnapshot } from '../runtime/registry/snapshot-loader.mjs';
import * as providerContextCompacter from '../runtime/hooks/provider/builtin/provider-context-compacter.hook.mjs';
import * as providerPromptInjector from '../runtime/hooks/provider/builtin/provider-prompt-injector.hook.mjs';
import * as providerOutputCompressor from '../runtime/hooks/provider/builtin/provider-output-compressor.hook.mjs';
import * as providerResponseFilter from '../runtime/hooks/provider/builtin/provider-response-filter.hook.mjs';

const BUILTIN_PROVIDER_HOOKS = [
  providerContextCompacter,
  providerPromptInjector,
  providerOutputCompressor,
  providerResponseFilter,
];

export async function installObservabilityServices(appCtx) {
  const { config, pool, log } = appCtx;
  const { env } = config;

  const systemMetrics = new SystemMetricsStore(appCtx);
  systemMetrics.start(config.defaults.systemMetricsSampleMs);
  appCtx.services.systemMetrics = systemMetrics;

  const broadcastHub = new BroadcastHub(appCtx);
  broadcastHub.startHeartbeat(env.WS_PING_INTERVAL_MS);
  appCtx.services.broadcastHub = broadcastHub;

  const auditLogWriter = new AuditLogWriter(appCtx);
  auditLogWriter.setBroadcastHub(broadcastHub);
  appCtx.services.auditLogWriter = auditLogWriter;

  if (env.DATABASE_URL) {
    appCtx.services.metricsService = new MetricsService(pool);
    appCtx.services.exportService = new ExportService(pool, env.EXPORT_BATCH_SIZE);
  }

  log.info('observability services installed');
}

export async function installExecutionServices(appCtx) {
  const { config, log } = appCtx;
  const { env } = config;

  appCtx.services.extensionServices = Object.freeze({});
  appCtx.services.concurrencyController = new ConcurrencyController();
  appCtx.services.encryptionKey = ensureEncryptionKey(config.env);

  const { SpendCache } = await import('../runtime/policy/spend-cache.mjs');
  appCtx.services.spendCache = new SpendCache({
    ttlMs: env.SPEND_CACHE_TTL_MS,
  });

  log.info('execution services installed');
}

export async function installProviderAuthServices(appCtx) {
  const { config, pool, log } = appCtx;
  const { env } = config;

  if (!env.DATABASE_URL) {
    return;
  }

  const accountsDao = await import('../db/dao/provider-accounts-dao.mjs');
  const { AccountPool } = await import('../runtime/providers/account-pool.mjs');
  const { CredentialManager } = await import('../runtime/providers/credential-manager.mjs');
  const { OAuthManager } = await import('../runtime/providers/oauth-manager.mjs');
  const { OAuthCredentialStore } = await import('../runtime/providers/oauth/credential-store.mjs');

  const accountPool = new AccountPool({ pool, accountsDao, log });
  const oauthCredentialStore = new OAuthCredentialStore({
    baseDir: config.env.CREDENTIALS_DIR,
    encryptionKey: appCtx.services.encryptionKey,
    log,
  });
  const credentialManager = new CredentialManager({
    pool,
    accountsDao,
    accountPool,
    encryptionKey: appCtx.services.encryptionKey,
    oauthCredentialStore,
    log,
  });
  const oauthManager = new OAuthManager({
    pool,
    accountsDao,
    accountPool,
    oauthCredentialStore,
    appCtx,
    log,
  });

  appCtx.services.accountPool = accountPool;
  appCtx.services.credentialManager = credentialManager;
  appCtx.services.oauthManager = oauthManager;
  appCtx.services.oauthCredentialStore = oauthCredentialStore;

  log.info('provider auth services installed');
}

export async function installSnapshotServices(appCtx) {
  const { config, log } = appCtx;
  const { env } = config;

  appCtx.services.reloadRuntimeSnapshot = async () => {
    if (!env.DATABASE_URL) {
      return appCtx.services.snapshot || null;
    }

    const snapshot = await loadRuntimeSnapshot(appCtx);
    appCtx.services.snapshot = snapshot;
    appCtx.snapshotGeneration = snapshot.generation;
    return snapshot;
  };

  if (env.DATABASE_URL) {
    const snapshot = await appCtx.services.reloadRuntimeSnapshot();
    log.info('runtime snapshot loaded', { generation: snapshot.generation });
  }
}

export async function installMiddlewareServices(appCtx) {
  const { config, pool, log } = appCtx;
  const { env } = config;
  const builtinDir = new URL('../runtime/middleware/builtin', import.meta.url).pathname;
  const extensionsDir = config.env.EXTENSIONS_DIR || './extensions';

  if (!appCtx.services.extensionLoader) {
    appCtx.services.extensionLoader = new ExtensionLoader(extensionsDir, log);
  }

  const catalog = new MiddlewareCatalog({
    gcGraceMs: config.defaults.middlewareGenerationGcGraceMs,
    pool: env.DATABASE_URL ? pool : null,
    builtinDir,
  });

  appCtx.services.middlewareCatalog = catalog;
  appCtx.services.reloadMiddlewareCatalog = async () => {
    const nextGeneration = await catalog.rescan({
      pool: env.DATABASE_URL ? pool : null,
      builtinDir,
    });

    if (appCtx.services.extensionLoader) {
      const extCatalog = await appCtx.services.extensionLoader.scan();
      let extensionCount = 0;
      for (const ext of extCatalog.middlewares) {
        if (ext.module && ext.manifest) {
          await catalog.registerExtensionMiddleware(
            ext.manifest,
            ext.module,
            ext.checksum,
            env.DATABASE_URL ? pool : null,
          );
          extensionCount++;
        }
      }
      let gatewayHookCount = 0;
      for (const ext of extCatalog.gatewayHooks) {
        if (!ext.module || !ext.manifest) continue;
        try {
          const hook = adaptExtensionEntryToHook(ext);
          if (!hook.onRequest && !hook.onResponse) {
            log.warn('gateway hook skipped: stream-only gateway hooks are not supported by the current middleware engine', {
              key: hook.meta.key,
            });
            continue;
          }
          const middlewareLike = adaptHookToMiddleware(hook);
          middlewareLike.meta = {
            ...middlewareLike.meta,
            key: hook.meta.key,
            name: hook.meta.name,
            version: hook.meta.version,
            defaultSettings: hook.meta.defaultSettings || {},
          };
          await catalog.registerExtensionMiddleware(
            { ...ext.manifest, key: hook.meta.key, name: hook.meta.name, defaultSettings: hook.meta.defaultSettings || {} },
            middlewareLike,
            ext.checksum,
            env.DATABASE_URL ? pool : null,
          );
          gatewayHookCount++;
        } catch (err) {
          log.warn('gateway hook integration failed', { key: ext.manifest.key, error: err.message });
        }
      }
      if (extensionCount > 0) {
        log.info('extension middlewares integrated', { count: extensionCount });
      }
      if (gatewayHookCount > 0) {
        log.info('gateway hook extensions integrated', { count: gatewayHookCount });
      }
      return {
        generation: nextGeneration,
        count: catalog.size,
        extensionGeneration: extCatalog.generation,
        gatewayHookCount,
      };
    }

    return { generation: nextGeneration, count: catalog.size, extensionGeneration: null, gatewayHookCount: 0 };
  };

  const initialLoad = await appCtx.services.reloadMiddlewareCatalog();
  log.info('middleware catalog loaded', initialLoad);
}

export async function installProviderCatalogServices(appCtx) {
  const { config, log } = appCtx;
  const extensionsDir = config.env.EXTENSIONS_DIR || null;
  const builtinDir = new URL('../runtime/providers/builtin', import.meta.url).pathname;

  const providerCatalog = new ProviderCatalog({ log });
  const loader = new ProviderLoader({ builtinDir, extensionsDir, log });
  const extensionLoader = appCtx.services.extensionLoader || new ExtensionLoader(extensionsDir || './extensions', log);

  appCtx.services.providerCatalog = providerCatalog;
  appCtx.services.providerLoader = loader;
  appCtx.services.extensionLoader = extensionLoader;
  appCtx.services.executorCatalog = new ExecutorCatalog();
  appCtx.services.providerHookCatalog = new ProviderHookCatalog();
  appCtx.services.reloadProviderCatalog = async () => {
    const plugins = await loader.loadAll();
    providerCatalog.load(plugins);
    const extCatalog = await extensionLoader.scan();

    const executorCatalog = new ExecutorCatalog();
    for (const [key, plugin] of providerCatalog.getAllPlugins()) {
      executorCatalog.register(key, adaptProviderToExecutor(plugin));
    }
    for (const ext of extCatalog.executors) {
      try {
        const executor = adaptExtensionEntryToExecutor(ext);
        executorCatalog.register(executor.manifest.key, executor);
      } catch (err) {
        log.warn('executor extension integration failed', { key: ext.manifest.key, error: err.message });
      }
    }

    const providerHookCatalog = new ProviderHookCatalog();
    for (const builtinHook of BUILTIN_PROVIDER_HOOKS) {
      providerHookCatalog.registerHook(builtinHook.meta.key, builtinHook);
    }
    for (const ext of extCatalog.providerHooks) {
      try {
        const hook = adaptExtensionEntryToHook(ext);
        providerHookCatalog.registerHook(hook.meta.key, hook);
      } catch (err) {
        log.warn('provider hook integration failed', { key: ext.manifest.key, error: err.message });
      }
    }
    if (config.env.DATABASE_URL) {
      try {
        await providerHookCatalog.loadAssignments(appCtx.pool);
      } catch (err) {
        log.warn('provider hook catalog load failed (table may not exist yet)', { error: err.message });
      }
    }

    appCtx.services.executorCatalog = executorCatalog;
    appCtx.services.providerHookCatalog = providerHookCatalog;
    appCtx.services.extensionCatalog = extCatalog;

    return {
      generation: providerCatalog.generation,
      count: providerCatalog.size,
      extensionGeneration: extCatalog.generation,
      executorCount: executorCatalog.size,
      providerHookCount: providerHookCatalog.hookCount,
      assignedProviderCount: providerHookCatalog.assignedProviderCount,
    };
  };

  const providerLoad = await appCtx.services.reloadProviderCatalog();
  log.info('provider catalog loaded', providerLoad);

  if (typeof appCtx.services.reloadMiddlewareCatalog === 'function') {
    await appCtx.services.reloadMiddlewareCatalog();
  }
}

export async function installOAuthAdapters(appCtx) {
  const { log } = appCtx;
  const oauthManager = appCtx.services.oauthManager;
  if (!oauthManager) {
    return;
  }

  try {
    const { readdirSync } = await import('node:fs');
    const { join } = await import('node:path');
    const { pathToFileURL } = await import('node:url');
    const oauthDir = new URL('../runtime/providers/oauth', import.meta.url).pathname;
    const files = readdirSync(oauthDir).filter(f =>
      f.endsWith('.mjs') && f !== 'common.mjs' && f !== 'credential-store.mjs'
    );

    let registered = 0;
    for (const file of files) {
      try {
        const mod = await import(pathToFileURL(join(oauthDir, file)).href);
        const adapter = mod.oauthAdapter || mod.default;
        if (adapter?.key && typeof adapter.startFlow === 'function') {
          oauthManager.registerAdapter(adapter);
          registered++;
        }
      } catch (err) {
        log.warn('oauth adapter load failed', { file, error: err.message });
      }
    }

    log.info('oauth adapters registered', { count: registered, scanned: files.length });
  } catch (err) {
    log.warn('oauth adapter scan failed', { error: err.message });
  }
}

export function installExtensionSdkServices(appCtx) {
  appCtx.services.extensionServices = createExtensionContext(appCtx).services;
}

export function installRuntimeCoordinationServices(appCtx) {
  installRuntimeRefreshServices(appCtx);
}
