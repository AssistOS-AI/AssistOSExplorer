/**
 * Backend terminal contract tests.
 *
 * Proves the kernel terminal middleware produced by
 * `createBackendTerminal(backendModule)`:
 *
 *   - reads request, target, signal, attempt from the kernel ctx
 *   - calls module.execute with a frozen BackendExecutionContext
 *   - wraps the returned async iterable as a CanonicalStream
 *   - records accountId on ctx.metadata.backendAccountId
 *   - classifies thrown errors via module.classifyError
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
} from '../../runtime/kernel/index.mjs';
import { createBackendTerminal } from '../../runtime/backends/backend-terminal.mjs';
import {
    ProviderModelNotFoundError,
    ProviderRateLimitError,
} from '../../core/errors.mjs';

// ── helpers ────────────────────────────────────────────────────────────

function noopLog() {
    return { debug() {}, info() {}, warn() {}, error() {}, fatal() {} };
}

function makeCtx(overrides = {}) {
    return createKernelContext({
        requestId: 'req-bt-1',
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

function makeStubModule({
    behavior = 'success',
    stream = sample(),
    accountId = 'acct-1',
} = {}) {
    return {
        manifest: {
            key: 'stub-backend',
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
            makeStubModule._lastCtx = ctx;
            return { accountId, stream, abort: async () => {} };
        },
        classifyError(err) {
            if (err?.status === 429) return new ProviderRateLimitError('stub');
            return err;
        },
    };
}

// ── validation ─────────────────────────────────────────────────────────

describe('createBackendTerminal: validation', () => {
    it('rejects a missing module', () => {
        assert.throws(
            () => createBackendTerminal(null),
            /backendModule is required/
        );
    });

    it('rejects a module with no execute method', () => {
        assert.throws(
            () => createBackendTerminal({ manifest: { key: 'x' } }),
            /backendModule\.execute is required/
        );
    });
});

// ── basic terminal contract ────────────────────────────────────────────

describe('createBackendTerminal: terminal contract', () => {
    it('calls module.execute with a frozen BackendExecutionContext', async () => {
        const mod = makeStubModule();
        const terminal = createBackendTerminal(mod);
        const ctx = makeCtx();

        await compose([terminal])(ctx);

        const lastCtx = makeStubModule._lastCtx;
        assert.ok(lastCtx);
        assert.equal(lastCtx.requestId, 'req-bt-1');
        assert.deepEqual(lastCtx.request, ctx.request);
        assert.equal(lastCtx.resolvedModel.modelKey, 'm');
        assert.equal(lastCtx.providerRecord.providerKey, 'p');
        assert.equal(lastCtx.credentialLease.accountId, 'acct-default');
        assert.equal(lastCtx.attempt.index, 0);
        assert.ok(Object.isFrozen(lastCtx));
    });

    it('wraps the returned stream as a CanonicalStream and tags meta', async () => {
        const mod = makeStubModule();
        const terminal = createBackendTerminal(mod);
        const ctx = makeCtx();
        await compose([terminal])(ctx);

        assert.equal(isCanonicalStream(ctx.response), true);
        assert.equal(ctx.response.meta.backend, 'stub-backend');
        assert.equal(ctx.response.meta.model, 'm');
    });

    it('records accountId on ctx.metadata.backendAccountId', async () => {
        const mod = makeStubModule({ accountId: 'acct-99' });
        const terminal = createBackendTerminal(mod);
        const ctx = makeCtx();
        await compose([terminal])(ctx);

        assert.equal(ctx.metadata.backendAccountId, 'acct-99');
    });

    it('classifies module errors via module.classifyError', async () => {
        const mod = makeStubModule({ behavior: 'throw' });
        const terminal = createBackendTerminal(mod);
        const ctx = makeCtx();

        await assert.rejects(
            compose([terminal])(ctx),
            (err) => err instanceof ProviderRateLimitError
        );
    });

    it('falls back to the original error when module.classifyError throws', async () => {
        const mod = {
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
        const terminal = createBackendTerminal(mod);
        await assert.rejects(compose([terminal])(makeCtx()), /upstream-died/);
    });

    it('classifies stream error events via module.classifyError', async () => {
        async function* failingStream() {
            yield {
                type: 'message_start',
                data: { id: 'm1', model: 'm', role: 'assistant' },
            };
            const err = new Error('upstream 429');
            err.status = 429;
            yield { type: 'error', error: err };
        }

        const mod = makeStubModule({ stream: failingStream() });
        const terminal = createBackendTerminal(mod);
        const ctx = makeCtx();

        await assert.rejects(
            compose([bufferingMiddleware(), terminal])(ctx),
            (err) => err instanceof ProviderRateLimitError
        );
    });

    it('classifies exceptions thrown while draining a backend stream', async () => {
        async function* failingStream() {
            yield {
                type: 'message_start',
                data: { id: 'm1', model: 'm', role: 'assistant' },
            };
            const err = new Error('missing model');
            err.status = 404;
            err.body = { error: { param: 'model', message: 'm' } };
            throw err;
        }

        const mod = {
            ...makeStubModule({ stream: failingStream() }),
            classifyError(err) {
                if (err?.status === 404) {
                    return new ProviderModelNotFoundError('stub', 'm');
                }
                return err;
            },
        };
        const terminal = createBackendTerminal(mod);
        const ctx = makeCtx();

        await assert.rejects(
            compose([bufferingMiddleware(), terminal])(ctx),
            (err) => err instanceof ProviderModelNotFoundError
        );
    });

    it('passes a non-iterable handle through unchanged so callers can decide', async () => {
        const mod = {
            manifest: {
                key: 'buffered',
                kind: 'external_api',
                authStrategy: 'api_key',
                supportsStreaming: false,
                supportsTools: false,
                supportedFormats: ['openai_chat'],
            },
            async execute() {
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
        const terminal = createBackendTerminal(mod);
        const ctx = makeCtx();
        await compose([terminal])(ctx);

        assert.equal(isCanonicalStream(ctx.response), false);
        assert.equal(ctx.response.message.content, 'pre-built');
    });
});

// ── integration with provider middleware + buffering ───────────────────

describe('createBackendTerminal: integration', () => {
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

        const stubModule = makeStubModule({
            stream: sample('hello world'),
            accountId: 'acct-int',
        });
        const terminal = createBackendTerminal(stubModule);

        const dispatch = compose([
            responseTagger,
            bufferingMiddleware(),
            promptInjector,
            terminal,
        ]);

        const ctx = makeCtx();
        await dispatch(ctx);

        const lastExecuteCtx = makeStubModule._lastCtx;
        assert.equal(lastExecuteCtx.request.messages[0].role, 'system');
        assert.equal(lastExecuteCtx.request.messages[0].content, 'INJECTED');

        assert.equal(ctx.response.message.content, '[TAGGED] hello world');
        assert.equal(ctx.metadata.backendAccountId, 'acct-int');
    });

    it('a provider middleware can intercept the canonical events the terminal produces', async () => {
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

        const stubModule = makeStubModule({ stream: sample('quiet') });
        const terminal = createBackendTerminal(stubModule);

        const dispatch = compose([
            bufferingMiddleware(),
            upper,
            terminal,
        ]);

        const ctx = makeCtx();
        await dispatch(ctx);
        assert.equal(ctx.response.message.content, 'QUIET');
    });

    it('an aborted ctx.signal propagates to the module via the execution ctx', async () => {
        const ac = new AbortController();
        let receivedSignal = null;

        const mod = {
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

        const terminal = createBackendTerminal(mod);
        const ctx = makeCtx({ signal: ac.signal });
        await compose([terminal])(ctx);

        assert.equal(receivedSignal, ac.signal);
    });
});
