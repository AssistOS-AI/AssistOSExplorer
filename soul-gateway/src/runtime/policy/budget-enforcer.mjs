/**
 * Budget enforcement policy module.
 *
 * Checks per-key daily and monthly budget limits against the cached spend.
 * Free models are exempt — the caller must check `is_free` before calling.
 */

/**
 * Check whether a key is within its budget limits.
 *
 * Refreshes the spend cache if it has gone stale.
 *
 * @param {object} keyRecord      Database row from api_keys table
 * @param {import('./spend-cache.mjs').SpendCache} spendCache
 * @param {object} pool           pg Pool
 * @returns {Promise<{ allowed: boolean, dailySpend: number, monthlySpend: number, dailyLimit: number|null, monthlyLimit: number|null }>}
 */
export async function checkBudget(keyRecord, spendCache, pool) {
    const keyId = keyRecord.id;
    const dailyLimit = keyRecord.daily_budget_usd ?? null;
    const monthlyLimit = keyRecord.monthly_budget_usd ?? null;

    // If no limits are configured, always allow
    if (dailyLimit == null && monthlyLimit == null) {
        return {
            allowed: true,
            dailySpend: 0,
            monthlySpend: 0,
            dailyLimit,
            monthlyLimit,
        };
    }

    // Ensure cache is fresh
    let dailySpend = spendCache.getDailySpend(keyId);
    let monthlySpend = spendCache.getMonthlySpend(keyId);

    if (dailySpend == null || monthlySpend == null) {
        await spendCache.refresh(keyId, pool);
        dailySpend = spendCache.getDailySpend(keyId);
        monthlySpend = spendCache.getMonthlySpend(keyId);
    }

    // Fallback to 0 if cache somehow still null
    dailySpend = dailySpend ?? 0;
    monthlySpend = monthlySpend ?? 0;

    let allowed = true;

    if (dailyLimit != null && dailySpend >= dailyLimit) {
        allowed = false;
    }

    if (monthlyLimit != null && monthlySpend >= monthlyLimit) {
        allowed = false;
    }

    return { allowed, dailySpend, monthlySpend, dailyLimit, monthlyLimit };
}

/**
 * Update the cached spend after a successful request.
 *
 * @param {string} keyId
 * @param {number} costUsd
 * @param {import('./spend-cache.mjs').SpendCache} spendCache
 */
export function recordSpend(keyId, costUsd, spendCache) {
    spendCache.recordCost(keyId, costUsd);
}
