import { normalizeProviderRecord } from './runtime-record-normalizer.mjs';
import { requireBackendModuleForProvider } from './provider-composition-validator.mjs';

export const PROVIDER_MODEL_REFRESH_REASON = 'provider.model-refresh';
const PROVIDER_PAGE_SIZE = 200;
const DEFAULT_DISCOVERY_TIMEOUT_MS = 10_000;

function accountHasUsableStoredCredential(account) {
    if (!account) return false;
    if (account.status !== 'active' && account.status !== 'refreshing') {
        return false;
    }
    return Boolean(
        account.secret_ciphertext ||
            account.secretCiphertext ||
            account.credentials_path ||
            account.credentialsPath ||
            account.metadata?.access_token ||
            account.metadata?.accessToken
    );
}

async function listEnabledProviders(pool, providersDao) {
    const providers = [];
    let offset = 0;
    while (true) {
        const page = await providersDao.list(pool, {
            enabled: true,
            limit: PROVIDER_PAGE_SIZE,
            offset,
        });
        providers.push(...page);
        if (page.length < PROVIDER_PAGE_SIZE) {
            return providers;
        }
        offset += PROVIDER_PAGE_SIZE;
    }
}

function providerUsesNoAuth(provider) {
    return (
        provider?.auth_strategy === 'none' ||
        provider?.authStrategy === 'none'
    );
}

function providerSupportsDiscovery(appCtx, provider) {
    try {
        const { backendModule } = requireBackendModuleForProvider(
            provider,
            appCtx.services?.backendCatalog || null
        );
        return typeof backendModule.discoverModels === 'function';
    } catch (err) {
        appCtx.log?.warn?.('provider model refresh skipped invalid provider', {
            provider: provider?.provider_key || provider?.providerKey || null,
            error: err.message,
        });
        return false;
    }
}

async function providerHasUsableCredential(pool, accountsDao, provider) {
    if (providerUsesNoAuth(provider)) {
        return true;
    }
    const accounts = await accountsDao.listByProvider(pool, provider.id);
    return accounts.some(accountHasUsableStoredCredential);
}

function createSummary(scanned = 0) {
    return {
        scanned,
        eligible: 0,
        refreshed: 0,
        discovered: 0,
        created: 0,
        updated: 0,
        disabled: 0,
        skipped: 0,
        emptySkipped: 0,
        failed: 0,
    };
}

function createDiscoveryTimeout(timeoutMs, providerKey) {
    return new Error(
        `Provider model discovery for '${providerKey}' timed out after ${timeoutMs}ms`
    );
}

async function withDiscoveryTimeout(discover, { timeoutMs, providerKey }) {
    const normalizedTimeoutMs = Number(timeoutMs);
    if (!Number.isFinite(normalizedTimeoutMs) || normalizedTimeoutMs <= 0) {
        return discover();
    }

    let timeoutId = null;
    try {
        return await Promise.race([
            discover(),
            new Promise((_, reject) => {
                timeoutId = setTimeout(() => {
                    reject(
                        createDiscoveryTimeout(
                            normalizedTimeoutMs,
                            providerKey
                        )
                    );
                }, normalizedTimeoutMs);
                timeoutId.unref?.();
            }),
        ]);
    } finally {
        if (timeoutId) clearTimeout(timeoutId);
    }
}

export async function refreshProviderModelCatalog(appCtx, options = {}) {
    const {
        phase = 'manual',
        discoverySource = 'synced',
        disableMissing = true,
        refreshReason = PROVIDER_MODEL_REFRESH_REASON,
        skipEmptyExistingCatalog = true,
        discoveryTimeoutMs = DEFAULT_DISCOVERY_TIMEOUT_MS,
    } = options;

    if (!appCtx.pool || !appCtx.services?.backendCatalog) {
        return createSummary(0);
    }

    const providersDao = await import('../../db/dao/providers-dao.mjs');
    const accountsDao = await import('../../db/dao/provider-accounts-dao.mjs');
    const modelsDao = await import('../../db/dao/models-dao.mjs');
    const {
        discoverProviderModels,
        syncProviderModels,
    } = await import('./auto-provisioner.mjs');

    const providers = await listEnabledProviders(appCtx.pool, providersDao);
    const summary = createSummary(providers.length);

    for (const provider of providers) {
        const normalizedProvider = normalizeProviderRecord(provider);
        if (!providerSupportsDiscovery(appCtx, provider)) {
            summary.skipped++;
            continue;
        }

        try {
            const hasCredential = await providerHasUsableCredential(
                appCtx.pool,
                accountsDao,
                provider
            );
            if (!hasCredential) {
                summary.skipped++;
                appCtx.log?.debug?.(
                    'provider model refresh skipped provider without usable credential',
                    {
                        phase,
                        provider: normalizedProvider.providerKey,
                        reason: 'missing_usable_credential',
                    }
                );
                continue;
            }

            summary.eligible++;

            const [existingRows, discoveries] = await Promise.all([
                modelsDao.listByProvider(appCtx.pool, provider.id),
                withDiscoveryTimeout(
                    () =>
                        discoverProviderModels(appCtx, provider, {
                            discoveryTimeoutMs,
                        }),
                    {
                        timeoutMs: discoveryTimeoutMs,
                        providerKey: normalizedProvider.providerKey,
                    }
                ),
            ]);
            const existingDiscoveredRows = existingRows.filter(
                (row) => row.discovery_source !== 'manual'
            );

            if (
                skipEmptyExistingCatalog &&
                Array.isArray(discoveries) &&
                discoveries.length === 0 &&
                existingDiscoveredRows.length > 0
            ) {
                summary.emptySkipped++;
                appCtx.log?.warn?.('provider model refresh returned empty catalog', {
                    phase,
                    provider: normalizedProvider.providerKey,
                    existingModels: existingDiscoveredRows.length,
                });
                continue;
            }

            const result = await syncProviderModels(
                appCtx,
                provider,
                discoveries,
                {
                    discoverySource,
                    disableMissing,
                    refreshReason,
                }
            );
            summary.refreshed++;
            summary.discovered += result.discovered;
            summary.created += result.created;
            summary.updated += result.updated;
            summary.disabled += result.disabled;
        } catch (err) {
            summary.failed++;
            appCtx.log?.warn?.('provider model refresh failed', {
                phase,
                provider: normalizedProvider.providerKey,
                error: err.message,
            });
        }
    }

    appCtx.log?.info?.('provider model refresh complete', {
        phase,
        ...summary,
    });
    return summary;
}

export default {
    PROVIDER_MODEL_REFRESH_REASON,
    refreshProviderModelCatalog,
};
