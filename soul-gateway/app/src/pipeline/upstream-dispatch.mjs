import { ensureProvider } from 'achillesAgentLib/utils/LLMProviders/providers/providerRegistry.mjs';
import { getProviderById, getProviderApiKey, resolveProviderByName } from '../db/providers-dao.mjs';
import { createLogger } from '../utils/logger.mjs';
import { UpstreamError } from '../utils/errors.mjs';

const log = createLogger('upstream');

/**
 * Dispatch a request to an LLM provider via achillesAgentLib.
 * Returns an async generator of typed chunks.
 *
 * All provider config (baseURL, API key) is resolved from the DB.
 * achillesAgentLib's ensureProvider() is only used to load protocol modules.
 */
// Map DB provider protocol to achillesAgentLib provider module key
const PROTOCOL_PROVIDER_MAP = {
  'openai': 'openai',
  'anthropic': 'anthropic',
  'google': 'google',
};

export async function dispatchUpstream(messages, routeResult, params, signal) {
  const { providerKey, providerModel, providerConfigId } = routeResult;

  let dbConfig;

  if (providerConfigId) {
    // Look up by ID (model has explicit provider_config_id)
    dbConfig = await getProviderById(providerConfigId);
    if (!dbConfig) {
      throw new UpstreamError(`Provider config "${providerConfigId}" not found in database`, 502, 'provider_not_found');
    }
  } else {
    // Look up by name (fallback for models without provider_config_id)
    const resolved = await resolveProviderByName(providerKey);
    if (!resolved) {
      throw new UpstreamError(`Provider "${providerKey}" not configured`, 502, 'provider_not_configured');
    }
    // resolveProviderByName returns api_key inline, but we need the same shape
    dbConfig = resolved;
  }

  if (!dbConfig.is_enabled) {
    throw new UpstreamError(`Provider "${dbConfig.name}" is disabled`, 502, 'provider_disabled');
  }

  const protocolKey = PROTOCOL_PROVIDER_MAP[dbConfig.protocol] || 'openai';
  let provider;
  try {
    provider = ensureProvider(protocolKey);
  } catch (err) {
    throw new UpstreamError(`Protocol module "${dbConfig.protocol}" not available: ${err.message}`, 502, 'provider_not_found');
  }

  const baseURL = dbConfig.base_url;
  if (!baseURL) {
    throw new UpstreamError(`Missing baseURL for provider "${dbConfig.name}"`, 502, 'provider_not_configured');
  }

  // Get API key: resolveProviderByName returns it inline, getProviderById doesn't
  const apiKey = dbConfig.api_key || await getProviderApiKey(dbConfig.id);
  if (!apiKey) {
    throw new UpstreamError(`No API key configured for provider "${dbConfig.name}"`, 401, 'authentication_error');
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
