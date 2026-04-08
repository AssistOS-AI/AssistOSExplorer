/**
 * Backend module + catalog contract tests.
 *
 * Verifies the unified backend layer that replaced the historical
 * `ProviderPlugin` / `TransportPlugin` split:
 *
 *   - manifest validation
 *   - terminal compilation via createBackendTerminal
 *   - catalog register/lookup, generation tracking
 *   - getBackend / getTerminal contract
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
    validateBackendManifest,
    isBackendKind,
} from '../../runtime/backends/backend-interface.mjs';
import { BackendCatalog } from '../../runtime/backends/backend-catalog.mjs';
import { createBackendTerminal } from '../../runtime/backends/backend-terminal.mjs';

// ── Manifest validation ─────────────────────────────────────────────

describe('validateBackendManifest', () => {
    const validManifest = {
        key: 'test-backend',
        kind: 'external_api',
        authStrategy: 'api_key',
        supportsStreaming: true,
        supportsTools: true,
        supportedFormats: ['openai_chat'],
    };

    it('accepts a valid manifest', () => {
        assert.doesNotThrow(() => validateBackendManifest(validManifest));
    });

    it('accepts every canonical kind', () => {
        for (const kind of [
            'external_api',
            'search',
            'local_model',
            'custom',
        ]) {
            assert.doesNotThrow(() =>
                validateBackendManifest({ ...validManifest, kind })
            );
        }
    });

    it('rejects null manifest', () => {
        assert.throws(
            () => validateBackendManifest(null),
            /non-null object/
        );
    });

    it('rejects missing key', () => {
        assert.throws(
            () => validateBackendManifest({ ...validManifest, key: '' }),
            /manifest\.key/
        );
    });

    it('rejects unknown kind', () => {
        assert.throws(
            () => validateBackendManifest({ ...validManifest, kind: 'wrapper' }),
            /manifest\.kind/
        );
    });

    it('rejects invalid authStrategy', () => {
        assert.throws(
            () =>
                validateBackendManifest({
                    ...validManifest,
                    authStrategy: 'unknown',
                }),
            /authStrategy/
        );
    });

    it('rejects non-boolean supportsStreaming', () => {
        assert.throws(
            () =>
                validateBackendManifest({
                    ...validManifest,
                    supportsStreaming: 'yes',
                }),
            /supportsStreaming/
        );
    });

    it('rejects non-array supportedFormats', () => {
        assert.throws(
            () =>
                validateBackendManifest({
                    ...validManifest,
                    supportedFormats: 'openai_chat',
                }),
            /supportedFormats/
        );
    });
});

describe('isBackendKind', () => {
    it('returns true for canonical kinds', () => {
        assert.equal(isBackendKind('external_api'), true);
        assert.equal(isBackendKind('search'), true);
        assert.equal(isBackendKind('local_model'), true);
        assert.equal(isBackendKind('custom'), true);
    });

    it('returns false for unknown kinds', () => {
        assert.equal(isBackendKind('wrapper'), false);
        assert.equal(isBackendKind('plugin'), false);
        assert.equal(isBackendKind(''), false);
    });
});

// ── createBackendTerminal ──────────────────────────────────────────

describe('createBackendTerminal', () => {
    function makeBackendModule(overrides = {}) {
        return {
            manifest: {
                key: 'stub-backend',
                kind: 'external_api',
                authStrategy: 'api_key',
                supportsStreaming: true,
                supportsTools: false,
                supportedFormats: ['openai_chat'],
            },
            async execute() {
                return { accountId: null, stream: null };
            },
            classifyError(err) {
                return err;
            },
            ...overrides,
        };
    }

    it('rejects a missing module', () => {
        assert.throws(
            () => createBackendTerminal(null),
            /backendModule is required/
        );
    });

    it('rejects a module with no execute method', () => {
        assert.throws(
            () => createBackendTerminal({ manifest: { key: 'x' } }),
            /backendModule\.execute is required/
        );
    });

    it('returns a callable terminal middleware', () => {
        const terminal = createBackendTerminal(makeBackendModule());
        assert.equal(typeof terminal, 'function');
    });
});

// ── BackendCatalog ─────────────────────────────────────────────────

describe('BackendCatalog', () => {
    function makeBackendModule(key, overrides = {}) {
        return {
            manifest: {
                key,
                kind: 'external_api',
                authStrategy: 'api_key',
                supportsStreaming: true,
                supportsTools: true,
                supportedFormats: ['openai_chat'],
            },
            async init() {},
            async shutdown() {},
            async execute() {
                return { accountId: null, stream: null };
            },
            classifyError(err) {
                return err;
            },
            ...overrides,
        };
    }

    function silentLog() {
        return { info() {}, warn() {}, error() {}, debug() {} };
    }

    it('starts empty', () => {
        const catalog = new BackendCatalog({ log: silentLog() });
        assert.equal(catalog.size, 0);
        assert.equal(catalog.generation, 0);
    });

    it('loads modules and increments generation', () => {
        const catalog = new BackendCatalog({ log: silentLog() });
        catalog.load([makeBackendModule('a'), makeBackendModule('b')]);
        assert.equal(catalog.size, 2);
        assert.equal(catalog.generation, 1);
    });

    it('getBackend returns the module by key', () => {
        const catalog = new BackendCatalog({ log: silentLog() });
        const mod = makeBackendModule('openai-api');
        catalog.load([mod]);
        assert.strictEqual(catalog.getBackend('openai-api'), mod);
    });

    it('getTerminal returns a callable terminal middleware', () => {
        const catalog = new BackendCatalog({ log: silentLog() });
        catalog.load([makeBackendModule('openai-api')]);
        const terminal = catalog.getTerminal('openai-api');
        assert.equal(typeof terminal, 'function');
    });

    it('getTerminal returns the SAME terminal across calls (compiled once)', () => {
        const catalog = new BackendCatalog({ log: silentLog() });
        catalog.load([makeBackendModule('openai-api')]);
        const t1 = catalog.getTerminal('openai-api');
        const t2 = catalog.getTerminal('openai-api');
        assert.strictEqual(t1, t2);
    });

    it('returns null for unknown keys', () => {
        const catalog = new BackendCatalog({ log: silentLog() });
        catalog.load([makeBackendModule('openai-api')]);
        assert.equal(catalog.getBackend('nonexistent'), null);
        assert.equal(catalog.getTerminal('nonexistent'), null);
    });

    it('rejects duplicate keys', () => {
        const catalog = new BackendCatalog({ log: silentLog() });
        assert.throws(
            () =>
                catalog.load([
                    makeBackendModule('dup'),
                    makeBackendModule('dup'),
                ]),
            /Duplicate backend key/
        );
    });

    it('listKeys returns the registered keys', () => {
        const catalog = new BackendCatalog({ log: silentLog() });
        catalog.load([makeBackendModule('a'), makeBackendModule('b')]);
        assert.deepEqual(catalog.listKeys().sort(), ['a', 'b']);
    });

    it('shutdownAll clears entries and calls each module shutdown', async () => {
        const catalog = new BackendCatalog({ log: silentLog() });
        let calls = 0;
        const mod = makeBackendModule('test', {
            async shutdown() {
                calls++;
            },
        });
        catalog.load([mod]);
        await catalog.shutdownAll();
        assert.equal(catalog.size, 0);
        assert.equal(calls, 1);
    });

    it('rejects modules with invalid manifests at register time', () => {
        const catalog = new BackendCatalog({ log: silentLog() });
        assert.throws(
            () =>
                catalog.load([
                    {
                        manifest: { key: '' },
                        async execute() {},
                        classifyError(e) {
                            return e;
                        },
                    },
                ]),
            /manifest\.key/
        );
    });

    it('testConnection routes through the resolved backend module', async () => {
        const catalog = new BackendCatalog({ log: silentLog() });
        let releasedLease = null;
        const mod = makeBackendModule('test-backend', {
            async testConnection(ctx) {
                assert.equal(ctx.credentialLease.secret, 'sk-test');
                assert.equal(
                    ctx.providerRecord.baseUrl,
                    'https://api.example.test'
                );
                return { ok: true, detail: 'ok' };
            },
        });
        catalog.load([mod]);

        const result = await catalog.testConnection(
            {
                id: 'provider-1',
                adapter_key: 'test-backend',
                base_url: 'https://api.example.test',
            },
            {
                credentialManager: {
                    async getCredentials(providerId) {
                        assert.equal(providerId, 'provider-1');
                        return {
                            leaseId: 'lease-1',
                            accountId: 'acc-1',
                            authType: 'api_key',
                            secret: 'sk-test',
                            oauth: null,
                            metadata: {},
                        };
                    },
                    release(lease) {
                        releasedLease = lease;
                    },
                },
            }
        );

        assert.deepEqual(result, { ok: true, detail: 'ok' });
        assert.equal(releasedLease.leaseId, 'lease-1');
    });

    it('discoverModels routes through the backend module', async () => {
        const catalog = new BackendCatalog({ log: silentLog() });
        let releasedLease = null;
        const mod = makeBackendModule('discovery-backend', {
            async discoverModels(ctx) {
                assert.equal(ctx.credentialLease.oauth.accessToken, 'oauth-token');
                return [{ modelId: 'm1' }];
            },
        });
        catalog.load([mod]);

        const result = await catalog.discoverModels(
            { id: 'provider-2', adapter_key: 'discovery-backend' },
            {
                credentialManager: {
                    async getCredentials() {
                        return {
                            leaseId: 'lease-2',
                            accountId: 'acc-2',
                            authType: 'oauth',
                            secret: null,
                            oauth: {
                                accessToken: 'oauth-token',
                                refreshToken: null,
                                expiresAt: null,
                            },
                            metadata: {},
                        };
                    },
                    release(lease) {
                        releasedLease = lease;
                    },
                },
            }
        );

        assert.deepEqual(result, [{ modelId: 'm1' }]);
        assert.equal(releasedLease.leaseId, 'lease-2');
    });

    it('testConnection returns ok=false when no module is loaded for the key', async () => {
        const catalog = new BackendCatalog({ log: silentLog() });
        catalog.load([]);
        const result = await catalog.testConnection({
            id: 'provider-x',
            adapter_key: 'missing',
        });
        assert.equal(result.ok, false);
        assert.match(result.detail, /Backend module not loaded/);
    });

    it('discoverModels returns [] when no module is loaded for the key', async () => {
        const catalog = new BackendCatalog({ log: silentLog() });
        catalog.load([]);
        const result = await catalog.discoverModels({
            id: 'provider-x',
            adapter_key: 'missing',
        });
        assert.deepEqual(result, []);
    });
});
