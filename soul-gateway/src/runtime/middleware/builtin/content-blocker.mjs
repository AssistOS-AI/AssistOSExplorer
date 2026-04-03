/**
 * Built-in middleware: Content Blocker
 *
 * Pre-hook: evaluate request messages against blacklist rules.
 * Abort with ContentBlockedError on match.
 */

export const meta = {
  key: 'content-blocker',
  name: 'Content Blocker',
  description: 'Blocks requests whose messages match configurable blacklist patterns.',
  version: '1.0.0',
  defaultSettings: {
    rules: [],
    // Each rule: { pattern: string, flags?: string, description?: string }
  },
  hooks: 'pre',
};

/**
 * Pre-hook: scan all message contents against blacklist rules.
 */
export async function pre(ctx, settings) {
  const rules = settings.rules;
  if (!Array.isArray(rules) || rules.length === 0) return;

  const messages = ctx.request.messages || [];
  const fullText = messages
    .map((m) => typeof m.content === 'string' ? m.content : JSON.stringify(m.content || ''))
    .join('\n');

  for (const rule of rules) {
    if (!rule.pattern) continue;

    let regex;
    try {
      regex = new RegExp(rule.pattern, rule.flags || 'i');
    } catch {
      ctx.log.warn('Invalid content-blocker rule pattern', { pattern: rule.pattern });
      continue;
    }

    if (regex.test(fullText)) {
      const description = rule.description || rule.pattern;
      ctx.log.warn('Content blocked', { rule: description });
      ctx.abort.error(400, `Content blocked: ${description}`);
      return;
    }
  }
}
