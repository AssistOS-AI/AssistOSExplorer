import { afterEach, describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';

describe('background scheduler provider model refresh', () => {
    const restorers = [];

    afterEach(() => {
        while (restorers.length) {
            restorers.pop().restore();
        }
    });

    function installTimerMocks() {
        const scheduled = [];
        restorers.push(
            mock.method(globalThis, 'setInterval', (fn, intervalMs) => {
                const timer = {
                    fn,
                    intervalMs,
                    unrefCalled: false,
                    unref() {
                        this.unrefCalled = true;
                    },
                };
                scheduled.push(timer);
                return timer;
            }).mock
        );
        restorers.push(
            mock.method(globalThis, 'clearInterval', () => {}).mock
        );
        return scheduled;
    }

    function installProviderRefreshMock(calls, implementation) {
        restorers.push(
            mock.module('../../runtime/providers/provider-catalog-refresh.mjs', {
                namedExports: {
                    async refreshProviderModelCatalog(appCtx, options) {
                        if (implementation) {
                            await implementation(appCtx, options);
                        }
                        calls.push({ appCtx, options });
                    },
                },
            })
        );
    }

    function createAppCtx(env) {
        const logs = [];
        return {
            pool: {},
            config: { env },
            services: {
                backendCatalog: {},
                spendCache: { cleanup() {} },
            },
            log: {
                info(msg, meta) {
                    logs.push({ level: 'info', msg, meta });
                },
                warn(msg, meta) {
                    logs.push({ level: 'warn', msg, meta });
                },
                error(msg, meta) {
                    logs.push({ level: 'error', msg, meta });
                },
            },
            _logs: logs,
        };
    }

    function findProviderJob(appCtx, scheduled) {
        const startedJobs = appCtx._logs.filter(
            (entry) => entry.msg === 'background job started'
        );
        const providerJobIndex = startedJobs.findIndex(
            (entry) => entry.meta.name === 'provider-model-refresh'
        );
        return {
            providerJob: startedJobs[providerJobIndex],
            providerTimer: scheduled[providerJobIndex],
        };
    }

    it('starts provider-model-refresh at the default interval and calls refresh with timer options', async () => {
        const scheduled = installTimerMocks();
        const refreshCalls = [];
        installProviderRefreshMock(refreshCalls);
        const { startBackgroundJobs } = await import(
            `../../background/scheduler.mjs?mock=${Date.now()}${Math.random()}`
        );
        const appCtx = createAppCtx({
            PARTITION_JOB_INTERVAL_MS: 3_600_000,
            PARTITION_AHEAD_DAYS: 1,
            LOG_RETENTION_DAYS: 1,
            TOKEN_REFRESH_INTERVAL_MS: 60_000,
            QUOTA_RESET_SWEEP_MS: 300_000,
        });

        const scheduler = startBackgroundJobs(appCtx);
        const { providerJob, providerTimer } = findProviderJob(
            appCtx,
            scheduled
        );

        assert.ok(providerJob);
        assert.equal(providerJob.meta.intervalMs, 900_000);
        assert.ok(providerTimer);
        await providerTimer.fn();
        assert.equal(refreshCalls.length, 1);
        assert.equal(refreshCalls[0].appCtx, appCtx);
        assert.deepEqual(refreshCalls[0].options, {
            phase: 'timer',
            discoverySource: 'synced',
            disableMissing: true,
            refreshReason: 'provider.timer-refresh',
            skipEmptyExistingCatalog: true,
        });
        scheduler.stop();
    });

    it('logs a warning and swallows provider-model-refresh failures', async () => {
        const scheduled = installTimerMocks();
        const refreshCalls = [];
        installProviderRefreshMock(refreshCalls, async () => {
            throw new Error('refresh boom');
        });
        const { startBackgroundJobs } = await import(
            `../../background/scheduler.mjs?mock=${Date.now()}${Math.random()}`
        );
        const appCtx = createAppCtx({
            PARTITION_JOB_INTERVAL_MS: 3_600_000,
            PARTITION_AHEAD_DAYS: 1,
            LOG_RETENTION_DAYS: 1,
            TOKEN_REFRESH_INTERVAL_MS: 60_000,
            QUOTA_RESET_SWEEP_MS: 300_000,
        });

        const scheduler = startBackgroundJobs(appCtx);
        const { providerTimer } = findProviderJob(appCtx, scheduled);

        assert.ok(providerTimer);
        await providerTimer.fn();
        assert.equal(refreshCalls.length, 0);
        assert.ok(
            appCtx._logs.some(
                (entry) =>
                    entry.level === 'warn' &&
                    entry.msg === 'provider model refresh failed' &&
                    entry.meta.phase === 'timer' &&
                    entry.meta.error === 'refresh boom'
            )
        );
        assert.equal(
            appCtx._logs.some(
                (entry) =>
                    entry.level === 'error' &&
                    entry.msg === 'background job failed: provider-model-refresh'
            ),
            false
        );
        scheduler.stop();
    });

    it('does not start provider-model-refresh when interval is zero', async () => {
        installTimerMocks();
        const { startBackgroundJobs } = await import(
            `../../background/scheduler.mjs?mock=${Date.now()}${Math.random()}`
        );
        const appCtx = createAppCtx({
            PARTITION_JOB_INTERVAL_MS: 3_600_000,
            PARTITION_AHEAD_DAYS: 1,
            LOG_RETENTION_DAYS: 1,
            TOKEN_REFRESH_INTERVAL_MS: 60_000,
            QUOTA_RESET_SWEEP_MS: 300_000,
            PROVIDER_MODEL_REFRESH_INTERVAL_MS: 0,
        });

        const scheduler = startBackgroundJobs(appCtx);
        const providerJob = appCtx._logs.find(
            (entry) =>
                entry.msg === 'background job started' &&
                entry.meta.name === 'provider-model-refresh'
        );

        assert.equal(providerJob, undefined);
        scheduler.stop();
    });
});
