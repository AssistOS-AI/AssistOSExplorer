import { normalizeProviderRecord } from './runtime-record-normalizer.mjs';
import { createBackendLifecycleContext } from '../backends/backend-context.mjs';
import {
    requireBackendModuleForProvider,
} from './provider-composition-validator.mjs';
import { performRuntimeRefresh } from '../registry/runtime-refresh.mjs';
import { enrichModelMetadata } from '../policy/model-metadata-classifier.mjs';

const MAX_DB_NUMERIC_14_8_ABS = 1_000_000;
const SYNC_DISABLED_METADATA_KEY = 'syncDisabled';
const OPERATOR_DISABLED_METADATA_KEYS = ['disabledBy'];

function hasSyncDisabledMarker(row) {
    return Boolean(row?.metadata?.[SYNC_DISABLED_METADATA_KEY]);
}

function clearSyncDisabledMarker(metadata = {}) {
    const next = { ...(metadata || {}) };
    delete next[SYNC_DISABLED_METADATA_KEY];
    return next;
}

function markSyncDisabledMetadata(metadata = {}, source) {
    return {
        ...(metadata || {}),
        [SYNC_DISABLED_METADATA_KEY]: {
            reason: 'missing-from-discovery',
            source,
            at: new Date().toISOString(),
        },
    };
}

function mergeOperatorDisabledMetadata(existingMetadata = {}, incomingMetadata = {}) {
    const existing = existingMetadata || {};
    const next = {
        ...existing,
        ...(incomingMetadata || {}),
    };
    for (const key of OPERATOR_DISABLED_METADATA_KEYS) {
        if (Object.prototype.hasOwnProperty.call(existing, key)) {
            next[key] = existing[key];
        }
    }
    return clearSyncDisabledMarker(next);
}

function mergeDiscoveryMetadata(existing, normalizedDiscovery) {
    const incoming = normalizedDiscovery.metadata || {};
    if (existing?.enabled === false && !hasSyncDisabledMarker(existing)) {
        return mergeOperatorDisabledMetadata(existing.metadata, incoming);
    }
    return clearSyncDisabledMarker(incoming);
}

function shouldEnableDiscoveredRow(existing) {
    if (existing?.enabled !== false) {
        return true;
    }
    return hasSyncDisabledMarker(existing);
}

function normalizeDbPricingNumber(value) {
    if (value === undefined || value === null || value === '') return null;
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return null;
    if (numeric < 0 || Math.abs(numeric) >= MAX_DB_NUMERIC_14_8_ABS) {
        return null;
    }
    return numeric;
}

function getDiscoveryPricing(discovery) {
    const pricing = discovery?.pricing || {};
    let pricingMode =
        discovery?.pricingMode ??
        pricing.mode ??
        'external_directory';
    let inputPricePerMillion = normalizeDbPricingNumber(
        discovery?.inputPricePerMillion ?? pricing.inputPricePerMillion
    );
    let outputPricePerMillion = normalizeDbPricingNumber(
        discovery?.outputPricePerMillion ?? pricing.outputPricePerMillion
    );
    let requestPriceUsd = normalizeDbPricingNumber(
        discovery?.requestPriceUsd ?? pricing.requestPriceUsd
    );

    if (
        pricingMode === 'token' &&
        (inputPricePerMillion === null || outputPricePerMillion === null)
    ) {
        pricingMode = 'external_directory';
        inputPricePerMillion = null;
        outputPricePerMillion = null;
    }
    if (pricingMode === 'request' && requestPriceUsd === null) {
        pricingMode = 'external_directory';
        requestPriceUsd = null;
    }

    return {
        pricingMode,
        inputPricePerMillion,
        outputPricePerMillion,
        requestPriceUsd,
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

async function getPricingDirectory(appCtx) {
    const directory = appCtx.services?.pricingDirectory || null;
    if (!directory) {
        return null;
    }
    try {
        await directory.refreshIfNeeded(appCtx.log);
        return directory;
    } catch (err) {
        appCtx.log.warn('openrouter metadata fallback unavailable', {
            url: directory.url || null,
            error: err.message,
        });
        return null;
    }
}

function envelopeFromDiscovery(discovery, provider) {
    const providerKey = provider?.providerKey || null;
    const providerModelId =
        discovery?.providerModelId ?? discovery?.modelId ?? discovery?.id ?? null;
    const pricing = discovery?.pricing || {};
    const modelKey =
        discovery?.modelKey ||
        (providerKey && providerModelId
            ? `${providerKey}/${providerModelId}`
            : null);

    // Mirror top-level capability shortcuts into the capabilities map so
    // the enrichment pipeline sees a single source of truth. Explicit
    // `false` values propagate (they carry provider knowledge) instead
    // of being treated as missing.
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
        discovery?.supportsVision != null &&
        capabilities.supportsVision == null
    ) {
        capabilities.supportsVision = discovery.supportsVision;
    }
    if (
        discovery?.supportsStreaming != null &&
        capabilities.supportsStreaming == null
    ) {
        capabilities.supportsStreaming = discovery.supportsStreaming;
    }

    return {
        providerKey,
        providerModelId,
        modelKey,
        displayName: discovery?.displayName || providerModelId || null,
        pricingMode: discovery?.pricingMode ?? pricing.mode ?? null,
        inputPricePerMillion:
            discovery?.inputPricePerMillion ??
            pricing.inputPricePerMillion ??
            null,
        outputPricePerMillion:
            discovery?.outputPricePerMillion ??
            pricing.outputPricePerMillion ??
            null,
        requestPriceUsd:
            discovery?.requestPriceUsd ?? pricing.requestPriceUsd ?? null,
        isFree: discovery?.isFree ?? null,
        contextWindow: capabilities.contextWindow ?? null,
        maxOutputTokens: capabilities.maxOutputTokens ?? null,
        supportsTools: capabilities.supportsTools ?? null,
        supportsVision: capabilities.supportsVision ?? null,
        supportsStreaming: capabilities.supportsStreaming ?? null,
        capabilities,
        tags: Array.isArray(discovery?.tags) ? [...discovery.tags] : [],
        metadata: discovery?.metadata || {},
    };
}

function envelopeToDiscovery(envelope, discovery) {
    const capabilities = { ...envelope.capabilities };
    if (envelope.contextWindow != null && capabilities.contextWindow == null) {
        capabilities.contextWindow = envelope.contextWindow;
    }
    if (
        envelope.maxOutputTokens != null &&
        capabilities.maxOutputTokens == null
    ) {
        capabilities.maxOutputTokens = envelope.maxOutputTokens;
    }
    if (
        envelope.supportsTools != null &&
        capabilities.supportsTools == null
    ) {
        capabilities.supportsTools = envelope.supportsTools;
    }
    if (
        envelope.supportsVision != null &&
        capabilities.supportsVision == null
    ) {
        capabilities.supportsVision = envelope.supportsVision;
    }
    if (
        envelope.supportsStreaming != null &&
        capabilities.supportsStreaming == null
    ) {
        capabilities.supportsStreaming = envelope.supportsStreaming;
    }

    const next = {
        ...discovery,
        pricingMode: envelope.pricingMode,
        inputPricePerMillion: envelope.inputPricePerMillion,
        outputPricePerMillion: envelope.outputPricePerMillion,
        requestPriceUsd: envelope.requestPriceUsd,
        isFree: envelope.isFree,
        contextWindow: envelope.contextWindow,
        maxOutputTokens: envelope.maxOutputTokens,
        supportsTools: envelope.supportsTools,
        supportsVision: envelope.supportsVision,
        supportsStreaming: envelope.supportsStreaming,
        capabilities,
        tags: [...envelope.tags],
        metadata: envelope.metadata,
    };
    if (
        envelope.pricingMode != null ||
        envelope.inputPricePerMillion != null ||
        envelope.outputPricePerMillion != null ||
        envelope.requestPriceUsd != null
    ) {
        next.pricing = {
            mode: envelope.pricingMode,
            inputPricePerMillion: envelope.inputPricePerMillion,
            outputPricePerMillion: envelope.outputPricePerMillion,
            requestPriceUsd: envelope.requestPriceUsd,
        };
    }
    return next;
}

function envelopeFromModelRow(row) {
    const capabilities = { ...(row?.capabilities || {}) };
    return {
        providerKey: row?.provider_key || null,
        providerModelId: row?.provider_model_id || null,
        modelKey: row?.model_key || null,
        displayName: row?.display_name || null,
        pricingMode: row?.pricing_mode ?? null,
        inputPricePerMillion: row?.input_price_per_million ?? null,
        outputPricePerMillion: row?.output_price_per_million ?? null,
        requestPriceUsd: row?.request_price_usd ?? null,
        isFree: row?.is_free ?? null,
        contextWindow: capabilities.contextWindow ?? null,
        maxOutputTokens: capabilities.maxOutputTokens ?? null,
        supportsTools: capabilities.supportsTools ?? null,
        supportsVision: capabilities.supportsVision ?? null,
        supportsStreaming: capabilities.supportsStreaming ?? null,
        capabilities,
        tags: Array.isArray(row?.tags) ? [...row.tags] : [],
        metadata: row?.metadata || {},
    };
}

function envelopeToModelRow(envelope, row) {
    return {
        ...row,
        pricing_mode: envelope.pricingMode,
        input_price_per_million: envelope.inputPricePerMillion,
        output_price_per_million: envelope.outputPricePerMillion,
        request_price_usd: envelope.requestPriceUsd,
        is_free:
            row?.is_free === true || envelope.isFree === true,
        capabilities: envelope.capabilities,
        tags: [...envelope.tags],
        metadata: envelope.metadata,
    };
}

export async function enrichDiscoveryDescriptors(appCtx, providerRecord, discoveries) {
    if (!Array.isArray(discoveries) || discoveries.length === 0) {
        return [];
    }

    const directory = await getPricingDirectory(appCtx);
    const provider = normalizeProviderRecord(providerRecord);

    return discoveries.map((discovery) => {
        const envelope = envelopeFromDiscovery(discovery, provider);
        const enriched = enrichModelMetadata(envelope, {
            pricingDirectory: directory,
        });
        return envelopeToDiscovery(enriched, discovery);
    });
}

export async function enrichStoredModelRows(appCtx, rows) {
    if (!Array.isArray(rows) || rows.length === 0) {
        return [];
    }

    const directory = await getPricingDirectory(appCtx);

    return rows.map((row) => {
        const envelope = envelopeFromModelRow(row);
        const enriched = enrichModelMetadata(envelope, {
            pricingDirectory: directory,
        });
        return envelopeToModelRow(enriched, row);
    });
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
    const enrichedDiscoveries = await enrichDiscoveryDescriptors(
        appCtx,
        normalizedProvider,
        discoveries
    );
    const uniqueDiscoveriesByModelKey = new Map();
    for (const discovery of enrichedDiscoveries) {
        const normalizedDiscovery = normalizeDiscoveryDescriptor(
            normalizedProvider,
            discovery
        );
        uniqueDiscoveriesByModelKey.set(
            normalizedDiscovery.modelKey,
            normalizedDiscovery
        );
    }
    const normalizedDiscoveries = [...uniqueDiscoveriesByModelKey.values()];
    const duplicateDiscoveriesDropped =
        enrichedDiscoveries.length - normalizedDiscoveries.length;
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
            enabled: shouldEnableDiscoveredRow(existing),
            metadata: mergeDiscoveryMetadata(existing, normalizedDiscovery),
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
            await modelsDao.update(appCtx.pool, existing.id, {
                enabled: false,
                metadata: markSyncDisabledMetadata(
                    existing.metadata || {},
                    refreshReason
                ),
            });
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
        duplicateDiscoveriesDropped,
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
