/**
 * Route chain end-to-end tests.
 *
 * Validates Phase 6: the request lifecycle now runs as a kernel-composed
 * chain of route middlewares (parse → auth → identity → snapshot →
 * normalize → validate → resolveModel → resolveSession → respond →
 * gatewayDispatch terminal) instead of the legacy hand-rolled stage
 * machine.
 *
 * The goal of this file is contract coverage:
 *
 *   - the chain runs every middleware in the right order
 *   - the dispatch terminal sets ctx.response and the respond
 *     middleware serializes it onto a fake `res`
 *   - the error boundary catches GatewayErrors and writes a structured
 *     error body
 *   - individual middlewares can be exercised in isolation against a
 *     hand-built kernel ctx
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';

import {
    buildRouteChain,
    parseBodyMiddleware,
    authenticateMiddleware,
    identityMiddleware,
    bindSnapshotMiddleware,
    normalizeIngressMiddleware,
    validateRequestMiddleware,
    resolveModelMiddleware,
    resolveSessionMiddleware,
    respondMiddleware,
    errorBoundaryMiddleware,
} from '../../runtime/route/run-route-request.mjs';
import { _resetPermissiveWarning as _resetAuthLatch } from '../../runtime/route/authenticate.mjs';
import { compose, createKernelContext } from '../../runtime/kernel/index.mjs';
import * as backendTerminalModule from '../../runtime/backends/backend-terminal.mjs';
import * as responseCache from '../../runtime/middleware/builtin/response-cache.mjs';
import { ModelNotFoundError, ValidationError } from '../../core/errors.mjs';

// ── helpers ────────────────────────────────────────────────────────────

function makeFakeReq(body, { headers = {} } = {}) {
    const json = typeof body === 'string' ? body : JSON.stringify(body);
    const stream = Readable.from([Buffer.from(json)]);
    stream.headers = { 'content-type': 'application/json', ...headers };
    return stream;
}

function makeFakeRes() {
    const captured = { status: null, headers: {}, body: null, ended: false };
    return {
        captured,
        headersSent: false,
        writableEnded: false,
        setHeader(k, v) {
            captured.headers[k] = v;
        },
        writeHead(status, headers) {
            captured.status = status;
            Object.assign(captured.headers, headers);
            this.headersSent = true;
        },
        end(chunk) {
            if (chunk) captured.body = chunk;
            this.writableEnded = true;
            captured.ended = true;
        },
        write(chunk) {
            captured.body = (captured.body || '') + (chunk || '');
        },
    };
}

function makeAppCtx({
    snapshot = null,
    services = {},
    middlewareCatalog = null,
    env = {},
} = {}) {
    return {
        config: {
            defaults: {
                requestIdPrefix: 'test-',
                responseExcerptChars: 2000,
            },
            env: {
                BODY_LIMIT_BYTES: 5_242_880,
                ALLOW_UNAUTHENTICATED: true,
                DEFAULT_RPM_LIMIT: 60,
                DEFAULT_TPM_LIMIT: 100_000,
                DEFAULT_REQUEST_TIMEOUT_MS: 1000,
                DEFAULT_QUEUE_TIMEOUT_MS: 1000,
                DEFAULT_MODEL_CONCURRENCY: 1,
                HTTP_RETRY_MAX_ATTEMPTS: 1,
                HTTP_RETRY_BASE_DELAY_MS: 1,
                HTTP_RETRY_MULTIPLIER: 1,
                HTTP_RETRY_MAX_DELAY_MS: 1,
                HTTP_RETRY_JITTER_PCT: 0,
                ...env,
            },
        },
        pool: null,
        log: { debug() {}, info() {}, warn() {}, error() {}, fatal() {} },
        services: {
            snapshot,
            middlewareCatalog,
            backendCatalog: services.backendCatalog ?? null,
            providerMiddlewareRegistry:
                services.providerMiddlewareRegistry ?? {
                    build: () => null,
                    get: () => null,
                },
            credentialManager: null,
            concurrencyController: null,
            extensionServices: Object.freeze({}),
            ...services,
        },
    };
}

function makeKernelCtx({ req, res, appCtx, routeKind = 'openai_chat' } = {}) {
    return createKernelContext({
        requestId: 'test-req-1',
        route: { kind: routeKind, format: routeKind },
        services: appCtx?.services,
        log: appCtx?.log,
        appCtx,
        http: { req, res },
    });
}

beforeEach(() => {
    _resetAuthLatch();
});

// ── isolated middleware tests ──────────────────────────────────────────

describe('parseBodyMiddleware', () => {
    it('parses a JSON body and stores it on ctx.body', async () => {
        const req = makeFakeReq({
            model: 'gpt-test',
            messages: [{ role: 'user', content: 'hi' }],
        });
        const ctx = makeKernelCtx({
            req,
            res: makeFakeRes(),
            appCtx: makeAppCtx(),
        });

        await parseBodyMiddleware()(ctx, async () => {});

        assert.equal(ctx.body.model, 'gpt-test');
        assert.equal(ctx.body.messages.length, 1);
        assert.ok(ctx.metadata.parseMs >= 0);
    });

    it('throws when ctx.http.req is missing', async () => {
        const ctx = createKernelContext({ requestId: 'r' });
        await assert.rejects(
            parseBodyMiddleware()(ctx, async () => {}),
            /ctx\.http\.req is required/
        );
    });
});

describe('authenticateMiddleware (permissive mode)', () => {
    it('builds a stub auth view when ALLOW_UNAUTHENTICATED=true', async () => {
        const req = makeFakeReq({});
        const ctx = makeKernelCtx({
            req,
            res: makeFakeRes(),
            appCtx: makeAppCtx(),
        });
        await authenticateMiddleware()(ctx, async () => {});
        assert.equal(ctx.auth.keyId, 'permissive-stub');
        assert.equal(ctx.auth.label, 'unauthenticated');
        assert.equal(ctx.auth.rpmLimit, 60);
    });

    it('throws AuthenticationRequiredError when neither auth nor permissive opt-in are configured', async () => {
        const req = makeFakeReq({});
        const appCtx = makeAppCtx({ env: { ALLOW_UNAUTHENTICATED: false } });
        const ctx = makeKernelCtx({ req, res: makeFakeRes(), appCtx });
        await assert.rejects(
            authenticateMiddleware()(ctx, async () => {}),
            /API key authentication is not configured/
        );
    });
});

describe('identityMiddleware', () => {
    it('reads identity headers from ctx.http.req.headers', async () => {
        const req = makeFakeReq(
            {},
            {
                headers: {
                    'x-soul-id': 'soul-1',
                    'x-soul-agent': 'agent-1',
                },
            }
        );
        const ctx = makeKernelCtx({
            req,
            res: makeFakeRes(),
            appCtx: makeAppCtx(),
        });
        await identityMiddleware()(ctx, async () => {});
        assert.equal(ctx.identity.soulId, 'soul-1');
        assert.equal(ctx.identity.agentName, 'agent-1');
    });
});

describe('bindSnapshotMiddleware', () => {
    it('pins the appCtx snapshot onto the kernel ctx', async () => {
        const snap = Object.freeze({
            generation: 42,
            models: new Map(),
            aliases: new Map(),
            tiers: new Map(),
            providers: new Map(),
        });
        const ctx = makeKernelCtx({
            req: makeFakeReq({}),
            res: makeFakeRes(),
            appCtx: makeAppCtx({ snapshot: snap }),
        });
        await bindSnapshotMiddleware()(ctx, async () => {});
        assert.equal(ctx.snapshot, snap);
    });
});

describe('normalizeIngressMiddleware', () => {
    it('runs the openai_chat normalizer when ctx.route.kind is openai_chat', async () => {
        const ctx = makeKernelCtx({
            req: makeFakeReq({}),
            res: makeFakeRes(),
            appCtx: makeAppCtx(),
        });
        ctx.body = {
            model: 'gpt-test',
            messages: [{ role: 'user', content: 'hi' }],
            stream: false,
        };
        await normalizeIngressMiddleware()(ctx, async () => {});
        assert.equal(ctx.request.model, 'gpt-test');
    });

    it('runs the anthropic_messages normalizer when route.kind is anthropic_messages', async () => {
        const ctx = makeKernelCtx({
            req: makeFakeReq({}),
            res: makeFakeRes(),
            appCtx: makeAppCtx(),
            routeKind: 'anthropic_messages',
        });
        ctx.body = {
            model: 'claude-3',
            system: 'You are a helpful assistant.',
            messages: [{ role: 'user', content: 'hi' }],
        };
        await normalizeIngressMiddleware()(ctx, async () => {});
        assert.equal(ctx.request.messages.length, 2);
        assert.equal(ctx.request.messages[0].role, 'system');
    });
});

describe('validateRequestMiddleware', () => {
    it('rejects an empty messages array', async () => {
        const ctx = makeKernelCtx({
            req: makeFakeReq({}),
            res: makeFakeRes(),
            appCtx: makeAppCtx(),
        });
        ctx.request = { model: 'gpt-test', messages: [] };
        await assert.rejects(
            validateRequestMiddleware()(ctx, async () => {}),
            ValidationError
        );
    });
});

describe('resolveModelMiddleware', () => {
    it('resolves a direct model from the snapshot', async () => {
        const model = Object.freeze({
            id: 'm1',
            modelKey: 'gpt-test',
            providerKey: 'p',
        });
        const snapshot = Object.freeze({
            models: new Map([['gpt-test', model]]),
            aliases: new Map(),
            tiers: new Map(),
            providers: new Map(),
        });
        const ctx = makeKernelCtx({
            req: makeFakeReq({}),
            res: makeFakeRes(),
            appCtx: makeAppCtx({ snapshot }),
        });
        ctx.snapshot = snapshot;
        ctx.request = {
            model: 'gpt-test',
            messages: [{ role: 'user', content: 'hi' }],
        };

        await resolveModelMiddleware()(ctx, async () => {});

        assert.equal(ctx.target.model, model);
        assert.equal(ctx.metadata.resolvedModel.kind, 'model');
    });

    it('throws ModelNotFoundError when the snapshot does not contain the requested model', async () => {
        const snapshot = Object.freeze({
            models: new Map(),
            aliases: new Map(),
            tiers: new Map(),
            providers: new Map(),
        });
        const ctx = makeKernelCtx({
            req: makeFakeReq({}),
            res: makeFakeRes(),
            appCtx: makeAppCtx({ snapshot }),
        });
        ctx.snapshot = snapshot;
        ctx.request = { model: 'unknown', messages: [] };

        await assert.rejects(
            resolveModelMiddleware()(ctx, async () => {}),
            ModelNotFoundError
        );
    });
});

describe('resolveSessionMiddleware (no DB)', () => {
    it('builds an in-memory session view from identity + auth', async () => {
        const ctx = makeKernelCtx({
            req: makeFakeReq({}),
            res: makeFakeRes(),
            appCtx: makeAppCtx(),
        });
        ctx.identity = {
            soulId: 's1',
            agentName: 'a1',
            explicitSessionId: null,
        };
        ctx.auth = { keyId: 'k-1', apiKeyRecord: { id: 'k-1' } };

        await resolveSessionMiddleware()(ctx, async () => {});
        assert.equal(ctx.session.key, 'k-1');
        assert.equal(ctx.session.agentName, 'a1');
    });

    it('uses an explicit session id when present', async () => {
        const ctx = makeKernelCtx({
            req: makeFakeReq({}),
            res: makeFakeRes(),
            appCtx: makeAppCtx(),
        });
        ctx.identity = {
            soulId: 's1',
            agentName: 'a1',
            explicitSessionId: 'sess-99',
        };
        ctx.auth = { keyId: 'k-1', apiKeyRecord: { id: 'k-1' } };

        await resolveSessionMiddleware()(ctx, async () => {});
        assert.equal(ctx.session.id, 'sess-99');
        assert.equal(ctx.session.key, 'explicit:k-1:sess-99');
    });
});

describe('respondMiddleware', () => {
    it('serializes ctx.response to the requested format and sends', async () => {
        const res = makeFakeRes();
        const ctx = makeKernelCtx({
            req: makeFakeReq({}),
            res,
            appCtx: makeAppCtx(),
            routeKind: 'openai_chat',
        });

        await respondMiddleware()(ctx, async () => {
            ctx.response = {
                id: 'r1',
                object: 'chat.completion',
                model: 'gpt-test',
                choices: [
                    {
                        index: 0,
                        message: { role: 'assistant', content: 'hi back' },
                        finish_reason: 'stop',
                    },
                ],
                usage: {
                    prompt_tokens: 1,
                    completion_tokens: 2,
                    total_tokens: 3,
                },
            };
        });

        assert.equal(res.captured.status, 200);
        const body = JSON.parse(res.captured.body);
        assert.equal(body.choices[0].message.content, 'hi back');
    });

    it('does not double-write when the response was already sent upstream', async () => {
        const res = makeFakeRes();
        res.writableEnded = true;
        const ctx = makeKernelCtx({
            req: makeFakeReq({}),
            res,
            appCtx: makeAppCtx(),
        });
        await respondMiddleware()(ctx, async () => {
            ctx.response = { choices: [], usage: null };
        });
        assert.equal(res.captured.status, null);
    });
});

describe('errorBoundaryMiddleware', () => {
    it('catches a GatewayError and writes a structured error body', async () => {
        const res = makeFakeRes();
        const ctx = makeKernelCtx({
            req: makeFakeReq({}),
            res,
            appCtx: makeAppCtx(),
        });

        const chain = compose([
            errorBoundaryMiddleware(),
            async () => {
                throw new ModelNotFoundError('unknown');
            },
        ]);

        await chain(ctx);
        assert.equal(res.captured.status, 404);
        const body = JSON.parse(res.captured.body);
        assert.equal(body.error.type, 'model_not_found');
    });

    it('catches an unhandled error and returns a 500', async () => {
        const res = makeFakeRes();
        const ctx = makeKernelCtx({
            req: makeFakeReq({}),
            res,
            appCtx: makeAppCtx(),
        });

        const chain = compose([
            errorBoundaryMiddleware(),
            async () => {
                throw new Error('boom');
            },
        ]);

        await chain(ctx);
        assert.equal(res.captured.status, 500);
        const body = JSON.parse(res.captured.body);
        assert.equal(body.error.type, 'internal_error');
    });

    it('writes a route-kind-specific SSE error frame when headers were already sent', async () => {
        const res = makeFakeRes();
        res.headersSent = true;
        const ctx = makeKernelCtx({
            req: makeFakeReq({}),
            res,
            appCtx: makeAppCtx(),
            routeKind: 'openai_responses',
        });

        const chain = compose([
            errorBoundaryMiddleware(),
            async () => {
                throw new Error('boom');
            },
        ]);

        await chain(ctx);
        assert.match(res.captured.body, /event: response\.failed/);
        assert.match(res.captured.body, /"status":"failed"/);
    });

    it('lets a successful chain pass through unchanged', async () => {
        const res = makeFakeRes();
        const ctx = makeKernelCtx({
            req: makeFakeReq({}),
            res,
            appCtx: makeAppCtx(),
        });

        const chain = compose([
            errorBoundaryMiddleware(),
            respondMiddleware(),
            async () => {
                ctx.response = {
                    choices: [
                        {
                            index: 0,
                            message: { role: 'assistant', content: 'ok' },
                            finish_reason: 'stop',
                        },
                    ],
                    usage: {
                        prompt_tokens: 0,
                        completion_tokens: 0,
                        total_tokens: 0,
                    },
                };
            },
        ]);

        await chain(ctx);
        assert.equal(res.captured.status, 200);
    });
});

// ── full chain integration ─────────────────────────────────────────────

describe('full route chain integration', () => {
    function buildSnapshot(model) {
        return Object.freeze({
            generation: 1,
            models: new Map([[model.modelKey, model]]),
            aliases: new Map(),
            tiers: new Map(),
            providers: new Map([
                [
                    model.providerKey,
                    Object.freeze({
                        id: 'provider-1',
                        providerKey: model.providerKey,
                        backendKey: 'stub-backend',
                        settings: {},
                    }),
                ],
            ]),
            middlewareAssignments: Object.freeze({
                byTier: new Map(),
                byModel: new Map(),
            }),
            cooldowns: new Set(),
            pricing: new Map(),
        });
    }

    function buildBackendCatalog(backendModule) {
        const { createBackendTerminal } = backendTerminalModule;
        const terminal = createBackendTerminal(backendModule);
        return {
            getTerminal(key) {
                if (key === backendModule.manifest.key) return terminal;
                return null;
            },
            getBackend(key) {
                if (key === backendModule.manifest.key) return backendModule;
                return null;
            },
        };
    }

    it('runs the full chain end-to-end and serializes the buffered response', async () => {
        async function* events() {
            yield {
                type: 'message_start',
                data: { id: 'm1', model: 'stub-model', role: 'assistant' },
            };
            yield { type: 'text_delta', data: { text: 'hello from stub' } };
            yield {
                type: 'usage',
                data: { input_tokens: 1, output_tokens: 3, total_tokens: 4 },
            };
            yield { type: 'done', data: { finish_reason: 'stop' } };
        }

        const stubBackend = {
            manifest: {
                key: 'stub-backend',
                kind: 'external_api',
                authStrategy: 'api_key',
                supportsStreaming: true,
                supportsTools: false,
                supportedFormats: ['openai_chat'],
            },
            async execute(ctx) {
                return {
                    accountId: 'acct-1',
                    stream: events(),
                    abort: async () => {},
                };
            },
            classifyError(e) {
                return e;
            },
        };

        const model = Object.freeze({
            id: 'model-1',
            modelKey: 'stub-model',
            providerId: 'provider-1',
            providerKey: 'stub-provider',
            providerModelId: 'stub-model',
            requestTimeoutMs: 1000,
            queueTimeoutMs: 1000,
            concurrencyLimit: 1,
            retryPolicy: {},
        });

        const snapshot = buildSnapshot(model);
        const backendCatalog = buildBackendCatalog(stubBackend);

        const appCtx = makeAppCtx({
            snapshot,
            services: { backendCatalog },
        });

        const req = makeFakeReq({
            model: 'stub-model',
            messages: [{ role: 'user', content: 'hi' }],
        });
        const res = makeFakeRes();

        const ctx = makeKernelCtx({ req, res, appCtx });

        await buildRouteChain()(ctx);

        assert.equal(res.captured.status, 200);
        const body = JSON.parse(res.captured.body);
        assert.equal(body.choices[0].message.content, 'hello from stub');
        assert.equal(body.usage.total_tokens, 4);
        assert.equal(ctx.metadata.totalMs >= 0, true);
    });

    it('writes one completed audit log after auth and request normalization', async () => {
        async function* events() {
            yield {
                type: 'message_start',
                data: { id: 'm1', model: 'stub-model', role: 'assistant' },
            };
            yield { type: 'text_delta', data: { text: 'audited response' } };
            yield {
                type: 'usage',
                data: { input_tokens: 2, output_tokens: 5, total_tokens: 7 },
            };
            yield {
                type: 'done',
                data: { finish_reason: 'stop', model: 'stub-model' },
            };
        }

        const stubBackend = {
            manifest: {
                key: 'stub-backend',
                kind: 'external_api',
                authStrategy: 'api_key',
                supportsStreaming: true,
                supportsTools: false,
                supportedFormats: ['openai_chat'],
            },
            async execute() {
                return {
                    accountId: 'acct-1',
                    stream: events(),
                    abort: async () => {},
                };
            },
            classifyError(e) {
                return e;
            },
        };

        const model = Object.freeze({
            id: 'model-1',
            modelKey: 'stub-model',
            providerId: 'provider-1',
            providerKey: 'stub-provider',
            providerModelId: 'stub-model',
            requestTimeoutMs: 1000,
            queueTimeoutMs: 1000,
            concurrencyLimit: 1,
            pricingMode: 'token',
            inputPricePerMillion: 1000,
            outputPricePerMillion: 2000,
            retryPolicy: {},
        });

        const calls = { write: null };
        const auditLogWriter = {
            async write(entry) {
                calls.write = entry;
                return { log_id: 'log-1' };
            },
        };

        const snapshot = buildSnapshot(model);
        const backendCatalog = buildBackendCatalog(stubBackend);
        const appCtx = makeAppCtx({
            snapshot,
            services: { auditLogWriter, backendCatalog },
        });

        const req = makeFakeReq(
            {
                model: 'stub-model',
                messages: [{ role: 'user', content: 'hi' }],
            },
            {
                headers: {
                    authorization: 'Bearer sk-test-123',
                    cookie: 'session=secret',
                    'x-session-id': '11111111-1111-1111-1111-111111111111',
                    'x-soul-id': 'soul-1',
                    'x-agent-name': 'agent-1',
                },
            }
        );
        const res = makeFakeRes();

        await buildRouteChain()(makeKernelCtx({ req, res, appCtx }));

        assert.equal(calls.write.apiKeyId, 'permissive-stub');
        assert.equal(calls.write.requestedModel, 'stub-model');
        assert.equal(
            calls.write.sessionId,
            '11111111-1111-1111-1111-111111111111'
        );
        assert.deepEqual(calls.write.requestPayload, {
            model: 'stub-model',
            messages: [{ role: 'user', content: 'hi' }],
            stream: false,
        });
        assert.deepEqual(calls.write.requestHeaders, {
            'content-type': 'application/json',
            'x-session-id': '11111111-1111-1111-1111-111111111111',
            'x-soul-id': 'soul-1',
            'x-agent-name': 'agent-1',
        });
        assert.equal(calls.write.totalTokens, 7);
        assert.equal(calls.write.totalCostUsd, 0.012);
        assert.equal(calls.write.status, 'succeeded');
    });

    it('records cache hits in audit logs and avoids a second backend call', async () => {
        responseCache._resetCache();

        let executeCalls = 0;
        async function* events(text) {
            yield {
                type: 'message_start',
                data: { id: 'm1', model: 'stub-model', role: 'assistant' },
            };
            yield { type: 'text_delta', data: { text } };
            yield {
                type: 'usage',
                data: { input_tokens: 2, output_tokens: 5, total_tokens: 7 },
            };
            yield {
                type: 'done',
                data: { finish_reason: 'stop', model: 'stub-model' },
            };
        }

        const stubBackend = {
            manifest: {
                key: 'stub-backend',
                kind: 'external_api',
                authStrategy: 'api_key',
                supportsStreaming: true,
                supportsTools: false,
                supportedFormats: ['openai_chat'],
            },
            async execute() {
                executeCalls++;
                return {
                    accountId: 'acct-1',
                    stream: events(`cached response ${executeCalls}`),
                    abort: async () => {},
                };
            },
            classifyError(e) {
                return e;
            },
        };

        const model = Object.freeze({
            id: 'model-1',
            modelKey: 'stub-model',
            providerId: 'provider-1',
            providerKey: 'stub-provider',
            providerModelId: 'stub-model',
            requestTimeoutMs: 1000,
            queueTimeoutMs: 1000,
            concurrencyLimit: 1,
            retryPolicy: {},
        });

        const auditEntries = [];
        const auditLogWriter = {
            async write(entry) {
                auditEntries.push(entry);
                return { log_id: `log-${auditEntries.length}` };
            },
        };
        const cacheMiddleware = responseCache.factory(
            responseCache.meta.defaultSettings
        );
        const middlewareCatalog = {
            resolveGatewayChain() {
                return [cacheMiddleware];
            },
        };

        const snapshot = buildSnapshot(model);
        const backendCatalog = buildBackendCatalog(stubBackend);
        const appCtx = makeAppCtx({
            snapshot,
            middlewareCatalog,
            services: { auditLogWriter, backendCatalog },
        });
        const body = {
            model: 'stub-model',
            messages: [{ role: 'user', content: 'hi' }],
        };

        const res1 = makeFakeRes();
        await buildRouteChain()(
            makeKernelCtx({ req: makeFakeReq(body), res: res1, appCtx })
        );
        assert.equal(
            JSON.parse(res1.captured.body).choices[0].message.content,
            'cached response 1'
        );

        const res2 = makeFakeRes();
        await buildRouteChain()(
            makeKernelCtx({ req: makeFakeReq(body), res: res2, appCtx })
        );
        assert.equal(
            JSON.parse(res2.captured.body).choices[0].message.content,
            'cached response 1'
        );

        assert.equal(executeCalls, 1);
        assert.equal(auditEntries.length, 2);
        assert.equal(auditEntries[0].cacheHit, false);
        assert.equal(auditEntries[1].cacheHit, true);
    });

    it('returns a typed error body when the requested model is unknown', async () => {
        const snapshot = Object.freeze({
            generation: 1,
            models: new Map(),
            aliases: new Map(),
            tiers: new Map(),
            providers: new Map(),
            middlewareAssignments: Object.freeze({
                byTier: new Map(),
                byModel: new Map(),
            }),
            cooldowns: new Set(),
            pricing: new Map(),
        });

        const appCtx = makeAppCtx({ snapshot });
        const req = makeFakeReq({
            model: 'unknown',
            messages: [{ role: 'user', content: 'hi' }],
        });
        const res = makeFakeRes();

        await buildRouteChain()(makeKernelCtx({ req, res, appCtx }));

        assert.equal(res.captured.status, 404);
        const body = JSON.parse(res.captured.body);
        assert.equal(body.error.type, 'model_not_found');
    });

    it('returns 400 when the body is invalid', async () => {
        const snapshot = Object.freeze({
            generation: 1,
            models: new Map(),
            aliases: new Map(),
            tiers: new Map(),
            providers: new Map(),
            middlewareAssignments: Object.freeze({
                byTier: new Map(),
                byModel: new Map(),
            }),
            cooldowns: new Set(),
            pricing: new Map(),
        });

        const appCtx = makeAppCtx({ snapshot });
        // Empty messages array fails validation
        const req = makeFakeReq({ model: 'gpt-test', messages: [] });
        const res = makeFakeRes();

        await buildRouteChain()(makeKernelCtx({ req, res, appCtx }));

        assert.equal(res.captured.status, 400);
    });

    it('returns 401 when auth is required and not configured', async () => {
        const appCtx = makeAppCtx({ env: { ALLOW_UNAUTHENTICATED: false } });
        const req = makeFakeReq({
            model: 'gpt-test',
            messages: [{ role: 'user', content: 'hi' }],
        });
        const res = makeFakeRes();

        await buildRouteChain()(makeKernelCtx({ req, res, appCtx }));
        assert.equal(res.captured.status, 401);
    });
});
