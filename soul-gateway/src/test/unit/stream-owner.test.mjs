/**
 * Stream disposal helpers of the kernel.
 *
 *   - `releaseOnEarlyReturn` runs a stream wrapper's release when the
 *     wrapper is disposed before its first event was pulled, because an
 *     async generator that never started skips its own `finally`.  Once
 *     the generator has started, its `finally` owns the release.
 *
 *   - `createStreamOwner` disposes every stream adopted for a request,
 *     read or not, and disposes a stream adopted after that at once.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
    createStreamOwner,
    releaseOnEarlyReturn,
} from '../../runtime/kernel/index.mjs';

const EVENT = { type: 'text_delta', data: { text: 'x' } };

function leasedGenerator() {
    const state = { released: 0, finallyRan: 0 };
    const release = () => {
        state.released++;
    };
    state.iterator = releaseOnEarlyReturn(
        (async function* () {
            try {
                yield EVENT;
                yield EVENT;
            } finally {
                state.finallyRan++;
                release();
            }
        })(),
        release
    );
    return state;
}

describe('releaseOnEarlyReturn', () => {
    it('releases a generator disposed before its first pull, once', async () => {
        const lease = leasedGenerator();

        assert.deepEqual(await lease.iterator.return('r'), { done: true, value: 'r' });
        await lease.iterator.return();

        assert.equal(lease.released, 1);
        assert.equal(lease.finallyRan, 0);
        assert.deepEqual(await lease.iterator.next(), { done: true, value: undefined });
    });

    it('releases a generator that is thrown into before its first pull', async () => {
        const lease = leasedGenerator();

        await assert.rejects(lease.iterator.throw(new Error('stop')), /stop/);

        assert.equal(lease.released, 1);
    });

    it('leaves the release to the generator once it has started', async () => {
        const lease = leasedGenerator();

        assert.deepEqual(await lease.iterator.next(), { done: false, value: EVENT });
        await lease.iterator.return();
        await lease.iterator.return();

        assert.equal(lease.finallyRan, 1);
        assert.equal(lease.released, 1);
    });

    it('is its own async iterator', () => {
        const lease = leasedGenerator();
        assert.equal(lease.iterator[Symbol.asyncIterator](), lease.iterator);
    });
});

describe('createStreamOwner', () => {
    function stream(state) {
        return {
            [Symbol.asyncIterator]() {
                return {
                    async next() {
                        return { done: true, value: undefined };
                    },
                    async return() {
                        state.returned++;
                        if (state.fails) throw new Error('dispose failed');
                        return { done: true, value: undefined };
                    },
                };
            },
        };
    }

    it('disposes every adopted stream, even when one fails', async () => {
        const first = { returned: 0, fails: true };
        const second = { returned: 0 };
        const owner = createStreamOwner();
        owner.adopt(stream(first));
        owner.adopt(stream(second));

        await owner.dispose();

        assert.equal(first.returned, 1);
        assert.equal(second.returned, 1);
    });

    it('disposes a stream adopted twice once', async () => {
        const state = { returned: 0 };
        const shared = stream(state);
        const owner = createStreamOwner();
        owner.adopt(shared);
        owner.adopt(shared);

        await owner.dispose();
        await owner.dispose();

        assert.equal(state.returned, 1);
    });

    it('disposes a stream adopted after the owner was disposed at once', async () => {
        const state = { returned: 0 };
        const owner = createStreamOwner();
        await owner.dispose();

        owner.adopt(stream(state));
        await new Promise((resolve) => setImmediate(resolve));

        assert.equal(state.returned, 1);
    });
});
