/**
 * transportDispatchMiddleware tests.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { compose, createKernelContext } from '../../runtime/kernel/index.mjs';
import { transportDispatchMiddleware } from '../../runtime/execution/transport-dispatch-middleware.mjs';
import { ConfigurationError } from '../../core/errors.mjs';

function makeCtx({ services = {}, target = null } = {}) {
    return createKernelContext({
        requestId: 'req-td-1',
        request: { model: 'm' },
        target: target || {
            model: { modelKey: 'm', providerKey: 'p' },
            provider: { adapterKey: 'stub-transport' },
        },
        appCtx: {
            config: { env: {} },
            services,
        },
    });
}

async function* sample() {
    yield {
        type: 'message_start',
        data: { id: 'm1', model: 'm', role: 'assistant' },
    };
    yield { type: 'text_delta', data: { text: 'hello' } };
    yield { type: 'done', data: { finish_reason: 'stop' } };
}

function makeStubPlugin() {
    return {
        manifest: { key: 'stub-transport' },
        async execute() {
            return { accountId: 'acct-1', stream: sample(), abort: async () => {} };
        },
        classifyError(e) {
            return e;
        },
    };
}

describe('transportDispatchMiddleware', () => {
    it('looks up the transport via provider.adapterKey and runs it', async () => {
        let askedFor = null;
        const plugin = makeStubPlugin();
        const transportCatalog = {
            getTransport(key) {
                askedFor = key;
                return key === 'stub-transport' ? plugin : null;
            },
        };
        const ctx = makeCtx({ services: { transportCatalog } });
        await compose([transportDispatchMiddleware()])(ctx);
        assert.equal(askedFor, 'stub-transport');
        assert.ok(ctx.response);
        assert.equal(ctx.metadata.transportAccountId, 'acct-1');
    });

    it('throws when provider.adapterKey is missing', async () => {
        const ctx = makeCtx({
            services: {
                transportCatalog: {
                    getTransport() {
                        return null;
                    },
                },
            },
            target: {
                model: { modelKey: 'm', providerKey: 'p' },
                provider: { adapterKey: null },
            },
        });
        await assert.rejects(
            compose([transportDispatchMiddleware()])(ctx),
            /provider adapterKey is required/
        );
    });

    it('throws ConfigurationError when no transport is registered for the key', async () => {
        const transportCatalog = { getTransport() { return null; } };
        const ctx = makeCtx({ services: { transportCatalog } });
        await assert.rejects(
            compose([transportDispatchMiddleware()])(ctx),
            ConfigurationError
        );
    });

    it('throws when no transportCatalog is installed', async () => {
        const ctx = makeCtx({ services: {} });
        await assert.rejects(
            compose([transportDispatchMiddleware()])(ctx),
            /transportCatalog is required/
        );
    });

    it('throws when ctx.target.model is missing', async () => {
        const ctx = createKernelContext({
            requestId: 'r',
            appCtx: { services: {}, config: { env: {} } },
        });
        await assert.rejects(
            compose([transportDispatchMiddleware()])(ctx),
            /ctx\.target\.model is required/
        );
    });

    it('throws when ctx.target.provider is missing', async () => {
        const ctx = createKernelContext({
            requestId: 'r',
            target: { model: { modelKey: 'm', providerKey: 'p' } },
            appCtx: {
                services: {
                    transportCatalog: {
                        getTransport() {
                            return null;
                        },
                    },
                },
                config: { env: {} },
            },
        });
        await assert.rejects(
            compose([transportDispatchMiddleware()])(ctx),
            /ctx\.target\.provider is required/
        );
    });
});
