/**
 * Kernel unit tests.
 *
 * Covers compose semantics, abort signals, the canonical stream helpers,
 * and the unified context factory.  These are pure unit
 * tests — they exercise the kernel modules in isolation, without touching
 * the rest of the runtime.
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import {
    compose,
    createKernelContext,
    forkKernelContext,
    abortSuccess,
    abortError,
    createAbortApi,
    isKernelAbortSignal,
    createCanonicalStream,
    isCanonicalStream,
    tapStream,
    mapStream,
} from '../../runtime/kernel/index.mjs';
import { MiddlewareAbortError, GatewayError } from '../../core/errors.mjs';

// ── Helpers ─────────────────────────────────────────────────────────────

function makeCtx(overrides = {}) {
    return createKernelContext({
        requestId: overrides.requestId ?? 'test-req-1',
        request: overrides.request ?? { model: 'test', messages: [] },
        log: overrides.log ?? collectingLog(),
        services: overrides.services,
        snapshot: overrides.snapshot,
    });
}

function collectingLog() {
    const log = {
        debug: [],
        info: [],
        warn: [],
        error: [],
        fatal: [],
    };
    return {
        debug: (...args) => log.debug.push(args),
        info: (...args) => log.info.push(args),
        warn: (...args) => log.warn.push(args),
        error: (...args) => log.error.push(args),
        fatal: (...args) => log.fatal.push(args),
        _log: log,
    };
}

// ── compose: ordering ──────────────────────────────────────────────────

describe('compose: middleware ordering', () => {
    it('executes pre/post in koa-style around order', async () => {
        const trace = [];
        const dispatch = compose([
            async (_ctx, next) => {
                trace.push('a:pre');
                await next();
                trace.push('a:post');
            },
            async (_ctx, next) => {
                trace.push('b:pre');
                await next();
                trace.push('b:post');
            },
            async (_ctx, next) => {
                trace.push('c:pre');
                await next();
                trace.push('c:post');
            },
        ]);

        await dispatch(makeCtx());
        assert.deepEqual(trace, [
            'a:pre',
            'b:pre',
            'c:pre',
            'c:post',
            'b:post',
            'a:post',
        ]);
    });

    it('terminal middleware does not need to call next()', async () => {
        const trace = [];
        const dispatch = compose([
            async (_ctx, next) => {
                trace.push('outer:pre');
                await next();
                trace.push('outer:post');
            },
            async (ctx) => {
                trace.push('terminal');
                ctx.response = { ok: true };
            },
        ]);

        const ctx = makeCtx();
        await dispatch(ctx);
        assert.deepEqual(trace, ['outer:pre', 'terminal', 'outer:post']);
        assert.deepEqual(ctx.response, { ok: true });
    });

    it('handles an empty middleware chain', async () => {
        const dispatch = compose([]);
        const ctx = makeCtx();
        await dispatch(ctx);
        assert.equal(ctx.response, null);
    });

    it('handles a single middleware', async () => {
        const dispatch = compose([
            async (ctx) => {
                ctx.response = { single: true };
            },
        ]);
        const ctx = makeCtx();
        await dispatch(ctx);
        assert.deepEqual(ctx.response, { single: true });
    });
});

// ── compose: short-circuit ─────────────────────────────────────────────

describe('compose: short-circuit', () => {
    it('skips downstream when a middleware does not call next()', async () => {
        const trace = [];
        const dispatch = compose([
            async (_ctx, next) => {
                trace.push('a:pre');
                await next();
                trace.push('a:post');
            },
            async (ctx /* no next */) => {
                trace.push('b:short');
                ctx.response = { cached: true };
            },
            async (_ctx, next) => {
                trace.push('c:pre');
                await next();
                trace.push('c:post');
            },
        ]);

        const ctx = makeCtx();
        await dispatch(ctx);
        assert.deepEqual(trace, ['a:pre', 'b:short', 'a:post']);
        assert.deepEqual(ctx.response, { cached: true });
    });

    it('an inner middleware that throws lets outer post-hooks observe the error', async () => {
        const observed = [];
        const dispatch = compose([
            async (_ctx, next) => {
                try {
                    await next();
                } catch (err) {
                    observed.push(err.message);
                    throw err;
                }
            },
            async () => {
                throw new Error('boom');
            },
        ]);

        await assert.rejects(() => dispatch(makeCtx()), /boom/);
        assert.deepEqual(observed, ['boom']);
    });
});

// ── compose: error propagation ──────────────────────────────────────────

describe('compose: error propagation', () => {
    it('rejects when a middleware throws (no swallowing)', async () => {
        const dispatch = compose([
            async () => {
                throw new Error('crash');
            },
        ]);
        await assert.rejects(() => dispatch(makeCtx()), /crash/);
    });

    it('propagates a GatewayError as-is', async () => {
        const dispatch = compose([
            async () => {
                throw new MiddlewareAbortError('test', 429, 'rate limited');
            },
        ]);
        await assert.rejects(
            () => dispatch(makeCtx()),
            (err) => {
                assert.ok(err instanceof MiddlewareAbortError);
                assert.equal(err.httpStatus, 429);
                return true;
            }
        );
    });

    it('refuses to call next() twice in the same middleware', async () => {
        const dispatch = compose([
            async (_ctx, next) => {
                await next();
                await next();
            },
            async () => {},
        ]);
        await assert.rejects(
            () => dispatch(makeCtx()),
            /next\(\) called multiple times/
        );
    });
});

// ── compose: abort signals ─────────────────────────────────────────────

describe('compose: abort signals', () => {
    it('abortSuccess sets ctx.response and short-circuits silently', async () => {
        const trace = [];
        const dispatch = compose([
            async (_ctx, next) => {
                trace.push('a:pre');
                await next();
                trace.push('a:post');
            },
            async (ctx) => {
                trace.push('b:abort');
                abortSuccess(ctx, { synthetic: true });
                trace.push('b:after-abort'); // unreachable
            },
            async (_ctx, next) => {
                trace.push('c:never');
                await next();
            },
        ]);

        const ctx = makeCtx();
        await dispatch(ctx);

        assert.deepEqual(trace, ['a:pre', 'b:abort', 'a:post']);
        assert.deepEqual(ctx.response, { synthetic: true });
    });

    it('abortError propagates as MiddlewareAbortError', async () => {
        const dispatch = compose([
            async () => abortError('test-mw', 503, 'unavailable'),
        ]);
        await assert.rejects(
            () => dispatch(makeCtx()),
            (err) => {
                assert.ok(err instanceof MiddlewareAbortError);
                assert.equal(err.httpStatus, 503);
                assert.equal(err.detail.middleware, 'test-mw');
                return true;
            }
        );
    });

    it('isKernelAbortSignal recognises the internal flow-control marker', () => {
        let captured = null;
        try {
            abortSuccess({ requestId: 'x' }, { ok: true });
        } catch (err) {
            captured = err;
        }
        assert.ok(captured);
        assert.equal(isKernelAbortSignal(captured), true);
        assert.equal(isKernelAbortSignal(new Error('boom')), false);
        assert.equal(isKernelAbortSignal(null), false);
    });

    it('createAbortApi binds the middleware name to abort.error', async () => {
        const abort = createAbortApi('budget-enforcer');
        assert.throws(
            () => abort.error(429, 'too rich'),
            (err) =>
                err instanceof MiddlewareAbortError &&
                err.detail.middleware === 'budget-enforcer'
        );
    });
});

// ── createKernelContext ────────────────────────────────────────────────

describe('createKernelContext', () => {
    it('requires a requestId', () => {
        assert.throws(() => createKernelContext({}), /requestId is required/);
    });

    it('populates safe defaults for unspecified fields', () => {
        const ctx = createKernelContext({ requestId: 'r-1' });
        assert.equal(ctx.requestId, 'r-1');
        assert.equal(ctx.request, null);
        assert.equal(ctx.response, null);
        assert.equal(ctx.identity, null);
        assert.equal(ctx.auth, null);
        assert.equal(ctx.target, null);
        assert.deepEqual(ctx.attempt, { index: 0, previousErrors: [] });
        assert.ok(ctx.state instanceof Map);
        assert.deepEqual(ctx.metadata, {});
        assert.equal(ctx.invokeModel, null);
        assert.ok(typeof ctx.abort.success === 'function');
        assert.ok(typeof ctx.abort.error === 'function');
    });

    it('forkKernelContext inherits parent identifiers but resets state', () => {
        const parent = createKernelContext({
            requestId: 'r-1',
            route: { kind: 'openai_chat' },
            auth: { keyId: 'k-1' },
        });
        parent.state.set('foo', 'bar');
        parent.attempt = { index: 3, previousErrors: ['x'] };

        const child = forkKernelContext(parent, {
            request: { model: 'fallback' },
        });
        assert.equal(child.requestId, 'r-1');
        assert.deepEqual(child.route, { kind: 'openai_chat' });
        assert.deepEqual(child.auth, { keyId: 'k-1' });
        assert.equal(child.state.size, 0);
        assert.deepEqual(child.attempt, { index: 0, previousErrors: [] });
        assert.equal(child.request.model, 'fallback');
    });
});

// ── canonical stream helpers ───────────────────────────────────────────

describe('canonicalStream', () => {
    async function* sample() {
        yield { type: 'message_start', data: { id: 'm1' } };
        yield { type: 'text_delta', data: { text: 'Hello' } };
        yield { type: 'text_delta', data: { text: ' world' } };
        yield {
            type: 'usage',
            data: { input_tokens: 1, output_tokens: 2, total_tokens: 3 },
        };
        yield { type: 'done', data: { finish_reason: 'stop' } };
    }

    it('createCanonicalStream wraps an async iterable and exposes meta', async () => {
        const stream = createCanonicalStream(sample(), { model: 'gpt-test' });
        assert.equal(isCanonicalStream(stream), true);
        assert.deepEqual(stream.meta, { model: 'gpt-test' });

        const events = [];
        for await (const event of stream) events.push(event.type);
        assert.deepEqual(events, [
            'message_start',
            'text_delta',
            'text_delta',
            'usage',
            'done',
        ]);
    });

    it('isCanonicalStream returns false for plain iterables', async () => {
        assert.equal(isCanonicalStream(sample()), false);
        assert.equal(isCanonicalStream(null), false);
        assert.equal(isCanonicalStream({}), false);
    });

    it('createCanonicalStream rejects non-iterables', () => {
        assert.throws(() => createCanonicalStream({}), /async iterable/);
    });

    it('tapStream observes events without altering them', async () => {
        const tapped = [];
        const events = [];
        for await (const event of tapStream(sample(), (e) => {
            tapped.push(e.type);
        })) {
            events.push(event.type);
        }
        assert.deepEqual(events, tapped);
    });

    it('mapStream rewrites events and can drop them', async () => {
        const out = [];
        const transform = (event) => {
            if (event.type === 'text_delta')
                return {
                    type: 'text_delta',
                    data: { text: event.data.text.toUpperCase() },
                };
            if (event.type === 'usage') return null;
            return event;
        };
        for await (const event of mapStream(sample(), transform))
            out.push(event);
        assert.deepEqual(
            out.map((e) => e.type),
            ['message_start', 'text_delta', 'text_delta', 'done']
        );
        assert.equal(out[1].data.text, 'HELLO');
        assert.equal(out[2].data.text, ' WORLD');
    });

    it('a stream-wrapping middleware can replace ctx.response.stream', async () => {
        const events = [];

        const dispatch = compose([
            async (ctx, next) => {
                await next();
                const original = ctx.response.stream;
                ctx.response.stream = mapStream(original, (e) => {
                    if (e.type === 'text_delta')
                        return {
                            type: 'text_delta',
                            data: { text: `[wrapped]${e.data.text}` },
                        };
                    return e;
                });
            },
            async (ctx) => {
                ctx.response = { stream: createCanonicalStream(sample()) };
            },
        ]);

        const ctx = makeCtx();
        await dispatch(ctx);

        for await (const event of ctx.response.stream) events.push(event);

        const texts = events
            .filter((e) => e.type === 'text_delta')
            .map((e) => e.data.text);
        assert.deepEqual(texts, ['[wrapped]Hello', '[wrapped] world']);
    });
});

// ── integration: ordering with abort + post-only middleware ────────────

describe('compose integration', () => {
    it('post-only middlewares observe a synthetic response from a downstream abort', async () => {
        const observed = [];
        const dispatch = compose([
            // Outer logger: only does post work
            async (ctx, next) => {
                await next();
                observed.push({ stage: 'logger', response: ctx.response });
            },
            // Cache: aborts on hit
            async (ctx) => {
                abortSuccess(ctx, { cache: 'hit' });
            },
            // Terminal that should never run
            async (ctx) => {
                ctx.response = { dispatched: true };
            },
        ]);

        const ctx = makeCtx();
        await dispatch(ctx);

        assert.deepEqual(ctx.response, { cache: 'hit' });
        assert.equal(observed.length, 1);
        assert.deepEqual(observed[0].response, { cache: 'hit' });
    });

    it('errors thrown after the inner short-circuit unwind through outer post-handlers', async () => {
        const observed = [];
        const dispatch = compose([
            async (ctx, next) => {
                try {
                    await next();
                    observed.push('logger:ok');
                } catch (err) {
                    observed.push(`logger:err:${err.message}`);
                    throw err;
                }
            },
            async () => {
                throw new MiddlewareAbortError('inner', 429, 'limit');
            },
        ]);

        await assert.rejects(() => dispatch(makeCtx()), MiddlewareAbortError);
        assert.deepEqual(observed, ['logger:err:limit']);
    });
});

// ── compose with non-Error class throw ─────────────────────────────────

describe('compose: non-Error throws', () => {
    it('still propagates string throws as-is', async () => {
        const dispatch = compose([
            async () => {
                throw 'string-error';
            }, // eslint-disable-line no-throw-literal
        ]);
        await assert.rejects(
            () =>
                dispatch(makeCtx()).catch((e) => {
                    throw new Error(String(e));
                }),
            /string-error/
        );
    });

    it('GatewayError without abort marker is treated as a real error', async () => {
        class TestError extends GatewayError {
            constructor() {
                super('boom', { httpStatus: 500, errorType: 'test_error' });
            }
        }
        const dispatch = compose([
            async () => {
                throw new TestError();
            },
        ]);
        await assert.rejects(() => dispatch(makeCtx()), TestError);
    });
});
