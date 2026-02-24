import { query } from '../db/init.mjs';
import { BudgetExceededError } from '../utils/errors.mjs';
import { createLogger } from '../utils/logger.mjs';

const log = createLogger('cost-throttler');

// In-memory spend cache: "family:<id>" or "key:<id>" → { total, fetchedAt }
const spendCache = new Map();
const CACHE_TTL_MS = 10_000;

function startOfMonth() {
  const d = new Date();
  d.setUTCDate(1);
  d.setUTCHours(0, 0, 0, 0);
  return d;
}

async function getMonthlySpend(scope, id) {
  const cacheKey = `${scope}:${id}`;
  const cached = spendCache.get(cacheKey);
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
    return cached.total;
  }

  const col = scope === 'family' ? 'family_id' : 'api_key_id';
  const { rows } = await query(`
    SELECT COALESCE(SUM(total_cost), 0) as spent
    FROM call_logs
    WHERE ${col} = $1 AND started_at >= $2 AND status_code = 200
  `, [id, startOfMonth()]);

  const total = Number(rows[0].spent);
  spendCache.set(cacheKey, { total, fetchedAt: Date.now() });
  return total;
}

function bumpCache(scope, id, amount) {
  if (!id) return;
  const cacheKey = `${scope}:${id}`;
  const cached = spendCache.get(cacheKey);
  if (cached) {
    cached.total += amount;
  }
}

/**
 * Pre-request budget check. Throws BudgetExceededError if over budget.
 */
export async function checkBudget(authCtx) {
  // Key-level budget (most specific)
  if (authCtx.key_monthly_budget != null) {
    const spent = await getMonthlySpend('key', authCtx.api_key_id);
    if (spent >= authCtx.key_monthly_budget) {
      log.warn('Key budget exceeded', { api_key_id: authCtx.api_key_id, spent, budget: authCtx.key_monthly_budget });
      throw new BudgetExceededError('key', spent, authCtx.key_monthly_budget);
    }
  }

  // Family-level budget
  if (authCtx.family_monthly_budget != null) {
    const spent = await getMonthlySpend('family', authCtx.family_id);
    if (spent >= authCtx.family_monthly_budget) {
      log.warn('Family budget exceeded', { family_id: authCtx.family_id, spent, budget: authCtx.family_monthly_budget });
      throw new BudgetExceededError('family', spent, authCtx.family_monthly_budget);
    }
  }
}

/**
 * Post-response: bump cached counters so subsequent requests see updated spend
 * without waiting for cache refresh.
 */
export function trackSpend(authCtx, totalCost) {
  bumpCache('key', authCtx.api_key_id, totalCost);
  bumpCache('family', authCtx.family_id, totalCost);
}
