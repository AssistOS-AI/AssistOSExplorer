/**
 * backendDispatchMiddleware tests.
 *
 * Verifies that the unified backend dispatch middleware:
 *
 *   - resolves the precompiled terminal from the backend catalog by
 *     `provider.backendKey`
 *   - throws ConfigurationError when the catalog is missing, the
 *     backend key is missing, or no backend is registered
 *   - throws TypeError when the kernel ctx is missing target.model
 *   - is itself terminal (does not call next())
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
    compose,
    createCanonicalStream,
    createKernelContext,
} from '../../runtime/kernel/index.mjs';
import { backendDispatchMiddleware } from '../../runtime/execution/backend-dispatch-middleware.mjs';
import { ConfigurationError } from '../../core/errors.mjs';

function makeCtx({ services = {}, target = null } = {}) {
    return createKernelContext({
        requestId: 'req-bd-1',
        request: { model: 'm' },
        target: target || {
            model: { modelKey: 'm', providerKey: 'p' },
            provider: { backendKey: 'stub-backend' },
        },
        appCtx: {
            config: { env: {} },
            services,
        },
    });
}

function makeStubCatalog(backendModule) {
    const terminal = async (ctx) => {
        const handle = await backendModule.execute(ctx);
        if (handle?.accountId !== undefined) {
            ctx.metadata.backendAccountId = handle.accountId;
        }
        ctx.response = handle;
    };
    return {
        getTerminal(key) {
            return key === backendModule.manifest.key ? terminal : null;
        },
    };
}

describe('backendDispatchMiddleware', () => {
    it('looks up the backend by provider.backendKey and runs its terminal', async () => {
        const backendModule = {
            manifest: { key: 'stub-backend' },
            async execute() {
                return {
                    accountId: 'acct-1',
                    stream: null,
                    message: { role: 'assistant', content: 'ok' },
                };
            },
        };
        const ctx = makeCtx({
            services: { backendCatalog: makeStubCatalog(backendModule) },
        });
        await compose([backendDispatchMiddleware()])(ctx);
        assert.equal(ctx.metadata.backendAccountId, 'acct-1');
        assert.ok(ctx.response);
    });

    it('throws when provider.backendKey is missing', async () => {
        const ctx = makeCtx({
            services: {
                backendCatalog: { getTerminal() { return null; } },
            },
            target: {
                model: { modelKey: 'm', providerKey: 'p' },
                provider: { backendKey: null },
            },
        });
        await assert.rejects(
            compose([backendDispatchMiddleware()])(ctx),
            /provider backendKey is required/
        );
    });

    it('throws ConfigurationError when no backend is registered for the key', async () => {
        const backendCatalog = { getTerminal() { return null; } };
        const ctx = makeCtx({ services: { backendCatalog } });
        await assert.rejects(
            compose([backendDispatchMiddleware()])(ctx),
            ConfigurationError
        );
    });

    it('throws when no backendCatalog is installed', async () => {
        const ctx = makeCtx({ services: {} });
        await assert.rejects(
            compose([backendDispatchMiddleware()])(ctx),
            /backendCatalog is required/
        );
    });

    it('throws when ctx.target.model is missing', async () => {
        const ctx = createKernelContext({
            requestId: 'r',
            appCtx: { services: {}, config: { env: {} } },
        });
        await assert.rejects(
            compose([backendDispatchMiddleware()])(ctx),
            /ctx\.target\.model is required/
        );
    });

    it('throws when ctx.target.provider is missing', async () => {
        const ctx = createKernelContext({
            requestId: 'r',
            target: { model: { modelKey: 'm', providerKey: 'p' } },
            appCtx: {
                services: {
                    backendCatalog: { getTerminal() { return null; } },
                },
                config: { env: {} },
            },
        });
        await assert.rejects(
            compose([backendDispatchMiddleware()])(ctx),
            /ctx\.target\.provider is required/
        );
    });

    it('holds the backend generation lease until a streamed response is consumed', async () => {
        const releases = [];
        let acquiredGeneration = null;
        const ctx = makeCtx({
            services: {
                backendCatalog: {
                    acquireGeneration() {
                        acquiredGeneration = 7;
                        return acquiredGeneration;
                    },
                    releaseGeneration(generation) {
                        releases.push(generation);
                    },
                    getTerminalForGeneration(key, generation) {
                        assert.equal(key, 'stub-backend');
                        assert.equal(generation, 7);
                        return async (innerCtx) => {
                            innerCtx.response = createCanonicalStream(
                                (async function* () {
                                    yield {
                                        type: 'done',
                                        data: { finish_reason: 'stop' },
                                    };
                                })()
                            );
                        };
                    },
                    getTerminal() {
                        throw new Error('should use generation-aware lookup');
                    },
                },
            },
        });

        await compose([backendDispatchMiddleware()])(ctx);
        assert.deepEqual(releases, []);

        for await (const _event of ctx.response) {
            // consume the stream to trigger the finally block
        }

        assert.deepEqual(releases, [acquiredGeneration]);
    });
});
