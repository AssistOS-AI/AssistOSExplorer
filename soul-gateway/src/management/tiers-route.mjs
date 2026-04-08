/**
 * Management tier routes.
 *
 * A tier is a model with `strategy_kind = 'cascade'`. This route keeps
 * the dashboard's `/management/tiers` surface backed by `models` +
 * `model_children`.
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
 *
 * Where `tierId` is the cascade model's UUID.
 */

import { readJsonBody } from '../core/json-body.mjs';
import { sendJson } from '../core/responses.mjs';
import { BadRequestError } from '../core/errors.mjs';
import * as modelsDao from '../db/dao/models-dao.mjs';
import * as modelChildrenDao from '../db/dao/model-children-dao.mjs';
import { requestRuntimeRefresh } from '../runtime/registry/runtime-refresh.mjs';
import { sendNotFound } from './route-response-helpers.mjs';

// ── helpers ────────────────────────────────────────────────────────────

/**
 * Load cascade models from the DB in the dashboard tier response shape:
 *   { id, tier_key, display_name, description, max_model_attempts,
 *     enabled, metadata, rate_limit_override, ..., models: [{ ... }] }
 */
async function loadCascadeRow(pool, id) {
    const row = await modelsDao.findById(pool, id);
    if (!row || row.strategy_kind !== 'cascade') return null;
    const children = await modelChildrenDao.listForParent(pool, id);
    return reshape(row, children);
}

function reshape(row, children) {
    return {
        id: row.id,
        tier_key: row.model_key,
        display_name: row.display_name,
        description: row.description ?? null,
        max_model_attempts: row.max_attempts ?? 5,
        enabled: row.enabled,
        rate_limit_override: row.rate_limit_override || {},
        budget_override: row.budget_override || {},
        loop_override: row.loop_override || {},
        response_filter_override: row.response_filter_override || {},
        metadata: row.metadata || {},
        models: (children || []).map((c) => ({
            id: c.id,
            tier_id: c.parent_model_id,
            model_id: c.child_model_id,
            model_key: c.child_model_key,
            model_display_name: c.child_display_name,
            priority: c.priority,
            enabled: c.enabled,
            settings: c.settings,
        })),
    };
}

// ── routes ─────────────────────────────────────────────────────────────

/**
 * GET /management/tiers
 */
export async function handleListTiers(ctx) {
    const { res, query, appCtx } = ctx;
    const { pool } = appCtx;

    const enabled =
        query.enabled !== undefined ? query.enabled === 'true' : null;
    const models = await modelsDao.list(pool, {
        enabled,
        limit: 500,
        offset: 0,
    });

    const data = [];
    for (const row of models) {
        if (row.strategy_kind !== 'cascade') continue;
        const children = await modelChildrenDao.listForParent(pool, row.id);
        data.push(reshape(row, children));
    }

    sendJson(res, 200, { data });
}

/**
 * POST /management/tiers
 *
 * Creates a cascade model.  Body:
 *   { tierKey, displayName, description?, maxModelAttempts?, enabled?,
 *     metadata?, models?: [{ modelId, priority, settings? }] }
 */
export async function handleCreateTier(ctx) {
    const { req, res, appCtx } = ctx;
    const { pool } = appCtx;
    const body = await readJsonBody(req);

    if (!body || !body.tierKey || !body.displayName) {
        throw new BadRequestError(
            'Missing required fields: tierKey, displayName'
        );
    }

    // Cascade models have no provider/provider_model_id — those columns
    // are nullable after the F2 migration. models-dao.create still
    // requires them, so go through a thin direct insert.
    const { rows } = await pool.query(
        `INSERT INTO soul_gateway.models
       (model_key, display_name, strategy_kind, max_attempts,
        enabled, rate_limit_override, budget_override, loop_override,
        response_filter_override, metadata)
     VALUES ($1, $2, 'cascade', $3, $4, $5, $6, $7, $8, $9)
     RETURNING *`,
        [
            body.tierKey,
            body.displayName,
            body.maxModelAttempts ?? 5,
            body.enabled ?? true,
            JSON.stringify(body.rateLimitOverride || {}),
            JSON.stringify(body.budgetOverride || {}),
            JSON.stringify(body.loopOverride || {}),
            JSON.stringify(body.responseFilterOverride || {}),
            JSON.stringify({
                ...(body.metadata || {}),
                ...(body.description ? { description: body.description } : {}),
            }),
        ]
    );
    const cascade = rows[0];

    if (Array.isArray(body.models)) {
        for (const m of body.models) {
            await modelChildrenDao.create(pool, {
                parentModelId: cascade.id,
                childModelId: m.modelId,
                priority: m.priority,
                settings: m.settings ?? {},
            });
        }
    }

    const children = await modelChildrenDao.listForParent(pool, cascade.id);

    requestRuntimeRefresh(appCtx, { snapshot: true, reason: 'tier.create' });

    sendJson(res, 201, { tier: reshape(cascade, children) });
}

/**
 * GET /management/tiers/:tierId
 */
export async function handleGetTier(ctx) {
    const { res, params, appCtx } = ctx;
    const { pool } = appCtx;

    const tier = await loadCascadeRow(pool, params.tierId);
    if (!tier) {
        sendNotFound(res, 'Tier');
        return;
    }
    sendJson(res, 200, { tier });
}

/**
 * PATCH /management/tiers/:tierId
 */
export async function handleUpdateTier(ctx) {
    const { req, res, params, appCtx } = ctx;
    const { pool } = appCtx;
    const body = await readJsonBody(req);

    if (!body || Object.keys(body).length === 0) {
        throw new BadRequestError('Empty update body');
    }

    // Verify it's a cascade model before we touch anything
    const existing = await modelsDao.findById(pool, params.tierId);
    if (!existing || existing.strategy_kind !== 'cascade') {
        sendNotFound(res, 'Tier');
        return;
    }

    const fields = {};
    if (body.displayName !== undefined) fields.displayName = body.displayName;
    if (body.maxModelAttempts !== undefined)
        fields.maxAttempts = body.maxModelAttempts;
    if (body.enabled !== undefined) fields.enabled = body.enabled;
    if (body.rateLimitOverride !== undefined)
        fields.rateLimitOverride = body.rateLimitOverride;
    if (body.budgetOverride !== undefined)
        fields.budgetOverride = body.budgetOverride;
    if (body.loopOverride !== undefined)
        fields.loopOverride = body.loopOverride;
    if (body.responseFilterOverride !== undefined)
        fields.responseFilterOverride = body.responseFilterOverride;
    if (body.metadata !== undefined) fields.metadata = body.metadata;

    const updated =
        Object.keys(fields).length > 0
            ? await modelsDao.update(pool, params.tierId, fields)
            : existing;

    if (Array.isArray(body.models)) {
        await modelChildrenDao.replaceChildren(
            pool,
            params.tierId,
            body.models.map((m) => ({
                childModelId: m.modelId,
                priority: m.priority,
                enabled: m.enabled ?? true,
                settings: m.settings ?? {},
            }))
        );
    }

    const children = await modelChildrenDao.listForParent(pool, params.tierId);

    requestRuntimeRefresh(appCtx, { snapshot: true, reason: 'tier.update' });

    sendJson(res, 200, { tier: reshape(updated, children) });
}

/**
 * DELETE /management/tiers/:tierId
 */
export async function handleDeleteTier(ctx) {
    const { res, params, appCtx } = ctx;
    const { pool } = appCtx;

    const existing = await modelsDao.findById(pool, params.tierId);
    if (!existing || existing.strategy_kind !== 'cascade') {
        sendNotFound(res, 'Tier');
        return;
    }

    // ON DELETE CASCADE on model_children removes the child rows
    // automatically.  middleware_bindings with target_id = this model's
    // id are NOT FK-linked, so clean them up explicitly.
    await pool.query(
        'DELETE FROM soul_gateway.middleware_bindings WHERE scope = $1 AND target_id = $2',
        ['model', params.tierId]
    );
    await modelsDao.del(pool, params.tierId);

    requestRuntimeRefresh(appCtx, { snapshot: true, reason: 'tier.delete' });
    sendJson(res, 200, { ok: true });
}

/**
 * POST /management/tiers/:tierId/enable
 */
export async function handleEnableTier(ctx) {
    const { res, params, appCtx } = ctx;
    const { pool } = appCtx;

    const existing = await modelsDao.findById(pool, params.tierId);
    if (!existing || existing.strategy_kind !== 'cascade') {
        sendNotFound(res, 'Tier');
        return;
    }
    const updated = await modelsDao.enable(pool, params.tierId);
    const children = await modelChildrenDao.listForParent(pool, params.tierId);

    requestRuntimeRefresh(appCtx, { snapshot: true, reason: 'tier.enable' });
    sendJson(res, 200, { tier: reshape(updated, children) });
}

/**
 * POST /management/tiers/:tierId/disable
 */
export async function handleDisableTier(ctx) {
    const { res, params, appCtx } = ctx;
    const { pool } = appCtx;

    const existing = await modelsDao.findById(pool, params.tierId);
    if (!existing || existing.strategy_kind !== 'cascade') {
        sendNotFound(res, 'Tier');
        return;
    }
    const updated = await modelsDao.disable(pool, params.tierId);
    const children = await modelChildrenDao.listForParent(pool, params.tierId);

    requestRuntimeRefresh(appCtx, { snapshot: true, reason: 'tier.disable' });
    sendJson(res, 200, { tier: reshape(updated, children) });
}
