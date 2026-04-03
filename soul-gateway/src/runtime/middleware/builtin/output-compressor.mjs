/**
 * Built-in middleware: Output Compressor
 *
 * Pre-hook: truncate verbose tool/function output in messages to reduce
 * context window consumption. Targets assistant messages with tool_calls
 * and tool-role messages with large content.
 */

export const meta = {
  key: 'output-compressor',
  name: 'Output Compressor',
  description: 'Truncates verbose tool output in messages to save context window tokens.',
  version: '1.0.0',
  defaultSettings: {
    maxOutputLength: 8000,
    truncationMarker: '\n... [output truncated] ...',
  },
  hooks: 'pre',
};

/**
 * Pre-hook: scan messages for tool outputs and truncate if necessary.
 */
export async function pre(ctx, settings) {
  const messages = ctx.request.messages;
  if (!messages || messages.length === 0) return;

  const maxLen = settings.maxOutputLength || 8000;
  const marker = settings.truncationMarker || '\n... [output truncated] ...';
  let truncatedCount = 0;

  for (const msg of messages) {
    // Tool role messages (function/tool responses)
    if ((msg.role === 'tool' || msg.role === 'function') && typeof msg.content === 'string') {
      if (msg.content.length > maxLen) {
        msg.content = msg.content.slice(0, maxLen - marker.length) + marker;
        truncatedCount++;
      }
    }

    // Array-style content (multimodal messages)
    if (Array.isArray(msg.content)) {
      for (const part of msg.content) {
        if (part.type === 'text' && typeof part.text === 'string' && part.text.length > maxLen) {
          part.text = part.text.slice(0, maxLen - marker.length) + marker;
          truncatedCount++;
        }
      }
    }
  }

  if (truncatedCount > 0) {
    ctx.log.debug('Output compressed', { truncatedMessages: truncatedCount, maxLength: maxLen });
  }
}
