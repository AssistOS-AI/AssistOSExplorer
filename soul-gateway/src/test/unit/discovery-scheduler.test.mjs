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
    const seedTiersMock = mock.module(
        '../../bootstrap/seed-default-tiers.mjs',
        {
            namedExports: {
                seedDefaultTiers: stubs.seedDefaultTiers,
            },
        }
    );

    try {
        const mod = await import(
            `../../ploinky/discovery-scheduler.mjs?mock=${Date.now()}${Math.random()}`
        );
        return await fn(mod);
    } finally {
        discoveryMock.restore();
        reconcileMock.restore();
        seedTiersMock.restore();
    }
}

describe('runPloinkyReconcileOnce', () => {
    it('seeds default tiers after reconcile and returns the reconcile summary', async () => {
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
                seedDefaultTiers: async (input) => {
                    assert.deepEqual(input, { appCtx });
                    calls.push('seed');
                    return { seeded: 1, skipped: 0, refreshed: true };
                },
            },
            async ({ runPloinkyReconcileOnce }) =>
                runPloinkyReconcileOnce(appCtx, { phase: 'startup' })
        );

        assert.equal(result, summary);
        assert.deepEqual(calls, ['discover', 'reconcile', 'seed']);
    });

    it('returns null and logs a warning when default-tier seeding fails', async () => {
        const appCtx = { config: {}, log: makeLog() };

        const result = await withSchedulerMocks(
            {
                isDiscoveryConfigured: () => true,
                discoverPloinkyAgents: async () => ({ complete: true, agents: [] }),
                reconcilePloinkyAgents: async () => ({ created: 0 }),
                seedDefaultTiers: async () => {
                    throw new Error('seed boom');
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
                error: 'seed boom',
            },
        });
    });
});
