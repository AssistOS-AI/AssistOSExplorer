export default {
  name: 'context-compressor',
  description: 'Compresses long conversations by summarizing older messages to reduce token usage (Headroom-inspired)',
  version: '1.0.0',
  type: 'pre',
  supportsStreaming: false,
  defaultSettings: {
    maxTokens: 100000,     // Estimated token threshold to trigger compression
    preserveRecent: 5,     // Number of recent messages to keep intact
    compressionMarker: '[Earlier conversation compressed: {count} messages, ~{tokens} tokens]',
  },

  async before(ctx, settings) {
    if (!Array.isArray(ctx.messages) || ctx.messages.length <= (settings.preserveRecent || 5)) return;

    // Estimate total tokens (rough: 4 chars per token)
    const estimateTokens = (msgs) => msgs.reduce((sum, m) => {
      const content = typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
      return sum + Math.ceil(content.length / 4);
    }, 0);

    const totalTokens = estimateTokens(ctx.messages);
    const maxTokens = settings.maxTokens || 100000;

    if (totalTokens <= maxTokens) return;

    const preserveRecent = settings.preserveRecent || 5;
    const keepFrom = ctx.messages.length - preserveRecent;

    if (keepFrom <= 1) return; // Nothing useful to compress

    // Split: older messages to compress, recent to keep
    const olderMessages = ctx.messages.slice(0, keepFrom);
    const recentMessages = ctx.messages.slice(keepFrom);

    const compressedTokens = estimateTokens(olderMessages);
    const olderCount = olderMessages.length;

    // Build compression summary
    const marker = (settings.compressionMarker || '[Earlier conversation compressed: {count} messages, ~{tokens} tokens]')
      .replace('{count}', olderCount)
      .replace('{tokens}', compressedTokens);

    // Extract key info from older messages: roles and first line of each
    const summaryLines = olderMessages.map(m => {
      const content = typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
      const firstLine = content.split('\n')[0].substring(0, 200);
      return `${m.role}: ${firstLine}`;
    });

    // Keep at most 20 summary lines to avoid the summary itself being too large
    const summaryText = summaryLines.length > 20
      ? [...summaryLines.slice(0, 10), `... (${summaryLines.length - 20} more messages) ...`, ...summaryLines.slice(-10)].join('\n')
      : summaryLines.join('\n');

    const compressedMessage = {
      role: 'system',
      content: `${marker}\n\nKey points from earlier conversation:\n${summaryText}`,
    };

    ctx.messages = [compressedMessage, ...recentMessages];

    // Store metadata for logging
    ctx.metadata.originalMessageCount = olderCount + recentMessages.length;
    ctx.metadata.compressedMessageCount = olderCount;
    ctx.metadata.compressedTokenEstimate = compressedTokens;
    ctx.metadata.newTokenEstimate = estimateTokens(ctx.messages);
  },
};
