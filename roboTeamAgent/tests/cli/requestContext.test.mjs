/**
 * Tests for RequestContext module.
 *
 * Tests request lifecycle management, abort handling, and context propagation.
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert';

describe('RequestContext', () => {
    let RequestContext, abortableTimeout, raceWithAbort, withRequestContext;

    beforeEach(async () => {
        const module = await import('../skill-manager/src/lib/RequestContext.mjs');
        RequestContext = module.RequestContext;
        abortableTimeout = module.abortableTimeout;
        raceWithAbort = module.raceWithAbort;
        withRequestContext = module.withRequestContext;

        // Clear any existing current context
        RequestContext.current = null;
    });

    describe('constructor', () => {
        it('should create context with metadata', () => {
            const ctx = new RequestContext({ skillName: 'test-skill' });

            assert.ok(ctx.metadata.skillName === 'test-skill');
            assert.ok(ctx.metadata.createdAt);
        });

        it('should have signal property', () => {
            const ctx = new RequestContext();

            assert.ok(ctx.signal instanceof AbortSignal);
        });

        it('should start with elapsed time near zero', () => {
            const ctx = new RequestContext();

            assert.ok(ctx.elapsed >= 0);
            assert.ok(ctx.elapsed < 100);
        });

        it('should not be aborted initially', () => {
            const ctx = new RequestContext();

            assert.strictEqual(ctx.aborted, false);
            assert.strictEqual(ctx.abortReason, undefined);
        });
    });

    describe('abort', () => {
        it('should abort the context', () => {
            const ctx = new RequestContext();

            ctx.abort('Test reason');

            assert.strictEqual(ctx.aborted, true);
            assert.strictEqual(ctx.abortReason, 'Test reason');
        });

        it('should use default reason', () => {
            const ctx = new RequestContext();

            ctx.abort();

            assert.strictEqual(ctx.aborted, true);
            assert.strictEqual(ctx.abortReason, 'User cancelled');
        });

        it('should only abort once', () => {
            const ctx = new RequestContext();

            ctx.abort('First');
            ctx.abort('Second');

            assert.strictEqual(ctx.abortReason, 'First');
        });
    });

    describe('throwIfAborted', () => {
        it('should not throw if not aborted', () => {
            const ctx = new RequestContext({ skillName: 'test' });

            // Should not throw
            ctx.throwIfAborted();
        });

        it('should throw SkillExecutionCancelledError if aborted', () => {
            const ctx = new RequestContext({ skillName: 'test-skill' });
            ctx.abort();

            assert.throws(
                () => ctx.throwIfAborted(),
                /cancelled/i
            );
        });
    });

    describe('child context', () => {
        it('should create child with inherited metadata', () => {
            const parent = new RequestContext({ skillName: 'parent' });
            const child = parent.child({ step: 'validation' });

            assert.strictEqual(child.metadata.skillName, 'parent');
            assert.strictEqual(child.metadata.step, 'validation');
        });

        it('should abort child when parent aborts', () => {
            const parent = new RequestContext();
            const child = parent.child();

            parent.abort('Parent aborted');

            assert.strictEqual(child.aborted, true);
            assert.strictEqual(child.abortReason, 'Parent aborted');
        });

        it('should not abort parent when child aborts', () => {
            const parent = new RequestContext();
            const child = parent.child();

            child.abort('Child aborted');

            assert.strictEqual(child.aborted, true);
            assert.strictEqual(parent.aborted, false);
        });
    });

    describe('addMetadata', () => {
        it('should add metadata to context', () => {
            const ctx = new RequestContext({ initial: 'value' });

            ctx.addMetadata({ added: 'later' });

            assert.strictEqual(ctx.metadata.initial, 'value');
            assert.strictEqual(ctx.metadata.added, 'later');
        });

        it('should return this for chaining', () => {
            const ctx = new RequestContext();

            const result = ctx.addMetadata({ key: 'value' });

            assert.strictEqual(result, ctx);
        });
    });

    describe('toJSON', () => {
        it('should serialize context state', () => {
            const ctx = new RequestContext({ skillName: 'test' });
            const json = ctx.toJSON();

            assert.ok('elapsed' in json);
            assert.strictEqual(json.aborted, false);
            assert.strictEqual(json.metadata.skillName, 'test');
        });
    });

    describe('run and runAsync', () => {
        it('should set current context during execution', () => {
            const ctx = new RequestContext({ id: '123' });

            let capturedCurrent = null;
            ctx.run(() => {
                capturedCurrent = RequestContext.current;
            });

            assert.strictEqual(capturedCurrent, ctx);
            assert.strictEqual(RequestContext.current, null);
        });

        it('should restore previous context after execution', () => {
            const outer = new RequestContext({ id: 'outer' });
            const inner = new RequestContext({ id: 'inner' });

            outer.run(() => {
                inner.run(() => {
                    assert.strictEqual(RequestContext.current, inner);
                });
                assert.strictEqual(RequestContext.current, outer);
            });
        });

        it('should handle async execution', async () => {
            const ctx = new RequestContext({ id: '123' });

            let capturedCurrent = null;
            await ctx.runAsync(async () => {
                capturedCurrent = RequestContext.current;
                await new Promise(resolve => setTimeout(resolve, 10));
            });

            assert.strictEqual(capturedCurrent, ctx);
        });
    });

    describe('static methods', () => {
        it('withContext should create and run with new context', () => {
            let capturedContext = null;
            const result = RequestContext.withContext({ test: true }, (ctx) => {
                capturedContext = ctx;
                return 'result';
            });

            assert.ok(capturedContext instanceof RequestContext);
            assert.strictEqual(capturedContext.metadata.test, true);
            assert.strictEqual(result, 'result');
        });

        it('withContextAsync should work with async functions', async () => {
            const result = await RequestContext.withContextAsync({ async: true }, async (ctx) => {
                await new Promise(resolve => setTimeout(resolve, 10));
                return ctx.metadata.async;
            });

            assert.strictEqual(result, true);
        });

        it('getOrCreate should return current context if exists', () => {
            const existing = new RequestContext({ existing: true });
            RequestContext.current = existing;

            const result = RequestContext.getOrCreate({ new: true });

            assert.strictEqual(result, existing);

            RequestContext.current = null;
        });

        it('getOrCreate should create new context if none exists', () => {
            RequestContext.current = null;

            const result = RequestContext.getOrCreate({ new: true });

            assert.ok(result instanceof RequestContext);
            assert.strictEqual(result.metadata.new, true);
        });
    });
});

describe('Utility functions', () => {
    let abortableTimeout, raceWithAbort, withRequestContext;

    beforeEach(async () => {
        const module = await import('../skill-manager/src/lib/RequestContext.mjs');
        abortableTimeout = module.abortableTimeout;
        raceWithAbort = module.raceWithAbort;
        withRequestContext = module.withRequestContext;
    });

    describe('abortableTimeout', () => {
        it('should resolve after timeout', async () => {
            const start = Date.now();
            await abortableTimeout(50);
            const elapsed = Date.now() - start;

            assert.ok(elapsed >= 45, `Expected >= 45ms, got ${elapsed}ms`);
        });

        it('should reject if signal is already aborted', async () => {
            const controller = new AbortController();
            controller.abort('Already aborted');

            await assert.rejects(
                abortableTimeout(1000, controller.signal),
                /Already aborted|Aborted/
            );
        });

        it('should reject when signal aborts', async () => {
            const controller = new AbortController();

            const promise = abortableTimeout(1000, controller.signal);
            setTimeout(() => controller.abort('Cancelled'), 10);

            await assert.rejects(promise, /Cancelled|Aborted/);
        });
    });

    describe('raceWithAbort', () => {
        it('should resolve with promise result if not aborted', async () => {
            const controller = new AbortController();
            const promise = Promise.resolve('success');

            const result = await raceWithAbort(promise, controller.signal);

            assert.strictEqual(result, 'success');
        });

        it('should reject if already aborted', async () => {
            const controller = new AbortController();
            controller.abort('Pre-aborted');

            const promise = new Promise(resolve => setTimeout(() => resolve('success'), 1000));

            await assert.rejects(
                raceWithAbort(promise, controller.signal),
                /Pre-aborted|Aborted/
            );
        });

        it('should reject when signal aborts before promise resolves', async () => {
            const controller = new AbortController();
            const promise = new Promise(resolve => setTimeout(() => resolve('success'), 1000));

            setTimeout(() => controller.abort('Cancelled'), 10);

            await assert.rejects(
                raceWithAbort(promise, controller.signal),
                /Cancelled|Aborted/
            );
        });
    });

    describe('withRequestContext', () => {
        it('should wrap function with context', async () => {
            const fn = async () => 'result';
            const wrapped = withRequestContext(fn, { wrapped: true });

            const result = await wrapped();

            assert.strictEqual(result, 'result');
        });
    });
});
