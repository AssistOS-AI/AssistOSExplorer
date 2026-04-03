/**
 * Extension SDK surface — services available to provider plugins and extensions.
 *
 * invokeModel: route a sub-request through the gateway pipeline
 * invokeSearch: dispatch a search query to a search-type model
 * credentials: access provider credential material
 * tokenEstimator: estimate token counts for messages
 * browserPool: acquire/release headless browser instances (placeholder until actual browser pool)
 */
import { estimatePromptTokens } from '../policy/token-estimator.mjs';
import { ConfigurationError, ModelNotFoundError } from '../../core/errors.mjs';

/**
 * Create the extension context that provider plugins receive via ctx.services.
 *
 * @param {object} appCtx - Application context with pool, config, services
 * @returns {{ services: object }}
 */
export function createExtensionContext(appCtx) {
  async function invokeModel(model, request) {
    const { executeResolvedRequest } = await import('../execution/execution-engine.mjs');
    const { resolveModel, resolveTier } = await import('../registry/model-registry.mjs');
    const { normalizeModelName } = await import('../registry/model-name-normalizer.mjs');
    const snapshot = appCtx.services.snapshot;
    if (!snapshot) throw new ConfigurationError('No runtime snapshot available');

    const { normalized, kind } = normalizeModelName(model, snapshot);

    let resolvedModel = null;
    let resolvedTier = null;

    if (kind === 'model') {
      const result = resolveModel(snapshot, normalized);
      if (!result) throw new ModelNotFoundError(model);
      resolvedModel = result.model;
    } else if (kind === 'tier') {
      const result = resolveTier(snapshot, normalized);
      if (!result) throw new ModelNotFoundError(model);
      resolvedTier = result.tier;
    } else {
      throw new ModelNotFoundError(model);
    }

    return executeResolvedRequest({
      resolvedModel,
      resolvedTier,
      normalizedRequest: { model, ...request },
      snapshot,
      appCtx,
      concurrencyController: appCtx.services.concurrencyController,
      providerCatalog: appCtx.services.providerCatalog || null,
      credentialManager: appCtx.services.credentialManager || null,
      onCooldown: () => {},
      log: appCtx.log,
    });
  }

  async function getCredentialLease(providerId, options) {
    const cm = appCtx.services.credentialManager;
    if (!cm) throw new ConfigurationError('CredentialManager not initialized');
    return cm.getCredentials(providerId, options);
  }

  function releaseCredentialLease(lease) {
    const cm = appCtx.services.credentialManager;
    if (!cm) throw new ConfigurationError('CredentialManager not initialized');
    cm.release(lease);
  }

  const services = Object.freeze({
      /**
       * Route a sub-request through the full gateway pipeline.
       * Useful for orchestrator models that need to call other models.
       *
       * @param {string} model - model key or tier key to invoke
       * @param {object} request - { messages, stream?, ...params }
       * @returns {Promise<object>} collected response with usage
       */
      invokeModel,

      /**
       * Dispatch a search query to a specific search model.
       *
       * @param {string} searchModel - search model key (e.g., 'search/tavily-search')
       * @param {string} query - the search query
       * @returns {Promise<object>} search results as collected response
       */
      async invokeSearch(searchModel, query) {
        return invokeModel(searchModel, {
          messages: [{ role: 'user', content: query }],
          stream: false,
        });
      },

      /**
       * Access provider credentials.
       */
      credentials: Object.freeze({
        get: getCredentialLease,

        release(lease) {
          releaseCredentialLease(lease);
        },

        async signRequest({ providerId, headers = {}, scheme = 'Bearer', options = {} }) {
          const lease = await getCredentialLease(providerId, options);
          try {
            const token = lease?.oauth?.accessToken || lease?.secret || null;
            if (!token) return { ...headers };
            return { ...headers, Authorization: `${scheme} ${token}` };
          } finally {
            if (lease) releaseCredentialLease(lease);
          }
        },
      }),

      /**
       * Token estimation utilities.
       */
      tokenEstimator: Object.freeze({
        estimate(request) {
          return estimatePromptTokens(request);
        },
        countTokens(text) {
          if (!text) return 0;
          return Math.ceil(text.length / 4);
        },
      }),

      /**
       * Browser pool for headless browser automation (e.g., Google AI Mode search).
       * This is a placeholder — real implementation would use puppeteer/playwright.
       */
      browserPool: Object.freeze({
        async acquire() {
          throw new ConfigurationError(
            'browserPool.acquire() requires a browser runtime (puppeteer/playwright). ' +
            'Install one and configure BROWSER_POOL_SIZE to enable headless browser extensions.'
          );
        },
        async release(_browser) {
          // no-op
        },
      }),
  });

  return { services };
}
