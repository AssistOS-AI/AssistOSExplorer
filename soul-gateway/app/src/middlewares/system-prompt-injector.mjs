export default {
  name: 'system-prompt-injector',
  description: 'Injects a configurable system message into the conversation per tier',
  version: '1.0.0',
  type: 'pre',
  supportsStreaming: false,
  defaultSettings: {
    content: '',
    position: 'prepend',  // 'prepend' or 'append'
    role: 'system',
  },

  async before(ctx, settings) {
    if (!settings.content) return;

    const msg = { role: settings.role || 'system', content: settings.content };

    if (settings.position === 'append') {
      ctx.messages = [...ctx.messages, msg];
    } else {
      ctx.messages = [msg, ...ctx.messages];
    }
  },
};
