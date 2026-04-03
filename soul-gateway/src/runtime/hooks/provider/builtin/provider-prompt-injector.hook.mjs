/**
 * Built-in provider hook: Provider Prompt Injector
 *
 * Request phase: prepend or append a system message to the conversation.
 *
 * This is the provider-scoped equivalent of the gateway system-prompt-injector
 * middleware. Useful for injecting provider-specific instructions, persona, or
 * safety guidelines that apply only when routing through a particular provider.
 *
 * Uses the hook contract (onRequest), not the middleware contract (pre/post).
 */

export const meta = {
  key: 'provider-prompt-injector',
  name: 'Provider Prompt Injector',
  description: 'Injects a system message at the beginning or end of the messages array (provider-scoped).',
  version: '1.0.0',
  scope: 'provider',
  phases: ['request'],
  defaultSettings: {
    content: '',
    position: 'prepend',  // 'prepend' | 'append'
    role: 'system',
  },
};

/**
 * onRequest: inject a system message.
 */
export async function onRequest(ctx, settings) {
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
}
