import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';

import {
    installMiddlewareServices,
    installBackendCatalogServices,
} from '../../bootstrap/service-installers.mjs';

describe('service installers extension integration', () => {
    let tmpDir;
    let appCtx;

    beforeEach(async () => {
        tmpDir = await mkdtemp(join(tmpdir(), 'soul-ext-installers-'));
        appCtx = {
            config: {
                env: {
                    DATABASE_URL: null,
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

async function writeModule(filePath, source) {
    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(filePath, source.trim() + '\n', 'utf8');
}
