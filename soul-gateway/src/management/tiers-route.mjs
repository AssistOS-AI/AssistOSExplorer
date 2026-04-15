/**
 * Management tier routes.
 *
 * A tier is a dashboard management view over a cascade model stored in
 * `soul_gateway.models` plus its ordered children in
 * `soul_gateway.model_children`.
 *
 * URL surface:
 *
 *   GET    /management/tiers
 *   POST   /management/tiers
 *   GET    /management/tiers/:tierId
 *   PATCH  /management/tiers/:tierId
 *   DELETE /management/tiers/:tierId
 *   POST   /management/tiers/:tierId/enable
 *   POST   /management/tiers/:tierId/disable
 */

import { readJsonBody } from '../core/json-body.mjs';
import { sendJson } from '../core/responses.mjs';
import { BadRequestError } from '../core/errors.mjs';
import * as modelsDao from '../db/dao/models-dao.mjs';
import * as modelChildrenDao from '../db/dao/model-children-dao.mjs';
import * as modelAliasesDao from '../db/dao/model-aliases-dao.mjs';
import { requestRuntimeRefresh } from '../runtime/registry/runtime-refresh.mjs';
import { sendNotFound } from './route-response-helpers.mjs';

const DEFAULT_MAX_ATTEMPTS = 5;

const CREATE_FIELDS = new Set([
    'tierKey',
    'displayName',
    'enabled',
    'maxAttempts',
    'childModelIds',
]);

const UPDATE_FIELDS = new Set([
    'tierKey',
    'displayName',
    'enabled',
    'maxAttempts',
    'childModelIds',
]);

function assertBodyObject(body, operation) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
        throw new BadRequestError(`${operation} body must be a JSON object`);
    }
}

function assertAllowedFields(body, allowedFields, operation) {
    const unsupported = Object.keys(body).filter((key) => !allowedFields.has(key));
    if (unsupported.length > 0) {
        throw new BadRequestError(
            `Unsupported fields for ${operation}: ${unsupported.join(', ')}`
        );
    }
}

function requireNonEmptyString(value, fieldName) {
    if (typeof value !== 'string') {
        throw new BadRequestError(`${fieldName} must be a non-empty string`);
    }
    const trimmed = value.trim();
    if (!trimmed) {
        throw new BadRequestError(`${fieldName} must be a non-empty string`);
    }
    return trimmed;
}

function normalizeOptionalString(value, fieldName) {
    if (value === undefined) return undefined;
    return requireNonEmptyString(value, fieldName);
}

function normalizeBoolean(value, fieldName, fallback = undefined) {
    if (value === undefined) return fallback;
    if (typeof value !== 'boolean') {
        throw new BadRequestError(`${fieldName} must be a boolean`);
    }
    return value;
}

function normalizeMaxAttempts(value, { fallback } = {}) {
    if (value === undefined) return fallback;
    if (!Number.isInteger(value) || value <= 0) {
        throw new BadRequestError('maxAttempts must be a positive integer');
    }
    return value;
}

function normalizeChildModelIds(value) {
    if (value === undefined) return undefined;
    if (!Array.isArray(value)) {
        throw new BadRequestError('childModelIds must be an array');
    }

    const normalized = value.map((entry, index) => {
        if (typeof entry !== 'string') {
            throw new BadRequestError(
                `childModelIds[${index}] must be a model id string`
            );
        }
        const trimmed = entry.trim();
        if (!trimmed) {
            throw new BadRequestError(
                `childModelIds[${index}] must be a non-empty model id string`
            );
        }
        return trimmed;
    });

    if (new Set(normalized).size !== normalized.length) {
        throw new BadRequestError('childModelIds cannot contain duplicates');
    }

    return normalized;
}

async function loadTierRow(pool, tierId) {
    const row = await modelsDao.findById(pool, tierId);
    if (!row || row.strategy_kind !== 'cascade') {
        return null;
    }
    return row;
}

async function validateChildModels(pool, childModelIds, tierId = null) {
    for (const childModelId of childModelIds) {
        if (tierId && childModelId === tierId) {
            throw new BadRequestError('A tier cannot include itself as a child');
        }

        const child = await modelsDao.findById(pool, childModelId);
        if (!child) {
            throw new BadRequestError(`Child model not found: ${childModelId}`);
        }
        if (child.strategy_kind !== 'direct') {
            throw new BadRequestError(
                `Tier child models must be direct models: ${child.model_key}`
            );
        }
    }
}

function serializeTier(row, children) {
    return {
        id: row.id,
        tierKey: row.model_key,
        displayName: row.display_name,
        enabled: row.enabled,
        maxAttempts: row.max_attempts ?? DEFAULT_MAX_ATTEMPTS,
        children: (children || []).map((child) => ({
            bindingId: child.id,
            modelId: child.child_model_id,
            modelKey: child.child_model_key,
            displayName: child.child_display_name,
            enabled: child.child_enabled,
            priority: child.priority,
        })),
    };
}

async function loadSerializedTier(pool, tierId) {
    const row = await loadTierRow(pool, tierId);
    if (!row) return null;
    const children = await modelChildrenDao.listForParent(pool, tierId);
    return serializeTier(row, children);
}

export async function handleListTiers(ctx) {
    const { res, query, appCtx } = ctx;
    const { pool } = appCtx;

    const enabled =
        query.enabled !== undefined ? query.enabled === 'true' : null;
    const rows = await modelsDao.list(pool, { enabled, limit: 500, offset: 0 });

    const tiers = [];
    for (const row of rows) {
        if (row.strategy_kind !== 'cascade') continue;
        const children = await modelChildrenDao.listForParent(pool, row.id);
        tiers.push(serializeTier(row, children));
    }

    sendJson(res, 200, { data: tiers });
}

export async function handleCreateTier(ctx) {
    const { req, res, appCtx } = ctx;
    const { pool } = appCtx;
    const body = await readJsonBody(req);

    assertBodyObject(body, 'Tier create');
    assertAllowedFields(body, CREATE_FIELDS, 'tier create');

    const tierKey = requireNonEmptyString(body.tierKey, 'tierKey');
    const displayName = requireNonEmptyString(body.displayName, 'displayName');
    const enabled = normalizeBoolean(body.enabled, 'enabled', true);
    const maxAttempts = normalizeMaxAttempts(body.maxAttempts, {
        fallback: DEFAULT_MAX_ATTEMPTS,
    });
    const childModelIds = normalizeChildModelIds(body.childModelIds) || [];

    const existingByKey = await modelsDao.findByKey(pool, tierKey);
    if (existingByKey) {
        throw new BadRequestError(`Tier key already exists: ${tierKey}`);
    }

    await validateChildModels(pool, childModelIds);

    const { rows } = await pool.query(
        `INSERT INTO soul_gateway.models
       (model_key, display_name, enabled, strategy_kind, max_attempts)
     VALUES ($1, $2, $3, 'cascade', $4)
     RETURNING *`,
        [tierKey, displayName, enabled, maxAttempts]
    );
    const tier = rows[0];

    await modelChildrenDao.replaceChildren(
        pool,
        tier.id,
        childModelIds.map((childModelId, index) => ({
            childModelId,
            priority: index + 1,
            enabled: true,
        }))
    );

    const children = await modelChildrenDao.listForParent(pool, tier.id);
    requestRuntimeRefresh(appCtx, { snapshot: true, reason: 'tier.create' });
    sendJson(res, 201, { tier: serializeTier(tier, children) });
}

export async function handleGetTier(ctx) {
    const { res, params, appCtx } = ctx;
    const { pool } = appCtx;

    const tier = await loadSerializedTier(pool, params.tierId);
    if (!tier) {
        sendNotFound(res, 'Tier');
        return;
    }

    sendJson(res, 200, { tier });
}

export async function handleUpdateTier(ctx) {
    const { req, res, params, appCtx } = ctx;
    const { pool } = appCtx;
    const body = await readJsonBody(req);

    assertBodyObject(body, 'Tier update');
    if (Object.keys(body).length === 0) {
        throw new BadRequestError('Empty update body');
    }
    assertAllowedFields(body, UPDATE_FIELDS, 'tier update');

    const existing = await loadTierRow(pool, params.tierId);
    if (!existing) {
        sendNotFound(res, 'Tier');
        return;
    }

    const fields = {};

    const tierKey = normalizeOptionalString(body.tierKey, 'tierKey');
    if (tierKey !== undefined) {
        const conflicting = await modelsDao.findByKey(pool, tierKey);
        if (conflicting && conflicting.id !== params.tierId) {
            throw new BadRequestError(`Tier key already exists: ${tierKey}`);
        }
        fields.modelKey = tierKey;
    }

    const displayName = normalizeOptionalString(body.displayName, 'displayName');
    if (displayName !== undefined) {
        fields.displayName = displayName;
    }

    const enabled = normalizeBoolean(body.enabled, 'enabled');
    if (enabled !== undefined) {
        fields.enabled = enabled;
    }

    const maxAttempts = normalizeMaxAttempts(body.maxAttempts);
    if (maxAttempts !== undefined) {
        fields.maxAttempts = maxAttempts;
    }

    const childModelIds = normalizeChildModelIds(body.childModelIds);
    if (childModelIds !== undefined) {
        await validateChildModels(pool, childModelIds, params.tierId);
        await modelChildrenDao.replaceChildren(
            pool,
            params.tierId,
            childModelIds.map((childModelId, index) => ({
                childModelId,
                priority: index + 1,
                enabled: true,
            }))
        );
    }

    const updated =
        Object.keys(fields).length > 0
            ? await modelsDao.update(pool, params.tierId, fields)
            : existing;

    const children = await modelChildrenDao.listForParent(pool, params.tierId);
    requestRuntimeRefresh(appCtx, { snapshot: true, reason: 'tier.update' });
    sendJson(res, 200, { tier: serializeTier(updated, children) });
}

export async function handleDeleteTier(ctx) {
    const { res, params, appCtx } = ctx;
    const { pool } = appCtx;

    const existing = await loadTierRow(pool, params.tierId);
    if (!existing) {
        sendNotFound(res, 'Tier');
        return;
    }

    await pool.query(
        `DELETE FROM soul_gateway.middleware_bindings
     WHERE scope = $1 AND target_id = $2`,
        ['model', params.tierId]
    );
    await modelAliasesDao.deleteByModel(pool, params.tierId);
    await modelsDao.del(pool, params.tierId);

    requestRuntimeRefresh(appCtx, { snapshot: true, reason: 'tier.delete' });
    sendJson(res, 200, { ok: true });
}

export async function handleEnableTier(ctx) {
    const { res, params, appCtx } = ctx;
    const { pool } = appCtx;

    const existing = await loadTierRow(pool, params.tierId);
    if (!existing) {
        sendNotFound(res, 'Tier');
        return;
    }

    const updated = await modelsDao.enable(pool, params.tierId);
    const children = await modelChildrenDao.listForParent(pool, params.tierId);
    requestRuntimeRefresh(appCtx, { snapshot: true, reason: 'tier.enable' });
    sendJson(res, 200, { tier: serializeTier(updated, children) });
}

export async function handleDisableTier(ctx) {
    const { res, params, appCtx } = ctx;
    const { pool } = appCtx;

    const existing = await loadTierRow(pool, params.tierId);
    if (!existing) {
        sendNotFound(res, 'Tier');
        return;
    }

    const updated = await modelsDao.disable(pool, params.tierId);
    const children = await modelChildrenDao.listForParent(pool, params.tierId);
    requestRuntimeRefresh(appCtx, { snapshot: true, reason: 'tier.disable' });
    sendJson(res, 200, { tier: serializeTier(updated, children) });
}
