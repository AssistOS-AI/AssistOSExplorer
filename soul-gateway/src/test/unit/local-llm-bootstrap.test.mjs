import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { bootstrapLocalLlmProvider } from '../../bootstrap/local-llm-bootstrap.mjs';

function makeAppCtx(envOverrides = {}, existingProvider = null) {
    const providers = existingProvider ? [existingProvider] : [];
    const accounts = [];
    const models = [];
    let nextId = 1;

    const env = {
        SOUL_GATEWAY_MODE: 'embedded',
        DATABASE_URL: 'postgres://localhost/test',
        LOCAL_LLM_BASE_URL: 'https://lmstudio.axiologic.dev/v1',
        LOCAL_LLM_MODEL: 'gemma-3-12b-it',
        LOCAL_LLM_API_KEY: null,
        LOCAL_LLM_DISCOVERY_MODE: 'single',
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
            if (sql.includes('INSERT INTO soul_gateway.models')) {
                const row = {
                    id: nextId++,
                    model_key: params[0],
                    display_name: params[1],
                    provider_id: params[2],
                    provider_model_id: params[3],
                };
                models.push(row);
                return { rows: [row] };
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
        const { appCtx, models, logs } = makeAppCtx();
        await bootstrapLocalLlmProvider(appCtx);
        assert.equal(models.length, 1);
        assert.equal(models[0].model_key, 'local-llm/gemma-3-12b-it');
        assert.equal(models[0].display_name, 'gemma-3-12b-it');
        assert.ok(logs.some((l) => l.msg.includes('fallback model')));
        assert.equal(
            logs.some((l) => l.msg.includes('auto-provision discovery failed')),
            false
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
