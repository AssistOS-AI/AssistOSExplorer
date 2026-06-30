/**
 * Route-level streaming tests.
 *
 * Proves the new SSE egress path that Workstream C added:
 *
 *   - `canonicalStreamToSse` converts canonical events to the right
 *     SSE wire format for each of the three public route kinds.
 *
 *   - `respondMiddleware` branches on the shape of `ctx.response`
 *     (CanonicalStream → SSE, buffered → JSON).
 *
 *   - The full route chain (`runRouteRequest` via `buildRouteChain`)
 *     can serve a streaming response end-to-end when the client sends
 *     `stream: true` and a stub transport returns a canonical event
 *     stream.
 *
 *   - Client disconnect during a stream aborts the iteration cleanly.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Readable, PassThrough } from 'node:stream';
import { EventEmitter } from 'node:events';

import {
    buildRouteChain,
    respondMiddleware,
} from '../../runtime/route/run-route-request.mjs';
import { canonicalStreamToSse } from '../../runtime/route/canonical-stream-to-sse.mjs';
import {
    compose,
    createKernelContext,
    createCanonicalStream,
} from '../../runtime/kernel/index.mjs';
import { createBackendTerminal } from '../../runtime/backends/backend-terminal.mjs';

// ── helpers ────────────────────────────────────────────────────────────

function makeFakeReq(body, { headers = {} } = {}) {
    const json = typeof body === 'string' ? body : JSON.stringify(body);
    const stream = Readable.from([Buffer.from(json)]);
    stream.headers = { 'content-type': 'application/json', ...headers };
    return stream;
}

/**
 * A fake ServerResponse that captures write() and end() calls and
 * supports the event emitter surface used by respondMiddleware
 * (`once('close')`, `off?.('close')`, `once('drain')`).
 */
function makeFakeRes() {
    const emitter = new EventEmitter();
    const captured = { status: null, headers: {}, chunks: [], ended: false };

    const res = {
        captured,
        headersSent: false,
        writableEnded: false,
        setHeader(k, v) {
            captured.headers[k] = v;
        },
        writeHead(status, headers) {
            captured.status = status;
            if (headers) Object.assign(captured.headers, headers);
            this.headersSent = true;
        },
        write(chunk) {
            captured.chunks.push(
                typeof chunk === 'string' ? chunk : chunk.toString('utf8')
            );
            return true;
        },
        end(chunk) {
            if (chunk)
                captured.chunks.push(
                    typeof chunk === 'string' ? chunk : chunk.toString('utf8')
                );
            this.writableEnded = true;
            captured.ended = true;
            emitter.emit('close');
        },
        once(event, fn) {
            emitter.once(event, fn);
        },
        off(event, fn) {
            emitter.off(event, fn);
        },
        emit(event, ...args) {
            emitter.emit(event, ...args);
        },
        _simulateClose() {
            emitter.emit('close');
        },
    };
    return res;
}

function noopLog() {
    return { debug() {}, info() {}, warn() {}, error() {}, fatal() {} };
}

async function* sampleEvents(text = 'hello world') {
    yield {
        type: 'message_start',
        data: { id: 'm1', model: 'stub-model', role: 'assistant' },
    };
    const half = Math.floor(text.length / 2);
    yield { type: 'text_delta', data: { text: text.slice(0, half) } };
    yield { type: 'text_delta', data: { text: text.slice(half) } };
    yield {
        type: 'usage',
        data: { input_tokens: 1, output_tokens: 2, total_tokens: 3 },
    };
    yield {
        type: 'done',
        data: { finish_reason: 'stop', model: 'stub-model' },
    };
}

function collectChunks(res) {
    return res.captured.chunks.join('');
}

// ── canonicalStreamToSse: per route-kind wire formats ─────────────────

describe('canonicalStreamToSse: openai_chat', () => {
    it('emits a role chunk, text deltas, usage, finish, and [DONE]', async () => {
        const stream = createCanonicalStream(sampleEvents('hi'));
        const out = [];
        for await (const chunk of canonicalStreamToSse(
            stream,
            'openai_chat',
            'req-1'
        ))
            out.push(chunk);
        const joined = out.join('');

        // SSE framing
        assert.ok(joined.includes('data: '));
        // Role start
        assert.ok(/"role":"assistant"/.test(joined));
        // Text content
        assert.ok(/"content":"h"/.test(joined));
        assert.ok(/"content":"i"/.test(joined));
        // Finish reason
        assert.ok(/"finish_reason":"stop"/.test(joined));
        // Terminator
        assert.ok(joined.endsWith('data: [DONE]\n\n'));
    });

    it('emits tool-call deltas', async () => {
        async function* events() {
            yield {
                type: 'message_start',
                data: { id: 't1', model: 'stub-model', role: 'assistant' },
            };
            yield {
                type: 'tool_call_delta',
                data: {
                    index: 0,
                    id: 'call_1',
                    name: 'search',
                    arguments: '{"q":',
                },
            };
            yield {
                type: 'tool_call_delta',
                data: { index: 0, arguments: '"hello"}' },
            };
            yield { type: 'done', data: { finish_reason: 'tool_calls' } };
        }
        const out = [];
        for await (const chunk of canonicalStreamToSse(
            createCanonicalStream(events()),
            'openai_chat',
            'req-2'
        ))
            out.push(chunk);
        const joined = out.join('');
        assert.ok(/"tool_calls"/.test(joined));
        assert.ok(/"name":"search"/.test(joined));
        assert.ok(/"arguments":"\{\\"q\\":"/.test(joined));
        assert.ok(joined.endsWith('data: [DONE]\n\n'));
    });

    it('emits a synthetic finish if the stream ends without a done event', async () => {
        async function* events() {
            yield {
                type: 'message_start',
                data: { id: 's1', model: 'm', role: 'assistant' },
            };
            yield { type: 'text_delta', data: { text: 'oops' } };
        }
        const out = [];
        for await (const chunk of canonicalStreamToSse(
            createCanonicalStream(events()),
            'openai_chat',
            'req-3'
        ))
            out.push(chunk);
        const joined = out.join('');
        assert.ok(/"finish_reason":"stop"/.test(joined));
        assert.ok(joined.endsWith('data: [DONE]\n\n'));
    });

    it('emits an error frame when the stream surfaces an error event', async () => {
        async function* events() {
            yield {
                type: 'message_start',
                data: { id: 'e1', model: 'm', role: 'assistant' },
            };
            yield {
                type: 'error',
                error: { message: 'upstream exploded', type: 'provider_error' },
            };
        }
        const out = [];
        for await (const chunk of canonicalStreamToSse(
            createCanonicalStream(events()),
            'openai_chat',
            'req-4'
        ))
            out.push(chunk);
        const joined = out.join('');
        assert.ok(/"message":"upstream exploded"/.test(joined));
        assert.ok(/"type":"provider_error"/.test(joined));
    });
});

describe('canonicalStreamToSse: anthropic_messages', () => {
    it('emits Anthropic-shaped message_start, content_block_delta, message_delta, message_stop frames', async () => {
        const stream = createCanonicalStream(sampleEvents('ab'));
        const out = [];
        for await (const chunk of canonicalStreamToSse(
            stream,
            'anthropic_messages',
            'req-a1'
        ))
            out.push(chunk);
        const joined = out.join('');

        assert.ok(joined.includes('event: message_start'));
        assert.ok(joined.includes('event: content_block_start'));
        assert.ok(joined.includes('event: content_block_delta'));
        assert.ok(joined.includes('"type":"text_delta"'));
        assert.ok(joined.includes('event: content_block_stop'));
        assert.ok(joined.includes('event: message_delta'));
        assert.ok(joined.includes('event: message_stop'));
        assert.ok(joined.includes('"stop_reason":"end_turn"'));
    });
});

describe('canonicalStreamToSse: openai_responses', () => {
    it('emits Responses-shaped created / output_text.delta / completed events', async () => {
        const stream = createCanonicalStream(sampleEvents('xy'));
        const out = [];
        for await (const chunk of canonicalStreamToSse(
            stream,
            'openai_responses',
            'req-r1'
        ))
            out.push(chunk);
        const joined = out.join('');

        assert.ok(joined.includes('event: response.created'));
        assert.ok(joined.includes('event: response.output_item.added'));
        assert.ok(joined.includes('event: response.output_text.delta'));
        assert.ok(joined.includes('event: response.output_item.done'));
        assert.ok(joined.includes('event: response.completed'));
    });
});

// ── respondMiddleware: buffered vs streaming branch ───────────────────

describe('respondMiddleware: branching', () => {
    function makeCtx({
        response,
        request = { model: 'm', stream: false },
        res = makeFakeRes(),
    }) {
        const ctx = createKernelContext({
            requestId: 'req-test',
            request,
            route: { kind: 'openai_chat', format: 'openai_chat' },
            log: noopLog(),
            appCtx: { config: { env: {} }, services: {} },
            http: { req: null, res },
        });
        ctx.response = response;
        return ctx;
    }

    it('serializes a buffered chat completion as a single JSON body', async () => {
        const ctx = makeCtx({
            response: {
                id: 'r1',
                object: 'chat.completion',
                model: 'stub-model',
                choices: [
                    {
                        index: 0,
                        message: { role: 'assistant', content: 'hello' },
                        finish_reason: 'stop',
                    },
                ],
                usage: {
                    prompt_tokens: 1,
                    completion_tokens: 1,
                    total_tokens: 2,
                },
            },
        });

        await respondMiddleware()(ctx, async () => {});

        assert.equal(ctx.http.res.captured.status, 200);
        const body = JSON.parse(collectChunks(ctx.http.res));
        assert.equal(body.choices[0].message.content, 'hello');
    });

    it('streams SSE when ctx.response is a CanonicalStream', async () => {
        const res = makeFakeRes();
        const ctx = makeCtx({
            response: createCanonicalStream(sampleEvents('quick')),
            request: { model: 'm', stream: true },
            res,
        });

        await respondMiddleware()(ctx, async () => {});

        assert.equal(res.captured.status, 200);
        assert.equal(res.captured.headers['Content-Type'], 'text/event-stream');
        const body = collectChunks(res);
        assert.ok(body.startsWith('data: '));
        assert.ok(body.endsWith('data: [DONE]\n\n'));
        assert.ok(res.writableEnded);
        assert.equal(ctx.metadata.responseCapture.excerpt, 'quick');
        assert.equal(
            ctx.metadata.responseCapture.payload.choices[0].message.content,
            'quick'
        );
        assert.equal(ctx.metadata.aborted, false);
    });

    it('streams SSE when ctx.response has a .stream that is a CanonicalStream', async () => {
        const res = makeFakeRes();
        const ctx = makeCtx({
            response: {
                stream: createCanonicalStream(sampleEvents('hi')),
                accountId: 'acct',
            },
            request: { model: 'm', stream: true },
            res,
        });

        await respondMiddleware()(ctx, async () => {});
        assert.equal(res.captured.headers['Content-Type'], 'text/event-stream');
    });

    it('stops writing when the client disconnects mid-stream', async () => {
        let produced = 0;
        async function* neverEnding() {
            yield {
                type: 'message_start',
                data: { id: 'n1', model: 'm', role: 'assistant' },
            };
            while (true) {
                produced++;
                yield {
                    type: 'text_delta',
                    data: { text: `chunk-${produced}` },
                };
                if (produced > 100) return; // safety cap
                // Yield microtask so the close event can interleave.
                await new Promise((r) => setImmediate(r));
            }
        }

        const res = makeFakeRes();
        const ctx = makeCtx({
            response: createCanonicalStream(neverEnding()),
            request: { model: 'm', stream: true },
            res,
        });

        // Simulate the client disconnecting after a few microticks.
        setTimeout(() => res._simulateClose(), 5);

        await respondMiddleware()(ctx, async () => {});

        // We should have stopped well before the 100-chunk safety cap.
        assert.ok(
            produced < 100,
            `expected early stop on client close, produced ${produced}`
        );
        assert.equal(ctx.metadata.aborted, true);
        assert.match(ctx.metadata.responseCapture.excerpt || '', /^chunk-/);
    });
});

// ── Full route chain: streaming end-to-end ────────────────────────────

describe('route chain: end-to-end streaming', () => {
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

    function makeAppCtx(backendModule) {
        const terminal = createBackendTerminal(backendModule);
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
                },
            },
            pool: null,
            log: noopLog(),
            services: {
                backendCatalog: {
                    getTerminal: (k) =>
                        k === backendModule.manifest.key ? terminal : null,
                    getBackend: (k) =>
                        k === backendModule.manifest.key ? backendModule : null,
                },
                providerMiddlewareRegistry: {
                    build: () => null,
                    get: () => null,
                },
                credentialManager: null,
                concurrencyController: null,
                extensionServices: Object.freeze({}),
            },
        };
    }

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
        strategyKind: 'direct',
    });

    function stubBackend(text = 'streamed body') {
        return {
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
                    accountId: 'acct-stream',
                    stream: sampleEvents(text),
                    abort: async () => {},
                };
            },
            classifyError(e) {
                return e;
            },
        };
    }

    async function runStreamingChain({
        routeKind = 'openai_chat',
        stream = true,
        text = 'hello stream',
    } = {}) {
        const backendModule = stubBackend(text);
        const snapshot = buildSnapshot(model);
        snapshot.models.set(model.modelKey, model);
        const appCtx = makeAppCtx(backendModule);
        appCtx.services.snapshot = snapshot;

        // Route kinds accept different request body shapes.  The
        // normalizers convert each into the canonical `{ model, messages, stream }`
        // shape internally; we produce the right on-the-wire body here.
        let body;
        if (routeKind === 'anthropic_messages') {
            body = {
                model: 'stub-model',
                messages: [{ role: 'user', content: 'hi' }],
                max_tokens: 128,
                stream,
            };
        } else if (routeKind === 'openai_responses') {
            body = {
                model: 'stub-model',
                input: 'hi',
                stream,
            };
        } else {
            body = {
                model: 'stub-model',
                messages: [{ role: 'user', content: 'hi' }],
                stream,
            };
        }

        const req = makeFakeReq(body);
        const res = makeFakeRes();

        const ctx = createKernelContext({
            requestId: 'test-req-1',
            route: { kind: routeKind, format: routeKind },
            services: appCtx.services,
            log: appCtx.log,
            appCtx,
            http: { req, res },
        });

        await buildRouteChain()(ctx);
        return { res, ctx };
    }

    it('openai_chat stream: true → SSE wire output with [DONE]', async () => {
        const { res } = await runStreamingChain({ routeKind: 'openai_chat' });
        assert.equal(res.captured.status, 200);
        assert.equal(res.captured.headers['Content-Type'], 'text/event-stream');
        const body = collectChunks(res);
        assert.ok(body.startsWith('data: '));
        assert.ok(body.endsWith('data: [DONE]\n\n'));
        assert.ok(/"role":"assistant"/.test(body));
        assert.ok(/"finish_reason":"stop"/.test(body));
    });

    it('anthropic_messages stream: true → Anthropic SSE frames', async () => {
        const { res } = await runStreamingChain({
            routeKind: 'anthropic_messages',
        });
        const body = collectChunks(res);
        assert.equal(res.captured.headers['Content-Type'], 'text/event-stream');
        assert.ok(body.includes('event: message_start'));
        assert.ok(body.includes('event: content_block_delta'));
        assert.ok(body.includes('event: message_stop'));
    });

    it('openai_responses stream: true → Responses SSE frames', async () => {
        const { res } = await runStreamingChain({
            routeKind: 'openai_responses',
        });
        const body = collectChunks(res);
        assert.equal(res.captured.headers['Content-Type'], 'text/event-stream');
        assert.ok(body.includes('event: response.created'));
        assert.ok(body.includes('event: response.output_text.delta'));
        assert.ok(body.includes('event: response.completed'));
    });

    it('openai_chat stream: false → buffered JSON body (no SSE)', async () => {
        const { res } = await runStreamingChain({
            routeKind: 'openai_chat',
            stream: false,
        });
        assert.equal(res.captured.status, 200);
        assert.equal(
            res.captured.headers[
                Object.keys(res.captured.headers).find(
                    (k) => k.toLowerCase() === 'content-type'
                )
            ] ||
                res.captured.headers['Content-Type'] ||
                res.captured.headers['content-type'],
            'application/json'
        );
        const body = JSON.parse(collectChunks(res));
        assert.equal(body.choices[0].message.content, 'hello stream');
        assert.equal(body.usage.total_tokens, 3);
    });
});
