import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createCipheriv, randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { importMainBranchData } from '../../db/import/main-branch-importer.mjs';
import { normalizeModelName } from '../../runtime/registry/model-name-normalizer.mjs';
import { compose, createKernelContext } from '../../runtime/kernel/index.mjs';
import { modelExecutionMiddleware } from '../../runtime/execution/model-execution.mjs';
import { createBackendTerminal } from '../../runtime/backends/backend-terminal.mjs';
import { MiddlewareCatalog } from '../../runtime/middleware/middleware-catalog.mjs';
import { ProviderRateLimitError } from '../../core/errors.mjs';

const LEGACY_ALGO = 'aes-256-gcm';
const BUILTIN_MIDDLEWARE_DIR = fileURLToPath(
    new URL('../../runtime/middleware/builtin/', import.meta.url)
);

describe('main-branch importer: fixture verification', () => {
    it('supports dry-run and strict mode on fixture-based source data', async () => {
        const sourceKey = randomBytes(32);
        const targetKey = randomBytes(32);
        const source = createMainBranchFixture(sourceKey, {
            includeUnknownMiddleware: true,
        });
        const harness = createImportHarness(
            source,
            createTargetMiddlewareRows()
        );

        const report = await importMainBranchData({
            sourcePool: harness.sourcePool,
            targetPool: harness.targetPool,
            sourceEncryptionKey: sourceKey,
            targetEncryptionKey: targetKey,
            targetApiKeyPepper: 'fixture-pepper',
            dryRun: true,
            includeAuditLogs: true,
        });

        assert.equal(report.dryRun, true);
        assert.equal(report.counts.providers, 2);
        assert.equal(report.sourceCounts.callLogs, 5);
        assert.equal(report.counts.auditLogs, 5);
        assert.ok(
            report.warnings.some((w) => w.code === 'middleware_key_unresolved')
        );
        assert.equal(harness.state.providers.length, 0);
        assert.equal(harness.state.models.length, 0);
        assert.equal(harness.state.middlewareBindings.length, 0);
        assert.equal(harness.state.auditLogs.length, 0);
        assert.equal(harness.state.sessions.length, 0);

        await assert.rejects(
            importMainBranchData({
                sourcePool: harness.sourcePool,
                targetPool: harness.targetPool,
                sourceEncryptionKey: sourceKey,
                targetEncryptionKey: targetKey,
                targetApiKeyPepper: 'fixture-pepper',
                strict: true,
            }),
            /Import plan contains 1 warning/
        );
    });

    it('imports a realistic main-branch fixture idempotently and preserves cascade parity', async () => {
        const sourceKey = randomBytes(32);
        const targetKey = randomBytes(32);
        const source = createMainBranchFixture(sourceKey);
        const harness = createImportHarness(
            source,
            createTargetMiddlewareRows()
        );

        const firstReport = await importMainBranchData({
            sourcePool: harness.sourcePool,
            targetPool: harness.targetPool,
            sourceEncryptionKey: sourceKey,
            targetEncryptionKey: targetKey,
            targetApiKeyPepper: 'fixture-pepper',
            includeAuditLogs: true,
        });

        assert.equal(firstReport.warnings.length, 0);
        assert.equal(harness.state.providers.length, 2);
        assert.equal(harness.state.providerAccounts.length, 1);
        assert.equal(harness.state.apiKeys.length, 2);
        assert.equal(harness.state.models.length, 5);
        assert.equal(harness.state.modelChildren.length, 3);
        assert.equal(harness.state.middlewareBindings.length, 2);
        assert.equal(harness.state.auditLogs.length, 5);
        assert.equal(harness.state.sessions.length, 3);
        assert.equal(firstReport.sourceCounts.callLogs, 5);
        assert.equal(firstReport.counts.auditLogs, 5);
        assert.equal(firstReport.counts.sessions, 3);

        const codexProvider = findBy(
            harness.state.providers,
            'provider_key',
            'codex'
        );
        assert.equal(codexProvider.adapter_key, 'codex-api');
        assert.equal(codexProvider.auth_strategy, 'oauth');
        assert.equal(codexProvider.oauth_adapter_key, 'openai-codex');
        assert.equal(
            codexProvider.base_url,
            'https://chatgpt.com/backend-api/codex'
        );

        const activeApiKey = findBy(
            harness.state.apiKeys,
            'label',
            'Production'
        );
        const revokedApiKey = findBy(harness.state.apiKeys, 'label', 'Revoked');
        assert.equal(activeApiKey.status, 'active');
        assert.equal(revokedApiKey.status, 'revoked');

        const fastTier = findBy(harness.state.models, 'model_key', 'axl/fast');
        const deepTier = findBy(harness.state.models, 'model_key', 'axl/deep');
        const miniModel = findBy(
            harness.state.models,
            'model_key',
            'openai/gpt-4o-mini'
        );
        const deepModel = findBy(
            harness.state.models,
            'model_key',
            'openai/gpt-4.1'
        );

        assert.equal(fastTier.strategy_kind, 'cascade');
        assert.equal(deepTier.strategy_kind, 'cascade');
        assert.equal(miniModel.strategy_kind, 'direct');
        assert.equal(deepModel.strategy_kind, 'direct');

        const fastChildren = harness.state.modelChildren
            .filter((row) => row.parent_model_id === fastTier.id)
            .sort((a, b) => a.priority - b.priority);
        assert.equal(fastChildren.length, 2);
        assert.equal(fastChildren[0].child_model_key, 'openai/gpt-4o-mini');
        assert.equal(fastChildren[1].child_model_key, 'axl/deep');
        assert.deepEqual(fastChildren[1].settings, { importedFallback: true });

        const responseCacheBinding = harness.state.middlewareBindings.find(
            (row) =>
                row.middleware_key === 'response-cache' &&
                row.target_id === fastTier.id
        );
        const contentBlockerBinding = harness.state.middlewareBindings.find(
            (row) =>
                row.middleware_key === 'content-blocker' &&
                row.target_id === deepModel.id
        );
        assert.ok(responseCacheBinding);
        assert.ok(contentBlockerBinding);

        const importedExplicitSession = harness.state.sessions.find(
            (row) =>
                row.explicit_session_id ===
                '11111111-1111-1111-1111-111111111111'
        );
        assert.ok(importedExplicitSession);
        assert.equal(importedExplicitSession.request_count, 2);
        assert.equal(importedExplicitSession.status, 'closed');

        const implicitSessions = harness.state.sessions
            .filter((row) => row.explicit_session_id == null)
            .sort((a, b) => a.sequence_no - b.sequence_no);
        assert.equal(implicitSessions.length, 2);
        assert.equal(implicitSessions[0].request_count, 2);
        assert.equal(implicitSessions[1].request_count, 1);

        const responsesLog = harness.state.auditLogs.find(
            (row) => row.log_id === '00000000-0000-0000-0000-000000000002'
        );
        const failedImplicitLog = harness.state.auditLogs.find(
            (row) => row.log_id === '00000000-0000-0000-0000-000000000005'
        );
        assert.equal(responsesLog.request_format, 'openai_responses');
        assert.equal(responsesLog.session_id, importedExplicitSession.id);
        assert.equal(failedImplicitLog.status, 'failed');
        assert.equal(failedImplicitLog.retryable, true);
        assert.equal(failedImplicitLog.session_id, implicitSessions[1].id);

        const secondReport = await importMainBranchData({
            sourcePool: harness.sourcePool,
            targetPool: harness.targetPool,
            sourceEncryptionKey: sourceKey,
            targetEncryptionKey: targetKey,
            targetApiKeyPepper: 'fixture-pepper',
            includeAuditLogs: true,
        });

        assert.equal(secondReport.warnings.length, 0);
        assert.equal(harness.state.providers.length, 2);
        assert.equal(harness.state.providerAccounts.length, 1);
        assert.equal(harness.state.apiKeys.length, 2);
        assert.equal(harness.state.models.length, 5);
        assert.equal(harness.state.modelChildren.length, 3);
        assert.equal(harness.state.middlewareBindings.length, 2);
        assert.equal(harness.state.auditLogs.length, 5);
        assert.equal(harness.state.sessions.length, 3);
        assert.equal(secondReport.counts.auditLogs, 5);
        assert.equal(secondReport.counts.sessions, 3);

        const snapshot = buildSnapshotFromImportState(harness.state);
        // After import, cascades are addressable by their bare name (e.g. 'fast')
        // which resolves via the normalizer's provider-prefix matching.
        // The legacy 'mode:' prefix is no longer supported in the runtime.
        assert.deepEqual(normalizeModelName('fast', snapshot), {
            normalized: 'axl/fast',
            kind: 'model',
        });

        const catalog = new MiddlewareCatalog();
        await catalog.loadBuiltins(BUILTIN_MIDDLEWARE_DIR);
        const gatewayChain = catalog.resolveGatewayChain({
            modelId: fastTier.id,
            snapshot,
        });
        assert.ok(gatewayChain.length > 0);

        const backendCalls = [];
        const stubBackendModule = {
            manifest: {
                key: 'openai-api',
                kind: 'external_api',
                authStrategy: 'api_key',
                supportsStreaming: true,
                supportsTools: true,
                supportedFormats: ['openai_chat'],
            },
            async execute(ctx) {
                const modelId =
                    ctx.resolvedModel.providerModelId ||
                    ctx.resolvedModel.provider_model_id;
                backendCalls.push(modelId);
                if (modelId === 'gpt-4o-mini') {
                    throw new ProviderRateLimitError('openai');
                }
                return {
                    accountId: 'acct-imported',
                    abort: async () => {},
                    stream: streamForText(`reply from ${modelId}`),
                };
            },
            classifyError(error) {
                return error;
            },
        };
        const stubTerminal = createBackendTerminal(stubBackendModule);

        const cascadeModel = snapshot.models.get('axl/fast');
        const appCtx = {
            config: {
                env: {
                    DEFAULT_MODEL_ATTEMPTS: 5,
                    DEFAULT_REQUEST_TIMEOUT_MS: 120000,
                    DEFAULT_QUEUE_TIMEOUT_MS: 60000,
                    HTTP_RETRY_MAX_ATTEMPTS: 1,
                    HTTP_RETRY_BASE_DELAY_MS: 1,
                    HTTP_RETRY_MULTIPLIER: 1,
                    HTTP_RETRY_MAX_DELAY_MS: 1,
                    HTTP_RETRY_JITTER_PCT: 0,
                },
                defaults: {
                    responseExcerptChars: 240,
                },
            },
            services: {
                backendCatalog: {
                    getTerminal(key) {
                        return key === 'openai-api' ? stubTerminal : null;
                    },
                    getBackend(key) {
                        return key === 'openai-api' ? stubBackendModule : null;
                    },
                },
                providerMiddlewareRegistry: { build: () => null },
            },
            log: noopLog(),
        };

        const ctx = createKernelContext({
            requestId: 'req-import-fixture',
            request: {
                model: 'axl/fast',
                messages: [{ role: 'user', content: 'hello' }],
                stream: false,
            },
            target: { model: cascadeModel },
            snapshot,
            services: appCtx.services.extensionServices || Object.freeze({}),
            log: noopLog(),
            appCtx,
        });
        ctx.metadata.wantStream = false;
        ctx.metadata.onCooldown = () => {};

        await compose([modelExecutionMiddleware()])(ctx);

        assert.deepEqual(backendCalls, ['gpt-4o-mini', 'gpt-4.1']);
        const cascadeModelChosen = ctx.metadata.cascadeModel;
        assert.equal(
            cascadeModelChosen?.modelKey || cascadeModelChosen?.model_key,
            'openai/gpt-4.1'
        );
        assert.equal(
            ctx.response.choices[0].message.content,
            'reply from gpt-4.1'
        );
        assert.deepEqual(
            computeLegacyDispatchOrder(source, 'axl/fast'),
            backendCalls
        );
    });
});

function createMainBranchFixture(
    sourceKey,
    { includeUnknownMiddleware = false } = {}
) {
    const middlewares = [
        {
            id: 'mw-cache',
            name: 'cache',
            description: 'legacy cache',
            file_name: 'cache.middleware.mjs',
            type: 'both',
            supports_streaming: false,
            default_settings: { ttlMs: 60_000 },
        },
        {
            id: 'mw-blacklist',
            name: 'blacklist-scanner',
            description: 'legacy blocker',
            file_name: 'blacklist.middleware.mjs',
            type: 'pre',
            supports_streaming: false,
            default_settings: {},
        },
    ];

    const modelMiddlewares = [
        {
            id: 'bind-fast-cache',
            model_config_id: 'tier-fast',
            middleware_id: 'mw-cache',
            middleware_name: 'cache',
            is_enabled: true,
            sort_order: 10,
            settings: { ttlMs: 5000 },
        },
        {
            id: 'bind-deep-block',
            model_config_id: 'model-deep',
            middleware_id: 'mw-blacklist',
            middleware_name: 'blacklist-scanner',
            is_enabled: true,
            sort_order: 20,
            settings: { mode: 'strict' },
        },
    ];

    if (includeUnknownMiddleware) {
        middlewares.push({
            id: 'mw-unknown',
            name: 'unknown-main-only',
            description: 'not present in new runtime',
            file_name: 'unknown.middleware.mjs',
            type: 'pre',
            supports_streaming: false,
            default_settings: {},
        });
        modelMiddlewares.push({
            id: 'bind-unknown',
            model_config_id: 'tier-fast',
            middleware_id: 'mw-unknown',
            middleware_name: 'unknown-main-only',
            is_enabled: true,
            sort_order: 30,
            settings: {},
        });
    }

    return {
        providers: [
            {
                id: 'prov-openai',
                name: 'openai',
                display_name: 'OpenAI',
                protocol: 'openai',
                base_url: 'https://api.openai.com/v1/chat/completions',
                encrypted_api_key: encryptLegacyBlob(
                    'sk-provider-openai',
                    sourceKey
                ),
                key_hint: 'sk-open...ai',
                billing_type: 'api_key',
                auth_type: 'api_key',
                is_enabled: true,
            },
            {
                id: 'prov-codex',
                name: 'codex',
                display_name: 'Codex',
                protocol: 'openai',
                base_url: 'https://chatgpt.com/backend-api/codex/responses',
                encrypted_api_key: null,
                key_hint: null,
                billing_type: 'subscription',
                auth_type: 'managed',
                is_enabled: true,
            },
        ],
        apiKeys: [
            {
                id: 'api-active',
                key_hash: 'legacy-active-hash',
                encrypted_key: encryptLegacyBlob('sk-soul-active', sourceKey),
                label: 'Production',
                key_hint: 'sk-soul...ctive',
                monthly_budget: '30',
                daily_budget: '3',
                rpm_limit: 120,
                tpm_limit: 250000,
                expires_at: null,
                is_revoked: false,
                last_used_at: '2026-04-07T12:00:00.000Z',
                created_at: '2026-04-01T00:00:00.000Z',
            },
            {
                id: 'api-revoked',
                key_hash: 'legacy-revoked-hash',
                encrypted_key: encryptLegacyBlob('sk-soul-revoked', sourceKey),
                label: 'Revoked',
                key_hint: 'sk-soul...oked',
                monthly_budget: '5',
                daily_budget: '1',
                rpm_limit: 60,
                tpm_limit: 100000,
                expires_at: null,
                is_revoked: true,
                last_used_at: '2026-04-05T09:30:00.000Z',
                created_at: '2026-04-02T00:00:00.000Z',
            },
        ],
        models: [
            {
                id: 'model-mini',
                name: 'openai/gpt-4o-mini',
                display_name: 'GPT-4o Mini',
                type: 'model',
                provider_config_id: 'prov-openai',
                provider_key: 'openai',
                provider_model: 'gpt-4o-mini',
                upstream_model: null,
                upstream_source: 'provider-sync',
                mode: 'fast',
                input_price: '0.15',
                output_price: '0.60',
                pricing_type: 'token',
                request_cost: '0',
                is_free: false,
                is_enabled: true,
                max_concurrency: 8,
                sort_order: 10,
                context_window: '128k',
                tags: ['fast'],
            },
            {
                id: 'model-deep',
                name: 'openai/gpt-4.1',
                display_name: 'GPT-4.1',
                type: 'model',
                provider_config_id: 'prov-openai',
                provider_key: 'openai',
                provider_model: 'gpt-4.1',
                upstream_model: null,
                upstream_source: 'provider-sync',
                mode: 'deep',
                input_price: '2.00',
                output_price: '8.00',
                pricing_type: 'token',
                request_cost: '0',
                is_free: false,
                is_enabled: true,
                max_concurrency: 4,
                sort_order: 20,
                context_window: '128k',
                tags: ['deep'],
            },
            {
                id: 'model-codex',
                name: 'openai/codex-mini',
                display_name: 'Codex Mini',
                type: 'model',
                provider_config_id: 'prov-codex',
                provider_key: 'codex',
                provider_model: 'codex-mini',
                upstream_model: null,
                upstream_source: 'provider-sync',
                mode: 'code',
                input_price: '0',
                output_price: '0',
                pricing_type: 'request',
                request_cost: '0.02',
                is_free: false,
                is_enabled: true,
                max_concurrency: 2,
                sort_order: 30,
                context_window: '256k',
                tags: ['code'],
            },
            {
                id: 'tier-deep',
                name: 'axl/deep',
                display_name: 'Deep',
                type: 'tier',
                model_refs: ['openai/gpt-4.1'],
                fallback_model: null,
                is_enabled: true,
                sort_order: 200,
                tags: ['deep'],
            },
            {
                id: 'tier-fast',
                name: 'axl/fast',
                display_name: 'Fast',
                type: 'tier',
                model_refs: ['openai/gpt-4o-mini'],
                fallback_model: 'axl/deep',
                is_enabled: true,
                sort_order: 100,
                tags: ['fast'],
            },
        ],
        middlewares,
        modelMiddlewares,
        callLogs: [
            {
                id: '00000000-0000-0000-0000-000000000001',
                soul_id: 'soul-alpha',
                api_key_id: 'api-active',
                agent_name: 'codex-cli',
                session_id: '11111111-1111-1111-1111-111111111111',
                requested_model: 'axl/fast',
                resolved_model: 'openai/gpt-4o-mini',
                mode: 'fast',
                is_streaming: false,
                request_messages: [{ role: 'user', content: 'hello fast' }],
                request_size_bytes: 120,
                response_content: 'mini reply',
                status_code: 200,
                stop_reason: 'stop',
                error_type: null,
                error_message: null,
                response_size_bytes: 42,
                latency_ms: 210,
                ttfb_ms: 55,
                prompt_tokens: 12,
                completion_tokens: 18,
                total_tokens: 30,
                input_cost: '0.0018',
                output_cost: '0.0108',
                total_cost: '0.0126',
                retry_count: 0,
                retry_reason: null,
                retries_detail: null,
                blocked_by_blacklist: false,
                blacklist_rule_id: null,
                blacklist_match: null,
                is_truncated: false,
                is_slow: false,
                prompt_size_warning: false,
                prompt_hash: 'prompt-fast-1',
                cache_hit: true,
                is_free: false,
                middlewares_applied: ['cache'],
                started_at: '2026-04-06T10:00:00.000Z',
                completed_at: '2026-04-06T10:00:02.000Z',
            },
            {
                id: '00000000-0000-0000-0000-000000000002',
                soul_id: 'soul-alpha',
                api_key_id: 'api-active',
                agent_name: 'codex-cli',
                session_id: '11111111-1111-1111-1111-111111111111',
                requested_model: 'openai/codex-mini',
                resolved_model: 'openai/codex-mini',
                mode: 'code',
                is_streaming: false,
                request_messages: [
                    {
                        type: 'message',
                        role: 'user',
                        content: [
                            { type: 'input_text', text: 'write a patch' },
                        ],
                    },
                ],
                request_size_bytes: 240,
                response_content: 'codex reply',
                status_code: 200,
                stop_reason: 'completed',
                error_type: null,
                error_message: null,
                response_size_bytes: 64,
                latency_ms: 350,
                ttfb_ms: 70,
                prompt_tokens: 20,
                completion_tokens: 25,
                total_tokens: 45,
                input_cost: '0.0200',
                output_cost: '0.0000',
                total_cost: '0.0200',
                retry_count: 0,
                retry_reason: null,
                retries_detail: null,
                blocked_by_blacklist: false,
                blacklist_rule_id: null,
                blacklist_match: null,
                is_truncated: false,
                is_slow: false,
                prompt_size_warning: false,
                prompt_hash: 'prompt-codex-1',
                cache_hit: false,
                is_free: false,
                middlewares_applied: [],
                started_at: '2026-04-06T10:05:00.000Z',
                completed_at: '2026-04-06T10:05:03.000Z',
            },
            {
                id: '00000000-0000-0000-0000-000000000003',
                soul_id: 'soul-alpha',
                api_key_id: 'api-active',
                agent_name: 'claude-code',
                session_id: null,
                requested_model: 'axl/fast',
                resolved_model: 'openai/gpt-4o-mini',
                mode: 'fast',
                is_streaming: true,
                request_messages: [{ role: 'user', content: 'stream this' }],
                request_size_bytes: 96,
                response_content: 'streamed mini reply',
                status_code: 200,
                stop_reason: 'stop',
                error_type: null,
                error_message: null,
                response_size_bytes: 80,
                latency_ms: 190,
                ttfb_ms: 40,
                prompt_tokens: 10,
                completion_tokens: 16,
                total_tokens: 26,
                input_cost: '0.0015',
                output_cost: '0.0096',
                total_cost: '0.0111',
                retry_count: 0,
                retry_reason: null,
                retries_detail: null,
                blocked_by_blacklist: false,
                blacklist_rule_id: null,
                blacklist_match: null,
                is_truncated: false,
                is_slow: false,
                prompt_size_warning: false,
                prompt_hash: 'prompt-fast-2',
                cache_hit: false,
                is_free: false,
                middlewares_applied: ['cache'],
                started_at: '2026-04-06T11:00:00.000Z',
                completed_at: '2026-04-06T11:00:02.000Z',
            },
            {
                id: '00000000-0000-0000-0000-000000000004',
                soul_id: 'soul-alpha',
                api_key_id: 'api-active',
                agent_name: 'claude-code',
                session_id: null,
                requested_model: 'axl/fast',
                resolved_model: 'openai/gpt-4o-mini',
                mode: 'fast',
                is_streaming: false,
                request_messages: [
                    { role: 'user', content: 'same implicit session' },
                ],
                request_size_bytes: 140,
                response_content: 'follow-up mini reply',
                status_code: 200,
                stop_reason: 'stop',
                error_type: null,
                error_message: null,
                response_size_bytes: 88,
                latency_ms: 230,
                ttfb_ms: 50,
                prompt_tokens: 14,
                completion_tokens: 19,
                total_tokens: 33,
                input_cost: '0.0021',
                output_cost: '0.0114',
                total_cost: '0.0135',
                retry_count: 0,
                retry_reason: null,
                retries_detail: null,
                blocked_by_blacklist: false,
                blacklist_rule_id: null,
                blacklist_match: null,
                is_truncated: false,
                is_slow: false,
                prompt_size_warning: false,
                prompt_hash: 'prompt-fast-3',
                cache_hit: false,
                is_free: false,
                middlewares_applied: ['cache'],
                started_at: '2026-04-06T11:10:00.000Z',
                completed_at: '2026-04-06T11:10:02.000Z',
            },
            {
                id: '00000000-0000-0000-0000-000000000005',
                soul_id: 'soul-alpha',
                api_key_id: 'api-active',
                agent_name: 'claude-code',
                session_id: null,
                requested_model: 'axl/deep',
                resolved_model: 'openai/gpt-4.1',
                mode: 'deep',
                is_streaming: false,
                request_messages: [
                    { role: 'user', content: 'fallback request' },
                ],
                request_size_bytes: 156,
                response_content: '',
                status_code: 429,
                stop_reason: null,
                error_type: 'rate_limit_error',
                error_message: 'too many requests',
                response_size_bytes: 0,
                latency_ms: 480,
                ttfb_ms: null,
                prompt_tokens: 18,
                completion_tokens: 0,
                total_tokens: 18,
                input_cost: '0.0360',
                output_cost: '0.0000',
                total_cost: '0.0360',
                retry_count: 1,
                retry_reason: 'rate_limit',
                retries_detail: [{ attempt: 1, error: 'rate_limit_error' }],
                blocked_by_blacklist: false,
                blacklist_rule_id: null,
                blacklist_match: null,
                is_truncated: false,
                is_slow: true,
                prompt_size_warning: false,
                prompt_hash: 'prompt-deep-1',
                cache_hit: false,
                is_free: false,
                middlewares_applied: ['blacklist-scanner'],
                started_at: '2026-04-06T12:00:00.000Z',
                completed_at: '2026-04-06T12:00:05.000Z',
            },
        ],
    };
}

function createTargetMiddlewareRows() {
    return [
        {
            id: 'target-response-cache',
            middleware_key: 'response-cache',
            display_name: 'Response Cache',
            source_type: 'builtin',
            module_path: '/tmp/response-cache.mjs',
            version: '1.0.0',
            checksum: 'cache',
            default_settings: { ttlMs: 300000 },
            enabled: true,
            metadata: {},
        },
        {
            id: 'target-content-blocker',
            middleware_key: 'content-blocker',
            display_name: 'Content Blocker',
            source_type: 'builtin',
            module_path: '/tmp/content-blocker.mjs',
            version: '1.0.0',
            checksum: 'block',
            default_settings: {},
            enabled: true,
            metadata: {},
        },
    ];
}

function createImportHarness(source, targetMiddlewareRows) {
    const state = {
        providers: [],
        providerAccounts: [],
        apiKeys: [],
        models: [],
        modelChildren: [],
        middlewareBindings: [],
        sessions: [],
        auditLogs: [],
        middlewares: targetMiddlewareRows.map((row) => ({ ...row })),
        seq: {
            provider: 1,
            providerAccount: 1,
            apiKey: 1,
            model: 1,
            modelChild: 1,
            middlewareBinding: 1,
        },
    };

    const sourcePool = {
        async query(sql, params = []) {
            if (sql.includes('FROM soul_gateway.provider_configs'))
                return { rows: cloneRows(source.providers) };
            if (sql.includes('FROM soul_gateway.api_keys'))
                return { rows: cloneRows(source.apiKeys) };
            if (sql.includes('FROM soul_gateway.model_configs'))
                return { rows: cloneRows(source.models) };
            if (
                sql.includes('FROM soul_gateway.middlewares') &&
                !sql.includes('JOIN')
            )
                return { rows: cloneRows(source.middlewares) };
            if (sql.includes('FROM soul_gateway.model_middlewares'))
                return { rows: cloneRows(source.modelMiddlewares) };
            if (
                sql.includes('COUNT(*)::int AS total') &&
                sql.includes('FROM soul_gateway.call_logs')
            ) {
                return { rows: [{ total: source.callLogs.length }] };
            }
            if (sql.includes('FROM soul_gateway.call_logs')) {
                const sorted = cloneRows(source.callLogs).sort((a, b) =>
                    compareStartedAtId(a, b)
                );
                if (params.length === 1) {
                    return { rows: sorted.slice(0, params[0]) };
                }
                if (params.length === 3) {
                    const [afterStartedAt, afterId, limit] = params;
                    const filtered = sorted.filter((row) => {
                        if (row.started_at > afterStartedAt) return true;
                        if (row.started_at < afterStartedAt) return false;
                        return row.id > afterId;
                    });
                    return { rows: filtered.slice(0, limit) };
                }
                throw new Error(
                    `Unexpected call_logs params: ${JSON.stringify(params)}`
                );
            }
            throw new Error(`Unexpected source query: ${sql}`);
        },
    };

    const targetPool = {
        async query(sql) {
            if (sql.includes('information_schema.columns'))
                return { rows: [{ ok: true }] };
            if (sql.includes("to_regclass('soul_gateway.model_children')"))
                return { rows: [{ regclass: 'soul_gateway.model_children' }] };
            if (sql.includes("to_regclass('soul_gateway.middleware_bindings')"))
                return {
                    rows: [{ regclass: 'soul_gateway.middleware_bindings' }],
                };
            if (sql.includes("to_regclass('soul_gateway.audit_logs')"))
                return { rows: [{ regclass: 'soul_gateway.audit_logs' }] };
            if (sql.includes("to_regclass('soul_gateway.sessions')"))
                return { rows: [{ regclass: 'soul_gateway.sessions' }] };
            if (sql.includes('SELECT * FROM soul_gateway.middlewares'))
                return { rows: cloneRows(state.middlewares) };
            throw new Error(`Unexpected target pool query: ${sql}`);
        },
        async connect() {
            return {
                async query(sql, params = []) {
                    if (
                        sql === 'BEGIN' ||
                        sql === 'COMMIT' ||
                        sql === 'ROLLBACK'
                    ) {
                        return { rows: [], rowCount: 0 };
                    }

                    if (sql.includes('INSERT INTO soul_gateway.providers')) {
                        const row = upsertBy(
                            state.providers,
                            'provider_key',
                            {
                                id: null,
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
                                settings: JSON.parse(params[13] || '{}'),
                                metadata: JSON.parse(params[14] || '{}'),
                            },
                            () => nextId(state.seq, 'provider', 'provider')
                        );
                        return { rows: [cloneRow(row)] };
                    }

                    if (sql.includes('FROM soul_gateway.provider_accounts')) {
                        const rows = state.providerAccounts
                            .filter(
                                (row) =>
                                    row.provider_id === params[0] &&
                                    row.auth_type === params[1] &&
                                    row.deleted_at == null
                            )
                            .slice(0, 1);
                        return { rows: cloneRows(rows) };
                    }

                    if (sql.includes('UPDATE soul_gateway.provider_accounts')) {
                        const row = state.providerAccounts.find(
                            (entry) => entry.id === params[0]
                        );
                        if (!row) return { rows: [] };
                        Object.assign(row, {
                            account_label: params[1],
                            status: params[2],
                            secret_ciphertext: params[3],
                            secret_iv: params[4],
                            secret_auth_tag: params[5],
                            secret_hint: params[6],
                            metadata: JSON.parse(params[7] || '{}'),
                        });
                        return { rows: [cloneRow(row)] };
                    }

                    if (
                        sql.includes(
                            'INSERT INTO soul_gateway.provider_accounts'
                        )
                    ) {
                        const row = {
                            id: nextId(
                                state.seq,
                                'providerAccount',
                                'provider-account'
                            ),
                            provider_id: params[0],
                            account_label: params[1],
                            auth_type: params[2],
                            status: params[3],
                            secret_ciphertext: params[4],
                            secret_iv: params[5],
                            secret_auth_tag: params[6],
                            secret_hint: params[7],
                            metadata: JSON.parse(params[8] || '{}'),
                            deleted_at: null,
                        };
                        state.providerAccounts.push(row);
                        return { rows: [cloneRow(row)] };
                    }

                    if (sql.includes('INSERT INTO soul_gateway.api_keys')) {
                        const row = upsertBy(
                            state.apiKeys,
                            'key_hash',
                            {
                                id: null,
                                label: params[0],
                                key_hash: params[1],
                                key_ciphertext: params[2],
                                key_iv: params[3],
                                key_auth_tag: params[4],
                                key_hint: params[5],
                                rpm_limit: params[6],
                                tpm_limit: params[7],
                                daily_budget_usd: params[8],
                                monthly_budget_usd: params[9],
                                expires_at: params[10],
                                status: params[11],
                                last_used_at: params[12],
                                metadata: JSON.parse(params[13] || '{}'),
                                revoked_at: params[14],
                            },
                            () => nextId(state.seq, 'apiKey', 'api-key')
                        );
                        return { rows: [cloneRow(row)] };
                    }

                    if (sql.includes('INSERT INTO soul_gateway.models')) {
                        const row = upsertBy(
                            state.models,
                            'model_key',
                            {
                                id: null,
                                model_key: params[0],
                                display_name: params[1],
                                provider_id: params[2],
                                provider_model_id: params[3],
                                execution_kind: params[4],
                                enabled: params[5],
                                concurrency_limit: params[6],
                                queue_timeout_ms: params[7],
                                request_timeout_ms: params[8],
                                pricing_mode: params[9],
                                input_price_per_million: params[10],
                                output_price_per_million: params[11],
                                request_price_usd: params[12],
                                retry_policy: JSON.parse(params[13] || '{}'),
                                capabilities: JSON.parse(params[14] || '{}'),
                                tags: params[15] || [],
                                is_free: params[16],
                                discovery_source: params[17],
                                metadata: JSON.parse(params[18] || '{}'),
                                strategy_kind: params[19],
                                max_attempts: params[20],
                            },
                            () => nextId(state.seq, 'model', 'model')
                        );
                        return { rows: [cloneRow(row)] };
                    }

                    if (
                        sql.includes('DELETE FROM soul_gateway.model_children')
                    ) {
                        state.modelChildren = state.modelChildren.filter(
                            (row) => row.parent_model_id !== params[0]
                        );
                        return { rows: [], rowCount: 1 };
                    }

                    if (
                        sql.includes('INSERT INTO soul_gateway.model_children')
                    ) {
                        const childModel = state.models.find(
                            (row) => row.id === params[1]
                        );
                        const row = {
                            id: nextId(state.seq, 'modelChild', 'model-child'),
                            parent_model_id: params[0],
                            child_model_id: params[1],
                            child_model_key: childModel?.model_key || null,
                            priority: params[2],
                            enabled: params[3],
                            settings: JSON.parse(params[4] || '{}'),
                        };
                        state.modelChildren.push(row);
                        return { rows: [cloneRow(row)], rowCount: 1 };
                    }

                    if (
                        sql.includes(
                            'INSERT INTO soul_gateway.middleware_bindings'
                        )
                    ) {
                        const row = upsertBinding(
                            state.middlewareBindings,
                            {
                                id: null,
                                scope: params[0],
                                target_id: params[1],
                                middleware_key: params[2],
                                sort_order: params[3],
                                enabled: params[4],
                                settings: JSON.parse(params[5] || '{}'),
                            },
                            () =>
                                nextId(
                                    state.seq,
                                    'middlewareBinding',
                                    'middleware-binding'
                                )
                        );
                        return { rows: [cloneRow(row)] };
                    }

                    if (
                        sql.includes(
                            'CREATE TABLE IF NOT EXISTS soul_gateway.audit_logs_'
                        )
                    ) {
                        return { rows: [], rowCount: 0 };
                    }

                    if (sql.includes('INSERT INTO soul_gateway.sessions')) {
                        const row = upsertBy(
                            state.sessions,
                            'id',
                            {
                                id: params[0],
                                group_key: params[1],
                                group_display: params[2],
                                sequence_no: params[3],
                                api_key_id: params[4],
                                soul_id: params[5],
                                agent_name: params[6],
                                explicit_session_id: params[7],
                                status: params[8],
                                started_at: params[9],
                                last_activity_at: params[10],
                                ended_at: params[11],
                                request_count: params[12],
                                input_tokens_total: params[13],
                                output_tokens_total: params[14],
                                metadata: JSON.parse(params[15] || '{}'),
                            },
                            () => params[0]
                        );
                        return { rows: [cloneRow(row)] };
                    }

                    if (sql.includes('INSERT INTO soul_gateway.audit_logs')) {
                        const key = `${params[0]}::${params[1]}`;
                        const row = upsertBy(
                            state.auditLogs,
                            '_pk',
                            {
                                _pk: key,
                                started_at: params[0],
                                log_id: params[1],
                                request_id: params[2],
                                request_format: params[3],
                                status: params[4],
                                api_key_id: params[5],
                                soul_id: params[6],
                                agent_name: params[7],
                                user_agent: params[8],
                                session_id: params[9],
                                requested_model: params[10],
                                resolved_model_id: params[11],
                                resolved_provider_id: params[12],
                                tier_id: params[13],
                                provider_account_id: params[14],
                                http_status: params[15],
                                error_type: params[16],
                                error_message: params[17],
                                retryable: params[18],
                                cascaded: params[19],
                                cache_hit: params[20],
                                blocked: params[21],
                                loop_detected: params[22],
                                truncated: params[23],
                                slow: params[24],
                                oversized: params[25],
                                streaming: params[26],
                                queue_wait_ms: params[27],
                                latency_ms: params[28],
                                ttfb_ms: params[29],
                                completed_at: params[30],
                                attempt_count: params[31],
                                retry_trace: JSON.parse(params[32] || '[]'),
                                middleware_trace: JSON.parse(
                                    params[33] || '[]'
                                ),
                                request_headers: JSON.parse(params[34] || '{}'),
                                request_payload: JSON.parse(params[35] || '{}'),
                                response_payload:
                                    params[36] == null
                                        ? null
                                        : JSON.parse(params[36]),
                                response_excerpt: params[37],
                                response_fingerprint: params[38],
                                input_tokens: params[39],
                                output_tokens: params[40],
                                total_tokens: params[41],
                                input_cost_usd: params[42],
                                output_cost_usd: params[43],
                                total_cost_usd: params[44],
                                budget_exempt: params[45],
                                flags: JSON.parse(params[46] || '{}'),
                                metadata: JSON.parse(params[47] || '{}'),
                            },
                            () => key
                        );
                        return { rows: [cloneRow(row)] };
                    }

                    throw new Error(`Unexpected target client query: ${sql}`);
                },
                release() {},
            };
        },
    };

    return { sourcePool, targetPool, state };
}

function buildSnapshotFromImportState(state) {
    const providers = new Map();
    for (const row of state.providers) {
        providers.set(
            row.provider_key,
            Object.freeze({
                id: row.id,
                providerKey: row.provider_key,
                provider_key: row.provider_key,
                displayName: row.display_name,
                display_name: row.display_name,
                backendKey: row.adapter_key,
                adapter_key: row.adapter_key,
                baseUrl: row.base_url,
                base_url: row.base_url,
            })
        );
    }

    const childrenByParent = new Map();
    for (const row of state.modelChildren) {
        let list = childrenByParent.get(row.parent_model_id);
        if (!list) {
            list = [];
            childrenByParent.set(row.parent_model_id, list);
        }
        list.push({
            modelKey: row.child_model_key,
            modelId: row.child_model_id,
            priority: row.priority,
            settings: row.settings || {},
            childEnabled: row.enabled,
        });
    }

    const models = new Map();
    for (const row of state.models) {
        const provider = row.provider_id
            ? state.providers.find((entry) => entry.id === row.provider_id)
            : null;
        const children = (childrenByParent.get(row.id) || []).sort(
            (a, b) => a.priority - b.priority
        );
        models.set(
            row.model_key,
            Object.freeze({
                id: row.id,
                modelKey: row.model_key,
                model_key: row.model_key,
                displayName: row.display_name,
                display_name: row.display_name,
                providerId: row.provider_id,
                provider_id: row.provider_id,
                providerKey: provider?.provider_key || null,
                provider_key: provider?.provider_key || null,
                providerModelId: row.provider_model_id,
                provider_model_id: row.provider_model_id,
                executionKind: row.execution_kind,
                execution_kind: row.execution_kind,
                enabled: row.enabled,
                concurrencyLimit: row.concurrency_limit,
                concurrency_limit: row.concurrency_limit,
                queueTimeoutMs: row.queue_timeout_ms,
                queue_timeout_ms: row.queue_timeout_ms,
                requestTimeoutMs: row.request_timeout_ms,
                request_timeout_ms: row.request_timeout_ms,
                pricingMode: row.pricing_mode,
                pricing_mode: row.pricing_mode,
                inputPricePerMillion: row.input_price_per_million,
                input_price_per_million: row.input_price_per_million,
                outputPricePerMillion: row.output_price_per_million,
                output_price_per_million: row.output_price_per_million,
                requestPriceUsd: row.request_price_usd,
                request_price_usd: row.request_price_usd,
                isFree: row.is_free,
                is_free: row.is_free,
                discoverySource: row.discovery_source,
                discovery_source: row.discovery_source,
                metadata: row.metadata || {},
                strategyKind: row.strategy_kind,
                strategy_kind: row.strategy_kind,
                maxAttempts: row.max_attempts,
                max_attempts: row.max_attempts,
                children:
                    row.strategy_kind === 'cascade'
                        ? Object.freeze(
                              children.map((child) => Object.freeze(child))
                          )
                        : null,
            })
        );
    }

    const middlewareMeta = new Map(
        state.middlewares.map((row) => [row.middleware_key, row])
    );
    const byModel = new Map();
    for (const binding of state.middlewareBindings) {
        if (binding.scope !== 'model') continue;
        const meta = middlewareMeta.get(binding.middleware_key);
        const list = byModel.get(binding.target_id) || [];
        list.push(
            Object.freeze({
                middlewareKey: binding.middleware_key,
                sourceType: meta?.source_type || 'builtin',
                modulePath: meta?.module_path || null,
                middlewareDefaultSettings: meta?.default_settings || {},
                settings: binding.settings || {},
                sortOrder: binding.sort_order,
                enabled: binding.enabled,
            })
        );
        byModel.set(binding.target_id, list);
    }
    for (const [key, rows] of byModel) {
        rows.sort((a, b) => a.sortOrder - b.sortOrder);
        byModel.set(key, Object.freeze(rows));
    }

    return Object.freeze({
        models,
        aliases: new Map(),
        providers,
        cooldowns: new Set(),
        middlewareBindings: Object.freeze({
            gateway: Object.freeze([]),
            byModel,
            byProvider: new Map(),
        }),
        loadedAt: Date.now(),
    });
}

function computeLegacyDispatchOrder(source, tierName, seen = new Set()) {
    if (seen.has(tierName)) return [];
    seen.add(tierName);

    const tier = source.models.find(
        (row) => row.type === 'tier' && row.name === tierName
    );
    if (!tier) return [tierName];

    const order = [];
    for (const ref of tier.model_refs || []) {
        const target = source.models.find((row) => row.name === ref);
        if (!target) continue;
        if (target.type === 'tier') {
            order.push(
                ...computeLegacyDispatchOrder(source, target.name, seen)
            );
        } else {
            order.push(target.provider_model || target.name);
        }
    }

    if (tier.fallback_model) {
        const fallback = source.models.find(
            (row) => row.name === tier.fallback_model
        );
        if (fallback) {
            if (fallback.type === 'tier') {
                order.push(
                    ...computeLegacyDispatchOrder(source, fallback.name, seen)
                );
            } else {
                order.push(fallback.provider_model || fallback.name);
            }
        }
    }

    return order;
}

async function* streamForText(text) {
    yield {
        type: 'message_start',
        data: { id: 'msg-1', model: 'fixture', role: 'assistant' },
    };
    yield { type: 'text_delta', data: { text } };
    yield {
        type: 'usage',
        data: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
    };
    yield { type: 'done', data: { finish_reason: 'stop' } };
}

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

function cloneRows(rows) {
    return rows.map((row) => cloneRow(row));
}

function cloneRow(row) {
    return { ...row };
}

function nextId(seq, key, prefix) {
    const id = `${prefix}-${seq[key]}`;
    seq[key] += 1;
    return id;
}

function upsertBy(rows, uniqueField, incoming, createId) {
    const existing = rows.find((row) =>
        compareField(row[uniqueField], incoming[uniqueField])
    );
    if (existing) {
        const { id: _ignoredId, ...rest } = incoming;
        Object.assign(existing, rest);
        return existing;
    }
    const row = {
        ...incoming,
        id: createId(),
    };
    rows.push(row);
    return row;
}

function upsertBinding(rows, incoming, createId) {
    const existing = rows.find(
        (row) =>
            row.scope === incoming.scope &&
            row.target_id === incoming.target_id &&
            row.middleware_key === incoming.middleware_key
    );
    if (existing) {
        const { id: _ignoredId, ...rest } = incoming;
        Object.assign(existing, rest);
        return existing;
    }
    const row = {
        ...incoming,
        id: createId(),
    };
    rows.push(row);
    return row;
}

function compareField(left, right) {
    if (Buffer.isBuffer(left) && Buffer.isBuffer(right)) {
        return left.equals(right);
    }
    return left === right;
}

function compareStartedAtId(left, right) {
    if (left.started_at < right.started_at) return -1;
    if (left.started_at > right.started_at) return 1;
    if (left.id < right.id) return -1;
    if (left.id > right.id) return 1;
    return 0;
}

function findBy(rows, field, value) {
    const row = rows.find((entry) => entry[field] === value);
    assert.ok(row, `Expected row with ${field}=${value}`);
    return row;
}

function noopLog() {
    return {
        debug() {},
        info() {},
        warn() {},
        error() {},
        fatal() {},
    };
}
