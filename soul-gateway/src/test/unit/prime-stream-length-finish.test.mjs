/**
 * A reply that the token limit cut off before any text or tool call (finish
 * reason `length`) tells the caller to raise its token limit, so it is a
 * completion, not an empty answer. A cascade child whose policy sets
 * `lengthWithoutContentFails` — the free-model execution policy does, because
 * in a cascade the gateway chose the model — treats it as an empty answer so
 * the next child is tried. A direct request always keeps the length finish,
 * because no other model would be tried. A reply that ended normally without
 * content stays an empty answer everywhere.
 *
 * The middleware is driven directly with real canonical streams.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { compose, createKernelContext } from '../../runtime/kernel/index.mjs';
import { createCanonicalStream } from '../../runtime/kernel/canonical-stream.mjs';
import { primeStreamMiddleware } from '../../runtime/execution/prime-stream-middleware.mjs';
import { FREE_MODEL_EXECUTION_POLICY } from '../../runtime/providers/free-model-policy.mjs';

const START = { type: 'message_start', data: { id: 'x', model: 'm', role: 'assistant' } };
const REASONING = { type: 'activity', data: { kind: 'reasoning' } };

function done(finishReason) {
    return { type: 'done', data: { finish_reason: finishReason, model: 'm' } };
}

function makeCtx(retryPolicy, { cascadeChild = false } = {}) {
    return createKernelContext({
        requestId: 'req-length-1',
        target: {
            model: {
                modelKey: 'm',
                providerKey: 'p',
                requestTimeoutMs: 30_000,
                retryPolicy,
                ...(cascadeChild ? { cascadeChild: true } : {}),
            },
        },
        appCtx: { config: { env: {} } },
    });
}

async function* replayEvents(events) {
    for (const event of events) yield event;
}

function run(ctx, events) {
    return compose([
        primeStreamMiddleware(),
        async (innerCtx) => {
            innerCtx.response = createCanonicalStream(replayEvents(events), {});
        },
    ])(ctx);
}

async function drain(stream) {
    const events = [];
    for await (const event of stream) events.push(event);
    return events;
}

async function expectLengthFinish(ctx) {
    await run(ctx, [START, REASONING, done('length')]);
    const events = await drain(ctx.response);
    assert.deepEqual(events.map((event) => event.type), ['message_start', 'done']);
    assert.equal(events.at(-1).data.finish_reason, 'length');
}

describe('a reply cut off by the token limit before any content', () => {
    it('is returned with its length finish reason on a row without the failover policy', async () => {
        await expectLengthFinish(makeCtx({ maxAttempts: 1 }));
        await expectLengthFinish(makeCtx({ maxAttempts: 1 }, { cascadeChild: true }));
    });

    it('fails over as an empty answer for a cascade child under the free-model execution policy', async () => {
        const ctx = makeCtx({ ...FREE_MODEL_EXECUTION_POLICY }, { cascadeChild: true });
        await assert.rejects(
            run(ctx, [START, REASONING, done('length')]),
            (err) => err.cascade === true && err.retryable === false && /empty response/.test(err.message)
        );
    });

    it('keeps its length finish reason on a direct request under the free-model execution policy', async () => {
        await expectLengthFinish(makeCtx({ ...FREE_MODEL_EXECUTION_POLICY }));
    });

    it('stays an empty answer when the reply ended normally', async () => {
        await assert.rejects(run(makeCtx({ maxAttempts: 1 }), [START, done('stop')]), /empty response/);
        await assert.rejects(run(makeCtx({ maxAttempts: 1 }), [START]), /empty response/);
        await assert.rejects(
            run(makeCtx({ ...FREE_MODEL_EXECUTION_POLICY }), [START, done('stop')]),
            /empty response/
        );
    });
});
