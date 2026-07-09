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
            join(tmpDir, 'backends', 'external-fetch.backend.mjs'),
            `
        export const backendModule = {
            manifest: {
                key: 'external-fetch',
                kind: 'external_api',
                authStrategy: 'api_key',
                supportsStreaming: false,
                supportsTools: false,
                supportedFormats: ['openai_chat'],
                displayName: 'External Fetch'
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
            appCtx.services.backendCatalog.getBackend('external-fetch');
        assert.ok(backend);
        assert.equal(backend.manifest.kind, 'external_api');

        // The catalog also exposes a precompiled terminal.
        const terminal =
            appCtx.services.backendCatalog.getTerminal('external-fetch');
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

async function withStartupRefreshMock(stub, fn) {
    const refreshMock = mock.module(
        '../../runtime/providers/provider-catalog-refresh.mjs',
        {
            namedExports: {
                refreshProviderModelCatalog: stub.refreshProviderModelCatalog,
            },
        }
    );

    try {
        return await fn();
    } finally {
        refreshMock.restore();
    }
}

describe('reconcileProvidersOnStartup', () => {
    it('delegates startup provider model refresh to the catalog refresh service', async () => {
        const calls = [];
        const appCtx = {
            config: { env: {} },
            pool: {},
            services: {},
            log: {
                info() {},
                warn() {},
                error() {},
                debug() {},
            },
        };

        const refreshSummary = {
            scanned: 2,
            eligible: 2,
            refreshed: 2,
            discovered: 4,
            created: 1,
            updated: 3,
            disabled: 0,
            skipped: 0,
            emptySkipped: 0,
            failed: 0,
        };
        const summary = await withStartupRefreshMock(
            {
                refreshProviderModelCatalog: async (receivedAppCtx, options) => {
                    calls.push({ receivedAppCtx, options });
                    return refreshSummary;
                },
            },
            () => reconcileProvidersOnStartup(appCtx)
        );

        assert.equal(calls.length, 1);
        assert.equal(calls[0].receivedAppCtx, appCtx);
        assert.deepEqual(calls[0].options, {
            phase: 'startup',
            discoverySource: 'synced',
            disableMissing: true,
            refreshReason: 'provider.startup-refresh',
            skipEmptyExistingCatalog: true,
        });
        assert.deepEqual(summary, refreshSummary);
    });

    it('no-ops without a database pool', async () => {
        const appCtx = {
            config: { env: {} },
            pool: null,
            services: {},
            log: {
                info() {},
                warn() {},
                error() {},
                debug() {},
            },
        };

        const summary = await reconcileProvidersOnStartup(appCtx);
        assert.deepEqual(summary, {
            scanned: 0,
            eligible: 0,
            refreshed: 0,
            discovered: 0,
            created: 0,
            updated: 0,
            disabled: 0,
            skipped: 0,
            emptySkipped: 0,
            failed: 0,
        });
    });
});
