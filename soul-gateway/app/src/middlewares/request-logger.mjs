import { createLogger } from '../utils/logger.mjs';

const log = createLogger('mw:request-logger');

export default {
  name: 'request-logger',
  description: 'Logs request and response metadata for debugging and observability',
  version: '1.0.0',
  type: 'both',
  supportsStreaming: true,
  defaultSettings: {
    logLevel: 'debug',
  },

  async before(ctx, settings) {
    const msgCount = Array.isArray(ctx.messages) ? ctx.messages.length : 0;
    const totalChars = Array.isArray(ctx.messages)
      ? ctx.messages.reduce((sum, m) => sum + (typeof m.content === 'string' ? m.content.length : JSON.stringify(m.content).length), 0)
      : 0;
    const estimatedTokens = Math.ceil(totalChars / 4);

    ctx.metadata.mwStartedAt = Date.now();
    ctx.metadata.estimatedInputTokens = estimatedTokens;

    log[settings.logLevel || 'debug']('Request', {
      model: ctx.model,
      tier: ctx.tier,
      agent: ctx.agentName,
      session: ctx.sessionId,
      messageCount: msgCount,
      estimatedTokens,
      streaming: ctx.isStreaming,
    });
  },

  async after(ctx, settings) {
    const latency = ctx.metadata.mwStartedAt ? Date.now() - ctx.metadata.mwStartedAt : null;
    const responseLen = typeof ctx.response === 'string' ? ctx.response.length : 0;

    log[settings.logLevel || 'debug']('Response', {
      model: ctx.model,
      tier: ctx.tier,
      responseChars: responseLen,
      promptTokens: ctx.usage?.prompt_tokens,
      completionTokens: ctx.usage?.completion_tokens,
      totalTokens: ctx.usage?.total_tokens,
      mwLatencyMs: latency,
    });
  },
};
