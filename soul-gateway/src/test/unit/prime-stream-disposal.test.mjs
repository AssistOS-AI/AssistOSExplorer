/**
 * Priming has already opened the backend stream when it returns, so the
 * primed stream must close it even when it is disposed before its first
 * event is read: closing it releases the upstream request and the backend
 * generation lease. The primed stream is also adopted by the request's
 * stream owner, which disposes it once the route response is finished.
 *
 * The middleware is driven directly with real canonical streams.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { compose, createKernelContext } from '../../runtime/kernel/index.mjs';
import { createCanonicalStream } from '../../runtime/kernel/canonical-stream.mjs';
import { primeStreamMiddleware } from '../../runtime/execution/prime-stream-middleware.mjs';

const START = { type: 'message_start', data: { id: 'x', model: 'm', role: 'assistant' } };
const TEXT = { type: 'text_delta', data: { text: 'answer' } };
const DONE = { type: 'done', data: { finish_reason: 'stop', model: 'm' } };

function makeCtx() {
    return createKernelContext({
        requestId: 'req-prime-dispose-1',
        target: {
            model: { modelKey: 'm', providerKey: 'p', requestTimeoutMs: 30_000 },
        },
        appCtx: { config: { env: {} } },
    });
}

function backend() {
    const state = { closed: 0 };
    state.stream = (async function* () {
        try {
            yield START;
            yield TEXT;
            yield DONE;
        } finally {
            state.closed++;
        }
    })();
    return state;
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

describe('a primed stream', () => {
    it('closes the backend stream when it is disposed unread', async () => {
        const upstream = backend();
        const ctx = makeCtx();
        await run(ctx, upstream.stream);
        assert.equal(upstream.closed, 0);

        const iterator = ctx.response[Symbol.asyncIterator]();
        await iterator.return();
        await iterator.return();

        assert.equal(upstream.closed, 1);
    });

    it('replays its head and closes the backend stream once when read to the end', async () => {
        const upstream = backend();
        const ctx = makeCtx();
        await run(ctx, upstream.stream);

        assert.deepEqual(await drain(ctx.response), [START, TEXT, DONE]);
        await ctx.response[Symbol.asyncIterator]().return();

        assert.equal(upstream.closed, 1);
    });

    it('is adopted by the request stream owner', async () => {
        const adopted = [];
        const ctx = makeCtx();
        ctx.streamOwner = { adopt: (stream) => adopted.push(stream) };
        await run(ctx, backend().stream);

        assert.deepEqual(adopted, [ctx.response]);
    });
});
