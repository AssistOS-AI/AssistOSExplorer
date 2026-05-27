import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Writable } from 'node:stream';

import { registerPublicApiRoutes } from '../../public-api/register-routes.mjs';

const TEST_API_KEY = 'sk-soul-test-workspace-key';

function createMockRouter() {
    const routes = new Map();
    return {
        add(method, path, handler) {
            routes.set(`${method} ${path}`, handler);
        },
        get(method, path) {
            return routes.get(`${method} ${path}`);
        },
    };
}

function createMockRes() {
    let statusCode = 200;
    const headers = {};
    const chunks = [];
    const res = new Writable({
        write(chunk, _enc, cb) {
            chunks.push(chunk);
            cb();
        },
    });
    res.setHeader = (k, v) => {
        headers[k.toLowerCase()] = v;
    };
    res.writeHead = (code, extraHeaders) => {
        statusCode = code;
        if (extraHeaders) {
            for (const [k, v] of Object.entries(extraHeaders)) {
                headers[k.toLowerCase()] = v;
            }
        }
    };
    Object.defineProperty(res, 'statusCode', {
        get: () => statusCode,
        set: (v) => {
            statusCode = v;
        },
    });
    res._headers = headers;
    res._chunks = chunks;
    return res;
}

function body(res) {
    return JSON.parse(Buffer.concat(res._chunks).toString('utf8'));
}

function snapshotFixture() {
    const models = new Map();
    models.set('openai/gpt-4o', {
        providerKey: 'openai',
        strategyKind: 'direct',
        pricingMode: 'token',
        inputPricePerMillion: 2.5,
        outputPricePerMillion: 10,
        requestPriceUsd: null,
        isFree: false,
        tags: ['fast', 'chat', 'tool-calling'],
        capabilities: { contextWindow: 128_000, maxOutputTokens: 16_384 },
    });
    models.set('free-provider/tiny', {
        providerKey: 'free-provider',
        strategyKind: 'direct',
        pricingMode: 'free',
        inputPricePerMillion: 0,
        outputPricePerMillion: 0,
        requestPriceUsd: null,
        isFree: true,
        tags: ['chat'],
        capabilities: { contextWindow: 4096 },
    });
    models.set('nvidia/google/gemma-3-27b-it', {
        modelKey: 'nvidia/google/gemma-3-27b-it',
        providerKey: 'nvidia',
        providerModelId: 'google/gemma-3-27b-it',
        displayName: 'Gemma 3 27B',
        strategyKind: 'direct',
        pricingMode: 'external_directory',
        inputPricePerMillion: null,
        outputPricePerMillion: null,
        requestPriceUsd: null,
        isFree: false,
        tags: [],
        capabilities: {},
        metadata: {},
    });
    models.set('axl/fast-cascade', {
        providerKey: null,
        strategyKind: 'cascade',
        tags: [],
        capabilities: {},
        children: [
            {
                modelKey: 'openai/gpt-4o',
                modelId: 'm1',
                priority: 0,
                childEnabled: true,
            },
            {
                modelKey: 'free-provider/tiny',
                modelId: 'm2',
                priority: 1,
                childEnabled: true,
            },
        ],
    });
    const aliases = new Map();
    aliases.set('gpt-4o', 'openai/gpt-4o');

    return {
        loadedAt: Date.now(),
        models,
        aliases,
    };
}

function createPricingDirectory() {
    return {
        lookupModel(providerKey, modelId) {
            if (
                providerKey === 'nvidia' &&
                modelId === 'google/gemma-3-27b-it'
            ) {
                return {
                    id: 'google/gemma-3-27b-it',
                    canonicalSlug: 'google/gemma-3-27b-it',
                    matchedBy: 'id',
                    pricingMode: 'token',
                    inputPricePerMillion: 0.27,
                    outputPricePerMillion: 0.4,
                    requestPriceUsd: null,
                    isFree: false,
                    contextWindow: 131_072,
                    maxOutputTokens: 8192,
                    supportsTools: true,
                    supportsVision: true,
                    tags: ['tool-calling', 'vision'],
                };
            }
            return null;
        },
    };
}

function createApiKeyPool() {
    let workspaceRow = null;
    return {
        async query(sql, params) {
            if (sql.includes('WHERE key_hash = $1')) {
                return { rows: workspaceRow ? [workspaceRow] : [] };
            }
            if (sql.includes('INSERT INTO soul_gateway.api_keys')) {
                workspaceRow = {
                    id: 'workspace-default',
                    label: params[0],
                    key_hash: params[1],
                    key_hint: params[5],
                    rpm_limit: params[6],
                    tpm_limit: params[7],
                    daily_budget_usd: params[8],
                    monthly_budget_usd: params[9],
                    expires_at: params[10],
                    metadata: params[11],
                    status: 'active',
                };
                return { rows: [workspaceRow] };
            }
            return { rows: [] };
        },
    };
}

function createAppCtx(snapshot, services = {}) {
    return {
        config: {
            env: {
                DATABASE_URL: 'postgresql://example.test/soul',
                ENCRYPTION_KEY: 'test-encryption-key',
                SOUL_GATEWAY_API_KEY: TEST_API_KEY,
                DEFAULT_RPM_LIMIT: 60,
                DEFAULT_TPM_LIMIT: 100000,
                ALLOW_UNAUTHENTICATED: false,
            },
        },
        pool: createApiKeyPool(),
        log: { debug() {}, info() {}, warn() {}, error() {}, fatal() {} },
        services: { snapshot, encryptionKey: Buffer.alloc(32), ...services },
    };
}

function invokeModelsHandler(snapshot, services = {}) {
    const router = createMockRouter();
    registerPublicApiRoutes(router, {});
    const handler = router.get('GET', '/v1/models');
    const res = createMockRes();
    const ctx = {
        req: { headers: { authorization: `Bearer ${TEST_API_KEY}` } },
        res,
        appCtx: createAppCtx(snapshot, services),
    };
    return Promise.resolve(handler(ctx)).then(() => res);
}

describe('Public /v1/models — additive gateway fields', () => {
    it('requires an API key', async () => {
        const router = createMockRouter();
        registerPublicApiRoutes(router, {});
        const handler = router.get('GET', '/v1/models');
        const res = createMockRes();
        await assert.rejects(
            handler({
                req: { headers: {} },
                res,
                appCtx: createAppCtx(snapshotFixture()),
            }),
            (err) => err?.errorType === 'authentication_required'
        );
    });

    it('emits _pricing/_context/_tags/_is_free for direct models', async () => {
        const snapshot = snapshotFixture();
        const res = await invokeModelsHandler(snapshot);
        const payload = body(res);
        const direct = payload.data.find((m) => m.id === 'openai/gpt-4o');
        assert.ok(direct);
        assert.equal(direct._pricing.mode, 'token');
        assert.equal(direct._pricing.input_per_million, 2.5);
        assert.equal(direct._pricing.output_per_million, 10);
        assert.equal(direct._context.window, 128_000);
        assert.equal(direct._context.max_output_tokens, 16_384);
        assert.deepEqual(direct._tags, ['chat', 'fast', 'tool-calling']);
        assert.equal(direct._is_free, false);
    });

    it('marks free direct models with _is_free:true', async () => {
        const snapshot = snapshotFixture();
        const res = await invokeModelsHandler(snapshot);
        const payload = body(res);
        const freeModel = payload.data.find(
            (m) => m.id === 'free-provider/tiny'
        );
        assert.equal(freeModel._is_free, true);
    });

    it('enriches sparse direct models from the in-memory pricing directory before emitting gateway metadata fields', async () => {
        const snapshot = snapshotFixture();
        const res = await invokeModelsHandler(snapshot, {
            pricingDirectory: createPricingDirectory(),
        });
        const payload = body(res);
        const model = payload.data.find(
            (m) => m.id === 'nvidia/google/gemma-3-27b-it'
        );
        assert.ok(model);
        assert.equal(model._pricing.mode, 'token');
        assert.equal(model._pricing.input_per_million, 0.27);
        assert.equal(model._pricing.output_per_million, 0.4);
        assert.equal(model._context.window, 131_072);
        assert.equal(model._context.max_output_tokens, 8192);
        assert.deepEqual(model._tags, [
            'chat',
            'fast',
            'long-context',
            'tool-calling',
            'vision',
        ]);
        assert.equal(model._is_free, true);
    });

    it('derives _billing_types and _is_free for cascade models from their children', async () => {
        const snapshot = snapshotFixture();
        const res = await invokeModelsHandler(snapshot);
        const payload = body(res);
        const cascade = payload.data.find((m) => m.id === 'axl/fast-cascade');
        assert.ok(cascade);
        assert.equal(cascade._strategy, 'cascade');
        assert.equal(cascade._child_count, 2);
        assert.deepEqual(cascade._billing_types, ['free', 'token']);
        // not all children are free → cascade is not free
        assert.equal(cascade._is_free, false);
    });

    it('keeps the OpenAI-compatible base shape and emits aliases with _alias:true', async () => {
        const snapshot = snapshotFixture();
        const res = await invokeModelsHandler(snapshot);
        const payload = body(res);
        assert.equal(payload.object, 'list');
        for (const entry of payload.data) {
            assert.equal(entry.object, 'model');
            assert.ok(typeof entry.id === 'string');
            assert.ok(typeof entry.created === 'number');
        }
        const alias = payload.data.find((m) => m.id === 'gpt-4o');
        assert.ok(alias);
        assert.equal(alias._alias, true);
        assert.equal(alias.root, 'openai/gpt-4o');
    });

    it('emits an empty list when the snapshot is absent', async () => {
        const router = createMockRouter();
        registerPublicApiRoutes(router, {});
        const handler = router.get('GET', '/v1/models');
        const res = createMockRes();
        await handler({
            req: { headers: { authorization: `Bearer ${TEST_API_KEY}` } },
            res,
            appCtx: createAppCtx(null),
        });
        assert.deepEqual(body(res), { object: 'list', data: [] });
    });
});
