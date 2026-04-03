/**
 * Built-in provider hook: Provider Response Filter
 *
 * Response phase: apply regex find/replace patterns to the response content.
 * Useful for provider-specific redaction, normalization, or post-processing.
 *
 * This is the provider-scoped equivalent of the gateway response-filter
 * middleware. Uses the hook contract (onResponse), not the middleware contract
 * (pre/post).
 *
 * Reads from ctx.response.content (or ctx.response.choices[].message.content)
 * and writes back.
 */

export const meta = {
  key: 'provider-response-filter',
  name: 'Provider Response Filter',
  description: 'Applies configurable regex patterns to filter or transform response content (provider-scoped).',
  version: '1.0.0',
  scope: 'provider',
  phases: ['response'],
  defaultSettings: {
    patterns: [],
    // Each pattern: { find: string, replace: string, flags?: string }
    replacement: '[REDACTED]',
  },
};

/**
 * onResponse: apply all filter patterns to the response.
 */
export async function onResponse(ctx, settings) {
  const patterns = settings.patterns;
  if (!Array.isArray(patterns) || patterns.length === 0) return;
  if (!ctx.response) return;

  // Handle direct content on ctx.response
  if (typeof ctx.response.content === 'string') {
    ctx.response.content = applyPatterns(ctx.response.content, patterns, settings.replacement);
    return;
  }

  // Handle OpenAI-style choices array
  const choices = ctx.response.choices;
  if (!Array.isArray(choices)) return;

  for (const choice of choices) {
    const msg = choice.message || choice.delta;
    if (!msg || typeof msg.content !== 'string') continue;
    msg.content = applyPatterns(msg.content, patterns, settings.replacement);
  }
}

/**
 * Apply an array of { find, replace, flags } patterns to text.
 */
function applyPatterns(text, patterns, defaultReplacement) {
  let result = text;

  for (const pat of patterns) {
    if (!pat.find) continue;

    let regex;
    try {
      regex = new RegExp(pat.find, pat.flags || 'g');
    } catch {
      continue;
    }

    result = result.replace(regex, pat.replace ?? defaultReplacement ?? '');
  }

  return result;
}
