import { checkRateLimit } from '../pipeline/rate-limiter.mjs';

export default {
  name: 'rate-limiter',
  description: 'Enforces per-key requests-per-minute rate limiting',
  version: '1.0.0',
  type: 'pre',
  supportsStreaming: false,
  defaultSettings: { enabled: true, overrideRpmLimit: null },

  async before(ctx, settings) {
    if (!settings.enabled || !ctx.authCtx) return;
    const rpmLimit = settings.overrideRpmLimit || ctx.authCtx.rpm_limit || 60;
    try {
      await checkRateLimit(ctx.authCtx.api_key_id, rpmLimit, ctx.authCtx.tpm_limit);
    } catch (err) {
      if (err.constructor.name === 'RateLimitError') {
        ctx.abort = true;
        ctx.abortStatus = 429;
        ctx.abortMessage = err.message;
        ctx.metadata.errorType = 'rate_limit_exceeded';
        ctx.metadata.retryAfter = err.retryAfter;
        return;
      }
      throw err;
    }
  },
};
