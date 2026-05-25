import { isEmbeddedMode } from '../config/env.mjs';

const PROVIDER_KEY = 'local-llm';

export async function bootstrapLocalLlmProvider(appCtx) {
    const { config, pool, log } = appCtx;
    const { env } = config;

    if (!isEmbeddedMode(env)) return;
    if (!env.DATABASE_URL) return;

    const providersDao = await import('../db/dao/providers-dao.mjs');
    const existing = await providersDao.findByKey(pool, PROVIDER_KEY);
    if (existing) {
        log.info('local-llm provider already exists, skipping bootstrap');
        return;
    }

    const baseUrl = env.LOCAL_LLM_BASE_URL;
    if (!baseUrl) {
        log.warn('LOCAL_LLM_BASE_URL not set, skipping local-llm bootstrap');
        return;
    }

    const provider = await providersDao.create(pool, {
        providerKey: PROVIDER_KEY,
        displayName: 'Local LLM',
        kind: 'local_model',
        adapterKey: 'openai-api',
        authStrategy: 'none',
        baseUrl,
        enabled: true,
        supportsStreaming: true,
        supportsTools: true,
    });

    log.info('local-llm provider created', { id: provider.id, baseUrl });

    const { autoProvisionModels } = await import(
        '../runtime/providers/auto-provisioner.mjs'
    );
    const result = await autoProvisionModels(appCtx, provider, null, {
        strict: false,
        discoverySource: 'auto_provisioned',
        refreshReason: 'local-llm-bootstrap',
    });

    if (result.created > 0) {
        log.info('local-llm models discovered', {
            created: result.created,
        });
        return;
    }

    const modelName = env.LOCAL_LLM_MODEL;
    if (!modelName || modelName === 'auto') {
        log.warn('local-llm discovery returned no models and LOCAL_LLM_MODEL is not set');
        return;
    }

    const modelsDao = await import('../db/dao/models-dao.mjs');
    await modelsDao.create(pool, {
        modelKey: `${PROVIDER_KEY}/${modelName}`,
        displayName: modelName,
        providerId: provider.id,
        providerModelId: modelName,
        discoverySource: 'manual',
        pricingMode: 'free',
        isFree: true,
    });

    log.info('local-llm fallback model created', { model: modelName });
}
