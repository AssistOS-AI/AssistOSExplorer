/**
 * Management middleware routes.
 *
 * The backing table is `middleware_bindings` — a single scope/target
 * table for gateway, model, and provider middleware bindings.
 *
 * The management URL surface is preserved so the dashboard does not
 * need to change shape:
 *
 *   GET    /management/middlewares
 *   GET    /management/middlewares/:id
 *   PATCH  /management/middlewares/:id
 *   POST   /management/middlewares/rescan
 *
 *   POST   /management/middlewares/assignments
 *   PATCH  /management/middlewares/assignments/:assignmentId
 *   DELETE /management/middlewares/assignments/:assignmentId
 *
 *   GET    /management/tiers/:tierId/middlewares
 *   POST   /management/tiers/:tierId/middlewares
 *   PATCH  /management/tiers/:tierId/middlewares/:assignmentId
 *   DELETE /management/tiers/:tierId/middlewares/:assignmentId
 *   POST   /management/tiers/:tierId/middlewares/reorder
 *
 *   GET    /management/models/:modelId/middlewares
 *   POST   /management/models/:modelId/middlewares
 *   PATCH  /management/models/:modelId/middlewares/:assignmentId
 *   DELETE /management/models/:modelId/middlewares/:assignmentId
 *   POST   /management/models/:modelId/middlewares/reorder
 *
 * The `tierId` path parameter is the cascade model's UUID — tiers are
 * now cascade models so the URL stays the same but under the hood we
 * write a `scope='model'` binding with `target_id = <cascade model id>`.
 */

import { readJsonBody } from '../core/json-body.mjs';
import { sendJson } from '../core/responses.mjs';
import { BadRequestError } from '../core/errors.mjs';
import * as middlewaresDao from '../db/dao/middlewares-dao.mjs';
import * as bindingsDao from '../db/dao/middleware-bindings-dao.mjs';
import {
    performRuntimeRefresh,
    requestRuntimeRefresh,
} from '../runtime/registry/runtime-refresh.mjs';
import { sendNotFound } from './route-response-helpers.mjs';

// ── helpers ────────────────────────────────────────────────────────────

/**
 * Resolve a middlewareId (row id in `middlewares`) to its middleware_key.
 * The unified bindings table stores the key directly rather than an FK
 * to the middlewares table, so the management UI's "pick a middleware"
 * dropdown needs a lookup step.
 */
async function keyForMiddlewareId(pool, id) {
    const row = await middlewaresDao.findById(pool, id);
    return row?.middleware_key || null;
}

function shapeAssignmentRow(row) {
    // Legacy-compatible shape for the dashboard.  The UI reads
    // `assignment.middleware_key`, `assignment.settings`, etc.  Convert
    // unified binding row fields into that shape.
    return {
        id: row.id,
        middleware_key: row.middleware_key,
        scope: row.scope,
        target_id: row.target_id,
        sort_order: row.sort_order,
        enabled: row.enabled,
        settings: row.settings || {},
        created_at: row.created_at,
        updated_at: row.updated_at,
        // Compat fields so the dashboard can keep reading old names too
        ...(row.scope === 'model' ? { model_id: row.target_id } : {}),
        ...(row.scope === 'provider' ? { provider_id: row.target_id } : {}),
    };
}

// ── Catalog routes ──────────────────────────────────────────────────

export async function handleListMiddlewares(ctx) {
    const { res, appCtx } = ctx;
    const { pool } = appCtx;
    const catalog = await middlewaresDao.list(pool);
    sendJson(res, 200, { catalog });
}

export async function handleGetMiddleware(ctx) {
    const { res, params, appCtx } = ctx;
    const { pool } = appCtx;
    const row = await middlewaresDao.findById(pool, params.id);
    if (!row) {
        sendNotFound(res, 'Middleware');
        return;
    }
    sendJson(res, 200, { middleware: row });
}

export async function handleUpdateMiddleware(ctx) {
    const { req, res, params, appCtx } = ctx;
    const { pool } = appCtx;
    const body = await readJsonBody(req);
    if (!body || Object.keys(body).length === 0) {
        throw new BadRequestError('Empty update body');
    }
    const allowed = ['displayName', 'enabled', 'defaultSettings', 'metadata'];
    const fields = {};
    for (const k of allowed) if (body[k] !== undefined) fields[k] = body[k];

    const row = await middlewaresDao.update(pool, params.id, fields);
    if (!row) {
        sendNotFound(res, 'Middleware');
        return;
    }
    requestRuntimeRefresh(appCtx, {
        snapshot: true,
        reason: 'middleware.update',
    });
    sendJson(res, 200, { middleware: row });
}

export async function handleRescan(ctx) {
    const { res, appCtx } = ctx;
    const refresh = await performRuntimeRefresh(appCtx, {
        middlewareCatalog: true,
        snapshot: true,
        reason: 'middleware.rescan',
    });
    sendJson(res, 200, {
        ok: true,
        snapshotGeneration: refresh.snapshotGeneration,
        middlewareGeneration: refresh.middlewareGeneration,
        middlewareCount: refresh.middlewareCount,
    });
}

// ── Flat assignment routes ──────────────────────────────────────────

export async function handleCreateAssignment(ctx) {
    const { req, res, appCtx } = ctx;
    const { pool } = appCtx;
    const body = await readJsonBody(req);

    if (
        !body ||
        (!body.middlewareId && !body.middlewareKey) ||
        !body.targetType
    ) {
        throw new BadRequestError(
            'Missing required fields: middlewareId or middlewareKey, targetType'
        );
    }

    // Validate scope + target first so mis-shaped requests get a clear
    // 400 before we hit the DB.
    let scope;
    let targetId = null;
    if (body.targetType === 'gateway') {
        scope = 'gateway';
    } else if (body.targetType === 'tier') {
        if (!body.tierId && !body.modelId) {
            throw new BadRequestError('tierId required for tier assignment');
        }
        scope = 'model';
        targetId = body.tierId || body.modelId;
    } else if (body.targetType === 'model') {
        if (!body.modelId) {
            throw new BadRequestError('modelId required for model assignment');
        }
        scope = 'model';
        targetId = body.modelId;
    } else if (body.targetType === 'provider') {
        if (!body.providerId) {
            throw new BadRequestError(
                'providerId required for provider assignment'
            );
        }
        scope = 'provider';
        targetId = body.providerId;
    } else {
        throw new BadRequestError(`Unknown targetType: ${body.targetType}`);
    }

    // Resolve the middleware key. Clients can pass either `middlewareKey`
    // directly or `middlewareId`, which we look up in the middlewares
    // table. Test mocks that do not model that lookup fall back to using
    // the id as the key.
    let middlewareKey = body.middlewareKey || null;
    if (!middlewareKey && body.middlewareId) {
        middlewareKey =
            (await keyForMiddlewareId(pool, body.middlewareId)) ||
            body.middlewareId;
    }
    if (!middlewareKey) {
        throw new BadRequestError('Unknown middleware');
    }

    const row = await bindingsDao.create(pool, {
        scope,
        targetId,
        middlewareKey,
        sortOrder: body.sortOrder ?? 100,
        enabled: body.enabled ?? true,
        settings: body.settings ?? {},
    });

    requestRuntimeRefresh(appCtx, {
        snapshot: true,
        reason: 'middleware.assignment.create',
    });
    sendJson(res, 201, { assignment: shapeAssignmentRow(row) });
}

export async function handleUpdateAssignment(ctx) {
    const { req, res, params, appCtx } = ctx;
    const { pool } = appCtx;
    const body = await readJsonBody(req);
    if (!body || Object.keys(body).length === 0) {
        throw new BadRequestError('Empty update body');
    }
    const fields = {};
    if (body.sortOrder !== undefined) fields.sortOrder = body.sortOrder;
    if (body.enabled !== undefined) fields.enabled = body.enabled;
    if (body.settings !== undefined) fields.settings = body.settings;

    const row = await bindingsDao.update(pool, params.assignmentId, fields);
    if (!row) {
        sendNotFound(res, 'Assignment');
        return;
    }
    requestRuntimeRefresh(appCtx, {
        snapshot: true,
        reason: 'middleware.assignment.update',
    });
    sendJson(res, 200, { assignment: shapeAssignmentRow(row) });
}

export async function handleDeleteAssignment(ctx) {
    const { res, params, appCtx } = ctx;
    const { pool } = appCtx;
    const ok = await bindingsDao.del(pool, params.assignmentId);
    if (!ok) {
        sendNotFound(res, 'Assignment');
        return;
    }
    requestRuntimeRefresh(appCtx, {
        snapshot: true,
        reason: 'middleware.assignment.delete',
    });
    sendJson(res, 200, { ok: true });
}

// ── Tier-scoped middleware routes ───────────────────────────────────
//
// These remain under `/management/tiers/...` URLs so the dashboard's
// Tiers page keeps working unchanged.  Under the hood they bind to
// `scope='model'` with the cascade model id as target.

export async function handleListTierMiddlewares(ctx) {
    const { res, params, appCtx } = ctx;
    const { pool } = appCtx;
    const rows = await bindingsDao.listByTarget(pool, 'model', params.tierId);
    sendJson(res, 200, { data: rows.map(shapeAssignmentRow) });
}

export async function handleCreateTierMiddleware(ctx) {
    const { req, res, params, appCtx } = ctx;
    const { pool } = appCtx;
    const body = await readJsonBody(req);
    if (!body || !body.middlewareId) {
        throw new BadRequestError('Missing required field: middlewareId');
    }

    const middlewareKey =
        body.middlewareKey ||
        (await keyForMiddlewareId(pool, body.middlewareId));
    if (!middlewareKey) {
        throw new BadRequestError('Unknown middlewareId');
    }

    const row = await bindingsDao.create(pool, {
        scope: 'model',
        targetId: params.tierId,
        middlewareKey,
        sortOrder: body.sortOrder ?? 100,
        enabled: body.enabled ?? true,
        settings: body.settings ?? {},
    });

    requestRuntimeRefresh(appCtx, {
        snapshot: true,
        reason: 'middleware.tier.create',
    });
    sendJson(res, 201, { assignment: shapeAssignmentRow(row) });
}

export async function handleUpdateTierMiddleware(ctx) {
    return handleUpdateAssignment(ctx);
}

export async function handleDeleteTierMiddleware(ctx) {
    return handleDeleteAssignment(ctx);
}

export async function handleReorderTierMiddlewares(ctx) {
    const { req, res, params, appCtx } = ctx;
    const { pool } = appCtx;
    const body = await readJsonBody(req);
    if (!body || !Array.isArray(body.assignments)) {
        throw new BadRequestError('Expected assignments array');
    }
    await bindingsDao.reorder(pool, body.assignments);
    const rows = await bindingsDao.listByTarget(pool, 'model', params.tierId);
    requestRuntimeRefresh(appCtx, {
        snapshot: true,
        reason: 'middleware.tier.reorder',
    });
    sendJson(res, 200, { data: rows.map(shapeAssignmentRow) });
}

// ── Model-scoped middleware routes ─────────────────────────────────

export async function handleListModelMiddlewares(ctx) {
    const { res, params, appCtx } = ctx;
    const { pool } = appCtx;
    const rows = await bindingsDao.listByTarget(pool, 'model', params.modelId);
    sendJson(res, 200, { data: rows.map(shapeAssignmentRow) });
}

export async function handleCreateModelMiddleware(ctx) {
    const { req, res, params, appCtx } = ctx;
    const { pool } = appCtx;
    const body = await readJsonBody(req);
    if (!body || !body.middlewareId) {
        throw new BadRequestError('Missing required field: middlewareId');
    }

    const middlewareKey =
        body.middlewareKey ||
        (await keyForMiddlewareId(pool, body.middlewareId));
    if (!middlewareKey) {
        throw new BadRequestError('Unknown middlewareId');
    }

    const row = await bindingsDao.create(pool, {
        scope: 'model',
        targetId: params.modelId,
        middlewareKey,
        sortOrder: body.sortOrder ?? 100,
        enabled: body.enabled ?? true,
        settings: body.settings ?? {},
    });

    requestRuntimeRefresh(appCtx, {
        snapshot: true,
        reason: 'middleware.model.create',
    });
    sendJson(res, 201, { assignment: shapeAssignmentRow(row) });
}

export async function handleUpdateModelMiddleware(ctx) {
    return handleUpdateAssignment(ctx);
}

export async function handleDeleteModelMiddleware(ctx) {
    return handleDeleteAssignment(ctx);
}

export async function handleReorderModelMiddlewares(ctx) {
    const { req, res, params, appCtx } = ctx;
    const { pool } = appCtx;
    const body = await readJsonBody(req);
    if (!body || !Array.isArray(body.assignments)) {
        throw new BadRequestError('Expected assignments array');
    }
    await bindingsDao.reorder(pool, body.assignments);
    const rows = await bindingsDao.listByTarget(pool, 'model', params.modelId);
    requestRuntimeRefresh(appCtx, {
        snapshot: true,
        reason: 'middleware.model.reorder',
    });
    sendJson(res, 200, { data: rows.map(shapeAssignmentRow) });
}
