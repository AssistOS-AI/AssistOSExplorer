import { beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
    bufferCanonicalStream,
    compose,
    createCanonicalStream,
    createKernelContext,
} from '../../runtime/kernel/index.mjs';
import { mergeMiddlewareSettings } from '../../runtime/middleware/settings-merge.mjs';
import { MiddlewareCatalog } from '../../runtime/middleware/middleware-catalog.mjs';
import * as responseCache from '../../runtime/middleware/builtin/response-cache.mjs';
import * as rateLimiter from '../../runtime/middleware/builtin/rate-limiter.mjs';
import * as budgetEnforcer from '../../runtime/middleware/builtin/budget-enforcer.mjs';
import * as contentBlocker from '../../runtime/middleware/builtin/content-blocker.mjs';
import * as loopDetector from '../../runtime/middleware/builtin/loop-detector.mjs';
import * as systemPromptInjector from '../../runtime/middleware/builtin/system-prompt-injector.mjs';
import * as responseFilter from '../../runtime/middleware/builtin/response-filter.mjs';
import * as outputCompressor from '../../runtime/middleware/builtin/output-compressor.mjs';
import * as contextCompressor from '../../runtime/middleware/builtin/context-compressor.mjs';
import * as sessionContext from '../../runtime/middleware/builtin/session-context.mjs';
import * as tokenTracker from '../../runtime/middleware/builtin/token-tracker.mjs';
import * as requestLogger from '../../runtime/middleware/builtin/request-logger.mjs';
import { MiddlewareAbortError } from '../../core/errors.mjs';

const noopLog = {
    debug() {},
    info() {},
    warn() {},
    error() {},
    fatal() {},
};

function makeCtx(overrides = {}) {
    const appCtx = overrides.appCtx ?? {
        config: { env: {} },
        log: noopLog,
        services: overrides.services ?? {},
        pool: null,
    };

    return createKernelContext({
        requestId: 'req-test',
        request: {
            model: 'openai/gpt-4o',
            messages: [{ role: 'user', content: 'Hello' }],
            ...overrides.request,
        },
        response: overrides.response ?? null,
        auth: overrides.auth ?? {
            keyId: 'test-key',
            label: 'Test Key',
            rpmLimit: 60,
            tpmLimit: 100_000,
            apiKeyRecord: overrides.apiKeyRecord ?? {},
        },
        session: overrides.session ?? {
            id: null,
            key: 'test-key',
            explicitId: null,
            agentName: 'test-agent',
            soulId: null,
        },
        services: Object.freeze(overrides.services ?? appCtx.services ?? {}),
        log: overrides.log ?? noopLog,
        appCtx,
    });
}

async function runBuiltin(module, ctx, settings = {}, terminal = async () => {}) {
    const middleware = module.factory(
        mergeMiddlewareSettings(module.meta.defaultSettings || {}, settings)
    );
    await compose([middleware, terminal])(ctx);
}

function makeResponse(content = 'Hello back!') {
    return {
        id: 'chatcmpl-test',
        choices: [
            {
                message: { role: 'assistant', content },
                index: 0,
                finish_reason: 'stop',
            },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    };
}

describe('mergeMiddlewareSettings', () => {
    it('returns empty frozen object when both are null', () => {
        const result = mergeMiddlewareSettings(null, null);
        assert.deepEqual(result, {});
        assert.ok(Object.isFrozen(result));
    });

    it('deep merges overrides into defaults', () => {
        const result = mergeMiddlewareSettings(
            { a: 1, nested: { x: 10, y: 20 } },
            { nested: { y: 99 } }
        );
        assert.deepEqual(result, { a: 1, nested: { x: 10, y: 99 } });
    });

    it('treats null override values as keep-default', () => {
        const result = mergeMiddlewareSettings(
            { a: 1, nested: { x: 10, y: 20 } },
            { a: null, nested: { y: null } }
        );
        assert.deepEqual(result, { a: 1, nested: { x: 10, y: 20 } });
    });
});

describe('MiddlewareCatalog', () => {
    it('loads built-ins and builds middleware instances', async () => {
        const builtinDir = new URL(
            '../../runtime/middleware/builtin',
            import.meta.url
        ).pathname;
        const catalog = new MiddlewareCatalog({ builtinDir });

        const generation = await catalog.rescan({ builtinDir });
        assert.equal(generation, 1);
        assert.ok(catalog.getMiddleware('rate-limiter'));
        assert.equal(typeof catalog.getFactory('rate-limiter'), 'function');
        assert.equal(typeof catalog.build('rate-limiter', {}), 'function');
    });

    it('resolves gateway bindings into a native middleware chain', async () => {
        const builtinDir = new URL(
            '../../runtime/middleware/builtin',
            import.meta.url
        ).pathname;
        const catalog = new MiddlewareCatalog({ builtinDir });
        await catalog.rescan({ builtinDir });

        const snapshot = {
            middlewareBindings: {
                gateway: Object.freeze([
                    {
                        middlewareKey: 'rate-limiter',
                        settings: {},
                        middlewareDefaultSettings: {},
                    },
                    {
                        middlewareKey: 'content-blocker',
                        settings: {},
                        middlewareDefaultSettings: {},
                    },
                ]),
                byModel: new Map([
                    [
                        'model-1',
                        Object.freeze([
                            {
                                middlewareKey: 'response-cache',
                                settings: { ttlMs: 60_000 },
                                middlewareDefaultSettings:
                                    responseCache.meta.defaultSettings,
                            },
                        ]),
                    ],
                ]),
            },
        };

        const chain = catalog.resolveGatewayChain({
            modelId: 'model-1',
            snapshot,
        });

        assert.equal(chain.length, 3);
        for (const middleware of chain) {
            assert.equal(typeof middleware, 'function');
        }
    });

    it('supports generation promotion and expiry', () => {
        const catalog = new MiddlewareCatalog();
        assert.equal(catalog.generation, 0);
        assert.equal(catalog.promoteGeneration(), 1);
        assert.equal(catalog.hasPreviousGeneration, true);
        catalog.expirePreviousGeneration();
        assert.equal(catalog.hasPreviousGeneration, false);
    });
});

describe('builtin: response-cache', () => {
    beforeEach(() => {
        responseCache._resetCache();
    });

    it('stores a response and replays it on the next identical request', async () => {
        const ctx1 = makeCtx();
        await runBuiltin(responseCache, ctx1, {}, async (innerCtx) => {
            innerCtx.response = makeResponse('cached');
        });
        assert.equal(ctx1.response.choices[0].message.content, 'cached');
        assert.equal(ctx1.metadata.cacheHit, false);

        let terminalCalls = 0;
        const ctx2 = makeCtx();
        await runBuiltin(responseCache, ctx2, {}, async () => {
            terminalCalls++;
        });

        assert.equal(terminalCalls, 0);
        assert.equal(ctx2.response.choices[0].message.content, 'cached');
        assert.equal(ctx2.metadata.cacheHit, true);
    });

    it('keeps streaming and buffered requests in separate cache entries', async () => {
        const bufferedCtx = makeCtx({ request: { stream: false } });
        await runBuiltin(responseCache, bufferedCtx, {}, async (innerCtx) => {
            innerCtx.response = makeResponse('buffered');
        });

        let terminalCalls = 0;
        const streamingCtx = makeCtx({ request: { stream: true } });
        await runBuiltin(responseCache, streamingCtx, {}, async (innerCtx) => {
            terminalCalls++;
            innerCtx.response = createCanonicalStream(sampleEvents('streamed'));
        });

        assert.equal(terminalCalls, 1);
        assert.equal(streamingCtx.metadata.cacheHit, false);
        const buffered = await bufferCanonicalStream(streamingCtx.response);
        assert.equal(buffered.message.content, 'streamed');
    });

    it('replays cached streaming responses without reusing the one-shot source stream', async () => {
        let terminalCalls = 0;

        const ctx1 = makeCtx({ request: { stream: true } });
        await runBuiltin(responseCache, ctx1, {}, async (innerCtx) => {
            terminalCalls++;
            innerCtx.response = createCanonicalStream(sampleEvents('stream-1'));
        });
        const first = await bufferCanonicalStream(ctx1.response);
        assert.equal(first.message.content, 'stream-1');
        assert.equal(ctx1.metadata.cacheHit, false);

        const ctx2 = makeCtx({ request: { stream: true } });
        await runBuiltin(responseCache, ctx2, {}, async () => {
            terminalCalls++;
        });
        const second = await bufferCanonicalStream(ctx2.response);

        assert.equal(terminalCalls, 1);
        assert.equal(second.message.content, 'stream-1');
        assert.equal(ctx2.metadata.cacheHit, true);
    });
});

async function* sampleEvents(text = 'Hello world') {
    yield {
        type: 'message_start',
        data: { id: 'm1', model: 'gpt-test', role: 'assistant' },
    };
    yield { type: 'text_delta', data: { text } };
    yield {
        type: 'usage',
        data: { input_tokens: 5, output_tokens: 4, total_tokens: 9 },
    };
    yield { type: 'done', data: { finish_reason: 'stop', model: 'gpt-test' } };
}

describe('builtin: rate-limiter', () => {
    beforeEach(() => {
        rateLimiter._resetWindows();
    });

    it('allows requests within the configured limit', async () => {
        const ctx = makeCtx();
        for (let idx = 0; idx < 5; idx++) {
            await runBuiltin(rateLimiter, ctx, {
                overrideRpmLimit: 5,
                windowMs: 60_000,
            });
        }
    });

    it('blocks requests that exceed the configured limit', async () => {
        const ctx = makeCtx();
        for (let idx = 0; idx < 3; idx++) {
            await runBuiltin(rateLimiter, ctx, {
                overrideRpmLimit: 3,
                windowMs: 60_000,
            });
        }

        await assert.rejects(
            () =>
                runBuiltin(rateLimiter, ctx, {
                    overrideRpmLimit: 3,
                    windowMs: 60_000,
                }),
            (err) => err instanceof MiddlewareAbortError && err.httpStatus === 429
        );
    });
});

function makeMockSpendCache(dailySpend = 0, monthlySpend = 0) {
    let daily = dailySpend;
    let monthly = monthlySpend;
    return {
        getDailySpend() {
            return daily;
        },
        getMonthlySpend() {
            return monthly;
        },
        async refresh() {},
        recordCost(_keyId, cost) {
            daily += cost;
            monthly += cost;
        },
        _getDaily() {
            return daily;
        },
    };
}

describe('builtin: budget-enforcer', () => {
    it('blocks when the daily budget is exceeded', async () => {
        const ctx = makeCtx({
            services: { spendCache: makeMockSpendCache(10, 10) },
        });

        await assert.rejects(
            () =>
                runBuiltin(budgetEnforcer, ctx, {
                    overrideDailyBudget: 5,
                }),
            (err) => err instanceof MiddlewareAbortError && err.httpStatus === 429
        );
    });

    it('records cost after a successful request', async () => {
        const cache = makeMockSpendCache(0, 0);
        const ctx = makeCtx({
            services: { spendCache: cache },
        });

        await runBuiltin(budgetEnforcer, ctx, {}, async (innerCtx) => {
            innerCtx.response = {
                usage: {
                    cost: 0.05,
                },
            };
        });

        assert.equal(cache._getDaily(), 0.05);
    });
});

describe('builtin: content-blocker', () => {
    it('blocks when a rule matches', async () => {
        const ctx = makeCtx({
            request: {
                messages: [
                    { role: 'user', content: 'This contains FORBIDDEN text' },
                ],
            },
        });

        await assert.rejects(
            () =>
                runBuiltin(contentBlocker, ctx, {
                    rules: [
                        {
                            pattern: 'forbidden',
                            flags: 'i',
                            description: 'Blocked content',
                        },
                    ],
                }),
            (err) => err instanceof MiddlewareAbortError && err.httpStatus === 400
        );
    });

    it('ignores invalid regex patterns', async () => {
        const warnings = [];
        const ctx = makeCtx({
            log: { ...noopLog, warn: (...args) => warnings.push(args) },
        });
        await runBuiltin(contentBlocker, ctx, {
            rules: [{ pattern: '[invalid(', description: 'bad regex' }],
        });
        assert.ok(warnings.length > 0);
    });
});

describe('builtin: loop-detector', () => {
    beforeEach(() => {
        loopDetector._resetSessions();
    });

    it('injects an intervention message in intervene mode', async () => {
        loopDetector._setSession('sess-loop', {
            fingerprints: Array(5).fill('abcdef1234567890'),
            totalTokens: [0, 100, 200, 300, 400],
        });
        const ctx = makeCtx({
            session: { key: 'sess-loop' },
            request: {
                model: 'test',
                messages: [{ role: 'user', content: 'Do something' }],
            },
        });

        await runBuiltin(loopDetector, ctx, {
            mode: 'intervene',
            repetitiveRatio: 0.5,
        });

        assert.ok(
            ctx.request.messages.some(
                (message) =>
                    message.role === 'system' &&
                    message.content.includes('LOOP DETECTED')
            )
        );
    });

    it('records response fingerprints after a successful request', async () => {
        const ctx = makeCtx({ session: { key: 'sess-fp' } });
        await runBuiltin(loopDetector, ctx, {}, async (innerCtx) => {
            innerCtx.response = makeResponse('Some response text');
        });

        const session = loopDetector._getSession('sess-fp');
        assert.equal(session.fingerprints.length, 1);
        assert.equal(session.totalTokens.length, 1);
    });
});

describe('builtin: system-prompt-injector', () => {
    it('prepends or appends messages based on settings', async () => {
        const prependCtx = makeCtx({
            request: { messages: [{ role: 'user', content: 'Hello' }] },
        });
        await runBuiltin(systemPromptInjector, prependCtx, {
            content: 'You are helpful.',
            position: 'prepend',
            role: 'system',
        });
        assert.equal(prependCtx.request.messages[0].content, 'You are helpful.');

        const appendCtx = makeCtx({
            request: { messages: [{ role: 'user', content: 'Hello' }] },
        });
        await runBuiltin(systemPromptInjector, appendCtx, {
            content: 'Be concise.',
            position: 'append',
            role: 'system',
        });
        assert.equal(
            appendCtx.request.messages[appendCtx.request.messages.length - 1]
                .content,
            'Be concise.'
        );
    });
});

describe('builtin: response-filter', () => {
    it('applies regex replacements to buffered responses', async () => {
        const ctx = makeCtx();
        await runBuiltin(responseFilter, ctx, {
            patterns: [
                {
                    find: '\\d{3}-\\d{2}-\\d{4}',
                    replace: '[REDACTED]',
                    flags: 'g',
                },
            ],
        }, async (innerCtx) => {
            innerCtx.response = makeResponse('This has SSN 123-45-6789 in it');
        });

        assert.equal(
            ctx.response.choices[0].message.content,
            'This has SSN [REDACTED] in it'
        );
    });
});

describe('builtin: output-compressor', () => {
    it('truncates oversized tool outputs', async () => {
        const ctx = makeCtx({
            request: {
                messages: [
                    { role: 'tool', content: 'x'.repeat(10_000) },
                    { role: 'user', content: 'Summarize that.' },
                ],
            },
        });

        await runBuiltin(outputCompressor, ctx, {
            maxOutputLength: 500,
            truncationMarker: '[TRUNCATED]',
        });

        assert.ok(ctx.request.messages[0].content.length <= 500);
        assert.ok(ctx.request.messages[0].content.endsWith('[TRUNCATED]'));
    });
});

describe('builtin: context-compressor', () => {
    it('summarizes older messages when the prompt is too large', async () => {
        const ctx = makeCtx({
            request: {
                messages: [
                    { role: 'system', content: 'rules' },
                    { role: 'user', content: 'a'.repeat(500) },
                    { role: 'assistant', content: 'b'.repeat(500) },
                    { role: 'user', content: 'c'.repeat(500) },
                ],
            },
        });

        await runBuiltin(contextCompressor, ctx, {
            maxTokens: 100,
            preserveRecent: 1,
        });

        assert.ok(ctx.request.messages.length < 4);
        assert.ok(
            ctx.request.messages.some((message) =>
                String(message.content).includes('Earlier context summarized')
            )
        );
    });
});

describe('builtin: session-context', () => {
    beforeEach(() => {
        sessionContext._resetSummaries();
    });

    it('injects existing summaries and updates them after response', async () => {
        sessionContext._setSummary('sess-1', 'Known facts');
        const ctx = makeCtx({
            session: { key: 'sess-1' },
            request: { messages: [{ role: 'user', content: 'Hello' }] },
        });

        await runBuiltin(sessionContext, ctx, {}, async (innerCtx) => {
            innerCtx.response = makeResponse('Fresh answer');
        });

        assert.equal(ctx.request.messages[0].role, 'system');
        assert.ok(ctx.request.messages[0].content.includes('Known facts'));
        assert.ok(sessionContext._getSummary('sess-1').includes('Fresh answer'));
    });
});

describe('builtin: token-tracker', () => {
    beforeEach(() => {
        tokenTracker._resetTpm();
    });

    it('records token usage after the response', async () => {
        const ctx = makeCtx();
        await runBuiltin(tokenTracker, ctx, {}, async (innerCtx) => {
            innerCtx.response = {
                usage: {
                    total_tokens: 42,
                },
            };
        });

        assert.equal(tokenTracker._getTpm('test-key').length, 1);
        assert.equal(tokenTracker._getTpm('test-key')[0].tokens, 42);
    });
});

describe('builtin: request-logger', () => {
    it('logs request start and completion', async () => {
        const entries = [];
        const ctx = makeCtx({
            log: {
                ...noopLog,
                info(message, meta) {
                    entries.push({ message, meta });
                },
            },
        });

        await runBuiltin(requestLogger, ctx, {}, async (innerCtx) => {
            innerCtx.response = makeResponse('done');
        });

        assert.equal(entries.length, 2);
        assert.equal(entries[0].message, 'Request start');
        assert.equal(entries[1].message, 'Request complete');
    });
});
