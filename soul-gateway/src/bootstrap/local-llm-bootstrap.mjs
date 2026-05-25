import { isEmbeddedMode } from '../config/env.mjs';
import { upsertProviderApiKeyAccount } from '../runtime/providers/api-key-account.mjs';

const PROVIDER_KEY = 'local-llm';
const DISCOVERY_MODE_AUTO = 'auto';
const DISCOVERY_MODE_SINGLE = 'single';

function normalizeDiscoveryMode(value) {
    const mode = String(value || DISCOVERY_MODE_SINGLE).trim().toLowerCase();
    return mode === DISCOVERY_MODE_AUTO
        ? DISCOVERY_MODE_AUTO
        : DISCOVERY_MODE_SINGLE;
}

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
        authStrategy: env.LOCAL_LLM_API_KEY ? 'api_key' : 'none',
        baseUrl,
        enabled: true,
        supportsStreaming: true,
        supportsTools: true,
    });

    if (env.LOCAL_LLM_API_KEY) {
        await upsertProviderApiKeyAccount({
            appCtx,
            providerId: provider.id,
            providerDisplayName: provider.display_name || 'Local LLM',
            apiKey: env.LOCAL_LLM_API_KEY,
        });
    }

    const discoveryMode = normalizeDiscoveryMode(env.LOCAL_LLM_DISCOVERY_MODE);
    log.info('local-llm provider created', {
        id: provider.id,
        baseUrl,
        authStrategy: env.LOCAL_LLM_API_KEY ? 'api_key' : 'none',
        discoveryMode,
    });

    if (discoveryMode === DISCOVERY_MODE_AUTO) {
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
    }

    const modelName = env.LOCAL_LLM_MODEL;
    if (!modelName || modelName === 'auto') {
        log.warn(
            'local-llm discovery returned no models and LOCAL_LLM_MODEL is not set'
        );
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
