import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createCipheriv, randomBytes } from 'node:crypto';
import {
    buildMainBranchImportPlan,
    importMainBranchData,
    resolveProviderImportSpec,
} from '../../db/import/main-branch-importer.mjs';
import {
    decryptLegacyBlob,
    decodeEncryptionKey,
} from '../../db/import/main-branch-crypto.mjs';

const LEGACY_ALGO = 'aes-256-gcm';

describe('main-branch legacy crypto helpers', () => {
    it('decodes a hex key and decrypts the legacy blob format', () => {
        const key = randomBytes(32);
        const blob = encryptLegacyBlob('legacy-secret', key);

        const decoded = decodeEncryptionKey(key.toString('hex'));
        const plaintext = decryptLegacyBlob(blob, decoded);

        assert.equal(plaintext, 'legacy-secret');
    });
});

describe('resolveProviderImportSpec', () => {
    it('maps managed Codex providers to the codex transport', () => {
        const spec = resolveProviderImportSpec({
            name: 'codex',
            auth_type: 'managed',
            protocol: 'openai',
            base_url: 'https://chatgpt.com/backend-api/codex/responses',
        });

        assert.equal(spec.adapterKey, 'codex-api');
        assert.equal(spec.authStrategy, 'oauth');
        assert.equal(spec.oauthAdapterKey, 'openai-codex');
        assert.equal(spec.baseUrl, 'https://chatgpt.com/backend-api/codex');
    });

    it('maps standard OpenAI-compatible providers to openai-api', () => {
        const spec = resolveProviderImportSpec({
            name: 'openai',
            auth_type: 'api_key',
            protocol: 'openai',
            base_url: 'https://api.openai.com/v1/chat/completions',
        });

        assert.equal(spec.adapterKey, 'openai-api');
        assert.equal(spec.authStrategy, 'api_key');
        assert.equal(spec.baseUrl, 'https://api.openai.com/v1');
    });
});

describe('buildMainBranchImportPlan', () => {
    it('maps tiers to cascade models and legacy middleware names to current middleware keys', () => {
        const sourceKey = randomBytes(32);
        const targetKey = randomBytes(32);
        const source = {
            providers: [
                {
                    id: 'prov-src-1',
                    name: 'openai',
                    display_name: 'OpenAI',
                    protocol: 'openai',
                    base_url: 'https://api.openai.com/v1/chat/completions',
                    encrypted_api_key: encryptLegacyBlob(
                        'sk-provider',
                        sourceKey
                    ),
                    key_hint: 'sk-prov...ider',
                    billing_type: 'api_key',
                    auth_type: 'api_key',
                    is_enabled: true,
                },
            ],
            apiKeys: [
                {
                    id: 'key-src-1',
                    label: 'Prod Key',
                    encrypted_key: encryptLegacyBlob(
                        'sk-soul-secret',
                        sourceKey
                    ),
                    key_hint: 'sk-soul...cret',
                    rpm_limit: 120,
                    tpm_limit: 250000,
                    monthly_budget: '10',
                    daily_budget: '2',
                    expires_at: null,
                    is_revoked: false,
                    last_used_at: null,
                    created_at: '2026-04-01T00:00:00.000Z',
                },
            ],
            models: [
                {
                    id: 'model-src-1',
                    name: 'gpt-4o',
                    display_name: 'GPT-4o',
                    type: 'model',
                    provider_config_id: 'prov-src-1',
                    provider_key: 'openai',
                    provider_model: 'gpt-4o',
                    upstream_model: null,
                    upstream_source: 'provider-sync',
                    mode: 'fast',
                    input_price: '5',
                    output_price: '15',
                    pricing_type: 'token',
                    request_cost: '0',
                    is_free: false,
                    is_enabled: true,
                    max_concurrency: 8,
                    sort_order: 10,
                    context_window: '128k',
                    tags: ['general'],
                },
                {
                    id: 'tier-src-1',
                    name: 'fast',
                    display_name: 'Fast',
                    type: 'tier',
                    model_refs: ['gpt-4o'],
                    fallback_model: null,
                    is_enabled: true,
                    sort_order: 100,
                    tags: [],
                },
            ],
            middlewares: [],
            modelMiddlewares: [
                {
                    id: 'mw-bind-src-1',
                    model_config_id: 'tier-src-1',
                    middleware_name: 'cache',
                    is_enabled: true,
                    sort_order: 20,
                    settings: { ttlMs: 1000 },
                },
            ],
        };

        const plan = buildMainBranchImportPlan({
            source,
            targetMiddlewareRows: [{ middleware_key: 'response-cache' }],
            sourceEncryptionKey: sourceKey,
            targetEncryptionKey: targetKey,
            targetApiKeyPepper: 'pepper',
        });

        assert.equal(plan.report.warnings.length, 0);
        assert.equal(plan.report.counts.providers, 1);
        assert.equal(plan.report.counts.providerAccounts, 1);
        assert.equal(plan.report.counts.directModels, 1);
        assert.equal(plan.report.counts.cascadeModels, 1);
        assert.equal(plan.report.counts.middlewareBindings, 1);
        assert.equal(plan.providerPlans[0].target.adapterKey, 'openai-api');
        assert.equal(plan.directModelPlans[0].target.strategyKind, 'direct');
        assert.equal(plan.cascadeModelPlans[0].target.strategyKind, 'cascade');
        assert.equal(
            plan.cascadeModelPlans[0].childModelRefs[0].sourceModelId,
            'model-src-1'
        );
        assert.equal(
            plan.modelBindingPlans[0].target.middlewareKey,
            'response-cache'
        );
    });
});

describe('importMainBranchData', () => {
    it('imports providers, api keys, models, model children, and middleware bindings', async () => {
        const sourceKey = randomBytes(32);
        const targetKey = randomBytes(32);
        const sourceRows = {
            providers: [
                {
                    id: 'prov-src-1',
                    name: 'openai',
                    display_name: 'OpenAI',
                    protocol: 'openai',
                    base_url: 'https://api.openai.com/v1/chat/completions',
                    encrypted_api_key: encryptLegacyBlob(
                        'sk-provider',
                        sourceKey
                    ),
                    key_hint: 'sk-prov...ider',
                    billing_type: 'api_key',
                    auth_type: 'api_key',
                    is_enabled: true,
                },
            ],
            apiKeys: [
                {
                    id: 'key-src-1',
                    label: 'Prod Key',
                    encrypted_key: encryptLegacyBlob(
                        'sk-soul-secret',
                        sourceKey
                    ),
                    key_hint: 'sk-soul...cret',
                    rpm_limit: 120,
                    tpm_limit: 250000,
                    monthly_budget: '10',
                    daily_budget: '2',
                    expires_at: null,
                    is_revoked: false,
                    last_used_at: null,
                    created_at: '2026-04-01T00:00:00.000Z',
                },
            ],
            models: [
                {
                    id: 'model-src-1',
                    name: 'gpt-4o',
                    display_name: 'GPT-4o',
                    type: 'model',
                    provider_config_id: 'prov-src-1',
                    provider_key: 'openai',
                    provider_model: 'gpt-4o',
                    upstream_model: null,
                    upstream_source: 'provider-sync',
                    mode: 'fast',
                    input_price: '5',
                    output_price: '15',
                    pricing_type: 'token',
                    request_cost: '0',
                    is_free: false,
                    is_enabled: true,
                    max_concurrency: 8,
                    sort_order: 10,
                    context_window: '128k',
                    tags: ['general'],
                },
                {
                    id: 'tier-src-1',
                    name: 'fast',
                    display_name: 'Fast',
                    type: 'tier',
                    model_refs: ['gpt-4o'],
                    fallback_model: null,
                    is_enabled: true,
                    sort_order: 100,
                    tags: [],
                },
            ],
            middlewares: [],
            modelMiddlewares: [
                {
                    id: 'mw-bind-src-1',
                    model_config_id: 'tier-src-1',
                    middleware_name: 'cache',
                    is_enabled: true,
                    sort_order: 20,
                    settings: { ttlMs: 1000 },
                },
            ],
        };

        const sourcePool = {
            async query(sql) {
                if (sql.includes('FROM soul_gateway.provider_configs'))
                    return { rows: sourceRows.providers };
                if (sql.includes('FROM soul_gateway.api_keys'))
                    return { rows: sourceRows.apiKeys };
                if (sql.includes('FROM soul_gateway.model_configs'))
                    return { rows: sourceRows.models };
                if (
                    sql.includes('FROM soul_gateway.middlewares') &&
                    !sql.includes('JOIN')
                )
                    return { rows: sourceRows.middlewares };
                if (sql.includes('FROM soul_gateway.model_middlewares'))
                    return { rows: sourceRows.modelMiddlewares };
                throw new Error(`Unexpected source query: ${sql}`);
            },
        };

        const targetQueries = [];
        const targetPool = {
            async query(sql) {
                if (sql.includes('information_schema.columns'))
                    return { rows: [{ ok: true }] };
                if (sql.includes("to_regclass('soul_gateway.model_children')"))
                    return {
                        rows: [{ regclass: 'soul_gateway.model_children' }],
                    };
                if (
                    sql.includes(
                        "to_regclass('soul_gateway.middleware_bindings')"
                    )
                )
                    return {
                        rows: [
                            { regclass: 'soul_gateway.middleware_bindings' },
                        ],
                    };
                if (sql.includes("to_regclass('soul_gateway.audit_logs')"))
                    return { rows: [{ regclass: 'soul_gateway.audit_logs' }] };
                if (sql.includes("to_regclass('soul_gateway.sessions')"))
                    return { rows: [{ regclass: 'soul_gateway.sessions' }] };
                if (sql.includes('FROM soul_gateway.middlewares'))
                    return { rows: [{ middleware_key: 'response-cache' }] };
                throw new Error(`Unexpected target pool query: ${sql}`);
            },
            async connect() {
                return {
                    async query(sql, params) {
                        targetQueries.push({ sql, params });
                        if (
                            sql === 'BEGIN' ||
                            sql === 'COMMIT' ||
                            sql === 'ROLLBACK'
                        )
                            return { rows: [], rowCount: 0 };
                        if (
                            sql.includes('INSERT INTO soul_gateway.providers')
                        ) {
                            return {
                                rows: [
                                    {
                                        id: 'prov-target-1',
                                        provider_key: params[0],
                                    },
                                ],
                            };
                        }
                        if (
                            sql.includes('FROM soul_gateway.provider_accounts')
                        ) {
                            return { rows: [] };
                        }
                        if (
                            sql.includes(
                                'INSERT INTO soul_gateway.provider_accounts'
                            )
                        ) {
                            return { rows: [{ id: 'acct-target-1' }] };
                        }
                        if (sql.includes('INSERT INTO soul_gateway.models')) {
                            return {
                                rows: [
                                    {
                                        id: `target-${params[0]}`,
                                        model_key: params[0],
                                    },
                                ],
                            };
                        }
                        if (
                            sql.includes(
                                'DELETE FROM soul_gateway.model_children'
                            )
                        ) {
                            return { rows: [], rowCount: 1 };
                        }
                        if (
                            sql.includes(
                                'INSERT INTO soul_gateway.model_children'
                            )
                        ) {
                            return {
                                rows: [{ id: 'child-target-1' }],
                                rowCount: 1,
                            };
                        }
                        if (sql.includes('INSERT INTO soul_gateway.api_keys')) {
                            return { rows: [{ id: 'key-target-1' }] };
                        }
                        if (
                            sql.includes(
                                'INSERT INTO soul_gateway.middleware_bindings'
                            )
                        ) {
                            return { rows: [{ id: 'bind-target-1' }] };
                        }
                        throw new Error(
                            `Unexpected target client query: ${sql}`
                        );
                    },
                    release() {},
                };
            },
        };

        const report = await importMainBranchData({
            sourcePool,
            targetPool,
            sourceEncryptionKey: sourceKey,
            targetEncryptionKey: targetKey,
            targetApiKeyPepper: 'pepper',
        });

        assert.equal(report.warnings.length, 0);
        assert.ok(
            targetQueries.some((q) =>
                q.sql.includes('INSERT INTO soul_gateway.providers')
            )
        );
        assert.ok(
            targetQueries.some((q) =>
                q.sql.includes('INSERT INTO soul_gateway.provider_accounts')
            )
        );
        assert.ok(
            targetQueries.some((q) =>
                q.sql.includes('INSERT INTO soul_gateway.api_keys')
            )
        );
        assert.ok(
            targetQueries.some((q) =>
                q.sql.includes('INSERT INTO soul_gateway.model_children')
            )
        );
        assert.ok(
            targetQueries.some((q) =>
                q.sql.includes('INSERT INTO soul_gateway.middleware_bindings')
            )
        );
    });
});

function encryptLegacyBlob(plaintext, key) {
    const iv = randomBytes(12);
    const cipher = createCipheriv(LEGACY_ALGO, key, iv);
    const ciphertext = Buffer.concat([
        cipher.update(plaintext, 'utf8'),
        cipher.final(),
    ]);
    const authTag = cipher.getAuthTag();
    return Buffer.concat([iv, authTag, ciphertext]);
}
