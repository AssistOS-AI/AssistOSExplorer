/**
 * Runtime refresh helpers.
 *
 * Centralizes snapshot/catalog reload orchestration so management routes
 * do not need to know which concrete reload hooks to call.
 */

export function installRuntimeRefreshServices(appCtx) {
    async function refreshRuntime(options = {}) {
        const {
            snapshot = false,
            middlewareCatalog = false,
            providerCatalog = false,
            reason = 'unspecified',
        } = options;

        const result = {
            reason,
            snapshotGeneration: appCtx.snapshotGeneration,
            middlewareGeneration: null,
            middlewareCount: null,
            providerCatalogGeneration: null,
            providerCount: null,
            extensionGeneration: null,
            transportCount: null,
            providerMiddlewareCount: null,
        };

        if (
            providerCatalog &&
            typeof appCtx.services.reloadProviderCatalog === 'function'
        ) {
            const providerResult =
                await appCtx.services.reloadProviderCatalog();
            result.providerCatalogGeneration =
                providerResult?.generation ?? null;
            result.providerCount = providerResult?.count ?? null;
            result.extensionGeneration =
                providerResult?.extensionGeneration ?? null;
            result.transportCount = providerResult?.transportCount ?? null;
            result.providerMiddlewareCount =
                providerResult?.providerMiddlewareCount ?? null;
        }

        if (
            middlewareCatalog &&
            typeof appCtx.services.reloadMiddlewareCatalog === 'function'
        ) {
            const middlewareResult =
                await appCtx.services.reloadMiddlewareCatalog();
            result.middlewareGeneration = middlewareResult?.generation ?? null;
            result.middlewareCount = middlewareResult?.count ?? null;
            result.extensionGeneration =
                middlewareResult?.extensionGeneration ??
                result.extensionGeneration;
        }

        if (
            snapshot &&
            typeof appCtx.services.reloadRuntimeSnapshot === 'function'
        ) {
            const snapshotResult =
                await appCtx.services.reloadRuntimeSnapshot();
            result.snapshotGeneration =
                snapshotResult?.generation ?? appCtx.snapshotGeneration;
        }

        return result;
    }

    function refreshRuntimeAsync(options = {}) {
        return refreshRuntime(options).catch((err) => {
            appCtx.log.warn('runtime refresh failed', {
                reason: options.reason || 'unspecified',
                error: err.message,
            });
            return null;
        });
    }

    appCtx.services.refreshRuntime = refreshRuntime;
    appCtx.services.refreshRuntimeAsync = refreshRuntimeAsync;
}

export async function performRuntimeRefresh(appCtx, options = {}) {
    if (typeof appCtx.services?.refreshRuntime === 'function') {
        return appCtx.services.refreshRuntime(options);
    }
    return {
        reason: options.reason || 'unspecified',
        snapshotGeneration: appCtx.snapshotGeneration,
        middlewareGeneration: null,
        middlewareCount: null,
        providerCatalogGeneration: null,
        providerCount: null,
        extensionGeneration: null,
        transportCount: null,
        providerMiddlewareCount: null,
    };
}

export function requestRuntimeRefresh(appCtx, options = {}) {
    if (typeof appCtx.services?.refreshRuntimeAsync === 'function') {
        return appCtx.services.refreshRuntimeAsync(options);
    }
    return Promise.resolve(null);
}
