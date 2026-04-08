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
    const mocked = mock.module('../../db/dao/models-dao.mjs', {
        namedExports: {
            findByKey: stub.findByKey,
            create: stub.create,
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
            log._entries.warn.filter((w) => w.msg.includes('backend module missing'))
                .length,
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
            w.msg.includes('backend module missing')
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
            log._entries.warn.find((w) => w.msg.includes('backend module missing'))
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

    it('releases the credential lease even when the backend throws', async () => {
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

        const result = await autoProvisionModels(appCtx, {
            id: 'p1',
            provider_key: 'codex-api',
            adapter_key: 'codex-api',
        });

        assert.equal(result.discovered, 0);
        assert.equal(credentialManager._state.released, 1);
        assert.ok(
            log._entries.warn.find((w) =>
                w.msg.includes('auto-provision discovery failed')
            )
        );
    });

    it('inserts only new models, skipping ones that already exist', async () => {
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
            },
            { modelId: 'gpt-5.1-codex', displayName: 'gpt-5.1-codex' },
        ];
        const backendModule = {
            async discoverModels() {
                return discovered;
            },
        };

        const existing = new Set(['codex-api/gpt-5-codex']);
        const created = [];
        const stub = {
            findByKey: async (_pool, key) =>
                existing.has(key) ? { id: 'x', model_key: key } : null,
            create: async (_pool, row) => {
                created.push(row);
                return { id: `new-${created.length}`, ...row };
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
        assert.equal(result.created, 2);
        assert.deepEqual(created.map((c) => c.modelKey).sort(), [
            'codex-api/gpt-5.1-codex',
            'codex-api/gpt-5.2-codex',
        ]);
        // Every row must carry the auto_provisioned discovery source so the
        // dashboard can distinguish it from manually-added models.
        for (const row of created) {
            assert.equal(row.discoverySource, 'auto_provisioned');
            assert.equal(row.executionKind, 'provider_model');
            assert.equal(row.enabled, true);
            assert.equal(row.pricingMode, 'external_directory');
            assert.equal(row.providerId, 'p1');
        }
    });

    it('tolerates duplicate-key races without surfacing them as warnings', async () => {
        const backendModule = {
            async discoverModels() {
                return [{ modelId: 'dup', displayName: 'dup' }];
            },
        };
        const stub = {
            findByKey: async () => null,
            create: async () => {
                const err = new Error(
                    'duplicate key value violates unique constraint'
                );
                throw err;
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
        assert.equal(result.created, 0);
        // Race-loss is silent — no "create failed" warning
        assert.equal(
            log._entries.warn.filter((w) =>
                w.msg.includes('model create failed')
            ).length,
            0
        );
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
            create: async (_pool, row) => {
                captured.push(row.modelKey);
                return { id: 'x' };
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
