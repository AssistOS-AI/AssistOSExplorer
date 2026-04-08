/**
 * Transport adapter tests.
 *
 * Proves the kernel terminal contract for `adaptProviderPluginToTransport`:
 *
 *   - reads request, target, signal, attempt from the kernel ctx
 *   - calls plugin.execute with a legacy ExecuteContext shape
 *   - wraps the returned async iterable as a CanonicalStream
 *   - records accountId on ctx.metadata
 *   - classifies thrown errors via plugin.classifyError
 *   - integrates with provider middleware + buffering as a real terminal
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
    compose,
    createKernelContext,
    createCanonicalStream,
    isCanonicalStream,
    bufferingMiddleware,
    adaptProviderPluginToTransport,
} from '../../runtime/kernel/index.mjs';
import { ProviderRateLimitError } from '../../core/errors.mjs';

// ── helpers ────────────────────────────────────────────────────────────

function noopLog() {
    return { debug() {}, info() {}, warn() {}, error() {}, fatal() {} };
}

function makeCtx(overrides = {}) {
    return createKernelContext({
        requestId: 'req-trans-1',
        request: overrides.request ?? {
            model: 'm',
            messages: [{ role: 'user', content: 'hi' }],
        },
        target: overrides.target ?? {
            model: { modelKey: 'm', model_key: 'm', providerKey: 'p' },
            provider: { providerKey: 'p' },
            credentialLease: { accountId: 'acct-default', secret: 'k' },
        },
        services: overrides.services ?? Object.freeze({}),
        signal: overrides.signal,
        log: overrides.log ?? noopLog(),
        appCtx: overrides.appCtx ?? { config: { env: {} }, services: {} },
    });
}

async function* sample(text = 'hello') {
    yield {
        type: 'message_start',
        data: { id: 'm1', model: 'm', role: 'assistant' },
    };
    yield { type: 'text_delta', data: { text } };
    yield {
        type: 'usage',
        data: { input_tokens: 1, output_tokens: 2, total_tokens: 3 },
    };
    yield { type: 'done', data: { finish_reason: 'stop' } };
}

function makeStubPlugin({
    behavior = 'success',
    stream = sample(),
    accountId = 'acct-1',
} = {}) {
    return {
        manifest: {
            key: 'stub-transport',
            kind: 'external_api',
            authStrategy: 'api_key',
            supportsStreaming: true,
            supportsTools: false,
            supportedFormats: ['openai_chat'],
        },
        async execute(ctx) {
            if (behavior === 'throw') {
                const err = new Error('upstream 429');
                err.status = 429;
                throw err;
            }
            // Capture the ctx for assertions in the test
            makeStubPlugin._lastCtx = ctx;
            return { accountId, stream, abort: async () => {} };
        },
        classifyError(err) {
            if (err?.status === 429) return new ProviderRateLimitError('stub');
            return err;
        },
    };
}

// ── validation ─────────────────────────────────────────────────────────

describe('adaptProviderPluginToTransport: validation', () => {
    it('rejects a missing plugin', () => {
        assert.throws(
            () => adaptProviderPluginToTransport(null),
            /plugin is required/
        );
    });

    it('rejects a plugin with no execute method', () => {
        assert.throws(
            () => adaptProviderPluginToTransport({ manifest: { key: 'x' } }),
            /plugin\.execute is required/
        );
    });
});

// ── basic terminal contract ────────────────────────────────────────────

describe('adaptProviderPluginToTransport: terminal contract', () => {
    it('calls plugin.execute with the legacy ExecuteContext shape', async () => {
        const plugin = makeStubPlugin();
        const transport = adaptProviderPluginToTransport(plugin);
        const ctx = makeCtx();

        await compose([transport])(ctx);

        const lastCtx = makeStubPlugin._lastCtx;
        assert.ok(lastCtx);
        assert.equal(lastCtx.requestId, 'req-trans-1');
        assert.deepEqual(lastCtx.request, ctx.request);
        assert.equal(lastCtx.resolvedModel.modelKey, 'm');
        assert.equal(lastCtx.providerRecord.providerKey, 'p');
        assert.equal(lastCtx.credentialLease.accountId, 'acct-default');
        assert.equal(lastCtx.attempt.index, 0);
    });

    it('wraps the returned stream as a CanonicalStream and tags meta', async () => {
        const plugin = makeStubPlugin();
        const transport = adaptProviderPluginToTransport(plugin);
        const ctx = makeCtx();
        await compose([transport])(ctx);

        assert.equal(isCanonicalStream(ctx.response), true);
        assert.equal(ctx.response.meta.transport, 'stub-transport');
        assert.equal(ctx.response.meta.model, 'm');
    });

    it('records accountId on ctx.metadata.transportAccountId', async () => {
        const plugin = makeStubPlugin({ accountId: 'acct-99' });
        const transport = adaptProviderPluginToTransport(plugin);
        const ctx = makeCtx();
        await compose([transport])(ctx);

        assert.equal(ctx.metadata.transportAccountId, 'acct-99');
    });

    it('classifies plugin errors via plugin.classifyError', async () => {
        const plugin = makeStubPlugin({ behavior: 'throw' });
        const transport = adaptProviderPluginToTransport(plugin);
        const ctx = makeCtx();

        await assert.rejects(
            compose([transport])(ctx),
            (err) => err instanceof ProviderRateLimitError
        );
    });

    it('falls back to the original error when plugin.classifyError throws', async () => {
        const plugin = {
            manifest: {
                key: 'broken',
                kind: 'external_api',
                authStrategy: 'api_key',
                supportsStreaming: true,
                supportsTools: false,
                supportedFormats: ['openai_chat'],
            },
            async execute() {
                throw new Error('upstream-died');
            },
            classifyError() {
                throw new Error('classifier-bug');
            },
        };
        const transport = adaptProviderPluginToTransport(plugin);
        await assert.rejects(compose([transport])(makeCtx()), /upstream-died/);
    });

    it('passes a non-iterable handle through unchanged so callers can decide', async () => {
        const plugin = {
            manifest: {
                key: 'buffered',
                kind: 'external_api',
                authStrategy: 'api_key',
                supportsStreaming: false,
                supportsTools: false,
                supportedFormats: ['openai_chat'],
            },
            async execute() {
                // Simulate a future "buffered transport" that returns the
                // collected shape directly.
                return {
                    accountId: 'a',
                    stream: null,
                    message: { role: 'assistant', content: 'pre-built' },
                    usage: {
                        input_tokens: 1,
                        output_tokens: 1,
                        total_tokens: 2,
                    },
                };
            },
            classifyError(e) {
                return e;
            },
        };
        const transport = adaptProviderPluginToTransport(plugin);
        const ctx = makeCtx();
        await compose([transport])(ctx);

        assert.equal(isCanonicalStream(ctx.response), false);
        assert.equal(ctx.response.message.content, 'pre-built');
    });
});

// ── integration with provider middleware + buffering ───────────────────

describe('adaptProviderPluginToTransport: integration', () => {
    it('runs end-to-end as the terminal of a provider chain', async () => {
        const promptInjector = async (ctx, next) => {
            ctx.request.messages.unshift({
                role: 'system',
                content: 'INJECTED',
            });
            await next();
        };

        const responseTagger = async (ctx, next) => {
            await next();
            ctx.response.message.content = `[TAGGED] ${ctx.response.message.content}`;
        };

        const stubPlugin = makeStubPlugin({
            stream: sample('hello world'),
            accountId: 'acct-int',
        });
        const transport = adaptProviderPluginToTransport(stubPlugin);

        const dispatch = compose([
            responseTagger,
            bufferingMiddleware(),
            promptInjector,
            transport,
        ]);

        const ctx = makeCtx();
        await dispatch(ctx);

        // The provider chain ran inject (mutated request), then transport
        // produced a stream, then tag (with inline buffer) read the buffered
        // response, then bufferingMiddleware finished the drain (no-op since
        // tag already drained).
        const lastExecuteCtx = makeStubPlugin._lastCtx;
        assert.equal(lastExecuteCtx.request.messages[0].role, 'system');
        assert.equal(lastExecuteCtx.request.messages[0].content, 'INJECTED');

        assert.equal(ctx.response.message.content, '[TAGGED] hello world');
        assert.equal(ctx.metadata.transportAccountId, 'acct-int');
    });

    it('a provider middleware can intercept the canonical events the transport produces', async () => {
        const upper = async (ctx, next) => {
            await next();
            const stream = ctx.response;
            ctx.response = createCanonicalStream(
                (async function* () {
                    for await (const ev of stream) {
                        if (ev.type === 'text_delta') {
                            yield {
                                type: 'text_delta',
                                data: { text: ev.data.text.toUpperCase() },
                            };
                        } else {
                            yield ev;
                        }
                    }
                })(),
                stream.meta
            );
        };

        const stubPlugin = makeStubPlugin({ stream: sample('quiet') });
        const transport = adaptProviderPluginToTransport(stubPlugin);

        const dispatch = compose([
            bufferingMiddleware(),
            upper,
            transport,
        ]);

        const ctx = makeCtx();
        await dispatch(ctx);
        assert.equal(ctx.response.message.content, 'QUIET');
    });

    it('an aborted ctx.signal propagates to the plugin via the legacy ctx', async () => {
        const ac = new AbortController();
        let receivedSignal = null;

        const plugin = {
            manifest: {
                key: 'signal-aware',
                kind: 'external_api',
                authStrategy: 'api_key',
                supportsStreaming: true,
                supportsTools: false,
                supportedFormats: ['openai_chat'],
            },
            async execute(executeCtx) {
                receivedSignal = executeCtx.signal;
                return {
                    accountId: null,
                    stream: sample('x'),
                    abort: async () => {},
                };
            },
            classifyError(e) {
                return e;
            },
        };

        const transport = adaptProviderPluginToTransport(plugin);
        const ctx = makeCtx({ signal: ac.signal });
        await compose([transport])(ctx);

        assert.equal(receivedSignal, ac.signal);
    });
});
