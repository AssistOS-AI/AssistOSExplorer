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

function parseAliases(value) {
    return String(value || '')
        .split(',')
        .map((alias) => alias.trim())
        .filter(Boolean);
}

async function findAliasTargetModel(appCtx, provider, createdModel = null) {
    if (createdModel) return createdModel;

    const { config, pool } = appCtx;
    const { env } = config;
    const modelsDao = await import('../db/dao/models-dao.mjs');
    const models = await modelsDao.listByProvider(pool, provider.id, {
        enabled: true,
    });

    const configuredModelKey = env.LOCAL_LLM_MODEL
        ? `${PROVIDER_KEY}/${env.LOCAL_LLM_MODEL}`
        : null;
    const configuredModel = configuredModelKey
        ? models.find((model) => model.model_key === configuredModelKey)
        : null;

    return configuredModel || models[0] || null;
}

async function ensureLocalLlmAliases(appCtx, provider, createdModel = null) {
    const { config, pool, log } = appCtx;
    const aliases = parseAliases(config.env.LOCAL_LLM_ALIASES);
    if (aliases.length === 0) return;

    const targetModel = await findAliasTargetModel(
        appCtx,
        provider,
        createdModel
    );
    if (!targetModel) {
        log.warn('local-llm aliases skipped because no enabled model exists');
        return;
    }

    const aliasesDao = await import('../db/dao/model-aliases-dao.mjs');
    for (const alias of aliases) {
        const existing = await aliasesDao.findByAlias(pool, alias);
        if (existing) {
            if (existing.model_key !== targetModel.model_key) {
                log.warn('local-llm alias already points to another model', {
                    alias,
                    target: existing.model_key,
                });
            }
            continue;
        }

        await aliasesDao.create(pool, {
            alias,
            modelId: targetModel.id,
        });
        log.info('local-llm alias created', {
            alias,
            model: targetModel.model_key,
        });
    }
}

async function reconcileExistingLocalLlmProvider(appCtx, providersDao, provider) {
    const { config, log, pool } = appCtx;
    const { env } = config;

    if (!env.LOCAL_LLM_API_KEY) return provider;

    await upsertProviderApiKeyAccount({
        appCtx,
        providerId: provider.id,
        providerDisplayName: provider.display_name || 'Local LLM',
        apiKey: env.LOCAL_LLM_API_KEY,
    });

    if (provider.auth_strategy === 'api_key') {
        log.info('local-llm provider API key account refreshed');
        return provider;
    }

    const updated = await providersDao.update(pool, provider.id, {
        authStrategy: 'api_key',
    });
    log.info('local-llm provider auth strategy updated', {
        authStrategy: 'api_key',
    });
    return updated || { ...provider, auth_strategy: 'api_key' };
}

export async function bootstrapLocalLlmProvider(appCtx) {
    const { config, pool, log } = appCtx;
    const { env } = config;

    if (!pool) return;

    const providersDao = await import('../db/dao/providers-dao.mjs');
    const existing = await providersDao.findByKey(pool, PROVIDER_KEY);
    if (existing) {
        const reconciled = await reconcileExistingLocalLlmProvider(
            appCtx,
            providersDao,
            existing
        );
        await ensureLocalLlmAliases(appCtx, reconciled);
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
            await ensureLocalLlmAliases(appCtx, provider);
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
    const model = await modelsDao.create(pool, {
        modelKey: `${PROVIDER_KEY}/${modelName}`,
        displayName: modelName,
        providerId: provider.id,
        providerModelId: modelName,
        discoverySource: 'manual',
        pricingMode: 'free',
        isFree: true,
    });

    await ensureLocalLlmAliases(appCtx, provider, model);
    log.info('local-llm fallback model created', { model: modelName });
}
