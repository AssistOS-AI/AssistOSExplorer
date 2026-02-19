import { loadModelsConfiguration } from 'achillesAgentLib/utils/LLMClient.mjs';
import { ensureProvider } from 'achillesAgentLib/utils/LLMProviders/providers/providerRegistry.mjs';
import { createLogger } from '../utils/logger.mjs';
import { UpstreamError } from '../utils/errors.mjs';

const log = createLogger('upstream');

// Cache the achillesAgentLib configuration (providers map)
const modelsConfig = loadModelsConfiguration();

/**
 * Dispatch a request to an LLM provider via achillesAgentLib.
 * Returns an async generator of typed chunks.
 *
 * @param {Array} messages - OpenAI-format messages array from client
 * @param {object} routeResult - From model-router: { providerKey, providerModel, ... }
 * @param {object} params - LLM parameters (temperature, max_tokens, etc.)
 * @param {AbortSignal} signal
 * @returns {AsyncGenerator} achillesAgentLib streaming chunks
 */
export async function dispatchUpstream(messages, routeResult, params, signal) {
  const { providerKey, providerModel } = routeResult;

  let provider;
  try {
    provider = ensureProvider(providerKey);
  } catch (err) {
    throw new UpstreamError(`Provider "${providerKey}" not available: ${err.message}`, 502, 'provider_not_found');
  }

  // Resolve baseURL and apiKey from achillesAgentLib's config
  const providerConfig = modelsConfig.providers.get(providerKey);
  if (!providerConfig) {
    throw new UpstreamError(`Provider "${providerKey}" not configured in LLMConfig`, 502, 'provider_not_configured');
  }

  const baseURL = providerConfig.baseURL;
  if (!baseURL) {
    throw new UpstreamError(`Missing baseURL for provider "${providerKey}"`, 502, 'provider_not_configured');
  }

  const apiKeyEnv = providerConfig.apiKeyEnv;
  const apiKey = apiKeyEnv ? process.env[apiKeyEnv] : process.env.LLM_API_KEY;

  if (!apiKey && providerKey !== 'huggingface') {
    throw new UpstreamError(`Missing API key for provider "${providerKey}" (env: ${apiKeyEnv})`, 401, 'authentication_error');
  }

  const options = {
    model: providerModel,
    providerKey,
    apiKey,
    baseURL,
    signal,
    params: params || {},
    headers: {},
  };

  try {
    if (typeof provider.callLLMStreaming !== 'function') {
      throw new UpstreamError(`Provider "${providerKey}" does not support streaming`, 502, 'provider_error');
    }
    // Return the async generator — stream-tap will consume it
    return provider.callLLMStreaming(messages, options);
  } catch (err) {
    if (err instanceof UpstreamError) throw err;
    throw classifyProviderError(err, providerKey);
  }
}

/**
 * Classify an error from achillesAgentLib provider calls.
 * Provider errors contain HTTP status in the message like "API Error (429): ...".
 */
export function classifyProviderError(err, providerKey) {
  const message = err?.message || String(err);

  // Extract HTTP status from error message: "API Error (429): ..."
  const statusMatch = message.match(/\((\d{3})\)/);
  const status = statusMatch ? parseInt(statusMatch[1], 10) : 0;

  if (status) {
    const classification = classifyError(status);
    return Object.assign(
      new UpstreamError(message, status, classification.type),
      { classification }
    );
  }

  // Network errors
  if (err.name === 'AbortError' || message.includes('aborted')) {
    return new UpstreamError('Request aborted', 408, 'timeout');
  }

  const code = err.code || err.cause?.code || '';
  if (code === 'ECONNREFUSED' || code === 'ECONNRESET' || code === 'ETIMEDOUT' ||
      code === 'UND_ERR_CONNECT_TIMEOUT' || message.includes('fetch failed')) {
    return new UpstreamError(`${providerKey} unreachable: ${code || message}`, 502, 'connection_error');
  }

  return new UpstreamError(`${providerKey} error: ${message}`, 502, 'upstream_error');
}

/**
 * Classify an HTTP status code for retry logic.
 */
export function classifyError(status) {
  // Non-retryable
  if (status === 400) return { retryable: false, type: 'invalid_request_error' };
  if (status === 401) return { retryable: false, type: 'authentication_error', critical: true };
  if (status === 402) return { retryable: false, type: 'payment_required' };
  if (status === 403) return { retryable: false, type: 'permission_error' };
  if (status === 404) return { retryable: false, type: 'model_not_found' };

  // Retryable
  if (status === 429) return { retryable: true, type: 'rate_limit_error' };
  if (status === 500) return { retryable: true, type: 'server_error' };
  if (status === 502) return { retryable: true, type: 'bad_gateway' };
  if (status === 503) return { retryable: true, type: 'service_unavailable' };
  if (status === 504) return { retryable: true, type: 'gateway_timeout' };
  if (status === 408) return { retryable: true, type: 'timeout', maxRetries: 1 };

  return { retryable: false, type: 'unknown_error' };
}
