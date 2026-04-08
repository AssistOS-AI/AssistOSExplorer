import { SystemMetricsStore } from '../observability/system-metrics.mjs';
import { AuditLogWriter } from '../observability/audit-log-writer.mjs';
import { BroadcastHub } from '../observability/broadcast-hub.mjs';
import { MetricsService } from '../observability/metrics-service.mjs';
import { ExportService } from '../observability/export-service.mjs';
import { ConcurrencyController } from '../runtime/execution/concurrency-controller.mjs';
import { ensureEncryptionKey } from '../runtime/security/encryption.mjs';
import { MiddlewareCatalog } from '../runtime/middleware/middleware-catalog.mjs';
import { ProviderMiddlewareRegistry } from '../runtime/middleware/provider-middleware-registry.mjs';
import { BackendCatalog } from '../runtime/backends/backend-catalog.mjs';
import { BackendLoader } from '../runtime/backends/backend-loader.mjs';
import { ExtensionLoader } from '../runtime/plugins/extension-loader.mjs';
import { adaptExtensionEntryToBackend } from '../runtime/plugins/runtime-extension-adapters.mjs';
import { createExtensionContext } from '../runtime/providers/extension-sdk.mjs';
import { installRuntimeRefreshServices } from '../runtime/registry/runtime-refresh.mjs';
import { loadRuntimeSnapshot } from '../runtime/registry/snapshot-loader.mjs';

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
        appCtx.services.exportService = new ExportService(
            pool,
            env.EXPORT_BATCH_SIZE
        );
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
    const providersDao = await import('../db/dao/providers-dao.mjs');
    const { AccountPool } = await import(
        '../runtime/providers/account-pool.mjs'
    );
    const { CredentialManager } = await import(
        '../runtime/providers/credential-manager.mjs'
    );
    const { OAuthManager } = await import(
        '../runtime/providers/oauth-manager.mjs'
    );
    const { OAuthCredentialStore } = await import(
        '../runtime/providers/oauth/credential-store.mjs'
    );

    const accountPool = new AccountPool({ pool, accountsDao, log });
    const oauthCredentialStore = new OAuthCredentialStore({
        baseDir: config.env.CREDENTIALS_DIR,
        encryptionKey: appCtx.services.encryptionKey,
        log,
    });
    // OAuthManager must be constructed before CredentialManager so the
    // latter can dispatch inline refreshes through it on token expiry.
    const oauthManager = new OAuthManager({
        pool,
        accountsDao,
        accountPool,
        oauthCredentialStore,
        appCtx,
        log,
    });
    const credentialManager = new CredentialManager({
        pool,
        accountsDao,
        accountPool,
        encryptionKey: appCtx.services.encryptionKey,
        oauthCredentialStore,
        oauthManager,
        providersDao,
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
        log.info('runtime snapshot loaded', {
            generation: snapshot.generation,
        });
    }
}

export async function installMiddlewareServices(appCtx) {
    const { config, pool, log } = appCtx;
    const { env } = config;
    const builtinDir = new URL('../runtime/middleware/builtin', import.meta.url)
        .pathname;
    const extensionsDir = config.env.EXTENSIONS_DIR || './extensions';

    if (!appCtx.services.extensionLoader) {
        appCtx.services.extensionLoader = new ExtensionLoader(
            extensionsDir,
            log
        );
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
                        env.DATABASE_URL ? pool : null
                    );
                    extensionCount++;
                }
            }
            if (extensionCount > 0) {
                log.info('extension middlewares integrated', {
                    count: extensionCount,
                });
            }
            return {
                generation: nextGeneration,
                count: catalog.size,
                extensionGeneration: extCatalog.generation,
            };
        }

        return {
            generation: nextGeneration,
            count: catalog.size,
            extensionGeneration: null,
        };
    };

    const initialLoad = await appCtx.services.reloadMiddlewareCatalog();
    log.info('middleware catalog loaded', initialLoad);
}

/**
 * Install the unified backend catalog and the provider middleware
 * registry.
 *
 * This installer owns:
 *
 *   - `backendCatalog` — single registry of BackendModule objects
 *     keyed by manifest key.  Both the request hot path
 *     (`backendDispatchMiddleware` -> `getTerminal(key)`) and
 *     lifecycle/admin operations (`testConnection`, `discoverModels`,
 *     `getTemplates`) read from this one catalog.  At register time
 *     each module's `execute()` is wrapped once into a kernel terminal
 *     middleware via `createBackendTerminal` so the dispatch path has
 *     no per-request adapter step.
 *   - `providerMiddlewareRegistry` — native `(ctx, next)` provider-
 *     scope middlewares.  Built-ins are loaded at startup; extension
 *     modules are registered into the same registry on every reload.
 */
export async function installBackendCatalogServices(appCtx) {
    const { config, log } = appCtx;
    const extensionsDir = config.env.EXTENSIONS_DIR || null;
    const builtinDir = new URL('../runtime/backends/builtin', import.meta.url)
        .pathname;

    const backendCatalog = new BackendCatalog({ log });
    const loader = new BackendLoader({ builtinDir, log });
    const extensionLoader =
        appCtx.services.extensionLoader ||
        new ExtensionLoader(extensionsDir || './extensions', log);

    appCtx.services.backendCatalog = backendCatalog;
    appCtx.services.backendLoader = loader;
    appCtx.services.extensionLoader = extensionLoader;
    // Native provider middleware registry. Built-ins are loaded here;
    // extension modules are registered on reload inside
    // reloadBackendCatalog below.
    appCtx.services.providerMiddlewareRegistry =
        new ProviderMiddlewareRegistry().loadBuiltins();
    appCtx.services.reloadBackendCatalog = async () => {
        const builtinModules = await loader.loadAll();
        backendCatalog.load(builtinModules);
        const extCatalog = await extensionLoader.scan();

        // Merge extension-shipped backend modules into the current
        // generation.  These do not increment the generation — they are
        // additive on top of the built-in modules just registered above.
        for (const ext of extCatalog.backends) {
            try {
                const extensionModule = adaptExtensionEntryToBackend(ext);
                backendCatalog.registerExtension(extensionModule);
            } catch (err) {
                log.warn('backend extension integration failed', {
                    key: ext.manifest?.key,
                    error: err.message,
                });
            }
        }

        // Register extension-shipped provider middlewares into the
        // native registry.
        const registry = appCtx.services.providerMiddlewareRegistry;
        let extensionProviderCount = 0;
        for (const ext of extCatalog.providerMiddlewares) {
            try {
                const mod = ext.module || {};
                if (typeof mod.factory !== 'function' || !mod.meta?.key) {
                    throw new Error(
                        'provider middleware extensions must export meta.key and factory()'
                    );
                }
                registry.register(mod);
                extensionProviderCount++;
            } catch (err) {
                log.warn('provider middleware extension integration failed', {
                    key: ext.manifest?.key,
                    error: err.message,
                });
            }
        }

        appCtx.services.extensionCatalog = extCatalog;

        return {
            generation: backendCatalog.generation,
            count: backendCatalog.size,
            extensionGeneration: extCatalog.generation,
            backendCount: backendCatalog.size,
            providerMiddlewareCount: registry.size,
            extensionProviderMiddlewareCount: extensionProviderCount,
        };
    };

    const backendLoad = await appCtx.services.reloadBackendCatalog();
    log.info('backend catalog loaded', backendLoad);

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
        const oauthDir = new URL('../runtime/providers/oauth', import.meta.url)
            .pathname;
        const files = readdirSync(oauthDir).filter(
            (f) =>
                f.endsWith('.mjs') &&
                f !== 'common.mjs' &&
                f !== 'credential-store.mjs'
        );

        let registered = 0;
        for (const file of files) {
            try {
                const mod = await import(
                    pathToFileURL(join(oauthDir, file)).href
                );
                const adapter = mod.oauthAdapter || mod.default;
                if (adapter?.key && typeof adapter.startFlow === 'function') {
                    oauthManager.registerAdapter(adapter);
                    registered++;
                }
            } catch (err) {
                log.warn('oauth adapter load failed', {
                    file,
                    error: err.message,
                });
            }
        }

        log.info('oauth adapters registered', {
            count: registered,
            scanned: files.length,
        });
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
