/**
 * Provider middleware registry tests.
 *
 * Validates that:
 *
 *   - The native `ProviderMiddlewareRegistry` registers and builds
 *     middleware factories.
 *   - All four built-in provider middlewares are registered with the
 *     correct keys.
 *   - Each built-in produces a working `(ctx, next)` middleware
 *     (tested via the kernel composer end-to-end).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
    compose,
    createKernelContext,
    createCanonicalStream,
} from '../../runtime/kernel/index.mjs';
import { ProviderMiddlewareRegistry } from '../../runtime/middleware/provider-middleware-registry.mjs';
import { compileProviderBindingsChain } from '../../runtime/middleware/compile-provider-bindings.mjs';
import { BUILTIN_PROVIDER_MIDDLEWARES } from '../../runtime/middleware/provider-builtin/index.mjs';

// ── helpers ────────────────────────────────────────────────────────────

function noopLog() {
    return { debug() {}, info() {}, warn() {}, error() {}, fatal() {} };
}

function makeCtx(overrides = {}) {
    return createKernelContext({
        requestId: 'req-prov-mw-1',
        request: overrides.request ?? {
            model: 'm',
            messages: [{ role: 'user', content: 'hi' }],
        },
        target: overrides.target ?? {
            model: { modelKey: 'm' },
            provider: { providerKey: 'p' },
        },
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

// ── ProviderMiddlewareRegistry: shape ─────────────────────────────────

describe('ProviderMiddlewareRegistry', () => {
    it('rejects modules without meta.key', () => {
        const reg = new ProviderMiddlewareRegistry();
        assert.throws(
            () => reg.register({ factory: () => () => {} }),
            /meta\.key/
        );
    });

    it('rejects modules without a factory function', () => {
        const reg = new ProviderMiddlewareRegistry();
        assert.throws(() => reg.register({ meta: { key: 'x' } }), /factory/);
    });

    it('loadBuiltins() registers all four built-in modules', () => {
        const reg = new ProviderMiddlewareRegistry().loadBuiltins();
        assert.equal(reg.size, 4);
        const keys = reg.listKeys().sort();
        assert.deepEqual(keys, [
            'provider-context-compacter',
            'provider-output-compressor',
            'provider-prompt-injector',
            'provider-response-filter',
        ]);
    });

    it('build() returns a function for a known key', () => {
        const reg = new ProviderMiddlewareRegistry().loadBuiltins();
        const fn = reg.build('provider-prompt-injector', { content: 'hi' });
        assert.equal(typeof fn, 'function');
        assert.equal(fn.length, 2);
    });

    it('build() returns null for an unknown key', () => {
        const reg = new ProviderMiddlewareRegistry().loadBuiltins();
        assert.equal(reg.build('not-a-real-middleware', {}), null);
    });
});

describe('compileProviderBindingsChain', () => {
    it('throws when a provider binding references an unknown middleware key', () => {
        const reg = new ProviderMiddlewareRegistry().loadBuiltins();
        assert.throws(
            () =>
                compileProviderBindingsChain({
                    providerId: 'provider-1',
                    registry: reg,
                    snapshot: {
                        middlewareBindings: {
                            byProvider: new Map([
                                [
                                    'provider-1',
                                    [
                                        {
                                            middlewareKey:
                                                'not-a-real-provider-middleware',
                                            middlewareDefaultSettings: {},
                                            settings: {},
                                        },
                                    ],
                                ],
                            ]),
                        },
                    },
                }),
            /Unknown provider middleware 'not-a-real-provider-middleware'/
        );
    });
});

// ── Built-in modules: meta ────────────────────────────────────────────

describe('BUILTIN_PROVIDER_MIDDLEWARES', () => {
    it('every entry exports meta with key, name, scope, defaultSettings and a factory', () => {
        for (const mod of BUILTIN_PROVIDER_MIDDLEWARES) {
            assert.ok(mod.meta, 'meta is required');
            assert.equal(typeof mod.meta.key, 'string');
            assert.equal(typeof mod.meta.name, 'string');
            assert.equal(mod.meta.scope, 'provider');
            assert.equal(typeof mod.meta.defaultSettings, 'object');
            assert.equal(typeof mod.factory, 'function');
        }
    });
});

// ── End-to-end: each built-in via the registry ────────────────────────

describe('built-in provider middlewares: end-to-end behavior', () => {
    const reg = new ProviderMiddlewareRegistry().loadBuiltins();

    it('provider-prompt-injector prepends a system message before next()', async () => {
        const mw = reg.build('provider-prompt-injector', {
            content: 'NATIVE PROMPT',
            position: 'prepend',
            role: 'system',
        });
        const ctx = makeCtx({
            request: {
                model: 'm',
                messages: [{ role: 'user', content: 'hi' }],
            },
        });
        await compose([mw, async () => {}])(ctx);

        assert.equal(ctx.request.messages.length, 2);
        assert.equal(ctx.request.messages[0].role, 'system');
        assert.equal(ctx.request.messages[0].content, 'NATIVE PROMPT');
        assert.equal(ctx.request.messages[1].role, 'user');
    });

    it('provider-prompt-injector appends a system message when position=append', async () => {
        const mw = reg.build('provider-prompt-injector', {
            content: 'TAIL',
            position: 'append',
        });
        const ctx = makeCtx({
            request: {
                model: 'm',
                messages: [{ role: 'user', content: 'hi' }],
            },
        });
        await compose([mw, async () => {}])(ctx);
        assert.equal(ctx.request.messages.length, 2);
        assert.equal(ctx.request.messages[1].content, 'TAIL');
    });

    it('provider-output-compressor truncates large tool messages', async () => {
        const longBlob = 'x'.repeat(20_000);
        const mw = reg.build('provider-output-compressor', {
            maxOutputLength: 1000,
        });
        const ctx = makeCtx({
            request: {
                model: 'm',
                messages: [{ role: 'tool', content: longBlob }],
            },
        });
        await compose([mw, async () => {}])(ctx);
        assert.ok(ctx.request.messages[0].content.length <= 1000);
        assert.ok(ctx.request.messages[0].content.includes('truncated'));
    });

    it('provider-output-compressor truncates multimodal text parts', async () => {
        const longText = 'y'.repeat(20_000);
        const mw = reg.build('provider-output-compressor', {
            maxOutputLength: 500,
        });
        const ctx = makeCtx({
            request: {
                model: 'm',
                messages: [
                    {
                        role: 'user',
                        content: [
                            { type: 'text', text: longText },
                            { type: 'text', text: 'short' },
                        ],
                    },
                ],
            },
        });
        await compose([mw, async () => {}])(ctx);
        const parts = ctx.request.messages[0].content;
        assert.ok(parts[0].text.length <= 500);
        assert.equal(parts[1].text, 'short');
    });

    it('provider-context-compacter compresses old messages above the budget', async () => {
        const messages = [];
        for (let i = 0; i < 20; i++) {
            messages.push({ role: 'user', content: 'word '.repeat(2000) });
        }
        const mw = reg.build('provider-context-compacter', {
            maxTokens: 100,
            preserveRecent: 2,
            charsPerToken: 4,
        });
        const ctx = makeCtx({ request: { model: 'm', messages } });
        await compose([mw, async () => {}])(ctx);
        assert.equal(ctx.request.messages.length, 3);
        assert.equal(ctx.request.messages[0].role, 'system');
        assert.ok(
            ctx.request.messages[0].content.includes(
                'Earlier context summarized'
            )
        );
    });

    it('provider-context-compacter is a no-op when below the budget', async () => {
        const messages = [{ role: 'user', content: 'short' }];
        const mw = reg.build('provider-context-compacter', {
            maxTokens: 100_000,
        });
        const ctx = makeCtx({
            request: { model: 'm', messages: [...messages] },
        });
        await compose([mw, async () => {}])(ctx);
        assert.equal(ctx.request.messages.length, 1);
        assert.equal(ctx.request.messages[0].content, 'short');
    });

    it('provider-response-filter redacts buffered choices content after next()', async () => {
        const mw = reg.build('provider-response-filter', {
            patterns: [{ find: 'secret', replace: '[REDACTED]', flags: 'g' }],
        });

        const dispatch = compose([
            mw,
            async (ctx) => {
                ctx.response = {
                    choices: [
                        {
                            index: 0,
                            message: {
                                role: 'assistant',
                                content: 'this has a secret token',
                            },
                        },
                    ],
                    usage: {
                        input_tokens: 1,
                        output_tokens: 5,
                        total_tokens: 6,
                    },
                };
            },
        ]);

        const ctx = makeCtx();
        await dispatch(ctx);
        assert.equal(
            ctx.response.choices[0].message.content,
            'this has a [REDACTED] token'
        );
    });

    it('provider-response-filter inline-buffers a canonical stream when needed', async () => {
        const mw = reg.build('provider-response-filter', {
            patterns: [{ find: 'hello', replace: 'HELLO', flags: 'g' }],
        });

        const dispatch = compose([
            mw,
            async (ctx) => {
                ctx.response = createCanonicalStream(sample('hello world'));
            },
        ]);

        const ctx = makeCtx();
        await dispatch(ctx);
        // Filter inline-buffered the stream and applied the regex
        assert.equal(ctx.response.content, 'HELLO world');
    });
});
