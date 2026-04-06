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
import { ERROR_MESSAGES, ERROR_TYPES, HTTP_STATUS } from '../core/constants.mjs';
import * as providersDao from '../db/dao/providers-dao.mjs';
import * as accountsDao from '../db/dao/provider-accounts-dao.mjs';
import * as modelsDao from '../db/dao/models-dao.mjs';
import { performRuntimeRefresh, requestRuntimeRefresh } from '../runtime/registry/runtime-refresh.mjs';
import {
  buildProviderLifecycleOptions,
  loadProviderOrRespond,
  upsertProviderApiKeyAccount,
} from './provider-route-helpers.mjs';
import { sendConflict, sendNotFound, sendOperationError } from './route-response-helpers.mjs';
import { toAccountView, buildAccountsPayload } from './account-view.mjs';
import { toProviderView, toProviderList } from './provider-view.mjs';
import { toDiscoveryList } from './model-discovery-view.mjs';

/**
 * GET /management/providers/templates
 * List built-in provider templates and supported auth flows.
 */
export async function handleListTemplates(ctx) {
  const { res, appCtx } = ctx;

  // If a provider catalog service is available, use it
  if (appCtx.services.providerCatalog) {
    const templates = appCtx.services.providerCatalog.getTemplates();
    sendJson(res, 200, { data: templates });
    return;
  }

  // Fallback: return empty list
  sendJson(res, 200, { data: [] });
}

/**
 * GET /management/providers
 */
export async function handleListProviders(ctx) {
  const { res, query, appCtx } = ctx;
  const { pool } = appCtx;

  const enabled = query.enabled !== undefined ? query.enabled === 'true' : null;
  const kind = query.kind || null;
  const limit = Math.min(parseInt(query.limit, 10) || 200, 500);
  const offset = parseInt(query.offset, 10) || 0;

  const rows = await providersDao.list(pool, { enabled, kind, limit, offset });
  sendJson(res, 200, { data: toProviderList(rows) });
}

/**
 * POST /management/providers
 */
export async function handleCreateProvider(ctx) {
  const { req, res, appCtx } = ctx;
  const { pool } = appCtx;
  const body = await readJsonBody(req);

  const providerKey = body?.providerKey ?? body?.provider_key ?? body?.name ?? null;
  const displayName = body?.displayName ?? body?.display_name ?? null;
  const authType = body?.authType ?? body?.auth_type ?? null;
  const oauthAdapterKey = body?.oauthAdapterKey ?? body?.oauth_adapter_key ?? null;
  const providerMode = body?.providerMode ?? body?.provider_mode ?? 'external_api';
  const executorKey = body?.executorKey ?? body?.executor_key ?? null;
  const adapterKey = body?.adapterKey ?? body?.adapter_key ?? (providerMode === 'custom' ? (executorKey || providerKey) : null);
  const kind = providerMode === 'custom' ? 'custom' : 'external_api';
  const inferredAuthStrategy = authType === 'managed'
    ? 'oauth'
    : (body?.authStrategy ?? body?.auth_strategy ?? null);

  if (!body || !providerKey || !displayName || !adapterKey || !inferredAuthStrategy) {
    throw new BadRequestError('Missing required fields: providerKey, displayName, adapterKey, authStrategy');
  }

  const row = await providersDao.create(pool, {
    providerKey,
    displayName,
    kind,
    adapterKey,
    authStrategy: inferredAuthStrategy,
    providerMode,
    executorKey,
    oauthAdapterKey,
    baseUrl: body.baseUrl ?? body.base_url ?? null,
    enabled: body.enabled ?? true,
    settings: body.settings ?? {},
    metadata: body.metadata ?? {},
  });

  // If an API key was provided, create an account for it
  const apiKey = body.api_key ?? body.apiKey ?? null;
  await upsertProviderApiKeyAccount({
    appCtx,
    providerId: row.id,
    providerDisplayName: row.display_name,
    apiKey,
  });

  // Refresh runtime snapshot after mutation
  requestRuntimeRefresh(appCtx, { snapshot: true, reason: 'provider.create' });

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

  const allowed = [
    'displayName', 'display_name', 'adapterKey', 'adapter_key', 'authStrategy', 'auth_strategy',
    'providerMode', 'provider_mode', 'executorKey', 'executor_key',
    'oauthAdapterKey', 'oauth_adapter_key',
    'baseUrl', 'enabled', 'supportsStreaming', 'supportsTools',
    'supportsMessagesApi', 'supportsResponsesApi', 'settings', 'metadata',
  ];

  const fields = {};
  for (const k of allowed) {
    if (body[k] !== undefined) {
      const normalizedKey = ({
        display_name: 'displayName',
        adapter_key: 'adapterKey',
        auth_strategy: 'authStrategy',
        provider_mode: 'providerMode',
        executor_key: 'executorKey',
        oauth_adapter_key: 'oauthAdapterKey',
      })[k] || k;
      fields[normalizedKey] = body[k];
    }
  }

  if ((body?.authType ?? body?.auth_type) === 'managed') {
    fields.authStrategy = 'oauth';
  }

  if (fields.providerMode !== undefined) {
    fields.kind = fields.providerMode === 'custom' ? 'custom' : 'external_api';
  }

  const row = await providersDao.update(pool, params.providerId, fields);
  if (!row) {
    sendNotFound(res, 'Provider');
    return;
  }

  // If an API key was provided, upsert an account for it
  const apiKey = body.api_key ?? body.apiKey ?? null;
  await upsertProviderApiKeyAccount({
    appCtx,
    providerId: params.providerId,
    providerDisplayName: row.display_name,
    apiKey,
  });

  // Refresh runtime snapshot after mutation
  requestRuntimeRefresh(appCtx, { snapshot: true, reason: 'provider.update' });

  sendJson(res, 200, { provider: row });
}

/**
 * DELETE /management/providers/:providerId
 */
export async function handleDeleteProvider(ctx) {
  const { res, params, appCtx } = ctx;
  const { pool } = appCtx;

  // Check for dependent models
  const models = await modelsDao.listByProvider(pool, params.providerId);
  if (models.length > 0) {
    sendConflict(res, `Cannot delete provider: ${models.length} model(s) depend on it`, {
      modelCount: models.length,
    });
    return;
  }

  const ok = await providersDao.del(pool, params.providerId);
  if (!ok) {
    sendNotFound(res, 'Provider');
    return;
  }

  // Refresh runtime snapshot after mutation
  requestRuntimeRefresh(appCtx, { snapshot: true, reason: 'provider.delete' });

  sendJson(res, 200, { ok: true });
}

/**
 * POST /management/providers/:providerId/test
 * Test connectivity and authentication.
 */
export async function handleTestConnection(ctx) {
  const { res, params, appCtx } = ctx;

  const provider = await loadProviderOrRespond(ctx, params.providerId);
  if (!provider) return;

  if (!appCtx.services.providerCatalog) {
    sendJson(res, HTTP_STATUS.OK, {
      ok: false,
      error: ERROR_MESSAGES.PROVIDER_CATALOG_NOT_INITIALIZED,
      latencyMs: 0,
    });
    return;
  }

  const start = Date.now();
  let result;
  try {
    result = await appCtx.services.providerCatalog.testConnection(
      provider,
      buildProviderLifecycleOptions(appCtx),
    );
  } catch (err) {
    sendJson(res, 200, {
      ok: false,
      error: err.message || 'Test failed',
      latencyMs: Date.now() - start,
    });
    return;
  }

  sendJson(res, 200, buildTestConnectionResponse(result, Date.now() - start));
}

/**
 * Translate a provider plugin's `{ ok, detail }` contract into the
 * `{ ok, message | error, latencyMs }` shape the dashboard expects.
 *
 * @param {{ ok: boolean, detail?: any }} result
 * @param {number} latencyMs
 * @returns {object}
 */
function buildTestConnectionResponse(result, latencyMs) {
  const message = extractDetailString(result?.detail);
  if (result?.ok) {
    return { ok: true, message: message || 'Connected', latencyMs };
  }
  return { ok: false, error: message || 'Connection failed', latencyMs };
}

/**
 * Plugins historically returned `detail` as either a string or an
 * object (e.g. `{ error: '...' }`). Collapse both shapes to a plain
 * string so the dashboard can render it directly.
 *
 * @param {any} detail
 * @returns {string|null}
 */
function extractDetailString(detail) {
  if (detail == null) return null;
  if (typeof detail === 'string') return detail;
  if (typeof detail === 'object') {
    return detail.error || detail.message || detail.detail || null;
  }
  return String(detail);
}

/**
 * POST /management/providers/:providerId/discover-models
 */
export async function handleDiscoverModels(ctx) {
  const { res, params, appCtx } = ctx;

  const provider = await loadProviderOrRespond(ctx, params.providerId);
  if (!provider) return;

  if (!appCtx.services.providerCatalog) {
    sendJson(res, 200, { data: [] });
    return;
  }

  try {
    const discoveries = await appCtx.services.providerCatalog.discoverModels(
      provider,
      buildProviderLifecycleOptions(appCtx),
    );
    sendJson(res, 200, {
      data: toDiscoveryList(discoveries, { providerName: provider.provider_key }),
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
  const { pool } = appCtx;
  const body = await readJsonBody(req);

  const provider = await loadProviderOrRespond(ctx, params.providerId);
  if (!provider) return;

  // Use provided discoveries or discover fresh
  let discoveries = body?.discoveries;
  if (!discoveries && appCtx.services.providerCatalog) {
    discoveries = await appCtx.services.providerCatalog.discoverModels(
      provider,
      buildProviderLifecycleOptions(appCtx),
    );
  }

  if (!discoveries || !Array.isArray(discoveries)) {
    sendJson(res, 200, { synced: 0, models: [] });
    return;
  }

  const synced = [];
  for (const d of discoveries) {
    const row = await modelsDao.syncFromDiscovery(pool, {
      modelKey: d.modelKey,
      displayName: d.displayName,
      providerId: params.providerId,
      providerModelId: d.providerModelId,
      executionKind: d.executionKind ?? 'provider_model',
      pricingMode: d.pricingMode ?? 'external_directory',
      inputPricePerMillion: d.inputPricePerMillion ?? null,
      outputPricePerMillion: d.outputPricePerMillion ?? null,
      requestPriceUsd: d.requestPriceUsd ?? null,
      isFree: d.isFree ?? false,
      capabilities: d.capabilities ?? {},
      tags: d.tags ?? [],
    });
    synced.push(row);
  }

  // Refresh runtime snapshot after mutation
  requestRuntimeRefresh(appCtx, { snapshot: true, reason: 'provider.sync-models' });

  sendJson(res, 200, { synced: synced.length, models: synced });
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
    const result = await appCtx.services.oauthManager.startFlow(provider, { label: body?.label });
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
    const result = await appCtx.services.oauthManager.handleCallback(params.providerId, query);
    // Return a simple HTML close page or JSON
    if (query.html) {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end('<html><body><script>window.close();</script><p>Authentication complete. You can close this window.</p></body></html>');
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
    const result = await appCtx.services.oauthManager.pollPending(params.providerId, params.flowId);
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

  const row = await accountsDao.del(pool, params.accountId);
  if (!row) {
    sendNotFound(res, 'Account');
    return;
  }

  sendJson(res, 200, { ok: true });
}

/**
 * POST /management/providers/:providerId/accounts/:accountId/reset-quota
 */
export async function handleResetAccountQuota(ctx) {
  const { res, params, appCtx } = ctx;
  const { pool } = appCtx;

  const row = await accountsDao.updateStatus(pool, params.accountId, 'active');
  if (!row) {
    sendNotFound(res, 'Account');
    return;
  }

  sendJson(res, 200, { account: row });
}

/**
 * POST /management/providers/rescan
 * Rescan extension directories.
 */
export async function handleRescan(ctx) {
  const { res, appCtx } = ctx;

  let providerCatalogGeneration = null;
  let providerCount = null;
  let extensionGeneration = null;

  const refresh = await performRuntimeRefresh(appCtx, {
    providerCatalog: true,
    snapshot: true,
    reason: 'provider.rescan',
  });
  providerCatalogGeneration = refresh.providerCatalogGeneration;
  providerCount = refresh.providerCount;
  extensionGeneration = refresh.extensionGeneration ?? null;

  sendJson(res, 200, {
    ok: true,
    snapshotGeneration: refresh.snapshotGeneration,
    providerCatalogGeneration,
    providerCount,
    extensionGeneration,
  });
}
