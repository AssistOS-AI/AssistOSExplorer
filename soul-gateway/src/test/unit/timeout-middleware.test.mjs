/**
 * timeoutMiddleware tests.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { compose, createKernelContext } from '../../runtime/kernel/index.mjs';
import { timeoutMiddleware } from '../../runtime/execution/timeout-middleware.mjs';

function makeCtx({ requestTimeoutMs = 50 } = {}) {
    return createKernelContext({
        requestId: 'req-to-1',
        target: {
            model: {
                modelKey: 'm',
                providerKey: 'p',
                requestTimeoutMs,
            },
        },
        appCtx: { config: { env: { DEFAULT_REQUEST_TIMEOUT_MS: 60000 } } },
    });
}

describe('timeoutMiddleware', () => {
    it('installs ctx.signal for the duration of the downstream chain', async () => {
        const ctx = makeCtx({ requestTimeoutMs: 1000 });
        let seenSignal = null;
        await compose([
            timeoutMiddleware(),
            async (innerCtx) => {
                seenSignal = innerCtx.signal;
                assert.ok(seenSignal);
                assert.equal(seenSignal.aborted, false);
            },
        ])(ctx);
        // After unwinding, the previous (null) signal is restored.
        assert.equal(ctx.signal, null);
    });

    it('aborts the signal when the timeout fires', async () => {
        const ctx = makeCtx({ requestTimeoutMs: 20 });
        let seenSignal = null;
        await compose([
            timeoutMiddleware(),
            async (innerCtx) => {
                seenSignal = innerCtx.signal;
                await new Promise((resolve) => setTimeout(resolve, 60));
            },
        ])(ctx);
        assert.ok(seenSignal.aborted);
    });

    it('clears the timer even if the downstream chain throws', async () => {
        const ctx = makeCtx({ requestTimeoutMs: 1000 });
        await assert.rejects(
            compose([
                timeoutMiddleware(),
                async () => {
                    throw new Error('boom');
                },
            ])(ctx),
            /boom/
        );
        // The middleware swapped ctx.signal back to null, proving the
        // timeout signal does not leak across requests.
        assert.equal(ctx.signal, null);
    });

    it('throws when ctx.target.model is missing', async () => {
        const ctx = createKernelContext({
            requestId: 'r',
            appCtx: { config: { env: {} } },
        });
        await assert.rejects(
            compose([timeoutMiddleware(), async () => {}])(ctx),
            /ctx\.target\.model is required/
        );
    });
});
