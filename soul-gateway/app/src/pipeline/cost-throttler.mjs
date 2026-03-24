import { query } from '../db/init.mjs';
import { BudgetExceededError } from '../utils/errors.mjs';
import { createLogger } from '../utils/logger.mjs';

const log = createLogger('cost-throttler');

// In-memory spend cache: "key:<id>" → { total, fetchedAt }
const spendCache = new Map();
const CACHE_TTL_MS = 10_000;

function startOfDay() {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  return d;
}

async function getDailySpend(id) {
  const cacheKey = `key:${id}`;
  const cached = spendCache.get(cacheKey);
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
    return cached.total;
  }

  const since = startOfDay();

  const { rows } = await query(`
    SELECT COALESCE(SUM(total_cost), 0) as spent
    FROM call_logs
    WHERE api_key_id = $1 AND started_at >= $2 AND status_code = 200 AND is_free IS NOT TRUE
  `, [id, since]);

  const total = Number(rows[0].spent);
  spendCache.set(cacheKey, { total, fetchedAt: Date.now() });
  return total;
}

function bumpCache(id, amount) {
  if (!id) return;
  const cacheKey = `key:${id}`;
  const cached = spendCache.get(cacheKey);
  if (cached) {
    cached.total += amount;
  }
}

/**
 * Pre-request budget check. Throws BudgetExceededError if over daily budget.
 */
export async function checkBudget(authCtx) {
  if (authCtx.key_daily_budget != null) {
    const spent = await getDailySpend(authCtx.api_key_id);
    if (spent >= authCtx.key_daily_budget) {
      log.warn('Key daily budget exceeded', { api_key_id: authCtx.api_key_id, spent, budget: authCtx.key_daily_budget });
      throw new BudgetExceededError('key', spent, authCtx.key_daily_budget);
    }
  }
}

/**
 * Post-response: bump cached counters so subsequent requests see updated spend.
 * Only bumps for non-free models.
 */
export function trackSpend(authCtx, totalCost, isFree) {
  if (isFree) return;
  bumpCache(authCtx.api_key_id, totalCost);
}
