/**
 * Provider hook management routes.
 *
 * GET    /management/provider-hooks                              — list all registered hook modules
 * GET    /management/executors                                   — list all registered executor modules
 * GET    /management/providers/:providerId/hooks                 — list assignments for a provider
 * POST   /management/providers/:providerId/hooks                 — create an assignment
 * PATCH  /management/providers/:providerId/hooks/:assignmentId   — update an assignment
 * DELETE /management/providers/:providerId/hooks/:assignmentId   — delete an assignment
 */

import { readJsonBody } from '../core/json-body.mjs';
import { sendJson } from '../core/responses.mjs';
import { BadRequestError } from '../core/errors.mjs';
import { HOOK_PHASES } from '../runtime/hooks/hook-constants.mjs';
import * as assignmentsDao from '../db/dao/provider-hook-assignments-dao.mjs';
import { requestRuntimeRefresh } from '../runtime/registry/runtime-refresh.mjs';
import { sendNotFound } from './route-response-helpers.mjs';

const VALID_PHASES = new Set(Object.values(HOOK_PHASES));

// ── Helpers ────────────────────────────────────────────────────────

function getCatalog(appCtx) {
  return appCtx.services.providerHookCatalog;
}

async function reloadCatalogAndSnapshot(appCtx, reason) {
  await requestRuntimeRefresh(appCtx, {
    providerCatalog: true,
    snapshot: true,
    reason,
  });
}

// ── Catalog route ──────────────────────────────────────────────────

/**
 * GET /management/provider-hooks
 * List all registered provider hook modules from the catalog.
 */
export async function handleListProviderHooks(ctx) {
  const { res, appCtx } = ctx;
  const catalog = getCatalog(appCtx);

  const data = catalog.listHookKeys().map((key) => {
    const hook = catalog.getHook(key);
    return {
      key,
      name: hook.meta.name,
      scope: hook.meta.scope,
      phases: hook.meta.phases,
      defaultSettings: hook.meta.defaultSettings || {},
    };
  });

  sendJson(res, 200, { data });
}

// ── Executor catalog route ─────────────────────────────────────────

/**
 * GET /management/executors
 * List all registered executor modules from the executor catalog.
 */
export async function handleListExecutors(ctx) {
  const { res, appCtx } = ctx;
  const catalog = appCtx.services.executorCatalog;

  const data = catalog
    ? catalog.listKeys().map((key) => {
        const exec = catalog.getExecutor(key);
        return {
          key,
          name: exec?.manifest?.name || key,
          executorType: exec?.manifest?.executorType || 'external_api',
          supportsStreaming: exec?.manifest?.supportsStreaming ?? true,
          supportsTools: exec?.manifest?.supportsTools ?? false,
        };
      })
    : [];

  sendJson(res, 200, { data });
}

// ── Assignment routes ──────────────────────────────────────────────

/**
 * GET /management/providers/:providerId/hooks
 * List hook assignments for a provider, grouped by phase.
 */
export async function handleListProviderHookAssignments(ctx) {
  const { res, params, appCtx } = ctx;
  const { pool } = appCtx;

  const rows = await assignmentsDao.listByProvider(pool, params.providerId);

  const grouped = { request: [], stream: [], response: [] };
  for (const row of rows) {
    if (grouped[row.phase]) {
      grouped[row.phase].push(row);
    }
  }

  sendJson(res, 200, { data: grouped });
}

/**
 * POST /management/providers/:providerId/hooks
 * Create a new provider hook assignment.
 *
 * Body: { hookKey, phase, sortOrder?, enabled?, settings? }
 */
export async function handleCreateProviderHookAssignment(ctx) {
  const { req, res, params, appCtx } = ctx;
  const { pool } = appCtx;
  const body = await readJsonBody(req);

  if (!body || !body.hookKey || !body.phase) {
    throw new BadRequestError('Missing required fields: hookKey, phase');
  }

  const catalog = getCatalog(appCtx);
  if (!catalog.getHook(body.hookKey)) {
    throw new BadRequestError(`Unknown hook key: ${body.hookKey}`);
  }

  if (!VALID_PHASES.has(body.phase)) {
    throw new BadRequestError(`Invalid phase: ${body.phase}. Must be one of: ${[...VALID_PHASES].join(', ')}`);
  }

  const row = await assignmentsDao.create(pool, {
    providerId: params.providerId,
    hookKey: body.hookKey,
    phase: body.phase,
    sortOrder: body.sortOrder ?? 100,
    enabled: body.enabled ?? true,
    settings: body.settings ?? {},
  });

  await reloadCatalogAndSnapshot(appCtx, 'provider-hook.assignment.create');

  sendJson(res, 201, { assignment: row });
}

/**
 * PATCH /management/providers/:providerId/hooks/:assignmentId
 * Update an existing provider hook assignment.
 *
 * Body: partial { sortOrder?, enabled?, settings? }
 */
export async function handleUpdateProviderHookAssignment(ctx) {
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

  await reloadCatalogAndSnapshot(appCtx, 'provider-hook.assignment.update');

  sendJson(res, 200, { assignment: row });
}

/**
 * DELETE /management/providers/:providerId/hooks/:assignmentId
 * Delete a provider hook assignment.
 */
export async function handleDeleteProviderHookAssignment(ctx) {
  const { res, params, appCtx } = ctx;
  const { pool } = appCtx;

  const ok = await assignmentsDao.del(pool, params.assignmentId);
  if (!ok) {
    sendNotFound(res, 'Assignment');
    return;
  }

  await reloadCatalogAndSnapshot(appCtx, 'provider-hook.assignment.delete');

  sendJson(res, 200, { ok: true });
}
