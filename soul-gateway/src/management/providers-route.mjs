/**
 * Management provider routes.
 *
 * GET    /management/providers/templates
 * GET    /management/providers
 * POST   /management/providers
 * GET    /management/providers/:providerId
 * PATCH  /management/providers/:providerId
 * DELETE /management/providers/:providerId
 * POST   /management/providers/:providerId/test
 * POST   /management/providers/:providerId/discover-models
 * POST   /management/providers/:providerId/sync-models
 * POST   /management/providers/:providerId/auth/start
 * GET    /management/providers/:providerId/auth/callback
 * GET    /management/providers/:providerId/auth/pending/:flowId
 * GET    /management/providers/:providerId/accounts
 * DELETE /management/providers/:providerId/accounts/:accountId
 * POST   /management/providers/:providerId/accounts/:accountId/reset-quota
 * POST   /management/providers/rescan
 */

import { readJsonBody } from '../core/json-body.mjs';
import { sendJson } from '../core/responses.mjs';
import { BadRequestError } from '../core/errors.mjs';
import {
    ERROR_MESSAGES,
    ERROR_TYPES,
    HTTP_STATUS,
} from '../core/constants.mjs';
import * as providersDao from '../db/dao/providers-dao.mjs';
import * as accountsDao from '../db/dao/provider-accounts-dao.mjs';
import * as modelsDao from '../db/dao/models-dao.mjs';
import {
    performRuntimeRefresh,
} from '../runtime/registry/runtime-refresh.mjs';
import {
    badRequestFactory,
    requireBackendModuleForProvider,
} from '../runtime/providers/provider-composition-validator.mjs';
import {
    buildProviderLifecycleOptions,
    loadProviderOrRespond,
    upsertProviderApiKeyAccount,
} from './provider-route-helpers.mjs';
import {
    sendConflict,
    sendNotFound,
    sendOperationError,
} from './route-response-helpers.mjs';
import { toAccountView, buildAccountsPayload } from './account-view.mjs';
import { toProviderView, toProviderList } from './provider-view.mjs';

function validateProviderBackendReference(appCtx, providerRecord) {
    requireBackendModuleForProvider(
        providerRecord,
        appCtx.services?.backendCatalog || null,
        { errorFactory: badRequestFactory }
    );
}

/**
 * GET /management/providers/templates
 * List built-in provider templates and supported auth flows.
 */
export async function handleListTemplates(ctx) {
    const { res, appCtx } = ctx;

    if (appCtx.services.backendCatalog) {
        const templates = appCtx.services.backendCatalog.getTemplates();
        sendJson(res, 200, { data: templates });
        return;
    }
    sendJson(res, 200, { data: [] });
}

/**
 * GET /management/providers
 */
export async function handleListProviders(ctx) {
    const { res, query, appCtx } = ctx;
    const { pool } = appCtx;

    const enabled =
        query.enabled !== undefined ? query.enabled === 'true' : null;
    const kind = query.kind || null;
    const limit = Math.min(parseInt(query.limit, 10) || 200, 500);
    const offset = parseInt(query.offset, 10) || 0;

    const rows = await providersDao.list(pool, {
        enabled,
        kind,
        limit,
        offset,
    });
    sendJson(res, 200, { data: toProviderList(rows) });
}

/**
 * POST /management/providers
 */
export async function handleCreateProvider(ctx) {
    const { req, res, appCtx } = ctx;
    const { pool } = appCtx;
    const body = await readJsonBody(req);

    const providerKey = body?.providerKey ?? null;
    const displayName = body?.displayName ?? null;
    const authStrategy = body?.authStrategy ?? null;
    const oauthAdapterKey = body?.oauthAdapterKey ?? null;
    const providerMode = body?.providerMode ?? 'external_api';
    const adapterKey =
        body?.adapterKey ?? (providerMode === 'custom' ? providerKey : null);
    const kind = body?.kind || (providerMode === 'custom' ? 'custom' : 'external_api');

    if (
        !body ||
        !providerKey ||
        !displayName ||
        !adapterKey ||
        !authStrategy
    ) {
        throw new BadRequestError(
            'Missing required fields: providerKey, displayName, adapterKey, authStrategy'
        );
    }

    validateProviderBackendReference(appCtx, {
        providerKey,
        displayName,
        authStrategy,
        providerMode,
        oauthAdapterKey,
        adapterKey,
        baseUrl: body.baseUrl ?? null,
        settings: body.settings ?? {},
        metadata: body.metadata ?? {},
    });

    const row = await providersDao.create(pool, {
        providerKey,
        displayName,
        kind,
        adapterKey,
        authStrategy,
        providerMode,
        oauthAdapterKey,
        baseUrl: body.baseUrl ?? null,
        enabled: body.enabled ?? true,
        settings: body.settings ?? {},
        metadata: body.metadata ?? {},
    });

    // If an API key was provided, create an account for it
    const apiKey = body.apiKey ?? null;
    await upsertProviderApiKeyAccount({
        appCtx,
        providerId: row.id,
        providerDisplayName: row.display_name,
        apiKey,
    });

    // Refresh runtime snapshot so the credential manager can lease
    // the just-created account on the auto-provision call below.
    await performRuntimeRefresh(appCtx, {
        snapshot: true,
        reason: 'provider.create',
    });

    // Auto-provision models from the provider's /models endpoint when
    // we already have a usable credential. For OAuth providers we skip
    // this and defer to the post-OAuth path in oauth-manager — no
    // credentials exist yet at create time.
    if (apiKey) {
        try {
            const { autoProvisionModels } = await import(
                '../runtime/providers/auto-provisioner.mjs'
            );
            await autoProvisionModels(appCtx, row, null, {
                strict: true,
                discoverySource: 'auto_provisioned',
                disableMissing: true,
                refreshReason: 'provider.create.auto-provision',
            });
        } catch (err) {
            await modelsDao.delByProvider(pool, row.id);
            await providersDao.del(pool, row.id);
            await performRuntimeRefresh(appCtx, {
                snapshot: true,
                reason: 'provider.create.rollback',
            });
            throw new BadRequestError(
                `Provider initial model sync failed: ${err.message}`
            );
        }
    }

    sendJson(res, 201, { provider: toProviderView(row) });
}

/**
 * GET /management/providers/:providerId
 */
export async function handleGetProvider(ctx) {
    const { res, params, appCtx } = ctx;
    const { pool } = appCtx;

    const provider = await loadProviderOrRespond(ctx, params.providerId);
    if (!provider) return;

    const rows = await accountsDao.listByProvider(pool, params.providerId);
    const accounts = rows.map(toAccountView).filter(Boolean);

    sendJson(res, 200, { provider: toProviderView(provider), accounts });
}

/**
 * PATCH /management/providers/:providerId
 */
export async function handleUpdateProvider(ctx) {
    const { req, res, params, appCtx } = ctx;
    const { pool } = appCtx;
    const body = await readJsonBody(req);

    if (!body || Object.keys(body).length === 0) {
        throw new BadRequestError('Empty update body');
    }

    // Load the provider first so a 404 reflects an actually-missing row.
    // Doing this up front also lets us answer api-key-only PATCHes
    // without ever hitting the providers DAO update path — that path
    // returns null on an empty fields object, which the previous
    // implementation (incorrectly) mapped to "Provider not found".
    const existing = await loadProviderOrRespond(ctx, params.providerId);
    if (!existing) return;

    const allowed = [
        'displayName',
        'adapterKey',
        'authStrategy',
        'providerMode',
        'oauthAdapterKey',
        'baseUrl',
        'enabled',
        'supportsStreaming',
        'supportsTools',
        'supportsMessagesApi',
        'supportsResponsesApi',
        'settings',
        'metadata',
    ];

    const fields = {};
    for (const k of allowed) {
        if (body[k] !== undefined) {
            fields[k] = body[k];
        }
    }

    if (fields.providerMode !== undefined) {
        fields.kind = fields.providerMode === 'custom'
            ? 'custom'
            : (existing.kind === 'search' ? 'search' : 'external_api');
    }

    const apiKey = body.apiKey ?? null;
    if (Object.keys(fields).length === 0 && apiKey === null) {
        throw new BadRequestError(
            'No supported update fields provided. Use canonical fields such as displayName, adapterKey, authStrategy, providerMode, oauthAdapterKey, baseUrl, enabled, settings, metadata, or apiKey.'
        );
    }

    if (Object.keys(fields).length > 0) {
        validateProviderBackendReference(appCtx, {
            ...existing,
            ...fields,
        });
    }

    // Only run the providers DAO update when the PATCH actually carries
    // a column change. A PATCH that only rotates `api_key` is valid —
    // the upsert below handles credential rotation without touching the
    // providers row.
    let row = existing;
    if (Object.keys(fields).length > 0) {
        const updated = await providersDao.update(
            pool,
            params.providerId,
            fields
        );
        if (!updated) {
            // Race: another caller deleted the provider between the load
            // above and this update. Surface the same 404 the dashboard
            // expects so the UI can refresh its list.
            sendNotFound(res, 'Provider');
            return;
        }
        row = updated;
    }

    // If an API key was provided, upsert an account for it
    await upsertProviderApiKeyAccount({
        appCtx,
        providerId: params.providerId,
        providerDisplayName: row.display_name,
        apiKey,
    });

    // Refresh runtime snapshot after mutation
    await performRuntimeRefresh(appCtx, {
        snapshot: true,
        reason: 'provider.update',
    });

    if (apiKey) {
        try {
            const { autoProvisionModels } = await import(
                '../runtime/providers/auto-provisioner.mjs'
            );
            await autoProvisionModels(appCtx, row, null, {
                strict: true,
                discoverySource: 'auto_provisioned',
                disableMissing: true,
                refreshReason: 'provider.update.auto-provision',
            });
        } catch (err) {
            throw new BadRequestError(
                `Provider model sync failed after credential update: ${err.message}`
            );
        }
    }

    sendJson(res, 200, { provider: toProviderView(row) });
}

/**
 * DELETE /management/providers/:providerId
 */
export async function handleDeleteProvider(ctx) {
    const { res, params, appCtx } = ctx;
    const { pool } = appCtx;

    const models = await modelsDao.listByProvider(pool, params.providerId);
    const manualModels = models.filter(
        (model) => model.discovery_source === 'manual'
    );
    if (manualModels.length > 0) {
        sendConflict(
            res,
            `Cannot delete provider: ${manualModels.length} manual model(s) depend on it`,
            {
                modelCount: models.length,
                manualModelCount: manualModels.length,
                providerSeededModelCount: models.length - manualModels.length,
            }
        );
        return;
    }

    if (models.length > 0) {
        await modelsDao.delByProvider(pool, params.providerId);
    }

    const ok = await providersDao.del(pool, params.providerId);
    if (!ok) {
        sendNotFound(res, 'Provider');
        return;
    }

    // Refresh runtime snapshot after mutation
    await performRuntimeRefresh(appCtx, {
        snapshot: true,
        reason: 'provider.delete',
    });

    sendJson(res, 200, { ok: true, deletedModels: models.length });
}

/**
 * POST /management/providers/:providerId/test
 * Test connectivity and authentication.
 */
export async function handleTestConnection(ctx) {
    const { res, params, appCtx } = ctx;

    const provider = await loadProviderOrRespond(ctx, params.providerId);
    if (!provider) return;

    if (!appCtx.services.backendCatalog) {
        sendJson(res, HTTP_STATUS.OK, {
            ok: false,
            detail: ERROR_MESSAGES.BACKEND_CATALOG_NOT_INITIALIZED,
            latencyMs: 0,
        });
        return;
    }

    const start = Date.now();
    let result;
    try {
        result = await appCtx.services.backendCatalog.testConnection(
            provider,
            buildProviderLifecycleOptions(appCtx)
        );
    } catch (err) {
        sendJson(res, 200, {
            ok: false,
            detail: err.message || 'Test failed',
            latencyMs: Date.now() - start,
        });
        return;
    }

    sendJson(res, 200, {
        ...result,
        detail: result?.detail ?? null,
        latencyMs: Date.now() - start,
    });
}

/**
 * POST /management/providers/:providerId/discover-models
 */
export async function handleDiscoverModels(ctx) {
    const { res, params, appCtx } = ctx;

    const provider = await loadProviderOrRespond(ctx, params.providerId);
    if (!provider) return;

    if (!appCtx.services.backendCatalog) {
        sendJson(res, 200, { data: [] });
        return;
    }

    try {
        const { discoverProviderModels } = await import(
            '../runtime/providers/auto-provisioner.mjs'
        );
        const discoveries = await discoverProviderModels(appCtx, provider);
        sendJson(res, 200, {
            data: Array.isArray(discoveries) ? discoveries : [],
        });
    } catch (err) {
        sendOperationError(res, {
            status: HTTP_STATUS.INTERNAL_SERVER_ERROR,
            message: err.message,
            type: ERROR_TYPES.DISCOVERY_ERROR,
        });
    }
}

/**
 * POST /management/providers/:providerId/sync-models
 * Upsert discovered models into the registry.
 */
export async function handleSyncModels(ctx) {
    const { req, res, params, appCtx } = ctx;
    const body = await readJsonBody(req);

    const provider = await loadProviderOrRespond(ctx, params.providerId);
    if (!provider) return;

    try {
        const {
            autoProvisionModels,
            syncProviderModels,
        } = await import('../runtime/providers/auto-provisioner.mjs');

        const result = Array.isArray(body?.discoveries)
            ? await syncProviderModels(appCtx, provider, body.discoveries, {
                  discoverySource: 'synced',
                  disableMissing: true,
                  refreshReason: 'provider.sync-models',
              })
            : await autoProvisionModels(appCtx, provider, null, {
                  strict: true,
                  discoverySource: 'synced',
                  disableMissing: true,
                  refreshReason: 'provider.sync-models',
              });

        sendJson(res, 200, {
            synced: result.created + result.updated,
            discovered: result.discovered,
            created: result.created,
            updated: result.updated,
            disabled: result.disabled,
            models: result.models,
        });
    } catch (err) {
        sendOperationError(res, {
            status: HTTP_STATUS.INTERNAL_SERVER_ERROR,
            message: err.message,
            type: ERROR_TYPES.DISCOVERY_ERROR,
        });
    }
}

/**
 * POST /management/providers/:providerId/auth/start
 * Start OAuth or device flow.
 */
export async function handleAuthStart(ctx) {
    const { req, res, params, appCtx } = ctx;
    const body = await readJsonBody(req);

    if (!appCtx.services.oauthManager) {
        sendOperationError(res, {
            status: HTTP_STATUS.NOT_IMPLEMENTED,
            message: 'OAuth manager not initialized',
            type: ERROR_TYPES.NOT_IMPLEMENTED,
        });
        return;
    }

    const provider = await loadProviderOrRespond(ctx, params.providerId);
    if (!provider) return;

    try {
        const result = await appCtx.services.oauthManager.startFlow(provider, {
            label: body?.label,
        });
        sendJson(res, 200, result);
    } catch (err) {
        sendOperationError(res, {
            status: HTTP_STATUS.INTERNAL_SERVER_ERROR,
            message: err.message,
            type: ERROR_TYPES.OAUTH_ERROR,
        });
    }
}

/**
 * GET /management/providers/:providerId/auth/callback
 * OAuth redirect target.
 */
export async function handleAuthCallback(ctx) {
    const { res, params, query, appCtx } = ctx;

    if (!appCtx.services.oauthManager) {
        sendOperationError(res, {
            status: HTTP_STATUS.NOT_IMPLEMENTED,
            message: 'OAuth manager not initialized',
            type: ERROR_TYPES.NOT_IMPLEMENTED,
        });
        return;
    }

    try {
        const result = await appCtx.services.oauthManager.handleCallback(
            params.providerId,
            query
        );
        // Return a simple HTML close page or JSON
        if (query.html) {
            res.writeHead(200, { 'Content-Type': 'text/html' });
            res.end(
                '<html><body><script>window.close();</script><p>Authentication complete. You can close this window.</p></body></html>'
            );
        } else {
            sendJson(res, 200, { status: 'complete', account: result });
        }
    } catch (err) {
        sendOperationError(res, {
            status: HTTP_STATUS.INTERNAL_SERVER_ERROR,
            message: err.message,
            type: ERROR_TYPES.OAUTH_CALLBACK_ERROR,
        });
    }
}

/**
 * GET /management/providers/:providerId/auth/pending/:flowId
 * Poll pending device flow.
 */
export async function handleAuthPending(ctx) {
    const { res, params, appCtx } = ctx;

    if (!appCtx.services.oauthManager) {
        sendOperationError(res, {
            status: HTTP_STATUS.NOT_IMPLEMENTED,
            message: 'OAuth manager not initialized',
            type: ERROR_TYPES.NOT_IMPLEMENTED,
        });
        return;
    }

    try {
        const result = await appCtx.services.oauthManager.pollPending(
            params.providerId,
            params.flowId
        );
        sendJson(res, 200, result);
    } catch (err) {
        sendOperationError(res, {
            status: HTTP_STATUS.INTERNAL_SERVER_ERROR,
            message: err.message,
            type: ERROR_TYPES.OAUTH_POLL_ERROR,
        });
    }
}

/**
 * GET /management/providers/:providerId/accounts
 */
export async function handleListAccounts(ctx) {
    const { res, params, appCtx } = ctx;
    const { pool } = appCtx;

    const rows = await accountsDao.listByProvider(pool, params.providerId);
    sendJson(res, 200, buildAccountsPayload(rows));
}

/**
 * DELETE /management/providers/:providerId/accounts/:accountId
 */
export async function handleDeleteAccount(ctx) {
    const { res, params, appCtx } = ctx;
    const { pool } = appCtx;

    const account = await accountsDao.findById(pool, params.accountId);
    if (!account) {
        sendNotFound(res, 'Account');
        return;
    }
    if (String(account.provider_id) !== String(params.providerId)) {
        throw new BadRequestError('Account does not belong to this provider');
    }

    await accountsDao.del(pool, params.accountId);
    sendJson(res, 200, { ok: true });
}

/**
 * POST /management/providers/:providerId/accounts/:accountId/reset-quota
 */
export async function handleResetAccountQuota(ctx) {
    const { res, params, appCtx } = ctx;
    const { pool } = appCtx;

    const account = await accountsDao.findById(pool, params.accountId);
    if (!account) {
        sendNotFound(res, 'Account');
        return;
    }
    if (String(account.provider_id) !== String(params.providerId)) {
        throw new BadRequestError('Account does not belong to this provider');
    }

    const row = await accountsDao.updateStatus(
        pool,
        params.accountId,
        'active'
    );
    sendJson(res, 200, { account: row });
}

/**
 * POST /management/providers/rescan
 * Rescan extension directories.
 */
export async function handleRescan(ctx) {
    const { res, appCtx } = ctx;

    const refresh = await performRuntimeRefresh(appCtx, {
        backendCatalog: true,
        snapshot: true,
        reason: 'provider.rescan',
    });

    sendJson(res, 200, {
        ok: true,
        snapshotGeneration: refresh.snapshotGeneration,
        backendCatalogGeneration: refresh.backendCatalogGeneration,
        backendCount: refresh.backendCount,
        extensionGeneration: refresh.extensionGeneration ?? null,
    });
}
