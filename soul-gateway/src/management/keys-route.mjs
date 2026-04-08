/**
 * Management key routes.
 *
 * GET    /management/keys
 * POST   /management/keys
 * GET    /management/keys/:keyId
 * PATCH  /management/keys/:keyId
 * POST   /management/keys/:keyId/revoke
 * POST   /management/keys/:keyId/reset-daily-budget
 * GET    /management/keys/:keyId/spend
 */

import { readJsonBody } from '../core/json-body.mjs';
import { sendJson } from '../core/responses.mjs';
import { BadRequestError } from '../core/errors.mjs';
import { randomBytes } from 'node:crypto';
import * as keysDao from '../db/dao/api-keys-dao.mjs';
import { DEFAULTS } from '../config/defaults.mjs';
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

    // Strip sensitive fields before returning
    const data = keys.map(stripSensitiveFields);

    sendJson(res, 200, { data });
}

/**
 * POST /management/keys
 * Create a new API key.
 */
export async function handleCreateKey(ctx) {
    const { req, res, appCtx } = ctx;
    const { pool } = appCtx;
    const body = await readJsonBody(req);

    if (!body || !body.label) {
        throw new BadRequestError('Missing required field: label');
    }

    // Generate key value or use provided
    const plaintextKey =
        body.keyValue ||
        DEFAULTS.apiKeyPrefix + randomBytes(32).toString('hex');
    const keyHint = plaintextKey.slice(0, 8) + '...' + plaintextKey.slice(-4);

    // Hash and encrypt the key
    const { encrypt } = await import('../runtime/security/encryption.mjs');
    const { hashApiKey, derivePepper } = await import(
        '../runtime/security/api-key-auth.mjs'
    );

    const pepper = derivePepper(appCtx.config.env);
    const keyHash = hashApiKey(plaintextKey, pepper);

    const encryptionKey = (
        await import('../runtime/security/encryption.mjs')
    ).ensureEncryptionKey(appCtx.config.env);
    const {
        ciphertext: keyCiphertext,
        iv: keyIv,
        authTag: keyAuthTag,
    } = encrypt(plaintextKey, encryptionKey);

    const row = await keysDao.create(pool, {
        label: body.label,
        keyHash,
        keyCiphertext,
        keyIv,
        keyAuthTag,
        keyHint,
        rpmLimit: body.rpmLimit ?? 60,
        tpmLimit: body.tpmLimit ?? 100_000,
        dailyBudgetUsd: body.dailyBudgetUsd ?? null,
        monthlyBudgetUsd: body.monthlyBudgetUsd ?? null,
        expiresAt: body.expiresAt ?? null,
        metadata: body.metadata ?? {},
    });

    sendJson(res, 201, {
        key: stripSensitiveFields(row),
        plaintextKey,
    });
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
 */
export async function handleRevokeKey(ctx) {
    const { res, params, appCtx } = ctx;
    const { pool } = appCtx;

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
    const { key_hash, key_ciphertext, key_iv, key_auth_tag, ...safe } = row;
    return safe;
}
