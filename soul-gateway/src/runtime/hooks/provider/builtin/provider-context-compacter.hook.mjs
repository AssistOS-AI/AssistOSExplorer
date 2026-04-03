/**
 * Built-in provider hook: Provider Context Compacter
 *
 * Request phase: if the conversation messages exceed maxTokens, summarize
 * older messages while preserving the most recent ones.
 *
 * This is the provider-scoped equivalent of the gateway context-compressor
 * middleware. It operates on ctx.request.messages directly using the hook
 * contract (onRequest), not the middleware contract (pre/post).
 *
 * Heuristic: estimates tokens from character count (4 chars ~ 1 token)
 * and compresses by replacing old messages with a summary.
 */

export const meta = {
  key: 'provider-context-compacter',
  name: 'Provider Context Compacter',
  description: 'Compresses conversation context by summarizing older messages when token limit is exceeded (provider-scoped).',
  version: '1.0.0',
  scope: 'provider',
  phases: ['request'],
  defaultSettings: {
    maxTokens: 100_000,
    preserveRecent: 5,
    charsPerToken: 4,
    summaryPrefix: '[Earlier context summarized] ',
  },
};

/**
 * Estimate token count from a string.
 */
function estimateTokens(text, charsPerToken) {
  if (!text) return 0;
  return Math.ceil(text.length / charsPerToken);
}

/**
 * Extract text content from a message.
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
 * onRequest: compress context if total tokens exceed maxTokens.
 */
export async function onRequest(ctx, settings) {
  const messages = ctx.request?.messages;
  if (!messages || messages.length === 0) return;

  const charsPerToken = settings.charsPerToken || 4;
  const maxTokens = settings.maxTokens || 100_000;
  const preserveRecent = settings.preserveRecent || 5;

  // Estimate total tokens
  let totalTokens = 0;
  for (const msg of messages) {
    totalTokens += estimateTokens(messageText(msg), charsPerToken);
  }

  if (totalTokens <= maxTokens) return;

  // Separate system messages from non-system messages
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
    const excerpt = text.length > 200 ? text.slice(0, 200) + '...' : text;
    summaryParts.push(`[${msg.role}]: ${excerpt}`);
  }

  const prefix = settings.summaryPrefix || '[Earlier context summarized] ';
  const summaryMsg = {
    role: 'system',
    content: `${prefix}${summaryParts.join('\n')}`,
  };

  ctx.request.messages = [...systemMessages, summaryMsg, ...keepRecent];
}
