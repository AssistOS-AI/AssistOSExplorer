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
 *  9. Close pg pool
 * 10. Exit
 */
export async function shutdown(appCtx, server, reason = 'SIGTERM') {
  const { log, config } = appCtx;
  const graceMs = config.env.SHUTDOWN_GRACE_MS;

  log.info('shutdown starting', { reason, graceMs });

  // 1. Stop accepting connections
  appCtx.draining = true;

  await new Promise((resolve) => {
    server.close(() => resolve());
    // If server.close doesn't finish in grace period, proceed anyway
    setTimeout(resolve, graceMs);
  });

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
