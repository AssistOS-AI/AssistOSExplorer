/**
 * `invokeModelCapabilityMiddleware` tests.
 *
 * Validates that the cascade re-entry primitive resolves a model from
 * either a model record or a model key, dispatches it through the
 * model-execution chain, and returns the finished child kernel ctx.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { compose, createKernelContext } from '../../runtime/kernel/index.mjs';
import { invokeModelCapabilityMiddleware } from '../../runtime/execution/invoke-model-capability-middleware.mjs';
import { ConfigurationError } from '../../core/errors.mjs';

// ── helpers ────────────────────────────────────────────────────────────

function noopLog() {
    return { debug() {}, info() {}, warn() {}, error() {}, fatal() {} };
}

function makeAppCtx({ transportCatalog } = {}) {
    return {
        config: {
            defaults: { responseExcerptChars: 2000 },
            env: {
                DEFAULT_REQUEST_TIMEOUT_MS: 1000,
                DEFAULT_QUEUE_TIMEOUT_MS: 1000,
                DEFAULT_MODEL_CONCURRENCY: 1,
                HTTP_RETRY_MAX_ATTEMPTS: 1,
                HTTP_RETRY_BASE_DELAY_MS: 1,
                HTTP_RETRY_MULTIPLIER: 1,
                HTTP_RETRY_MAX_DELAY_MS: 1,
                HTTP_RETRY_JITTER_PCT: 0,
            },
        },
        pool: null,
        log: noopLog(),
        services: {
            transportCatalog: transportCatalog || null,
            providerMiddlewareRegistry: { build: () => null },
            concurrencyController: null,
            credentialManager: null,
            extensionServices: Object.freeze({}),
        },
    };
}

function makeSnapshot(model) {
    return Object.freeze({
        generation: 1,
        models: new Map([[model.modelKey, model]]),
        aliases: new Map(),
        providers: new Map([
            [
                model.providerKey,
                Object.freeze({
                    id: 'provider-1',
                    providerKey: model.providerKey,
                    adapterKey: 'stub-transport',
                    settings: {},
                }),
            ],
        ]),
        middlewareBindings: {
            gateway: [],
            byModel: new Map(),
            byProvider: new Map(),
        },
        cooldowns: new Set(),
        pricing: new Map(),
    });
}

function makeStubTransport(textOrFn) {
    return {
        manifest: {
            key: 'stub-transport',
            kind: 'external_api',
            authStrategy: 'api_key',
            supportsStreaming: true,
            supportsTools: false,
            supportedFormats: ['openai_chat'],
        },
        async execute(executeCtx) {
            const text =
                typeof textOrFn === 'function'
                    ? textOrFn(executeCtx)
                    : textOrFn;
            async function* events() {
                yield {
                    type: 'message_start',
                    data: {
                        id: 'm1',
                        model: executeCtx.resolvedModel.modelKey,
                        role: 'assistant',
                    },
                };
                yield { type: 'text_delta', data: { text } };
                yield {
                    type: 'usage',
                    data: {
                        input_tokens: 1,
                        output_tokens: 2,
                        total_tokens: 3,
                    },
                };
                yield { type: 'done', data: { finish_reason: 'stop' } };
            }
            return {
                accountId: `acct-${executeCtx.resolvedModel.modelKey}`,
                stream: events(),
                abort: async () => {},
            };
        },
        classifyError(e) {
            return e;
        },
    };
}

/**
 * Build a kernel ctx and install ctx.invokeModel via the capability
 * middleware.  The capability middleware itself is a wrapping middleware
 * that calls next() — we run it through compose with a no-op terminal so
 * the install side-effect lands on the parent ctx.
 */
async function buildCtxWithInvokeModel({ snapshot, appCtx }) {
    const ctx = createKernelContext({
        requestId: 'req-1',
        request: { model: 'x', messages: [{ role: 'user', content: 'hi' }] },
        snapshot,
        services: appCtx.services,
        log: appCtx.log,
        appCtx,
    });
    const chain = compose([
        invokeModelCapabilityMiddleware(),
        async () => {},
    ]);
    await chain(ctx);
    return ctx;
}

// ── installation ───────────────────────────────────────────────────────

describe('invokeModelCapabilityMiddleware', () => {
    it('installs ctx.invokeModel as a function', async () => {
        const ctx = await buildCtxWithInvokeModel({
            snapshot: makeSnapshot({ modelKey: 'm', providerKey: 'p' }),
            appCtx: makeAppCtx(),
        });
        assert.equal(typeof ctx.invokeModel, 'function');
    });
});

// ── invocation ─────────────────────────────────────────────────────────

describe('ctx.invokeModel: dispatch', () => {
    it('resolves a model record and runs the direct-model chain', async () => {
        const model = Object.freeze({
            id: 'model-1',
            modelKey: 'stub-model',
            providerId: 'provider-1',
            providerKey: 'stub-provider',
            requestTimeoutMs: 1000,
            queueTimeoutMs: 1000,
            concurrencyLimit: 1,
            retryPolicy: {},
            strategyKind: 'direct',
        });

        const transport = makeStubTransport('hello from stub');
        const transportCatalog = {
            getTransport: (k) => (k === 'stub-transport' ? transport : null),
        };
        const snapshot = makeSnapshot(model);
        const appCtx = makeAppCtx({ transportCatalog });

        const ctx = await buildCtxWithInvokeModel({ snapshot, appCtx });

        const childCtx = await ctx.invokeModel(model);
        assert.equal(childCtx.response.choices[0].message.content, 'hello from stub');
        assert.equal(childCtx.response.usage.total_tokens, 3);
        assert.equal(childCtx.metadata.transportAccountId, 'acct-stub-model');
    });

    it('resolves a model by string key from the snapshot', async () => {
        const model = Object.freeze({
            id: 'model-1',
            modelKey: 'lookup-model',
            providerId: 'provider-1',
            providerKey: 'stub-provider',
            requestTimeoutMs: 1000,
            queueTimeoutMs: 1000,
            concurrencyLimit: 1,
            retryPolicy: {},
            strategyKind: 'direct',
        });

        const transport = makeStubTransport(
            (execCtx) => `${execCtx.resolvedModel.modelKey}!`
        );
        const transportCatalog = {
            getTransport: (k) => (k === 'stub-transport' ? transport : null),
        };
        const snapshot = makeSnapshot(model);
        const appCtx = makeAppCtx({ transportCatalog });

        const ctx = await buildCtxWithInvokeModel({ snapshot, appCtx });

        const childCtx = await ctx.invokeModel('lookup-model');
        assert.equal(childCtx.response.choices[0].message.content, 'lookup-model!');
    });

    it('throws ConfigurationError when no snapshot is pinned', async () => {
        const appCtx = makeAppCtx();
        const ctx = createKernelContext({
            requestId: 'r',
            appCtx,
            services: appCtx.services,
        });
        const chain = compose([
            invokeModelCapabilityMiddleware(),
            async () => {},
        ]);
        await chain(ctx);
        await assert.rejects(ctx.invokeModel('any'), ConfigurationError);
    });

    it('throws ConfigurationError when the model key is not in the snapshot', async () => {
        const model = Object.freeze({
            id: 'm1',
            modelKey: 'present',
            providerKey: 'p',
            providerId: 'provider-1',
            retryPolicy: {},
            strategyKind: 'direct',
        });
        const snapshot = makeSnapshot(model);
        const appCtx = makeAppCtx();
        const ctx = await buildCtxWithInvokeModel({ snapshot, appCtx });
        await assert.rejects(ctx.invokeModel('not-there'), ConfigurationError);
    });
});
