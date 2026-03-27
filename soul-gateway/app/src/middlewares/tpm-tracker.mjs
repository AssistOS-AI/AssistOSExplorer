import { trackTokenUsage } from '../pipeline/rate-limiter.mjs';

export default {
  name: 'tpm-tracker',
  description: 'Tracks tokens-per-minute usage per API key (non-blocking observation)',
  version: '1.0.0',
  type: 'post',
  supportsStreaming: true,
  defaultSettings: { enabled: true },

  async after(ctx, settings) {
    if (!settings.enabled || !ctx.authCtx || !ctx.usage) return;
    const totalTokens = ctx.usage.total_tokens || 0;
    if (totalTokens > 0) {
      await trackTokenUsage(
        ctx.authCtx.api_key_id,
        totalTokens,
        ctx.authCtx.tpm_limit
      ).catch(() => {});
    }
  },
};
