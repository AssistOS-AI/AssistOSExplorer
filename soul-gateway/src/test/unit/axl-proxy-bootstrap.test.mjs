import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { bootstrapAxlProxyProvider } from '../../bootstrap/axl-proxy-bootstrap.mjs';

const SILENT_LOG = { debug() {}, info() {}, warn() {}, error() {} };

function makeAppCtx(env = {}) {
    return { pool: {}, log: SILENT_LOG, config: { env } };
}

function makeDeps({ existingProvider = null } = {}) {
    const calls = { create: [], update: [], upsert: [], autoProvision: [] };
    const providersDao = {
        async findByKey() {
            return existingProvider;
        },
        async create(_pool, spec) {
            calls.create.push(spec);
            return { id: 'prov-1', ...spec };
        },
        async update(_pool, id, fields) {
            calls.update.push({ id, fields });
            return { id, ...fields };
        },
    };
    const upsertProviderApiKeyAccount = async (args) => {
        calls.upsert.push(args);
        return { id: 'acct-1' };
    };
    const autoProvisionModels = async (_ctx, provider, _oauth, opts) => {
        calls.autoProvision.push({ provider, opts });
        return { discovered: 3, created: 3, updated: 0, disabled: 0, models: [] };
    };
    return {
        deps: { providersDao, upsertProviderApiKeyAccount, autoProvisionModels },
        calls,
    };
}

describe('bootstrapAxlProxyProvider', () => {
    it('skips when AXL_PROXY_API_KEY is unset', async () => {
        const { deps, calls } = makeDeps();
        const result = await bootstrapAxlProxyProvider({
            appCtx: makeAppCtx({}),
            deps,
        });
        assert.equal(result.configured, false);
        assert.equal(calls.create.length, 0);
        assert.equal(calls.autoProvision.length, 0);
    });

    it('skips when base URL is missing', async () => {
        const { deps, calls } = makeDeps();
        const result = await bootstrapAxlProxyProvider({
            appCtx: makeAppCtx({ AXL_PROXY_API_KEY: 'k' }),
            deps,
        });
        assert.equal(result.configured, false);
        assert.equal(calls.create.length, 0);
    });

    it('creates the delegating provider, stores the key, and mirrors models', async () => {
        const { deps, calls } = makeDeps();
        const result = await bootstrapAxlProxyProvider({
            appCtx: makeAppCtx({
                AXL_PROXY_API_KEY: 'k',
                AXL_PROXY_BASE_URL: 'https://soul.axiologic.dev/v1/',
            }),
            deps,
        });
        assert.equal(result.configured, true);
        assert.equal(calls.create.length, 1);
        assert.equal(calls.create[0].providerKey, 'axl-proxy');
        assert.equal(calls.create[0].adapterKey, 'openai-api');
        assert.equal(calls.create[0].kind, 'external_api');
        // trailing slash stripped
        assert.equal(calls.create[0].baseUrl, 'https://soul.axiologic.dev/v1');
        assert.equal(calls.upsert.length, 1);
        assert.equal(calls.upsert[0].apiKey, 'k');
        assert.equal(calls.autoProvision.length, 1);
        assert.equal(
            calls.autoProvision[0].opts.refreshReason,
            'axl-proxy-bootstrap'
        );
        assert.equal(result.discovered, 3);
    });

    it('reconciles an existing provider instead of creating one', async () => {
        const existingProvider = {
            id: 'prov-1',
            provider_key: 'axl-proxy',
            display_name: 'Old Name',
            kind: 'external_api',
            adapter_key: 'openai-api',
            auth_strategy: 'api_key',
            base_url: 'https://old.example/v1',
            enabled: true,
        };
        const { deps, calls } = makeDeps({ existingProvider });
        const result = await bootstrapAxlProxyProvider({
            appCtx: makeAppCtx({
                AXL_PROXY_API_KEY: 'k',
                AXL_PROXY_BASE_URL: 'https://soul.axiologic.dev/v1',
            }),
            deps,
        });
        assert.equal(calls.create.length, 0);
        assert.equal(calls.update.length, 1);
        assert.equal(
            calls.update[0].fields.baseUrl,
            'https://soul.axiologic.dev/v1'
        );
        assert.equal(result.discovered, 3);
    });

    it('registers the provider but skips discovery when DISCOVERY_MODE=off', async () => {
        const { deps, calls } = makeDeps();
        const result = await bootstrapAxlProxyProvider({
            appCtx: makeAppCtx({
                AXL_PROXY_API_KEY: 'k',
                AXL_PROXY_BASE_URL: 'https://x/v1',
                AXL_PROXY_DISCOVERY_MODE: 'off',
            }),
            deps,
        });
        assert.equal(result.configured, true);
        assert.equal(calls.create.length, 1);
        assert.equal(calls.autoProvision.length, 0);
    });
});
