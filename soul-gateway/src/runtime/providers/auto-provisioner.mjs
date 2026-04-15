import { normalizeProviderRecord } from './runtime-record-normalizer.mjs';
import { createBackendLifecycleContext } from '../backends/backend-context.mjs';
import {
    requireBackendModuleForProvider,
} from './provider-composition-validator.mjs';
import { performRuntimeRefresh } from '../registry/runtime-refresh.mjs';

function getDiscoveryPricing(discovery) {
    const pricing = discovery?.pricing || {};
    return {
        pricingMode:
            discovery?.pricingMode ??
            pricing.mode ??
            'external_directory',
        inputPricePerMillion:
            discovery?.inputPricePerMillion ??
            pricing.inputPricePerMillion ??
            null,
        outputPricePerMillion:
            discovery?.outputPricePerMillion ??
            pricing.outputPricePerMillion ??
            null,
        requestPriceUsd:
            discovery?.requestPriceUsd ??
            pricing.requestPriceUsd ??
            null,
    };
}

function buildDiscoveryCapabilities(discovery) {
    const capabilities = { ...(discovery?.capabilities || {}) };
    if (
        discovery?.contextWindow != null &&
        capabilities.contextWindow == null
    ) {
        capabilities.contextWindow = discovery.contextWindow;
    }
    if (
        discovery?.maxOutputTokens != null &&
        capabilities.maxOutputTokens == null
    ) {
        capabilities.maxOutputTokens = discovery.maxOutputTokens;
    }
    if (
        discovery?.supportsTools != null &&
        capabilities.supportsTools == null
    ) {
        capabilities.supportsTools = discovery.supportsTools;
    }
    if (
        discovery?.supportsStreaming != null &&
        capabilities.supportsStreaming == null
    ) {
        capabilities.supportsStreaming = discovery.supportsStreaming;
    }
    if (
        discovery?.supportsVision != null &&
        capabilities.supportsVision == null
    ) {
        capabilities.supportsVision = discovery.supportsVision;
    }
    return capabilities;
}

export function normalizeDiscoveryDescriptor(providerRecord, discovery) {
    const provider = normalizeProviderRecord(providerRecord);
    const providerModelId =
        discovery?.providerModelId ?? discovery?.modelId ?? discovery?.id ?? null;
    if (!providerModelId) {
        throw new Error(
            `Provider discovery for '${provider?.providerKey || 'unknown'}' returned an entry without modelId`
        );
    }

    const { pricingMode, inputPricePerMillion, outputPricePerMillion, requestPriceUsd } =
        getDiscoveryPricing(discovery);

    return {
        modelKey:
            discovery?.modelKey ||
            `${provider.providerKey}/${providerModelId}`,
        displayName: discovery?.displayName || providerModelId,
        providerId: provider.id,
        providerModelId,
        executionKind: discovery?.executionKind ?? 'provider_model',
        pricingMode,
        inputPricePerMillion,
        outputPricePerMillion,
        requestPriceUsd,
        isFree: discovery?.isFree ?? false,
        capabilities: buildDiscoveryCapabilities(discovery),
        tags: discovery?.tags ?? [],
        metadata: discovery?.metadata ?? {},
    };
}

export async function discoverProviderModels(
    appCtx,
    provider,
    { oauthAdapterKey = null } = {}
) {
    const log = appCtx.log;
    const normalizedProvider = normalizeProviderRecord(provider);
    const providerKey = normalizedProvider?.providerKey;
    const { backendModule } = requireBackendModuleForProvider(
        normalizedProvider,
        appCtx.services?.backendCatalog || null
    );
    const backendKey = normalizedProvider.backendKey || oauthAdapterKey;

    if (typeof backendModule.discoverModels !== 'function') {
        throw new Error(
            `Provider backend '${backendKey}' does not support model discovery`
        );
    }

    const credentialManager = appCtx.services?.credentialManager || null;
    let credentialLease = null;
    if (credentialManager) {
        credentialLease = await credentialManager.getCredentials(provider.id);
    }

    try {
        const lifecycleCtx = createBackendLifecycleContext({
            providerRecord: normalizedProvider,
            credentialLease,
            logger: log,
        });
        const result = await backendModule.discoverModels(lifecycleCtx);
        if (!Array.isArray(result)) {
            throw new Error(
                `Provider backend '${backendKey}' returned a non-array discovery result`
            );
        }
        return result;
    } finally {
        if (credentialLease && credentialManager) {
            credentialManager.release(credentialLease);
        }
    }
}

export async function syncProviderModels(
    appCtx,
    provider,
    discoveries,
    {
        discoverySource = 'synced',
        disableMissing = true,
        refreshReason = 'provider.sync-models',
    } = {}
) {
    const normalizedProvider = normalizeProviderRecord(provider);
    const normalizedDiscoveries = discoveries.map((discovery) =>
        normalizeDiscoveryDescriptor(normalizedProvider, discovery)
    );
    const modelsDao = await import('../../db/dao/models-dao.mjs');
    const existingRows = await modelsDao.listByProvider(
        appCtx.pool,
        normalizedProvider.id
    );
    const existingByModelKey = new Map(
        existingRows.map((row) => [row.model_key, row])
    );
    const discoveredModelKeys = new Set();
    const syncedModels = [];
    let created = 0;
    let updated = 0;
    let disabled = 0;

    for (const normalizedDiscovery of normalizedDiscoveries) {
        discoveredModelKeys.add(normalizedDiscovery.modelKey);
        const existing = existingByModelKey.get(normalizedDiscovery.modelKey) || null;

        if (!existing) {
            const createdRow = await modelsDao.create(appCtx.pool, {
                ...normalizedDiscovery,
                enabled: true,
                discoverySource,
            });
            syncedModels.push(createdRow);
            created++;
            continue;
        }

        if (existing.discovery_source === 'manual') {
            syncedModels.push(existing);
            continue;
        }

        const updatedRow = await modelsDao.update(appCtx.pool, existing.id, {
            displayName: normalizedDiscovery.displayName,
            providerModelId: normalizedDiscovery.providerModelId,
            executionKind: normalizedDiscovery.executionKind,
            pricingMode: normalizedDiscovery.pricingMode,
            inputPricePerMillion: normalizedDiscovery.inputPricePerMillion,
            outputPricePerMillion: normalizedDiscovery.outputPricePerMillion,
            requestPriceUsd: normalizedDiscovery.requestPriceUsd,
            isFree: normalizedDiscovery.isFree,
            capabilities: normalizedDiscovery.capabilities,
            tags: normalizedDiscovery.tags,
            metadata: normalizedDiscovery.metadata,
            discoverySource,
        });
        syncedModels.push(updatedRow || existing);
        updated++;
    }

    if (disableMissing) {
        for (const existing of existingRows) {
            if (existing.discovery_source === 'manual') {
                continue;
            }
            if (discoveredModelKeys.has(existing.model_key)) {
                continue;
            }
            if (existing.enabled === false) {
                continue;
            }
            await modelsDao.disable(appCtx.pool, existing.id);
            disabled++;
        }
    }

    if (created > 0 || updated > 0 || disabled > 0) {
        await performRuntimeRefresh(appCtx, {
            snapshot: true,
            reason: refreshReason,
        });
    }

    appCtx.log.info('provider models synced', {
        provider: normalizedProvider.providerKey,
        discoverySource,
        discovered: normalizedDiscoveries.length,
        created,
        updated,
        disabled,
    });

    return {
        discovered: normalizedDiscoveries.length,
        created,
        updated,
        disabled,
        models: syncedModels,
    };
}

/**
 * Discover and sync models for one provider.
 *
 * The "auto-provision" entry point is used by provider creation and
 * post-OAuth completion. It is intentionally the same code path as
 * manual sync so model-registry semantics stay consistent.
 */
export async function autoProvisionModels(
    appCtx,
    provider,
    oauthAdapterKey = null,
    {
        strict = false,
        discoverySource = 'auto_provisioned',
        disableMissing = true,
        refreshReason = 'auto-provision',
    } = {}
) {
    try {
        const discoveries = await discoverProviderModels(appCtx, provider, {
            oauthAdapterKey,
        });
        return await syncProviderModels(appCtx, provider, discoveries, {
            discoverySource,
            disableMissing,
            refreshReason,
        });
    } catch (err) {
        if (strict) {
            throw err;
        }
        appCtx.log.warn('auto-provision discovery failed', {
            provider: normalizeProviderRecord(provider)?.providerKey || null,
            backendKey: normalizeProviderRecord(provider)?.backendKey || null,
            oauthAdapterKey,
            error: err.message,
        });
        return {
            discovered: 0,
            created: 0,
            updated: 0,
            disabled: 0,
            models: [],
        };
    }
}
