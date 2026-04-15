import { describe, it, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, randomBytes } from 'node:crypto';
import { Readable } from 'node:stream';
import { EventEmitter } from 'node:events';
import { MetricsService } from '../../observability/metrics-service.mjs';
import { ExportService } from '../../observability/export-service.mjs';
import { AuthenticationRequiredError } from '../../core/errors.mjs';

// ── Test helpers ────────────────────────────────────────────────────

function createMockPool(queryFn) {
    return {
        query: queryFn || (async () => ({ rows: [], rowCount: 0 })),
    };
}

function makeSigningKey() {
    return 'test-signing-key-' + randomBytes(8).toString('hex');
}

function signAdminToken(expiresAt, signingKey, csrfToken = null) {
    const payload = csrfToken ? `${expiresAt}.${csrfToken}` : String(expiresAt);
    const sig = createHmac('sha256', signingKey).update(payload).digest('hex');
    return `${payload}.${sig}`;
}

function createMockAppCtx(overrides = {}) {
    const signingKey = overrides.signingKey || makeSigningKey();
    const services = { ...(overrides.services || {}) };
    const availableBackends = new Map(
        (overrides.availableBackends || [
            'openai-api',
            'anthropic-api',
            'gemini-openai',
            'search-builtin',
            'codex-api',
            'copilot-api',
            'custom-backend',
        ]).map((key) => [
            key,
            {
                manifest: {
                    key,
                    kind: key === 'custom-backend' ? 'custom' : 'external_api',
                },
            },
        ])
    );
    const availableProviderMiddlewares = new Map(
        (overrides.availableProviderMiddlewares || [
            'provider-context-compacter',
            'provider-output-compressor',
            'provider-prompt-injector',
            'provider-response-filter',
        ]).map((key) => [
            key,
            {
                meta: {
                    key,
                    name: key,
                    description: '',
                    version: '1.0.0',
                    defaultSettings: {},
                },
                factory: () => async (_ctx, next) => {
                    if (typeof next === 'function') {
                        await next();
                    }
                },
            },
        ])
    );

    if (!services.backendCatalog) {
        services.backendCatalog = {
            getBackend(key) {
                return availableBackends.get(key) || null;
            },
            listKeys() {
                return [...availableBackends.keys()];
            },
            getTemplates() {
                return {};
            },
        };
    }

    if (!services.providerMiddlewareRegistry) {
        services.providerMiddlewareRegistry = {
            get(key) {
                return availableProviderMiddlewares.get(key) || null;
            },
            listKeys() {
                return [...availableProviderMiddlewares.keys()];
            },
            build(key, settings = {}) {
                const module = availableProviderMiddlewares.get(key);
                return module ? module.factory(settings) : null;
            },
            get size() {
                return availableProviderMiddlewares.size;
            },
        };
    }

    if (!services.refreshRuntime) {
        services.refreshRuntime = async (options = {}) => {
            const result = {
                reason: options.reason || 'test',
                snapshotGeneration: 1,
                middlewareGeneration: null,
                middlewareCount: null,
                backendCatalogGeneration: null,
                backendCount: null,
            };

            if (
                options.middlewareCatalog &&
                typeof services.reloadMiddlewareCatalog === 'function'
            ) {
                const middleware = await services.reloadMiddlewareCatalog();
                result.middlewareGeneration = middleware?.generation ?? null;
                result.middlewareCount = middleware?.count ?? null;
            }

            if (
                options.backendCatalog &&
                typeof services.reloadBackendCatalog === 'function'
            ) {
                const backends = await services.reloadBackendCatalog();
                result.backendCatalogGeneration =
                    backends?.generation ?? null;
                result.backendCount = backends?.count ?? null;
            }

            if (
                options.snapshot &&
                typeof services.reloadRuntimeSnapshot === 'function'
            ) {
                const snapshot = await services.reloadRuntimeSnapshot();
                result.snapshotGeneration =
                    snapshot?.generation ?? result.snapshotGeneration;
            }

            return result;
        };
    }

    if (!services.refreshRuntimeAsync) {
        services.refreshRuntimeAsync = (options = {}) =>
            services.refreshRuntime(options);
    }

    return {
        config: {
            env: {
                DASHBOARD_PASSWORD: overrides.dashboardPassword || 'testpass',
                ADMIN_SESSION_SIGNING_KEY: signingKey,
                ENCRYPTION_KEY: null,
                API_KEY_HASH_PEPPER: 'test-pepper',
                DATA_DIR: '/tmp/soul-gateway-test',
                DASHBOARD_STATIC_DIR: '/tmp/soul-gateway-test/dashboard',
            },
            defaults: {
                adminSessionTtlMs: 43_200_000,
                apiKeyPrefix: 'sk-soul-',
                requestIdPrefix: 'chatcmpl-',
                systemMetricsSampleMs: 15_000,
            },
        },
        pool: overrides.pool || createMockPool(),
        log: { info() {}, warn() {}, error() {}, debug() {} },
        services: Object.assign(services, {
            metricsService: services.metricsService || new MetricsService(overrides.pool || createMockPool()),
            exportService: services.exportService || new ExportService(overrides.pool || createMockPool()),
        }),
        draining: false,
        snapshotGeneration: 1,
        startedAt: Date.now(),
        _signingKey: signingKey,
    };
}

function createMockReq({ method = 'GET', headers = {}, body = null } = {}) {
    const req = new EventEmitter();
    req.method = method;
    req.headers = headers;
    req.url = '/';
    req.destroy = () => {};

    // Simulate readable body
    if (body) {
        const json = JSON.stringify(body);
        process.nextTick(() => {
            req.emit('data', Buffer.from(json));
            req.emit('end');
        });
    } else {
        process.nextTick(() => req.emit('end'));
    }

    return req;
}

function createMockRes() {
    const res = {
        statusCode: null,
        headers: {},
        body: null,
        destroyed: false,
        writeHead(status, headers) {
            res.statusCode = status;
            Object.assign(res.headers, headers);
        },
        setHeader(key, value) {
            res.headers[key] = value;
        },
        write(data) {
            if (!res.body) res.body = '';
            res.body += data;
        },
        end(data) {
            if (data) {
                if (!res.body) res.body = '';
                res.body += data;
            }
        },
        on() {},
    };
    return res;
}

function parseJsonResponse(res) {
    return JSON.parse(res.body);
}

function compactSql(sql) {
    return sql.replace(/\s+/g, ' ').trim();
}

function addAdminAuth(req, appCtx, { csrfToken = null } = {}) {
    const token = signAdminToken(
        Date.now() + 3_600_000,
        appCtx._signingKey,
        csrfToken
    );
    req.headers.authorization = `Bearer ${token}`;
    return token;
}

// ── Auth route tests ────────────────────────────────────────────────

describe('management/auth-route', () => {
    let handleLogin, handleLogout, handleSession;

    beforeEach(async () => {
        ({ handleLogin, handleLogout, handleSession } = await import(
            '../../management/auth-route.mjs'
        ));
    });

    it('handleLogin returns token for valid password', async () => {
        const appCtx = createMockAppCtx();
        const req = createMockReq({
            method: 'POST',
            body: { password: 'testpass' },
        });
        const res = createMockRes();

        await handleLogin({ req, res, params: {}, query: {}, appCtx });

        assert.equal(res.statusCode, 200);
        const body = parseJsonResponse(res);
        assert.equal(body.ok, true);
        assert.ok(body.token);
        assert.ok(body.expiresAt);
        assert.ok(body.csrfToken);
    });

    it('handleLogin rejects wrong password', async () => {
        const appCtx = createMockAppCtx();
        const req = createMockReq({
            method: 'POST',
            body: { password: 'wrong' },
        });
        const res = createMockRes();

        await assert.rejects(
            () => handleLogin({ req, res, params: {}, query: {}, appCtx }),
            (err) => err.httpStatus === 401
        );
    });

    it('handleLogin rejects missing password field', async () => {
        const appCtx = createMockAppCtx();
        const req = createMockReq({ method: 'POST', body: {} });
        const res = createMockRes();

        await assert.rejects(
            () => handleLogin({ req, res, params: {}, query: {}, appCtx }),
            (err) => err.httpStatus === 400
        );
    });

    it('handleSession returns authenticated: true for valid session', async () => {
        const appCtx = createMockAppCtx();
        const req = createMockReq();
        addAdminAuth(req, appCtx, { csrfToken: 'csrf-valid' });
        const res = createMockRes();

        await handleSession({ req, res, params: {}, query: {}, appCtx });

        assert.equal(res.statusCode, 200);
        const body = parseJsonResponse(res);
        assert.equal(body.authenticated, true);
    });

    it('handleSession returns authenticated: false for missing session', async () => {
        const appCtx = createMockAppCtx();
        const req = createMockReq();
        const res = createMockRes();

        await handleSession({ req, res, params: {}, query: {}, appCtx });

        assert.equal(res.statusCode, 200);
        const body = parseJsonResponse(res);
        assert.equal(body.authenticated, false);
    });

    it('handleLogout clears the session cookie when CSRF token matches', async () => {
        const appCtx = createMockAppCtx();
        const req = createMockReq({
            method: 'POST',
            headers: { 'x-csrf-token': 'csrf-1' },
        });
        addAdminAuth(req, appCtx, { csrfToken: 'csrf-1' });
        const res = createMockRes();

        await handleLogout({ req, res, params: {}, query: {}, appCtx });

        assert.equal(res.statusCode, 200);
        assert.ok(res.headers['Set-Cookie'].includes('Max-Age=0'));
    });

    it('handleLogout rejects tokens without CSRF component', async () => {
        const appCtx = createMockAppCtx();
        const req = createMockReq({ method: 'POST' });
        addAdminAuth(req, appCtx); // token without csrfToken is now rejected
        const res = createMockRes();

        await assert.rejects(
            () => handleLogout({ req, res, params: {}, query: {}, appCtx }),
            (err) => err instanceof AuthenticationRequiredError
        );
    });

    it('handleLogout rejects a missing CSRF token header for valid sessions', async () => {
        const appCtx = createMockAppCtx();
        const req = createMockReq({ method: 'POST' });
        addAdminAuth(req, appCtx, { csrfToken: 'csrf-1' });
        const res = createMockRes();

        await assert.rejects(
            () => handleLogout({ req, res, params: {}, query: {}, appCtx }),
            (err) => err.httpStatus === 400
        );
    });
});

// ── Keys route tests ────────────────────────────────────────────────

describe('management/keys-route', () => {
    let handleListKeys,
        handleCreateKey,
        handleGetKey,
        handleUpdateKey,
        handleRevokeKey;

    beforeEach(async () => {
        ({
            handleListKeys,
            handleCreateKey,
            handleGetKey,
            handleUpdateKey,
            handleRevokeKey,
        } = await import('../../management/keys-route.mjs'));
    });

    it('handleListKeys returns key list', async () => {
        const mockRow = {
            id: 'k1',
            label: 'Test Key',
            status: 'active',
            key_hash: 'h',
            key_ciphertext: 'c',
            key_iv: 'i',
            key_auth_tag: 't',
            key_hint: 'sk-s...1234',
            rpm_limit: 60,
        };
        const pool = createMockPool(async () => ({ rows: [mockRow] }));
        const appCtx = createMockAppCtx({ pool });
        const res = createMockRes();

        await handleListKeys({
            req: createMockReq(),
            res,
            params: {},
            query: {},
            appCtx,
        });

        assert.equal(res.statusCode, 200);
        const body = parseJsonResponse(res);
        assert.equal(body.data.length, 1);
        // Sensitive fields should be stripped
        assert.equal(body.data[0].key_hash, undefined);
        assert.equal(body.data[0].key_ciphertext, undefined);
    });

    it('handleGetKey returns 404 for unknown key', async () => {
        const pool = createMockPool(async () => ({ rows: [] }));
        const appCtx = createMockAppCtx({ pool });
        const res = createMockRes();

        await handleGetKey({
            req: createMockReq(),
            res,
            params: { keyId: 'unknown' },
            query: {},
            appCtx,
        });

        assert.equal(res.statusCode, 404);
    });

    it('handleRevokeKey returns 404 for already revoked', async () => {
        const pool = createMockPool(async () => ({ rows: [] }));
        const appCtx = createMockAppCtx({ pool });
        const res = createMockRes();

        await handleRevokeKey({
            req: createMockReq(),
            res,
            params: { keyId: 'k1' },
            query: {},
            appCtx,
        });

        assert.equal(res.statusCode, 404);
    });
});

// ── Models route tests ──────────────────────────────────────────────

describe('management/models-route', () => {
    let handleListModels,
        handleCreateModel,
        handleGetModel,
        handleUpdateModel,
        handleDeleteModel,
        handleListModelProviders,
        handleListProviderModels,
        handleListModelTags;

    beforeEach(async () => {
        ({
            handleListModels,
            handleCreateModel,
            handleGetModel,
            handleUpdateModel,
            handleDeleteModel,
            handleListModelProviders,
            handleListProviderModels,
            handleListModelTags,
        } = await import('../../management/models-route.mjs'));
    });

    it('handleListModels returns model list', async () => {
        const mockRow = {
            id: 'm1',
            model_key: 'gpt-4o',
            display_name: 'GPT-4o',
            enabled: true,
        };
        const pool = createMockPool(async () => ({ rows: [mockRow] }));
        const appCtx = createMockAppCtx({ pool });
        const res = createMockRes();

        await handleListModels({
            req: createMockReq(),
            res,
            params: {},
            query: {},
            appCtx,
        });

        assert.equal(res.statusCode, 200);
        const body = parseJsonResponse(res);
        assert.equal(body.data.length, 1);
        assert.equal(body.data[0].model_key, 'gpt-4o');
    });

    it('handleListModels overlays missing pricing, context, and tags from the pricing directory', async () => {
        const mockRow = {
            id: 'm1',
            model_key: 'nvidia/google/gemma-3-27b-it',
            display_name: 'Gemma 3 27B',
            provider_key: 'nvidia',
            provider_model_id: 'google/gemma-3-27b-it',
            pricing_mode: 'external_directory',
            input_price_per_million: null,
            output_price_per_million: null,
            request_price_usd: null,
            capabilities: {},
            tags: [],
            metadata: {},
            is_free: false,
            enabled: true,
        };
        const pool = createMockPool(async () => ({ rows: [mockRow] }));
        const appCtx = createMockAppCtx({
            pool,
            services: {
                pricingDirectory: {
                    async refreshIfNeeded() {},
                    lookupModel(providerKey, modelId) {
                        assert.equal(providerKey, 'nvidia');
                        assert.equal(modelId, 'google/gemma-3-27b-it');
                        return {
                            id: 'google/gemma-3-27b-it',
                            canonicalSlug: 'google/gemma-3-27b-it',
                            matchedBy: 'id',
                            pricingMode: 'token',
                            inputPricePerMillion: 0.27,
                            outputPricePerMillion: 0.4,
                            requestPriceUsd: null,
                            isFree: false,
                            contextWindow: 131072,
                            maxOutputTokens: 8192,
                            supportsTools: true,
                            supportsVision: true,
                            tags: ['tool-calling', 'vision'],
                            description: 'test',
                        };
                    },
                    get url() {
                        return 'https://openrouter.ai/api/v1/models';
                    },
                },
            },
        });
        const res = createMockRes();

        await handleListModels({
            req: createMockReq(),
            res,
            params: {},
            query: {},
            appCtx,
        });

        const body = parseJsonResponse(res);
        assert.equal(body.data[0].pricing_mode, 'token');
        assert.equal(body.data[0].input_price_per_million, 0.27);
        assert.equal(body.data[0].capabilities.contextWindow, 131072);
        assert.equal(body.data[0].capabilities.maxOutputTokens, 8192);
        // Tags union: directory supplies tool-calling/vision capability tags;
        // the classifier adds curated family tags (chat/fast from the
        // gemma rule) and long-context (131072 >= threshold). `nvidia` is
        // not in TOOL_CALLING_PROVIDER_KEYS so no augmentation.
        assert.deepEqual(body.data[0].tags, [
            'chat',
            'fast',
            'long-context',
            'tool-calling',
            'vision',
        ]);
        assert.equal(body.data[0].metadata.openrouter.matchedBy, 'id');
        assert.equal(
            body.data[0].metadata.classifier.source,
            'model-metadata-classifier'
        );
    });

    it('handleCreateModel rejects missing required fields', async () => {
        const appCtx = createMockAppCtx();
        const req = createMockReq({
            method: 'POST',
            body: { modelKey: 'test' },
        });
        const res = createMockRes();

        await assert.rejects(
            () =>
                handleCreateModel({ req, res, params: {}, query: {}, appCtx }),
            (err) => err.httpStatus === 400
        );
    });

    it('handleGetModel returns 404 for missing model', async () => {
        const pool = createMockPool(async () => ({ rows: [] }));
        const appCtx = createMockAppCtx({ pool });
        const res = createMockRes();

        await handleGetModel({
            req: createMockReq(),
            res,
            params: { modelId: 'x' },
            query: {},
            appCtx,
        });

        assert.equal(res.statusCode, 404);
    });

    it('handleUpdateModel rejects empty body', async () => {
        const appCtx = createMockAppCtx();
        const req = createMockReq({ method: 'PATCH', body: {} });
        const res = createMockRes();

        await assert.rejects(
            () =>
                handleUpdateModel({
                    req,
                    res,
                    params: { modelId: 'm1' },
                    query: {},
                    appCtx,
                }),
            (err) => err.httpStatus === 400
        );
    });

    it('handleDeleteModel returns 404 for missing model', async () => {
        const pool = createMockPool(async () => ({ rows: [], rowCount: 0 }));
        const appCtx = createMockAppCtx({ pool });
        const res = createMockRes();

        await handleDeleteModel({
            req: createMockReq(),
            res,
            params: { modelId: 'x' },
            query: {},
            appCtx,
        });

        assert.equal(res.statusCode, 404);
    });

    it('handleListModelProviders returns all enabled providers, not just those with model rows', async () => {
        const pool = createMockPool(async (sql) => {
            if (sql.includes('FROM soul_gateway.providers')) {
                return {
                    rows: [
                        {
                            provider_id: 'p1',
                            provider_key: 'openai',
                            display_name: 'OpenAI',
                        },
                        {
                            provider_id: 'p2',
                            provider_key: 'groq',
                            display_name: 'Groq',
                        },
                    ],
                };
            }
            return { rows: [] };
        });
        const appCtx = createMockAppCtx({ pool });
        const res = createMockRes();

        await handleListModelProviders({
            req: createMockReq(),
            res,
            params: {},
            query: {},
            appCtx,
        });

        assert.equal(res.statusCode, 200);
        const body = parseJsonResponse(res);
        assert.deepEqual(body.data, [
            {
                provider_id: 'p1',
                provider_key: 'openai',
                display_name: 'OpenAI',
            },
            {
                provider_id: 'p2',
                provider_key: 'groq',
                display_name: 'Groq',
            },
        ]);
    });

    it('handleListProviderModels discovers provider models from the backend catalog', async () => {
        const pool = createMockPool(async (sql, params) => {
            if (
                sql.includes('FROM soul_gateway.providers') &&
                sql.includes('provider_key = $1')
            ) {
                assert.deepEqual(params, ['openai']);
                return {
                    rows: [
                        {
                            id: 'p1',
                            provider_key: 'openai',
                            display_name: 'OpenAI',
                            adapter_key: 'openai-api',
                            auth_strategy: 'api_key',
                            provider_mode: 'external_api',
                            base_url: 'https://api.openai.com/v1',
                            enabled: true,
                            settings: {},
                            metadata: {},
                        },
                    ],
                };
            }
            return { rows: [] };
        });
        const appCtx = createMockAppCtx({
            pool,
            services: {
                backendCatalog: {
                    getBackend(key) {
                        assert.equal(key, 'openai-api');
                        return {
                            manifest: { key: 'openai-api' },
                            async discoverModels() {
                                return [
                                    {
                                        modelId: 'gpt-5.4',
                                        displayName: 'GPT-5.4',
                                        pricing: {
                                            mode: 'token',
                                            inputPricePerMillion: 1.25,
                                            outputPricePerMillion: 10,
                                        },
                                    },
                                ];
                            },
                        };
                    },
                },
            },
        });
        const res = createMockRes();

        await handleListProviderModels({
            req: createMockReq(),
            res,
            params: { key: 'openai' },
            query: {},
            appCtx,
        });

        assert.equal(res.statusCode, 200);
        const body = parseJsonResponse(res);
        assert.equal(body.data.length, 1);
        const [row] = body.data;
        assert.equal(row.provider_model_id, 'gpt-5.4');
        assert.equal(row.display_name, 'GPT-5.4');
        assert.equal(row.pricing_mode, 'token');
        assert.equal(row.input_price_per_million, 1.25);
        assert.equal(row.output_price_per_million, 10);
        assert.equal(row.request_price_usd, null);
        assert.equal(row.is_free, false);
        assert.deepEqual(row.capabilities, {});
        // Classifier tags: gpt-5.4 matches the gpt-5.[1234] rule
        // (reasoning, coding), the gpt-5 rule (reasoning, chat), and the
        // catch-all gpt- rule (chat). `openai` is in
        // TOOL_CALLING_PROVIDER_KEYS so tool-calling is augmented in.
        assert.deepEqual(row.tags, [
            'chat',
            'coding',
            'reasoning',
            'tool-calling',
        ]);
        assert.equal(
            row.metadata.classifier.source,
            'model-metadata-classifier'
        );
        // No pricingDirectory configured here so no openrouter provenance
        // should be attached.
        assert.equal(row.metadata.openrouter, undefined);
    });

    it('handleListProviderModels overlays missing discovery metadata from the pricing directory', async () => {
        const pool = createMockPool(async (sql, params) => {
            if (
                sql.includes('FROM soul_gateway.providers') &&
                sql.includes('provider_key = $1')
            ) {
                assert.deepEqual(params, ['nvidia']);
                return {
                    rows: [
                        {
                            id: 'p1',
                            provider_key: 'nvidia',
                            display_name: 'NVIDIA',
                            adapter_key: 'openai-api',
                            auth_strategy: 'api_key',
                            provider_mode: 'external_api',
                            base_url: 'https://integrate.api.nvidia.com/v1',
                            enabled: true,
                            settings: {},
                            metadata: {},
                        },
                    ],
                };
            }
            return { rows: [] };
        });
        const appCtx = createMockAppCtx({
            pool,
            services: {
                backendCatalog: {
                    getBackend(key) {
                        assert.equal(key, 'openai-api');
                        return {
                            manifest: { key: 'openai-api' },
                            async discoverModels() {
                                return [
                                    {
                                        modelId: 'google/gemma-3-27b-it',
                                        displayName: 'Gemma 3 27B',
                                        supportsTools: true,
                                        supportsStreaming: true,
                                        supportsVision: false,
                                    },
                                ];
                            },
                        };
                    },
                },
                pricingDirectory: {
                    async refreshIfNeeded() {},
                    lookupModel(providerKey, modelId, options) {
                        assert.equal(providerKey, 'nvidia');
                        assert.equal(modelId, 'google/gemma-3-27b-it');
                        assert.equal(options.displayName, 'Gemma 3 27B');
                        return {
                            id: 'google/gemma-3-27b-it',
                            canonicalSlug: 'google/gemma-3-27b-it',
                            matchedBy: 'id',
                            pricingMode: 'token',
                            inputPricePerMillion: 0.27,
                            outputPricePerMillion: 0.4,
                            requestPriceUsd: null,
                            isFree: false,
                            contextWindow: 131072,
                            maxOutputTokens: 8192,
                            supportsTools: true,
                            supportsVision: true,
                            tags: ['tool-calling', 'vision'],
                            description: 'test',
                        };
                    },
                    get url() {
                        return 'https://openrouter.ai/api/v1/models';
                    },
                },
            },
        });
        const res = createMockRes();

        await handleListProviderModels({
            req: createMockReq(),
            res,
            params: { key: 'nvidia' },
            query: {},
            appCtx,
        });

        assert.equal(res.statusCode, 200);
        const body = parseJsonResponse(res);
        assert.equal(body.data.length, 1);
        const [row] = body.data;
        assert.equal(row.provider_model_id, 'google/gemma-3-27b-it');
        assert.equal(row.display_name, 'Gemma 3 27B');
        assert.equal(row.pricing_mode, 'token');
        assert.equal(row.input_price_per_million, 0.27);
        assert.equal(row.output_price_per_million, 0.4);
        assert.equal(row.is_free, false);
        // Provider explicitly reported supportsVision=false; directory
        // says true, but provider-supplied capability wins.
        assert.deepEqual(row.capabilities, {
            contextWindow: 131072,
            maxOutputTokens: 8192,
            supportsTools: true,
            supportsStreaming: true,
            supportsVision: false,
        });
        // Tags union: provider explicitly reported supportsVision=false,
        // so the directory's `vision` tag must not be merged back in.
        // The directory still contributes `tool-calling`; the classifier
        // adds chat/fast (gemma rule) and long-context (131072 threshold).
        // nvidia is not in TOOL_CALLING_PROVIDER_KEYS — no augmentation.
        assert.deepEqual(row.tags, [
            'chat',
            'fast',
            'long-context',
            'tool-calling',
        ]);
        assert.equal(row.metadata.openrouter.matchedBy, 'id');
        assert.equal(row.metadata.openrouter.id, 'google/gemma-3-27b-it');
        assert.equal(
            row.metadata.classifier.source,
            'model-metadata-classifier'
        );
    });

    it('handleListModelTags returns PREDEFINED_MODEL_TAGS union with stored tags on a sparse DB', async () => {
        const pool = createMockPool(async () => ({ rows: [] }));
        const appCtx = createMockAppCtx({ pool });
        const res = createMockRes();

        await handleListModelTags({
            req: createMockReq(),
            res,
            params: {},
            query: {},
            appCtx,
        });

        assert.equal(res.statusCode, 200);
        const body = parseJsonResponse(res);
        // Even with no stored rows, the predefined taxonomy must surface
        // so the dashboard tag-filter chip row has a stable vocabulary.
        for (const tag of [
            'tool-calling',
            'vision',
            'coding',
            'reasoning',
            'agentic',
            'fast',
            'long-context',
        ]) {
            assert.ok(
                body.data.includes(tag),
                `expected ${tag} in union with empty DB`
            );
        }
        // Response must be sorted and contain no duplicates.
        assert.deepEqual(body.data, [...new Set(body.data)].sort());
    });

    it('handleListModelTags merges custom stored tags that are not part of the taxonomy', async () => {
        const pool = createMockPool(async () => ({
            rows: [{ tag: 'custom-internal' }, { tag: 'experimental' }],
        }));
        const appCtx = createMockAppCtx({ pool });
        const res = createMockRes();

        await handleListModelTags({
            req: createMockReq(),
            res,
            params: {},
            query: {},
            appCtx,
        });

        const body = parseJsonResponse(res);
        assert.ok(body.data.includes('custom-internal'));
        assert.ok(body.data.includes('experimental'));
        assert.ok(body.data.includes('tool-calling'));
        // Stored tag duplicates of the taxonomy must not appear twice.
        const counts = new Map();
        for (const tag of body.data) {
            counts.set(tag, (counts.get(tag) || 0) + 1);
        }
        for (const [tag, count] of counts) {
            assert.equal(count, 1, `tag ${tag} must appear once`);
        }
    });
});

// ── Tiers route tests ───────────────────────────────────────────────

describe('management/tiers-route', () => {
    let handleListTiers,
        handleCreateTier,
        handleUpdateTier;

    beforeEach(async () => {
        ({
            handleListTiers,
            handleCreateTier,
            handleUpdateTier,
        } = await import('../../management/tiers-route.mjs'));
    });

    it('handleListTiers returns only cascade models with child models', async () => {
        const pool = createMockPool(async (sql) => {
            const normalized = compactSql(sql);

            if (
                normalized.includes('FROM soul_gateway.models m') &&
                normalized.includes('LEFT JOIN soul_gateway.providers p')
            ) {
                return {
                    rows: [
                        {
                            id: 'tier-1',
                            model_key: 'axl/fast',
                            display_name: 'Fast Tier',
                            enabled: true,
                            strategy_kind: 'cascade',
                            max_attempts: 4,
                        },
                        {
                            id: 'model-1',
                            model_key: 'openai/gpt-4.1',
                            display_name: 'GPT-4.1',
                            enabled: true,
                            strategy_kind: 'direct',
                        },
                    ],
                };
            }

            if (normalized.includes('FROM soul_gateway.model_children mc')) {
                return {
                    rows: [
                        {
                            id: 'binding-1',
                            parent_model_id: 'tier-1',
                            child_model_id: 'model-1',
                            child_model_key: 'openai/gpt-4.1',
                            child_display_name: 'GPT-4.1',
                            child_enabled: true,
                            priority: 1,
                        },
                    ],
                };
            }

            throw new Error(`Unexpected query: ${normalized}`);
        });
        const appCtx = createMockAppCtx({ pool });
        const res = createMockRes();

        await handleListTiers({
            req: createMockReq(),
            res,
            params: {},
            query: {},
            appCtx,
        });

        assert.equal(res.statusCode, 200);
        const body = parseJsonResponse(res);
        assert.equal(body.data.length, 1);
        assert.equal(body.data[0].tierKey, 'axl/fast');
        assert.equal(body.data[0].children.length, 1);
        assert.equal(body.data[0].children[0].modelKey, 'openai/gpt-4.1');
    });

    it('handleCreateTier rejects unsupported request fields', async () => {
        const appCtx = createMockAppCtx();
        const req = createMockReq({
            method: 'POST',
            body: {
                name: 'axl/fast',
                displayName: 'Fast Tier',
            },
        });
        const res = createMockRes();

        await assert.rejects(
            () =>
                handleCreateTier({ req, res, params: {}, query: {}, appCtx }),
            (err) =>
                err.httpStatus === 400 &&
                err.message.includes('Unsupported fields')
        );
    });

    it('handleCreateTier creates a cascade tier from ordered direct child ids', async () => {
        let snapshotReloads = 0;
        const pool = createMockPool(async (sql, params) => {
            const normalized = compactSql(sql);

            if (
                normalized ===
                'SELECT * FROM soul_gateway.models WHERE model_key = $1'
            ) {
                return { rows: [] };
            }

            if (
                normalized === 'SELECT * FROM soul_gateway.models WHERE id = $1'
            ) {
                if (params[0] === 'model-1') {
                    return {
                        rows: [
                            {
                                id: 'model-1',
                                model_key: 'openai/gpt-4.1',
                                strategy_kind: 'direct',
                            },
                        ],
                    };
                }
                if (params[0] === 'model-2') {
                    return {
                        rows: [
                            {
                                id: 'model-2',
                                model_key: 'anthropic/claude-sonnet-4',
                                strategy_kind: 'direct',
                            },
                        ],
                    };
                }
            }

            if (
                normalized.startsWith('INSERT INTO soul_gateway.models')
            ) {
                return {
                    rows: [
                        {
                            id: 'tier-1',
                            model_key: params[0],
                            display_name: params[1],
                            enabled: params[2],
                            strategy_kind: 'cascade',
                            max_attempts: params[3],
                        },
                    ],
                };
            }

            if (
                normalized === 'BEGIN' ||
                normalized === 'COMMIT' ||
                normalized === 'ROLLBACK'
            ) {
                return { rows: [], rowCount: 0 };
            }

            if (
                normalized ===
                'DELETE FROM soul_gateway.model_children WHERE parent_model_id = $1'
            ) {
                return { rows: [], rowCount: 0 };
            }

            if (
                normalized.startsWith('INSERT INTO soul_gateway.model_children')
            ) {
                return { rows: [], rowCount: 1 };
            }

            if (normalized.includes('FROM soul_gateway.model_children mc')) {
                return {
                    rows: [
                        {
                            id: 'binding-1',
                            parent_model_id: 'tier-1',
                            child_model_id: 'model-1',
                            child_model_key: 'openai/gpt-4.1',
                            child_display_name: 'GPT-4.1',
                            child_enabled: true,
                            priority: 1,
                        },
                        {
                            id: 'binding-2',
                            parent_model_id: 'tier-1',
                            child_model_id: 'model-2',
                            child_model_key: 'anthropic/claude-sonnet-4',
                            child_display_name: 'Claude Sonnet 4',
                            child_enabled: true,
                            priority: 2,
                        },
                    ],
                };
            }

            throw new Error(`Unexpected query: ${normalized}`);
        });
        const appCtx = createMockAppCtx({
            pool,
            services: {
                reloadRuntimeSnapshot: async () => {
                    snapshotReloads += 1;
                    return { generation: 2 };
                },
            },
        });
        const req = createMockReq({
            method: 'POST',
            body: {
                tierKey: 'axl/fast',
                displayName: 'Fast Tier',
                maxAttempts: 6,
                childModelIds: ['model-1', 'model-2'],
            },
        });
        const res = createMockRes();

        await handleCreateTier({
            req,
            res,
            params: {},
            query: {},
            appCtx,
        });

        assert.equal(res.statusCode, 201);
        assert.equal(snapshotReloads, 1);
        const body = parseJsonResponse(res);
        assert.equal(body.tier.tierKey, 'axl/fast');
        assert.equal(body.tier.maxAttempts, 6);
        assert.deepEqual(
            body.tier.children.map((child) => child.modelId),
            ['model-1', 'model-2']
        );
    });

    it('handleUpdateTier rejects cascade child tiers in childModelIds', async () => {
        const pool = createMockPool(async (sql, params) => {
            const normalized = compactSql(sql);
            if (
                normalized === 'SELECT * FROM soul_gateway.models WHERE id = $1'
            ) {
                if (params[0] === 'tier-1') {
                    return {
                        rows: [
                            {
                                id: 'tier-1',
                                model_key: 'axl/fast',
                                display_name: 'Fast Tier',
                                strategy_kind: 'cascade',
                                enabled: true,
                                max_attempts: 5,
                            },
                        ],
                    };
                }
                if (params[0] === 'tier-2') {
                    return {
                        rows: [
                            {
                                id: 'tier-2',
                                model_key: 'axl/slow',
                                display_name: 'Slow Tier',
                                strategy_kind: 'cascade',
                                enabled: true,
                                max_attempts: 5,
                            },
                        ],
                    };
                }
            }

            throw new Error(`Unexpected query: ${normalized}`);
        });
        const appCtx = createMockAppCtx({ pool });
        const req = createMockReq({
            method: 'PATCH',
            body: { childModelIds: ['tier-2'] },
        });
        const res = createMockRes();

        await assert.rejects(
            () =>
                handleUpdateTier({
                    req,
                    res,
                    params: { tierId: 'tier-1' },
                    query: {},
                    appCtx,
                }),
            (err) =>
                err.httpStatus === 400 &&
                err.message.includes('direct models')
        );
    });
});

// ── Providers route tests ───────────────────────────────────────────

describe('management/providers-route', () => {
    let handleListProviders;
    let handleCreateProvider;
    let handleGetProvider;
    let handleUpdateProvider;
    let handleDeleteProvider;
    let handleAuthCallback;
    let handleListAccounts;
    let handleTestConnection;
    let handleDiscoverModels;

    beforeEach(async () => {
        ({
            handleListProviders,
            handleCreateProvider,
            handleGetProvider,
            handleUpdateProvider,
            handleDeleteProvider,
            handleAuthCallback,
            handleListAccounts,
            handleTestConnection,
            handleDiscoverModels,
        } = await import('../../management/providers-route.mjs'));
    });

    it('handleListProviders returns provider list', async () => {
        const mockRow = {
            id: 'p1',
            provider_key: 'openai',
            display_name: 'OpenAI',
        };
        const pool = createMockPool(async () => ({ rows: [mockRow] }));
        const appCtx = createMockAppCtx({ pool });
        const res = createMockRes();

        await handleListProviders({
            req: createMockReq(),
            res,
            params: {},
            query: {},
            appCtx,
        });

        assert.equal(res.statusCode, 200);
        const body = parseJsonResponse(res);
        assert.equal(body.data.length, 1);
    });

    it('handleCreateProvider rejects missing fields', async () => {
        const appCtx = createMockAppCtx();
        const req = createMockReq({
            method: 'POST',
            body: { providerKey: 'test' },
        });
        const res = createMockRes();

        await assert.rejects(
            () =>
                handleCreateProvider({
                    req,
                    res,
                    params: {},
                    query: {},
                    appCtx,
                }),
            (err) => err.httpStatus === 400
        );
    });

    it('handleCreateProvider requires canonical camelCase payload fields', async () => {
        const appCtx = createMockAppCtx();
        const req = createMockReq({
            method: 'POST',
            body: {
                name: 'gemini-oauth',
                display_name: 'Google Gemini (OAuth)',
                adapter_key: 'gemini-openai',
                auth_type: 'managed',
            },
        });
        const res = createMockRes();

        await assert.rejects(
            () => handleCreateProvider({ req, res, params: {}, query: {}, appCtx }),
            (err) => err.httpStatus === 400
        );
    });

    it('handleCreateProvider derives kind from providerMode and preserves oauth authStrategy', async () => {
        const pool = createMockPool(async (_sql, params) => ({
            rows: [
                {
                    id: 'p1',
                    provider_key: params[0],
                    display_name: params[1],
                    kind: params[2],
                    adapter_key: params[3],
                    auth_strategy: params[4],
                    provider_mode: params[5],
                    oauth_adapter_key: params[6],
                    base_url: params[7],
                },
            ],
        }));
        const appCtx = createMockAppCtx({ pool });
        const req = createMockReq({
            method: 'POST',
            body: {
                providerKey: 'gemini-oauth',
                displayName: 'Google Gemini (OAuth)',
                adapterKey: 'gemini-openai',
                authStrategy: 'oauth',
                providerMode: 'custom',
                oauthAdapterKey: 'google-gemini',
                baseUrl:
                    'https://generativelanguage.googleapis.com/v1beta/openai',
            },
        });
        const res = createMockRes();

        await handleCreateProvider({ req, res, params: {}, query: {}, appCtx });

        assert.equal(res.statusCode, 201);
        const body = parseJsonResponse(res);
        assert.equal(body.provider.provider_key, 'gemini-oauth');
        assert.equal(body.provider.kind, 'custom');
        assert.equal(body.provider.adapter_key, 'gemini-openai');
        assert.equal(body.provider.auth_strategy, 'oauth');
        assert.equal(body.provider.provider_mode, 'custom');
        assert.equal(body.provider.oauth_adapter_key, 'google-gemini');
    });

    it('handleCreateProvider rejects unknown adapterKey values', async () => {
        const appCtx = createMockAppCtx({
            availableBackends: ['openai-api'],
        });
        const req = createMockReq({
            method: 'POST',
            body: {
                providerKey: 'broken-provider',
                displayName: 'Broken Provider',
                adapterKey: 'missing-backend',
                authStrategy: 'api_key',
                providerMode: 'external_api',
            },
        });
        const res = createMockRes();

        await assert.rejects(
            () => handleCreateProvider({ req, res, params: {}, query: {}, appCtx }),
            (err) =>
                err.httpStatus === 400 &&
                err.message.includes("Unknown provider backend 'missing-backend'")
        );
    });

    it('handleCreateProvider rolls back the provider row when initial model sync fails', async () => {
        const queries = [];
        const pool = createMockPool(async (sql, params) => {
            queries.push(compactSql(sql));

            if (sql.includes('INSERT INTO soul_gateway.providers')) {
                return {
                    rows: [
                        {
                            id: 'p-sync-fail',
                            provider_key: params[0],
                            display_name: params[1],
                            kind: params[2],
                            adapter_key: params[3],
                            auth_strategy: params[4],
                            provider_mode: params[5],
                            oauth_adapter_key: params[6],
                            base_url: params[7],
                            enabled: true,
                            settings: {},
                            metadata: {},
                        },
                    ],
                };
            }

            if (
                sql.includes('FROM soul_gateway.provider_accounts') &&
                sql.includes('provider_id = $1')
            ) {
                return { rows: [] };
            }

            if (sql.includes('INSERT INTO soul_gateway.provider_accounts')) {
                return {
                    rows: [
                        {
                            id: 'acc-sync-fail',
                            provider_id: 'p-sync-fail',
                            auth_type: 'api_key',
                            status: 'active',
                        },
                    ],
                };
            }

            if (sql.includes('DELETE FROM soul_gateway.providers')) {
                return { rows: [], rowCount: 1 };
            }

            return { rows: [], rowCount: 0 };
        });
        const appCtx = createMockAppCtx({
            pool,
            services: {
                encryptionKey: randomBytes(32),
                backendCatalog: {
                    getBackend(key) {
                        assert.equal(key, 'openai-api');
                        return {
                            manifest: { key: 'openai-api' },
                            async discoverModels() {
                                throw new Error('upstream /models failed');
                            },
                        };
                    },
                    listKeys() {
                        return ['openai-api'];
                    },
                    getTemplates() {
                        return {};
                    },
                },
            },
        });
        const req = createMockReq({
            method: 'POST',
            body: {
                providerKey: 'openai',
                displayName: 'OpenAI',
                adapterKey: 'openai-api',
                authStrategy: 'api_key',
                providerMode: 'external_api',
                baseUrl: 'https://api.openai.com/v1',
                apiKey: 'sk-test-12345',
            },
        });
        const res = createMockRes();

        await assert.rejects(
            () => handleCreateProvider({ req, res, params: {}, query: {}, appCtx }),
            (err) =>
                err.httpStatus === 400 &&
                err.message.includes('Provider initial model sync failed')
        );

        assert.ok(
            queries.find((sql) => sql.includes('DELETE FROM soul_gateway.providers')),
            'expected the failed create flow to delete the provider row'
        );
    });

    it('handleCreateProvider deletes partially inserted models before provider rollback', async () => {
        const queries = [];
        let snapshotReloadCalls = 0;
        const pool = createMockPool(async (sql, params) => {
            queries.push(compactSql(sql));

            if (sql.includes('INSERT INTO soul_gateway.providers')) {
                return {
                    rows: [
                        {
                            id: 'p-partial-sync',
                            provider_key: params[0],
                            display_name: params[1],
                            kind: params[2],
                            adapter_key: params[3],
                            auth_strategy: params[4],
                            provider_mode: params[5],
                            oauth_adapter_key: params[6],
                            base_url: params[7],
                            enabled: true,
                            settings: {},
                            metadata: {},
                        },
                    ],
                };
            }

            if (
                sql.includes('FROM soul_gateway.provider_accounts') &&
                sql.includes('provider_id = $1')
            ) {
                return { rows: [] };
            }

            if (sql.includes('INSERT INTO soul_gateway.provider_accounts')) {
                return {
                    rows: [
                        {
                            id: 'acc-partial-sync',
                            provider_id: 'p-partial-sync',
                            auth_type: 'api_key',
                            status: 'active',
                        },
                    ],
                };
            }

            if (sql.includes('SELECT * FROM soul_gateway.models')) {
                return { rows: [] };
            }

            if (sql.includes('INSERT INTO soul_gateway.models')) {
                return {
                    rows: [
                        {
                            id: 'm-partial-sync',
                            provider_id: 'p-partial-sync',
                            model_key: 'nvidia/meta/llama-3.1-8b-instruct',
                            discovery_source: 'auto_provisioned',
                            enabled: true,
                        },
                    ],
                };
            }

            if (sql.includes('DELETE FROM soul_gateway.models WHERE provider_id = $1')) {
                assert.equal(params[0], 'p-partial-sync');
                return { rows: [], rowCount: 1 };
            }

            if (sql.includes('DELETE FROM soul_gateway.providers')) {
                assert.equal(params[0], 'p-partial-sync');
                return { rows: [], rowCount: 1 };
            }

            return { rows: [], rowCount: 0 };
        });

        const appCtx = createMockAppCtx({
            pool,
            services: {
                encryptionKey: randomBytes(32),
                backendCatalog: {
                    getBackend(key) {
                        assert.equal(key, 'openai-api');
                        return {
                            manifest: { key: 'openai-api' },
                            async discoverModels() {
                                return [
                                    {
                                        modelId: 'meta/llama-3.1-8b-instruct',
                                        displayName: 'Llama 3.1 8B Instruct',
                                    },
                                ];
                            },
                        };
                    },
                    listKeys() {
                        return ['openai-api'];
                    },
                    getTemplates() {
                        return {};
                    },
                },
                reloadRuntimeSnapshot: async () => {
                    snapshotReloadCalls += 1;
                    if (snapshotReloadCalls !== 2) {
                        return { generation: 1 };
                    }
                    throw new Error('snapshot reload failed');
                },
            },
        });
        const req = createMockReq({
            method: 'POST',
            body: {
                providerKey: 'nvidia',
                displayName: 'NVIDIA',
                adapterKey: 'openai-api',
                authStrategy: 'api_key',
                providerMode: 'external_api',
                baseUrl: 'https://integrate.api.nvidia.com/v1',
                apiKey: 'sk-test-12345',
            },
        });
        const res = createMockRes();

        await assert.rejects(
            () => handleCreateProvider({ req, res, params: {}, query: {}, appCtx }),
            (err) =>
                err.httpStatus === 400 &&
                err.message.includes('Provider initial model sync failed: snapshot reload failed')
        );

        const deleteModelsIndex = queries.findIndex((sql) =>
            sql.includes('DELETE FROM soul_gateway.models WHERE provider_id = $1')
        );
        const deleteProviderIndex = queries.findIndex((sql) =>
            sql.includes('DELETE FROM soul_gateway.providers')
        );
        assert.ok(deleteModelsIndex >= 0, 'expected rollback to delete provider models');
        assert.ok(deleteProviderIndex >= 0, 'expected rollback to delete the provider row');
        assert.ok(
            deleteModelsIndex < deleteProviderIndex,
            'expected model cleanup before provider delete to satisfy the FK'
        );
    });

    it('handleUpdateProvider accepts an apiKey-only PATCH, creates a provider_accounts row, and auto-syncs models', async () => {
        const providerRow = {
            id: 'p-nv',
            provider_key: 'nvidia',
            display_name: 'NVIDIA',
            kind: 'external_api',
            adapter_key: 'openai-api',
            auth_strategy: 'api_key',
            base_url: 'https://integrate.api.nvidia.com/v1',
            enabled: true,
            settings: {},
            metadata: {},
        };

        const calls = [];
        const pool = createMockPool(async (sql, params) => {
            calls.push({ sql: sql.replace(/\s+/g, ' ').trim(), params });

            if (
                sql.includes('FROM soul_gateway.providers') &&
                sql.includes('WHERE id')
            ) {
                return { rows: [providerRow] };
            }
            if (
                sql.includes('FROM soul_gateway.provider_accounts') &&
                sql.includes('provider_id = $1')
            ) {
                return { rows: [] };
            }
            if (sql.includes('INSERT INTO soul_gateway.provider_accounts')) {
                return {
                    rows: [
                        {
                            id: 'acc-new',
                            provider_id: 'p-nv',
                            auth_type: 'api_key',
                            status: 'active',
                        },
                    ],
                };
            }
            // Defensive: any UPDATE on the providers table is a regression — the
            // handler must NOT touch the providers row when only apiKey is sent.
            if (sql.includes('UPDATE soul_gateway.providers')) {
                throw new Error(
                    'Unexpected UPDATE on providers table for apiKey-only PATCH'
                );
            }
            return { rows: [], rowCount: 0 };
        });

        const appCtx = createMockAppCtx({
            pool,
            services: {
                encryptionKey: randomBytes(32),
                backendCatalog: {
                    getBackend(key) {
                        assert.equal(key, 'openai-api');
                        return {
                            manifest: { key: 'openai-api' },
                            async discoverModels() {
                                return [];
                            },
                        };
                    },
                    listKeys() {
                        return ['openai-api'];
                    },
                    getTemplates() {
                        return {};
                    },
                },
            },
        });
        const req = createMockReq({
            method: 'PATCH',
            body: { apiKey: 'sk-test-12345' },
        });
        const res = createMockRes();

        await handleUpdateProvider({
            req,
            res,
            params: { providerId: 'p-nv' },
            query: {},
            appCtx,
        });

        assert.equal(
            res.statusCode,
            200,
            'PATCH should succeed even when only apiKey is sent'
        );
        const body = parseJsonResponse(res);
        assert.equal(body.provider.id, 'p-nv');
        assert.equal(body.provider.provider_key, 'nvidia');

        const inserted = calls.find((c) =>
            c.sql.includes('INSERT INTO soul_gateway.provider_accounts')
        );
        assert.ok(
            inserted,
            'expected an INSERT into provider_accounts to back the apiKey upsert'
        );
    });

    it('handleUpdateProvider rejects an apiKey PATCH when strict model sync fails', async () => {
        const providerRow = {
            id: 'p-openai',
            provider_key: 'openai',
            display_name: 'OpenAI',
            kind: 'external_api',
            adapter_key: 'openai-api',
            auth_strategy: 'api_key',
            base_url: 'https://api.openai.com/v1',
            enabled: true,
            settings: {},
            metadata: {},
        };
        const pool = createMockPool(async (sql) => {
            if (
                sql.includes('FROM soul_gateway.providers') &&
                sql.includes('WHERE id')
            ) {
                return { rows: [providerRow] };
            }
            if (
                sql.includes('FROM soul_gateway.provider_accounts') &&
                sql.includes('provider_id = $1')
            ) {
                return { rows: [] };
            }
            if (sql.includes('INSERT INTO soul_gateway.provider_accounts')) {
                return {
                    rows: [
                        {
                            id: 'acc-openai',
                            provider_id: 'p-openai',
                            auth_type: 'api_key',
                            status: 'active',
                        },
                    ],
                };
            }
            if (sql.includes('SELECT * FROM soul_gateway.models')) {
                return { rows: [] };
            }
            return { rows: [], rowCount: 0 };
        });

        const appCtx = createMockAppCtx({
            pool,
            services: {
                encryptionKey: randomBytes(32),
                backendCatalog: {
                    getBackend(key) {
                        assert.equal(key, 'openai-api');
                        return {
                            manifest: { key: 'openai-api' },
                            async discoverModels() {
                                throw new Error('upstream /models failed');
                            },
                        };
                    },
                    listKeys() {
                        return ['openai-api'];
                    },
                    getTemplates() {
                        return {};
                    },
                },
            },
        });
        const req = createMockReq({
            method: 'PATCH',
            body: { apiKey: 'sk-test-12345' },
        });
        const res = createMockRes();

        await assert.rejects(
            () =>
                handleUpdateProvider({
                    req,
                    res,
                    params: { providerId: 'p-openai' },
                    query: {},
                    appCtx,
                }),
            (err) =>
                err.httpStatus === 400 &&
                err.message.includes(
                    'Provider model sync failed after credential update'
                )
        );
    });

    it('handleUpdateProvider returns 404 when the provider id does not exist', async () => {
        const pool = createMockPool(async (sql) => {
            if (
                sql.includes('FROM soul_gateway.providers') &&
                sql.includes('WHERE id')
            ) {
                return { rows: [] };
            }
            return { rows: [], rowCount: 0 };
        });
        const appCtx = createMockAppCtx({ pool });
        const req = createMockReq({
            method: 'PATCH',
            body: { displayName: 'Anything' },
        });
        const res = createMockRes();

        await handleUpdateProvider({
            req,
            res,
            params: { providerId: 'missing' },
            query: {},
            appCtx,
        });

        assert.equal(res.statusCode, 404);
    });

    it('handleUpdateProvider rejects legacy snake_case PATCH fields', async () => {
        const providerRow = {
            id: 'p-nv',
            provider_key: 'nvidia',
            display_name: 'NVIDIA',
            kind: 'external_api',
            adapter_key: 'openai-api',
            auth_strategy: 'api_key',
            base_url: 'https://integrate.api.nvidia.com/v1',
            enabled: true,
            settings: {},
            metadata: {},
        };
        const pool = createMockPool(async (sql) => {
            if (
                sql.includes('FROM soul_gateway.providers') &&
                sql.includes('WHERE id')
            ) {
                return { rows: [providerRow] };
            }
            return { rows: [], rowCount: 0 };
        });
        const appCtx = createMockAppCtx({ pool });
        const req = createMockReq({
            method: 'PATCH',
            body: { api_key: 'sk-test-12345' },
        });
        const res = createMockRes();

        await assert.rejects(
            () =>
                handleUpdateProvider({
                    req,
                    res,
                    params: { providerId: 'p-nv' },
                    query: {},
                    appCtx,
                }),
            (err) =>
                err.httpStatus === 400 &&
                err.message.includes('No supported update fields provided')
        );
    });

    it('handleUpdateProvider rejects unknown adapterKey values', async () => {
        const providerRow = {
            id: 'p-nv',
            provider_key: 'nvidia',
            display_name: 'NVIDIA',
            kind: 'external_api',
            adapter_key: 'openai-api',
            auth_strategy: 'api_key',
            base_url: 'https://integrate.api.nvidia.com/v1',
            enabled: true,
            settings: {},
            metadata: {},
        };
        const pool = createMockPool(async (sql) => {
            if (
                sql.includes('FROM soul_gateway.providers') &&
                sql.includes('WHERE id')
            ) {
                return { rows: [providerRow] };
            }
            return { rows: [], rowCount: 0 };
        });
        const appCtx = createMockAppCtx({
            pool,
            availableBackends: ['openai-api'],
        });
        const req = createMockReq({
            method: 'PATCH',
            body: { adapterKey: 'missing-backend' },
        });
        const res = createMockRes();

        await assert.rejects(
            () =>
                handleUpdateProvider({
                    req,
                    res,
                    params: { providerId: 'p-nv' },
                    query: {},
                    appCtx,
                }),
            (err) =>
                err.httpStatus === 400 &&
                err.message.includes("Unknown provider backend 'missing-backend'")
        );
    });

    it('handleUpdateProvider rejects an empty PATCH body with 400', async () => {
        const appCtx = createMockAppCtx();
        const req = createMockReq({ method: 'PATCH', body: {} });
        const res = createMockRes();

        await assert.rejects(
            () =>
                handleUpdateProvider({
                    req,
                    res,
                    params: { providerId: 'p1' },
                    query: {},
                    appCtx,
                }),
            (err) => err.httpStatus === 400
        );
    });

    it('handleDeleteProvider returns 409 when manual models depend on it', async () => {
        const pool = createMockPool(async (sql) => {
            if (sql.includes('provider_id')) {
                return {
                    rows: [
                        {
                            id: 'm1',
                            discovery_source: 'manual',
                        },
                    ],
                };
            }
            if (sql.includes('DELETE FROM soul_gateway.providers')) {
                throw new Error(
                    'Provider delete should not run when manual models exist'
                );
            }
            return { rows: [], rowCount: 0 };
        });
        const appCtx = createMockAppCtx({ pool });
        const res = createMockRes();

        await handleDeleteProvider({
            req: createMockReq(),
            res,
            params: { providerId: 'p1' },
            query: {},
            appCtx,
        });

        assert.equal(res.statusCode, 409);
        const body = parseJsonResponse(res);
        assert.equal(
            body.error.message,
            'Cannot delete provider: 1 manual model(s) depend on it'
        );
        assert.equal(body.error.detail.modelCount, 1);
        assert.equal(body.error.detail.manualModelCount, 1);
        assert.equal(body.error.detail.providerSeededModelCount, 0);
    });

    it('handleDeleteProvider deletes provider-seeded models before deleting the provider', async () => {
        const queries = [];
        const pool = createMockPool(async (sql, params) => {
            queries.push(compactSql(sql));

            if (sql.includes('SELECT * FROM soul_gateway.models')) {
                return {
                    rows: [
                        {
                            id: 'm-auto-1',
                            discovery_source: 'auto_provisioned',
                        },
                        {
                            id: 'm-auto-2',
                            discovery_source: 'synced',
                        },
                    ],
                };
            }

            if (sql.includes('DELETE FROM soul_gateway.models WHERE provider_id = $1')) {
                assert.equal(params[0], 'p-auto');
                return { rows: [], rowCount: 2 };
            }

            if (sql.includes('DELETE FROM soul_gateway.providers')) {
                assert.equal(params[0], 'p-auto');
                return { rows: [], rowCount: 1 };
            }

            return { rows: [], rowCount: 0 };
        });
        const appCtx = createMockAppCtx({ pool });
        const res = createMockRes();

        await handleDeleteProvider({
            req: createMockReq(),
            res,
            params: { providerId: 'p-auto' },
            query: {},
            appCtx,
        });

        assert.equal(res.statusCode, 200);
        const body = parseJsonResponse(res);
        assert.equal(body.ok, true);
        assert.equal(body.deletedModels, 2);

        const deleteModelsIndex = queries.findIndex((sql) =>
            sql.includes('DELETE FROM soul_gateway.models WHERE provider_id = $1')
        );
        const deleteProviderIndex = queries.findIndex((sql) =>
            sql.includes('DELETE FROM soul_gateway.providers')
        );
        assert.ok(deleteModelsIndex >= 0, 'expected provider model cleanup');
        assert.ok(deleteProviderIndex >= 0, 'expected provider delete');
        assert.ok(
            deleteModelsIndex < deleteProviderIndex,
            'expected model cleanup before provider delete'
        );
    });

    it('handleAuthCallback returns dashboard-compatible completion shape', async () => {
        const appCtx = createMockAppCtx({
            services: {
                oauthManager: {
                    async handleCallback(providerId, query) {
                        assert.equal(providerId, 'p1');
                        assert.equal(query.code, 'code-1');
                        assert.equal(query.state, 'state-1');
                        return { accountId: 'acc-1', status: 'active' };
                    },
                },
            },
        });
        const res = createMockRes();

        await handleAuthCallback({
            req: createMockReq(),
            res,
            params: { providerId: 'p1' },
            query: { code: 'code-1', state: 'state-1' },
            appCtx,
        });

        assert.equal(res.statusCode, 200);
        const body = parseJsonResponse(res);
        assert.equal(body.status, 'complete');
        assert.equal(body.account.accountId, 'acc-1');
    });

    it('handleListAccounts returns the accounts payload used by the dashboard', async () => {
        const pool = createMockPool(async () => ({
            rows: [{ id: 'a1', account_label: 'Test Account' }],
        }));
        const appCtx = createMockAppCtx({ pool });
        const res = createMockRes();

        await handleListAccounts({
            req: createMockReq(),
            res,
            params: { providerId: 'p1' },
            query: {},
            appCtx,
        });

        assert.equal(res.statusCode, 200);
        const body = parseJsonResponse(res);
        assert.equal(body.accounts.length, 1);
    });

    describe('handleTestConnection', () => {
        function createBackendCatalogMock(testConnectionImpl) {
            return {
                testConnection: testConnectionImpl,
            };
        }

        function buildCtx({ providerRow, catalog }) {
            const pool = createMockPool(async () => ({ rows: [providerRow] }));
            const appCtx = createMockAppCtx({
                pool,
                services: { backendCatalog: catalog },
            });
            return {
                req: createMockReq({ method: 'POST' }),
                res: createMockRes(),
                params: { providerId: providerRow.id },
                query: {},
                appCtx,
            };
        }

        it('returns the backend result detail unchanged on success', async () => {
            const catalog = createBackendCatalogMock(async () => ({
                ok: true,
                detail: 'Codex OAuth credentials present',
            }));
            const ctx = buildCtx({
                providerRow: {
                    id: 'p1',
                    provider_key: 'codex',
                    oauth_adapter_key: 'openai-codex',
                },
                catalog,
            });

            await handleTestConnection(ctx);

            assert.equal(ctx.res.statusCode, 200);
            const body = parseJsonResponse(ctx.res);
            assert.equal(body.ok, true);
            assert.equal(body.detail, 'Codex OAuth credentials present');
            assert.equal(typeof body.latencyMs, 'number');
            assert.equal(body.message, undefined);
            assert.equal(body.error, undefined);
        });

        it('returns the backend result detail unchanged on failure', async () => {
            const catalog = createBackendCatalogMock(async () => ({
                ok: false,
                detail: 'HTTP 403',
            }));
            const ctx = buildCtx({
                providerRow: { id: 'p1', provider_key: 'codex' },
                catalog,
            });

            await handleTestConnection(ctx);

            const body = parseJsonResponse(ctx.res);
            assert.equal(body.ok, false);
            assert.equal(body.detail, 'HTTP 403');
            assert.equal(body.message, undefined);
            assert.equal(body.error, undefined);
        });

        it('normalizes missing detail to null when the backend omits it', async () => {
            const catalog = createBackendCatalogMock(async () => ({
                ok: false,
            }));
            const ctx = buildCtx({ providerRow: { id: 'p1' }, catalog });

            await handleTestConnection(ctx);
            const body = parseJsonResponse(ctx.res);
            assert.equal(body.ok, false);
            assert.equal(body.detail, null);
        });

        it('preserves object-shaped detail payloads', async () => {
            const catalog = createBackendCatalogMock(async () => ({
                ok: false,
                detail: { error: 'credentials missing' },
            }));
            const ctx = buildCtx({ providerRow: { id: 'p1' }, catalog });

            await handleTestConnection(ctx);
            const body = parseJsonResponse(ctx.res);
            assert.equal(body.ok, false);
            assert.deepEqual(body.detail, { error: 'credentials missing' });
        });

        it('returns the thrown error message in detail when the backend throws', async () => {
            const catalog = createBackendCatalogMock(async () => {
                throw new Error('backend blew up');
            });
            const ctx = buildCtx({ providerRow: { id: 'p1' }, catalog });

            await handleTestConnection(ctx);
            const body = parseJsonResponse(ctx.res);
            assert.equal(body.ok, false);
            assert.equal(body.detail, 'backend blew up');
        });

        it('returns a structured detail when the backend catalog is not installed', async () => {
            const pool = createMockPool(async () => ({ rows: [{ id: 'p1' }] }));
            const appCtx = createMockAppCtx({ pool });
            const res = createMockRes();

            await handleTestConnection({
                req: createMockReq({ method: 'POST' }),
                res,
                params: { providerId: 'p1' },
                query: {},
                appCtx,
            });

            const body = parseJsonResponse(res);
            assert.equal(body.ok, false);
            assert.equal(typeof body.detail, 'string');
            assert.equal(body.message, undefined);
            assert.equal(body.error, undefined);
        });
    });

    describe('handleDiscoverModels', () => {
        it('returns raw backend discovery descriptors unchanged', async () => {
            const providerRow = {
                id: 'p1',
                provider_key: 'codex',
                adapter_key: 'codex-api',
                auth_strategy: 'oauth',
                provider_mode: 'external_api',
                settings: {},
                metadata: {},
            };
            const pool = createMockPool(async () => ({ rows: [providerRow] }));
            const appCtx = createMockAppCtx({
                pool,
                services: {
                    backendCatalog: {
                        getBackend(key) {
                            assert.equal(key, 'codex-api');
                            return {
                                manifest: { key: 'codex-api' },
                                async discoverModels() {
                                    return [
                                        {
                                            modelId: 'gpt-5.4',
                                            displayName: 'GPT-5.4',
                                            contextWindow: 400000,
                                            supportsTools: true,
                                            supportsStreaming: true,
                                            supportsVision: false,
                                            pricing: {
                                                mode: 'token',
                                                inputPricePerMillion: 1.25,
                                                outputPricePerMillion: 10,
                                            },
                                        },
                                    ];
                                },
                            };
                        },
                    },
                },
            });
            const res = createMockRes();

            await handleDiscoverModels({
                req: createMockReq({ method: 'POST' }),
                res,
                params: { providerId: 'p1' },
                query: {},
                appCtx,
            });

            assert.equal(res.statusCode, 200);
            const body = parseJsonResponse(res);
            assert.deepEqual(body.data, [
                {
                    modelId: 'gpt-5.4',
                    displayName: 'GPT-5.4',
                    contextWindow: 400000,
                    supportsTools: true,
                    supportsStreaming: true,
                    supportsVision: false,
                    pricing: {
                        mode: 'token',
                        inputPricePerMillion: 1.25,
                        outputPricePerMillion: 10,
                    },
                },
            ]);
        });
    });
});

// ── Blacklist route tests ───────────────────────────────────────────

describe('management/blacklist-route', () => {
    let handleListRules, handleCreateRule, handleGetRule, handleDeleteRule;

    beforeEach(async () => {
        ({
            handleListRules,
            handleCreateRule,
            handleGetRule,
            handleDeleteRule,
        } = await import('../../management/blacklist-route.mjs'));
    });

    it('handleListRules returns rules list', async () => {
        const mockRow = {
            id: 'r1',
            rule_key: 'no-pii',
            match_type: 'regex',
            enabled: true,
        };
        const pool = createMockPool(async () => ({ rows: [mockRow] }));
        const appCtx = createMockAppCtx({ pool });
        const res = createMockRes();

        await handleListRules({
            req: createMockReq(),
            res,
            params: {},
            query: {},
            appCtx,
        });

        assert.equal(res.statusCode, 200);
        const body = parseJsonResponse(res);
        assert.equal(body.data.length, 1);
    });

    it('handleCreateRule rejects missing fields', async () => {
        const appCtx = createMockAppCtx();
        const req = createMockReq({
            method: 'POST',
            body: { ruleKey: 'test' },
        });
        const res = createMockRes();

        await assert.rejects(
            () => handleCreateRule({ req, res, params: {}, query: {}, appCtx }),
            (err) => err.httpStatus === 400
        );
    });

    it('handleGetRule returns 404 for missing rule', async () => {
        const pool = createMockPool(async () => ({ rows: [] }));
        const appCtx = createMockAppCtx({ pool });
        const res = createMockRes();

        await handleGetRule({
            req: createMockReq(),
            res,
            params: { ruleId: 'x' },
            query: {},
            appCtx,
        });

        assert.equal(res.statusCode, 404);
    });

    it('handleDeleteRule returns 404 for missing rule', async () => {
        const pool = createMockPool(async () => ({ rows: [], rowCount: 0 }));
        const appCtx = createMockAppCtx({ pool });
        const res = createMockRes();

        await handleDeleteRule({
            req: createMockReq(),
            res,
            params: { ruleId: 'x' },
            query: {},
            appCtx,
        });

        assert.equal(res.statusCode, 404);
    });
});

// ── Cooldowns route tests ───────────────────────────────────────────

describe('management/cooldowns-route', () => {
    let handleListCooldowns, handleClearAll, handleClearModel;

    beforeEach(async () => {
        ({ handleListCooldowns, handleClearAll, handleClearModel } =
            await import('../../management/cooldowns-route.mjs'));
    });

    it('handleListCooldowns returns active cooldowns', async () => {
        const mockRow = {
            id: 'c1',
            model_id: 'm1',
            model_key: 'gpt-4o',
            expires_at: new Date().toISOString(),
        };
        const pool = createMockPool(async () => ({ rows: [mockRow] }));
        const appCtx = createMockAppCtx({ pool });
        const res = createMockRes();

        await handleListCooldowns({
            req: createMockReq(),
            res,
            params: {},
            query: {},
            appCtx,
        });

        assert.equal(res.statusCode, 200);
        const body = parseJsonResponse(res);
        assert.equal(body.data.length, 1);
    });

    it('handleClearAll clears all cooldowns', async () => {
        const pool = createMockPool(async () => ({ rows: [], rowCount: 3 }));
        const appCtx = createMockAppCtx({ pool });
        const res = createMockRes();

        await handleClearAll({
            req: createMockReq(),
            res,
            params: {},
            query: {},
            appCtx,
        });

        assert.equal(res.statusCode, 200);
        const body = parseJsonResponse(res);
        assert.equal(body.cleared, 3);
    });

    it('handleClearModel clears cooldown for one model', async () => {
        const pool = createMockPool(async () => ({ rows: [], rowCount: 1 }));
        const appCtx = createMockAppCtx({ pool });
        const res = createMockRes();

        await handleClearModel({
            req: createMockReq(),
            res,
            params: { modelId: 'm1' },
            query: {},
            appCtx,
        });

        assert.equal(res.statusCode, 200);
        const body = parseJsonResponse(res);
        assert.equal(body.ok, true);
    });
});

// ── Logs route tests ────────────────────────────────────────────────

describe('management/logs-route', () => {
    let handleListLogs, handleGetLog;

    beforeEach(async () => {
        ({ handleListLogs, handleGetLog } = await import(
            '../../management/logs-route.mjs'
        ));
    });

    it('handleListLogs returns paginated logs', async () => {
        const mockRow = { log_id: 'l1', request_id: 'r1', status: 'succeeded' };
        let callIdx = 0;
        const pool = createMockPool(async (sql) => {
            callIdx++;
            if (sql.includes('COUNT')) return { rows: [{ total: 1 }] };
            return { rows: [mockRow] };
        });
        const appCtx = createMockAppCtx({ pool });
        const res = createMockRes();

        await handleListLogs({
            req: createMockReq(),
            res,
            params: {},
            appCtx,
            query: { limit: '10', offset: '0' },
        });

        assert.equal(res.statusCode, 200);
        const body = parseJsonResponse(res);
        assert.equal(body.data.length, 1);
        assert.equal(body.total, 1);
    });

    it('handleGetLog returns 404 for missing log', async () => {
        const pool = createMockPool(async () => ({ rows: [] }));
        const appCtx = createMockAppCtx({ pool });
        const res = createMockRes();

        await handleGetLog({
            req: createMockReq(),
            res,
            params: { logId: 'x' },
            query: {},
            appCtx,
        });

        assert.equal(res.statusCode, 404);
    });
});

// ── Metrics route tests ─────────────────────────────────────────────

describe('management/metrics-route', () => {
    let handleCostMetrics, handleUsageMetrics, handleErrorMetrics;

    beforeEach(async () => {
        ({ handleCostMetrics, handleUsageMetrics, handleErrorMetrics } =
            await import('../../management/metrics-route.mjs'));
    });

    it('handleCostMetrics rejects missing date range', async () => {
        const appCtx = createMockAppCtx();
        const res = createMockRes();

        await assert.rejects(
            () =>
                handleCostMetrics({
                    req: createMockReq(),
                    res,
                    params: {},
                    query: {},
                    appCtx,
                }),
            (err) => err.httpStatus === 400
        );
    });

    it('handleCostMetrics returns data for valid date range', async () => {
        const mockRow = {
            period: '2026-04-01',
            total_cost_usd: '1.50',
            request_count: 10,
        };
        const pool = createMockPool(async () => ({ rows: [mockRow] }));
        const appCtx = createMockAppCtx({ pool });
        const res = createMockRes();

        await handleCostMetrics({
            req: createMockReq(),
            res,
            params: {},
            appCtx,
            query: { from: '2026-04-01', to: '2026-04-02' },
        });

        assert.equal(res.statusCode, 200);
        const body = parseJsonResponse(res);
        assert.equal(body.data.length, 1);
    });
});

// ── Sessions route tests ────────────────────────────────────────────

describe('management/sessions-route', () => {
    let handleListSessions, handleGetSession, handleGetSessionLogs;

    beforeEach(async () => {
        ({ handleListSessions, handleGetSession, handleGetSessionLogs } =
            await import('../../management/sessions-route.mjs'));
    });

    it('handleListSessions returns session list', async () => {
        const mockRow = { id: 's1', agent_name: 'coral-agent', status: 'open' };
        const pool = createMockPool(async () => ({ rows: [mockRow] }));
        const appCtx = createMockAppCtx({ pool });
        const res = createMockRes();

        await handleListSessions({
            req: createMockReq(),
            res,
            params: {},
            query: {},
            appCtx,
        });

        assert.equal(res.statusCode, 200);
        const body = parseJsonResponse(res);
        assert.equal(body.data.length, 1);
    });

    it('handleGetSession returns 404 for missing session', async () => {
        const pool = createMockPool(async () => ({ rows: [] }));
        const appCtx = createMockAppCtx({ pool });
        const res = createMockRes();

        await handleGetSession({
            req: createMockReq(),
            res,
            params: { sessionId: 'x' },
            query: {},
            appCtx,
        });

        assert.equal(res.statusCode, 404);
    });

    it('handleGetSessionLogs returns recent logs for an existing session', async () => {
        const responses = [
            { rows: [{ id: 's1', agent_name: 'coral-agent' }] },
            { rows: [{ request_id: 'req-1', session_id: 's1' }] },
        ];
        const pool = createMockPool(
            async () => responses.shift() || { rows: [] }
        );
        const appCtx = createMockAppCtx({ pool });
        const res = createMockRes();

        await handleGetSessionLogs({
            req: createMockReq(),
            res,
            params: { sessionId: 's1' },
            query: { limit: '25' },
            appCtx,
        });

        assert.equal(res.statusCode, 200);
        const body = parseJsonResponse(res);
        assert.equal(body.sessionId, 's1');
        assert.equal(body.data.length, 1);
    });
});

// ── Middlewares route tests ─────────────────────────────────────────

describe('management/middlewares-route', () => {
    let handleListMiddlewares,
        handleCreateAssignment,
        handleUpdateAssignment,
        handleDeleteAssignment,
        handleRescan;

    beforeEach(async () => {
        ({
            handleListMiddlewares,
            handleCreateAssignment,
            handleUpdateAssignment,
            handleDeleteAssignment,
            handleRescan,
        } = await import('../../management/middlewares-route.mjs'));
    });

    it('handleListMiddlewares returns catalog', async () => {
        const mockRow = {
            id: 'mw1',
            middleware_key: 'rate-limiter',
            display_name: 'Rate Limiter',
        };
        const pool = createMockPool(async () => ({ rows: [mockRow] }));
        const appCtx = createMockAppCtx({ pool });
        const res = createMockRes();

        await handleListMiddlewares({
            req: createMockReq(),
            res,
            params: {},
            query: {},
            appCtx,
        });

        assert.equal(res.statusCode, 200);
        const body = parseJsonResponse(res);
        assert.equal(body.catalog.length, 1);
    });

    it('handleCreateAssignment rejects missing fields', async () => {
        const appCtx = createMockAppCtx();
        const req = createMockReq({ method: 'POST', body: {} });
        const res = createMockRes();

        await assert.rejects(
            () =>
                handleCreateAssignment({
                    req,
                    res,
                    params: {},
                    query: {},
                    appCtx,
                }),
            (err) => err.httpStatus === 400
        );
    });

    it('handleCreateAssignment rejects unknown targetType', async () => {
        const appCtx = createMockAppCtx();
        const req = createMockReq({
            method: 'POST',
            body: { middlewareId: 'mw1', targetType: 'unknown' },
        });
        const res = createMockRes();

        await assert.rejects(
            () =>
                handleCreateAssignment({
                    req,
                    res,
                    params: {},
                    query: {},
                    appCtx,
                }),
            (err) => err.httpStatus === 400 && err.message.includes('Unknown targetType')
        );
    });

    it('handleDeleteAssignment returns 404 for missing assignment', async () => {
        const pool = createMockPool(async () => ({ rows: [], rowCount: 0 }));
        const appCtx = createMockAppCtx({ pool });
        const res = createMockRes();

        await handleDeleteAssignment({
            req: createMockReq(),
            res,
            params: { assignmentId: 'x' },
            query: {},
            appCtx,
        });

        assert.equal(res.statusCode, 404);
    });

    it('handleCreateAssignment triggers runtime snapshot reload', async () => {
        const pool = createMockPool(async () => ({
            rows: [
                {
                    id: 'a1',
                    middleware_key: 'mw1',
                    scope: 'model',
                    target_id: 'm1',
                },
            ],
            rowCount: 1,
        }));
        let reloads = 0;
        const appCtx = createMockAppCtx({
            pool,
            services: {
                reloadRuntimeSnapshot: async () => {
                    reloads += 1;
                    return { generation: 2 };
                },
            },
        });
        const req = createMockReq({
            method: 'POST',
            body: { middlewareId: 'mw1', targetType: 'model', modelId: 'm1' },
        });
        const res = createMockRes();

        await handleCreateAssignment({
            req,
            res,
            params: {},
            query: {},
            appCtx,
        });

        assert.equal(res.statusCode, 201);
        assert.equal(reloads, 1);
    });

    it('handleRescan reloads the middleware catalog and runtime snapshot', async () => {
        let snapshotReloads = 0;
        const appCtx = createMockAppCtx({
            services: {
                reloadMiddlewareCatalog: async () => ({
                    generation: 3,
                    count: 8,
                }),
                reloadRuntimeSnapshot: async () => {
                    snapshotReloads += 1;
                    return { generation: 4 };
                },
            },
        });
        const res = createMockRes();

        await handleRescan({
            req: createMockReq({ method: 'POST' }),
            res,
            params: {},
            query: {},
            appCtx,
        });

        assert.equal(res.statusCode, 200);
        assert.equal(snapshotReloads, 1);
        const body = parseJsonResponse(res);
        assert.equal(body.middlewareGeneration, 3);
        assert.equal(body.snapshotGeneration, 4);
    });
});

// ── Router integration tests ────────────────────────────────────────

describe('management/router', () => {
    let buildManagementRouter;

    beforeEach(async () => {
        ({ buildManagementRouter } = await import(
            '../../management/build-routes.mjs'
        ));
    });

    it('builds http and ws routers', () => {
        const appCtx = createMockAppCtx();
        const { httpRouter, wsRouter } = buildManagementRouter(appCtx);

        assert.ok(httpRouter);
        assert.ok(wsRouter);
        assert.ok(typeof httpRouter.match === 'function');
        assert.ok(typeof wsRouter.match === 'function');
    });

    it('matches auth login route without admin guard', () => {
        const appCtx = createMockAppCtx();
        const { httpRouter } = buildManagementRouter(appCtx);
        const match = httpRouter.match('POST', '/management/auth/login');
        assert.ok(match);
        assert.ok(typeof match.handler === 'function');
    });

    it('rejects tokens without CSRF component on all admin routes', async () => {
        const appCtx = createMockAppCtx();
        const { httpRouter } = buildManagementRouter(appCtx);
        const match = httpRouter.match('POST', '/management/keys');
        const req = createMockReq({ method: 'POST' });
        const res = createMockRes();

        addAdminAuth(req, appCtx); // token without csrfToken is now rejected

        await assert.rejects(
            () =>
                match.handler({
                    req,
                    res,
                    params: match.params,
                    query: {},
                    appCtx,
                }),
            (err) => err instanceof AuthenticationRequiredError
        );
    });

    it('accepts valid CSRF tokens on read-only admin routes', async () => {
        const appCtx = createMockAppCtx();
        const { httpRouter } = buildManagementRouter(appCtx);
        const match = httpRouter.match('GET', '/management/keys');
        const req = createMockReq({ method: 'GET' });
        const res = createMockRes();

        addAdminAuth(req, appCtx, { csrfToken: 'csrf-token-123' });

        await match.handler({
            req,
            res,
            params: match.params,
            query: {},
            appCtx,
        });

        assert.equal(res.statusCode, 200);
    });

    it('matches key management routes', () => {
        const appCtx = createMockAppCtx();
        const { httpRouter } = buildManagementRouter(appCtx);

        assert.ok(httpRouter.match('GET', '/management/keys'));
        assert.ok(httpRouter.match('POST', '/management/keys'));
        assert.ok(httpRouter.match('GET', '/management/keys/some-id'));
        assert.ok(httpRouter.match('PATCH', '/management/keys/some-id'));
        assert.ok(httpRouter.match('POST', '/management/keys/some-id/revoke'));
        assert.ok(httpRouter.match('GET', '/management/keys/some-id/spend'));
    });

    it('matches model management routes', () => {
        const appCtx = createMockAppCtx();
        const { httpRouter } = buildManagementRouter(appCtx);

        assert.ok(httpRouter.match('GET', '/management/models'));
        assert.ok(httpRouter.match('POST', '/management/models'));
        assert.ok(httpRouter.match('GET', '/management/models/m1'));
        assert.ok(httpRouter.match('PATCH', '/management/models/m1'));
        assert.ok(httpRouter.match('DELETE', '/management/models/m1'));
        assert.ok(httpRouter.match('POST', '/management/models/m1/enable'));
        assert.ok(httpRouter.match('POST', '/management/models/m1/disable'));
    });

    it('matches tier management routes', () => {
        const appCtx = createMockAppCtx();
        const { httpRouter } = buildManagementRouter(appCtx);

        assert.ok(httpRouter.match('GET', '/management/tiers'));
        assert.ok(httpRouter.match('POST', '/management/tiers'));
        assert.ok(httpRouter.match('GET', '/management/tiers/t1'));
        assert.ok(httpRouter.match('PATCH', '/management/tiers/t1'));
        assert.ok(httpRouter.match('DELETE', '/management/tiers/t1'));
        assert.ok(httpRouter.match('POST', '/management/tiers/t1/enable'));
        assert.ok(httpRouter.match('POST', '/management/tiers/t1/disable'));
    });

    it('matches provider management routes', () => {
        const appCtx = createMockAppCtx();
        const { httpRouter } = buildManagementRouter(appCtx);

        assert.ok(httpRouter.match('GET', '/management/providers/templates'));
        assert.ok(httpRouter.match('GET', '/management/providers'));
        assert.ok(httpRouter.match('POST', '/management/providers'));
        assert.ok(httpRouter.match('GET', '/management/providers/p1'));
        assert.ok(httpRouter.match('PATCH', '/management/providers/p1'));
        assert.ok(httpRouter.match('DELETE', '/management/providers/p1'));
        assert.ok(httpRouter.match('POST', '/management/providers/p1/test'));
        assert.ok(
            httpRouter.match('POST', '/management/providers/p1/discover-models')
        );
        assert.ok(
            httpRouter.match('POST', '/management/providers/p1/sync-models')
        );
        assert.ok(
            httpRouter.match('POST', '/management/providers/p1/auth/start')
        );
        assert.ok(
            httpRouter.match('GET', '/management/providers/p1/auth/callback')
        );
        assert.ok(
            httpRouter.match(
                'GET',
                '/management/providers/p1/auth/pending/flow1'
            )
        );
        assert.ok(httpRouter.match('GET', '/management/providers/p1/accounts'));
        assert.ok(
            httpRouter.match('DELETE', '/management/providers/p1/accounts/a1')
        );
        assert.ok(
            httpRouter.match(
                'POST',
                '/management/providers/p1/accounts/a1/reset-quota'
            )
        );
        assert.ok(httpRouter.match('POST', '/management/providers/rescan'));
    });

    it('matches middleware routes', () => {
        const appCtx = createMockAppCtx();
        const { httpRouter } = buildManagementRouter(appCtx);

        assert.ok(httpRouter.match('GET', '/management/middlewares'));
        assert.ok(httpRouter.match('POST', '/management/middlewares/rescan'));
        assert.ok(httpRouter.match('GET', '/management/middlewares/mw1'));
        assert.ok(httpRouter.match('PATCH', '/management/middlewares/mw1'));
        assert.ok(
            httpRouter.match('POST', '/management/middlewares/assignments')
        );
        assert.ok(
            httpRouter.match('PATCH', '/management/middlewares/assignments/a1')
        );
        assert.ok(
            httpRouter.match('DELETE', '/management/middlewares/assignments/a1')
        );
    });

    it('matches model-scoped middleware routes', () => {
        const appCtx = createMockAppCtx();
        const { httpRouter } = buildManagementRouter(appCtx);

        assert.ok(httpRouter.match('GET', '/management/models/m1/middlewares'));
        assert.ok(
            httpRouter.match('POST', '/management/models/m1/middlewares')
        );
        assert.ok(
            httpRouter.match(
                'POST',
                '/management/models/m1/middlewares/reorder'
            )
        );
        assert.ok(
            httpRouter.match('PATCH', '/management/models/m1/middlewares/a1')
        );
        assert.ok(
            httpRouter.match('DELETE', '/management/models/m1/middlewares/a1')
        );
    });

    it('matches blacklist routes', () => {
        const appCtx = createMockAppCtx();
        const { httpRouter } = buildManagementRouter(appCtx);

        assert.ok(httpRouter.match('GET', '/management/blacklist/rules'));
        assert.ok(httpRouter.match('POST', '/management/blacklist/rules'));
        assert.ok(httpRouter.match('GET', '/management/blacklist/rules/r1'));
        assert.ok(httpRouter.match('PATCH', '/management/blacklist/rules/r1'));
        assert.ok(httpRouter.match('DELETE', '/management/blacklist/rules/r1'));
        assert.ok(
            httpRouter.match('POST', '/management/blacklist/rules/r1/enable')
        );
        assert.ok(
            httpRouter.match('POST', '/management/blacklist/rules/r1/disable')
        );
    });

    it('matches cooldown routes', () => {
        const appCtx = createMockAppCtx();
        const { httpRouter } = buildManagementRouter(appCtx);

        assert.ok(httpRouter.match('GET', '/management/cooldowns'));
        assert.ok(httpRouter.match('DELETE', '/management/cooldowns'));
        assert.ok(httpRouter.match('DELETE', '/management/cooldowns/m1'));
    });

    it('matches log routes', () => {
        const appCtx = createMockAppCtx();
        const { httpRouter } = buildManagementRouter(appCtx);

        assert.ok(httpRouter.match('GET', '/management/logs'));
        assert.ok(httpRouter.match('GET', '/management/logs/some-request-id'));
    });

    it('matches metrics routes', () => {
        const appCtx = createMockAppCtx();
        const { httpRouter } = buildManagementRouter(appCtx);

        assert.ok(httpRouter.match('GET', '/management/metrics/cost'));
        assert.ok(httpRouter.match('GET', '/management/metrics/usage'));
        assert.ok(httpRouter.match('GET', '/management/metrics/errors'));
        assert.ok(httpRouter.match('GET', '/management/metrics/activity'));
        assert.ok(httpRouter.match('GET', '/management/metrics/tokens'));
    });

    it('matches export routes', () => {
        const appCtx = createMockAppCtx();
        const { httpRouter } = buildManagementRouter(appCtx);

        assert.ok(httpRouter.match('GET', '/management/export/logs.csv'));
        assert.ok(httpRouter.match('GET', '/management/export/logs.json'));
    });

    it('matches session and agent routes', () => {
        const appCtx = createMockAppCtx();
        const { httpRouter } = buildManagementRouter(appCtx);

        assert.ok(httpRouter.match('GET', '/management/sessions'));
        assert.ok(httpRouter.match('GET', '/management/sessions/s1'));
        assert.ok(httpRouter.match('GET', '/management/sessions/s1/logs'));
        assert.ok(httpRouter.match('GET', '/management/agents/tree'));
    });

    it('matches SSE streaming routes', () => {
        const appCtx = createMockAppCtx();
        const { httpRouter } = buildManagementRouter(appCtx);

        assert.ok(httpRouter.match('GET', '/management/logs/stream/sse'));
        assert.ok(
            httpRouter.match('GET', '/management/logs/stream/soul/soul-123')
        );
    });

    it('matches WebSocket streaming routes', () => {
        const appCtx = createMockAppCtx();
        const { wsRouter } = buildManagementRouter(appCtx);

        assert.ok(wsRouter.match('GET', '/ws/logs'));
        assert.ok(wsRouter.match('GET', '/ws/logs/soul/soul-123'));
    });

    it('route params are populated correctly', () => {
        const appCtx = createMockAppCtx();
        const { httpRouter } = buildManagementRouter(appCtx);

        const match = httpRouter.match('GET', '/management/keys/abc-123');
        assert.ok(match);
        assert.equal(match.params.keyId, 'abc-123');

        const match2 = httpRouter.match(
            'GET',
            '/management/providers/p1/accounts'
        );
        assert.ok(match2);
        assert.equal(match2.params.providerId, 'p1');

        const match3 = httpRouter.match(
            'DELETE',
            '/management/providers/p1/accounts/a2'
        );
        assert.ok(match3);
        assert.equal(match3.params.providerId, 'p1');
        assert.equal(match3.params.accountId, 'a2');
    });

    it('returns null for unregistered paths', () => {
        const appCtx = createMockAppCtx();
        const { httpRouter } = buildManagementRouter(appCtx);

        assert.equal(httpRouter.match('GET', '/management/nonexistent'), null);
        assert.equal(httpRouter.match('PUT', '/management/keys'), null);
    });
});
