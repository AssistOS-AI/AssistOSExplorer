/**
 * Management middleware routes.
 *
 * GET    /management/middlewares
 * GET    /management/middlewares/:id
 * PATCH  /management/middlewares/:id
 * POST   /management/middlewares/rescan
 *
 * Assignment routes (flat):
 * POST   /management/middlewares/assignments
 * PATCH  /management/middlewares/assignments/:assignmentId
 * DELETE /management/middlewares/assignments/:assignmentId
 *
 * Tier-scoped middleware routes:
 * GET    /management/tiers/:tierId/middlewares
 * POST   /management/tiers/:tierId/middlewares
 * PATCH  /management/tiers/:tierId/middlewares/:assignmentId
 * DELETE /management/tiers/:tierId/middlewares/:assignmentId
 * POST   /management/tiers/:tierId/middlewares/reorder
 *
 * Model-scoped middleware routes:
 * GET    /management/models/:modelId/middlewares
 * POST   /management/models/:modelId/middlewares
 * PATCH  /management/models/:modelId/middlewares/:assignmentId
 * DELETE /management/models/:modelId/middlewares/:assignmentId
 * POST   /management/models/:modelId/middlewares/reorder
 */

import { readJsonBody } from '../core/json-body.mjs';
import { sendJson } from '../core/responses.mjs';
import { BadRequestError } from '../core/errors.mjs';
import * as middlewaresDao from '../db/dao/middlewares-dao.mjs';
import * as assignmentsDao from '../db/dao/middleware-assignments-dao.mjs';
import { performRuntimeRefresh, requestRuntimeRefresh } from '../runtime/registry/runtime-refresh.mjs';
import { sendNotFound } from './route-response-helpers.mjs';

// ── Catalog routes ──────────────────────────────────────────────────

/**
 * GET /management/middlewares
 * List middleware catalog and all assignments.
 */
export async function handleListMiddlewares(ctx) {
  const { res, appCtx } = ctx;
  const { pool } = appCtx;

  const catalog = await middlewaresDao.list(pool);
  sendJson(res, 200, { catalog });
}

/**
 * GET /management/middlewares/:id
 */
export async function handleGetMiddleware(ctx) {
  const { res, params, appCtx } = ctx;
  const { pool } = appCtx;

  const row = await middlewaresDao.findById(pool, params.id);
  if (!row) {
    sendNotFound(res, 'Middleware');
    return;
  }

  sendJson(res, 200, { middleware: row });
}

/**
 * PATCH /management/middlewares/:id
 */
export async function handleUpdateMiddleware(ctx) {
  const { req, res, params, appCtx } = ctx;
  const { pool } = appCtx;
  const body = await readJsonBody(req);

  if (!body || Object.keys(body).length === 0) {
    throw new BadRequestError('Empty update body');
  }

  const allowed = ['displayName', 'enabled', 'defaultSettings', 'metadata'];
  const fields = {};
  for (const k of allowed) {
    if (body[k] !== undefined) fields[k] = body[k];
  }

  const row = await middlewaresDao.update(pool, params.id, fields);
  if (!row) {
    sendNotFound(res, 'Middleware');
    return;
  }

  requestRuntimeRefresh(appCtx, { snapshot: true, reason: 'middleware.update' });

  sendJson(res, 200, { middleware: row });
}

/**
 * POST /management/middlewares/rescan
 */
export async function handleRescan(ctx) {
  const { res, appCtx } = ctx;

  let middlewareGeneration = null;
  let middlewareCount = null;

  const refresh = await performRuntimeRefresh(appCtx, {
    middlewareCatalog: true,
    snapshot: true,
    reason: 'middleware.rescan',
  });
  middlewareGeneration = refresh.middlewareGeneration;
  middlewareCount = refresh.middlewareCount;

  sendJson(res, 200, {
    ok: true,
    snapshotGeneration: refresh.snapshotGeneration,
    middlewareGeneration,
    middlewareCount,
  });
}

// ── Flat assignment routes ──────────────────────────────────────────

/**
 * POST /management/middlewares/assignments
 */
export async function handleCreateAssignment(ctx) {
  const { req, res, appCtx } = ctx;
  const { pool } = appCtx;
  const body = await readJsonBody(req);

  if (!body || !body.middlewareId || !body.targetType) {
    throw new BadRequestError('Missing required fields: middlewareId, targetType');
  }

  if (body.targetType === 'tier' && !body.tierId) {
    throw new BadRequestError('tierId required for tier assignment');
  }
  if (body.targetType === 'model' && !body.modelId) {
    throw new BadRequestError('modelId required for model assignment');
  }

  const row = await assignmentsDao.create(pool, {
    middlewareId: body.middlewareId,
    targetType: body.targetType,
    tierId: body.tierId ?? null,
    modelId: body.modelId ?? null,
    sortOrder: body.sortOrder ?? 100,
    enabled: body.enabled ?? true,
    settings: body.settings ?? {},
  });

  requestRuntimeRefresh(appCtx, { snapshot: true, reason: 'middleware.assignment.create' });

  sendJson(res, 201, { assignment: row });
}

/**
 * PATCH /management/middlewares/assignments/:assignmentId
 */
export async function handleUpdateAssignment(ctx) {
  const { req, res, params, appCtx } = ctx;
  const { pool } = appCtx;
  const body = await readJsonBody(req);

  if (!body || Object.keys(body).length === 0) {
    throw new BadRequestError('Empty update body');
  }

  const allowed = ['sortOrder', 'enabled', 'settings'];
  const fields = {};
  for (const k of allowed) {
    if (body[k] !== undefined) fields[k] = body[k];
  }

  const row = await assignmentsDao.update(pool, params.assignmentId, fields);
  if (!row) {
    sendNotFound(res, 'Assignment');
    return;
  }

  requestRuntimeRefresh(appCtx, { snapshot: true, reason: 'middleware.assignment.update' });

  sendJson(res, 200, { assignment: row });
}

/**
 * DELETE /management/middlewares/assignments/:assignmentId
 */
export async function handleDeleteAssignment(ctx) {
  const { res, params, appCtx } = ctx;
  const { pool } = appCtx;

  const ok = await assignmentsDao.del(pool, params.assignmentId);
  if (!ok) {
    sendNotFound(res, 'Assignment');
    return;
  }

  requestRuntimeRefresh(appCtx, { snapshot: true, reason: 'middleware.assignment.delete' });

  sendJson(res, 200, { ok: true });
}

// ── Tier-scoped middleware routes ───────────────────────────────────

/**
 * GET /management/tiers/:tierId/middlewares
 */
export async function handleListTierMiddlewares(ctx) {
  const { res, params, appCtx } = ctx;
  const { pool } = appCtx;

  const rows = await assignmentsDao.listForTier(pool, params.tierId);
  sendJson(res, 200, { data: rows });
}

/**
 * POST /management/tiers/:tierId/middlewares
 */
export async function handleCreateTierMiddleware(ctx) {
  const { req, res, params, appCtx } = ctx;
  const { pool } = appCtx;
  const body = await readJsonBody(req);

  if (!body || !body.middlewareId) {
    throw new BadRequestError('Missing required field: middlewareId');
  }

  const row = await assignmentsDao.create(pool, {
    middlewareId: body.middlewareId,
    targetType: 'tier',
    tierId: params.tierId,
    sortOrder: body.sortOrder ?? 100,
    enabled: body.enabled ?? true,
    settings: body.settings ?? {},
  });

  requestRuntimeRefresh(appCtx, { snapshot: true, reason: 'middleware.tier.create' });

  sendJson(res, 201, { assignment: row });
}

/**
 * PATCH /management/tiers/:tierId/middlewares/:assignmentId
 */
export async function handleUpdateTierMiddleware(ctx) {
  const { req, res, params, appCtx } = ctx;
  const { pool } = appCtx;
  const body = await readJsonBody(req);

  if (!body || Object.keys(body).length === 0) {
    throw new BadRequestError('Empty update body');
  }

  const allowed = ['sortOrder', 'enabled', 'settings'];
  const fields = {};
  for (const k of allowed) {
    if (body[k] !== undefined) fields[k] = body[k];
  }

  const row = await assignmentsDao.update(pool, params.assignmentId, fields);
  if (!row) {
    sendNotFound(res, 'Assignment');
    return;
  }

  requestRuntimeRefresh(appCtx, { snapshot: true, reason: 'middleware.tier.update' });

  sendJson(res, 200, { assignment: row });
}

/**
 * DELETE /management/tiers/:tierId/middlewares/:assignmentId
 */
export async function handleDeleteTierMiddleware(ctx) {
  const { res, params, appCtx } = ctx;
  const { pool } = appCtx;

  const ok = await assignmentsDao.del(pool, params.assignmentId);
  if (!ok) {
    sendNotFound(res, 'Assignment');
    return;
  }

  requestRuntimeRefresh(appCtx, { snapshot: true, reason: 'middleware.tier.delete' });

  sendJson(res, 200, { ok: true });
}

/**
 * POST /management/tiers/:tierId/middlewares/reorder
 * Body: { assignments: [{ id, sortOrder }] }
 */
export async function handleReorderTierMiddlewares(ctx) {
  const { req, res, params, appCtx } = ctx;
  const { pool } = appCtx;
  const body = await readJsonBody(req);

  if (!body || !Array.isArray(body.assignments)) {
    throw new BadRequestError('Expected assignments array');
  }

  await assignmentsDao.reorder(pool, body.assignments);
  const rows = await assignmentsDao.listForTier(pool, params.tierId);
  requestRuntimeRefresh(appCtx, { snapshot: true, reason: 'middleware.tier.reorder' });
  sendJson(res, 200, { data: rows });
}

// ── Model-scoped middleware routes ─────────────────────────────────

/**
 * GET /management/models/:modelId/middlewares
 */
export async function handleListModelMiddlewares(ctx) {
  const { res, params, appCtx } = ctx;
  const { pool } = appCtx;

  const rows = await assignmentsDao.listForModel(pool, params.modelId);
  sendJson(res, 200, { data: rows });
}

/**
 * POST /management/models/:modelId/middlewares
 */
export async function handleCreateModelMiddleware(ctx) {
  const { req, res, params, appCtx } = ctx;
  const { pool } = appCtx;
  const body = await readJsonBody(req);

  if (!body || !body.middlewareId) {
    throw new BadRequestError('Missing required field: middlewareId');
  }

  const row = await assignmentsDao.create(pool, {
    middlewareId: body.middlewareId,
    targetType: 'model',
    modelId: params.modelId,
    sortOrder: body.sortOrder ?? 100,
    enabled: body.enabled ?? true,
    settings: body.settings ?? {},
  });

  requestRuntimeRefresh(appCtx, { snapshot: true, reason: 'middleware.model.create' });

  sendJson(res, 201, { assignment: row });
}

/**
 * PATCH /management/models/:modelId/middlewares/:assignmentId
 */
export async function handleUpdateModelMiddleware(ctx) {
  const { req, res, params, appCtx } = ctx;
  const { pool } = appCtx;
  const body = await readJsonBody(req);

  if (!body || Object.keys(body).length === 0) {
    throw new BadRequestError('Empty update body');
  }

  const allowed = ['sortOrder', 'enabled', 'settings'];
  const fields = {};
  for (const k of allowed) {
    if (body[k] !== undefined) fields[k] = body[k];
  }

  const row = await assignmentsDao.update(pool, params.assignmentId, fields);
  if (!row) {
    sendNotFound(res, 'Assignment');
    return;
  }

  requestRuntimeRefresh(appCtx, { snapshot: true, reason: 'middleware.model.update' });

  sendJson(res, 200, { assignment: row });
}

/**
 * DELETE /management/models/:modelId/middlewares/:assignmentId
 */
export async function handleDeleteModelMiddleware(ctx) {
  const { res, params, appCtx } = ctx;
  const { pool } = appCtx;

  const ok = await assignmentsDao.del(pool, params.assignmentId);
  if (!ok) {
    sendNotFound(res, 'Assignment');
    return;
  }

  requestRuntimeRefresh(appCtx, { snapshot: true, reason: 'middleware.model.delete' });

  sendJson(res, 200, { ok: true });
}

/**
 * POST /management/models/:modelId/middlewares/reorder
 * Body: { assignments: [{ id, sortOrder }] }
 */
export async function handleReorderModelMiddlewares(ctx) {
  const { req, res, params, appCtx } = ctx;
  const { pool } = appCtx;
  const body = await readJsonBody(req);

  if (!body || !Array.isArray(body.assignments)) {
    throw new BadRequestError('Expected assignments array');
  }

  await assignmentsDao.reorder(pool, body.assignments);
  const rows = await assignmentsDao.listForModel(pool, params.modelId);
  requestRuntimeRefresh(appCtx, { snapshot: true, reason: 'middleware.model.reorder' });
  sendJson(res, 200, { data: rows });
}
