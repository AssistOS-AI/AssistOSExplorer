import { sendJson } from './core/responses.mjs';
import { readEnv } from './config/env.mjs';
import { buildConfig } from './config/app-config.mjs';
import { createLogger } from './core/logger.mjs';
import { createAppContext } from './core/app-context.mjs';
import { createPgPool, ensureSchema } from './db/pool.mjs';
import { createRouter } from './core/path-router.mjs';
import { createHttpServer } from './core/http-server.mjs';
import { runMigrations } from './db/migrator.mjs';
import { startBackgroundJobs } from './background/scheduler.mjs';
import {
    installBackendCatalogServices,
    installBrowserPoolService,
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

/**
 * Full boot sequence.
 * Returns { appCtx, server } on success.
 * Throws on fatal errors.
 *
 * Boot order follows the design doc §14.1:
 *  1. readEnv() and buildConfig()
 *  2. initialize logger
 *  3. create PostgreSQL pool
 *  4. acquire migration lock and run migrations
 *  5. initialize subsystem services
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

    log.info('booting', { host: env.HOST, port: env.PORT });

    // 2. Database
    const pool = createPgPool(config);
    if (env.DATABASE_URL) {
        await ensureSchema(pool);
        log.info('database connected');

        // 2b. Run migrations
        const migrationsDir = new URL('./db/migrations', import.meta.url)
            .pathname;
        await runMigrations(pool, migrationsDir, log);
    } else {
        log.warn('DATABASE_URL not set — running without database');
    }

    // 3. Application context
    const appCtx = createAppContext({ config, pool, log });
    await installObservabilityServices(appCtx);
    await installExecutionServices(appCtx);
    await installProviderAuthServices(appCtx);
    await installMiddlewareServices(appCtx);
    await installBackendCatalogServices(appCtx);
    await installBrowserPoolService(appCtx);
    await installOAuthAdapters(appCtx);
    await reconcileProvidersOnStartup(appCtx);
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
 * Register routes that are always available (health, compatibility aliases).
 */
async function handleHealthFull(ctx) {
    const uptime = (Date.now() - ctx.appCtx.startedAt) / 1000;
    let dbOk = false;
    try {
        if (ctx.appCtx.pool && ctx.appCtx.config.env.DATABASE_URL) {
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

function handleSystemMetrics(ctx) {
    const metrics = ctx.appCtx.services.systemMetrics.collect();
    sendJson(ctx.res, 200, metrics);
}

function registerCoreRoutes(router, appCtx) {
    router.add('GET', '/healthz', handleHealthFull);

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
