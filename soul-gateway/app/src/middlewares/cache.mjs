import { findCachedResponse } from '../db/logs-dao.mjs';
import { sha256 } from '../utils/crypto.mjs';

export default {
  name: 'cache',
  description: 'Returns cached responses for identical prompts, avoiding redundant LLM calls. Assign with sort_order 999 so it runs after all other pre-middlewares.',
  version: '1.0.0',
  type: 'pre',
  supportsStreaming: false,
  defaultSettings: {
    enabled: true,
  },

  async before(ctx, settings) {
    if (!settings.enabled) return;

    // Skip streaming requests (cached responses are complete objects)
    if (ctx.isStreaming) return;

    // Compute prompt hash from final messages + model.
    // This runs AFTER all other pre-middlewares (highest sort_order),
    // so ctx.messages reflects any mutations from earlier middlewares.
    const promptHash = sha256(JSON.stringify(ctx.messages) + '||' + ctx.model);

    const cached = await findCachedResponse(promptHash, ctx.model);
    if (!cached) return;

    // Cache hit: abort with success response
    ctx.abort = true;
    ctx.abortStatus = 200;
    ctx.abortResponse = {
      content: cached.response_content,
      stopReason: cached.stop_reason || 'stop',
      usage: {
        prompt_tokens: cached.prompt_tokens || 0,
        completion_tokens: cached.completion_tokens || 0,
        total_tokens: cached.total_tokens || 0,
      },
      headers: { 'X-Cache': 'HIT' },
      cacheHit: true,
      promptHash,
    };
  },
};
