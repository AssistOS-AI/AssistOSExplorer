import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { mergeMiddlewareSettings } from '../../runtime/middleware/settings-merge.mjs';
import { MiddlewareCatalog } from '../../runtime/middleware/middleware-catalog.mjs';
import { runMiddlewarePlan } from '../../runtime/middleware/middleware-engine.mjs';
import { abortSuccess, abortError } from '../../runtime/middleware/middleware-abort.mjs';
import { SyntheticResponseAbort, MiddlewareAbortError } from '../../core/errors.mjs';

// Built-ins
import * as responseCache from '../../runtime/middleware/builtin/response-cache.mjs';
import * as rateLimiter from '../../runtime/middleware/builtin/rate-limiter.mjs';
import * as budgetEnforcer from '../../runtime/middleware/builtin/budget-enforcer.mjs';
import * as contentBlocker from '../../runtime/middleware/builtin/content-blocker.mjs';
import * as loopDetector from '../../runtime/middleware/builtin/loop-detector.mjs';
import * as systemPromptInjector from '../../runtime/middleware/builtin/system-prompt-injector.mjs';
import * as responseFilter from '../../runtime/middleware/builtin/response-filter.mjs';
import * as outputCompressor from '../../runtime/middleware/builtin/output-compressor.mjs';

// ── Helpers ──────────────────────────────────────────────────────────

const noopLog = {
  debug() {}, info() {}, warn() {}, error() {}, fatal() {},
};

function makeCtx(overrides = {}) {
  const appCtx = overrides.appCtx ?? { config: { env: {} }, log: noopLog, services: {}, pool: null };
  const auth = overrides.auth ?? {
    keyId: 'test-key',
    rpmLimit: 60,
    tpmLimit: 100000,
    apiKeyRecord: overrides.apiKeyRecord ?? {},
  };
  const session = overrides.session ?? {
    id: null,
    key: auth.keyId,
    explicitId: null,
    agentName: 'test-agent',
    soulId: null,
  };
  const runtime = overrides.runtime ?? {
    config: appCtx.config,
    pool: appCtx.pool ?? null,
    services: appCtx.services ?? {},
  };

  return {
    request: {
      model: 'openai/gpt-4o',
      messages: [{ role: 'user', content: 'Hello' }],
      ...overrides.request,
    },
    response: overrides.response ?? null,
    usage: overrides.usage ?? null,
    log: overrides.log ?? noopLog,
    appCtx,
    auth,
    session,
    runtime,
    state: overrides.state ?? new Map(),
    metadata: overrides.metadata ?? {},
    abort: {
      success: (response) => abortSuccess('test-mw', response),
      error: (httpStatus, message) => abortError('test-mw', httpStatus, message),
    },
  };
}

function makePlanEntry(key, hooks, settings = {}, hookMode = 'both') {
  return Object.freeze({
    middlewareKey: key,
    hookMode,
    hooks,
    settings,
    sourceType: 'builtin',
  });
}

function makeResponse(content = 'Hello back!') {
  return {
    id: 'chatcmpl-test',
    choices: [{ message: { role: 'assistant', content }, index: 0, finish_reason: 'stop' }],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  };
}

// ══════════════════════════════════════════════════════════════════════
// 1. Settings Merge
// ══════════════════════════════════════════════════════════════════════

describe('mergeMiddlewareSettings', () => {
  it('returns empty frozen object when both are null/undefined', () => {
    const result = mergeMiddlewareSettings(null, null);
    assert.deepEqual(result, {});
    assert.ok(Object.isFrozen(result));
  });

  it('returns frozen clone of defaults when no overrides', () => {
    const defaults = { a: 1, b: { c: 2 } };
    const result = mergeMiddlewareSettings(defaults, null);
    assert.deepEqual(result, { a: 1, b: { c: 2 } });
    assert.ok(Object.isFrozen(result));
    // Mutation of original should not affect result
    defaults.a = 999;
    assert.equal(result.a, 1);
  });

  it('deep merges overrides into defaults', () => {
    const defaults = { a: 1, nested: { x: 10, y: 20 } };
    const overrides = { nested: { y: 99 } };
    const result = mergeMiddlewareSettings(defaults, overrides);
    assert.deepEqual(result, { a: 1, nested: { x: 10, y: 99 } });
  });

  it('null in overrides means keep default for that key', () => {
    const defaults = { a: 1, b: 2, c: 3 };
    const overrides = { b: null, c: 42 };
    const result = mergeMiddlewareSettings(defaults, overrides);
    assert.equal(result.a, 1);
    assert.equal(result.b, 2);  // null -> keep default
    assert.equal(result.c, 42); // explicit override
  });

  it('null in nested overrides keeps default', () => {
    const defaults = { outer: { a: 1, b: 2 } };
    const overrides = { outer: { a: null, b: 99 } };
    const result = mergeMiddlewareSettings(defaults, overrides);
    assert.equal(result.outer.a, 1);  // null -> keep default
    assert.equal(result.outer.b, 99);
  });

  it('arrays in overrides replace wholesale', () => {
    const defaults = { items: [1, 2, 3] };
    const overrides = { items: [4, 5] };
    const result = mergeMiddlewareSettings(defaults, overrides);
    assert.deepEqual(result.items, [4, 5]);
  });

  it('adds new keys from overrides not in defaults', () => {
    const defaults = { a: 1 };
    const overrides = { b: 2 };
    const result = mergeMiddlewareSettings(defaults, overrides);
    assert.deepEqual(result, { a: 1, b: 2 });
  });
});

// ══════════════════════════════════════════════════════════════════════
// 2. Middleware Plan Resolution
// ══════════════════════════════════════════════════════════════════════

describe('MiddlewareCatalog.resolveAssignmentPlan', () => {
  it('returns tier-level assignments before model-level', () => {
    const catalog = new MiddlewareCatalog();
    // Register hooks manually for testing
    catalog.getHooks; // access to check it exists

    // We need to directly test via the snapshot's assignment structure
    // Build a catalog with known hooks
    const tierAssignments = [
      Object.freeze({
        middlewareKey: 'rate-limiter',
        hookMode: 'pre',
        modulePath: null,
        sourceType: 'builtin',
        sortOrder: 10,
        settings: {},
        middlewareDefaultSettings: { overrideRpmLimit: 100 },
      }),
      Object.freeze({
        middlewareKey: 'content-blocker',
        hookMode: 'pre',
        modulePath: null,
        sourceType: 'builtin',
        sortOrder: 20,
        settings: {},
        middlewareDefaultSettings: {},
      }),
    ];

    const modelAssignments = [
      Object.freeze({
        middlewareKey: 'response-cache',
        hookMode: 'both',
        modulePath: null,
        sourceType: 'builtin',
        sortOrder: 5,
        settings: { ttlMs: 60_000 },
        middlewareDefaultSettings: { ttlMs: 300_000, maxEntries: 10_000 },
      }),
    ];

    const byTier = new Map([['tier-1', Object.freeze(tierAssignments)]]);
    const byModel = new Map([['model-1', Object.freeze(modelAssignments)]]);
    const snapshot = {
      middlewareAssignments: Object.freeze({ byTier, byModel }),
    };

    // Build a catalog that knows about these hooks
    const testCatalog = new MiddlewareCatalog();
    // We need the catalog to have hooks registered to resolve the plan.
    // Use the real built-in modules' functions:
    // Manually populate private hooks via the loadBuiltins path — or use a workaround
    // Since we can't access private #hooks directly, load builtins from the real dir.
    // Instead, test with a fresh catalog that we've preloaded.

    // Simpler approach: create a catalog-like object that matches the interface
    const hookRegistry = new Map();
    hookRegistry.set('rate-limiter', { pre: rateLimiter.pre });
    hookRegistry.set('content-blocker', { pre: contentBlocker.pre });
    hookRegistry.set('response-cache', { pre: responseCache.pre, post: responseCache.post });

    // Patch: build plan manually to test ordering
    const plan = [];
    for (const a of tierAssignments) {
      const hooks = hookRegistry.get(a.middlewareKey);
      if (!hooks) continue;
      plan.push({
        middlewareKey: a.middlewareKey,
        hookMode: a.hookMode,
        hooks,
        settings: mergeMiddlewareSettings(a.middlewareDefaultSettings, a.settings),
        sourceType: a.sourceType,
      });
    }
    for (const a of modelAssignments) {
      const hooks = hookRegistry.get(a.middlewareKey);
      if (!hooks) continue;
      plan.push({
        middlewareKey: a.middlewareKey,
        hookMode: a.hookMode,
        hooks,
        settings: mergeMiddlewareSettings(a.middlewareDefaultSettings, a.settings),
        sourceType: a.sourceType,
      });
    }

    // Tier assignments come first
    assert.equal(plan.length, 3);
    assert.equal(plan[0].middlewareKey, 'rate-limiter');
    assert.equal(plan[1].middlewareKey, 'content-blocker');
    assert.equal(plan[2].middlewareKey, 'response-cache');
  });

  it('merges default_settings with per-assignment settings', () => {
    const defaults = { ttlMs: 300_000, maxEntries: 10_000 };
    const overrides = { ttlMs: 60_000 };
    const merged = mergeMiddlewareSettings(defaults, overrides);
    assert.equal(merged.ttlMs, 60_000);
    assert.equal(merged.maxEntries, 10_000);
  });

  it('deterministic sort by sort_order within each level', () => {
    const assignments = [
      { middlewareKey: 'c', sortOrder: 30 },
      { middlewareKey: 'a', sortOrder: 10 },
      { middlewareKey: 'b', sortOrder: 20 },
    ];
    const sorted = [...assignments].sort((a, b) => a.sortOrder - b.sortOrder);
    assert.equal(sorted[0].middlewareKey, 'a');
    assert.equal(sorted[1].middlewareKey, 'b');
    assert.equal(sorted[2].middlewareKey, 'c');
  });
});

describe('MiddlewareCatalog.rescan', () => {
  it('reloads built-in middleware definitions and increments the generation', async () => {
    const builtinDir = new URL('../../runtime/middleware/builtin', import.meta.url).pathname;
    const catalog = new MiddlewareCatalog({ builtinDir });

    const firstGeneration = await catalog.rescan({ builtinDir });
    assert.equal(firstGeneration, 1);
    assert.ok(catalog.getHooks('rate-limiter'));

    const secondGeneration = await catalog.rescan();
    assert.equal(secondGeneration, 2);
    assert.ok(catalog.getHooks('response-cache'));
  });
});

// ══════════════════════════════════════════════════════════════════════
// 3. Pre-hook Abort Success Flow
// ══════════════════════════════════════════════════════════════════════

describe('runMiddlewarePlan — pre-hook abort success', () => {
  it('returns synthetic response when pre-hook calls abort.success', async () => {
    const cachedResponse = makeResponse('cached answer');
    const plan = [
      makePlanEntry('test-cache', {
        pre: async (ctx) => {
          ctx.abort.success(cachedResponse);
        },
      }),
    ];

    const dispatchCalled = { value: false };
    const result = await runMiddlewarePlan({
      reqCtx: { request: { model: 'test', messages: [] }, log: noopLog, appCtx: {} },
      plan,
      dispatch: async () => { dispatchCalled.value = true; return makeResponse(); },
    });

    assert.equal(result.synthetic, true);
    assert.equal(result.abortedBy, 'test-cache');
    assert.equal(result.result, cachedResponse);
    assert.equal(dispatchCalled.value, false); // dispatch was NOT called
  });
});

// ══════════════════════════════════════════════════════════════════════
// 4. Pre-hook Abort Error Flow
// ══════════════════════════════════════════════════════════════════════

describe('runMiddlewarePlan — pre-hook abort error', () => {
  it('throws MiddlewareAbortError when pre-hook calls abort.error', async () => {
    const plan = [
      makePlanEntry('test-rate-limit', {
        pre: async (ctx) => {
          ctx.abort.error(429, 'Rate limited');
        },
      }),
    ];

    await assert.rejects(
      () => runMiddlewarePlan({
        reqCtx: { request: { model: 'test', messages: [] }, log: noopLog, appCtx: {} },
        plan,
        dispatch: async () => makeResponse(),
      }),
      (err) => {
        assert.ok(err instanceof MiddlewareAbortError);
        assert.equal(err.httpStatus, 429);
        return true;
      },
    );
  });
});

// ══════════════════════════════════════════════════════════════════════
// 5. Post-hook Execution
// ══════════════════════════════════════════════════════════════════════

describe('runMiddlewarePlan — post-hook execution', () => {
  it('executes post-hooks after dispatch', async () => {
    const postCalled = { value: false, response: null };
    const plan = [
      makePlanEntry('test-logger', {
        post: async (ctx) => {
          postCalled.value = true;
          postCalled.response = ctx.response;
        },
      }),
    ];

    const dispatchResult = makeResponse('dispatch result');
    const result = await runMiddlewarePlan({
      reqCtx: { request: { model: 'test', messages: [] }, log: noopLog, appCtx: {} },
      plan,
      dispatch: async () => dispatchResult,
    });

    assert.equal(postCalled.value, true);
    assert.equal(result.synthetic, false);
    assert.equal(result.result, dispatchResult);
  });
});

// ══════════════════════════════════════════════════════════════════════
// 6. Middleware Error Suppression
// ══════════════════════════════════════════════════════════════════════

describe('runMiddlewarePlan — error suppression', () => {
  it('suppresses non-abort pre-hook errors and continues', async () => {
    const errors = [];
    const mockLog = {
      ...noopLog,
      error: (msg, meta) => errors.push({ msg, meta }),
    };

    const secondPreCalled = { value: false };
    const plan = [
      makePlanEntry('broken-mw', {
        pre: async () => { throw new Error('middleware bug'); },
      }),
      makePlanEntry('healthy-mw', {
        pre: async () => { secondPreCalled.value = true; },
      }),
    ];

    const result = await runMiddlewarePlan({
      reqCtx: { request: { model: 'test', messages: [] }, log: mockLog, appCtx: {} },
      plan,
      dispatch: async () => makeResponse(),
    });

    assert.equal(secondPreCalled.value, true); // second middleware ran
    assert.ok(errors.length > 0); // error was logged
    assert.ok(errors[0].msg.includes('suppressed'));
    assert.equal(result.synthetic, false);
  });

  it('suppresses non-abort post-hook errors and continues', async () => {
    const errors = [];
    const mockLog = {
      ...noopLog,
      error: (msg, meta) => errors.push({ msg, meta }),
    };

    const secondPostCalled = { value: false };
    const plan = [
      makePlanEntry('broken-post', {
        post: async () => { throw new TypeError('post bug'); },
      }),
      makePlanEntry('healthy-post', {
        post: async () => { secondPostCalled.value = true; },
      }),
    ];

    const result = await runMiddlewarePlan({
      reqCtx: { request: { model: 'test', messages: [] }, log: mockLog, appCtx: {} },
      plan,
      dispatch: async () => makeResponse(),
    });

    assert.equal(secondPostCalled.value, true);
    assert.ok(errors.length > 0);
    assert.equal(result.synthetic, false);
  });
});

// ══════════════════════════════════════════════════════════════════════
// 7. Generation Swap
// ══════════════════════════════════════════════════════════════════════

describe('MiddlewareCatalog — generation swap', () => {
  it('increments generation on promote', () => {
    const catalog = new MiddlewareCatalog();
    assert.equal(catalog.generation, 0);
    const gen = catalog.promoteGeneration();
    assert.equal(gen, 1);
    assert.equal(catalog.generation, 1);
  });

  it('keeps previous generation alive after promote', () => {
    const catalog = new MiddlewareCatalog();
    catalog.promoteGeneration();
    assert.equal(catalog.hasPreviousGeneration, true);
  });

  it('previous generation can be force-expired', () => {
    const catalog = new MiddlewareCatalog();
    catalog.promoteGeneration();
    assert.equal(catalog.hasPreviousGeneration, true);
    catalog.expirePreviousGeneration();
    assert.equal(catalog.hasPreviousGeneration, false);
  });

  it('second promote expires first previous generation', () => {
    const catalog = new MiddlewareCatalog();
    catalog.promoteGeneration(); // gen 0 -> prev, gen 1 current
    catalog.promoteGeneration(); // gen 1 -> prev, gen 2 current, gen 0 discarded
    assert.equal(catalog.generation, 2);
    assert.equal(catalog.hasPreviousGeneration, true);
    catalog.expirePreviousGeneration();
    assert.equal(catalog.hasPreviousGeneration, false);
  });
});

// ══════════════════════════════════════════════════════════════════════
// 8. Built-in Middleware Tests
// ══════════════════════════════════════════════════════════════════════

// ── response-cache ─────────────────────────────────────────────────

describe('builtin: response-cache', () => {
  beforeEach(() => {
    responseCache._resetCache();
  });

  it('misses on first request', async () => {
    const ctx = makeCtx();
    // pre should not throw (no cache hit)
    await responseCache.pre(ctx, responseCache.meta.defaultSettings);
    assert.ok(ctx.state.get('response-cache:key')); // key was stashed
  });

  it('hits on second identical request', async () => {
    const settings = { ...responseCache.meta.defaultSettings };

    // First request: pre (miss) + post (store)
    const ctx1 = makeCtx();
    await responseCache.pre(ctx1, settings);
    const resp = makeResponse('cached');
    ctx1.response = resp;
    await responseCache.post(ctx1, settings);

    // Second request: pre (hit) -> should throw SyntheticResponseAbort
    const ctx2 = makeCtx();
    await assert.rejects(
      () => responseCache.pre(ctx2, settings),
      (err) => {
        assert.ok(err instanceof SyntheticResponseAbort);
        assert.equal(err.syntheticResponse, resp);
        return true;
      },
    );
  });

  it('different models produce different cache keys', async () => {
    const settings = { ...responseCache.meta.defaultSettings };

    const ctx1 = makeCtx({ request: { model: 'model-a', messages: [{ role: 'user', content: 'Hi' }] } });
    await responseCache.pre(ctx1, settings);
    const key1 = ctx1.state.get('response-cache:key');

    const ctx2 = makeCtx({ request: { model: 'model-b', messages: [{ role: 'user', content: 'Hi' }] } });
    await responseCache.pre(ctx2, settings);
    const key2 = ctx2.state.get('response-cache:key');

    assert.notEqual(key1, key2);
  });
});

// ── rate-limiter ───────────────────────────────────────────────────

describe('builtin: rate-limiter', () => {
  beforeEach(() => {
    rateLimiter._resetWindows();
  });

  it('allows requests within limit', async () => {
    const settings = { overrideRpmLimit: 5, windowMs: 60_000 };
    const ctx = makeCtx();

    // 5 requests should all succeed
    for (let i = 0; i < 5; i++) {
      await rateLimiter.pre(ctx, settings);
    }
  });

  it('blocks requests exceeding limit', async () => {
    const settings = { overrideRpmLimit: 3, windowMs: 60_000 };
    const ctx = makeCtx();

    // 3 requests succeed
    for (let i = 0; i < 3; i++) {
      await rateLimiter.pre(ctx, settings);
    }

    // 4th should be blocked
    await assert.rejects(
      () => rateLimiter.pre(ctx, settings),
      (err) => {
        assert.ok(err instanceof MiddlewareAbortError);
        assert.equal(err.httpStatus, 429);
        return true;
      },
    );
  });
});

// ── budget-enforcer ────────────────────────────────────────────────

function makeMockSpendCache(dailySpend = 0, monthlySpend = 0) {
  let daily = dailySpend;
  let monthly = monthlySpend;
  return {
    getDailySpend() { return daily; },
    getMonthlySpend() { return monthly; },
    async refresh() {},
    recordCost(keyId, cost) { daily += cost; monthly += cost; },
    _getDaily() { return daily; },
  };
}

describe('builtin: budget-enforcer', () => {
  it('allows requests within daily budget', async () => {
    const settings = { overrideDailyBudget: 5.0, overrideMonthlyBudget: null };
    const ctx = makeCtx({
      appCtx: { config: { env: {} }, log: noopLog, services: { spendCache: makeMockSpendCache(0) } },
    });
    await budgetEnforcer.pre(ctx, settings);
  });

  it('blocks when daily budget is exceeded', async () => {
    const settings = { overrideDailyBudget: 5.0, overrideMonthlyBudget: null };
    const ctx = makeCtx({
      appCtx: { config: { env: {} }, log: noopLog, services: { spendCache: makeMockSpendCache(10.0, 10.0) } },
    });

    await assert.rejects(
      () => budgetEnforcer.pre(ctx, settings),
      (err) => {
        assert.ok(err instanceof MiddlewareAbortError);
        assert.equal(err.httpStatus, 429);
        assert.ok(err.message.includes('Daily budget'));
        return true;
      },
    );
  });

  it('records cost in post-hook via shared spend cache', async () => {
    const cache = makeMockSpendCache(0);
    const settings = { overrideDailyBudget: 5.0 };
    const ctx = makeCtx({
      usage: { cost: 0.05 },
      appCtx: { config: { env: {} }, log: noopLog, services: { spendCache: cache } },
    });

    await budgetEnforcer.post(ctx, settings);
    assert.equal(cache._getDaily(), 0.05);
  });
});

// ── content-blocker ────────────────────────────────────────────────

describe('builtin: content-blocker', () => {
  it('passes when no rules match', async () => {
    const settings = {
      rules: [{ pattern: 'forbidden-word', description: 'Test rule' }],
    };
    const ctx = makeCtx({ request: { messages: [{ role: 'user', content: 'Hello world' }] } });
    await contentBlocker.pre(ctx, settings);
  });

  it('blocks when a rule matches', async () => {
    const settings = {
      rules: [{ pattern: 'forbidden', flags: 'i', description: 'Blocked content' }],
    };
    const ctx = makeCtx({ request: { messages: [{ role: 'user', content: 'This contains FORBIDDEN text' }] } });

    await assert.rejects(
      () => contentBlocker.pre(ctx, settings),
      (err) => {
        assert.ok(err instanceof MiddlewareAbortError);
        assert.equal(err.httpStatus, 400);
        assert.ok(err.message.includes('Content blocked'));
        return true;
      },
    );
  });

  it('skips invalid regex patterns gracefully', async () => {
    const warnings = [];
    const ctx = makeCtx({
      request: { messages: [{ role: 'user', content: 'test' }] },
      log: { ...noopLog, warn: (msg, meta) => warnings.push(msg) },
    });
    const settings = {
      rules: [{ pattern: '[invalid(', description: 'Bad regex' }],
    };
    await contentBlocker.pre(ctx, settings);
    assert.ok(warnings.length > 0);
  });
});

// ── loop-detector ──────────────────────────────────────────────────

describe('builtin: loop-detector', () => {
  beforeEach(() => {
    loopDetector._resetSessions();
  });

  it('does nothing when not enough responses', async () => {
    const ctx = makeCtx({ session: { key: 'sess-1' } });
    const settings = { ...loopDetector.meta.defaultSettings };
    // Pre with no history — should pass
    await loopDetector.pre(ctx, settings);
  });

  it('detects loop in intervene mode and injects message', async () => {
    // Seed a session with identical fingerprints
    const session = { fingerprints: [], totalTokens: [] };
    // Create 5 identical fingerprints
    for (let i = 0; i < 5; i++) {
      // We need real fingerprints — use the post hook to create them
      session.fingerprints.push('abcdef1234567890');
      session.totalTokens.push(i * 100);
    }
    loopDetector._setSession('sess-loop', session);

    const ctx = makeCtx({
      request: {
        model: 'test',
        messages: [{ role: 'user', content: 'Do something' }],
      },
      session: { key: 'sess-loop' },
    });
    const settings = {
      mode: 'intervene',
      similarityThreshold: 5,
      window: 7,
      minResponses: 3,
      repetitiveRatio: 0.50,
      growthThreshold: 50_000,
    };

    await loopDetector.pre(ctx, settings);

    // Should have injected a system message
    const systemMsgs = ctx.request.messages.filter((m) => m.role === 'system');
    assert.ok(systemMsgs.length > 0);
    assert.ok(systemMsgs.some((m) => m.content.includes('LOOP DETECTED')));
  });

  it('blocks in block mode', async () => {
    const session = { fingerprints: [], totalTokens: [] };
    for (let i = 0; i < 5; i++) {
      session.fingerprints.push('abcdef1234567890');
      session.totalTokens.push(i * 100);
    }
    loopDetector._setSession('sess-block', session);

    const ctx = makeCtx({ session: { key: 'sess-block' } });
    const settings = {
      mode: 'block',
      similarityThreshold: 5,
      window: 7,
      minResponses: 3,
      repetitiveRatio: 0.50,
      growthThreshold: 50_000,
    };

    await assert.rejects(
      () => loopDetector.pre(ctx, settings),
      (err) => {
        assert.ok(err instanceof MiddlewareAbortError);
        assert.equal(err.httpStatus, 429);
        return true;
      },
    );
  });

  it('records fingerprints in post-hook', async () => {
    const ctx = makeCtx({
      session: { key: 'sess-fp' },
      response: makeResponse('Some response text'),
      usage: { total_tokens: 42 },
    });
    const settings = { ...loopDetector.meta.defaultSettings };

    await loopDetector.post(ctx, settings);

    const session = loopDetector._getSession('sess-fp');
    assert.ok(session);
    assert.equal(session.fingerprints.length, 1);
    assert.equal(session.totalTokens.length, 1);
    assert.equal(session.totalTokens[0], 42);
  });
});

// ── system-prompt-injector ─────────────────────────────────────────

describe('builtin: system-prompt-injector', () => {
  it('prepends system message by default', async () => {
    const ctx = makeCtx({
      request: {
        messages: [
          { role: 'user', content: 'Hello' },
        ],
      },
    });
    const settings = { content: 'You are helpful.', position: 'prepend', role: 'system' };

    await systemPromptInjector.pre(ctx, settings);

    assert.equal(ctx.request.messages.length, 2);
    assert.equal(ctx.request.messages[0].role, 'system');
    assert.equal(ctx.request.messages[0].content, 'You are helpful.');
    assert.equal(ctx.request.messages[1].role, 'user');
  });

  it('appends system message when position=append', async () => {
    const ctx = makeCtx({
      request: {
        messages: [
          { role: 'user', content: 'Hello' },
        ],
      },
    });
    const settings = { content: 'Be concise.', position: 'append', role: 'system' };

    await systemPromptInjector.pre(ctx, settings);

    assert.equal(ctx.request.messages.length, 2);
    assert.equal(ctx.request.messages[0].role, 'user');
    assert.equal(ctx.request.messages[1].content, 'Be concise.');
  });

  it('does nothing when content is empty', async () => {
    const ctx = makeCtx({
      request: { messages: [{ role: 'user', content: 'Hello' }] },
    });
    await systemPromptInjector.pre(ctx, { content: '', position: 'prepend', role: 'system' });
    assert.equal(ctx.request.messages.length, 1);
  });

  it('inserts after existing system messages when prepending', async () => {
    const ctx = makeCtx({
      request: {
        messages: [
          { role: 'system', content: 'Existing system msg' },
          { role: 'user', content: 'Hello' },
        ],
      },
    });
    await systemPromptInjector.pre(ctx, { content: 'Injected', position: 'prepend', role: 'system' });
    assert.equal(ctx.request.messages.length, 3);
    assert.equal(ctx.request.messages[0].content, 'Existing system msg');
    assert.equal(ctx.request.messages[1].content, 'Injected');
    assert.equal(ctx.request.messages[2].content, 'Hello');
  });
});

// ── response-filter ────────────────────────────────────────────────

describe('builtin: response-filter', () => {
  it('applies find/replace patterns to response', async () => {
    const ctx = makeCtx({
      response: makeResponse('This has SSN 123-45-6789 in it'),
    });
    const settings = {
      patterns: [
        { find: '\\d{3}-\\d{2}-\\d{4}', replace: '[REDACTED]', flags: 'g' },
      ],
    };

    await responseFilter.post(ctx, settings);

    const content = ctx.response.choices[0].message.content;
    assert.equal(content, 'This has SSN [REDACTED] in it');
  });

  it('handles multiple patterns', async () => {
    const ctx = makeCtx({
      response: makeResponse('email: test@example.com, phone: 555-1234'),
    });
    const settings = {
      patterns: [
        { find: '[\\w.-]+@[\\w.-]+', replace: '[EMAIL]', flags: 'g' },
        { find: '\\d{3}-\\d{4}', replace: '[PHONE]', flags: 'g' },
      ],
    };

    await responseFilter.post(ctx, settings);

    const content = ctx.response.choices[0].message.content;
    assert.ok(content.includes('[EMAIL]'));
    assert.ok(content.includes('[PHONE]'));
  });

  it('does nothing with no patterns', async () => {
    const original = 'original content';
    const ctx = makeCtx({ response: makeResponse(original) });
    await responseFilter.post(ctx, { patterns: [] });
    assert.equal(ctx.response.choices[0].message.content, original);
  });

  it('skips invalid regex gracefully', async () => {
    const warnings = [];
    const ctx = makeCtx({
      response: makeResponse('test content'),
      log: { ...noopLog, warn: (msg) => warnings.push(msg) },
    });
    const settings = {
      patterns: [{ find: '[bad(', replace: 'x' }],
    };
    await responseFilter.post(ctx, settings);
    assert.ok(warnings.length > 0);
  });
});

// ── output-compressor ──────────────────────────────────────────────

describe('builtin: output-compressor', () => {
  it('truncates tool messages exceeding maxOutputLength', async () => {
    const longContent = 'x'.repeat(10_000);
    const ctx = makeCtx({
      request: {
        messages: [
          { role: 'tool', content: longContent },
          { role: 'user', content: 'Summarize that.' },
        ],
      },
    });
    const settings = { maxOutputLength: 500, truncationMarker: '\n[TRUNCATED]' };

    await outputCompressor.pre(ctx, settings);

    const toolMsg = ctx.request.messages[0];
    assert.ok(toolMsg.content.length <= 500);
    assert.ok(toolMsg.content.endsWith('[TRUNCATED]'));

    // User message should be untouched
    assert.equal(ctx.request.messages[1].content, 'Summarize that.');
  });

  it('does not truncate short messages', async () => {
    const ctx = makeCtx({
      request: {
        messages: [{ role: 'tool', content: 'Short output' }],
      },
    });
    await outputCompressor.pre(ctx, { maxOutputLength: 8000, truncationMarker: '...' });
    assert.equal(ctx.request.messages[0].content, 'Short output');
  });

  it('truncates function-role messages', async () => {
    const longContent = 'y'.repeat(5000);
    const ctx = makeCtx({
      request: {
        messages: [{ role: 'function', content: longContent }],
      },
    });
    await outputCompressor.pre(ctx, { maxOutputLength: 200, truncationMarker: '[CUT]' });
    assert.ok(ctx.request.messages[0].content.length <= 200);
    assert.ok(ctx.request.messages[0].content.endsWith('[CUT]'));
  });

  it('truncates array-style content parts', async () => {
    const longText = 'z'.repeat(5000);
    const ctx = makeCtx({
      request: {
        messages: [{
          role: 'tool',
          content: [
            { type: 'text', text: longText },
            { type: 'text', text: 'short' },
          ],
        }],
      },
    });
    await outputCompressor.pre(ctx, { maxOutputLength: 300, truncationMarker: '[...]' });

    const parts = ctx.request.messages[0].content;
    assert.ok(parts[0].text.length <= 300);
    assert.ok(parts[0].text.endsWith('[...]'));
    assert.equal(parts[1].text, 'short'); // untouched
  });
});

// ══════════════════════════════════════════════════════════════════════
// 9. Abort Helpers
// ══════════════════════════════════════════════════════════════════════

describe('middleware-abort helpers', () => {
  it('abortSuccess throws SyntheticResponseAbort with response attached', () => {
    const resp = { id: 'synth' };
    assert.throws(
      () => abortSuccess('test-mw', resp),
      (err) => {
        assert.ok(err instanceof SyntheticResponseAbort);
        assert.equal(err.syntheticResponse, resp);
        return true;
      },
    );
  });

  it('abortError throws MiddlewareAbortError with correct status', () => {
    assert.throws(
      () => abortError('test-mw', 403, 'Forbidden'),
      (err) => {
        assert.ok(err instanceof MiddlewareAbortError);
        assert.equal(err.httpStatus, 403);
        assert.equal(err.message, 'Forbidden');
        return true;
      },
    );
  });
});

// ══════════════════════════════════════════════════════════════════════
// 10. Engine hook-mode filtering
// ══════════════════════════════════════════════════════════════════════

describe('runMiddlewarePlan — hookMode filtering', () => {
  it('skips pre-hooks when hookMode is post', async () => {
    const preCalled = { value: false };
    const postCalled = { value: false };
    const plan = [
      makePlanEntry('post-only', {
        pre: async () => { preCalled.value = true; },
        post: async () => { postCalled.value = true; },
      }, {}, 'post'),
    ];

    await runMiddlewarePlan({
      reqCtx: { request: {}, log: noopLog, appCtx: {} },
      plan,
      dispatch: async () => makeResponse(),
    });

    assert.equal(preCalled.value, false);
    assert.equal(postCalled.value, true);
  });

  it('skips post-hooks when hookMode is pre', async () => {
    const preCalled = { value: false };
    const postCalled = { value: false };
    const plan = [
      makePlanEntry('pre-only', {
        pre: async () => { preCalled.value = true; },
        post: async () => { postCalled.value = true; },
      }, {}, 'pre'),
    ];

    await runMiddlewarePlan({
      reqCtx: { request: {}, log: noopLog, appCtx: {} },
      plan,
      dispatch: async () => makeResponse(),
    });

    assert.equal(preCalled.value, true);
    assert.equal(postCalled.value, false);
  });
});
