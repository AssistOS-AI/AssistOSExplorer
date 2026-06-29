import { describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';

function createLog() {
    const entries = { info: [], warn: [], error: [], debug: [] };
    return {
        info: (msg, meta) => entries.info.push({ msg, meta }),
        warn: (msg, meta) => entries.warn.push({ msg, meta }),
        error: (msg, meta) => entries.error.push({ msg, meta }),
        debug: (msg, meta) => entries.debug.push({ msg, meta }),
        _entries: entries,
    };
}

async function withRefreshMocks(stubs, fn) {
    const providersMock = mock.module('../../db/dao/providers-dao.mjs', {
        namedExports: {
            list: stubs.listProviders,
        },
    });
    const accountsMock = mock.module('../../db/dao/provider-accounts-dao.mjs', {
        namedExports: {
            listByProvider: stubs.listAccountsByProvider,
        },
    });
    const modelsMock = mock.module('../../db/dao/models-dao.mjs', {
        namedExports: {
            listByProvider: stubs.listModelsByProvider,
        },
    });
    const autoProvisionerMock = mock.module(
        '../../runtime/providers/auto-provisioner.mjs',
        {
            namedExports: {
                discoverProviderModels: stubs.discoverProviderModels,
                syncProviderModels: stubs.syncProviderModels,
            },
        }
    );

    try {
        const mod = await import(
            `../../runtime/providers/provider-catalog-refresh.mjs?mock=${Date.now()}${Math.random()}`
        );
        return await fn(mod);
    } finally {
        providersMock.restore();
        accountsMock.restore();
        modelsMock.restore();
        autoProvisionerMock.restore();
    }
}

describe('refreshProviderModelCatalog', () => {
    it('syncs eligible enabled providers and aggregates counts', async () => {
        const synced = [];
        const log = createLog();
        const appCtx = {
            pool: {},
            services: {
                backendCatalog: {
                    getBackend(key) {
                        return key === 'openai-api'
                            ? { discoverModels() {} }
                            : { execute() {} };
                    },
                },
            },
            log,
        };

        const result = await withRefreshMocks(
            {
                listProviders: async (_pool, { limit, offset }) => {
                    assert.equal(limit, 200);
                    return offset === 0
                        ? [
                              {
                                  id: 'p1',
                                  provider_key: 'nvidia',
                                  adapter_key: 'openai-api',
                                  auth_strategy: 'api_key',
                                  enabled: true,
                              },
                              {
                                  id: 'p2',
                                  provider_key: 'none',
                                  adapter_key: 'openai-api',
                                  auth_strategy: 'none',
                                  enabled: true,
                              },
                              {
                                  id: 'p3',
                                  provider_key: 'no-discovery',
                                  adapter_key: 'other',
                                  auth_strategy: 'api_key',
                                  enabled: true,
                              },
                          ]
                        : [];
                },
                listAccountsByProvider: async (_pool, providerId) =>
                    providerId === 'p1'
                        ? [{ status: 'active', secret_ciphertext: Buffer.from('x') }]
                        : [],
                listModelsByProvider: async () => [],
                discoverProviderModels: async (_appCtx, provider) => [
                    { modelId: `${provider.provider_key}-model` },
                ],
                syncProviderModels: async (_appCtx, provider, discoveries, options) => {
                    synced.push({ provider, discoveries, options });
                    return {
                        discovered: discoveries.length,
                        created: 1,
                        updated: 2,
                        disabled: 0,
                        models: [],
                    };
                },
            },
            (mod) => mod.refreshProviderModelCatalog(appCtx, { phase: 'test' })
        );

        assert.equal(result.scanned, 3);
        assert.equal(result.eligible, 2);
        assert.equal(result.refreshed, 2);
        assert.equal(result.discovered, 2);
        assert.equal(result.created, 2);
        assert.equal(result.updated, 4);
        assert.equal(result.disabled, 0);
        assert.equal(result.skipped, 1);
        assert.equal(result.failed, 0);
        assert.deepEqual(
            synced.map((entry) => entry.provider.id),
            ['p1', 'p2']
        );
        assert.equal(synced[0].options.discoverySource, 'synced');
        assert.equal(synced[0].options.disableMissing, true);
        assert.equal(synced[0].options.refreshReason, 'provider.model-refresh');
    });

    it('preserves existing rows when automatic discovery returns empty for an existing catalog', async () => {
        let syncCalls = 0;
        const appCtx = {
            pool: {},
            services: {
                backendCatalog: {
                    getBackend() {
                        return { discoverModels() {} };
                    },
                },
            },
            log: createLog(),
        };

        const result = await withRefreshMocks(
            {
                listProviders: async (_pool, { offset }) =>
                    offset === 0
                        ? [
                              {
                                  id: 'p1',
                                  provider_key: 'axl-proxy',
                                  adapter_key: 'openai-api',
                                  auth_strategy: 'api_key',
                                  enabled: true,
                              },
                          ]
                        : [],
                listAccountsByProvider: async () => [
                    { status: 'active', secret_ciphertext: Buffer.from('x') },
                ],
                listModelsByProvider: async () => [
                    {
                        id: 'm1',
                        model_key: 'axl-proxy/old',
                        discovery_source: 'synced',
                        enabled: true,
                    },
                ],
                discoverProviderModels: async () => [],
                syncProviderModels: async () => {
                    syncCalls++;
                    throw new Error('sync should be skipped');
                },
            },
            (mod) => mod.refreshProviderModelCatalog(appCtx, { phase: 'test' })
        );

        assert.equal(syncCalls, 0);
        assert.equal(result.emptySkipped, 1);
        assert.equal(result.failed, 0);
        assert.equal(result.disabled, 0);
    });

    it('logs discovery failures and continues refreshing other providers', async () => {
        const synced = [];
        const appCtx = {
            pool: {},
            services: {
                backendCatalog: {
                    getBackend() {
                        return { discoverModels() {} };
                    },
                },
            },
            log: createLog(),
        };

        const result = await withRefreshMocks(
            {
                listProviders: async (_pool, { offset }) =>
                    offset === 0
                        ? [
                              {
                                  id: 'bad',
                                  provider_key: 'bad',
                                  adapter_key: 'openai-api',
                                  auth_strategy: 'none',
                                  enabled: true,
                              },
                              {
                                  id: 'good',
                                  provider_key: 'good',
                                  adapter_key: 'openai-api',
                                  auth_strategy: 'none',
                                  enabled: true,
                              },
                          ]
                        : [],
                listAccountsByProvider: async () => [],
                listModelsByProvider: async () => [],
                discoverProviderModels: async (_appCtx, provider) => {
                    if (provider.id === 'bad') throw new Error('upstream failed');
                    return [{ modelId: 'good-model' }];
                },
                syncProviderModels: async (_appCtx, provider) => {
                    synced.push(provider.id);
                    return {
                        discovered: 1,
                        created: 1,
                        updated: 0,
                        disabled: 0,
                        models: [],
                    };
                },
            },
            (mod) => mod.refreshProviderModelCatalog(appCtx, { phase: 'test' })
        );

        assert.deepEqual(synced, ['good']);
        assert.equal(result.failed, 1);
        assert.equal(result.refreshed, 1);
        assert.ok(
            appCtx.log._entries.warn.find((entry) =>
                entry.msg.includes('provider model refresh failed')
            )
        );
    });

    it('skips authenticated discoverable providers without usable credentials and logs the reason', async () => {
        let discoveryCalls = 0;
        let syncCalls = 0;
        const appCtx = {
            pool: {},
            services: {
                backendCatalog: {
                    getBackend() {
                        return { discoverModels() {} };
                    },
                },
            },
            log: createLog(),
        };

        const result = await withRefreshMocks(
            {
                listProviders: async (_pool, { offset }) =>
                    offset === 0
                        ? [
                              {
                                  id: 'p1',
                                  provider_key: 'needs-key',
                                  adapter_key: 'openai-api',
                                  auth_strategy: 'api_key',
                                  enabled: true,
                              },
                          ]
                        : [],
                listAccountsByProvider: async () => [],
                listModelsByProvider: async () => [],
                discoverProviderModels: async () => {
                    discoveryCalls++;
                    return [{ modelId: 'should-not-run' }];
                },
                syncProviderModels: async () => {
                    syncCalls++;
                    return {
                        discovered: 1,
                        created: 1,
                        updated: 0,
                        disabled: 0,
                        models: [],
                    };
                },
            },
            (mod) => mod.refreshProviderModelCatalog(appCtx, { phase: 'test' })
        );

        assert.equal(discoveryCalls, 0);
        assert.equal(syncCalls, 0);
        assert.equal(result.scanned, 1);
        assert.equal(result.eligible, 0);
        assert.equal(result.skipped, 1);
        assert.equal(result.failed, 0);
        assert.ok(
            appCtx.log._entries.debug.find(
                (entry) =>
                    entry.msg.includes(
                        'provider model refresh skipped provider without usable credential'
                    ) &&
                    entry.meta.phase === 'test' &&
                    entry.meta.provider === 'needs-key' &&
                    entry.meta.reason === 'missing_usable_credential'
            )
        );
    });

    it('logs credential lookup failures and continues refreshing other providers', async () => {
        const synced = [];
        const appCtx = {
            pool: {},
            services: {
                backendCatalog: {
                    getBackend() {
                        return { discoverModels() {} };
                    },
                },
            },
            log: createLog(),
        };

        const result = await withRefreshMocks(
            {
                listProviders: async (_pool, { offset }) =>
                    offset === 0
                        ? [
                              {
                                  id: 'bad',
                                  provider_key: 'bad-creds',
                                  adapter_key: 'openai-api',
                                  auth_strategy: 'api_key',
                                  enabled: true,
                              },
                              {
                                  id: 'good',
                                  provider_key: 'good',
                                  adapter_key: 'openai-api',
                                  auth_strategy: 'none',
                                  enabled: true,
                              },
                          ]
                        : [],
                listAccountsByProvider: async (_pool, providerId) => {
                    if (providerId === 'bad') {
                        throw new Error('credential store unavailable');
                    }
                    return [];
                },
                listModelsByProvider: async () => [],
                discoverProviderModels: async (_appCtx, provider) => [
                    { modelId: `${provider.provider_key}-model` },
                ],
                syncProviderModels: async (_appCtx, provider) => {
                    synced.push(provider.id);
                    return {
                        discovered: 1,
                        created: 1,
                        updated: 0,
                        disabled: 0,
                        models: [],
                    };
                },
            },
            (mod) => mod.refreshProviderModelCatalog(appCtx, { phase: 'test' })
        );

        assert.deepEqual(synced, ['good']);
        assert.equal(result.failed, 1);
        assert.equal(result.refreshed, 1);
        assert.equal(result.eligible, 1);
        assert.ok(
            appCtx.log._entries.warn.find(
                (entry) =>
                    entry.msg.includes('provider model refresh failed') &&
                    entry.meta.phase === 'test' &&
                    entry.meta.provider === 'bad-creds' &&
                    entry.meta.error === 'credential store unavailable'
            )
        );
    });
});
