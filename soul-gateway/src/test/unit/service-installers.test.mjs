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
    tmpDir = await mkdtemp(join(tmpdir(), 'soul-hook-installers-'));
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

  it('wires gateway hooks, provider hooks, and executor extensions into live catalogs', async () => {
    await writeModule(
      join(tmpDir, 'gateway-hooks', 'gateway-audit.hook.mjs'),
      `
        export const manifest = { key: 'gateway-audit', phases: ['request'], version: '1.0.0' };
        export async function onRequest() {}
      `,
    );
    await writeModule(
      join(tmpDir, 'provider-hooks', 'query-planner.hook.mjs'),
      `
        export const manifest = { key: 'query-planner', phases: ['request'], version: '1.0.0' };
        export async function onRequest() {}
      `,
    );
    await writeModule(
      join(tmpDir, 'executors', 'browser-search.executor.mjs'),
      `
        export const manifest = { key: 'browser-search', name: 'Browser Search' };
        export async function execute() {
          return { accountId: null, stream: (async function* () { yield { type: 'done', data: { finish_reason: 'stop' } }; })(), abort: async () => {} };
        }
      `,
    );

    await installMiddlewareServices(appCtx);
    await installProviderCatalogServices(appCtx);

    const gatewayHook = appCtx.services.middlewareCatalog.getHookView('gateway-audit');
    assert.ok(gatewayHook);
    assert.equal(gatewayHook.meta.scope, 'gateway');

    const providerHook = appCtx.services.providerHookCatalog.getHook('query-planner');
    assert.ok(providerHook);
    assert.equal(providerHook.meta.scope, 'provider');

    const executor = appCtx.services.executorCatalog.getExecutor('browser-search');
    assert.ok(executor);
    assert.equal(executor.manifest.executorType, 'custom');

    assert.ok(appCtx.services.extensionCatalog);
    assert.equal(appCtx.services.extensionCatalog.gatewayHooks.length, 1);
    assert.equal(appCtx.services.extensionCatalog.providerHooks.length, 1);
    assert.equal(appCtx.services.extensionCatalog.executors.length, 1);
  });
});

async function writeModule(filePath, source) {
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, source.trim() + '\n', 'utf8');
}
