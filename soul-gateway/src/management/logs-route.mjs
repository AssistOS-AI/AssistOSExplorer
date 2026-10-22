/**
 * Management log routes.
 *
 * GET /management/logs
 * GET /management/logs/keys
 * GET /management/logs/:logId
 */

import { sendJson } from '../core/responses.mjs';
import * as keysDao from '../db/dao/api-keys-dao.mjs';
import * as auditDao from '../db/dao/audit-logs-dao.mjs';
import { sendNotFound } from './route-response-helpers.mjs';

function hasValue(value) {
    return (
        value !== undefined &&
        value !== null &&
        value !== '' &&
        value !== 'undefined' &&
        value !== 'null'
    );
}

/**
 * GET /management/logs
 * Search audit logs with filters.
 *
 * Query params: soul_id, model, from, to, status, error_type, keyword,
 *               session_id, api_key_id, limit, offset, sort, order
 */
export async function handleListLogs(ctx) {
    const { res, query, appCtx } = ctx;
    const { pool } = appCtx;

    const filters = {};
    if (hasValue(query.soul_id)) filters.soulId = query.soul_id;
    if (hasValue(query.model)) filters.model = query.model;
    if (hasValue(query.from)) filters.from = query.from;
    if (hasValue(query.to)) filters.to = query.to;
    if (hasValue(query.status)) filters.status = query.status;
    if (hasValue(query.error_type)) filters.errorType = query.error_type;
    if (hasValue(query.keyword)) filters.keyword = query.keyword;
    if (hasValue(query.session_id)) filters.sessionId = query.session_id;
    if (hasValue(query.api_key_id)) filters.apiKeyId = query.api_key_id;

    const limit = Math.min(parseInt(query.limit, 10) || 50, 500);
    const offset = parseInt(query.offset, 10) || 0;
    const sort = query.sort || 'started_at';
    const order = query.order || 'DESC';

    const [rows, total] = await Promise.all([
        auditDao.query(pool, filters, {
            limit,
            offset,
            sort,
            order,
        }),
        auditDao.countByFilters(pool, filters),
    ]);

    sendJson(res, 200, { data: rows, total, limit, offset });
}

/**
 * GET /management/logs/keys
 * Summarize logs by API key for the selected time window.
 */
export async function handleListLogKeys(ctx) {
    const { res, query, appCtx } = ctx;
    const { pool } = appCtx;

    const filters = {};
    if (hasValue(query.soul_id)) filters.soulId = query.soul_id;
    if (hasValue(query.model)) filters.model = query.model;
    if (hasValue(query.from)) filters.from = query.from;
    if (hasValue(query.to)) filters.to = query.to;
    if (hasValue(query.status)) filters.status = query.status;
    if (hasValue(query.error_type)) filters.errorType = query.error_type;
    if (hasValue(query.keyword)) filters.keyword = query.keyword;
    if (hasValue(query.session_id)) filters.sessionId = query.session_id;

    const rows = await auditDao.summarizeByApiKey(pool, filters);
    sendJson(res, 200, { data: rows.map(stripInternalKeySummaryFields) });
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

function stripInternalKeySummaryFields(row) {
    if (!row) return row;
    const { subject_id, subject_type, ...safe } = row;
    const missingLabel = safe.key_label || (
        safe.api_key_id ? 'Missing key' : 'Unknown key'
    );
    const missingJoinedKey = (
        !subject_id &&
        !subject_type &&
        !safe.key_hint &&
        safe.key_status === 'unknown' &&
        (safe.key_label === 'Missing key' || safe.key_label === 'Unknown key')
    );
    const display = keysDao.buildSafeKeyDisplay(missingJoinedKey ? null : {
        id: safe.api_key_id,
        label: safe.key_label,
        key_label: safe.key_label,
        key_hint: safe.key_hint,
        status: safe.key_status,
        key_status: safe.key_status,
        subject_id,
        subject_type,
    }, {
        missingLabel,
    });
    return { ...safe, ...display };
}
