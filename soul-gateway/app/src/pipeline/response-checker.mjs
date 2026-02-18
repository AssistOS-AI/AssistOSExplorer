import { config } from '../config.mjs';

/**
 * Check response for truncation and slow request flags.
 */
export function checkResponse(stopReason, latencyMs) {
  return {
    is_truncated: stopReason === 'max_tokens' || stopReason === 'length',
    is_slow: latencyMs > config.slowRequestMs,
  };
}
