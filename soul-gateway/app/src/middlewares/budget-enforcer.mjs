import { checkBudget, trackSpend } from '../pipeline/cost-throttler.mjs';

export default {
  name: 'budget-enforcer',
  description: 'Enforces daily spending budget per API key and tracks post-response spend',
  version: '1.0.0',
  type: 'both',
  supportsStreaming: false,
  defaultSettings: { enabled: true, overrideDailyBudget: null },

  async before(ctx, settings) {
    if (!settings.enabled || !ctx.authCtx) return;
    const authCtx = settings.overrideDailyBudget
      ? { ...ctx.authCtx, key_daily_budget: settings.overrideDailyBudget }
      : ctx.authCtx;
    try {
      await checkBudget(authCtx);
    } catch (err) {
      if (err.constructor.name === 'BudgetExceededError') {
        ctx.abort = true;
        ctx.abortStatus = 429;
        ctx.abortMessage = err.message;
        ctx.metadata.errorType = 'budget_exceeded';
        return;
      }
      throw err;
    }
  },

  async after(ctx, settings) {
    if (!settings.enabled || !ctx.authCtx) return;
    const totalCost = ctx.metadata?.totalCost;
    const isFree = ctx.metadata?.isFree;
    if (totalCost && totalCost > 0) {
      trackSpend(ctx.authCtx, totalCost, isFree);
    }
  },
};
