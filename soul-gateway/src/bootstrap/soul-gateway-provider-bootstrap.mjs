import { upsertProviderApiKeyAccount } from '../runtime/providers/api-key-account.mjs';

const PROVIDER_KEY = 'soul-gateway';
const DISPLAY_NAME = 'Soul Gateway';
const DEFAULT_BASE_URL = 'https://soul.axiologic.dev/v1';
const DISCOVERY_MODE_AUTO = 'auto';
const DISCOVERY_MODE_OFF = 'off';

function normalizeBaseUrl(value) {
    const baseUrl = String(value || DEFAULT_BASE_URL).trim();
    return baseUrl.endsWith('/') ? baseUrl.slice(0, -1) : baseUrl;
}

function normalizeDiscoveryMode(value) {
    const mode = String(value || DISCOVERY_MODE_AUTO).trim().toLowerCase();
    return mode === DISCOVERY_MODE_OFF ? DISCOVERY_MODE_OFF : DISCOVERY_MODE_AUTO;
}

function parseAliases(value) {
    const aliases = String(value || '')
        .split(',')
        .map((alias) => alias.trim())
        .filter(Boolean);
    return [...new Set(aliases)];
}

async function upsertProviderAccount(appCtx, provider) {
    const apiKey = appCtx.config.env.SOUL_GATEWAY_PROVIDER_API_KEY;
    if (!apiKey) return;

    await upsertProviderApiKeyAccount({
        appCtx,
        providerId: provider.id,
        providerDisplayName: DISPLAY_NAME,
        apiKey,
    });
}

async function reconcileExistingProvider(appCtx, providersDao, provider, baseUrl) {
    const { pool, log } = appCtx;
    await upsertProviderAccount(appCtx, provider);

    const fields = {};
    if (provider.display_name !== DISPLAY_NAME) fields.displayName = DISPLAY_NAME;
    if (provider.kind !== 'external_api') fields.kind = 'external_api';
    if (provider.adapter_key !== 'openai-api') fields.adapterKey = 'openai-api';
    if (provider.auth_strategy !== 'api_key') fields.authStrategy = 'api_key';
    if (provider.base_url !== baseUrl) fields.baseUrl = baseUrl;
    if (provider.enabled !== true) fields.enabled = true;
    if (provider.supports_streaming !== true) fields.supportsStreaming = true;
    if (provider.supports_tools !== true) fields.supportsTools = true;

    if (Object.keys(fields).length === 0) {
        log.info('Soul Gateway provider already configured');
        return provider;
    }

    const updated = await providersDao.update(pool, provider.id, fields);
    log.info('Soul Gateway provider reconciled', {
        id: provider.id,
        baseUrl,
    });
    return updated || { ...provider, ...fields };
}

async function ensureMirroredAliases(appCtx, provider) {
    const { config, pool, log } = appCtx;
    const aliases = parseAliases(config.env.SOUL_GATEWAY_PROVIDER_ALIASES);
    if (aliases.length === 0) return;

    const modelsDao = await import('../db/dao/models-dao.mjs');
    const models = await modelsDao.listByProvider(pool, provider.id, {
        enabled: true,
    });
    const modelsByKey = new Map(models.map((model) => [model.model_key, model]));
    const aliasesDao = await import('../db/dao/model-aliases-dao.mjs');

    for (const alias of aliases) {
        const targetModelKey = `${PROVIDER_KEY}/${alias}`;
        const targetModel = modelsByKey.get(targetModelKey);
        if (!targetModel) {
            log.warn('Soul Gateway provider alias skipped', {
                alias,
                target: targetModelKey,
            });
            continue;
        }

        const existing = await aliasesDao.findByAlias(pool, alias);
        if (existing) {
            if (existing.model_key === targetModel.model_key) {
                continue;
            }
            if (String(existing.model_key || '').startsWith('local-llm/')) {
                await aliasesDao.updateModel(pool, {
                    alias,
                    modelId: targetModel.id,
                });
                log.info('Soul Gateway provider alias reassigned', {
                    alias,
                    previous: existing.model_key,
                    model: targetModel.model_key,
                });
            } else {
                log.warn('Soul Gateway provider alias already points elsewhere', {
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
        log.info('Soul Gateway provider alias created', {
            alias,
            model: targetModel.model_key,
        });
    }
}

async function discoverProviderModels(appCtx, provider) {
    const discoveryMode = normalizeDiscoveryMode(
        appCtx.config.env.SOUL_GATEWAY_PROVIDER_DISCOVERY_MODE
    );
    if (discoveryMode === DISCOVERY_MODE_OFF) {
        appCtx.log.info('Soul Gateway provider model discovery disabled');
        return;
    }

    const { autoProvisionModels } = await import(
        '../runtime/providers/auto-provisioner.mjs'
    );
    const result = await autoProvisionModels(appCtx, provider, null, {
        strict: false,
        discoverySource: 'auto_provisioned',
        refreshReason: 'soul-gateway-provider-bootstrap',
    });

    if (result.discovered > 0) {
        await ensureMirroredAliases(appCtx, provider);
    }
}

export async function bootstrapSoulGatewayProvider(appCtx) {
    const { config, pool, log } = appCtx;
    const { env } = config;

    if (!pool) return;
    if (!env.SOUL_GATEWAY_PROVIDER_API_KEY) {
        log.info(
            'SOUL_GATEWAY_PROVIDER_API_KEY not set, skipping Soul Gateway provider bootstrap'
        );
        return;
    }

    const providersDao = await import('../db/dao/providers-dao.mjs');
    const baseUrl = normalizeBaseUrl(env.SOUL_GATEWAY_PROVIDER_BASE_URL);
    const existing = await providersDao.findByKey(pool, PROVIDER_KEY);
    const provider = existing
        ? await reconcileExistingProvider(appCtx, providersDao, existing, baseUrl)
        : await providersDao.create(pool, {
            providerKey: PROVIDER_KEY,
            displayName: DISPLAY_NAME,
            kind: 'external_api',
            adapterKey: 'openai-api',
            authStrategy: 'api_key',
            baseUrl,
            enabled: true,
            supportsStreaming: true,
            supportsTools: true,
            metadata: {
                remoteGateway: true,
                bootstrap: 'soul-gateway-provider',
            },
        });

    if (!existing) {
        await upsertProviderAccount(appCtx, provider);
        log.info('Soul Gateway provider created', {
            id: provider.id,
            baseUrl,
        });
    }

    await discoverProviderModels(appCtx, provider);
}
