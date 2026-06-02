import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';

import {
    installExecutionServices,
    installMiddlewareServices,
    installBackendCatalogServices,
    reconcileProvidersOnStartup,
} from '../../bootstrap/service-installers.mjs';
import { mock } from 'node:test';

describe('service installers extension integration', () => {
    let tmpDir;
    let appCtx;

    beforeEach(async () => {
        tmpDir = await mkdtemp(join(tmpdir(), 'soul-ext-installers-'));
        appCtx = {
            config: {
                env: {
                    EXTENSIONS_DIR: tmpDir,
                },
                defaults: {
                    middlewareGenerationGcGraceMs: 10,
                },
            },
            services: {},
            pool: null,
            log: {
                debug() {},
                info() {},
                warn() {},
                error() {},
                fatal() {},
            },
        };
    });

    afterEach(async () => {
        await rm(tmpDir, { recursive: true, force: true });
    });

    it('wires gateway middleware, provider middleware, and backend extensions into live catalogs', async () => {
        await writeModule(
            join(tmpDir, 'middlewares', 'gateway-audit.middleware.mjs'),
            `
        export const manifest = { key: 'gateway-audit', name: 'Gateway Audit', version: '1.0.0' };
        export const meta = manifest;
        export function factory() { return async (ctx, next) => { await next(); }; }
      `
        );
        await writeModule(
            join(tmpDir, 'provider-middlewares', 'query-planner.middleware.mjs'),
            `
        export const manifest = { key: 'query-planner', name: 'Query Planner', version: '1.0.0' };
        export const meta = manifest;
        export function factory() { return async (ctx, next) => { await next(); }; }
      `
        );
        await writeModule(
            join(tmpDir, 'backends', 'browser-search.backend.mjs'),
            `
        export const backendModule = {
            manifest: {
                key: 'browser-search',
                kind: 'search',
                authStrategy: 'api_key',
                supportsStreaming: false,
                supportsTools: false,
                supportedFormats: ['openai_chat'],
                displayName: 'Browser Search'
            },
            async execute() {
                return { accountId: null, stream: (async function* () { yield { type: 'done', data: { finish_reason: 'stop' } }; })(), abort: async () => {} };
            },
            classifyError(error) {
                return error;
            }
        };
      `
        );

        await installMiddlewareServices(appCtx);
        await installBackendCatalogServices(appCtx);

        // Gateway middleware extension is registered as a middleware catalog
        // entry with a usable factory.
        const gatewayMiddleware = appCtx.services.middlewareCatalog.build(
            'gateway-audit',
            {}
        );
        assert.ok(
            gatewayMiddleware,
            'gateway middleware extension should be registered in the middleware catalog'
        );
        assert.equal(typeof gatewayMiddleware, 'function');

        // Provider middleware extension is registered in the native
        // provider middleware registry.
        const providerModule =
            appCtx.services.providerMiddlewareRegistry.get('query-planner');
        assert.ok(
            providerModule,
            'provider middleware extension should be registered in the provider middleware registry'
        );
        assert.equal(typeof providerModule.factory, 'function');

        // Backend extension is registered in the backend catalog.
        const backend =
            appCtx.services.backendCatalog.getBackend('browser-search');
        assert.ok(backend);
        assert.equal(backend.manifest.kind, 'search');

        // The catalog also exposes a precompiled terminal.
        const terminal =
            appCtx.services.backendCatalog.getTerminal('browser-search');
        assert.equal(typeof terminal, 'function');

        assert.ok(appCtx.services.extensionCatalog);
        assert.equal(appCtx.services.extensionCatalog.middlewares.length, 1);
        assert.equal(
            appCtx.services.extensionCatalog.providerMiddlewares.length,
            1
        );
        assert.equal(appCtx.services.extensionCatalog.backends.length, 1);
    });
});

describe('installExecutionServices', () => {
    it('installs the shared pricing directory service with the OpenRouter default URL', async () => {
        const originalFetch = globalThis.fetch;
        globalThis.fetch = async () =>
            new Response(JSON.stringify({ data: [] }), {
                status: 200,
                headers: { 'Content-Type': 'application/json' },
            });
        const appCtx = {
            config: {
                env: {
                    SPEND_CACHE_TTL_MS: 10_000,
                    PRICING_DIRECTORY_URL: null,
                    PRICING_REFRESH_INTERVAL_MS: 60_000,
                    DATA_DIR: '/tmp/soul-gateway-test',
                    ENCRYPTION_KEY: 'a'.repeat(64),
                },
            },
            services: {},
            log: {
                debug() {},
                info() {},
                warn() {},
                error() {},
                fatal() {},
            },
        };

        try {
            await installExecutionServices(appCtx);

            assert.ok(appCtx.services.pricingDirectory);
            assert.equal(
                appCtx.services.pricingDirectory.url,
                'https://openrouter.ai/api/v1/models'
            );
        } finally {
            globalThis.fetch = originalFetch;
        }
    });
});

async function writeModule(filePath, source) {
    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(filePath, source.trim() + '\n', 'utf8');
}

async function withStartupReconcileMocks(stubs, fn) {
    const providerDaoMock = mock.module('../../db/dao/providers-dao.mjs', {
        namedExports: {
            list: stubs.listProviders,
        },
    });
    const accountsDaoMock = mock.module(
        '../../db/dao/provider-accounts-dao.mjs',
        {
            namedExports: {
                listByProvider: stubs.listAccountsByProvider,
            },
        }
    );
    const modelsDaoMock = mock.module('../../db/dao/models-dao.mjs', {
        namedExports: {
            listByProvider: stubs.listModelsByProvider,
        },
    });
    const autoProvisionerMock = mock.module(
        '../../runtime/providers/auto-provisioner.mjs',
        {
            namedExports: {
                autoProvisionModels: stubs.autoProvisionModels,
            },
        }
    );

    try {
        return await fn();
    } finally {
        providerDaoMock.restore();
        accountsDaoMock.restore();
        modelsDaoMock.restore();
        autoProvisionerMock.restore();
    }
}

describe('reconcileProvidersOnStartup', () => {
    it('reconciles only enabled providers that have an active stored credential and zero model rows', async () => {
        const calls = [];
        const appCtx = {
            config: {
                env: {},
            },
            pool: {},
            services: {},
            log: {
                info() {},
                warn() {},
                error() {},
                debug() {},
            },
        };

        const summary = await withStartupReconcileMocks(
            {
                listProviders: async (_pool, { limit, offset }) => {
                    assert.equal(limit, 200);
                    if (offset === 0) {
                        return [
                            {
                                id: 'provider-sync',
                                provider_key: 'openai',
                                oauth_adapter_key: null,
                            },
                            {
                                id: 'provider-no-creds',
                                provider_key: 'copilot',
                                oauth_adapter_key: 'github-copilot',
                            },
                            {
                                id: 'provider-has-models',
                                provider_key: 'anthropic',
                                oauth_adapter_key: null,
                            },
                        ];
                    }
                    return [];
                },
                listAccountsByProvider: async (_pool, providerId) => {
                    if (providerId === 'provider-sync') {
                        return [
                            {
                                id: 'acc-1',
                                status: 'active',
                                secret_ciphertext: Buffer.from('secret'),
                            },
                        ];
                    }
                    if (providerId === 'provider-no-creds') {
                        return [];
                    }
                    return [
                        {
                            id: 'acc-2',
                            status: 'active',
                            credentials_path: '/tmp/oauth.json',
                        },
                    ];
                },
                listModelsByProvider: async (_pool, providerId) => {
                    if (providerId === 'provider-has-models') {
                        return [{ id: 'model-1' }];
                    }
                    return [];
                },
                autoProvisionModels: async (
                    _appCtx,
                    provider,
                    oauthAdapterKey,
                    options
                ) => {
                    calls.push({
                        providerId: provider.id,
                        oauthAdapterKey,
                        options,
                    });
                    return {
                        created: 2,
                        updated: 1,
                        disabled: 0,
                    };
                },
            },
            () => reconcileProvidersOnStartup(appCtx)
        );

        assert.deepEqual(summary, {
            scanned: 3,
            reconciled: 1,
            created: 2,
            updated: 1,
            disabled: 0,
        });
        assert.deepEqual(calls, [
            {
                providerId: 'provider-sync',
                oauthAdapterKey: null,
                options: {
                    strict: true,
                    discoverySource: 'auto_provisioned',
                    disableMissing: true,
                    refreshReason: 'provider.startup-reconcile',
                },
            },
        ]);
    });

    it('fails startup when reconciliation cannot seed an eligible provider', async () => {
        const appCtx = {
            config: {
                env: {},
            },
            pool: {},
            services: {},
            log: {
                info() {},
                warn() {},
                error() {},
                debug() {},
            },
        };

        await assert.rejects(
            () =>
                withStartupReconcileMocks(
                    {
                        listProviders: async () => [
                            {
                                id: 'provider-sync',
                                provider_key: 'openai',
                                oauth_adapter_key: null,
                            },
                        ],
                        listAccountsByProvider: async () => [
                            {
                                id: 'acc-1',
                                status: 'active',
                                secret_ciphertext: Buffer.from('secret'),
                            },
                        ],
                        listModelsByProvider: async () => [],
                        autoProvisionModels: async () => {
                            throw new Error('upstream /models failed');
                        },
                    },
                    () => reconcileProvidersOnStartup(appCtx)
                ),
            /upstream \/models failed/
        );
    });
});
