export default {
  name: 'output-compressor',
  description: 'Compresses verbose tool/CLI output blocks in messages to reduce token usage (RTK-inspired)',
  version: '1.0.0',
  type: 'pre',
  supportsStreaming: false,
  defaultSettings: {
    maxOutputLength: 5000,   // Max characters per tool output block
    truncationMarker: '... [output truncated: {original} chars → {truncated} chars]',
    // Patterns that identify tool output (content between triple backticks, or tool role messages)
    compressToolMessages: true,
    compressCodeBlocks: true,
  },

  async before(ctx, settings) {
    if (!Array.isArray(ctx.messages)) return;

    const maxLen = settings.maxOutputLength || 5000;
    let totalSaved = 0;

    ctx.messages = ctx.messages.map(msg => {
      const content = typeof msg.content === 'string' ? msg.content : null;
      if (!content) return msg;

      // Compress tool-role messages (typically contain CLI/tool output)
      if (settings.compressToolMessages && msg.role === 'tool' && content.length > maxLen) {
        const truncated = truncateOutput(content, maxLen, settings.truncationMarker);
        totalSaved += content.length - truncated.length;
        return { ...msg, content: truncated };
      }

      // Compress large code blocks within any message
      if (settings.compressCodeBlocks && content.length > maxLen) {
        const compressed = compressCodeBlocks(content, maxLen, settings.truncationMarker);
        if (compressed !== content) {
          totalSaved += content.length - compressed.length;
          return { ...msg, content: compressed };
        }
      }

      return msg;
    });

    if (totalSaved > 0) {
      ctx.metadata.outputCompressionSaved = totalSaved;
      ctx.metadata.outputCompressionSavedTokens = Math.ceil(totalSaved / 4);
    }
  },
};

function truncateOutput(content, maxLen, markerTemplate) {
  if (content.length <= maxLen) return content;

  // Keep first portion and last portion
  const keepStart = Math.floor(maxLen * 0.7);
  const keepEnd = Math.floor(maxLen * 0.2);
  const marker = (markerTemplate || '... [truncated]')
    .replace('{original}', content.length)
    .replace('{truncated}', keepStart + keepEnd);

  return content.substring(0, keepStart) + '\n' + marker + '\n' + content.substring(content.length - keepEnd);
}

function compressCodeBlocks(content, maxLen, markerTemplate) {
  // Find triple-backtick code blocks and truncate large ones
  return content.replace(/```[\s\S]*?```/g, (block) => {
    if (block.length <= maxLen) return block;
    // Extract language hint from opening fence
    const firstLine = block.split('\n')[0];
    const inner = block.slice(firstLine.length + 1, -3); // Strip fences
    const truncated = truncateOutput(inner, maxLen - 20, markerTemplate);
    return firstLine + '\n' + truncated + '\n```';
  });
}
