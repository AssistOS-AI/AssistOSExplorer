import { describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';

function makeLog() {
    const entries = { warn: [] };
    return {
        debug() {},
        info() {},
        warn(message, metadata) {
            entries.warn.push({ message, metadata });
        },
        error() {},
        entries,
    };
}

async function withSchedulerMocks(stubs, fn) {
    const discoveryMock = mock.module('../../ploinky/discovery-client.mjs', {
        namedExports: {
            isDiscoveryConfigured: stubs.isDiscoveryConfigured,
            discoverPloinkyAgents: stubs.discoverPloinkyAgents,
        },
    });
    const reconcileMock = mock.module('../../ploinky/reconcile-agents.mjs', {
        namedExports: {
            reconcilePloinkyAgents: stubs.reconcilePloinkyAgents,
        },
    });

    try {
        const mod = await import(
            `../../ploinky/discovery-scheduler.mjs?mock=${Date.now()}${Math.random()}`
        );
        return await fn(mod);
    } finally {
        discoveryMock.restore();
        reconcileMock.restore();
    }
}

describe('runPloinkyReconcileOnce', () => {
    it('discovers agents, reconciles them, and returns the reconcile summary', async () => {
        const calls = [];
        const appCtx = { config: {}, log: makeLog() };
        const discovery = { complete: true, agents: [] };
        const summary = { created: 1, updated: 0, disabled: 0 };

        const result = await withSchedulerMocks(
            {
                isDiscoveryConfigured: () => true,
                discoverPloinkyAgents: async (config, { log }) => {
                    assert.equal(config, appCtx.config);
                    assert.equal(log, appCtx.log);
                    calls.push('discover');
                    return discovery;
                },
                reconcilePloinkyAgents: async (input) => {
                    assert.deepEqual(input, { appCtx, discovery });
                    calls.push('reconcile');
                    return summary;
                },
            },
            async ({ runPloinkyReconcileOnce }) =>
                runPloinkyReconcileOnce(appCtx, { phase: 'startup' })
        );

        assert.equal(result, summary);
        assert.deepEqual(calls, ['discover', 'reconcile']);
    });

    it('returns null and logs a warning when reconcile fails', async () => {
        const appCtx = { config: {}, log: makeLog() };

        const result = await withSchedulerMocks(
            {
                isDiscoveryConfigured: () => true,
                discoverPloinkyAgents: async () => ({ complete: true, agents: [] }),
                reconcilePloinkyAgents: async () => {
                    throw new Error('reconcile boom');
                },
            },
            async ({ runPloinkyReconcileOnce }) =>
                runPloinkyReconcileOnce(appCtx, { phase: 'timer' })
        );

        assert.equal(result, null);
        assert.equal(appCtx.log.entries.warn.length, 1);
        assert.deepEqual(appCtx.log.entries.warn[0], {
            message: 'ploinky agent reconcile pass failed',
            metadata: {
                phase: 'timer',
                error: 'reconcile boom',
            },
        });
    });
});

describe('startPloinkyDiscoveryTimer', () => {
    it('skips a tick that fires while the previous reconcile is still running', async () => {
        const appCtx = { config: {}, log: makeLog() };
        let reconcileCalls = 0;
        let releaseFirst;
        const firstDone = new Promise((resolve) => {
            releaseFirst = resolve;
        });

        await withSchedulerMocks(
            {
                isDiscoveryConfigured: () => true,
                discoverPloinkyAgents: async () => ({ complete: true, agents: [] }),
                reconcilePloinkyAgents: async () => {
                    reconcileCalls += 1;
                    if (reconcileCalls === 1) {
                        await firstDone;
                    }
                    return {};
                },
            },
            async ({ startPloinkyDiscoveryTimer }) => {
                const timer = startPloinkyDiscoveryTimer(appCtx, { intervalMs: 10 });
                try {
                    await new Promise((resolve) => setTimeout(resolve, 80));
                    // Several ticks fired while pass 1 is blocked: only one ran.
                    assert.equal(reconcileCalls, 1);
                    assert.ok(
                        appCtx.log.entries.warn.some((e) =>
                            /skipping overlapping/.test(e.message)
                        )
                    );
                    releaseFirst();
                    await new Promise((resolve) => setTimeout(resolve, 60));
                    // Once pass 1 finished, later ticks run again.
                    assert.ok(reconcileCalls >= 2);
                } finally {
                    clearInterval(timer);
                    releaseFirst();
                }
            }
        );
    });
});
