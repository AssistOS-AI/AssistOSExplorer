/**
 * Kernel streaming primitives tests.
 *
 * Covers Phase 3 deliverables:
 *
 *   - bufferCanonicalStream: drains a CanonicalStream into the legacy
 *     buffered shape (compatible with serializeBufferedResponse / today's
 *     reqCtx.completion).
 *
 *   - bufferingMiddleware: a kernel middleware that materializes
 *     ctx.response when it is (or contains) a CanonicalStream, so post-only
 *     middlewares like response-cache, token-tracker, response-filter and
 *     request-logger keep working under streaming flows.
 *
 *   - wrappingStreamMiddleware: a kernel middleware that intercepts the
 *     canonical event stream produced by a downstream transport and
 *     replaces it with a wrapped iterable.  Multiple wrappers stack
 *     correctly (last bound runs outermost — same as gateway middleware).
 *
 *   - End-to-end: stream-wrap → buffer → gateway middleware
 *     observes the wrapped, buffered text content.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
    compose,
    createKernelContext,
    createCanonicalStream,
    isCanonicalStream,
    bufferCanonicalStream,
    bufferingMiddleware,
    wrappingStreamMiddleware,
} from '../../runtime/kernel/index.mjs';
import * as responseFilter from '../../runtime/middleware/builtin/response-filter.mjs';
import * as responseCache from '../../runtime/middleware/builtin/response-cache.mjs';
import { mergeMiddlewareSettings } from '../../runtime/middleware/settings-merge.mjs';

// ── helpers ────────────────────────────────────────────────────────────

function makeCtx() {
    return createKernelContext({
        requestId: 'req-stream-1',
        request: {
            model: 'gpt-test',
            messages: [{ role: 'user', content: 'hi' }],
        },
        auth: {
            keyId: 'k',
            label: 'k',
            rpmLimit: 60,
            tpmLimit: 100_000,
            apiKeyRecord: {},
        },
        session: {
            id: null,
            key: 'k',
            explicitId: null,
            agentName: null,
            soulId: null,
        },
        log: { debug() {}, info() {}, warn() {}, error() {}, fatal() {} },
        appCtx: { config: { env: {} }, pool: null, services: {} },
    });
}

async function* sampleEvents(text = 'Hello world') {
    yield {
        type: 'message_start',
        data: { id: 'm1', model: 'gpt-test', role: 'assistant' },
    };
    // Split the text into half so we get 2 deltas
    const half = Math.floor(text.length / 2);
    yield { type: 'text_delta', data: { text: text.slice(0, half) } };
    yield { type: 'text_delta', data: { text: text.slice(half) } };
    yield {
        type: 'usage',
        data: { input_tokens: 5, output_tokens: 4, total_tokens: 9 },
    };
    yield { type: 'done', data: { finish_reason: 'stop', model: 'gpt-test' } };
}

function chatCompletionFromBuffered(buffered) {
    // Mirror executeProviderDispatch shape so legacy hooks see what they
    // would see in production: { id, object, model, choices, usage }.
    return {
        id: 'req-stream-1',
        object: 'chat.completion',
        model: 'gpt-test',
        choices: [
            {
                index: 0,
                message: buffered.message,
                finish_reason: buffered.finishReason || 'stop',
            },
        ],
        usage: {
            prompt_tokens: buffered.usage.input_tokens,
            completion_tokens: buffered.usage.output_tokens,
            total_tokens: buffered.usage.total_tokens,
        },
    };
}

// ── bufferCanonicalStream ──────────────────────────────────────────────

describe('bufferCanonicalStream', () => {
    it('drains a CanonicalStream into the buffered shape', async () => {
        const stream = createCanonicalStream(sampleEvents('Hello stream'));
        const buffered = await bufferCanonicalStream(stream);

        assert.equal(buffered.message.role, 'assistant');
        assert.equal(buffered.message.content, 'Hello stream');
        assert.equal(buffered.finishReason, 'stop');
        assert.equal(buffered.usage.total_tokens, 9);
        assert.equal(buffered.toolCalls.length, 0);
    });

    it('rejects a non-iterable input', () => {
        assert.throws(() => bufferCanonicalStream(null), /async iterable/);
        assert.throws(() => bufferCanonicalStream({}), /async iterable/);
    });

    it('handles a stream with tool calls', async () => {
        async function* withToolCalls() {
            yield {
                type: 'message_start',
                data: { id: 't1', model: 'gpt', role: 'assistant' },
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
            yield {
                type: 'usage',
                data: { input_tokens: 1, output_tokens: 2, total_tokens: 3 },
            };
            yield { type: 'done', data: { finish_reason: 'tool_calls' } };
        }
        const buffered = await bufferCanonicalStream(
            createCanonicalStream(withToolCalls())
        );
        assert.equal(buffered.toolCalls.length, 1);
        assert.equal(buffered.toolCalls[0].function.name, 'search');
        assert.equal(buffered.toolCalls[0].function.arguments, '{"q":"hello"}');
    });
});

// ── bufferingMiddleware ────────────────────────────────────────────────

describe('bufferingMiddleware', () => {
    it('drains a CanonicalStream set as ctx.response into a buffered completion', async () => {
        const dispatch = compose([
            bufferingMiddleware(),
            // Terminal: produce a streaming response
            async (ctx) => {
                ctx.response = createCanonicalStream(
                    sampleEvents('streamed body')
                );
            },
        ]);

        const ctx = makeCtx();
        await dispatch(ctx);

        assert.equal(isCanonicalStream(ctx.response), false);
        assert.equal(ctx.response.message.content, 'streamed body');
        assert.equal(ctx.response.usage.total_tokens, 9);
    });

    it('drains a stream nested under ctx.response.stream and preserves envelope', async () => {
        const dispatch = compose([
            bufferingMiddleware(),
            async (ctx) => {
                ctx.response = {
                    accountId: 'acct-99',
                    stream: createCanonicalStream(sampleEvents('hello')),
                };
            },
        ]);

        const ctx = makeCtx();
        await dispatch(ctx);

        assert.equal(ctx.response.accountId, 'acct-99');
        assert.equal(ctx.response.stream, null);
        assert.equal(ctx.response.message.content, 'hello');
        assert.equal(ctx.response.usage.total_tokens, 9);
    });

    it('is a no-op when ctx.response is already buffered', async () => {
        const buffered = {
            message: { role: 'assistant', content: 'pre-buffered' },
            usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
            toolCalls: [],
        };
        const dispatch = compose([
            bufferingMiddleware(),
            async (ctx) => {
                ctx.response = buffered;
            },
        ]);

        const ctx = makeCtx();
        await dispatch(ctx);
        assert.equal(ctx.response, buffered); // same reference, untouched
    });

    it('is a no-op when ctx.response is null', async () => {
        const dispatch = compose([
            bufferingMiddleware(),
            async () => {
                /* terminal does nothing */
            },
        ]);
        const ctx = makeCtx();
        await dispatch(ctx);
        assert.equal(ctx.response, null);
    });
});

// ── wrappingStreamMiddleware ───────────────────────────────────────────

describe('wrappingStreamMiddleware', () => {
    it('replaces ctx.response with a wrapped CanonicalStream', async () => {
        const wrap = wrappingStreamMiddleware(async function* upper(stream) {
            for await (const ev of stream) {
                if (ev.type === 'text_delta') {
                    yield {
                        type: 'text_delta',
                        data: { text: ev.data.text.toUpperCase() },
                    };
                } else {
                    yield ev;
                }
            }
        });

        const dispatch = compose([
            wrap,
            async (ctx) => {
                ctx.response = createCanonicalStream(
                    sampleEvents('hello world')
                );
            },
        ]);

        const ctx = makeCtx();
        await dispatch(ctx);

        const events = [];
        for await (const ev of ctx.response) events.push(ev);
        const texts = events
            .filter((e) => e.type === 'text_delta')
            .map((e) => e.data.text);
        // 'hello world'.length === 11, half=5 → 'hello' + ' world' → 'HELLO' + ' WORLD'
        assert.deepEqual(texts, ['HELLO', ' WORLD']);
    });

    it('wraps a stream nested under ctx.response.stream', async () => {
        const wrap = wrappingStreamMiddleware(async function* tag(stream) {
            for await (const ev of stream) {
                if (ev.type === 'text_delta') {
                    yield {
                        type: 'text_delta',
                        data: { text: `[${ev.data.text}]` },
                    };
                } else yield ev;
            }
        });

        const dispatch = compose([
            wrap,
            async (ctx) => {
                ctx.response = {
                    accountId: 'acct',
                    stream: createCanonicalStream(sampleEvents('xy')),
                };
            },
        ]);

        const ctx = makeCtx();
        await dispatch(ctx);

        assert.equal(ctx.response.accountId, 'acct');
        const events = [];
        for await (const ev of ctx.response.stream) events.push(ev);
        const texts = events
            .filter((e) => e.type === 'text_delta')
            .map((e) => e.data.text);
        assert.deepEqual(texts, ['[x]', '[y]']);
    });

    it('multiple wrappers stack: outermost binding runs last on the events', async () => {
        const upper = wrappingStreamMiddleware(async function* (stream) {
            for await (const ev of stream) {
                if (ev.type === 'text_delta')
                    yield {
                        type: 'text_delta',
                        data: { text: ev.data.text.toUpperCase() },
                    };
                else yield ev;
            }
        });
        const tag = wrappingStreamMiddleware(async function* (stream) {
            for await (const ev of stream) {
                if (ev.type === 'text_delta')
                    yield {
                        type: 'text_delta',
                        data: { text: `[${ev.data.text}]` },
                    };
                else yield ev;
            }
        });

        // Compose order: outerWrapper, innerWrapper, terminal
        // Around-style: terminal sets stream, innerWrapper wraps it (UPPER),
        // then outerWrapper wraps that (adds [...]).
        const dispatch = compose([
            tag, // outermost — runs after upper
            upper, // inner — runs first on raw stream
            async (ctx) => {
                ctx.response = createCanonicalStream(sampleEvents('abcd'));
            },
        ]);

        const ctx = makeCtx();
        await dispatch(ctx);

        const events = [];
        for await (const ev of ctx.response) events.push(ev);
        const texts = events
            .filter((e) => e.type === 'text_delta')
            .map((e) => e.data.text);
        // Stream → upper → tag : 'ab','cd' → 'AB','CD' → '[AB]','[CD]'
        assert.deepEqual(texts, ['[AB]', '[CD]']);
    });

    it('rejects a non-function wrap', () => {
        assert.throws(
            () => wrappingStreamMiddleware(null),
            /must be a function/
        );
    });
});

// ── end-to-end: stream-wrap + buffer + gateway middleware ───────────────

describe('streaming + buffering + gateway middleware', () => {
    it('response-filter sees the wrapped+buffered content', async () => {
        // 1. Wrap the stream so any 'world' becomes 'WORLD'
        const upper = wrappingStreamMiddleware(async function* (stream) {
            for await (const ev of stream) {
                if (
                    ev.type === 'text_delta' &&
                    ev.data.text.includes('world')
                ) {
                    yield {
                        type: 'text_delta',
                        data: { text: ev.data.text.replace('world', 'WORLD') },
                    };
                } else yield ev;
            }
        });

        // 2. Buffer the stream so post-response middleware can read ctx.response
        const buffer = bufferingMiddleware();

        const filter = responseFilter.factory(
            mergeMiddlewareSettings(responseFilter.meta.defaultSettings, {
                patterns: [{ find: 'WORLD', replace: '[REDACTED]', flags: 'g' }],
            })
        );

        const dispatch = compose([
            filter,
            buffer,
            upper,
            async (ctx) => {
                const stream = createCanonicalStream(
                    sampleEvents('Hello world')
                );
                ctx.response = stream;
            },
        ]);

        const ctx = makeCtx();
        await dispatch(ctx);

        assert.equal(ctx.response.message.content, 'Hello WORLD');
    });

    it('end-to-end with chat-completion envelope: filter redacts after stream wrap', async () => {
        const envelopeAdapter = async (ctx, next) => {
            await next();
            if (ctx.response && ctx.response.message && !ctx.response.choices) {
                ctx.response = chatCompletionFromBuffered(ctx.response);
            }
        };

        const upper = wrappingStreamMiddleware(async function* (stream) {
            for await (const ev of stream) {
                if (ev.type === 'text_delta') {
                    yield {
                        type: 'text_delta',
                        data: { text: ev.data.text.toUpperCase() },
                    };
                } else yield ev;
            }
        });

        const filter = responseFilter.factory(
            mergeMiddlewareSettings(responseFilter.meta.defaultSettings, {
                patterns: [
                    { find: 'BANNED', replace: '[REDACTED]', flags: 'g' },
                ],
            })
        );

        const dispatch = compose([
            filter,
            envelopeAdapter,
            bufferingMiddleware(),
            upper,
            async (ctx) => {
                ctx.response = createCanonicalStream(
                    sampleEvents('say BANNED words')
                );
            },
        ]);

        const ctx = makeCtx();
        await dispatch(ctx);

        assert.equal(
            ctx.response.choices[0].message.content,
            'SAY [REDACTED] WORDS'
        );
    });

    it('response-cache hits replay against the same buffered envelope', async () => {
        responseCache._resetCache();

        const cache = responseCache.factory(
            mergeMiddlewareSettings(responseCache.meta.defaultSettings, {
                ttlMs: 60_000,
            })
        );

        const envelopeAdapter = async (ctx, next) => {
            await next();
            if (ctx.response && ctx.response.message && !ctx.response.choices) {
                ctx.response = chatCompletionFromBuffered(ctx.response);
            }
        };

        let dispatchCount = 0;
        const dispatch = compose([
            cache,
            envelopeAdapter,
            bufferingMiddleware(),
            async (ctx) => {
                dispatchCount++;
                ctx.response = createCanonicalStream(
                    sampleEvents(`gen-${dispatchCount}`)
                );
            },
        ]);

        const ctx1 = makeCtx();
        await dispatch(ctx1);
        assert.equal(ctx1.response.choices[0].message.content, 'gen-1');

        const ctx2 = makeCtx();
        await dispatch(ctx2);
        assert.equal(
            dispatchCount,
            1,
            'cache should have absorbed the second call'
        );
        assert.equal(ctx2.response.choices[0].message.content, 'gen-1');
    });
});
