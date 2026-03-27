export default {
  name: 'response-filter',
  description: 'Applies regex-based find/replace on response content for redaction or filtering',
  version: '1.0.0',
  type: 'post',
  supportsStreaming: false,
  defaultSettings: {
    patterns: [],        // Array of regex pattern strings
    replacement: '[REDACTED]',
  },

  async after(ctx, settings) {
    if (!ctx.response || !Array.isArray(settings.patterns) || settings.patterns.length === 0) return;

    let content = ctx.response;
    const replacement = settings.replacement || '[REDACTED]';

    for (const pattern of settings.patterns) {
      try {
        const regex = new RegExp(pattern, 'gi');
        content = content.replace(regex, replacement);
      } catch {
        // Skip invalid regex patterns
      }
    }

    ctx.response = content;
  },
};
