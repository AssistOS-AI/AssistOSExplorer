/**
 * Graceful shutdown coordinator.
 *
 * Order:
 *  1. Stop accepting new HTTP/WS connections
 *  2. Mark appCtx.draining = true
 *  3. Stop background jobs
 *  4. Close SSE and WS subscribers
 *  5. Wait for in-flight requests (up to SHUTDOWN_GRACE_MS)
 *  6. Abort remaining requests
 *  7. Flush pending audit updates
 *  8. Call shutdown() on current provider/middleware generations
 *  9. Close the SQLite database
 * 10. Exit
 */
export async function shutdown(appCtx, server, reason = 'SIGTERM') {
    const { log, config } = appCtx;
    const graceMs = config.env.SHUTDOWN_GRACE_MS;

    log.info('shutdown starting', { reason, graceMs });

    // 1-2. Stop accepting connections
    appCtx.draining = true;

    await new Promise((resolve) => {
        server.close(() => resolve());
        setTimeout(resolve, graceMs);
    });

    // 3. Stop background jobs
    if (appCtx.services.jobScheduler) {
        try {
            appCtx.services.jobScheduler.stop();
            log.info('background jobs stopped');
        } catch (err) {
            log.error('error stopping background jobs', { error: err.message });
        }
    }

    // 3b. Stop the Ploinky agent discovery timer
    if (appCtx.services.ploinkyDiscoveryTimer) {
        try {
            clearInterval(appCtx.services.ploinkyDiscoveryTimer);
            appCtx.services.ploinkyDiscoveryTimer = null;
            log.info('ploinky discovery timer stopped');
        } catch (err) {
            log.error('error stopping ploinky discovery timer', {
                error: err.message,
            });
        }
    }

    // 4. Close SSE/WS subscribers
    if (appCtx.services.broadcastHub) {
        try {
            appCtx.services.broadcastHub.stop();
            log.info('broadcast hub closed');
        } catch (err) {
            log.error('error closing broadcast hub', { error: err.message });
        }
    }

    // 5-6. Wait for in-flight requests (best-effort poll)
    if (typeof appCtx.activeRequestCount === 'number' && appCtx.activeRequestCount > 0) {
        const deadline = Date.now() + graceMs;
        while (appCtx.activeRequestCount > 0 && Date.now() < deadline) {
            await new Promise((resolve) => setTimeout(resolve, 100));
        }
        if (appCtx.activeRequestCount > 0) {
            log.warn('shutdown draining timed out', {
                remaining: appCtx.activeRequestCount,
            });
        }
    }

    // 7. Flush pending audit writes
    if (appCtx.services.auditLogWriter && typeof appCtx.services.auditLogWriter.flush === 'function') {
        try {
            await appCtx.services.auditLogWriter.flush();
            log.info('audit log writer flushed');
        } catch (err) {
            log.error('error flushing audit log writer', { error: err.message });
        }
    }

    // 8. Shutdown backend catalog
    if (appCtx.services.backendCatalog) {
        try {
            await appCtx.services.backendCatalog.shutdownAll();
            log.info('backend catalog shut down');
        } catch (err) {
            log.error('error shutting down backend catalog', { error: err.message });
        }
    }

    // 9. Close database pool
    if (appCtx.pool) {
        try {
            await appCtx.pool.end();
            log.info('database pool closed');
        } catch (err) {
            log.error('error closing db pool', { error: err.message });
        }
    }

    log.info('shutdown complete', { reason });
}
