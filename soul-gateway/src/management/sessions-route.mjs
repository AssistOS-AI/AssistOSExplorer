/**
 * Management session routes.
 *
 * GET /management/sessions
 * GET /management/sessions/:sessionId
 * GET /management/sessions/:sessionId/logs
 * GET /management/agents/tree
 */

import { sendJson } from '../core/responses.mjs';
import * as sessionsDao from '../db/dao/sessions-dao.mjs';
import * as sessionStateDao from '../db/dao/session-state-dao.mjs';
import * as auditDao from '../db/dao/audit-logs-dao.mjs';
import { sendNotFound } from './route-response-helpers.mjs';

/**
 * GET /management/sessions
 * Browse grouped sessions with filters.
 */
export async function handleListSessions(ctx) {
  const { res, query, appCtx } = ctx;
  const { pool } = appCtx;

  const limit = Math.min(parseInt(query.limit, 10) || 50, 500);
  const offset = parseInt(query.offset, 10) || 0;
  const status = query.status || null;

  const rows = await sessionsDao.listRecent(pool, { limit, offset, status });
  sendJson(res, 200, { data: rows });
}

/**
 * GET /management/sessions/:sessionId
 * Session detail with state and recent logs.
 */
export async function handleGetSession(ctx) {
  const { res, params, appCtx } = ctx;
  const { pool } = appCtx;

  const session = await sessionsDao.findById(pool, params.sessionId);
  if (!session) {
    sendNotFound(res, 'Session');
    return;
  }

  const state = await sessionStateDao.findBySessionId(pool, params.sessionId);
  const logs = await auditDao.query(pool, { sessionId: params.sessionId }, { limit: 50, sort: 'started_at', order: 'DESC' });

  sendJson(res, 200, { session, state, logs });
}

/**
 * GET /management/sessions/:sessionId/logs
 * Dedicated log listing for a single session.
 */
export async function handleGetSessionLogs(ctx) {
  const { res, params, query, appCtx } = ctx;
  const { pool } = appCtx;

  const session = await sessionsDao.findById(pool, params.sessionId);
  if (!session) {
    sendNotFound(res, 'Session');
    return;
  }

  const limit = Math.min(parseInt(query.limit, 10) || 100, 500);
  const offset = parseInt(query.offset, 10) || 0;
  const logs = await auditDao.query(pool, { sessionId: params.sessionId }, {
    limit,
    offset,
    sort: 'started_at',
    order: 'DESC',
  });

  sendJson(res, 200, { sessionId: params.sessionId, data: logs });
}

/**
 * GET /management/agents/tree
 * Souls -> agents -> sessions hierarchy.
 */
export async function handleAgentsTree(ctx) {
  const { res, query, appCtx } = ctx;
  const { pool } = appCtx;

  const from = query.from || null;
  const to = query.to || null;

  // Query distinct agent_name -> session groups
  let sql = `
    SELECT soul_id, agent_name, COUNT(*) AS session_count,
           MAX(last_activity_at) AS last_activity
    FROM soul_gateway.sessions
  `;
  const params = [];
  const conditions = [];
  let idx = 1;

  if (from) {
    conditions.push(`started_at >= $${idx++}`);
    params.push(from);
  }
  if (to) {
    conditions.push(`started_at <= $${idx++}`);
    params.push(to);
  }

  if (conditions.length > 0) {
    sql += ` WHERE ${conditions.join(' AND ')}`;
  }

  sql += ' GROUP BY soul_id, agent_name ORDER BY last_activity DESC';

  const { rows } = await pool.query(sql, params);

  // Build tree: group by soul_id
  const tree = {};
  for (const row of rows) {
    const soulId = row.soul_id || '__unknown__';
    if (!tree[soulId]) {
      tree[soulId] = { soulId, agents: [] };
    }
    tree[soulId].agents.push({
      agentName: row.agent_name,
      sessionCount: parseInt(row.session_count, 10),
      lastActivity: row.last_activity,
    });
  }

  sendJson(res, 200, { data: Object.values(tree) });
}
