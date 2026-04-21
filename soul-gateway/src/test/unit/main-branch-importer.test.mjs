import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createCipheriv, randomBytes } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
    buildMainBranchImportPlan,
    importMainBranchData,
    resolveProviderImportSpec,
} from '../../db/import/main-branch-importer.mjs';
import {
    decryptLegacyBlob,
    decryptLegacyBlobWithKeys,
    decodeEncryptionKey,
    resolveSourceEncryptionKeys,
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

    it('accepts multiple source encryption keys and decrypts with the matching one', () => {
        const wrongKey = randomBytes(32);
        const rightKey = randomBytes(32);
        const blob = encryptLegacyBlob('legacy-secret', rightKey);
        const keys = resolveSourceEncryptionKeys({
            SOURCE_ENCRYPTION_KEYS: [
                wrongKey.toString('hex'),
                rightKey.toString('hex'),
            ].join(','),
        });

        assert.equal(keys.length, 2);
        assert.equal(
            decryptLegacyBlobWithKeys(blob, keys, {
                label: 'test blob',
            }),
            'legacy-secret'
        );
    });
});

describe('resolveProviderImportSpec', () => {
    it('maps managed Anthropic providers to the claude.ai oauth transport', () => {
        const spec = resolveProviderImportSpec({
            name: 'anthropic',
            auth_type: 'managed',
            protocol: 'openai',
            base_url: 'https://api.anthropic.com/v1/messages',
        });

        assert.equal(spec.adapterKey, 'claudeai-api');
        assert.equal(spec.authStrategy, 'oauth');
        assert.equal(spec.oauthAdapterKey, 'anthropic-claudeai');
        assert.equal(spec.baseUrl, 'https://api.anthropic.com');
    });

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

    it('builds oauth provider accounts and historical aliases for managed providers', () => {
        const source = {
            providers: [
                {
                    id: 'prov-src-1',
                    name: 'copilot',
                    display_name: 'Copilot Gateway',
                    protocol: 'openai',
                    base_url: 'https://api.githubcopilot.com',
                    encrypted_api_key: null,
                    key_hint: 'managed',
                    billing_type: 'subscription',
                    auth_type: 'managed',
                    is_enabled: true,
                    legacy_managed_accounts: [
                        {
                            accessToken: 'tok',
                            refreshToken: 'refresh',
                            expiresAt: Date.parse('2030-01-01T00:00:00Z'),
                            email: 'research@axiologic.net',
                            _index: 0,
                        },
                    ],
                    legacy_managed_state: { activeIndex: 0 },
                    legacy_managed_accounts_error: null,
                },
            ],
            apiKeys: [],
            models: [
                {
                    id: 'model-src-1',
                    name: 'copilot/gpt-4o',
                    display_name: 'GPT-4o',
                    type: 'model',
                    provider_config_id: 'prov-src-1',
                    provider_key: 'copilot',
                    provider_model: 'gpt-4o',
                    upstream_model: null,
                    upstream_source: 'provider-sync',
                    mode: 'fast',
                    input_price: '0',
                    output_price: '0',
                    pricing_type: 'request',
                    request_cost: '0.04',
                    is_free: false,
                    is_enabled: true,
                    max_concurrency: 8,
                    sort_order: 10,
                    context_window: '128k',
                    tags: ['coding'],
                },
                {
                    id: 'tier-src-1',
                    name: 'axl/fast',
                    display_name: 'Fast',
                    type: 'tier',
                    model_refs: ['copilot/gpt-4o'],
                    fallback_model: null,
                    is_enabled: true,
                    sort_order: 100,
                    tags: ['fast'],
                },
            ],
            middlewares: [],
            modelMiddlewares: [],
        };

        const plan = buildMainBranchImportPlan({
            source,
            targetMiddlewareRows: [],
            sourceEncryptionKey: null,
            targetEncryptionKey: randomBytes(32),
            targetApiKeyPepper: 'pepper',
            targetCredentialsDir: '/tmp/target-creds',
        });

        assert.equal(plan.report.warnings.length, 0);
        assert.equal(plan.providerPlans[0].accounts.length, 1);
        assert.equal(plan.providerPlans[0].accounts[0].authType, 'oauth');
        assert.equal(
            plan.providerPlans[0].accounts[0].externalAccountId,
            'research@axiologic.net'
        );
        assert.ok(
            plan.modelAliasPlans.some(
                (plan) =>
                    plan.alias === 'copilot-gpt-4o' &&
                    plan.targetModelKey === 'copilot/gpt-4o'
            )
        );
        assert.ok(
            plan.modelAliasPlans.some(
                (plan) =>
                    plan.alias === 'axl/copilot/gpt-4o' &&
                    plan.targetModelKey === 'copilot/gpt-4o'
            )
        );
        assert.ok(
            plan.modelAliasPlans.some(
                (plan) =>
                    plan.alias === 'fast' &&
                    plan.targetModelKey === 'axl/fast'
            )
        );
    });

    it('synthesizes implicit providers for models whose legacy provider rows are missing', () => {
        const plan = buildMainBranchImportPlan({
            source: {
                providers: [],
                apiKeys: [],
                models: [
                    {
                        id: 'model-openai',
                        name: 'openai/o4-mini',
                        display_name: 'o4-mini',
                        type: 'model',
                        provider_config_id: null,
                        provider_key: 'openai',
                        provider_model: 'o4-mini',
                        upstream_model: null,
                        upstream_source: 'openai',
                        mode: 'fast',
                        input_price: '0',
                        output_price: '0',
                        pricing_type: 'token',
                        request_cost: '0',
                        is_free: false,
                        is_enabled: true,
                        max_concurrency: 4,
                        sort_order: 10,
                        context_window: '128k',
                        tags: [],
                    },
                    {
                        id: 'model-search',
                        name: 'search/exa-search',
                        display_name: 'Exa Search',
                        type: 'model',
                        provider_config_id: null,
                        provider_key: 'search',
                        provider_model: 'exa-search',
                        upstream_model: null,
                        upstream_source: null,
                        mode: 'fast',
                        input_price: '0',
                        output_price: '0',
                        pricing_type: 'request',
                        request_cost: '0',
                        is_free: false,
                        is_enabled: true,
                        max_concurrency: 4,
                        sort_order: 20,
                        context_window: '128k',
                        tags: [],
                    },
                    {
                        id: 'tier-search',
                        name: 'axl/search',
                        display_name: 'Search',
                        type: 'tier',
                        model_refs: ['search/exa-search'],
                        fallback_model: null,
                        is_enabled: true,
                        sort_order: 100,
                        tags: [],
                    },
                ],
                middlewares: [],
                modelMiddlewares: [],
            },
            targetMiddlewareRows: [],
            sourceEncryptionKey: null,
            targetEncryptionKey: randomBytes(32),
            targetApiKeyPepper: 'pepper',
        });

        assert.equal(plan.report.warnings.length, 0);
        assert.equal(plan.report.counts.providers, 2);
        assert.equal(plan.report.counts.directModels, 2);
        assert.equal(plan.report.counts.cascadeModels, 1);
        assert.deepEqual(
            plan.providerPlans.map((entry) => entry.target.providerKey).sort(),
            ['openai', 'search']
        );
    });

    it('prefers canonical provider/model keys when historical aliases collide with shortened variants', () => {
        const plan = buildMainBranchImportPlan({
            source: {
                providers: [
                    {
                        id: 'prov-copilot',
                        name: 'copilot',
                        display_name: 'Copilot',
                        protocol: 'openai',
                        base_url: 'https://api.githubcopilot.com',
                        encrypted_api_key: null,
                        key_hint: 'managed',
                        billing_type: 'subscription',
                        auth_type: 'managed',
                        is_enabled: true,
                        legacy_managed_accounts: [
                            {
                                accessToken: 'tok',
                                refreshToken: 'refresh',
                                expiresAt: Date.parse('2030-01-01T00:00:00Z'),
                                email: 'research@axiologic.net',
                                _index: 0,
                            },
                        ],
                        legacy_managed_state: { activeIndex: 0 },
                        legacy_managed_accounts_error: null,
                    },
                ],
                apiKeys: [],
                models: [
                    {
                        id: 'model-canonical',
                        name: 'copilot/claude-opus-4.6',
                        display_name: 'Claude Opus 4.6 (Copilot, 9x)',
                        type: 'model',
                        provider_config_id: 'prov-copilot',
                        provider_key: 'copilot',
                        provider_model: 'claude-opus-4.6',
                        upstream_model: null,
                        upstream_source: 'provider-sync',
                        mode: 'deep',
                        input_price: '0',
                        output_price: '0',
                        pricing_type: 'request',
                        request_cost: '0.04',
                        is_free: false,
                        is_enabled: true,
                        max_concurrency: 8,
                        sort_order: 10,
                        context_window: '128k',
                        tags: ['coding'],
                    },
                    {
                        id: 'model-short',
                        name: 'copilot/opus-4.6',
                        display_name: 'axl/copilot/opus-4.6',
                        type: 'model',
                        provider_config_id: 'prov-copilot',
                        provider_key: 'copilot',
                        provider_model: 'claude-opus-4.6',
                        upstream_model: null,
                        upstream_source: 'provider-sync',
                        mode: 'deep',
                        input_price: '0',
                        output_price: '0',
                        pricing_type: 'request',
                        request_cost: '0.04',
                        is_free: false,
                        is_enabled: true,
                        max_concurrency: 8,
                        sort_order: 20,
                        context_window: '128k',
                        tags: ['coding'],
                    },
                ],
                middlewares: [],
                modelMiddlewares: [],
            },
            targetMiddlewareRows: [],
            sourceEncryptionKey: null,
            targetEncryptionKey: randomBytes(32),
            targetApiKeyPepper: 'pepper',
            targetCredentialsDir: '/tmp/target-creds',
        });

        assert.ok(
            plan.modelAliasPlans.some(
                (entry) =>
                    entry.alias === 'copilot-claude-opus-4.6' &&
                    entry.targetModelKey === 'copilot/claude-opus-4.6'
            )
        );
        assert.ok(
            plan.modelAliasPlans.some(
                (entry) =>
                    entry.alias === 'copilot-opus-4.6' &&
                    entry.targetModelKey === 'copilot/opus-4.6'
            )
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
                            sql.includes('INSERT INTO soul_gateway.model_aliases')
                        ) {
                            return {
                                rows: [
                                    { id: `alias-${params[0]}`, alias: params[0] },
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

    it('imports managed provider accounts into encrypted oauth credential files and model aliases', async () => {
        const sourceCredentialsDir = await mkdtemp(
            join(tmpdir(), 'sg-import-source-')
        );
        const targetCredentialsDir = await mkdtemp(
            join(tmpdir(), 'sg-import-target-')
        );
        await mkdir(join(sourceCredentialsDir, 'copilot', 'accounts'), {
            recursive: true,
        });
        await writeFile(
            join(sourceCredentialsDir, 'copilot', 'accounts', 'account-0.json'),
            JSON.stringify(
                {
                    accessToken: 'file-access-token',
                    refreshToken: 'file-refresh-token',
                    expiresAt: Date.parse('2030-01-01T00:00:00Z'),
                    email: 'research@axiologic.net',
                    _index: 0,
                },
                null,
                2
            )
        );
        await writeFile(
            join(sourceCredentialsDir, 'copilot', 'state.json'),
            JSON.stringify({ activeIndex: 0 }, null, 2)
        );

        const sourceRows = {
            providers: [
                {
                    id: 'prov-src-1',
                    name: 'copilot',
                    display_name: 'Copilot Gateway',
                    protocol: 'openai',
                    base_url: 'https://api.githubcopilot.com',
                    encrypted_api_key: null,
                    key_hint: 'managed',
                    billing_type: 'subscription',
                    auth_type: 'managed',
                    is_enabled: true,
                },
            ],
            apiKeys: [],
            models: [
                {
                    id: 'model-src-1',
                    name: 'copilot/gpt-4o',
                    display_name: 'GPT-4o',
                    type: 'model',
                    provider_config_id: 'prov-src-1',
                    provider_key: 'copilot',
                    provider_model: 'gpt-4o',
                    upstream_model: null,
                    upstream_source: 'provider-sync',
                    mode: 'fast',
                    input_price: '0',
                    output_price: '0',
                    pricing_type: 'request',
                    request_cost: '0.04',
                    is_free: false,
                    is_enabled: true,
                    max_concurrency: 8,
                    sort_order: 10,
                    context_window: '128k',
                    tags: ['coding'],
                },
            ],
            middlewares: [],
            modelMiddlewares: [],
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
                    return { rows: [] };
                throw new Error(`Unexpected target pool query: ${sql}`);
            },
            async connect() {
                return {
                    async query(sql, params = []) {
                        targetQueries.push({ sql, params });
                        if (
                            sql === 'BEGIN' ||
                            sql === 'COMMIT' ||
                            sql === 'ROLLBACK'
                        ) {
                            return { rows: [], rowCount: 0 };
                        }
                        if (sql.includes('INSERT INTO soul_gateway.providers')) {
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
                            sql.includes('INSERT INTO soul_gateway.model_aliases')
                        ) {
                            return {
                                rows: [
                                    { id: `alias-${params[0]}`, alias: params[0] },
                                ],
                            };
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
            sourceEncryptionKey: randomBytes(32),
            targetEncryptionKey: randomBytes(32),
            targetApiKeyPepper: 'pepper',
            sourceCredentialsDir,
            targetCredentialsDir,
        });

        assert.equal(report.warnings.length, 0);
        const providerAccountInsert = targetQueries.find((q) =>
            q.sql.includes('INSERT INTO soul_gateway.provider_accounts')
        );
        assert.ok(providerAccountInsert, 'expected oauth provider account insert');
        assert.equal(providerAccountInsert.params[2], 'active');
        assert.equal(
            providerAccountInsert.params[3],
            'research@axiologic.net'
        );
        assert.match(
            providerAccountInsert.params[4],
            /prov-target-1\/research-axiologic\.net\.json\.enc$/
        );
        assert.ok(
            targetQueries.some(
                (q) =>
                    q.sql.includes('INSERT INTO soul_gateway.model_aliases') &&
                    q.params[0] === 'copilot-gpt-4o'
            )
        );

        const encryptedPayload = JSON.parse(
            await readFile(providerAccountInsert.params[4], 'utf8')
        );
        assert.equal(typeof encryptedPayload.ciphertext, 'string');
        assert.equal(typeof encryptedPayload.iv, 'string');
        assert.equal(typeof encryptedPayload.authTag, 'string');
        assert.ok(
            !JSON.stringify(encryptedPayload).includes('file-access-token'),
            'credential file should be encrypted at rest'
        );
    });

    it('imports mixed-key legacy secrets and backfills logs with missing api_key_id via placeholder keys', async () => {
        const providerKey = randomBytes(32);
        const apiKeyKey = randomBytes(32);
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
                        'sk-provider-mixed',
                        providerKey
                    ),
                    key_hint: 'sk-prov...ixed',
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
                        'sk-soul-mixed',
                        apiKeyKey
                    ),
                    key_hint: 'sk-soul...ixed',
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
            ],
            middlewares: [],
            modelMiddlewares: [],
            callLogs: [
                {
                    id: '00000000-0000-0000-0000-000000000011',
                    soul_id: 'soul-alpha',
                    api_key_id: null,
                    agent_name: 'codex-cli',
                    session_id: null,
                    requested_model: 'gpt-4o',
                    resolved_model: 'gpt-4o',
                    mode: 'fast',
                    is_streaming: false,
                    request_messages: [{ role: 'user', content: 'hello' }],
                    request_size_bytes: 10,
                    response_content: 'ok',
                    status_code: 200,
                    stop_reason: 'stop',
                    error_type: null,
                    error_message: null,
                    response_size_bytes: 12,
                    latency_ms: 200,
                    ttfb_ms: 50,
                    prompt_tokens: 10,
                    completion_tokens: 5,
                    total_tokens: 15,
                    input_cost: '0.01',
                    output_cost: '0.02',
                    total_cost: '0.03',
                    retry_count: 0,
                    retry_reason: null,
                    retries_detail: null,
                    blocked_by_blacklist: false,
                    blacklist_rule_id: null,
                    blacklist_match: null,
                    is_truncated: false,
                    is_slow: false,
                    prompt_size_warning: false,
                    prompt_hash: 'hash-1',
                    cache_hit: false,
                    is_free: false,
                    middlewares_applied: [],
                    started_at: '2026-04-06T10:00:00.000Z',
                    completed_at: '2026-04-06T10:00:01.000Z',
                },
            ],
        };

        const sourcePool = {
            async query(sql, params = []) {
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
                if (
                    sql.includes('COUNT(*)::int AS total') &&
                    sql.includes('FROM soul_gateway.call_logs')
                ) {
                    return { rows: [{ total: sourceRows.callLogs.length }] };
                }
                if (sql.includes('FROM soul_gateway.call_logs')) {
                    if (params.length === 1) {
                        return { rows: sourceRows.callLogs.slice(0, params[0]) };
                    }
                    return { rows: [] };
                }
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
                    return { rows: [] };
                throw new Error(`Unexpected target pool query: ${sql}`);
            },
            async connect() {
                return {
                    async query(sql, params = []) {
                        targetQueries.push({ sql, params });
                        if (
                            sql === 'BEGIN' ||
                            sql === 'COMMIT' ||
                            sql === 'ROLLBACK'
                        ) {
                            return { rows: [], rowCount: 0 };
                        }
                        if (sql.includes('INSERT INTO soul_gateway.providers')) {
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
                                        id: 'model-target-1',
                                        model_key: params[0],
                                    },
                                ],
                            };
                        }
                        if (
                            sql.includes('INSERT INTO soul_gateway.model_aliases')
                        ) {
                            return {
                                rows: [
                                    { id: `alias-${params[0]}`, alias: params[0] },
                                ],
                            };
                        }
                        if (sql.includes('INSERT INTO soul_gateway.api_keys')) {
                            return {
                                rows: [
                                    {
                                        id: params[0].startsWith(
                                            'Imported Missing Legacy API Key'
                                        )
                                            ? 'placeholder-key-target-1'
                                            : 'key-target-1',
                                    },
                                ],
                            };
                        }
                        if (
                            sql.includes(
                                'CREATE TABLE IF NOT EXISTS soul_gateway.audit_logs_'
                            )
                        ) {
                            return { rows: [], rowCount: 0 };
                        }
                        if (
                            sql.includes('INSERT INTO soul_gateway.audit_logs')
                        ) {
                            return { rows: [{ id: 'audit-target-1' }] };
                        }
                        if (sql.includes('INSERT INTO soul_gateway.sessions')) {
                            return { rows: [{ id: 'session-target-1' }] };
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
            sourceEncryptionKey: [providerKey, apiKeyKey],
            targetEncryptionKey: targetKey,
            targetApiKeyPepper: 'pepper',
            includeAuditLogs: true,
        });

        assert.equal(report.counts.apiKeys, 2);
        assert.equal(report.counts.auditLogs, 1);
        assert.equal(report.counts.skippedAuditLogs, 0);
        assert.equal(report.counts.sessions, 1);
        assert.ok(
            report.warnings.some(
                (warning) =>
                    warning.code ===
                    'audit_log_api_key_placeholder_created'
            )
        );

        const apiKeyInserts = targetQueries.filter((q) =>
            q.sql.includes('INSERT INTO soul_gateway.api_keys')
        );
        assert.equal(apiKeyInserts.length, 2);
        assert.ok(
            apiKeyInserts.some(
                (q) =>
                    q.params[0] === 'Prod Key' && q.params[11] === 'active'
            )
        );
        assert.ok(
            apiKeyInserts.some(
                (q) =>
                    q.params[0] === 'Imported Missing Legacy API Key' &&
                    q.params[11] === 'revoked'
            )
        );

        const auditLogInsert = targetQueries.find((q) =>
            q.sql.includes('INSERT INTO soul_gateway.audit_logs')
        );
        assert.equal(auditLogInsert.params[5], 'placeholder-key-target-1');

        const sessionInsert = targetQueries.find((q) =>
            q.sql.includes('INSERT INTO soul_gateway.sessions')
        );
        assert.equal(sessionInsert.params[4], 'placeholder-key-target-1');
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
