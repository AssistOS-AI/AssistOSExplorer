/**
 * Extension SDK surface — services available to backend modules and extensions.
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
 * Create the extension context that backend modules and extensions receive via
 * ctx.services.
 *
 * @param {object} appCtx - Application context with pool, config, services
 * @returns {{ services: object }}
 */
export function createExtensionContext(appCtx) {
    async function invokeModel(model, request) {
        const { compose, createKernelContext } = await import(
            '../kernel/index.mjs'
        );
        const { modelExecutionMiddleware } = await import(
            '../execution/model-execution.mjs'
        );
        const { resolveModel } = await import('../registry/model-registry.mjs');
        const { normalizeModelName } = await import(
            '../registry/model-name-normalizer.mjs'
        );
        const snapshot = appCtx.services.snapshot;
        if (!snapshot)
            throw new ConfigurationError('No runtime snapshot available');

        const { normalized } = normalizeModelName(model, snapshot);
        const result = resolveModel(snapshot, normalized);
        if (!result) throw new ModelNotFoundError(model);

        const ctx = createKernelContext({
            requestId: `ext-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            request: { model, ...request },
            target: { model: result.model },
            snapshot,
            services: appCtx.services.extensionServices || Object.freeze({}),
            log: appCtx.log,
            appCtx,
        });
        ctx.metadata.wantStream = !!request?.stream;
        ctx.metadata.onCooldown = () => {};

        const chain = compose([modelExecutionMiddleware()]);
        await chain(ctx);

        return {
            collected: ctx.response,
            accountId: ctx.metadata.backendAccountId || null,
            queueWaitMs: ctx.metadata.queueWaitMs || 0,
            retryTrace: ctx.metadata.retryTrace || [],
            model: ctx.target?.model || result.model,
        };
    }

    async function getCredentialLease(providerId, options) {
        const cm = appCtx.services.credentialManager;
        if (!cm)
            throw new ConfigurationError('CredentialManager not initialized');
        return cm.getCredentials(providerId, options);
    }

    function releaseCredentialLease(lease) {
        const cm = appCtx.services.credentialManager;
        if (!cm)
            throw new ConfigurationError('CredentialManager not initialized');
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

            async signRequest({
                providerId,
                headers = {},
                scheme = 'Bearer',
                options = {},
            }) {
                const lease = await getCredentialLease(providerId, options);
                try {
                    const token =
                        lease?.oauth?.accessToken || lease?.secret || null;
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
         * Delegates to the bootstrap-installed BrowserPool service when available.
         */
        browserPool: Object.freeze({
            async acquire(signal) {
                const pool = appCtx.services?.browserPool;
                if (!pool) {
                    throw new ConfigurationError(
                        'browserPool.acquire() requires BROWSER_POOL_SIZE > 0 and puppeteer-core installed.'
                    );
                }
                return pool.acquire(signal);
            },
            async release(handle) {
                const pool = appCtx.services?.browserPool;
                if (pool) return pool.release(handle);
            },
        }),
    });

    return { services };
}
