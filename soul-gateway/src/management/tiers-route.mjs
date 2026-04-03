/**
 * Management tier routes.
 *
 * GET    /management/tiers
 * POST   /management/tiers
 * GET    /management/tiers/:tierId
 * PATCH  /management/tiers/:tierId
 * DELETE /management/tiers/:tierId
 * POST   /management/tiers/:tierId/enable
 * POST   /management/tiers/:tierId/disable
 */

import { readJsonBody } from '../core/json-body.mjs';
import { sendJson } from '../core/responses.mjs';
import { BadRequestError } from '../core/errors.mjs';
import * as tiersDao from '../db/dao/tiers-dao.mjs';
import { requestRuntimeRefresh } from '../runtime/registry/runtime-refresh.mjs';
import { sendNotFound } from './route-response-helpers.mjs';

/**
 * GET /management/tiers
 */
export async function handleListTiers(ctx) {
  const { res, query, appCtx } = ctx;
  const { pool } = appCtx;

  const enabled = query.enabled !== undefined ? query.enabled === 'true' : null;
  const limit = Math.min(parseInt(query.limit, 10) || 200, 500);
  const offset = parseInt(query.offset, 10) || 0;

  const tiers = await tiersDao.list(pool, { enabled, limit, offset });

  // Enrich with tier_models
  const data = [];
  for (const tier of tiers) {
    const models = await tiersDao.listModelsForTier(pool, tier.id);
    data.push({ ...tier, models });
  }

  sendJson(res, 200, { data });
}

/**
 * POST /management/tiers
 */
export async function handleCreateTier(ctx) {
  const { req, res, appCtx } = ctx;
  const { pool } = appCtx;
  const body = await readJsonBody(req);

  if (!body || !body.tierKey || !body.displayName) {
    throw new BadRequestError('Missing required fields: tierKey, displayName');
  }

  const tier = await tiersDao.create(pool, {
    tierKey: body.tierKey,
    displayName: body.displayName,
    description: body.description ?? null,
    fallbackTierId: body.fallbackTierId ?? null,
    maxModelAttempts: body.maxModelAttempts ?? 5,
    enabled: body.enabled ?? true,
    metadata: body.metadata ?? {},
  });

  // Add tier models if provided
  if (Array.isArray(body.models)) {
    for (const m of body.models) {
      await tiersDao.addModel(pool, {
        tierId: tier.id,
        modelId: m.modelId,
        priority: m.priority,
        settings: m.settings ?? {},
      });
    }
  }

  const models = await tiersDao.listModelsForTier(pool, tier.id);

  // Refresh runtime snapshot after mutation
  requestRuntimeRefresh(appCtx, { snapshot: true, reason: 'tier.create' });

  sendJson(res, 201, { tier: { ...tier, models } });
}

/**
 * GET /management/tiers/:tierId
 */
export async function handleGetTier(ctx) {
  const { res, params, appCtx } = ctx;
  const { pool } = appCtx;

  const tier = await tiersDao.findById(pool, params.tierId);
  if (!tier) {
    sendNotFound(res, 'Tier');
    return;
  }

  const models = await tiersDao.listModelsForTier(pool, tier.id);
  sendJson(res, 200, { tier: { ...tier, models } });
}

/**
 * PATCH /management/tiers/:tierId
 */
export async function handleUpdateTier(ctx) {
  const { req, res, params, appCtx } = ctx;
  const { pool } = appCtx;
  const body = await readJsonBody(req);

  if (!body || Object.keys(body).length === 0) {
    throw new BadRequestError('Empty update body');
  }

  const allowed = [
    'displayName', 'description', 'fallbackTierId', 'maxModelAttempts',
    'enabled', 'rateLimitOverride', 'budgetOverride', 'loopOverride',
    'responseFilterOverride', 'metadata',
  ];

  const fields = {};
  for (const k of allowed) {
    if (body[k] !== undefined) fields[k] = body[k];
  }

  const tier = await tiersDao.update(pool, params.tierId, fields);
  if (!tier) {
    sendNotFound(res, 'Tier');
    return;
  }

  // If models array provided, rebuild tier_models
  if (Array.isArray(body.models)) {
    // Get existing to remove
    const existing = await tiersDao.listModelsForTier(pool, tier.id);
    for (const m of existing) {
      await tiersDao.removeModel(pool, tier.id, m.model_id);
    }
    for (const m of body.models) {
      await tiersDao.addModel(pool, {
        tierId: tier.id,
        modelId: m.modelId,
        priority: m.priority,
        settings: m.settings ?? {},
      });
    }
  }

  const models = await tiersDao.listModelsForTier(pool, tier.id);

  // Refresh runtime snapshot after mutation
  requestRuntimeRefresh(appCtx, { snapshot: true, reason: 'tier.update' });

  sendJson(res, 200, { tier: { ...tier, models } });
}

/**
 * DELETE /management/tiers/:tierId
 */
export async function handleDeleteTier(ctx) {
  const { res, params, appCtx } = ctx;
  const { pool } = appCtx;

  const ok = await tiersDao.del(pool, params.tierId);
  if (!ok) {
    sendNotFound(res, 'Tier');
    return;
  }

  // Refresh runtime snapshot after mutation
  requestRuntimeRefresh(appCtx, { snapshot: true, reason: 'tier.delete' });

  sendJson(res, 200, { ok: true });
}

/**
 * POST /management/tiers/:tierId/enable
 */
export async function handleEnableTier(ctx) {
  const { res, params, appCtx } = ctx;
  const { pool } = appCtx;

  const row = await tiersDao.enable(pool, params.tierId);
  if (!row) {
    sendNotFound(res, 'Tier');
    return;
  }

  const models = await tiersDao.listModelsForTier(pool, row.id);

  // Refresh runtime snapshot after mutation
  requestRuntimeRefresh(appCtx, { snapshot: true, reason: 'tier.enable' });

  sendJson(res, 200, { tier: { ...row, models } });
}

/**
 * POST /management/tiers/:tierId/disable
 */
export async function handleDisableTier(ctx) {
  const { res, params, appCtx } = ctx;
  const { pool } = appCtx;

  const row = await tiersDao.disable(pool, params.tierId);
  if (!row) {
    sendNotFound(res, 'Tier');
    return;
  }

  const models = await tiersDao.listModelsForTier(pool, row.id);

  // Refresh runtime snapshot after mutation
  requestRuntimeRefresh(appCtx, { snapshot: true, reason: 'tier.disable' });

  sendJson(res, 200, { tier: { ...row, models } });
}
