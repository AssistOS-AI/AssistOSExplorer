import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { bootstrapLocalLlmProvider } from '../../bootstrap/local-llm-bootstrap.mjs';

const DEFAULT_LOCAL_LLM_ALIASES = [
    'fast',
    'axl/fast',
    'plan',
    'code',
    'write',
    'deep',
    'ultra',
];

function makeAppCtx(
    envOverrides = {},
    existingProvider = null,
    existingModels = []
) {
    const providers = existingProvider ? [existingProvider] : [];
    const accounts = [];
    const models = [...existingModels];
    const aliases = [];
    let nextId = 1;

    const env = {
        SOUL_GATEWAY_MODE: 'embedded',
        DATABASE_URL: 'postgres://localhost/test',
        LOCAL_LLM_BASE_URL: 'https://lmstudio.axiologic.dev/v1',
        LOCAL_LLM_MODEL: 'gemma-3-12b-it',
        LOCAL_LLM_API_KEY: null,
        LOCAL_LLM_DISCOVERY_MODE: 'single',
        LOCAL_LLM_ALIASES: DEFAULT_LOCAL_LLM_ALIASES.join(','),
        ...envOverrides,
    };

    const pool = {
        async query(sql, params) {
            if (sql.includes('INSERT INTO soul_gateway.providers')) {
                const row = {
                    id: nextId++,
                    provider_key: params[0],
                    display_name: params[1],
                    kind: params[2],
                    adapter_key: params[3],
                    auth_strategy: params[4],
                    base_url: params[7],
                    enabled: params[8],
                };
                providers.push(row);
                return { rows: [row] };
            }
            if (sql.includes('UPDATE soul_gateway.providers')) {
                const found = providers.find(
                    (provider) => provider.id === params[0]
                );
                if (found) {
                    found.auth_strategy = params[1];
                    return { rows: [found] };
                }
                return { rows: [] };
            }
            if (sql.includes('INSERT INTO soul_gateway.models')) {
                const row = {
                    id: nextId++,
                    model_key: params[0],
                    display_name: params[1],
                    provider_id: params[2],
                    provider_model_id: params[3],
                    enabled: true,
                };
                models.push(row);
                return { rows: [row] };
            }
            if (sql.includes('INSERT INTO soul_gateway.model_aliases')) {
                const row = {
                    id: nextId++,
                    alias: params[0],
                    model_id: params[1],
                };
                aliases.push(row);
                return { rows: [row] };
            }
            if (sql.includes('FROM soul_gateway.model_aliases')) {
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
            if (sql.includes('FROM soul_gateway.models WHERE provider_id')) {
                const rows = models.filter((model) => (
                    model.provider_id === params[0] &&
                    (params.length < 2 || model.enabled === params[1])
                ));
                return { rows };
            }
            if (sql.includes('INSERT INTO soul_gateway.provider_accounts')) {
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
            if (sql.includes('UPDATE soul_gateway.provider_accounts')) {
                const found = accounts.find(
                    (account) => account.id === params[0]
                );
                if (found) {
                    found.secret_ciphertext = params[1];
                    found.secret_iv = params[2];
                    found.secret_auth_tag = params[3];
                    found.secret_hint = params[4];
                    found.status = 'active';
                    return { rows: [found] };
                }
                return { rows: [] };
            }
            if (sql.includes('FROM soul_gateway.provider_accounts')) {
                const rows = accounts.filter(
                    (account) => (
                        account.provider_id === params[0] &&
                        account.deleted_at === null
                    )
                );
                return { rows };
            }
            if (sql.includes('FROM soul_gateway.providers WHERE provider_key')) {
                const found = providers.find((p) => p.provider_key === params[0]);
                return { rows: found ? [found] : [] };
            }
            return { rows: [] };
        },
    };

    const logs = [];
    const log = {
        info: (msg, data) => logs.push({ level: 'info', msg, data }),
        warn: (msg, data) => logs.push({ level: 'warn', msg, data }),
    };

    return {
        appCtx: {
            config: { env },
            pool,
            log,
            services: {
                encryptionKey: Buffer.alloc(32, 1),
                backendCatalog: {
                    get: () => null,
                },
            },
        },
        providers,
        accounts,
        models,
        aliases,
        logs,
    };
}

describe('bootstrapLocalLlmProvider', () => {
    it('skips when not in embedded mode', async () => {
        const { appCtx, providers } = makeAppCtx({
            SOUL_GATEWAY_MODE: null,
        });
        await bootstrapLocalLlmProvider(appCtx);
        assert.equal(providers.length, 0);
    });

    it('skips when DATABASE_URL is not set', async () => {
        const { appCtx, providers } = makeAppCtx({
            DATABASE_URL: null,
        });
        await bootstrapLocalLlmProvider(appCtx);
        assert.equal(providers.length, 0);
    });

    it('skips when provider already exists', async () => {
        const existing = {
            id: 99,
            provider_key: 'local-llm',
            display_name: 'Local LLM',
        };
        const { appCtx, providers, logs } = makeAppCtx({}, existing);
        await bootstrapLocalLlmProvider(appCtx);
        assert.equal(providers.length, 1);
        assert.equal(providers[0].id, 99);
        assert.ok(logs.some((l) => l.msg.includes('already exists')));
    });

    it('upgrades an existing no-auth provider when LOCAL_LLM_API_KEY appears', async () => {
        const existing = {
            id: 99,
            provider_key: 'local-llm',
            display_name: 'Local LLM',
            auth_strategy: 'none',
        };
        const { appCtx, providers, accounts, logs } = makeAppCtx(
            { LOCAL_LLM_API_KEY: 'lmstudio-secret-token' },
            existing,
        );

        await bootstrapLocalLlmProvider(appCtx);

        assert.equal(providers.length, 1);
        assert.equal(providers[0].auth_strategy, 'api_key');
        assert.equal(accounts.length, 1);
        assert.equal(accounts[0].provider_id, 99);
        assert.equal(accounts[0].auth_type, 'api_key');
        assert.ok(
            logs.some((l) => l.msg.includes('auth strategy updated'))
        );
    });

    it('creates local aliases for an existing provider model', async () => {
        const existingProvider = {
            id: 99,
            provider_key: 'local-llm',
            display_name: 'Local LLM',
        };
        const existingModels = [{
            id: 'model-99',
            model_key: 'local-llm/gemma-3-12b-it',
            display_name: 'gemma-3-12b-it',
            provider_id: 99,
            enabled: true,
        }];
        const { appCtx, providers, models, aliases } = makeAppCtx(
            {},
            existingProvider,
            existingModels,
        );
        await bootstrapLocalLlmProvider(appCtx);
        assert.equal(providers.length, 1);
        assert.equal(models.length, 1);
        assert.deepEqual(
            aliases.map((row) => row.alias),
            DEFAULT_LOCAL_LLM_ALIASES,
        );
        assert.ok(aliases.every((row) => row.model_id === 'model-99'));
    });

    it('skips when LOCAL_LLM_BASE_URL is not set', async () => {
        const { appCtx, providers, logs } = makeAppCtx({
            LOCAL_LLM_BASE_URL: null,
        });
        await bootstrapLocalLlmProvider(appCtx);
        assert.equal(providers.length, 0);
        assert.ok(logs.some((l) => l.level === 'warn'));
    });

    it('creates provider with correct fields', async () => {
        const { appCtx, providers } = makeAppCtx();
        await bootstrapLocalLlmProvider(appCtx);
        assert.equal(providers.length, 1);
        assert.equal(providers[0].provider_key, 'local-llm');
        assert.equal(providers[0].display_name, 'Local LLM');
        assert.equal(providers[0].kind, 'local_model');
        assert.equal(providers[0].adapter_key, 'openai-api');
        assert.equal(providers[0].auth_strategy, 'none');
        assert.equal(
            providers[0].base_url,
            'https://lmstudio.axiologic.dev/v1',
        );
    });

    it('creates configured fallback model in single discovery mode', async () => {
        const { appCtx, models, aliases, logs } = makeAppCtx();
        await bootstrapLocalLlmProvider(appCtx);
        assert.equal(models.length, 1);
        assert.equal(models[0].model_key, 'local-llm/gemma-3-12b-it');
        assert.equal(models[0].display_name, 'gemma-3-12b-it');
        assert.deepEqual(
            aliases.map((row) => row.alias),
            DEFAULT_LOCAL_LLM_ALIASES,
        );
        assert.ok(aliases.every((row) => row.model_id === models[0].id));
        assert.ok(logs.some((l) => l.msg.includes('fallback model')));
        assert.equal(
            logs.some((l) => l.msg.includes('auto-provision discovery failed')),
            false
        );
    });

    it('uses LOCAL_LLM_ALIASES to override compatibility aliases', async () => {
        const { appCtx, models, aliases } = makeAppCtx({
            LOCAL_LLM_ALIASES: 'quick, local/default ,,',
        });
        await bootstrapLocalLlmProvider(appCtx);
        assert.equal(models.length, 1);
        assert.deepEqual(
            aliases.map((row) => row.alias),
            ['quick', 'local/default'],
        );
    });

    it('attempts endpoint discovery in auto mode before fallback', async () => {
        const { appCtx, models, logs } = makeAppCtx({
            LOCAL_LLM_DISCOVERY_MODE: 'auto',
        });
        await bootstrapLocalLlmProvider(appCtx);
        assert.equal(models.length, 1);
        assert.ok(
            logs.some((l) => l.msg.includes('auto-provision discovery failed'))
        );
    });

    it('stores encrypted API key account when LOCAL_LLM_API_KEY is set', async () => {
        const { appCtx, providers, accounts } = makeAppCtx({
            LOCAL_LLM_API_KEY: 'lmstudio-secret-token',
        });
        await bootstrapLocalLlmProvider(appCtx);
        assert.equal(providers.length, 1);
        assert.equal(providers[0].auth_strategy, 'api_key');
        assert.equal(accounts.length, 1);
        assert.equal(accounts[0].provider_id, providers[0].id);
        assert.equal(accounts[0].auth_type, 'api_key');
        assert.equal(accounts[0].status, 'active');
        assert.equal(accounts[0].secret_hint, 'lmstud...oken');
        assert.ok(Buffer.isBuffer(accounts[0].secret_ciphertext));
        assert.ok(Buffer.isBuffer(accounts[0].secret_iv));
        assert.ok(Buffer.isBuffer(accounts[0].secret_auth_tag));
    });

    it('skips fallback model when LOCAL_LLM_MODEL is "auto"', async () => {
        const { appCtx, models, logs } = makeAppCtx({
            LOCAL_LLM_MODEL: 'auto',
        });
        await bootstrapLocalLlmProvider(appCtx);
        assert.equal(models.length, 0);
        assert.ok(
            logs.some((l) => l.level === 'warn' && l.msg.includes('no models'))
        );
    });

    it('skips fallback model when LOCAL_LLM_MODEL is not set', async () => {
        const { appCtx, models } = makeAppCtx({
            LOCAL_LLM_MODEL: null,
        });
        await bootstrapLocalLlmProvider(appCtx);
        assert.equal(models.length, 0);
    });
});
