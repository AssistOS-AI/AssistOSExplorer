import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { bootstrapLocalLlmProvider } from '../../bootstrap/local-llm-bootstrap.mjs';

function makeAppCtx(envOverrides = {}, existingProvider = null) {
    const providers = existingProvider ? [existingProvider] : [];
    const models = [];
    let nextId = 1;

    const env = {
        SOUL_GATEWAY_MODE: 'embedded',
        DATABASE_URL: 'postgres://localhost/test',
        LOCAL_LLM_BASE_URL: 'http://host.containers.internal:11434/v1',
        LOCAL_LLM_MODEL: 'gemma4:e2b',
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
                backendCatalog: {
                    get: () => null,
                },
            },
        },
        providers,
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
            'http://host.containers.internal:11434/v1',
        );
    });

    it('creates fallback model when discovery fails', async () => {
        const { appCtx, models, logs } = makeAppCtx();
        await bootstrapLocalLlmProvider(appCtx);
        assert.equal(models.length, 1);
        assert.equal(models[0].model_key, 'local-llm/gemma4:e2b');
        assert.equal(models[0].display_name, 'gemma4:e2b');
        assert.ok(logs.some((l) => l.msg.includes('fallback model')));
    });

    it('skips fallback model when LOCAL_LLM_MODEL is "auto"', async () => {
        const { appCtx, models, logs } = makeAppCtx({
            LOCAL_LLM_MODEL: 'auto',
        });
        await bootstrapLocalLlmProvider(appCtx);
        assert.equal(models.length, 0);
        assert.ok(logs.some((l) => l.level === 'warn' && l.msg.includes('no models')));
    });

    it('skips fallback model when LOCAL_LLM_MODEL is not set', async () => {
        const { appCtx, models } = makeAppCtx({
            LOCAL_LLM_MODEL: null,
        });
        await bootstrapLocalLlmProvider(appCtx);
        assert.equal(models.length, 0);
    });
});
