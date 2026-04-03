/**
 * Auto-provision provider record and known models after first OAuth success.
 *
 * Called by OAuthManager after flow completion when the provider
 * doesn't yet have models in the registry.
 */
export async function autoProvisionAfterOAuth(appCtx, provider, adapterKey) {
  const log = appCtx.log;
  const catalog = appCtx.services.providerCatalog;

  // 1. Get the plugin for this provider's adapter
  const plugin = catalog?.getPlugin(adapterKey);
  if (!plugin || typeof plugin.discoverModels !== 'function') return;

  // 2. Discover known models from the plugin
  let discovered;
  try {
    discovered = await plugin.discoverModels({ providerRecord: provider });
  } catch (err) {
    log.warn('auto-provision discovery failed', { provider: provider.provider_key, error: err.message });
    return;
  }

  if (!discovered?.length) return;

  // 3. Upsert each discovered model into the database
  const modelsDao = await import('../../db/dao/models-dao.mjs');
  let created = 0;

  for (const model of discovered) {
    const modelKey = `${provider.provider_key}/${model.modelId || model.model_key || model.id}`;
    const existing = await modelsDao.findByKey(appCtx.pool, modelKey);
    if (existing) continue;

    try {
      await modelsDao.create(appCtx.pool, {
        modelKey,
        displayName: model.displayName || model.display_name || modelKey,
        providerId: provider.id,
        providerModelId: model.modelId || model.provider_model_id || model.id,
        executionKind: 'provider_model',
        enabled: true,
        pricingMode: 'external_directory',
        discoverySource: 'auto_provisioned',
        tags: [],
      });
      created++;
    } catch (err) {
      // Duplicate key is fine (race condition)
      if (!err.message?.includes('unique') && !err.message?.includes('duplicate')) {
        log.warn('auto-provision model create failed', { modelKey, error: err.message });
      }
    }
  }

  if (created > 0) {
    log.info('auto-provisioned models', { provider: provider.provider_key, count: created });

    // Refresh snapshot so new models are immediately available
    const { requestRuntimeRefresh } = await import('../registry/runtime-refresh.mjs');
    requestRuntimeRefresh(appCtx, { snapshot: true, reason: 'oauth.auto-provision' });
  }
}
