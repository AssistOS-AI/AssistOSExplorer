/**
 * Built-in middleware: System Prompt Injector
 *
 * Pre-hook: prepend or append a system message to the conversation.
 * Useful for injecting safety instructions, persona, or guidelines.
 */

export const meta = {
  key: 'system-prompt-injector',
  name: 'System Prompt Injector',
  description: 'Injects a system message at the beginning or end of the messages array.',
  version: '1.0.0',
  defaultSettings: {
    content: '',
    position: 'prepend',  // 'prepend' | 'append'
    role: 'system',        // usually 'system', could be 'developer' for some providers
  },
  hooks: 'pre',
};

/**
 * Pre-hook: inject system message.
 */
export async function pre(ctx, settings) {
  const content = settings.content;
  if (!content) return;

  if (!ctx.request.messages) ctx.request.messages = [];

  const injected = {
    role: settings.role || 'system',
    content,
  };

  const position = settings.position || 'prepend';

  if (position === 'append') {
    ctx.request.messages.push(injected);
  } else {
    // Prepend — insert after any existing system messages at the start
    let insertIdx = 0;
    while (
      insertIdx < ctx.request.messages.length
      && ctx.request.messages[insertIdx].role === 'system'
    ) {
      insertIdx++;
    }
    ctx.request.messages.splice(insertIdx, 0, injected);
  }

  ctx.log.debug('System prompt injected', { position, length: content.length });
}
