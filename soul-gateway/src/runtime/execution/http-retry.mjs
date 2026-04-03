import { ERROR_TYPES } from '../../core/constants.mjs';

/**
 * HTTP-level retry with exponential backoff and jitter.
 *
 * Retries only on retryable errors (as classified by the provider).
 */
export async function executeWithHttpRetry(policy, fn) {
  const {
    maxAttempts = 3,
    baseDelayMs = 1000,
    multiplier = 2,
    maxDelayMs = 30000,
    jitterPct = 0.20,
  } = policy;

  const trace = [];
  let lastError;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const result = await fn(attempt);
      return { result, trace };
    } catch (err) {
      lastError = err;
      trace.push({
        attempt,
        error_type: err.errorType || err.code || ERROR_TYPES.UNKNOWN,
        status: err.httpStatus || null,
        message: err.message,
        timestamp: new Date().toISOString(),
      });

      // Don't retry if not retryable or if this was the last attempt
      if (!err.retryable || attempt >= maxAttempts) break;

      // Calculate delay with exponential backoff and jitter
      const rawDelay = baseDelayMs * Math.pow(multiplier, attempt - 1);
      const cappedDelay = Math.min(rawDelay, maxDelayMs);
      const jitter = cappedDelay * jitterPct * (Math.random() * 2 - 1);
      const delay = Math.max(0, Math.round(cappedDelay + jitter));

      trace[trace.length - 1].delay_ms = delay;
      await sleep(delay);
    }
  }

  return { error: lastError, trace };
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
