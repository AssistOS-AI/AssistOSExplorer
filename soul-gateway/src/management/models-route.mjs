/**
 * Management model routes.
 *
 * GET    /management/models
 * POST   /management/models
 * GET    /management/models/:modelId
 * PATCH  /management/models/:modelId
 * DELETE /management/models/:modelId
 * POST   /management/models/:modelId/enable
 * POST   /management/models/:modelId/disable
 */

import { readJsonBody } from '../core/json-body.mjs';
import { sendJson } from '../core/responses.mjs';
import { BadRequestError } from '../core/errors.mjs';
import * as modelsDao from '../db/dao/models-dao.mjs';
import { requestRuntimeRefresh } from '../runtime/registry/runtime-refresh.mjs';
import { sendNotFound } from './route-response-helpers.mjs';

/**
 * GET /management/models
 */
export async function handleListModels(ctx) {
  const { res, query, appCtx } = ctx;
  const { pool } = appCtx;

  const enabled = query.enabled !== undefined ? query.enabled === 'true' : null;
  const executionKind = query.executionKind || null;
  const limit = Math.min(parseInt(query.limit, 10) || 500, 1000);
  const offset = parseInt(query.offset, 10) || 0;

  const rows = await modelsDao.list(pool, { enabled, executionKind, limit, offset });
  sendJson(res, 200, { data: rows });
}

/**
 * POST /management/models
 */
export async function handleCreateModel(ctx) {
  const { req, res, appCtx } = ctx;
  const { pool } = appCtx;
  const body = await readJsonBody(req);

  if (!body || !body.modelKey || !body.displayName || !body.providerId || !body.providerModelId) {
    throw new BadRequestError('Missing required fields: modelKey, displayName, providerId, providerModelId');
  }

  const row = await modelsDao.create(pool, {
    modelKey: body.modelKey,
    displayName: body.displayName,
    providerId: body.providerId,
    providerModelId: body.providerModelId,
    executionKind: body.executionKind ?? 'provider_model',
    enabled: body.enabled ?? true,
    concurrencyLimit: body.concurrencyLimit ?? 3,
    queueTimeoutMs: body.queueTimeoutMs ?? 60_000,
    requestTimeoutMs: body.requestTimeoutMs ?? 120_000,
    pricingMode: body.pricingMode ?? 'external_directory',
    inputPricePerMillion: body.inputPricePerMillion ?? null,
    outputPricePerMillion: body.outputPricePerMillion ?? null,
    requestPriceUsd: body.requestPriceUsd ?? null,
    tags: body.tags ?? [],
    capabilities: body.capabilities ?? {},
    metadata: body.metadata ?? {},
  });

  // Refresh runtime snapshot after mutation
  requestRuntimeRefresh(appCtx, { snapshot: true, reason: 'model.create' });

  sendJson(res, 201, { model: row });
}

/**
 * GET /management/models/:modelId
 */
export async function handleGetModel(ctx) {
  const { res, params, appCtx } = ctx;
  const { pool } = appCtx;

  const row = await modelsDao.findById(pool, params.modelId);
  if (!row) {
    sendNotFound(res, 'Model');
    return;
  }

  sendJson(res, 200, { model: row });
}

/**
 * PATCH /management/models/:modelId
 */
export async function handleUpdateModel(ctx) {
  const { req, res, params, appCtx } = ctx;
  const { pool } = appCtx;
  const body = await readJsonBody(req);

  if (!body || Object.keys(body).length === 0) {
    throw new BadRequestError('Empty update body');
  }

  const allowed = [
    'displayName', 'providerModelId', 'executionKind', 'enabled',
    'concurrencyLimit', 'queueTimeoutMs', 'requestTimeoutMs',
    'pricingMode', 'inputPricePerMillion', 'outputPricePerMillion', 'requestPriceUsd',
    'rateLimitOverride', 'budgetOverride', 'loopOverride', 'responseFilterOverride',
    'retryPolicy', 'capabilities', 'tags', 'isFree', 'metadata',
  ];

  const fields = {};
  for (const k of allowed) {
    if (body[k] !== undefined) fields[k] = body[k];
  }

  const row = await modelsDao.update(pool, params.modelId, fields);
  if (!row) {
    sendNotFound(res, 'Model');
    return;
  }

  // Refresh runtime snapshot after mutation
  requestRuntimeRefresh(appCtx, { snapshot: true, reason: 'model.update' });

  sendJson(res, 200, { model: row });
}

/**
 * DELETE /management/models/:modelId
 */
export async function handleDeleteModel(ctx) {
  const { res, params, appCtx } = ctx;
  const { pool } = appCtx;

  const ok = await modelsDao.del(pool, params.modelId);
  if (!ok) {
    sendNotFound(res, 'Model');
    return;
  }

  // Also clean up aliases
  const aliasDao = await import('../db/dao/model-aliases-dao.mjs');
  await aliasDao.deleteByModel(pool, params.modelId);

  // Refresh runtime snapshot after mutation
  requestRuntimeRefresh(appCtx, { snapshot: true, reason: 'model.delete' });

  sendJson(res, 200, { ok: true });
}

/**
 * POST /management/models/:modelId/enable
 */
export async function handleEnableModel(ctx) {
  const { res, params, appCtx } = ctx;
  const { pool } = appCtx;

  const row = await modelsDao.enable(pool, params.modelId);
  if (!row) {
    sendNotFound(res, 'Model');
    return;
  }

  // Refresh runtime snapshot after mutation
  requestRuntimeRefresh(appCtx, { snapshot: true, reason: 'model.enable' });

  sendJson(res, 200, { model: row });
}

/**
 * POST /management/models/:modelId/disable
 */
export async function handleDisableModel(ctx) {
  const { res, params, appCtx } = ctx;
  const { pool } = appCtx;

  const row = await modelsDao.disable(pool, params.modelId);
  if (!row) {
    sendNotFound(res, 'Model');
    return;
  }

  // Refresh runtime snapshot after mutation
  requestRuntimeRefresh(appCtx, { snapshot: true, reason: 'model.disable' });

  sendJson(res, 200, { model: row });
}

/**
 * GET /management/models/providers
 * List distinct provider keys that have models registered.
 */
export async function handleListModelProviders(ctx) {
  const { res, appCtx } = ctx;
  const { pool } = appCtx;

  const { rows } = await pool.query(
    `SELECT DISTINCT provider_id,
            (SELECT p.provider_key FROM soul_gateway.providers p WHERE p.id = m.provider_id) AS provider_key,
            (SELECT p.display_name FROM soul_gateway.providers p WHERE p.id = m.provider_id) AS display_name
     FROM soul_gateway.models m
     WHERE provider_id IS NOT NULL
     ORDER BY provider_key ASC`,
  );
  sendJson(res, 200, { data: rows });
}

/**
 * GET /management/models/providers/:key/models
 * List models for a given provider key.
 */
export async function handleListProviderModels(ctx) {
  const { res, params, appCtx } = ctx;
  const { pool } = appCtx;

  const { rows } = await pool.query(
    `SELECT m.* FROM soul_gateway.models m
     JOIN soul_gateway.providers p ON p.id = m.provider_id
     WHERE p.provider_key = $1
     ORDER BY m.display_name ASC`,
    [params.key],
  );
  sendJson(res, 200, { data: rows });
}

/**
 * GET /management/models/tags
 * List distinct tags used across all models.
 */
export async function handleListModelTags(ctx) {
  const { res, appCtx } = ctx;
  const { pool } = appCtx;

  const { rows } = await pool.query(
    `SELECT DISTINCT unnest(tags) AS tag FROM soul_gateway.models ORDER BY tag ASC`,
  );
  sendJson(res, 200, { data: rows.map((r) => r.tag) });
}
