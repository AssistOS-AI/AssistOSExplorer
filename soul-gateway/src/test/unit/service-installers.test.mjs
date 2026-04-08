import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';

import {
    installMiddlewareServices,
    installProviderCatalogServices,
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

    it('wires gateway middleware, provider middleware, and transport extensions into live catalogs', async () => {
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
            join(tmpDir, 'transports', 'browser-search.transport.mjs'),
            `
        export const manifest = { key: 'browser-search', name: 'Browser Search' };
        export async function execute() {
          return { accountId: null, stream: (async function* () { yield { type: 'done', data: { finish_reason: 'stop' } }; })(), abort: async () => {} };
        }
      `
        );

        await installMiddlewareServices(appCtx);
        await installProviderCatalogServices(appCtx);

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

        // Transport extension is registered in the transport catalog.
        const transport =
            appCtx.services.transportCatalog.getTransport('browser-search');
        assert.ok(transport);
        assert.equal(transport.manifest.transportType, 'custom');

        assert.ok(appCtx.services.extensionCatalog);
        assert.equal(appCtx.services.extensionCatalog.middlewares.length, 1);
        assert.equal(
            appCtx.services.extensionCatalog.providerMiddlewares.length,
            1
        );
        assert.equal(appCtx.services.extensionCatalog.transports.length, 1);
    });
});

async function writeModule(filePath, source) {
    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(filePath, source.trim() + '\n', 'utf8');
}
