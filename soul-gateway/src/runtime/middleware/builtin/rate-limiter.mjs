/**
 * Built-in middleware: Rate Limiter
 *
 * Pre-hook: check requests-per-minute sliding window.
 * Abort with RateLimitExceededError if exceeded.
 *
 * Uses a simple in-memory sliding window counter per key.
 */

export const meta = {
  key: 'rate-limiter',
  name: 'Rate Limiter',
  description: 'Sliding-window RPM rate limiter. Blocks requests that exceed the configured limit.',
  version: '1.0.0',
  defaultSettings: {
    overrideRpmLimit: null,  // null = use key's rpm_limit or env default
    windowMs: 60_000,        // 1 minute
  },
  hooks: 'pre',
};

/**
 * In-memory sliding window store.
 * key -> array of timestamps (ms).
 */
const _windows = new Map();

/**
 * Pre-hook: enforce RPM limit.
 *
 * @param {Object} ctx
 * @param {Object} settings
 */
export async function pre(ctx, settings) {
  const apiKey = ctx.auth?.keyId || 'anonymous';
  const windowMs = settings.windowMs || 60_000;
  const now = Date.now();

  // Determine effective RPM limit
  const rpmLimit = settings.overrideRpmLimit
    ?? ctx.auth?.rpmLimit
    ?? ctx.runtime?.config?.env?.DEFAULT_RPM_LIMIT
    ?? 60;

  // Get or create window for this key
  let timestamps = _windows.get(apiKey);
  if (!timestamps) {
    timestamps = [];
    _windows.set(apiKey, timestamps);
  }

  // Prune expired timestamps
  const cutoff = now - windowMs;
  while (timestamps.length > 0 && timestamps[0] <= cutoff) {
    timestamps.shift();
  }

  if (timestamps.length >= rpmLimit) {
    const retryAfter = Math.ceil((timestamps[0] + windowMs - now) / 1000);
    ctx.log.warn('Rate limit exceeded', {
      keyId: apiKey,
      rpm: timestamps.length,
      limit: rpmLimit,
      retryAfterSeconds: retryAfter,
    });
    ctx.abort.error(429, `Rate limit exceeded: ${timestamps.length}/${rpmLimit} RPM`);
    return;
  }

  timestamps.push(now);
}

/** Exposed for testing. */
export function _resetWindows() {
  _windows.clear();
}

export function _getWindow(key) {
  return _windows.get(key) || [];
}
