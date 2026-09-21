import { sendJson } from './core/responses.mjs';
import { readEnv, assertSignedSubjectAuthConfig } from './config/env.mjs';
import { buildConfig } from './config/app-config.mjs';
import { createLogger } from './core/logger.mjs';
import { createAppContext } from './core/app-context.mjs';
import { openDatabase, initializeSchema } from './db/sqlite-db.mjs';
import { createRouter } from './core/path-router.mjs';
import { createHttpServer } from './core/http-server.mjs';
import { requireAdmin } from './runtime/security/dashboard-auth.mjs';
import { startBackgroundJobs } from './background/scheduler.mjs';
import {
    installBackendCatalogServices,
    installExecutionServices,
    installExtensionSdkServices,
    installMiddlewareServices,
    installOAuthAdapters,
    installObservabilityServices,
    installProviderAuthServices,
    reconcileProvidersOnStartup,
    installRuntimeCoordinationServices,
    installSnapshotServices,
} from './bootstrap/service-installers.mjs';
import {
    runInitialPloinkyReconcile,
    startPloinkyDiscoveryTimer,
} from './ploinky/discovery-scheduler.mjs';
import {
    appendNewModelsToTagTiers,
    bootstrapInitialTagTiersOnce,
} from './bootstrap/reconcile-tag-tiers.mjs';
import { reconcileCompatibilityAliases } from './bootstrap/reconcile-compatibility-aliases.mjs';
import {
    FREE_DEFAULTS_BOOTSTRAP_KEY,
    FREE_PROVIDER_KEY,
    installFreeModelDefaults,
} from './bootstrap/free-model-defaults.mjs';

const FREE_TAG_JOIN_BOOTSTRAP_KEY = 'free-model-defaults-tag-tiers';

/**
 * Full boot sequence.
 * Returns { appCtx, server } on success.
 * Throws on fatal errors.
 *
 * Boot order follows the design doc §14.1:
 *  1. readEnv() and buildConfig()
 *  2. initialize logger
 *  3. open SQLite database and initialize schema
 *  4. initialize subsystem services
 *  6. register OAuth adapters and reconcile provider catalogs
 *  7. load runtime snapshot
 *  8. start background jobs
 *  9. create HTTP server and bind routes
 */
export async function bootstrap() {
    // 1. Config
    const env = readEnv();
    const config = buildConfig(env);
    const log = createLogger();

    // Fail closed unless the current Ploinky agent identity and signed-subject
    // auth are configured. readEnv() carries the PLOINKY_* fields directly;
    // buildConfig() only wraps them as config.env, so validate the env object here.
    assertSignedSubjectAuthConfig(env, { log });

    log.info('booting', { host: env.HOST, port: env.PORT });

    // 2. Database — embedded SQLite inside the agent container
    const pool = await openDatabase(env);
    const schemaResult = await initializeSchema(pool);
    log.info('sqlite database initialized', {
        path: env.SQLITE_PATH,
        ...schemaResult,
    });

    // 3. Application context
    const appCtx = createAppContext({ config, pool, log });
    await installObservabilityServices(appCtx);
    await installExecutionServices(appCtx);
    await installProviderAuthServices(appCtx);
    await installMiddlewareServices(appCtx);
    await installBackendCatalogServices(appCtx);
    await installOAuthAdapters(appCtx);
    // Reconcile discovered Ploinky agents into the provider/model catalog
    // BEFORE installSnapshotServices so the initial snapshot includes them.
    // No-ops cleanly outside Ploinky mode; never crashes startup on failure.
    await runInitialPloinkyReconcile(appCtx);
    // Free defaults are written before the catalog refresh and the first
    // snapshot, so an offline start still has every tier. A failure leaves
    // no partial records and no completion marker; the next start retries.
    try {
        await installFreeModelDefaults({ appCtx });
    } catch (err) {
        log.warn('free model defaults install failed; will retry next start', {
            error: err.message,
        });
    }
    await reconcileProvidersOnStartup(appCtx);
    try {
        const tagTiers = await bootstrapInitialTagTiersOnce({ appCtx });
        if (tagTiers.status === 'installed') {
            log.info('initial tag-tier bootstrap completed');
        }
        await joinFreeModelsToTagTiersOnce(appCtx);
    } catch (err) {
        log.warn('tag-tier bootstrap failed; will retry next start', {
            error: err.message,
        });
    }
    await reconcileCompatibilityAliases({ appCtx });
    await installSnapshotServices(appCtx);
    try {
        installExtensionSdkServices(appCtx);
    } catch (err) {
        log.warn('extension sdk init failed', { error: err.message });
    }
    installRuntimeCoordinationServices(appCtx);

    // 8. Background jobs
    const jobScheduler = startBackgroundJobs(appCtx);
    appCtx.services.jobScheduler = jobScheduler;

    // Periodic Ploinky agent discovery + reconcile (~60s). No-ops cleanly
    // outside Ploinky mode. The handle is stored for shutdown to clear.
    appCtx.services.ploinkyDiscoveryTimer = startPloinkyDiscoveryTimer(appCtx);

    // 9. Build routers
    const httpRouter = createRouter();
    const wsRouter = createRouter();

    registerCoreRoutes(httpRouter, appCtx);

    // 9b. Register public API routes
    {
        const { registerPublicApiRoutes } = await import(
            './public-api/register-routes.mjs'
        );
        registerPublicApiRoutes(httpRouter, appCtx);
        log.info('public API routes registered');
    }

    // 9c. Register management routes
    {
        const { buildManagementRouter } = await import(
            './management/build-routes.mjs'
        );
        const { httpRouter: mgmtHttp, wsRouter: mgmtWs } =
            buildManagementRouter(appCtx);
        appCtx.services.managementHttpRouter = mgmtHttp;
        appCtx.services.managementWsRouter = mgmtWs;
        log.info('management routes registered');
    }

    // 10. HTTP server
    const server = createHttpServer(appCtx, httpRouter, wsRouter);

    return { appCtx, server, httpRouter, wsRouter };
}

/**
 * Baseline models written directly by the free-defaults installer join the
 * auto tag tiers once. This also covers tag tiers created before the install
 * (a start with the free defaults disabled). The step has its own marker, so
 * a start interrupted between the install and this step redoes it, and later
 * starts never re-add models an administrator removed from a tag tier.
 */
async function joinFreeModelsToTagTiersOnce(appCtx) {
    const bootstrapStateDao = await import('./db/dao/bootstrap-state-dao.mjs');
    const pool = appCtx.pool;
    if (!(await bootstrapStateDao.isComplete(pool, FREE_DEFAULTS_BOOTSTRAP_KEY))) return;
    if (await bootstrapStateDao.isComplete(pool, FREE_TAG_JOIN_BOOTSTRAP_KEY)) return;
    // Select by provider: the startup catalog sync may already have replaced
    // the baseline rows' metadata.
    const { rows } = await pool.query(
        `SELECT m.* FROM models m
           JOIN providers p ON p.id = m.provider_id
          WHERE p.provider_key = $1
            AND m.strategy_kind = 'direct'
            AND m.enabled = 1`,
        [FREE_PROVIDER_KEY]
    );
    await appendNewModelsToTagTiers({ appCtx, models: rows });
    await bootstrapStateDao.markComplete(pool, { bootstrapKey: FREE_TAG_JOIN_BOOTSTRAP_KEY });
}

/**
 * Register routes that are always available (health, compatibility aliases).
 */
async function handleHealthFull(ctx) {
    const uptime = (Date.now() - ctx.appCtx.startedAt) / 1000;
    let dbOk = false;
    try {
        if (ctx.appCtx.pool) {
            await ctx.appCtx.pool.query('SELECT 1');
            dbOk = true;
        }
    } catch {
        /* db check failed */
    }
    sendJson(ctx.res, 200, {
        ok: true,
        db: dbOk,
        snapshotGeneration: ctx.appCtx.snapshotGeneration,
        uptimeSeconds: Math.round(uptime),
    });
}

async function handleSystemMetrics(ctx) {
    await requireAdmin(
        ctx.req,
        ctx.appCtx.config.env,
        ctx.appCtx.routerAuth || ctx.appCtx
    );
    const metrics = ctx.appCtx.services.systemMetrics.collect();
    sendJson(ctx.res, 200, metrics);
}

function registerCoreRoutes(router, appCtx) {
    router.add('GET', '/healthz', handleHealthFull);
    router.add('GET', '/healthz/', handleHealthFull);

    router.add('GET', '/management/metrics/system', handleSystemMetrics);

    router.add('GET', '/', async (ctx) => {
        ctx.res.writeHead(302, { Location: '/management' });
        ctx.res.end();
    });

    // Favicon — return 204 to stop browsers from 404-ing
    router.add('GET', '/favicon.ico', async (ctx) => {
        ctx.res.writeHead(204);
        ctx.res.end();
    });
}
