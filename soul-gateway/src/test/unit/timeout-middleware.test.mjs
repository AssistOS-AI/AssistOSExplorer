/**
 * timeoutMiddleware tests, including the two deadlines of a leased stream:
 * the idle deadline that every event restarts and the content-gap deadline
 * that only content events restart, and the ceiling that keeps a very large
 * configured deadline from overflowing a timer and firing at once.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { compose, createKernelContext } from '../../runtime/kernel/index.mjs';
import { createCanonicalStream } from '../../runtime/kernel/canonical-stream.mjs';
import { timeoutMiddleware } from '../../runtime/execution/timeout-middleware.mjs';

const TEXT_EVENT = { type: 'text_delta', data: { text: 'hi' } };
const USAGE_EVENT = { type: 'usage', data: { promptTokens: 1 } };
const LIVENESS_EVENT = { type: 'activity', data: { kind: 'reasoning' } };
const OVERFLOWING_MS = 2 ** 31;

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function makeLeaseCtx(retryPolicy, requestTimeoutMs = 30_000) {
    return createKernelContext({
        requestId: 'req-lease-1',
        target: {
            model: { modelKey: 'm', providerKey: 'p', requestTimeoutMs, retryPolicy },
        },
        appCtx: { config: { env: {} } },
    });
}

// Run the middleware over a source that stops when the attempt signal
// aborts, the way a real upstream transport does.
async function lease(ctx, build) {
    let signal = null;
    await compose([
        timeoutMiddleware(),
        async (innerCtx) => {
            signal = innerCtx.signal;
            innerCtx.response = createCanonicalStream(build(innerCtx.signal), {});
        },
    ])(ctx);
    return signal;
}

async function drain(stream) {
    const events = [];
    for await (const event of stream) events.push(event);
    return events;
}

// One content event, then `filler` every `intervalMs` until the signal
// aborts or `forMs` has passed; optionally a closing content event.
function committedThen(filler, { intervalMs, forMs = Infinity, tail = [] }) {
    return async function* source(signal) {
        yield TEXT_EVENT;
        const started = Date.now();
        while (!signal.aborted && Date.now() - started < forMs) {
            await sleep(intervalMs);
            if (signal.aborted) return;
            yield filler;
        }
        for (const event of tail) yield event;
    };
}

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

describe('the content-gap deadline of a leased stream', () => {
    it('is not extended by non-content, non-liveness events', async () => {
        const ctx = makeLeaseCtx({
            streamIdleTimeoutMs: 300,
            firstContentTimeoutMs: 300,
        });
        const started = Date.now();
        // The filler stops on its own well after the deadline, so a
        // regression fails on the assertions instead of running forever.
        const signal = await lease(
            ctx,
            committedThen(USAGE_EVENT, { intervalMs: 60, forMs: 3_000 })
        );
        const events = await drain(ctx.response);
        const elapsed = Date.now() - started;

        assert.equal(signal.aborted, true, 'the stream was never aborted');
        assert.ok(elapsed >= 250 && elapsed < 900, `aborted after ${elapsed}ms`);
        assert.deepEqual(events[0], TEXT_EVENT);
        // The usage events themselves still reach the caller; they simply do
        // not buy the upstream more time.
        assert.ok(events.length > 1);
    });

    it('is extended by content events, so a long answer is served', async () => {
        const ctx = makeLeaseCtx({
            streamIdleTimeoutMs: 300,
            firstContentTimeoutMs: 300,
        });
        const started = Date.now();
        const signal = await lease(
            ctx,
            committedThen(TEXT_EVENT, { intervalMs: 100, forMs: 600 })
        );
        const events = await drain(ctx.response);
        const elapsed = Date.now() - started;

        assert.equal(signal.aborted, false, 'a steadily answering stream was cut');
        assert.ok(elapsed >= 550, `finished after only ${elapsed}ms`);
        assert.ok(events.length >= 6, `only ${events.length} events`);
        assert.ok(events.every((event) => event.type === 'text_delta'));
    });

    it('does not fire at once when the configured deadline overflows a timer', async () => {
        const ctx = makeLeaseCtx({
            streamIdleTimeoutMs: 1_000,
            firstContentTimeoutMs: OVERFLOWING_MS,
        });
        const started = Date.now();
        const signal = await lease(
            ctx,
            committedThen(LIVENESS_EVENT, {
                intervalMs: 60,
                forMs: 400,
                tail: [TEXT_EVENT],
            })
        );
        const events = await drain(ctx.response);
        const elapsed = Date.now() - started;

        assert.equal(signal.aborted, false, 'the stream was cut by an overflowed timer');
        assert.ok(elapsed >= 350, `finished after only ${elapsed}ms`);
        // Liveness is dropped by the lease; both content events survive.
        assert.deepEqual(events, [TEXT_EVENT, TEXT_EVENT]);
    });

    it('does not fire at once when the attempt deadline overflows a timer', async () => {
        const ctx = makeLeaseCtx({}, OVERFLOWING_MS);
        let signal = null;
        await compose([
            timeoutMiddleware(),
            async (innerCtx) => {
                signal = innerCtx.signal;
                await sleep(200);
            },
        ])(ctx);
        assert.equal(signal.aborted, false);
    });
});
