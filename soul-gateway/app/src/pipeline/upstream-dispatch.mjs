import { config } from '../config.mjs';
import { createLogger } from '../utils/logger.mjs';
import { UpstreamError } from '../utils/errors.mjs';

const log = createLogger('upstream');

/**
 * Forward the request to cliproxyapi.
 * Returns the raw fetch Response object.
 */
export async function dispatchUpstream(body, isStreaming, signal) {
  const url = `${config.upstreamUrl}/v1/chat/completions`;

  const headers = {
    'Content-Type': 'application/json',
  };

  // Use the proxy API key for cliproxyapi auth if available
  if (config.defaultProxyApiKey) {
    headers['Authorization'] = `Bearer ${config.defaultProxyApiKey}`;
  }

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal,
    });

    return response;
  } catch (err) {
    if (err.name === 'AbortError') {
      throw new UpstreamError('Request aborted', 408, 'timeout');
    }
    // Network errors
    const code = err.code || err.cause?.code || '';
    if (code === 'ECONNREFUSED' || code === 'ECONNRESET' || code === 'ETIMEDOUT' || code === 'UND_ERR_CONNECT_TIMEOUT') {
      throw new UpstreamError(`Upstream unreachable: ${code}`, 502, 'connection_error');
    }
    throw new UpstreamError(`Upstream error: ${err.message}`, 502, 'upstream_error');
  }
}

/**
 * Classify an upstream error response for retry logic.
 */
export function classifyError(status, body) {
  const errorType = body?.error?.type || '';

  // Non-retryable
  if (status === 400) return { retryable: false, type: 'invalid_request_error' };
  if (status === 401) return { retryable: false, type: 'authentication_error', critical: true };
  if (status === 402) return { retryable: false, type: 'payment_required' };
  if (status === 403) return { retryable: false, type: 'permission_error' };
  if (status === 404) return { retryable: false, type: 'model_not_found' };

  // Retryable
  if (status === 429) {
    const type = errorType === 'model_cooldown' ? 'model_cooldown' : 'rate_limit_error';
    return { retryable: true, type };
  }
  if (status === 500) return { retryable: true, type: 'server_error' };
  if (status === 502) return { retryable: true, type: 'bad_gateway' };
  if (status === 503) return { retryable: true, type: 'service_unavailable' };
  if (status === 504) return { retryable: true, type: 'gateway_timeout' };
  if (status === 408) return { retryable: true, type: 'timeout', maxRetries: 1 };

  return { retryable: false, type: errorType || 'unknown_error' };
}
