import { ERROR_TYPES } from '../../core/constants.mjs';
import { clampTimerDelay } from './timer-delay.mjs';

/**
 * HTTP-level retry with exponential backoff and jitter.
 *
 * Retries only on retryable errors (as classified by the provider).
 */
export async function executeWithHttpRetry(policy, fn, { signal = null } = {}) {
    const {
        maxAttempts = 3,
        baseDelayMs = 1000,
        multiplier = 2,
        maxDelayMs = 30000,
        jitterPct = 0.2,
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

            // Don't retry if not retryable, if this was the last attempt, or
            // if the caller (client disconnect, cascade budget) has aborted.
            if (!err.retryable || attempt >= maxAttempts) break;
            if (signal?.aborted) break;

            // Calculate delay with exponential backoff and jitter
            const rawDelay = baseDelayMs * Math.pow(multiplier, attempt - 1);
            const cappedDelay = Math.min(rawDelay, maxDelayMs);
            const jitter = cappedDelay * jitterPct * (Math.random() * 2 - 1);
            const delay = Math.max(0, Math.round(cappedDelay + jitter));

            trace[trace.length - 1].delay_ms = delay;
            await sleep(delay, signal);
            if (signal?.aborted) break;
        }
    }

    return { error: lastError, trace };
}

function sleep(ms, signal) {
    return new Promise((resolve) => {
        const timer = setTimeout(done, clampTimerDelay(ms));
        function done() {
            clearTimeout(timer);
            signal?.removeEventListener?.('abort', done);
            resolve();
        }
        signal?.addEventListener?.('abort', done, { once: true });
    });
}
