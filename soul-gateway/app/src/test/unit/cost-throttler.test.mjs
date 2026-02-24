import { describe, it, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { BudgetExceededError } from '../../utils/errors.mjs';

// Silence logs during tests
process.env.LOG_LEVEL = 'critical';

// Mock the DB query function before importing the module
const mockQuery = mock.fn(() => Promise.resolve({ rows: [{ spent: '0' }] }));
mock.module('../../db/init.mjs', {
  namedExports: { query: mockQuery },
});

const { checkBudget, trackSpend } = await import('../../pipeline/cost-throttler.mjs');

// Use unique IDs per test to avoid in-memory cache interference
let counter = 0;
function uniqueId(prefix) {
  return `${prefix}-${++counter}-${Date.now()}`;
}

function makeAuthCtx(overrides = {}) {
  return {
    family_id: uniqueId('fam'),
    family_name: 'test-family',
    api_key_id: uniqueId('key'),
    family_monthly_budget: null,
    key_monthly_budget: null,
    ...overrides,
  };
}

describe('cost-throttler', () => {
  beforeEach(() => {
    mockQuery.mock.resetCalls();
    mockQuery.mock.mockImplementation(() => Promise.resolve({ rows: [{ spent: '0' }] }));
  });

  describe('checkBudget', () => {
    it('does nothing when both budgets are null (unlimited)', async () => {
      const ctx = makeAuthCtx();
      await checkBudget(ctx);
      assert.equal(mockQuery.mock.callCount(), 0);
    });

    it('allows request when family spend is under budget', async () => {
      mockQuery.mock.mockImplementation(() => Promise.resolve({ rows: [{ spent: '5.00' }] }));
      const ctx = makeAuthCtx({ family_monthly_budget: 10 });
      await checkBudget(ctx);
      assert.ok(mockQuery.mock.callCount() >= 1);
    });

    it('throws BudgetExceededError when family spend exceeds budget', async () => {
      mockQuery.mock.mockImplementation(() => Promise.resolve({ rows: [{ spent: '10.50' }] }));
      const ctx = makeAuthCtx({ family_monthly_budget: 10 });
      await assert.rejects(
        () => checkBudget(ctx),
        (err) => {
          assert.ok(err instanceof BudgetExceededError);
          assert.equal(err.scope, 'family');
          assert.equal(err.status, 429);
          assert.equal(err.type, 'budget_exceeded');
          assert.equal(err.spent, 10.50);
          assert.equal(err.budget, 10);
          assert.ok(err.retryAfter > 0);
          return true;
        },
      );
    });

    it('throws BudgetExceededError when family spend equals budget exactly', async () => {
      mockQuery.mock.mockImplementation(() => Promise.resolve({ rows: [{ spent: '10.00' }] }));
      const ctx = makeAuthCtx({ family_monthly_budget: 10 });
      await assert.rejects(
        () => checkBudget(ctx),
        (err) => {
          assert.ok(err instanceof BudgetExceededError);
          assert.equal(err.scope, 'family');
          return true;
        },
      );
    });

    it('allows request when key spend is under budget', async () => {
      mockQuery.mock.mockImplementation(() => Promise.resolve({ rows: [{ spent: '2.00' }] }));
      const ctx = makeAuthCtx({ key_monthly_budget: 5 });
      await checkBudget(ctx);
    });

    it('throws BudgetExceededError for key budget before checking family', async () => {
      mockQuery.mock.mockImplementation(() => Promise.resolve({ rows: [{ spent: '6.00' }] }));
      const keyId = uniqueId('key');
      const ctx = makeAuthCtx({
        api_key_id: keyId,
        key_monthly_budget: 5,
        family_monthly_budget: 100,
      });
      await assert.rejects(
        () => checkBudget(ctx),
        (err) => {
          assert.ok(err instanceof BudgetExceededError);
          assert.equal(err.scope, 'key');
          assert.equal(mockQuery.mock.callCount(), 1);
          return true;
        },
      );
    });

    it('checks both key and family budgets when key is under limit', async () => {
      let callCount = 0;
      mockQuery.mock.mockImplementation(() => {
        callCount++;
        if (callCount === 1) return Promise.resolve({ rows: [{ spent: '2.00' }] }); // key: under
        return Promise.resolve({ rows: [{ spent: '50.00' }] }); // family: over
      });
      const ctx = makeAuthCtx({ key_monthly_budget: 5, family_monthly_budget: 10 });
      await assert.rejects(
        () => checkBudget(ctx),
        (err) => {
          assert.ok(err instanceof BudgetExceededError);
          assert.equal(err.scope, 'family');
          return true;
        },
      );
    });
  });

  describe('trackSpend', () => {
    it('bumps cached spend so next check reflects it', async () => {
      mockQuery.mock.mockImplementation(() => Promise.resolve({ rows: [{ spent: '5.00' }] }));
      // Use a fixed family_id for this test since we need cache hits
      const famId = uniqueId('fam-track');
      const ctx = makeAuthCtx({ family_id: famId, family_monthly_budget: 20 });
      await checkBudget(ctx); // fetches from DB, caches 5.00

      // Track 12.00 of spend -> cached total = 17.00
      trackSpend(ctx, 12);

      // Still under 20 — should pass
      await checkBudget(ctx);

      // Track another 5.00 -> cached total = 22.00
      trackSpend(ctx, 5);

      // Now over 20 — should throw
      await assert.rejects(
        () => checkBudget(ctx),
        (err) => {
          assert.ok(err instanceof BudgetExceededError);
          assert.equal(err.scope, 'family');
          return true;
        },
      );
    });
  });

  describe('BudgetExceededError', () => {
    it('has correct status, type, and properties', () => {
      const err = new BudgetExceededError('family', 15.5, 10);
      assert.equal(err.status, 429);
      assert.equal(err.type, 'budget_exceeded');
      assert.equal(err.scope, 'family');
      assert.equal(err.spent, 15.5);
      assert.equal(err.budget, 10);
      assert.ok(err.retryAfter > 0);
      assert.ok(err.retryAfter <= 86400);
      assert.ok(err.message.includes('$15.50'));
      assert.ok(err.message.includes('$10.00'));
    });

    it('works for key scope', () => {
      const err = new BudgetExceededError('key', 3.14, 2.50);
      assert.equal(err.scope, 'key');
      assert.ok(err.message.includes('key'));
    });
  });
});
