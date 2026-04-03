/**
 * Built-in middleware: Context Compressor
 *
 * Pre-hook: if the conversation messages exceed maxTokens, truncate
 * older messages while preserving the most recent ones.
 *
 * This is a heuristic approach — it estimates tokens from character count
 * (4 chars ≈ 1 token) and summarizes by trimming older messages.
 */

export const meta = {
  key: 'context-compressor',
  name: 'Context Compressor',
  description: 'Compresses conversation context by summarizing older messages when token limit is exceeded.',
  version: '1.0.0',
  defaultSettings: {
    maxTokens: 100_000,
    preserveRecent: 10,     // number of recent messages to always keep
    charsPerToken: 4,       // rough estimate
    summaryPrefix: '[Earlier context summarized] ',
  },
  hooks: 'pre',
};

/**
 * Estimate token count from a string.
 */
function estimateTokens(text, charsPerToken) {
  if (!text) return 0;
  return Math.ceil(text.length / charsPerToken);
}

/**
 * Get the text content of a message.
 */
function messageText(msg) {
  if (typeof msg.content === 'string') return msg.content;
  if (Array.isArray(msg.content)) {
    return msg.content
      .filter((p) => p.type === 'text')
      .map((p) => p.text || '')
      .join(' ');
  }
  return JSON.stringify(msg.content || '');
}

/**
 * Pre-hook: compress context if needed.
 */
export async function pre(ctx, settings) {
  const messages = ctx.request.messages;
  if (!messages || messages.length === 0) return;

  const charsPerToken = settings.charsPerToken || 4;
  const maxTokens = settings.maxTokens || 100_000;
  const preserveRecent = settings.preserveRecent || 10;

  // Estimate total tokens
  let totalTokens = 0;
  for (const msg of messages) {
    totalTokens += estimateTokens(messageText(msg), charsPerToken);
  }

  if (totalTokens <= maxTokens) return;

  ctx.log.info('Context compression triggered', {
    estimatedTokens: totalTokens,
    maxTokens,
    messageCount: messages.length,
  });

  // Split into system messages, old messages, and recent messages
  const systemMessages = [];
  const nonSystemMessages = [];
  for (const msg of messages) {
    if (msg.role === 'system') {
      systemMessages.push(msg);
    } else {
      nonSystemMessages.push(msg);
    }
  }

  if (nonSystemMessages.length <= preserveRecent) return;

  const keepRecent = nonSystemMessages.slice(-preserveRecent);
  const oldMessages = nonSystemMessages.slice(0, -preserveRecent);

  // Build a summary of old messages
  const summaryParts = [];
  for (const msg of oldMessages) {
    const text = messageText(msg);
    // Take first 200 chars of each old message
    const excerpt = text.length > 200 ? text.slice(0, 200) + '...' : text;
    summaryParts.push(`[${msg.role}]: ${excerpt}`);
  }

  const prefix = settings.summaryPrefix || '[Earlier context summarized] ';
  const summaryMsg = {
    role: 'system',
    content: `${prefix}${summaryParts.join('\n')}`,
  };

  // Rebuild messages array
  ctx.request.messages = [...systemMessages, summaryMsg, ...keepRecent];

  ctx.log.info('Context compressed', {
    originalCount: messages.length,
    newCount: ctx.request.messages.length,
    removedMessages: oldMessages.length,
  });
}
