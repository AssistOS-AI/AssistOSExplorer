/**
 * Management key routes.
 *
 * GET    /management/keys
 * GET    /management/keys/:keyId
 * PATCH  /management/keys/:keyId
 * POST   /management/keys/:keyId/revoke
 * POST   /management/keys/:keyId/reset-daily-budget
 * GET    /management/keys/:keyId/spend
 */

import { readJsonBody } from '../core/json-body.mjs';
import { sendJson } from '../core/responses.mjs';
import { BadRequestError } from '../core/errors.mjs';
import * as keysDao from '../db/dao/api-keys-dao.mjs';
import { sendNotFound } from './route-response-helpers.mjs';

/**
 * GET /management/keys
 * List API keys with current spend info.
 */
export async function handleListKeys(ctx) {
    const { res, query, appCtx } = ctx;
    const { pool } = appCtx;

    const status = query.status || null;
    const limit = Math.min(parseInt(query.limit, 10) || 100, 500);
    const offset = parseInt(query.offset, 10) || 0;

    const keys = await keysDao.list(pool, { status, limit, offset });

    // Strip sensitive fields before returning. Signed-subject rows are the only
    // api_keys rows; there is no synthetic workspace-default key to inject.
    const data = keys.map(stripSensitiveFields);

    sendJson(res, 200, { data });
}

/**
 * GET /management/keys/:keyId
 */
export async function handleGetKey(ctx) {
    const { res, params, appCtx } = ctx;
    const { pool } = appCtx;

    const row = await keysDao.findById(pool, params.keyId);
    if (!row) {
        sendNotFound(res, 'Key');
        return;
    }

    sendJson(res, 200, { key: stripSensitiveFields(row) });
}

/**
 * PATCH /management/keys/:keyId
 */
export async function handleUpdateKey(ctx) {
    const { req, res, params, appCtx } = ctx;
    const { pool } = appCtx;
    const body = await readJsonBody(req);

    if (!body || Object.keys(body).length === 0) {
        throw new BadRequestError('Empty update body');
    }

    // Only allow safe fields
    const allowed = [
        'label',
        'rpmLimit',
        'tpmLimit',
        'dailyBudgetUsd',
        'monthlyBudgetUsd',
        'expiresAt',
        'metadata',
    ];
    const fields = {};
    for (const k of allowed) {
        if (body[k] !== undefined) fields[k] = body[k];
    }

    const row = await keysDao.update(pool, params.keyId, fields);
    if (!row) {
        sendNotFound(res, 'Key');
        return;
    }

    sendJson(res, 200, { key: stripSensitiveFields(row) });
}

/**
 * POST /management/keys/:keyId/revoke
 *
 * Agent keys (subject_type === 'agent') are provisioned by Ploinky discovery
 * and cannot be revoked; access is governed by limits/budget/expiry instead.
 * User keys may be revoked.
 */
export async function handleRevokeKey(ctx) {
    const { res, params, appCtx } = ctx;
    const { pool } = appCtx;

    const existing = await keysDao.findById(pool, params.keyId);
    if (!existing) {
        sendNotFound(res, 'Key');
        return;
    }
    if (existing.subject_type === 'agent') {
        sendJson(res, 409, {
            error: {
                message:
                    'Agent keys cannot be revoked. Adjust limits, budget, or expiry instead.',
                type: 'conflict',
            },
        });
        return;
    }

    const row = await keysDao.revoke(pool, params.keyId);
    if (!row) {
        sendNotFound(res, 'Key');
        return;
    }

    sendJson(res, 200, { key: stripSensitiveFields(row) });
}

/**
 * POST /management/keys/:keyId/reset-daily-budget
 * Zero out cached daily spend state for the key.
 */
export async function handleResetDailyBudget(ctx) {
    const { res, params, appCtx } = ctx;

    // Clear from spend cache if available
    if (appCtx.services.spendCache) {
        appCtx.services.spendCache.clearForKey(params.keyId);
    }

    sendJson(res, 200, { ok: true, keyId: params.keyId });
}

/**
 * GET /management/keys/:keyId/spend
 * Current daily and monthly spend.
 */
export async function handleGetSpend(ctx) {
    const { res, params, appCtx } = ctx;

    let dailySpendUsd = 0;
    let monthlySpendUsd = 0;

    if (appCtx.services.spendCache) {
        const spend = appCtx.services.spendCache.getForKey(params.keyId);
        dailySpendUsd = spend?.dailySpendUsd ?? 0;
        monthlySpendUsd = spend?.monthlySpendUsd ?? 0;
    }

    sendJson(res, 200, {
        dailySpendUsd,
        monthlySpendUsd,
        asOf: new Date().toISOString(),
    });
}

// ── helpers ──────────────────────────────────────────────────────────

function stripSensitiveFields(row) {
    if (!row) return row;
    const { key_hash, ...safe } = row;
    return safe;
}
