import { query } from '../db/init.mjs';
import { BudgetExceededError } from '../utils/errors.mjs';
import { createLogger } from '../utils/logger.mjs';

const log = createLogger('cost-throttler');

// In-memory spend cache: "key:<id>" → { total, fetchedAt }
const spendCache = new Map();
const CACHE_TTL_MS = 10_000;

function startOfMonth() {
  const d = new Date();
  d.setUTCDate(1);
  d.setUTCHours(0, 0, 0, 0);
  return d;
}

async function getMonthlySpend(id, budgetResetAt) {
  const cacheKey = `key:${id}`;
  const cached = spendCache.get(cacheKey);
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
    return cached.total;
  }

  // Use the later of: start of month or budget_reset_at
  let since = startOfMonth();
  if (budgetResetAt) {
    const resetDate = new Date(budgetResetAt);
    if (resetDate > since) since = resetDate;
  }

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
 * Pre-request budget check. Throws BudgetExceededError if over budget.
 */
export async function checkBudget(authCtx) {
  if (authCtx.key_monthly_budget != null) {
    const spent = await getMonthlySpend(authCtx.api_key_id, authCtx.budget_reset_at);
    if (spent >= authCtx.key_monthly_budget) {
      log.warn('Key budget exceeded', { api_key_id: authCtx.api_key_id, spent, budget: authCtx.key_monthly_budget });
      throw new BudgetExceededError('key', spent, authCtx.key_monthly_budget);
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
