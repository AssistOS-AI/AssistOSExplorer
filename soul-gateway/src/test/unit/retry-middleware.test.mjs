/**
 * retryMiddleware tests.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { compose, createKernelContext } from '../../runtime/kernel/index.mjs';
import { retryMiddleware } from '../../runtime/execution/retry-middleware.mjs';

function makeCtx({ maxAttempts = 3 } = {}) {
    return createKernelContext({
        requestId: 'req-retry-1',
        request: { model: 'm', messages: [{ role: 'user', content: 'hi' }] },
        target: {
            model: {
                modelKey: 'm',
                retryPolicy: {
                    maxAttempts,
                    baseDelayMs: 1,
                    multiplier: 1,
                    maxDelayMs: 1,
                    jitterPct: 0,
                },
            },
        },
        appCtx: {
            config: {
                env: {
                    HTTP_RETRY_MAX_ATTEMPTS: 3,
                    HTTP_RETRY_BASE_DELAY_MS: 1,
                    HTTP_RETRY_MULTIPLIER: 1,
                    HTTP_RETRY_MAX_DELAY_MS: 1,
                    HTTP_RETRY_JITTER_PCT: 0,
                },
            },
            services: {},
        },
    });
}

function attempting(fn) {
    return [
        async (ctx) => {
            await fn(ctx);
        },
    ];
}

describe('retryMiddleware', () => {
    it('runs the attempt chain once on success and copies response to parent', async () => {
        let attempts = 0;
        const ctx = makeCtx();
        const middleware = retryMiddleware({
            attemptChain: attempting(async (innerCtx) => {
                attempts++;
                innerCtx.response = { ok: true };
            }),
        });
        await compose([middleware, async () => {}])(ctx);
        assert.equal(attempts, 1);
        assert.deepEqual(ctx.response, { ok: true });
        assert.deepEqual(ctx.metadata.retryTrace, []);
    });

    it('retries on retryable errors and returns the first successful attempt', async () => {
        let attempts = 0;
        const ctx = makeCtx();
        const middleware = retryMiddleware({
            attemptChain: attempting(async (innerCtx) => {
                attempts++;
                if (attempts < 3) {
                    const err = new Error('try again');
                    err.retryable = true;
                    err.errorType = 'provider_timeout';
                    throw err;
                }
                innerCtx.response = { ok: true, attempt: attempts };
            }),
        });
        await compose([middleware, async () => {}])(ctx);
        assert.equal(attempts, 3);
        assert.equal(ctx.response.attempt, 3);
        assert.equal(ctx.metadata.retryTrace.length, 2);
    });

    it('does not retry non-retryable errors', async () => {
        let attempts = 0;
        const ctx = makeCtx();
        const middleware = retryMiddleware({
            attemptChain: attempting(async () => {
                attempts++;
                const err = new Error('fatal');
                err.retryable = false;
                throw err;
            }),
        });
        await assert.rejects(
            compose([middleware, async () => {}])(ctx),
            /fatal/
        );
        assert.equal(attempts, 1);
    });

    it('isolates request mutations across attempts (forked context)', async () => {
        let attempts = 0;
        const ctx = makeCtx();
        const middleware = retryMiddleware({
            attemptChain: [
                async (innerCtx, next) => {
                    // Simulate an attempt-level mutation that should NOT
                    // leak across retries.
                    innerCtx.request = { ...innerCtx.request, mutated: true };
                    await next();
                },
                async (innerCtx) => {
                    attempts++;
                    if (attempts < 2) {
                        const err = new Error('retry');
                        err.retryable = true;
                        throw err;
                    }
                    innerCtx.response = { ok: true };
                },
            ],
        });
        await compose([middleware, async () => {}])(ctx);
        // Parent ctx.request was not mutated by the per-attempt fork.
        assert.equal(ctx.request.mutated, undefined);
    });

    it('records the transport account id from the successful attempt', async () => {
        const ctx = makeCtx();
        const middleware = retryMiddleware({
            attemptChain: attempting(async (innerCtx) => {
                innerCtx.metadata.transportAccountId = 'acct-99';
                innerCtx.response = { ok: true };
            }),
        });
        await compose([middleware, async () => {}])(ctx);
        assert.equal(ctx.metadata.transportAccountId, 'acct-99');
    });

    it('rejects misuse without an attemptChain array', () => {
        assert.throws(
            () => retryMiddleware({}),
            /attemptChain \(Array\) is required/
        );
    });
});
