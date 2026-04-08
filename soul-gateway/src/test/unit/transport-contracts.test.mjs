import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { validateTransportManifest } from '../../runtime/transports/transport-interface.mjs';
import { TransportCatalog } from '../../runtime/transports/transport-catalog.mjs';
import { adaptProviderToTransport } from '../../runtime/transports/provider-transport-adapter.mjs';

// ── Transport manifest validation ───────────────────────────────────

describe('validateTransportManifest', () => {
    const validManifest = {
        key: 'test-transport',
        name: 'Test Transport',
        transportType: 'external_api',
        supportsStreaming: true,
        supportsTools: true,
    };

    it('accepts a valid manifest', () => {
        assert.doesNotThrow(() => validateTransportManifest(validManifest));
    });

    it('accepts all valid transportType values', () => {
        for (const t of ['external_api', 'search', 'local_model', 'custom']) {
            assert.doesNotThrow(() =>
                validateTransportManifest({
                    ...validManifest,
                    transportType: t,
                })
            );
        }
    });

    it('rejects null manifest', () => {
        assert.throws(() => validateTransportManifest(null), /non-null object/);
    });

    it('rejects non-object manifest', () => {
        assert.throws(
            () => validateTransportManifest('string'),
            /non-null object/
        );
    });

    it('rejects missing key', () => {
        assert.throws(
            () => validateTransportManifest({ ...validManifest, key: '' }),
            /manifest\.key/
        );
    });

    it('rejects non-string key', () => {
        assert.throws(
            () => validateTransportManifest({ ...validManifest, key: 42 }),
            /manifest\.key/
        );
    });

    it('rejects missing name', () => {
        assert.throws(
            () => validateTransportManifest({ ...validManifest, name: '' }),
            /manifest\.name/
        );
    });

    it('rejects invalid transportType', () => {
        assert.throws(
            () =>
                validateTransportManifest({
                    ...validManifest,
                    transportType: 'invalid',
                }),
            /transportType/
        );
    });

    it('rejects wrapper transportType (no longer accepted)', () => {
        assert.throws(
            () =>
                validateTransportManifest({
                    ...validManifest,
                    transportType: 'wrapper',
                }),
            /transportType/
        );
    });

    it('rejects non-boolean supportsStreaming', () => {
        assert.throws(
            () =>
                validateTransportManifest({
                    ...validManifest,
                    supportsStreaming: 'yes',
                }),
            /supportsStreaming/
        );
    });

    it('rejects non-boolean supportsTools', () => {
        assert.throws(
            () =>
                validateTransportManifest({
                    ...validManifest,
                    supportsTools: 1,
                }),
            /supportsTools/
        );
    });
});

// ── adaptProviderToTransport ────────────────────────────────────────

describe('adaptProviderToTransport', () => {
    function makeProviderPlugin(overrides = {}) {
        return {
            manifest: {
                key: 'test-api',
                kind: 'external_api',
                authStrategy: 'api_key',
                supportsStreaming: true,
                supportsTools: true,
                supportedFormats: ['openai_chat'],
                displayName: 'Test API Provider',
                ...overrides.manifest,
            },
            async init() {},
            async shutdown() {},
            validateProviderRecord() {},
            validateModelRecord() {},
            async execute(ctx) {
                return { accountId: null, stream: null, abort: async () => {} };
            },
            classifyError(err) {
                return {
                    httpStatus: 500,
                    errorType: 'internal_error',
                    retryable: false,
                    cooldown: false,
                    cascade: false,
                    retryAfterSeconds: null,
                };
            },
            async discoverModels() {
                return [{ modelId: 'm1', displayName: 'Model 1' }];
            },
            async testConnection() {
                return { ok: true, detail: 'connected' };
            },
            ...overrides,
        };
    }

    it('maps kind to transportType', () => {
        const adapted = adaptProviderToTransport(makeProviderPlugin());
        assert.equal(adapted.manifest.transportType, 'external_api');
    });

    it('maps kind=search to transportType=search', () => {
        const adapted = adaptProviderToTransport(
            makeProviderPlugin({
                manifest: {
                    kind: 'search',
                    key: 'search-builtin',
                    displayName: 'Search',
                },
            })
        );
        assert.equal(adapted.manifest.transportType, 'search');
    });

    it('uses displayName as name', () => {
        const adapted = adaptProviderToTransport(makeProviderPlugin());
        assert.equal(adapted.manifest.name, 'Test API Provider');
    });

    it('falls back to key when displayName is absent', () => {
        const plugin = makeProviderPlugin();
        delete plugin.manifest.displayName;
        const adapted = adaptProviderToTransport(plugin);
        assert.equal(adapted.manifest.name, 'test-api');
    });

    it('preserves execute function', async () => {
        let called = false;
        const plugin = makeProviderPlugin({
            async execute(ctx) {
                called = true;
                return { accountId: null, stream: null, abort: async () => {} };
            },
        });
        const adapted = adaptProviderToTransport(plugin);
        await adapted.execute({});
        assert.ok(called);
    });

    it('preserves classifyError function', () => {
        let called = false;
        const plugin = makeProviderPlugin({
            classifyError(err) {
                called = true;
                return { httpStatus: 400 };
            },
        });
        const adapted = adaptProviderToTransport(plugin);
        adapted.classifyError(new Error('test'));
        assert.ok(called);
    });

    it('preserves discoverModels when present', async () => {
        const adapted = adaptProviderToTransport(makeProviderPlugin());
        assert.equal(typeof adapted.discoverModels, 'function');
        const models = await adapted.discoverModels();
        assert.equal(models.length, 1);
        assert.equal(models[0].modelId, 'm1');
    });

    it('omits discoverModels when not on provider', () => {
        const plugin = makeProviderPlugin();
        delete plugin.discoverModels;
        const adapted = adaptProviderToTransport(plugin);
        assert.equal(adapted.discoverModels, undefined);
    });

    it('preserves testConnection when present', async () => {
        const adapted = adaptProviderToTransport(makeProviderPlugin());
        assert.equal(typeof adapted.testConnection, 'function');
        const result = await adapted.testConnection();
        assert.equal(result.ok, true);
    });

    it('preserves init and shutdown when present', async () => {
        let initCalled = false;
        let shutdownCalled = false;
        const plugin = makeProviderPlugin({
            async init() {
                initCalled = true;
            },
            async shutdown() {
                shutdownCalled = true;
            },
        });
        const adapted = adaptProviderToTransport(plugin);
        await adapted.init();
        await adapted.shutdown();
        assert.ok(initCalled);
        assert.ok(shutdownCalled);
    });

    it('produces a manifest that passes validation', () => {
        const adapted = adaptProviderToTransport(makeProviderPlugin());
        assert.doesNotThrow(() => validateTransportManifest(adapted.manifest));
    });
});

// ── TransportCatalog ────────────────────────────────────────────────

describe('TransportCatalog', () => {
    function makeTransport(key, overrides = {}) {
        return {
            manifest: {
                key,
                name: overrides.name || key,
                transportType: overrides.transportType || 'external_api',
                supportsStreaming: true,
                supportsTools: true,
            },
            async execute() {},
            classifyError() {},
            ...overrides,
        };
    }

    it('register and getTransport', () => {
        const cat = new TransportCatalog();
        const t = makeTransport('openai-api');
        cat.register('openai-api', t);
        assert.strictEqual(cat.getTransport('openai-api'), t);
    });

    it('listKeys returns registered keys', () => {
        const cat = new TransportCatalog();
        cat.register('openai-api', makeTransport('openai-api'));
        cat.register('anthropic-api', makeTransport('anthropic-api'));
        assert.deepEqual(cat.listKeys().sort(), [
            'anthropic-api',
            'openai-api',
        ]);
    });

    it('size reflects count', () => {
        const cat = new TransportCatalog();
        assert.equal(cat.size, 0);
        cat.register('a', makeTransport('a'));
        assert.equal(cat.size, 1);
        cat.register('b', makeTransport('b'));
        assert.equal(cat.size, 2);
    });

    it('getTransport returns null for unknown key', () => {
        const cat = new TransportCatalog();
        assert.equal(cat.getTransport('nonexistent'), null);
    });

    it('getTransport returns the registered transport by exact key', () => {
        // The catalog is keyed by the plugin's manifest.key (e.g.
        // `openai-api`), and every caller is required to look up by the
        // same key — there is no legacy short-name fallback
        // (`nvidia`/`mistral`/`openrouter` → `openai-api`).
        const cat = new TransportCatalog();
        const openai = makeTransport('openai-api');
        cat.register('openai-api', openai);

        assert.strictEqual(cat.getTransport('openai-api'), openai);
        assert.equal(cat.getTransport('nvidia'), null);
        assert.equal(cat.getTransport('mistral'), null);
        assert.equal(cat.getTransport('openrouter'), null);
    });

    it('rejects invalid manifest on register', () => {
        const cat = new TransportCatalog();
        assert.throws(
            () => cat.register('bad', { manifest: { key: '' } }),
            /manifest\.key/
        );
    });
});

// ── Adapted transport transportType mapping ─────────────────────────

describe('Adapted transport transportType mapping', () => {
    function makeProviderPlugin(kind) {
        return {
            manifest: {
                key: `test-${kind}`,
                kind,
                authStrategy: 'api_key',
                supportsStreaming: kind !== 'search',
                supportsTools: kind !== 'search',
                supportedFormats: ['openai_chat'],
                displayName: `Test ${kind}`,
            },
            async init() {},
            async shutdown() {},
            async execute() {},
            classifyError() {},
        };
    }

    for (const kind of ['external_api', 'search', 'local_model', 'custom']) {
        it(`maps provider kind '${kind}' to transportType '${kind}'`, () => {
            const adapted = adaptProviderToTransport(makeProviderPlugin(kind));
            assert.equal(adapted.manifest.transportType, kind);
        });
    }
});
