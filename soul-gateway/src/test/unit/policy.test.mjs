import { describe, it, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';

import { SlidingWindowLimiter } from '../../runtime/policy/rate-limiter.mjs';
import { TpmTracker } from '../../runtime/policy/tpm-tracker.mjs';
import { SpendCache } from '../../runtime/policy/spend-cache.mjs';
import { checkBudget, recordSpend } from '../../runtime/policy/budget-enforcer.mjs';
import { calculateRequestCost } from '../../runtime/policy/cost-calculator.mjs';
import { estimatePromptTokens } from '../../runtime/policy/token-estimator.mjs';
import { PricingDirectory } from '../../runtime/policy/pricing-directory.mjs';
import { evaluateBlacklist } from '../../runtime/policy/content-blocker.mjs';
import { applyResponseFilters } from '../../runtime/policy/response-filter.mjs';
import { evaluateLoopSignal } from '../../runtime/policy/loop-detector.mjs';

// ═════════════════════════════════════════════════════════════════════
// SlidingWindowLimiter
// ═════════════════════════════════════════════════════════════════════

describe('SlidingWindowLimiter', () => {
  it('allows requests within the limit', () => {
    let now = 1000;
    const limiter = new SlidingWindowLimiter({ nowSeconds: () => now });

    limiter.record('key-1');
    limiter.record('key-1');
    limiter.record('key-1');

    const result = limiter.check('key-1', 5);
    assert.equal(result.allowed, true);
    assert.equal(result.remaining, 2);
    assert.equal(result.retryAfterMs, 0);
  });

  it('reports remaining=0 at the limit', () => {
    let now = 1000;
    const limiter = new SlidingWindowLimiter({ nowSeconds: () => now });

    for (let i = 0; i < 5; i++) limiter.record('key-1');

    const result = limiter.check('key-1', 5);
    assert.equal(result.allowed, false);
    assert.equal(result.remaining, 0);
    assert.ok(result.retryAfterMs > 0);
  });

  it('denies requests when exceeded', () => {
    let now = 1000;
    const limiter = new SlidingWindowLimiter({ nowSeconds: () => now });

    for (let i = 0; i < 10; i++) limiter.record('key-1');

    const result = limiter.check('key-1', 5);
    assert.equal(result.allowed, false);
    assert.equal(result.remaining, 0);
  });

  it('allows requests again after window expiry', () => {
    let now = 1000;
    const limiter = new SlidingWindowLimiter({ nowSeconds: () => now });

    for (let i = 0; i < 5; i++) limiter.record('key-1');

    // Check at limit
    let result = limiter.check('key-1', 5);
    assert.equal(result.allowed, false);

    // Advance time by 61 seconds (past the full window)
    now = 1061;
    result = limiter.check('key-1', 5);
    assert.equal(result.allowed, true);
    assert.equal(result.remaining, 5);
  });

  it('tracks different keys independently', () => {
    let now = 1000;
    const limiter = new SlidingWindowLimiter({ nowSeconds: () => now });

    for (let i = 0; i < 5; i++) limiter.record('key-1');
    limiter.record('key-2');

    assert.equal(limiter.check('key-1', 5).allowed, false);
    assert.equal(limiter.check('key-2', 5).allowed, true);
    assert.equal(limiter.check('key-2', 5).remaining, 4);
  });

  it('partially expires old slots as time advances', () => {
    let now = 1000;
    const limiter = new SlidingWindowLimiter({ nowSeconds: () => now });

    // Record 3 at t=1000
    for (let i = 0; i < 3; i++) limiter.record('key-1');

    // Record 2 at t=1030 (30 seconds later)
    now = 1030;
    for (let i = 0; i < 2; i++) limiter.record('key-1');

    // At t=1030 all 5 are in window
    assert.equal(limiter.check('key-1', 5).allowed, false);

    // At t=1061 the first 3 have expired, only 2 remain
    now = 1061;
    const result = limiter.check('key-1', 5);
    assert.equal(result.allowed, true);
    assert.equal(result.remaining, 3);
  });
});

// ═════════════════════════════════════════════════════════════════════
// TpmTracker
// ═════════════════════════════════════════════════════════════════════

describe('TpmTracker', () => {
  it('accumulates tokens correctly', () => {
    let now = 1000;
    const tracker = new TpmTracker({ nowSeconds: () => now });

    tracker.record('key-1', 500);
    tracker.record('key-1', 300);

    const result = tracker.check('key-1', 1000);
    assert.equal(result.current, 800);
    assert.equal(result.limit, 1000);
    assert.equal(result.exceeded, false);
  });

  it('reports exceeded when at or above limit', () => {
    let now = 1000;
    const tracker = new TpmTracker({ nowSeconds: () => now });

    tracker.record('key-1', 1000);

    const result = tracker.check('key-1', 1000);
    assert.equal(result.exceeded, true);
  });

  it('does not block — only reports (soft limit)', () => {
    let now = 1000;
    const tracker = new TpmTracker({ nowSeconds: () => now });

    tracker.record('key-1', 5000);

    // Exceeded is true, but the tracker does not throw or prevent recording
    const result = tracker.check('key-1', 1000);
    assert.equal(result.exceeded, true);
    assert.equal(result.current, 5000);

    // Can still record more
    tracker.record('key-1', 1000);
    assert.equal(tracker.check('key-1', 1000).current, 6000);
  });

  it('expires tokens after the window', () => {
    let now = 1000;
    const tracker = new TpmTracker({ nowSeconds: () => now });

    tracker.record('key-1', 5000);

    now = 1061;
    const result = tracker.check('key-1', 10000);
    assert.equal(result.current, 0);
    assert.equal(result.exceeded, false);
  });

  it('tracks different keys independently', () => {
    let now = 1000;
    const tracker = new TpmTracker({ nowSeconds: () => now });

    tracker.record('key-1', 500);
    tracker.record('key-2', 200);

    assert.equal(tracker.check('key-1', 1000).current, 500);
    assert.equal(tracker.check('key-2', 1000).current, 200);
  });
});

// ═════════════════════════════════════════════════════════════════════
// SpendCache
// ═════════════════════════════════════════════════════════════════════

describe('SpendCache', () => {
  it('returns null for unknown key', () => {
    const cache = new SpendCache({ ttlMs: 10_000 });
    assert.equal(cache.getDailySpend('key-1'), null);
    assert.equal(cache.getMonthlySpend('key-1'), null);
  });

  it('returns cached values after refresh', async () => {
    let time = 1000;
    const cache = new SpendCache({ ttlMs: 10_000, now: () => time });

    const mockPool = createMockPool(1.50, 25.00);
    await cache.refresh('key-1', mockPool);

    assert.equal(cache.getDailySpend('key-1'), 1.50);
    assert.equal(cache.getMonthlySpend('key-1'), 25.00);
  });

  it('returns null when cache is stale', async () => {
    let time = 1000;
    const cache = new SpendCache({ ttlMs: 5000, now: () => time });

    const mockPool = createMockPool(1.00, 10.00);
    await cache.refresh('key-1', mockPool);

    assert.equal(cache.getDailySpend('key-1'), 1.00);

    // Advance past TTL
    time = 7000;
    assert.equal(cache.getDailySpend('key-1'), null);
    assert.equal(cache.getMonthlySpend('key-1'), null);
  });

  it('optimistically adds cost via recordCost', async () => {
    let time = 1000;
    const cache = new SpendCache({ ttlMs: 10_000, now: () => time });

    const mockPool = createMockPool(1.00, 10.00);
    await cache.refresh('key-1', mockPool);

    cache.recordCost('key-1', 0.50);

    assert.equal(cache.getDailySpend('key-1'), 1.50);
    assert.equal(cache.getMonthlySpend('key-1'), 10.50);
  });

  it('resets daily spend', async () => {
    let time = 1000;
    const cache = new SpendCache({ ttlMs: 10_000, now: () => time });

    const mockPool = createMockPool(5.00, 50.00);
    await cache.refresh('key-1', mockPool);

    cache.resetDaily('key-1');

    assert.equal(cache.getDailySpend('key-1'), 0);
    assert.equal(cache.getMonthlySpend('key-1'), 50.00);
  });

  it('invalidate marks entry stale', async () => {
    let time = 1000;
    const cache = new SpendCache({ ttlMs: 10_000, now: () => time });

    const mockPool = createMockPool(1.00, 10.00);
    await cache.refresh('key-1', mockPool);

    cache.invalidate('key-1');

    assert.equal(cache.getDailySpend('key-1'), null);
    assert.equal(cache.getMonthlySpend('key-1'), null);
  });

  it('getForKey returns the combined cached spend values', async () => {
    let time = 1000;
    const cache = new SpendCache({ ttlMs: 10_000, now: () => time });

    const mockPool = createMockPool(2.25, 12.50);
    await cache.refresh('key-1', mockPool);

    assert.deepEqual(cache.getForKey('key-1'), {
      dailySpendUsd: 2.25,
      monthlySpendUsd: 12.50,
    });
  });

  it('cleanup evicts entries that have been idle too long', async () => {
    let time = 1000;
    const cache = new SpendCache({
      ttlMs: 60_000,
      cleanupIdleMs: 5000,
      now: () => time,
    });

    const mockPool = createMockPool(1.00, 10.00);
    await cache.refresh('key-1', mockPool);

    time = 7000;
    const removed = cache.cleanup();

    assert.equal(removed, 1);
    assert.equal(cache.getForKey('key-1'), null);
  });
});

// ═════════════════════════════════════════════════════════════════════
// Budget Enforcer
// ═════════════════════════════════════════════════════════════════════

describe('checkBudget', () => {
  it('allows when no limits are set', async () => {
    const cache = new SpendCache({ ttlMs: 60_000, now: () => 1000 });
    const result = await checkBudget(
      { id: 'key-1', daily_budget_usd: null, monthly_budget_usd: null },
      cache,
      null,
    );
    assert.equal(result.allowed, true);
  });

  it('blocks when daily spend exceeds daily limit', async () => {
    let time = 1000;
    const cache = new SpendCache({ ttlMs: 60_000, now: () => time });
    const mockPool = createMockPool(5.00, 50.00);
    await cache.refresh('key-1', mockPool);

    const result = await checkBudget(
      { id: 'key-1', daily_budget_usd: 4.00, monthly_budget_usd: null },
      cache,
      mockPool,
    );
    assert.equal(result.allowed, false);
    assert.equal(result.dailySpend, 5.00);
  });

  it('blocks when monthly spend exceeds monthly limit', async () => {
    let time = 1000;
    const cache = new SpendCache({ ttlMs: 60_000, now: () => time });
    const mockPool = createMockPool(1.00, 50.00);
    await cache.refresh('key-1', mockPool);

    const result = await checkBudget(
      { id: 'key-1', daily_budget_usd: null, monthly_budget_usd: 40.00 },
      cache,
      mockPool,
    );
    assert.equal(result.allowed, false);
    assert.equal(result.monthlySpend, 50.00);
  });

  it('allows when spend is below all limits', async () => {
    let time = 1000;
    const cache = new SpendCache({ ttlMs: 60_000, now: () => time });
    const mockPool = createMockPool(1.00, 10.00);
    await cache.refresh('key-1', mockPool);

    const result = await checkBudget(
      { id: 'key-1', daily_budget_usd: 5.00, monthly_budget_usd: 100.00 },
      cache,
      mockPool,
    );
    assert.equal(result.allowed, true);
    assert.equal(result.dailyLimit, 5.00);
    assert.equal(result.monthlyLimit, 100.00);
  });

  it('refreshes cache when stale', async () => {
    let time = 1000;
    const cache = new SpendCache({ ttlMs: 100, now: () => time });
    const mockPool = createMockPool(1.00, 10.00);
    await cache.refresh('key-1', mockPool);

    // Make cache stale
    time = 2000;

    const result = await checkBudget(
      { id: 'key-1', daily_budget_usd: 5.00, monthly_budget_usd: 100.00 },
      cache,
      mockPool,
    );
    assert.equal(result.allowed, true);
    assert.equal(result.dailySpend, 1.00);
  });
});

describe('recordSpend', () => {
  it('updates cached spend', async () => {
    let time = 1000;
    const cache = new SpendCache({ ttlMs: 60_000, now: () => time });
    const mockPool = createMockPool(1.00, 10.00);
    await cache.refresh('key-1', mockPool);

    recordSpend('key-1', 0.25, cache);

    assert.equal(cache.getDailySpend('key-1'), 1.25);
    assert.equal(cache.getMonthlySpend('key-1'), 10.25);
  });
});

// ═════════════════════════════════════════════════════════════════════
// Cost Calculator
// ═════════════════════════════════════════════════════════════════════

describe('calculateRequestCost', () => {
  it('calculates token-based pricing', () => {
    const result = calculateRequestCost(
      { pricingMode: 'token', inputPricePerMillion: 3.0, outputPricePerMillion: 15.0 },
      { inputTokens: 1000, outputTokens: 500 },
    );
    assert.equal(result.inputCostUsd, 0.003);
    assert.equal(result.outputCostUsd, 0.0075);
    assert.equal(result.totalCostUsd, 0.003 + 0.0075);
    assert.equal(result.budgetExempt, false);
    assert.equal(result.pricingMissing, false);
  });

  it('calculates request-based pricing', () => {
    const result = calculateRequestCost(
      { pricingMode: 'request', requestPriceUsd: 0.01 },
      { inputTokens: 5000, outputTokens: 2000 },
    );
    assert.equal(result.totalCostUsd, 0.01);
    assert.equal(result.inputCostUsd, 0);
    assert.equal(result.outputCostUsd, 0);
    assert.equal(result.budgetExempt, false);
  });

  it('returns zero for free pricing mode', () => {
    const result = calculateRequestCost(
      { pricingMode: 'free' },
      { inputTokens: 10000, outputTokens: 5000 },
    );
    assert.equal(result.totalCostUsd, 0);
    assert.equal(result.budgetExempt, true);
    assert.equal(result.pricingMissing, false);
  });

  it('returns zero with pricingMissing for external_directory without directory', () => {
    const result = calculateRequestCost(
      { pricingMode: 'external_directory' },
      { inputTokens: 1000, outputTokens: 500 },
    );
    assert.equal(result.totalCostUsd, 0);
    assert.equal(result.pricingMissing, true);
  });

  it('uses pricing directory for external_directory mode', () => {
    const fakeDirectory = {
      lookup: (provider, model) => {
        if (provider === 'openai' && model === 'gpt-4') {
          return { inputPricePerMillion: 30, outputPricePerMillion: 60 };
        }
        return null;
      },
    };

    const result = calculateRequestCost(
      { pricingMode: 'external_directory' },
      { inputTokens: 1000, outputTokens: 500 },
      fakeDirectory,
      'openai',
      'gpt-4',
    );
    // (1000 / 1_000_000) * 30 = 0.03
    assert.equal(result.inputCostUsd, 0.03);
    // (500 / 1_000_000) * 60 = 0.03
    assert.equal(result.outputCostUsd, 0.03);
    assert.equal(result.pricingMissing, false);
  });

  it('returns pricingMissing when directory lookup fails', () => {
    const fakeDirectory = { lookup: () => null };
    const result = calculateRequestCost(
      { pricingMode: 'external_directory' },
      { inputTokens: 1000, outputTokens: 500 },
      fakeDirectory,
      'openai',
      'gpt-unknown',
    );
    assert.equal(result.pricingMissing, true);
    assert.equal(result.totalCostUsd, 0);
  });

  it('returns pricingMissing for unknown pricing mode', () => {
    const result = calculateRequestCost(
      { pricingMode: 'mystery' },
      { inputTokens: 1000, outputTokens: 500 },
    );
    assert.equal(result.pricingMissing, true);
    assert.equal(result.totalCostUsd, 0);
  });
});

// ═════════════════════════════════════════════════════════════════════
// Token Estimator
// ═════════════════════════════════════════════════════════════════════

describe('estimatePromptTokens', () => {
  it('estimates tokens from simple messages', () => {
    const result = estimatePromptTokens({
      messages: [
        { role: 'user', content: 'Hello, how are you?' },
      ],
    });
    // "user" (4 chars) + "Hello, how are you?" (19 chars) = 23 chars / 4 = 6 tokens
    assert.equal(result, 6);
  });

  it('handles multiple messages', () => {
    const result = estimatePromptTokens({
      messages: [
        { role: 'system', content: 'You are helpful.' },
        { role: 'user', content: 'Hello' },
      ],
    });
    // "system" (6) + "You are helpful." (16) + "user" (4) + "Hello" (5) = 31 / 4 = 8
    assert.equal(result, 8);
  });

  it('returns 0 for empty messages', () => {
    assert.equal(estimatePromptTokens({ messages: [] }), 0);
    assert.equal(estimatePromptTokens({}), 0);
    assert.equal(estimatePromptTokens(null), 0);
  });

  it('handles multi-part content arrays', () => {
    const result = estimatePromptTokens({
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: 'Describe this image' },
          { type: 'image_url', image_url: { url: 'http://...' } },
        ],
      }],
    });
    // "user" (4) + "Describe this image" (19) = 23 / 4 = 6
    assert.equal(result, 6);
  });

  it('handles tool calls in messages', () => {
    const result = estimatePromptTokens({
      messages: [{
        role: 'assistant',
        content: '',
        tool_calls: [{
          function: { name: 'get_weather', arguments: '{"city":"NYC"}' },
        }],
      }],
    });
    // "assistant" (9) + "" (0) + "get_weather" (11) + '{"city":"NYC"}' (14) = 34 / 4 = 9
    assert.equal(result, 9);
  });

  it('handles large messages', () => {
    const longContent = 'a'.repeat(4000);
    const result = estimatePromptTokens({
      messages: [{ role: 'user', content: longContent }],
    });
    // "user" (4) + 4000 = 4004 / 4 = 1001
    assert.equal(result, 1001);
  });
});

// ═════════════════════════════════════════════════════════════════════
// Content Blocker
// ═════════════════════════════════════════════════════════════════════

describe('evaluateBlacklist', () => {
  it('returns not blocked when no rules', () => {
    const result = evaluateBlacklist([], [{ role: 'user', content: 'hello' }]);
    assert.equal(result.blocked, false);
  });

  it('returns not blocked when no messages', () => {
    const result = evaluateBlacklist(
      [{ pattern: 'bad', matchType: 'substring' }],
      [],
    );
    assert.equal(result.blocked, false);
  });

  it('blocks on exact match', () => {
    const result = evaluateBlacklist(
      [{ pattern: 'forbidden phrase', matchType: 'exact', caseSensitive: true }],
      [{ role: 'user', content: 'forbidden phrase' }],
    );
    assert.equal(result.blocked, true);
    assert.equal(result.matchedText, 'forbidden phrase');
  });

  it('exact match is case-sensitive by default', () => {
    const result = evaluateBlacklist(
      [{ pattern: 'Forbidden', matchType: 'exact', caseSensitive: true }],
      [{ role: 'user', content: 'forbidden' }],
    );
    assert.equal(result.blocked, false);
  });

  it('exact match with case-insensitive flag', () => {
    const result = evaluateBlacklist(
      [{ pattern: 'Forbidden', matchType: 'exact', caseSensitive: false }],
      [{ role: 'user', content: 'forbidden' }],
    );
    assert.equal(result.blocked, true);
  });

  it('blocks on substring match', () => {
    const result = evaluateBlacklist(
      [{ pattern: 'bad word', matchType: 'substring' }],
      [{ role: 'user', content: 'this has a bad word in it' }],
    );
    assert.equal(result.blocked, true);
    assert.equal(result.matchedText, 'bad word');
  });

  it('substring case-insensitive', () => {
    const result = evaluateBlacklist(
      [{ pattern: 'BAD', matchType: 'substring', caseSensitive: false }],
      [{ role: 'user', content: 'this is bad' }],
    );
    assert.equal(result.blocked, true);
  });

  it('blocks on regex match', () => {
    const result = evaluateBlacklist(
      [{ pattern: '\\b\\d{3}-\\d{2}-\\d{4}\\b', matchType: 'regex' }],
      [{ role: 'user', content: 'My SSN is 123-45-6789' }],
    );
    assert.equal(result.blocked, true);
    assert.equal(result.matchedText, '123-45-6789');
  });

  it('regex case-insensitive', () => {
    const result = evaluateBlacklist(
      [{ pattern: 'secret', matchType: 'regex', caseSensitive: false }],
      [{ role: 'user', content: 'This is SECRET data' }],
    );
    assert.equal(result.blocked, true);
    assert.equal(result.matchedText, 'SECRET');
  });

  it('does not block when content is clean', () => {
    const result = evaluateBlacklist(
      [
        { pattern: 'bad', matchType: 'substring' },
        { pattern: 'evil', matchType: 'exact' },
      ],
      [{ role: 'user', content: 'perfectly fine content' }],
    );
    assert.equal(result.blocked, false);
  });

  it('checks all messages', () => {
    const result = evaluateBlacklist(
      [{ pattern: 'blocked', matchType: 'substring' }],
      [
        { role: 'user', content: 'safe message' },
        { role: 'assistant', content: 'this is blocked content' },
      ],
    );
    assert.equal(result.blocked, true);
  });
});

// ═════════════════════════════════════════════════════════════════════
// Response Filter
// ═════════════════════════════════════════════════════════════════════

describe('applyResponseFilters', () => {
  it('applies a single replacement', () => {
    const result = applyResponseFilters('Hello World', [
      { find: 'World', replace: 'Earth' },
    ]);
    assert.equal(result, 'Hello Earth');
  });

  it('applies multiple patterns in order', () => {
    const result = applyResponseFilters('foo bar baz', [
      { find: 'foo', replace: 'one' },
      { find: 'bar', replace: 'two' },
      { find: 'baz', replace: 'three' },
    ]);
    assert.equal(result, 'one two three');
  });

  it('supports regex flags', () => {
    const result = applyResponseFilters('Hello hello HELLO', [
      { find: 'hello', replace: 'hi', flags: 'gi' },
    ]);
    assert.equal(result, 'hi hi hi');
  });

  it('replaces all occurrences by default (g flag)', () => {
    const result = applyResponseFilters('aaa bbb aaa', [
      { find: 'aaa', replace: 'xxx' },
    ]);
    assert.equal(result, 'xxx bbb xxx');
  });

  it('returns original text when patterns array is empty', () => {
    assert.equal(applyResponseFilters('hello', []), 'hello');
  });

  it('returns original text when text is empty', () => {
    assert.equal(applyResponseFilters('', [{ find: 'a', replace: 'b' }]), '');
  });

  it('skips invalid regex patterns gracefully', () => {
    const result = applyResponseFilters('hello world', [
      { find: '[invalid', replace: 'x' },
      { find: 'world', replace: 'earth' },
    ]);
    assert.equal(result, 'hello earth');
  });

  it('supports capture groups in replace', () => {
    const result = applyResponseFilters('2024-01-15', [
      { find: '(\\d{4})-(\\d{2})-(\\d{2})', replace: '$2/$3/$1' },
    ]);
    assert.equal(result, '01/15/2024');
  });
});

// ═════════════════════════════════════════════════════════════════════
// Loop Detector
// ═════════════════════════════════════════════════════════════════════

describe('evaluateLoopSignal', () => {
  it('does not detect loop below minimum responses', () => {
    const state = { recent_fingerprints: [] };
    const response = { content: 'Hello world' };
    const settings = { minResponses: 3, windowSize: 7, similarityThreshold: 3 };

    // First call
    const r1 = evaluateLoopSignal(state, response, settings);
    assert.equal(r1.loopDetected, false);
    assert.equal(r1.signal, null);

    // Second call (same response)
    const r2 = evaluateLoopSignal(state, response, settings);
    assert.equal(r2.loopDetected, false);
    assert.equal(state.recent_fingerprints.length, 2);
  });

  it('detects similarity loop when enough identical responses', () => {
    const state = { recent_fingerprints: [] };
    const response = { content: 'I am stuck in a loop' };
    const settings = {
      minResponses: 3,
      windowSize: 7,
      similarityThreshold: 3,
      mode: 'block',
    };

    // Pump 3 identical responses
    evaluateLoopSignal(state, response, settings);
    evaluateLoopSignal(state, response, settings);
    const result = evaluateLoopSignal(state, response, settings);

    assert.equal(result.loopDetected, true);
    assert.equal(result.signal, 'similarity');
    assert.equal(result.mode, 'block');
  });

  it('does not detect loop when responses are different', () => {
    const state = { recent_fingerprints: [] };
    const settings = {
      minResponses: 3,
      windowSize: 7,
      similarityThreshold: 5,
    };

    evaluateLoopSignal(state, { content: 'Response A' }, settings);
    evaluateLoopSignal(state, { content: 'Response B' }, settings);
    evaluateLoopSignal(state, { content: 'Response C' }, settings);
    const result = evaluateLoopSignal(state, { content: 'Response D' }, settings);

    assert.equal(result.loopDetected, false);
    assert.equal(result.signal, null);
  });

  it('detects growth loop', () => {
    const state = { recent_fingerprints: [] };
    // Create a response large enough to trigger growth detection
    // growthThresholdTokens = 100, with windowSize = 5, need ~20 tokens per response (~80 chars)
    const longContent = 'x'.repeat(400);
    const response = { content: longContent };
    const settings = {
      minResponses: 3,
      windowSize: 5,
      similarityThreshold: 10, // High so similarity doesn't trigger
      growthThresholdTokens: 100,
      repetitiveRatioThreshold: 0.60,
      mode: 'intervene',
    };

    for (let i = 0; i < 4; i++) {
      evaluateLoopSignal(state, response, settings);
    }
    const result = evaluateLoopSignal(state, response, settings);

    assert.equal(result.loopDetected, true);
    assert.equal(result.signal, 'growth');
    assert.equal(result.mode, 'intervene');
  });

  it('initializes recent_fingerprints if missing', () => {
    const state = {};
    evaluateLoopSignal(state, { content: 'test' }, { minResponses: 3 });
    assert.ok(Array.isArray(state.recent_fingerprints));
    assert.equal(state.recent_fingerprints.length, 1);
  });

  it('trims fingerprints to window size', () => {
    const state = { recent_fingerprints: [] };
    const settings = { minResponses: 1, windowSize: 3, similarityThreshold: 10 };

    for (let i = 0; i < 10; i++) {
      evaluateLoopSignal(state, { content: `Response ${i}` }, settings);
    }
    assert.equal(state.recent_fingerprints.length, 3);
  });

  it('includes tool calls in fingerprint', () => {
    const state = { recent_fingerprints: [] };
    const settings = {
      minResponses: 3,
      windowSize: 7,
      similarityThreshold: 3,
    };

    const responseA = {
      content: 'same text',
      tool_calls: [{ function: { name: 'fn_a', arguments: '{}' } }],
    };
    const responseB = {
      content: 'same text',
      tool_calls: [{ function: { name: 'fn_b', arguments: '{}' } }],
    };

    evaluateLoopSignal(state, responseA, settings);
    evaluateLoopSignal(state, responseB, settings);
    evaluateLoopSignal(state, responseA, settings);
    const result = evaluateLoopSignal(state, responseB, settings);

    // Two distinct fingerprints, each appearing only 2 times — no loop
    assert.equal(result.loopDetected, false);
  });

  it('defaults mode to log', () => {
    const state = { recent_fingerprints: [] };
    const result = evaluateLoopSignal(state, { content: 'test' }, {});
    assert.equal(result.mode, 'log');
  });
});

// ═════════════════════════════════════════════════════════════════════
// Helpers
// ═════════════════════════════════════════════════════════════════════

function createMockPool(dailyTotal, monthlyTotal) {
  return {
    query: async (sql, params) => {
      // Distinguish daily vs monthly by looking at the date parameter
      // The daily query uses a date from today, monthly from start of month.
      // For simplicity, we just alternate based on call order.
      // But since they're called via Promise.all, we check the date.
      const dateParam = params[1];
      if (dateParam instanceof Date) {
        const day = dateParam.getUTCDate();
        // If it's the 1st of the month, it's the monthly query
        if (day === 1 && dateParam.getUTCHours() === 0) {
          // Could be either — we need a smarter approach
        }
      }
      // Use a counter approach
      if (!createMockPool._callCount) createMockPool._callCount = 0;
      createMockPool._callCount++;
      const isDaily = createMockPool._callCount % 2 === 1;
      return { rows: [{ total: isDaily ? dailyTotal : monthlyTotal }] };
    },
  };
}
