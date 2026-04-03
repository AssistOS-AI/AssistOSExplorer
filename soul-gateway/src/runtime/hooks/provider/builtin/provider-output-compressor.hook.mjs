/**
 * Built-in provider hook: Provider Output Compressor
 *
 * Request phase: truncate verbose tool output in messages before sending
 * to the provider. Targets tool-role and function-role messages with large
 * content, as well as array-style (multimodal) content parts.
 *
 * This is the provider-scoped equivalent of the gateway output-compressor
 * middleware. Uses the hook contract (onRequest), not the middleware contract
 * (pre/post).
 */

export const meta = {
  key: 'provider-output-compressor',
  name: 'Provider Output Compressor',
  description: 'Truncates verbose tool output in messages to save context window tokens (provider-scoped).',
  version: '1.0.0',
  scope: 'provider',
  phases: ['request'],
  defaultSettings: {
    maxOutputLength: 5000,
    truncationMarker: '... [truncated]',
    compressToolMessages: true,
  },
};

/**
 * onRequest: scan messages for tool outputs and truncate if necessary.
 */
export async function onRequest(ctx, settings) {
  const messages = ctx.request?.messages;
  if (!messages || messages.length === 0) return;
  if (!settings.compressToolMessages) return;

  const maxLen = settings.maxOutputLength || 5000;
  const marker = settings.truncationMarker || '... [truncated]';

  for (const msg of messages) {
    // Tool/function role messages with string content
    if ((msg.role === 'tool' || msg.role === 'function') && typeof msg.content === 'string') {
      if (msg.content.length > maxLen) {
        msg.content = msg.content.slice(0, maxLen - marker.length) + marker;
      }
    }

    // Array-style content (multimodal messages)
    if (Array.isArray(msg.content)) {
      for (const part of msg.content) {
        if (part.type === 'text' && typeof part.text === 'string' && part.text.length > maxLen) {
          part.text = part.text.slice(0, maxLen - marker.length) + marker;
        }
      }
    }
  }
}
