import { getProviderById, getProviderApiKey, resolveProviderByName } from '../db/providers-dao.mjs';
import { createLogger } from '../utils/logger.mjs';
import { UpstreamError } from '../utils/errors.mjs';
import { fetchLLMStreaming } from './llm-client.mjs';
import * as authManager from '../providers/auth-manager.mjs';
import { classifyError } from 'achillesAgentLib/utils/LLMProviders/providers/errorClassification.mjs';

const log = createLogger('upstream');

/**
 * Dispatch a request to an LLM provider via direct fetch.
 * Returns an async generator of typed chunks.
 *
 * All provider config (baseURL, API key) is resolved from the DB.
 */
export async function dispatchUpstream(messages, routeResult, params, signal) {
  const { providerKey, providerModel, providerConfigId } = routeResult;

  let dbConfig;

  if (providerConfigId) {
    dbConfig = await getProviderById(providerConfigId);
    if (!dbConfig) {
      throw new UpstreamError(`Provider config "${providerConfigId}" not found in database`, 502, 'provider_not_found');
    }
  } else {
    const resolved = await resolveProviderByName(providerKey);
    if (!resolved) {
      throw new UpstreamError(`Provider "${providerKey}" not configured`, 502, 'provider_not_configured');
    }
    dbConfig = resolved;
  }

  if (!dbConfig.is_enabled) {
    throw new UpstreamError(`Provider "${dbConfig.name}" is disabled`, 502, 'provider_disabled');
  }

  // Internal providers (e.g., search) — no external auth needed, use format converter directly
  if (dbConfig.auth_type === 'internal') {
    const adapter = authManager.getAdapter(dbConfig.name);
    if (adapter?.formatConverter) {
      log.info('Internal provider dispatch', { name: dbConfig.name, model: providerModel });
      const payload = { model: providerModel, messages, ...(params || {}) };
      try {
        return adapter.formatConverter.dispatch(messages, payload, dbConfig.base_url || '', {}, signal);
      } catch (err) {
        if (err instanceof UpstreamError) throw err;
        const classified = classifyProviderError(err, providerKey);
        classified.dbConfig = dbConfig;
        throw classified;
      }
    }
    throw new UpstreamError(`Internal provider "${dbConfig.name}" has no format converter`, 502, 'provider_not_configured');
  }

  if (dbConfig.auth_type === 'managed') {
    log.info('Managed auth provider', { name: dbConfig.name, provider: providerKey });
    const creds = await authManager.getCredentials(dbConfig.name);
    if (!creds) {
      throw new UpstreamError(`Provider "${dbConfig.name}" not authenticated`, 503, 'provider_not_authenticated');
    }
    log.info('Credentials resolved', { hasToken: !!creds.token, hasConverter: !!creds.formatConverter, headerKeys: Object.keys(creds.headers || {}) });
    const baseURL = dbConfig.base_url;
    const payload = { model: providerModel, messages, ...(params || {}) };
    if (creds.formatConverter) {
      try {
        return creds.formatConverter.dispatch(messages, payload, baseURL, creds.headers, signal);
      } catch (err) {
        if (err instanceof UpstreamError) throw err;
        const classified = classifyProviderError(err, providerKey);
        classified.dbConfig = dbConfig;
        throw classified;
      }
    }
    try {
      return fetchLLMStreaming(baseURL, creds.token, payload, signal, creds.headers);
    } catch (err) {
      if (err instanceof UpstreamError) throw err;
      const classified = classifyProviderError(err, providerKey);
      classified.dbConfig = dbConfig;
      throw classified;
    }
  }

  const baseURL = dbConfig.base_url;
  if (!baseURL) {
    throw new UpstreamError(`Missing baseURL for provider "${dbConfig.name}"`, 502, 'provider_not_configured');
  }

  const apiKey = dbConfig.api_key || await getProviderApiKey(dbConfig.id);
  if (!apiKey) {
    throw new UpstreamError(`No API key configured for provider "${dbConfig.name}"`, 401, 'authentication_error');
  }

  const payload = {
    model: providerModel,
    messages,
    ...(params || {}),
  };

  try {
    return fetchLLMStreaming(baseURL, apiKey, payload, signal);
  } catch (err) {
    if (err instanceof UpstreamError) throw err;
    const classified = classifyProviderError(err, providerKey);
    classified.dbConfig = dbConfig;
    throw classified;
  }
}

/**
 * Classify an error from provider calls.
 * Provider errors contain HTTP status in the message like "API Error (429): ...".
 */
export function classifyProviderError(err, providerKey) {
  const message = err?.message || String(err);

  const statusMatch = message.match(/\((\d{3})\)/);
  const status = statusMatch ? parseInt(statusMatch[1], 10) : 0;

  if (status) {
    const classification = classifyError(status);
    return Object.assign(
      new UpstreamError(message, status, classification.type),
      { classification }
    );
  }

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

// classifyError imported from achillesAgentLib — re-export for backward compatibility
export { classifyError };
