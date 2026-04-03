/**
 * Management cooldown routes.
 *
 * GET    /management/cooldowns
 * DELETE /management/cooldowns
 * DELETE /management/cooldowns/:modelId
 */

import { sendJson } from '../core/responses.mjs';
import * as cooldownsDao from '../db/dao/cooldowns-dao.mjs';
import { requestRuntimeRefresh } from '../runtime/registry/runtime-refresh.mjs';

/**
 * GET /management/cooldowns
 * List all active cooldowns.
 */
export async function handleListCooldowns(ctx) {
  const { res, appCtx } = ctx;
  const { pool } = appCtx;

  const rows = await cooldownsDao.listActive(pool);
  sendJson(res, 200, { data: rows });
}

/**
 * DELETE /management/cooldowns
 * Clear all cooldowns.
 */
export async function handleClearAll(ctx) {
  const { res, appCtx } = ctx;
  const { pool } = appCtx;

  const cleared = await cooldownsDao.clearAll(pool, 'admin');

  // Also clear from in-memory cooldown store if available
  if (appCtx.services.cooldownStore) {
    appCtx.services.cooldownStore.clearAll();
  }

  // Refresh runtime snapshot after mutation
  requestRuntimeRefresh(appCtx, { snapshot: true, reason: 'cooldown.clear-all' });

  sendJson(res, 200, { cleared });
}

/**
 * DELETE /management/cooldowns/:modelId
 * Clear cooldown for one model.
 */
export async function handleClearModel(ctx) {
  const { res, params, appCtx } = ctx;
  const { pool } = appCtx;

  await cooldownsDao.clearByModel(pool, params.modelId, 'admin');

  // Also clear from in-memory store if available
  if (appCtx.services.cooldownStore) {
    appCtx.services.cooldownStore.clear(params.modelId);
  }

  // Refresh runtime snapshot after mutation
  requestRuntimeRefresh(appCtx, { snapshot: true, reason: 'cooldown.clear-one' });

  sendJson(res, 200, { ok: true });
}
