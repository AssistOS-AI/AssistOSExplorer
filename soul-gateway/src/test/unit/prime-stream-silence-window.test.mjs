/**
 * The pre-commit silence window (`firstEventTimeoutMs`) restarts on upstream
 * liveness only. Any other event a backend may emit before the first content
 * event — a usage report, for example — must not extend it, or a trickle of
 * such events would keep a silent model alive indefinitely. The first-content
 * cap stays absolute: liveness cannot push it back either.
 *
 * The middleware is driven directly with real canonical streams, because the
 * OpenAI-compatible transport emits its usage event only inside the terminal
 * `done` chunk and so cannot produce this sequence.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { compose, createKernelContext } from '../../runtime/kernel/index.mjs';
import { createCanonicalStream } from '../../runtime/kernel/canonical-stream.mjs';
import { primeStreamMiddleware } from '../../runtime/execution/prime-stream-middleware.mjs';
import { ProviderTimeoutError } from '../../core/errors.mjs';

const TICK_MS = 50;
const SILENCE_MS = 200;
const CONTENT_MS = 600;

const USAGE_EVENT = { type: 'usage', data: { promptTokens: 1, completionTokens: 0 } };
const LIVENESS_EVENT = { type: 'activity', data: { kind: 'reasoning' } };
const TEXT_EVENT = { type: 'text_delta', data: { text: 'answer' } };

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

async function* trickle(event, { forMs, tail = [] }) {
    const started = Date.now();
    while (Date.now() - started < forMs) {
        await sleep(TICK_MS);
        yield event;
    }
    for (const value of tail) yield value;
}

function makeCtx(retryPolicy) {
    return createKernelContext({
        requestId: 'req-prime-1',
        target: {
            model: {
                modelKey: 'm',
                providerKey: 'p',
                requestTimeoutMs: 30_000,
                retryPolicy,
            },
        },
        appCtx: { config: { env: {} } },
    });
}

function run(ctx, source) {
    return compose([
        primeStreamMiddleware(),
        async (innerCtx) => {
            innerCtx.response = createCanonicalStream(source, {});
        },
    ])(ctx);
}

async function drain(stream) {
    const events = [];
    for await (const event of stream) events.push(event);
    return events;
}

describe('the pre-commit silence window', () => {
    it('is not extended by non-liveness events', async () => {
        const ctx = makeCtx({ firstEventTimeoutMs: SILENCE_MS });
        const started = Date.now();
        await assert.rejects(
            run(ctx, trickle(USAGE_EVENT, { forMs: CONTENT_MS, tail: [TEXT_EVENT] })),
            (err) => err instanceof ProviderTimeoutError
        );
        const elapsed = Date.now() - started;
        assert.ok(elapsed < CONTENT_MS, `waited ${elapsed}ms for content`);
        assert.ok(elapsed >= SILENCE_MS - 50, `waited only ${elapsed}ms`);
    });

    it('is extended by liveness events', async () => {
        const ctx = makeCtx({ firstEventTimeoutMs: SILENCE_MS });
        const started = Date.now();
        await run(ctx, trickle(LIVENESS_EVENT, { forMs: CONTENT_MS, tail: [TEXT_EVENT] }));
        const elapsed = Date.now() - started;
        assert.ok(elapsed >= CONTENT_MS - 50, `committed after only ${elapsed}ms`);
        const events = await drain(ctx.response);
        assert.deepEqual(events, [TEXT_EVENT]);
    });

    it('does not fire at once when the configured window overflows a timer', async () => {
        // A silence window above what a timer can represent must mean
        // "practically never", not "after one millisecond".
        const ctx = makeCtx({ firstEventTimeoutMs: 2 ** 31 });
        const started = Date.now();
        await run(ctx, trickle(LIVENESS_EVENT, { forMs: 250, tail: [TEXT_EVENT] }));
        const elapsed = Date.now() - started;
        assert.ok(elapsed >= 200, `committed after only ${elapsed}ms`);
        assert.deepEqual(await drain(ctx.response), [TEXT_EVENT]);
    });

    it('cannot push back the absolute first-content cap', async () => {
        const ctx = makeCtx({
            firstEventTimeoutMs: SILENCE_MS,
            firstContentTimeoutMs: 300,
        });
        const started = Date.now();
        await assert.rejects(
            run(ctx, trickle(LIVENESS_EVENT, { forMs: Infinity })),
            (err) => err instanceof ProviderTimeoutError
        );
        const elapsed = Date.now() - started;
        assert.ok(elapsed >= 250 && elapsed < 900, `cut after ${elapsed}ms`);
    });
});
