/**
 * concurrencyMiddleware tests.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { compose, createKernelContext } from '../../runtime/kernel/index.mjs';
import { concurrencyMiddleware } from '../../runtime/execution/concurrency-middleware.mjs';
import { ConcurrencyController } from '../../runtime/execution/concurrency-controller.mjs';

function noopLog() {
    return { debug() {}, info() {}, warn() {}, error() {}, fatal() {} };
}

function makeCtx({ controller = null } = {}) {
    return createKernelContext({
        requestId: 'req-conc-1',
        request: { model: 'm', messages: [] },
        target: {
            model: { modelKey: 'mw-model', concurrencyLimit: 1, queueTimeoutMs: 1000 },
        },
        log: noopLog(),
        appCtx: {
            config: { env: { DEFAULT_MODEL_CONCURRENCY: 1, DEFAULT_QUEUE_TIMEOUT_MS: 1000 } },
            services: { concurrencyController: controller },
        },
    });
}

describe('concurrencyMiddleware', () => {
    it('passes through when no controller is registered', async () => {
        let calledTerminal = false;
        const ctx = makeCtx({ controller: null });
        await compose([
            concurrencyMiddleware(),
            async () => {
                calledTerminal = true;
            },
        ])(ctx);
        assert.ok(calledTerminal);
    });

    it('acquires and releases a slot around the downstream chain', async () => {
        const cc = new ConcurrencyController();
        const ctx = makeCtx({ controller: cc });
        await compose([
            concurrencyMiddleware(),
            async (innerCtx) => {
                assert.equal(cc.activeCount('mw-model'), 1);
            },
        ])(ctx);
        assert.equal(cc.activeCount('mw-model'), 0);
        assert.equal(typeof ctx.metadata.queueWaitMs, 'number');
    });

    it('releases the slot even when the downstream chain throws', async () => {
        const cc = new ConcurrencyController();
        const ctx = makeCtx({ controller: cc });
        await assert.rejects(
            compose([
                concurrencyMiddleware(),
                async () => {
                    throw new Error('boom');
                },
            ])(ctx),
            /boom/
        );
        assert.equal(cc.activeCount('mw-model'), 0);
    });

    it('throws when ctx.target.model is missing', async () => {
        const cc = new ConcurrencyController();
        const ctx = createKernelContext({
            requestId: 'r',
            appCtx: { services: { concurrencyController: cc }, config: { env: {} } },
        });
        await assert.rejects(
            compose([concurrencyMiddleware(), async () => {}])(ctx),
            /ctx\.target\.model is required/
        );
    });
});
