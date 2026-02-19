import { dispatchUpstream, classifyProviderError, classifyError } from './upstream-dispatch.mjs';
import { config } from '../config.mjs';
import { createLogger } from '../utils/logger.mjs';

const log = createLogger('retry');

/**
 * Dispatch upstream with retry logic.
 *
 * achillesAgentLib's callLLMStreaming throws errors synchronously (before
 * yielding chunks) for connection/auth failures. We retry on those.
 * Once chunks start flowing, retry is not possible — errors are passed
 * through to stream-tap.
 *
 * @param {Array} messages - OpenAI-format messages
 * @param {object} routeResult - From model-router
 * @param {object} params - LLM parameters
 * @returns {{ generator, retryCount, retryReason, retriesDetail }}
 */
export async function dispatchWithRetry(messages, routeResult, params) {
  const maxRetries = config.maxRetries;
  let lastError = null;
  const retriesDetail = [];

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 120_000); // 2 min timeout per attempt

      const generator = await dispatchUpstream(messages, routeResult, params, controller.signal);

      // Peek at the first chunk to verify the generator works.
      // If the provider fails immediately (auth error, connection refused),
      // the first .next() will throw.
      const first = await generator.next();
      clearTimeout(timeout);

      if (first.done) {
        // Empty generator — unlikely but handle gracefully
        return {
          generator: emptyGenerator(),
          retryCount: attempt,
          retryReason: attempt > 0 ? lastError?.type : null,
          retriesDetail: retriesDetail.length > 0 ? retriesDetail : null,
        };
      }

      // Wrap the generator to prepend the first chunk we already consumed
      return {
        generator: prependChunk(first.value, generator),
        retryCount: attempt,
        retryReason: attempt > 0 ? lastError?.type : null,
        retriesDetail: retriesDetail.length > 0 ? retriesDetail : null,
      };

    } catch (err) {
      // Classify the error
      const upstreamErr = err.classification ? err : classifyProviderError(err, routeResult.providerKey);
      const classification = upstreamErr.classification || classifyError(upstreamErr.status || 0);

      if (classification.critical) {
        log.error('Provider authentication failure', {
          provider: routeResult.providerKey,
          status: upstreamErr.status,
        });
      }

      const effectiveMaxRetries = classification.maxRetries ?? maxRetries;

      if (!classification.retryable || attempt >= effectiveMaxRetries) {
        // Non-retryable or exhausted retries — re-throw for pipeline to handle
        upstreamErr.retryCount = attempt;
        upstreamErr.retryReason = classification.type;
        upstreamErr.retriesDetail = retriesDetail.length > 0 ? retriesDetail : null;
        upstreamErr.errorClassification = classification;
        throw upstreamErr;
      }

      const delayMs = computeDelay(attempt);

      retriesDetail.push({
        attempt: attempt + 1,
        status: upstreamErr.status || 0,
        error_type: classification.type,
        delay_ms: delayMs,
      });

      log.warn(`Retrying (${attempt + 1}/${maxRetries})`, {
        provider: routeResult.providerKey,
        type: classification.type,
        error: err.message,
        delayMs,
      });

      await sleep(delayMs);
      lastError = classification;
    }
  }
}

async function* emptyGenerator() {
  yield { type: 'done', fullText: '', usage: {} };
}

async function* prependChunk(firstChunk, generator) {
  yield firstChunk;
  yield* generator;
}

function computeDelay(attempt) {
  const base = config.initialDelayMs * Math.pow(config.backoffMultiplier, attempt);
  const capped = Math.min(base, config.maxDelayMs);
  const jitter = capped * (config.jitterPercent / 100) * (Math.random() * 2 - 1);
  return Math.max(100, Math.round(capped + jitter));
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
