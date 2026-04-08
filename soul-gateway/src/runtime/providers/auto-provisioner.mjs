import { normalizeProviderRecord } from './runtime-record-normalizer.mjs';

/**
 * Auto-provision models for a provider from its plugin's live
 * discoverModels() implementation.
 *
 * Called by OAuthManager after a successful OAuth flow and by
 * `handleCreateProvider` after creating an API-key provider with a
 * credential attached. In both cases the plugin is expected to make
 * a live call to the provider's /models endpoint (via achillesAgentLib)
 * and return the canonical list — there is no hardcoded fallback.
 *
 * The plugin is looked up by the provider's own `adapterKey`, which
 * IS the plugin key. (Earlier revisions passed the OAuth adapter key
 * here, which lived in a different keyspace and made every call
 * silently no-op.) The OAuth adapter key is accepted for logging but
 * ignored for plugin lookup.
 *
 * Credentials are leased from the shared CredentialManager so the
 * plugin can use them to hit the provider's /models endpoint. The
 * lease is always released, even on failure.
 *
 * @param {object} appCtx
 * @param {object} provider          Raw providers DB row
 * @param {string} [oauthAdapterKey] OAuth adapter key — for logging only
 * @returns {Promise<{ discovered: number, created: number }>}
 */
export async function autoProvisionModels(
    appCtx,
    provider,
    oauthAdapterKey = null
) {
    const log = appCtx.log;
    const catalog = appCtx.services.providerCatalog;
    const credentialManager = appCtx.services.credentialManager;
    const normalizedProvider = normalizeProviderRecord(provider);
    const providerKey = normalizedProvider?.providerKey;
    const adapterKey = normalizedProvider?.adapterKey;

    if (!catalog || !provider) {
        return { discovered: 0, created: 0 };
    }

    const pluginKey = adapterKey || oauthAdapterKey;
    const plugin = catalog.getPlugin(pluginKey);
    if (!plugin || typeof plugin.discoverModels !== 'function') {
        log.warn(
            'auto-provision skipped: plugin missing or has no discoverModels',
            {
                provider: providerKey,
                pluginKey,
                oauthAdapterKey,
            }
        );
        return { discovered: 0, created: 0 };
    }

    // Lease credentials so the plugin can hit the provider's /models
    // endpoint. For providers with no credential configured yet the
    // lease is null and we let the plugin decide whether to proceed
    // (some plugins might be able to discover without auth).
    let credentialLease = null;
    if (credentialManager) {
        try {
            credentialLease = await credentialManager.getCredentials(
                provider.id
            );
        } catch (err) {
            log.warn('auto-provision credential lease failed', {
                provider: providerKey,
                error: err.message,
            });
        }
    }

    let discovered = [];
    let discoveryFailed = false;
    try {
        const result = await plugin.discoverModels({
            providerRecord: normalizedProvider,
            credentialLease,
        });
        if (Array.isArray(result)) discovered = result;
    } catch (err) {
        discoveryFailed = true;
        log.warn('auto-provision discovery failed', {
            provider: providerKey,
            pluginKey,
            error: err.message,
        });
    } finally {
        if (credentialLease && credentialManager)
            credentialManager.release(credentialLease);
    }

    if (discoveryFailed) {
        return { discovered: 0, created: 0 };
    }

    if (!discovered.length) {
        log.info('auto-provision returned no models', {
            provider: providerKey,
            pluginKey,
        });
        return { discovered: 0, created: 0 };
    }

    const modelsDao = await import('../../db/dao/models-dao.mjs');
    let created = 0;

    for (const model of discovered) {
        const providerModelId = model.modelId || model.id;
        if (!providerModelId) continue;
        const modelKey = `${providerKey}/${providerModelId}`;
        const existing = await modelsDao.findByKey(appCtx.pool, modelKey);
        if (existing) continue;

        try {
            await modelsDao.create(appCtx.pool, {
                modelKey,
                displayName: model.displayName || providerModelId,
                providerId: provider.id,
                providerModelId,
                executionKind: 'provider_model',
                enabled: true,
                pricingMode: 'external_directory',
                discoverySource: 'auto_provisioned',
                tags: [],
                metadata: model.metadata || {},
            });
            created++;
        } catch (err) {
            // Duplicate key is fine (race condition between concurrent
            // callers racing to provision the same new model).
            if (
                !err.message?.includes('unique') &&
                !err.message?.includes('duplicate')
            ) {
                log.warn('auto-provision model create failed', {
                    provider: providerKey,
                    modelKey,
                    error: err.message,
                });
            }
        }
    }

    log.info('auto-provisioned models', {
        provider: providerKey,
        pluginKey,
        discovered: discovered.length,
        created,
    });

    if (created > 0) {
        // Refresh snapshot so new models are immediately routable
        const { requestRuntimeRefresh } = await import(
            '../registry/runtime-refresh.mjs'
        );
        requestRuntimeRefresh(appCtx, {
            snapshot: true,
            reason: 'auto-provision',
        });
    }

    return { discovered: discovered.length, created };
}
