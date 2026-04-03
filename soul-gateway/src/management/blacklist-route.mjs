/**
 * Management blacklist routes.
 *
 * GET    /management/blacklist/rules
 * POST   /management/blacklist/rules
 * GET    /management/blacklist/rules/:ruleId
 * PATCH  /management/blacklist/rules/:ruleId
 * DELETE /management/blacklist/rules/:ruleId
 * POST   /management/blacklist/rules/:ruleId/enable
 * POST   /management/blacklist/rules/:ruleId/disable
 */

import { readJsonBody } from '../core/json-body.mjs';
import { sendJson } from '../core/responses.mjs';
import { BadRequestError } from '../core/errors.mjs';
import * as blacklistDao from '../db/dao/blacklist-dao.mjs';
import { requestRuntimeRefresh } from '../runtime/registry/runtime-refresh.mjs';
import { sendNotFound } from './route-response-helpers.mjs';

/**
 * GET /management/blacklist/rules
 */
export async function handleListRules(ctx) {
  const { res, query, appCtx } = ctx;
  const { pool } = appCtx;

  const limit = Math.min(parseInt(query.limit, 10) || 500, 1000);
  const offset = parseInt(query.offset, 10) || 0;

  const rows = await blacklistDao.list(pool, { limit, offset });
  sendJson(res, 200, { data: rows });
}

/**
 * POST /management/blacklist/rules
 */
export async function handleCreateRule(ctx) {
  const { req, res, appCtx } = ctx;
  const { pool } = appCtx;
  const body = await readJsonBody(req);

  if (!body || !body.ruleKey || !body.matchType || !body.pattern) {
    throw new BadRequestError('Missing required fields: ruleKey, matchType, pattern');
  }

  const row = await blacklistDao.create(pool, {
    ruleKey: body.ruleKey,
    description: body.description ?? null,
    matchType: body.matchType,
    pattern: body.pattern,
    caseSensitive: body.caseSensitive ?? false,
    priority: body.priority ?? 100,
    enabled: body.enabled ?? true,
    metadata: body.metadata ?? {},
  });

  // Refresh runtime snapshot after mutation
  requestRuntimeRefresh(appCtx, { snapshot: true, reason: 'blacklist.create' });

  sendJson(res, 201, { rule: row });
}

/**
 * GET /management/blacklist/rules/:ruleId
 */
export async function handleGetRule(ctx) {
  const { res, params, appCtx } = ctx;
  const { pool } = appCtx;

  const row = await blacklistDao.findById(pool, params.ruleId);
  if (!row) {
    sendNotFound(res, 'Rule');
    return;
  }

  sendJson(res, 200, { rule: row });
}

/**
 * PATCH /management/blacklist/rules/:ruleId
 */
export async function handleUpdateRule(ctx) {
  const { req, res, params, appCtx } = ctx;
  const { pool } = appCtx;
  const body = await readJsonBody(req);

  if (!body || Object.keys(body).length === 0) {
    throw new BadRequestError('Empty update body');
  }

  const allowed = ['description', 'matchType', 'pattern', 'caseSensitive', 'priority', 'enabled', 'metadata'];
  const fields = {};
  for (const k of allowed) {
    if (body[k] !== undefined) fields[k] = body[k];
  }

  const row = await blacklistDao.update(pool, params.ruleId, fields);
  if (!row) {
    sendNotFound(res, 'Rule');
    return;
  }

  // Refresh runtime snapshot after mutation
  requestRuntimeRefresh(appCtx, { snapshot: true, reason: 'blacklist.update' });

  sendJson(res, 200, { rule: row });
}

/**
 * DELETE /management/blacklist/rules/:ruleId
 */
export async function handleDeleteRule(ctx) {
  const { res, params, appCtx } = ctx;
  const { pool } = appCtx;

  const ok = await blacklistDao.del(pool, params.ruleId);
  if (!ok) {
    sendNotFound(res, 'Rule');
    return;
  }

  // Refresh runtime snapshot after mutation
  requestRuntimeRefresh(appCtx, { snapshot: true, reason: 'blacklist.delete' });

  sendJson(res, 200, { ok: true });
}

/**
 * POST /management/blacklist/rules/:ruleId/enable
 */
export async function handleEnableRule(ctx) {
  const { res, params, appCtx } = ctx;
  const { pool } = appCtx;

  const row = await blacklistDao.update(pool, params.ruleId, { enabled: true });
  if (!row) {
    sendNotFound(res, 'Rule');
    return;
  }

  // Refresh runtime snapshot after mutation
  requestRuntimeRefresh(appCtx, { snapshot: true, reason: 'blacklist.enable' });

  sendJson(res, 200, { rule: row });
}

/**
 * POST /management/blacklist/rules/:ruleId/disable
 */
export async function handleDisableRule(ctx) {
  const { res, params, appCtx } = ctx;
  const { pool } = appCtx;

  const row = await blacklistDao.update(pool, params.ruleId, { enabled: false });
  if (!row) {
    sendNotFound(res, 'Rule');
    return;
  }

  // Refresh runtime snapshot after mutation
  requestRuntimeRefresh(appCtx, { snapshot: true, reason: 'blacklist.disable' });

  sendJson(res, 200, { rule: row });
}
