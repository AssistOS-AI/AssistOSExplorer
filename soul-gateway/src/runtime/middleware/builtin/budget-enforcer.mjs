/**
 * Built-in middleware: Budget Enforcer
 *
 * Pre-hook:  check daily/monthly spend against limit, abort if exceeded.
 * Post-hook: record the cost of the completed request.
 *
 * Uses the shared SpendCache runtime service for spend tracking.
 * If the shared cache is unavailable, spend is treated as zero and the
 * middleware degrades permissively instead of blocking requests.
 */

export const meta = {
  key: 'budget-enforcer',
  name: 'Budget Enforcer',
  description: 'Enforces daily and monthly spend budgets per API key. Blocks requests when budget is exhausted.',
  version: '1.0.0',
  defaultSettings: {
    overrideDailyBudget: null,    // null = use key's configured limit
    overrideMonthlyBudget: null,  // null = use key's configured limit
  },
  hooks: 'both',
};

/**
 * Pre-hook: check spend against budget limits.
 */
export async function pre(ctx, settings) {
  const keyId = ctx.auth?.keyId || 'anonymous';
  const keyRecord = ctx.auth?.apiKeyRecord || {};
  const spendCache = ctx.runtime?.services?.spendCache;
  const pool = ctx.runtime?.pool;

  // Resolve effective limits: setting override > key record > env default
  const dailyLimit = settings.overrideDailyBudget
    ?? keyRecord.daily_budget_usd
    ?? ctx.runtime?.config?.env?.DEFAULT_DAILY_BUDGET_USD
    ?? null;

  const monthlyLimit = settings.overrideMonthlyBudget
    ?? keyRecord.monthly_budget_usd
    ?? null;

  // No limits configured — nothing to enforce
  if (dailyLimit == null && monthlyLimit == null) return;

  // Get current spend from shared cache (refresh if stale)
  let dailySpend = 0;
  let monthlySpend = 0;

  if (spendCache) {
    let cached = spendCache.getDailySpend(keyId);
    if (cached == null && pool) {
      await spendCache.refresh(keyId, pool);
      cached = spendCache.getDailySpend(keyId);
    }
    dailySpend = cached ?? 0;
    monthlySpend = spendCache.getMonthlySpend(keyId) ?? 0;
  }

  // Check daily budget
  if (dailyLimit != null && dailySpend >= dailyLimit) {
    ctx.log.warn('Daily budget exceeded', {
      keyId,
      spent: dailySpend,
      limit: dailyLimit,
    });
    ctx.abort.error(429, `Daily budget exceeded: $${dailySpend.toFixed(4)} / $${dailyLimit.toFixed(2)}`);
    return;
  }

  // Check monthly budget
  if (monthlyLimit != null && monthlySpend >= monthlyLimit) {
    ctx.log.warn('Monthly budget exceeded', {
      keyId,
      spent: monthlySpend,
      limit: monthlyLimit,
    });
    ctx.abort.error(429, `Monthly budget exceeded: $${monthlySpend.toFixed(4)} / $${monthlyLimit.toFixed(2)}`);
    return;
  }
}

/**
 * Post-hook: record the cost of the request in the shared spend cache.
 */
export async function post(ctx, _settings) {
  const keyId = ctx.auth?.keyId || 'anonymous';
  const spendCache = ctx.runtime?.services?.spendCache;

  const usage = ctx.usage;
  if (!usage) return;

  const cost = usage.cost ?? usage.totalCostUsd ?? 0;
  if (cost <= 0) return;

  // Optimistically update the shared cache (avoids DB re-query)
  if (spendCache) {
    spendCache.recordCost(keyId, cost);
  }

  ctx.log.debug('Budget recorded', {
    keyId,
    cost,
  });
}
