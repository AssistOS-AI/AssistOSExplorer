import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
    bootstrapSoulGatewayProvider,
} from '../../bootstrap/soul-gateway-provider-bootstrap.mjs';

function parseProviderUpdateFields(sql) {
    const match = sql.match(/SET (.*), updated_at = now\(\) WHERE id = \$1/s);
    if (!match) return [];
    return match[1]
        .split(',')
        .map((clause) => clause.trim().split(/\s*=\s*/)[0])
        .filter(Boolean);
}

function makeAppCtx({
    envOverrides = {},
    existingProvider = null,
    existingAccounts = [],
    existingModels = [],
    existingAliases = [],
    discoveries = [
        { modelId: 'fast', displayName: 'fast' },
        { modelId: 'plan', displayName: 'plan' },
    ],
} = {}) {
    const providers = existingProvider ? [existingProvider] : [];
    const accounts = [...existingAccounts];
    const models = [...existingModels];
    const aliases = [...existingAliases];
    let nextId = 1;

    const env = {
        SOUL_GATEWAY_PROVIDER_API_KEY: 'provider-secret',
        SOUL_GATEWAY_PROVIDER_BASE_URL: 'https://soul.axiologic.dev/v1/',
        SOUL_GATEWAY_PROVIDER_DISCOVERY_MODE: 'auto',
        SOUL_GATEWAY_PROVIDER_ALIASES: 'fast,plan,code',
        ...envOverrides,
    };

    const pool = {
        async query(sql, params) {
            if (sql.includes('INSERT INTO providers')) {
                const row = {
                    id: nextId++,
                    provider_key: params[0],
                    display_name: params[1],
                    kind: params[2],
                    adapter_key: params[3],
                    auth_strategy: params[4],
                    provider_mode: params[5],
                    oauth_adapter_key: params[6],
                    base_url: params[7],
                    enabled: params[8],
                    supports_streaming: params[9],
                    supports_tools: params[10],
                    supports_messages_api: params[11],
                    supports_responses_api: params[12],
                    settings: JSON.parse(params[13]),
                    metadata: JSON.parse(params[14]),
                };
                providers.push(row);
                return { rows: [row] };
            }
            if (sql.includes('UPDATE providers SET')) {
                const found = providers.find(
                    (provider) => provider.id === params[0]
                );
                if (!found) return { rows: [] };
                const fields = parseProviderUpdateFields(sql);
                fields.forEach((field, index) => {
                    found[field] = params[index + 1];
                });
                return { rows: [found] };
            }
            if (sql.includes('FROM providers WHERE provider_key')) {
                const found = providers.find((p) => p.provider_key === params[0]);
                return { rows: found ? [found] : [] };
            }
            if (sql.includes('INSERT INTO provider_accounts')) {
                const row = {
                    id: nextId++,
                    provider_id: params[0],
                    account_label: params[1],
                    auth_type: params[2],
                    status: params[3],
                    secret_ciphertext: params[5],
                    secret_iv: params[6],
                    secret_auth_tag: params[7],
                    secret_hint: params[8],
                    deleted_at: null,
                };
                accounts.push(row);
                return { rows: [row] };
            }
            if (sql.includes('UPDATE provider_accounts')) {
                const found = accounts.find(
                    (account) => account.id === params[0]
                );
                if (!found) return { rows: [] };
                found.secret_ciphertext = params[1];
                found.secret_iv = params[2];
                found.secret_auth_tag = params[3];
                found.secret_hint = params[4];
                found.status = 'active';
                return { rows: [found] };
            }
            if (sql.includes('FROM provider_accounts')) {
                const rows = accounts.filter(
                    (account) => (
                        account.provider_id === params[0] &&
                        account.deleted_at === null
                    )
                );
                return { rows };
            }
            if (sql.includes('INSERT INTO models')) {
                const row = {
                    id: nextId++,
                    model_key: params[0],
                    display_name: params[1],
                    provider_id: params[2],
                    provider_model_id: params[3],
                    enabled: params[5],
                    discovery_source: params[21],
                    metadata: JSON.parse(params[22]),
                };
                models.push(row);
                return { rows: [row] };
            }
            if (sql.includes('FROM models WHERE provider_id')) {
                const rows = models.filter((model) => (
                    model.provider_id === params[0] &&
                    (params.length < 2 || model.enabled === params[1])
                ));
                return { rows };
            }
            if (sql.includes('INSERT INTO model_aliases')) {
                const row = {
                    id: nextId++,
                    alias: params[0],
                    model_id: params[1],
                };
                aliases.push(row);
                return { rows: [row] };
            }
            if (sql.includes('UPDATE model_aliases')) {
                const found = aliases.find((alias) => alias.alias === params[0]);
                if (!found) return { rows: [] };
                found.model_id = params[1];
                return { rows: [found] };
            }
            if (sql.includes('FROM model_aliases')) {
                const found = aliases.find((alias) => alias.alias === params[0]);
                const model = found
                    ? models.find((entry) => entry.id === found.model_id)
                    : null;
                return {
                    rows: found && model
                        ? [{ ...found, model_key: model.model_key }]
                        : [],
                };
            }
            return { rows: [] };
        },
    };

    const logs = [];
    const log = {
        info: (msg, data) => logs.push({ level: 'info', msg, data }),
        warn: (msg, data) => logs.push({ level: 'warn', msg, data }),
    };

    const backendCatalog = {
        getBackend(key) {
            assert.equal(key, 'openai-api');
            return {
                discoverModels: async () => discoveries,
            };
        },
    };

    return {
        appCtx: {
            config: { env },
            pool,
            log,
            services: {
                encryptionKey: Buffer.alloc(32, 1),
                backendCatalog,
            },
        },
        providers,
        accounts,
        models,
        aliases,
        logs,
    };
}

describe('bootstrapSoulGatewayProvider', () => {
    it('skips when SOUL_GATEWAY_PROVIDER_API_KEY is not set', async () => {
        const { appCtx, providers } = makeAppCtx({
            envOverrides: { SOUL_GATEWAY_PROVIDER_API_KEY: null },
        });

        await bootstrapSoulGatewayProvider(appCtx);

        assert.equal(providers.length, 0);
    });

    it('creates provider, stores provider key, discovers models, and mirrors aliases', async () => {
        const { appCtx, providers, accounts, models, aliases } = makeAppCtx();

        await bootstrapSoulGatewayProvider(appCtx);

        assert.equal(providers.length, 1);
        assert.equal(providers[0].provider_key, 'soul-gateway');
        assert.equal(providers[0].display_name, 'Soul Gateway');
        assert.equal(providers[0].kind, 'external_api');
        assert.equal(providers[0].adapter_key, 'openai-api');
        assert.equal(providers[0].auth_strategy, 'api_key');
        assert.equal(providers[0].base_url, 'https://soul.axiologic.dev/v1');
        assert.equal(accounts.length, 1);
        assert.equal(accounts[0].provider_id, providers[0].id);
        assert.equal(accounts[0].auth_type, 'api_key');
        assert.equal(accounts[0].secret_hint, 'provid...cret');
        assert.deepEqual(
            models.map((model) => model.model_key),
            ['soul-gateway/fast', 'soul-gateway/plan']
        );
        assert.deepEqual(
            aliases.map((alias) => alias.alias),
            ['fast', 'plan']
        );
    });

    it('reassigns configured aliases from local-llm fallback models', async () => {
        const { appCtx, models, aliases, logs } = makeAppCtx({
            existingModels: [{
                id: 'local-model-fast',
                model_key: 'local-llm/gemma-3-12b-it',
                provider_id: 'local-provider',
                enabled: true,
            }],
            existingAliases: [{
                id: 'alias-fast',
                alias: 'fast',
                model_id: 'local-model-fast',
            }],
        });

        await bootstrapSoulGatewayProvider(appCtx);

        const remoteFast = models.find(
            (model) => model.model_key === 'soul-gateway/fast'
        );
        const fastAlias = aliases.find((alias) => alias.alias === 'fast');
        assert.ok(remoteFast);
        assert.equal(fastAlias.model_id, remoteFast.id);
        assert.ok(
            logs.some((entry) => entry.msg.includes('alias reassigned'))
        );
    });

    it('reconciles an existing Soul Gateway provider and refreshes its account', async () => {
        const existingProvider = {
            id: 42,
            provider_key: 'soul-gateway',
            display_name: 'Old Gateway',
            kind: 'custom',
            adapter_key: 'unknown',
            auth_strategy: 'none',
            base_url: 'https://old.example/v1',
            enabled: false,
            supports_streaming: false,
            supports_tools: false,
        };
        const { appCtx, providers, accounts } = makeAppCtx({
            existingProvider,
            discoveries: [],
        });

        await bootstrapSoulGatewayProvider(appCtx);

        assert.equal(providers.length, 1);
        assert.equal(providers[0].display_name, 'Soul Gateway');
        assert.equal(providers[0].kind, 'external_api');
        assert.equal(providers[0].adapter_key, 'openai-api');
        assert.equal(providers[0].auth_strategy, 'api_key');
        assert.equal(providers[0].base_url, 'https://soul.axiologic.dev/v1');
        assert.equal(providers[0].enabled, true);
        assert.equal(providers[0].supports_streaming, true);
        assert.equal(providers[0].supports_tools, true);
        assert.equal(accounts.length, 1);
        assert.equal(accounts[0].provider_id, 42);
        assert.equal(accounts[0].account_label, 'Soul Gateway API Key');
    });

    it('can create only the provider and account when discovery is off', async () => {
        const { appCtx, providers, models } = makeAppCtx({
            envOverrides: {
                SOUL_GATEWAY_PROVIDER_DISCOVERY_MODE: 'off',
            },
            discoveries: [
                { modelId: 'should-not-be-discovered' },
            ],
        });

        await bootstrapSoulGatewayProvider(appCtx);

        assert.equal(providers.length, 1);
        assert.equal(models.length, 0);
    });

    it('is idempotent across repeated startup runs', async () => {
        const { appCtx, providers, accounts, models } = makeAppCtx({
            envOverrides: {
                SOUL_GATEWAY_PROVIDER_DISCOVERY_MODE: 'off',
            },
        });

        await bootstrapSoulGatewayProvider(appCtx);
        await bootstrapSoulGatewayProvider(appCtx);

        assert.equal(providers.length, 1);
        assert.equal(accounts.length, 1);
        assert.equal(accounts[0].auth_type, 'api_key');
        assert.equal(models.length, 0);
    });
});
