/**
 * Built-in middleware: Token Tracker
 *
 * Post-hook: record tokens-per-minute usage after response.
 * Maintains an in-memory per-key TPM counter for observability.
 */

export const meta = {
  key: 'token-tracker',
  name: 'Token Tracker',
  description: 'Records token usage (TPM) per API key after each response.',
  version: '1.0.0',
  defaultSettings: {
    windowMs: 60_000,  // 1-minute window
  },
  hooks: 'post',
};

/**
 * In-memory TPM tracker.
 * key -> { timestamps: Array<{ ts: number, tokens: number }> }
 */
const _tpm = new Map();

/**
 * Post-hook: record token usage.
 */
export async function post(ctx, settings) {
  const usage = ctx.usage;
  if (!usage) return;

  const totalTokens = usage.total_tokens ?? usage.totalTokens ?? 0;
  if (totalTokens <= 0) return;

  const apiKey = ctx.auth?.keyId || 'anonymous';
  const windowMs = settings.windowMs || 60_000;
  const now = Date.now();

  let entries = _tpm.get(apiKey);
  if (!entries) {
    entries = [];
    _tpm.set(apiKey, entries);
  }

  entries.push({ ts: now, tokens: totalTokens });

  // Prune expired entries
  const cutoff = now - windowMs;
  while (entries.length > 0 && entries[0].ts <= cutoff) {
    entries.shift();
  }

  const currentTpm = entries.reduce((sum, e) => sum + e.tokens, 0);

  ctx.log.debug('Token usage recorded', {
    keyId: apiKey,
    tokens: totalTokens,
    tpm: currentTpm,
  });
}

/** Exposed for testing. */
export function _resetTpm() {
  _tpm.clear();
}

export function _getTpm(apiKey) {
  return _tpm.get(apiKey) || [];
}
