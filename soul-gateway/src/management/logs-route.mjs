/**
 * Management log routes.
 *
 * GET /management/logs
 * GET /management/logs/:logId
 */

import { sendJson } from '../core/responses.mjs';
import * as auditDao from '../db/dao/audit-logs-dao.mjs';
import { sendNotFound } from './route-response-helpers.mjs';

/**
 * GET /management/logs
 * Search audit logs with filters.
 *
 * Query params: soul_id, model, from, to, status, error_type, keyword,
 *               session_id, agent_name, api_key_id, limit, offset, sort, order
 */
export async function handleListLogs(ctx) {
  const { res, query, appCtx } = ctx;
  const { pool } = appCtx;

  const filters = {};
  if (query.soul_id)     filters.soulId = query.soul_id;
  if (query.model)       filters.model = query.model;
  if (query.from)        filters.from = query.from;
  if (query.to)          filters.to = query.to;
  if (query.status)      filters.status = query.status;
  if (query.error_type)  filters.errorType = query.error_type;
  if (query.keyword)     filters.keyword = query.keyword;
  if (query.session_id)  filters.sessionId = query.session_id;
  if (query.agent_name)  filters.agentName = query.agent_name;
  if (query.api_key_id)  filters.apiKeyId = query.api_key_id;

  const limit = Math.min(parseInt(query.limit, 10) || 50, 500);
  const offset = parseInt(query.offset, 10) || 0;
  const sort = query.sort || 'started_at';
  const order = query.order || 'DESC';

  const rows = await auditDao.query(pool, filters, { limit, offset, sort, order });
  const total = await auditDao.countByFilters(pool, filters);

  sendJson(res, 200, { data: rows, total, limit, offset });
}

/**
 * GET /management/logs/:logId
 * Fetch one audit log entry by request_id.
 */
export async function handleGetLog(ctx) {
  const { res, params, appCtx } = ctx;
  const { pool } = appCtx;

  const rows = await auditDao.findByRequestId(pool, params.logId);
  if (!rows || rows.length === 0) {
    sendNotFound(res, 'Log entry');
    return;
  }

  sendJson(res, 200, { log: rows[0] });
}
