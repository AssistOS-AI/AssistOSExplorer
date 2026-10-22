import { Readable } from 'node:stream';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { createRouter } from '../../core/path-router.mjs';
import { registerPublicApiRoutes } from '../../public-api/register-routes.mjs';

function jsonRequest(body) {
    const req = Readable.from([Buffer.from(JSON.stringify(body))]);
    req.headers = {};
    return req;
}

function captureResponse() {
    const res = {
        statusCode: null,
        headers: null,
        body: '',
        writableEnded: false,
        headersSent: false,
        setHeader() {},
        writeHead(statusCode, headers = {}) {
            this.statusCode = statusCode;
            this.headers = headers;
            this.headersSent = true;
        },
        end(chunk = '') {
            this.body += chunk;
            this.writableEnded = true;
        },
    };
    return res;
}

function makeAppCtx({ embed }) {
    const embeddingModel = {
        id: 'model-embed',
        modelKey: 'provider/text-embed',
        model_key: 'provider/text-embed',
        providerKey: 'provider',
        provider_key: 'provider',
        providerId: 'provider-id',
        provider_id: 'provider-id',
        providerModelId: 'text-embed',
        provider_model_id: 'text-embed',
        strategyKind: 'direct',
        strategy_kind: 'direct',
        enabled: true,
        tags: ['embeddings'],
        capabilities: {},
        metadata: {},
    };
    const embeddingTier = {
        id: 'tier-embeddings',
        modelKey: 'embeddings',
        model_key: 'embeddings',
        strategyKind: 'cascade',
        strategy_kind: 'cascade',
        enabled: true,
        children: [
            {
                modelKey: 'provider/text-embed',
                childEnabled: true,
                priority: 1,
            },
        ],
    };

    return {
        config: {
            env: {
                ALLOW_UNAUTHENTICATED: true,
                DEFAULT_MODEL_CONCURRENCY: 5,
                DEFAULT_QUEUE_TIMEOUT_MS: 1000,
            },
            defaults: {
                requestIdPrefix: 'test-',
            },
        },
        log: {
            info() {},
            warn() {},
            error() {},
        },
        services: {
            snapshot: {
                models: new Map([
                    ['embeddings', embeddingTier],
                    ['provider/text-embed', embeddingModel],
                ]),
                aliases: new Map(),
                providers: new Map([
                    [
                        'provider',
                        {
                            id: 'provider-id',
                            providerKey: 'provider',
                            provider_key: 'provider',
                            backendKey: 'fake-openai',
                            backend_key: 'fake-openai',
                            authStrategy: 'none',
                            auth_strategy: 'none',
                            baseUrl: 'https://provider.example/v1',
                            settings: {},
                        },
                    ],
                ]),
                cooldowns: new Map(),
            },
            backendCatalog: {
                getBackend(key) {
                    assert.equal(key, 'fake-openai');
                    return { embed };
                },
            },
        },
    };
}

describe('POST /v1/embeddings', () => {
    it('dispatches embedding tiers to embeddings-tagged child models', async () => {
        const calls = [];
        const appCtx = makeAppCtx({
            async embed(ctx) {
                calls.push(ctx);
                return {
                    object: 'list',
                    data: [
                        {
                            object: 'embedding',
                            index: 0,
                            embedding: [0.1, 0.2],
                        },
                    ],
                    model: ctx.request.model,
                    usage: { prompt_tokens: 1, total_tokens: 1 },
                };
            },
        });
        const router = createRouter();
        registerPublicApiRoutes(router, appCtx);
        const match = router.match('POST', '/v1/embeddings');
        assert.ok(match);

        const req = jsonRequest({ model: 'embeddings', input: ['hello'] });
        const res = captureResponse();
        await match.handler({
            req,
            res,
            requestId: 'req-embed',
            appCtx,
        });

        assert.equal(res.statusCode, 200);
        const body = JSON.parse(res.body);
        assert.deepEqual(body.data[0].embedding, [0.1, 0.2]);
        assert.equal(calls.length, 1);
        assert.equal(calls[0].resolvedModel.modelKey, 'provider/text-embed');
        assert.deepEqual(calls[0].request.input, ['hello']);
    });
});
