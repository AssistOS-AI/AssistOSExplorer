/**
 * Background job scheduler.
 * Each job is a named interval that runs a function periodically.
 */
export function startBackgroundJobs(appCtx) {
    const jobs = [];
    const { config, log } = appCtx;
    const env = config.env;

    function schedule(name, intervalMs, fn) {
        let running = false;
        const timer = setInterval(async () => {
            if (running) {
                log.warn(`skipping overlapping ${name}`);
                return;
            }
            running = true;
            try {
                await fn();
            } catch (err) {
                log.error(`background job failed: ${name}`, {
                    error: err.message,
                });
            } finally {
                running = false;
            }
        }, intervalMs);
        timer.unref();
        jobs.push({ name, timer });
        log.info('background job started', { name, intervalMs });
    }

    // Cooldown cleanup — every minute
    schedule('cooldown-cleanup', 60_000, async () => {
        if (!appCtx.pool) return;
        const { deleteExpired } = await import('../db/dao/cooldowns-dao.mjs');
        await deleteExpired(appCtx.pool);
    });

    // Partition maintenance — hourly
    schedule(
        'partition-maintenance',
        env.PARTITION_JOB_INTERVAL_MS,
        async () => {
            if (!appCtx.pool) return;
            const { ensurePartition, dropExpiredPartitions } = await import(
                '../db/dao/audit-logs-dao.mjs'
            );
            const now = new Date();
            for (let d = 0; d <= env.PARTITION_AHEAD_DAYS; d++) {
                const date = new Date(now);
                date.setUTCDate(date.getUTCDate() + d);
                await ensurePartition(appCtx.pool, date);
            }
            const cutoff = new Date();
            cutoff.setUTCDate(cutoff.getUTCDate() - env.LOG_RETENTION_DAYS);
            await dropExpiredPartitions(appCtx.pool, cutoff);
        }
    );

    // Token refresh — proactively refresh expiring OAuth tokens
    schedule(
        'token-refresh',
        env.TOKEN_REFRESH_INTERVAL_MS || 60_000,
        async () => {
            if (!appCtx.pool) return;
            if (!appCtx.services.oauthManager) return;
            const { listExpiringOAuth } = await import(
                '../db/dao/provider-accounts-dao.mjs'
            );
            const expiring = await listExpiringOAuth(appCtx.pool);
            for (const account of expiring) {
                try {
                    await appCtx.services.oauthManager.refreshTokens(
                        account.id,
                        account.oauth_adapter_key
                    );
                } catch (err) {
                    log.warn('token refresh failed for account', {
                        accountId: account.id,
                        error: err.message,
                    });
                }
            }
        }
    );

    // Quota reset sweep — reactivate accounts whose quota period has elapsed
    schedule(
        'quota-reset-sweep',
        env.QUOTA_RESET_SWEEP_MS || 300_000,
        async () => {
            if (!appCtx.pool) return;
            const { sweepExpiredQuotas } = await import(
                '../db/dao/provider-accounts-dao.mjs'
            );
            const restored = await sweepExpiredQuotas(appCtx.pool);
            const accountPool = appCtx.services.accountPool;
            let cleared = 0;
            let purged = 0;

            if (accountPool) {
                if (restored.length > 0) {
                    cleared = accountPool.clearExhaustions(
                        restored.map((row) => row.id)
                    );
                }
                purged = accountPool.purgeExpiredExhaustions();
            }

            if (restored.length > 0) {
                log.info('quota reset sweep restored accounts', {
                    count: restored.length,
                    clearedInMemory: cleared,
                    purgedExpired: purged,
                });
            }
        }
    );

    // Spend cache cleanup — evict stale entries every 30 minutes
    schedule('spend-cache-cleanup', 30 * 60_000, async () => {
        if (typeof appCtx.services.spendCache?.cleanup === 'function') {
            appCtx.services.spendCache.cleanup();
        }
    });

    const providerModelRefreshIntervalMs =
        env.PROVIDER_MODEL_REFRESH_INTERVAL_MS ?? 900_000;
    if (providerModelRefreshIntervalMs > 0) {
        schedule(
            'provider-model-refresh',
            providerModelRefreshIntervalMs,
            async () => {
                if (!appCtx.pool) return;
                if (!appCtx.services.backendCatalog) return;
                try {
                    const { refreshProviderModelCatalog } = await import(
                        '../runtime/providers/provider-catalog-refresh.mjs'
                    );
                    await refreshProviderModelCatalog(appCtx, {
                        phase: 'timer',
                        discoverySource: 'synced',
                        disableMissing: true,
                        refreshReason: 'provider.timer-refresh',
                        skipEmptyExistingCatalog: true,
                    });
                } catch (err) {
                    log.warn('provider model refresh failed', {
                        phase: 'timer',
                        error: err.message,
                    });
                }
            }
        );
    }

    return {
        stop() {
            for (const { name, timer } of jobs) {
                clearInterval(timer);
                log.info('background job stopped', { name });
            }
            jobs.length = 0;
        },
    };
}
