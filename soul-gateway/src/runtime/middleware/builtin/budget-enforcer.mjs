/**
 * Built-in middleware: Budget Enforcer
 *
 * Checks spend limits before dispatch and records response cost after.
 */

export const meta = Object.freeze({
    key: 'budget-enforcer',
    name: 'Budget Enforcer',
    description:
        'Enforces daily and monthly spend budgets per API key. Blocks requests when budget is exhausted.',
    version: '2.0.0',
    scope: 'gateway',
    defaultSettings: Object.freeze({
        overrideDailyBudget: null,
        overrideMonthlyBudget: null,
    }),
});

export function factory(settings = {}) {
    const merged = { ...meta.defaultSettings, ...settings };

    return async function budgetEnforcer(ctx, next) {
        const keyId = ctx.auth?.keyId || 'anonymous';
        const keyRecord = ctx.auth?.apiKeyRecord || {};
        const spendCache =
            ctx.services?.spendCache || ctx.appCtx?.services?.spendCache;
        const pool = ctx.appCtx?.pool ?? null;

        const dailyLimit =
            merged.overrideDailyBudget ??
            keyRecord.daily_budget_usd ??
            ctx.appCtx?.config?.env?.DEFAULT_DAILY_BUDGET_USD ??
            null;

        const monthlyLimit =
            merged.overrideMonthlyBudget ?? keyRecord.monthly_budget_usd ?? null;

        if (dailyLimit != null || monthlyLimit != null) {
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

            if (dailyLimit != null && dailySpend >= dailyLimit) {
                ctx.log.warn('Daily budget exceeded', {
                    keyId,
                    spent: dailySpend,
                    limit: dailyLimit,
                });
                ctx.abort.error(
                    429,
                    `Daily budget exceeded: $${dailySpend.toFixed(4)} / $${dailyLimit.toFixed(2)}`
                );
            }

            if (monthlyLimit != null && monthlySpend >= monthlyLimit) {
                ctx.log.warn('Monthly budget exceeded', {
                    keyId,
                    spent: monthlySpend,
                    limit: monthlyLimit,
                });
                ctx.abort.error(
                    429,
                    `Monthly budget exceeded: $${monthlySpend.toFixed(4)} / $${monthlyLimit.toFixed(2)}`
                );
            }
        }

        await next();

        const usage = ctx.response?.usage ?? ctx.usage;
        const cost = usage?.cost ?? usage?.totalCostUsd ?? 0;
        if (cost > 0 && spendCache) {
            spendCache.recordCost(keyId, cost);
            ctx.log.debug('Budget recorded', {
                keyId,
                cost,
            });
        }
    };
}
