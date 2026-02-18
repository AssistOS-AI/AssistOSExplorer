import { dispatchUpstream, classifyError } from './upstream-dispatch.mjs';
import { config } from '../config.mjs';
import { createLogger } from '../utils/logger.mjs';

const log = createLogger('retry');

/**
 * Dispatch upstream with retry logic.
 * Returns { response, retryCount, retryReason, retriesDetail }.
 */
export async function dispatchWithRetry(body, isStreaming) {
  const maxRetries = config.maxRetries;
  let lastError = null;
  const retriesDetail = [];

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 120_000); // 2 min timeout per attempt

      const response = await dispatchUpstream(body, isStreaming, controller.signal);
      clearTimeout(timeout);

      // Success or non-retryable error
      if (response.ok) {
        return {
          response,
          retryCount: attempt,
          retryReason: attempt > 0 ? lastError?.type : null,
          retriesDetail: retriesDetail.length > 0 ? retriesDetail : null,
        };
      }

      // Read error body
      let errorBody = null;
      try {
        errorBody = await response.clone().json();
      } catch { /* ignore */ }

      const classification = classifyError(response.status, errorBody);

      if (classification.critical) {
        log.critical('Upstream authentication failure — check cliproxyapi API key', {
          status: response.status,
        });
      }

      if (!classification.retryable || attempt >= maxRetries) {
        // Return the error response as-is for the pipeline to handle
        return {
          response,
          retryCount: attempt,
          retryReason: classification.type,
          retriesDetail: retriesDetail.length > 0 ? retriesDetail : null,
          errorClassification: classification,
        };
      }

      // Compute delay
      const effectiveMaxRetries = classification.maxRetries ?? maxRetries;
      if (attempt >= effectiveMaxRetries) {
        return {
          response,
          retryCount: attempt,
          retryReason: classification.type,
          retriesDetail: retriesDetail.length > 0 ? retriesDetail : null,
          errorClassification: classification,
        };
      }

      let delayMs = computeDelay(attempt, response, errorBody);

      retriesDetail.push({
        attempt: attempt + 1,
        status: response.status,
        error_type: classification.type,
        delay_ms: delayMs,
      });

      log.warn(`Retrying (${attempt + 1}/${maxRetries})`, {
        status: response.status,
        type: classification.type,
        delayMs,
      });

      await sleep(delayMs);
      lastError = classification;

    } catch (err) {
      // Network-level error (ECONNREFUSED, etc.)
      const classification = {
        retryable: true,
        type: err.type || 'connection_error',
      };

      if (attempt >= maxRetries) {
        throw err;
      }

      let delayMs = computeDelay(attempt, null, null);
      retriesDetail.push({
        attempt: attempt + 1,
        status: 0,
        error_type: classification.type,
        delay_ms: delayMs,
      });

      log.warn(`Retrying after network error (${attempt + 1}/${maxRetries})`, {
        error: err.message,
        delayMs,
      });

      await sleep(delayMs);
      lastError = classification;
    }
  }
}

function computeDelay(attempt, response, errorBody) {
  // Check Retry-After header
  if (response) {
    const retryAfter = response.headers.get('retry-after');
    if (retryAfter) {
      const secs = parseInt(retryAfter, 10);
      if (!isNaN(secs)) return secs * 1000;
    }
  }

  // Check reset_seconds from body (model_cooldown)
  if (errorBody?.reset_seconds) {
    return errorBody.reset_seconds * 1000;
  }

  // Exponential backoff with jitter
  const base = config.initialDelayMs * Math.pow(config.backoffMultiplier, attempt);
  const capped = Math.min(base, config.maxDelayMs);
  const jitter = capped * (config.jitterPercent / 100) * (Math.random() * 2 - 1);
  return Math.max(100, Math.round(capped + jitter));
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
