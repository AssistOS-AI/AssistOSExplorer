/**
 * Built-in middleware: Response Filter
 *
 * Post-hook: apply regex find/replace patterns to the response text.
 * Useful for redacting PII, stripping unwanted content, or normalizing output.
 */

export const meta = {
  key: 'response-filter',
  name: 'Response Filter',
  description: 'Applies configurable regex patterns to filter or transform response content.',
  version: '1.0.0',
  defaultSettings: {
    patterns: [],
    // Each pattern: { find: string, replace: string, flags?: string }
  },
  hooks: 'post',
};

/**
 * Post-hook: apply all filter patterns to the response.
 */
export async function post(ctx, settings) {
  const patterns = settings.patterns;
  if (!Array.isArray(patterns) || patterns.length === 0) return;
  if (!ctx.response) return;

  const choices = ctx.response.choices;
  if (!Array.isArray(choices)) return;

  let modified = false;

  for (const choice of choices) {
    const msg = choice.message || choice.delta;
    if (!msg || typeof msg.content !== 'string') continue;

    let text = msg.content;

    for (const pat of patterns) {
      if (!pat.find) continue;

      let regex;
      try {
        regex = new RegExp(pat.find, pat.flags || 'g');
      } catch {
        ctx.log.warn('Invalid response-filter pattern', { find: pat.find });
        continue;
      }

      const replaced = text.replace(regex, pat.replace ?? '');
      if (replaced !== text) {
        text = replaced;
        modified = true;
      }
    }

    msg.content = text;
  }

  if (modified) {
    ctx.log.debug('Response filtered', { patternCount: patterns.length });
  }
}
