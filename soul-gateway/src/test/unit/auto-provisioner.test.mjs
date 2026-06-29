import { describe, it, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';

// ── test doubles ────────────────────────────────────────────────────

function createMockLog() {
    const entries = { info: [], warn: [], error: [], debug: [] };
    return {
        info: (msg, meta) => entries.info.push({ msg, meta }),
        warn: (msg, meta) => entries.warn.push({ msg, meta }),
        error: (msg, meta) => entries.error.push({ msg, meta }),
        debug: (msg, meta) => entries.debug.push({ msg, meta }),
        _entries: entries,
    };
}

function createMockCatalog(modules = {}) {
    return {
        getBackend: (key) => modules[key] || null,
    };
}

function createMockCredentialManager(lease) {
    const state = { released: 0, getCalls: 0 };
    return {
        async getCredentials() {
            state.getCalls++;
            return lease;
        },
        release(l) {
            if (l === lease) state.released++;
        },
        _state: state,
    };
}

function createMockAppCtx({ catalog, credentialManager, log, pool }) {
    return {
        pool: pool || { query: async () => ({ rows: [], rowCount: 0 }) },
        log: log || createMockLog(),
        services: {
            backendCatalog: catalog || null,
            credentialManager: credentialManager || null,
            refreshRuntime: async () => ({ snapshotGeneration: 2 }),
            refreshRuntimeAsync: () => Promise.resolve(null),
        },
        snapshotGeneration: 1,
    };
}

// Intercept the `modelsDao` dynamic import used inside the
// auto-provisioner. `mock.module` (via --experimental-test-module-mocks,
// already enabled in the package.json test script) lets us install a
// per-test stub without touching the real module.
async function withStubbedModelsDao(stub, fn) {
    const updateProviderSyncedModel =
        stub.updateProviderSyncedModel || stub.update;
    const disableMissingProviderSyncedModel =
        stub.disableMissingProviderSyncedModel ||
        (async (pool, id, marker) =>
            stub.update(pool, id, {
                enabled: false,
                metadata: { syncDisabled: marker },
            }));
    const mocked = mock.module('../../db/dao/models-dao.mjs', {
        namedExports: {
            findByKey: stub.findByKey,
            listByProvider: stub.listByProvider,
            create: stub.create,
            update: stub.update,
            disable: stub.disable,
            updateProviderSyncedModel,
            disableMissingProviderSyncedModel,
        },
    });
    // Re-import the auto-provisioner so its dynamic import picks up the mock.
    const mod = await import(
        `../../runtime/providers/auto-provisioner.mjs?mock=${Date.now()}${Math.random()}`
    );
    try {
        return await fn(mod);
    } finally {
        mocked.restore();
    }
}

// ── tests ──────────────────────────────────────────────────────────

describe('auto-provisioner.autoProvisionModels', () => {
    let log;
    let autoProvisionModels;

    beforeEach(async () => {
        log = createMockLog();
        // Fresh import each test so stubs from previous tests don't leak.
        ({ autoProvisionModels } = await import(
            `../../runtime/providers/auto-provisioner.mjs?t=${Date.now()}${Math.random()}`
        ));
    });

    it('looks up the backend via provider.backendKey (Bug A regression fuse)', async () => {
        const backendModule = {
            async discoverModels() {
                return [];
            },
        };
        const catalog = createMockCatalog({
            // Only registered under the BACKEND key, not the OAuth adapter key
            'codex-api': backendModule,
        });
        const appCtx = createMockAppCtx({ catalog, log });

        const result = await autoProvisionModels(
            appCtx,
            { id: 'p1', provider_key: 'codex-api', adapter_key: 'codex-api' },
            // OAuth adapter key (what the old buggy code used for lookup)
            'openai-codex'
        );
        assert.equal(result.discovered, 0);
        assert.equal(
            log._entries.warn.length,
            0,
            'backend should be resolved via provider.backendKey, not the OAuth adapter key'
        );
    });

    it('warns with a structured message when the backend has no discoverModels function', async () => {
        const catalog = createMockCatalog({ 'codex-api': { manifest: {} } });
        const appCtx = createMockAppCtx({ catalog, log });

        await autoProvisionModels(appCtx, {
            id: 'p1',
            provider_key: 'codex-api',
            adapter_key: 'codex-api',
        });

        const warn = log._entries.warn.find((w) =>
            w.msg.includes('auto-provision discovery failed')
        );
        assert.ok(
            warn,
            'expected a warn log when backend module is missing discoverModels'
        );
        assert.equal(warn.meta.provider, 'codex-api');
        assert.equal(warn.meta.backendKey, 'codex-api');
    });

    it('warns (not silent no-op) when no backend is registered at all', async () => {
        const catalog = createMockCatalog({});
        const appCtx = createMockAppCtx({ catalog, log });

        const result = await autoProvisionModels(appCtx, {
            id: 'p1',
            provider_key: 'ghost',
            adapter_key: 'ghost',
        });
        assert.equal(result.discovered, 0);
        assert.ok(
            log._entries.warn.find((w) =>
                w.msg.includes('auto-provision discovery failed')
            )
        );
    });

    it('leases credentials, passes them to backend.discoverModels, and releases after', async () => {
        const lease = {
            accountId: 'acc-1',
            oauth: { accessToken: 'tok' },
            authType: 'oauth',
        };
        const credentialManager = createMockCredentialManager(lease);
        let capturedCtx;
        const backendModule = {
            async discoverModels(ctx) {
                capturedCtx = ctx;
                return [];
            },
        };
        const appCtx = createMockAppCtx({
            catalog: createMockCatalog({ 'codex-api': backendModule }),
            credentialManager,
            log,
        });

        await autoProvisionModels(appCtx, {
            id: 'p1',
            provider_key: 'codex-api',
            adapter_key: 'codex-api',
        });

        assert.equal(credentialManager._state.getCalls, 1);
        assert.equal(
            credentialManager._state.released,
            1,
            'lease must be released exactly once'
        );
        assert.equal(capturedCtx.credentialLease, lease);
        assert.equal(capturedCtx.providerRecord.provider_key, 'codex-api');
    });

    it('releases the credential lease even when strict auto-provision throws', async () => {
        const lease = { accountId: 'acc-err', oauth: { accessToken: 'tok' } };
        const credentialManager = createMockCredentialManager(lease);
        const backendModule = {
            async discoverModels() {
                throw new Error('upstream boom');
            },
        };
        const appCtx = createMockAppCtx({
            catalog: createMockCatalog({ 'codex-api': backendModule }),
            credentialManager,
            log,
        });

        await assert.rejects(
            () =>
                autoProvisionModels(
                    appCtx,
                    {
                        id: 'p1',
                        provider_key: 'codex-api',
                        adapter_key: 'codex-api',
                    },
                    null,
                    { strict: true }
                ),
            /upstream boom/
        );
        assert.equal(credentialManager._state.released, 1);
    });

    it('creates new rows, updates auto-provisioned rows, preserves manual rows, and disables missing discovered rows', async () => {
        const discovered = [
            {
                modelId: 'gpt-5.2-codex',
                displayName: 'gpt-5.2-codex',
                contextWindow: 272000,
            },
            {
                modelId: 'gpt-5-codex',
                displayName: 'gpt-5-codex',
                contextWindow: 128000,
                supportsTools: false,
            },
            { modelId: 'gpt-5.1-codex', displayName: 'gpt-5.1-codex' },
        ];
        const backendModule = {
            async discoverModels() {
                return discovered;
            },
        };

        const created = [];
        const updated = [];
        const disabled = [];
        const stub = {
            findByKey: async () => null,
            listByProvider: async () => [
                {
                    id: 'existing-auto',
                    model_key: 'codex-api/gpt-5-codex',
                    discovery_source: 'auto_provisioned',
                    enabled: true,
                },
                {
                    id: 'existing-manual',
                    model_key: 'codex-api/gpt-5.1-codex',
                    discovery_source: 'manual',
                    enabled: true,
                },
                {
                    id: 'missing-auto',
                    model_key: 'codex-api/gpt-4-missing',
                    discovery_source: 'synced',
                    enabled: true,
                },
            ],
            create: async (_pool, row) => {
                created.push(row);
                return { id: `new-${created.length}`, ...row };
            },
            update: async (_pool, id, fields) => {
                updated.push({ id, fields });
                return { id, ...fields };
            },
            disable: async (_pool, id) => {
                disabled.push(id);
                return { id, enabled: false };
            },
        };

        const appCtx = createMockAppCtx({
            catalog: createMockCatalog({ 'codex-api': backendModule }),
            credentialManager: createMockCredentialManager({
                oauth: { accessToken: 'tok' },
            }),
            log,
        });

        const result = await withStubbedModelsDao(stub, (mod) =>
            mod.autoProvisionModels(appCtx, {
                id: 'p1',
                provider_key: 'codex-api',
                adapter_key: 'codex-api',
            })
        );

        assert.equal(result.discovered, 3);
        assert.equal(result.created, 1);
        assert.equal(result.updated, 1);
        assert.equal(result.disabled, 1);
        assert.deepEqual(created.map((c) => c.modelKey), [
            'codex-api/gpt-5.2-codex',
        ]);
        assert.equal(created[0].discoverySource, 'auto_provisioned');
        assert.equal(created[0].enabled, true);
        assert.equal(created[0].providerId, 'p1');
        assert.equal(updated.length, 2);
        const existingAutoUpdate = updated.find((entry) => entry.id === 'existing-auto');
        assert.ok(existingAutoUpdate, 'existing auto row should be refreshed');
        assert.equal(existingAutoUpdate.fields.discoverySource, 'auto_provisioned');
        assert.equal(
            existingAutoUpdate.fields.capabilities.contextWindow,
            128000
        );
        assert.equal(
            existingAutoUpdate.fields.capabilities.supportsTools,
            false
        );
        const missingAutoUpdate = updated.find((entry) => entry.id === 'missing-auto');
        assert.ok(missingAutoUpdate, 'missing row should be sync-disabled via update');
        assert.equal(missingAutoUpdate.fields.enabled, false);
        assert.equal(
            missingAutoUpdate.fields.metadata.syncDisabled.reason,
            'missing-from-discovery'
        );
        assert.deepEqual(disabled, []);
    });

    it('marks missing discovered rows as sync-disabled instead of plain disabling them', async () => {
        const backendModule = {
            async discoverModels() {
                return [{ modelId: 'current-model', displayName: 'Current Model' }];
            },
        };

        const updates = [];
        const stub = {
            findByKey: async () => null,
            listByProvider: async () => [
                {
                    id: 'existing-current',
                    model_key: 'codex-api/current-model',
                    discovery_source: 'synced',
                    enabled: true,
                    metadata: { existing: true },
                },
                {
                    id: 'missing-synced',
                    model_key: 'codex-api/old-model',
                    discovery_source: 'synced',
                    enabled: true,
                    metadata: { kept: 'value' },
                },
            ],
            create: async () => {
                throw new Error('should not create rows');
            },
            update: async (_pool, id, fields) => {
                updates.push({ id, fields });
                return { id, ...fields };
            },
            disable: async () => {
                throw new Error('sync disable should update metadata and enabled together');
            },
            disableMissingProviderSyncedModel: async (_pool, id, marker) => {
                const fields = {
                    enabled: false,
                    metadata: {
                        kept: 'value',
                        syncDisabled: marker,
                    },
                };
                updates.push({ id, fields });
                return { id, ...fields };
            },
        };

        const appCtx = createMockAppCtx({
            catalog: createMockCatalog({ 'codex-api': backendModule }),
            credentialManager: createMockCredentialManager({ secret: 'sk-test' }),
            log,
        });

        const result = await withStubbedModelsDao(stub, (mod) =>
            mod.autoProvisionModels(
                appCtx,
                {
                    id: 'p1',
                    provider_key: 'codex-api',
                    adapter_key: 'codex-api',
                },
                null,
                {
                    discoverySource: 'synced',
                    refreshReason: 'provider.model-refresh',
                }
            )
        );

        assert.equal(result.disabled, 1);
        const missingUpdate = updates.find((entry) => entry.id === 'missing-synced');
        assert.ok(missingUpdate, 'missing row should be updated');
        assert.equal(missingUpdate.fields.enabled, false);
        assert.equal(missingUpdate.fields.metadata.kept, 'value');
        assert.equal(
            missingUpdate.fields.metadata.syncDisabled.reason,
            'missing-from-discovery'
        );
        assert.equal(
            missingUpdate.fields.metadata.syncDisabled.source,
            'provider.model-refresh'
        );
        assert.match(
            missingUpdate.fields.metadata.syncDisabled.at,
            /^\d{4}-\d{2}-\d{2}T/
        );
    });

    it('re-enables returning sync-disabled rows but preserves operator-disabled rows', async () => {
        const backendModule = {
            async discoverModels() {
                return [
                    { modelId: 'returned-model', displayName: 'Returned Model' },
                    {
                        modelId: 'operator-disabled',
                        displayName: 'Operator Disabled',
                        metadata: {
                            refreshedFromDiscovery: true,
                            openrouter: { matchedBy: 'id' },
                        },
                    },
                ];
            },
        };

        const updates = [];
        const stub = {
            findByKey: async () => null,
            listByProvider: async () => [
                {
                    id: 'returned',
                    model_key: 'codex-api/returned-model',
                    discovery_source: 'synced',
                    enabled: false,
                    metadata: {
                        syncDisabled: {
                            reason: 'missing-from-discovery',
                            source: 'provider.model-refresh',
                            at: '2026-06-29T00:00:00.000Z',
                        },
                    },
                },
                {
                    id: 'operator',
                    model_key: 'codex-api/operator-disabled',
                    discovery_source: 'synced',
                    enabled: false,
                    metadata: {
                        disabledBy: 'operator',
                        openrouter: { matchedBy: 'old' },
                    },
                },
            ],
            create: async () => {
                throw new Error('should not create rows');
            },
            update: async (_pool, id, fields) => {
                updates.push({ id, fields });
                return { id, ...fields };
            },
            disable: async () => {
                throw new Error('should not disable rows');
            },
            updateProviderSyncedModel: async (_pool, id, fields) => {
                const row = {
                    id,
                    ...fields,
                    enabled: id === 'returned' ? true : false,
                };
                updates.push({ id, fields: row });
                return row;
            },
        };

        const appCtx = createMockAppCtx({
            catalog: createMockCatalog({ 'codex-api': backendModule }),
            credentialManager: createMockCredentialManager({ secret: 'sk-test' }),
            log,
        });

        await withStubbedModelsDao(stub, (mod) =>
            mod.autoProvisionModels(
                appCtx,
                {
                    id: 'p1',
                    provider_key: 'codex-api',
                    adapter_key: 'codex-api',
                },
                null,
                {
                    discoverySource: 'synced',
                    refreshReason: 'provider.model-refresh',
                }
            )
        );

        const returnedUpdate = updates.find((entry) => entry.id === 'returned');
        assert.ok(returnedUpdate, 'returned model should be updated');
        assert.equal(returnedUpdate.fields.enabled, true);
        assert.equal(
            returnedUpdate.fields.metadata.syncDisabled,
            undefined,
            'syncDisabled marker should be removed after re-enable'
        );

        const operatorUpdate = updates.find((entry) => entry.id === 'operator');
        assert.ok(operatorUpdate, 'operator-disabled model should still receive metadata refresh');
        assert.equal(operatorUpdate.fields.enabled, false);
        assert.equal(operatorUpdate.fields.metadata.refreshedFromDiscovery, true);
        assert.equal(operatorUpdate.fields.metadata.openrouter.matchedBy, 'id');
        assert.equal(operatorUpdate.fields.metadata.disabledBy, 'operator');
    });

    it('does not re-enable a discovered row that an operator disabled after the sync snapshot', async () => {
        const backendModule = {
            async discoverModels() {
                return [{ modelId: 'racy-model', displayName: 'Racy Model' }];
            },
        };

        const genericUpdates = [];
        const conditionalUpdates = [];
        const stub = {
            findByKey: async () => null,
            listByProvider: async () => [
                {
                    id: 'racy',
                    model_key: 'codex-api/racy-model',
                    discovery_source: 'synced',
                    enabled: true,
                    metadata: {
                        syncDisabled: {
                            reason: 'missing-from-discovery',
                            source: 'provider.model-refresh',
                            at: '2026-06-29T00:00:00.000Z',
                        },
                    },
                },
            ],
            create: async () => {
                throw new Error('should not create rows');
            },
            update: async (_pool, id, fields) => {
                genericUpdates.push({ id, fields });
                return { id, ...fields };
            },
            disable: async () => {
                throw new Error('should not call generic disable');
            },
            updateProviderSyncedModel: async (_pool, id, fields) => {
                conditionalUpdates.push({ id, fields });
                return {
                    id,
                    ...fields,
                    enabled: false,
                    metadata: {
                        refreshedFromDiscovery: true,
                    },
                };
            },
            disableMissingProviderSyncedModel: async () => {
                throw new Error('should not disable discovered rows');
            },
        };

        const appCtx = createMockAppCtx({
            catalog: createMockCatalog({ 'codex-api': backendModule }),
            credentialManager: createMockCredentialManager({ secret: 'sk-test' }),
            log,
        });

        const result = await withStubbedModelsDao(stub, (mod) =>
            mod.autoProvisionModels(
                appCtx,
                {
                    id: 'p1',
                    provider_key: 'codex-api',
                    adapter_key: 'codex-api',
                },
                null,
                {
                    discoverySource: 'synced',
                    refreshReason: 'provider.model-refresh',
                }
            )
        );

        assert.equal(result.updated, 1);
        assert.deepEqual(
            genericUpdates,
            [],
            'sync must not write enabled:true through a stale generic update'
        );
        assert.equal(conditionalUpdates.length, 1);
        assert.equal(conditionalUpdates[0].id, 'racy');
        assert.equal(
            conditionalUpdates[0].fields.enabled,
            undefined,
            'ordinary discovered updates must leave enabled conditional to the DAO'
        );
        assert.equal(result.models[0].enabled, false);
    });

    it('does not mark a missing row sync-disabled when an operator disabled it after the sync snapshot', async () => {
        const backendModule = {
            async discoverModels() {
                return [];
            },
        };

        const genericUpdates = [];
        const missingDisableAttempts = [];
        const stub = {
            findByKey: async () => null,
            listByProvider: async () => [
                {
                    id: 'missing-racy',
                    model_key: 'codex-api/missing-racy',
                    discovery_source: 'synced',
                    enabled: true,
                    metadata: { kept: 'value' },
                },
            ],
            create: async () => {
                throw new Error('should not create rows');
            },
            update: async (_pool, id, fields) => {
                genericUpdates.push({ id, fields });
                return { id, ...fields };
            },
            disable: async () => {
                throw new Error('should not call generic disable');
            },
            updateProviderSyncedModel: async () => {
                throw new Error('should not update missing rows');
            },
            disableMissingProviderSyncedModel: async (_pool, id, marker) => {
                missingDisableAttempts.push({ id, marker });
                return null;
            },
        };

        const appCtx = createMockAppCtx({
            catalog: createMockCatalog({ 'codex-api': backendModule }),
            credentialManager: createMockCredentialManager({ secret: 'sk-test' }),
            log,
        });

        const result = await withStubbedModelsDao(stub, (mod) =>
            mod.autoProvisionModels(
                appCtx,
                {
                    id: 'p1',
                    provider_key: 'codex-api',
                    adapter_key: 'codex-api',
                },
                null,
                {
                    discoverySource: 'synced',
                    refreshReason: 'provider.model-refresh',
                }
            )
        );

        assert.equal(result.disabled, 0);
        assert.deepEqual(
            genericUpdates,
            [],
            'sync must not apply syncDisabled through a stale generic update'
        );
        assert.equal(missingDisableAttempts.length, 1);
        assert.equal(missingDisableAttempts[0].id, 'missing-racy');
        assert.equal(
            missingDisableAttempts[0].marker.reason,
            'missing-from-discovery'
        );
        assert.equal(
            missingDisableAttempts[0].marker.source,
            'provider.model-refresh'
        );
    });

    it('enriches missing discovery pricing, context, and tags from the pricing directory before persisting', async () => {
        const backendModule = {
            async discoverModels() {
                return [
                    {
                        modelId: 'google/gemma-3-27b-it',
                        displayName: 'Gemma 3 27B',
                        supportsTools: true,
                        supportsStreaming: true,
                    },
                ];
            },
        };
        const created = [];
        const stub = {
            findByKey: async () => null,
            listByProvider: async () => [],
            create: async (_pool, row) => {
                created.push(row);
                return { id: 'new-1', ...row };
            },
            update: async () => {
                throw new Error('should not update rows');
            },
            disable: async () => {
                throw new Error('should not disable rows');
            },
        };
        const appCtx = createMockAppCtx({
            catalog: createMockCatalog({ 'openai-api': backendModule }),
            credentialManager: createMockCredentialManager({
                secret: 'sk-test',
            }),
            log,
            pool: {},
        });
        appCtx.services.pricingDirectory = {
            async refreshIfNeeded() {},
            lookupModel(providerKey, modelId, options) {
                assert.equal(providerKey, 'nvidia');
                assert.equal(modelId, 'google/gemma-3-27b-it');
                assert.equal(options.displayName, 'Gemma 3 27B');
                return {
                    id: 'google/gemma-3-27b-it',
                    canonicalSlug: 'google/gemma-3-27b-it',
                    matchedBy: 'id',
                    pricingMode: 'token',
                    inputPricePerMillion: 0.27,
                    outputPricePerMillion: 0.4,
                    requestPriceUsd: null,
                    isFree: false,
                    contextWindow: 131072,
                    maxOutputTokens: 8192,
                    supportsTools: true,
                    supportsVision: true,
                    tags: ['tool-calling', 'vision'],
                    description: 'test',
                };
            },
            get url() {
                return 'https://openrouter.ai/api/v1/models';
            },
        };

        await withStubbedModelsDao(stub, (mod) =>
            mod.autoProvisionModels(appCtx, {
                id: 'provider-nvidia',
                provider_key: 'nvidia',
                adapter_key: 'openai-api',
            })
        );

        assert.equal(created.length, 1);
        assert.equal(created[0].pricingMode, 'token');
        assert.equal(created[0].inputPricePerMillion, 0.27);
        assert.equal(created[0].capabilities.contextWindow, 131072);
        assert.equal(created[0].capabilities.maxOutputTokens, 8192);
        // Directory-sourced capability tags plus classifier-sourced
        // curated family tags (gemma -> chat/fast; 131072 -> long-context).
        assert.deepEqual(created[0].tags, [
            'chat',
            'fast',
            'long-context',
            'tool-calling',
            'vision',
        ]);
        assert.equal(created[0].metadata.openrouter.matchedBy, 'id');
        assert.equal(
            created[0].metadata.classifier.source,
            'model-metadata-classifier'
        );
    });

    it('drops out-of-range discovery pricing before persisting models', async () => {
        const backendModule = {
            async discoverModels() {
                return [
                    {
                        modelId: 'remote-fast',
                        displayName: 'Remote Fast',
                        pricingMode: 'token',
                        inputPricePerMillion: 0.25,
                        outputPricePerMillion: 1_000_000,
                    },
                    {
                        modelId: 'remote-request',
                        displayName: 'Remote Request',
                        pricing: {
                            mode: 'request',
                            requestPriceUsd: 2_000_000,
                        },
                    },
                ];
            },
        };
        const created = [];
        const stub = {
            findByKey: async () => null,
            listByProvider: async () => [],
            create: async (_pool, row) => {
                created.push(row);
                return { id: `new-${created.length}`, ...row };
            },
            update: async () => {
                throw new Error('should not update rows');
            },
            disable: async () => {
                throw new Error('should not disable rows');
            },
        };
        const appCtx = createMockAppCtx({
            catalog: createMockCatalog({ 'openai-api': backendModule }),
            credentialManager: createMockCredentialManager({
                secret: 'sk-test',
            }),
            log,
        });

        await withStubbedModelsDao(stub, (mod) =>
            mod.autoProvisionModels(appCtx, {
                id: 'provider-remote',
                provider_key: 'soul-gateway',
                adapter_key: 'openai-api',
            })
        );

        assert.equal(created.length, 2);
        assert.equal(created[0].pricingMode, 'external_directory');
        assert.equal(created[0].inputPricePerMillion, null);
        assert.equal(created[0].outputPricePerMillion, null);
        assert.equal(created[1].pricingMode, 'external_directory');
        assert.equal(created[1].requestPriceUsd, null);
    });

    it('keys inserted models as `${provider_key}/${modelId}` to match dashboard convention', async () => {
        const backendModule = {
            async discoverModels() {
                return [{ modelId: 'm1' }, { modelId: 'm2' }];
            },
        };
        const captured = [];
        const stub = {
            findByKey: async () => null,
            listByProvider: async () => [],
            create: async (_pool, row) => {
                captured.push(row.modelKey);
                return { id: 'x' };
            },
            update: async () => {
                throw new Error('should not update existing rows');
            },
            disable: async () => {
                throw new Error('should not disable rows');
            },
        };
        const appCtx = createMockAppCtx({
            catalog: createMockCatalog({ 'my-adapter': backendModule }),
            credentialManager: createMockCredentialManager({
                oauth: { accessToken: 'tok' },
            }),
            log,
        });

        await withStubbedModelsDao(stub, (mod) =>
            mod.autoProvisionModels(appCtx, {
                id: 'p1',
                provider_key: 'my-custom-codex',
                adapter_key: 'my-adapter',
            })
        );
        assert.deepEqual(captured, [
            'my-custom-codex/m1',
            'my-custom-codex/m2',
        ]);
    });

    it('deduplicates repeated discovery entries by modelKey before inserting', async () => {
        const backendModule = {
            async discoverModels() {
                return [
                    { modelId: 'nemotron', displayName: 'Nemotron' },
                    {
                        modelId: 'nemotron',
                        displayName: 'Nemotron Duplicate',
                        supportsTools: false,
                    },
                    { modelId: 'llama', displayName: 'Llama' },
                ];
            },
        };
        const created = [];
        const stub = {
            findByKey: async () => null,
            listByProvider: async () => [],
            create: async (_pool, row) => {
                created.push(row);
                return { id: `new-${created.length}`, ...row };
            },
            update: async () => {
                throw new Error('should not update rows');
            },
            disable: async () => {
                throw new Error('should not disable rows');
            },
        };
        const appCtx = createMockAppCtx({
            catalog: createMockCatalog({ 'openai-api': backendModule }),
            credentialManager: createMockCredentialManager({
                secret: 'sk-test',
            }),
            log,
        });

        const result = await withStubbedModelsDao(stub, (mod) =>
            mod.autoProvisionModels(appCtx, {
                id: 'provider-nvidia',
                provider_key: 'nvidia',
                adapter_key: 'openai-api',
            })
        );

        assert.equal(result.discovered, 2);
        assert.deepEqual(
            created.map((row) => row.modelKey),
            ['nvidia/nemotron', 'nvidia/llama']
        );
        assert.equal(created[0].displayName, 'Nemotron Duplicate');
        assert.equal(created[0].capabilities.supportsTools, false);
    });

    it('returns early (and does not throw) when the catalog is not installed', async () => {
        const appCtx = createMockAppCtx({ catalog: null, log });
        const result = await autoProvisionModels(appCtx, {
            id: 'p1',
            provider_key: 'x',
            adapter_key: 'x',
        });
        assert.equal(result.discovered, 0);
        assert.equal(result.created, 0);
    });
});
