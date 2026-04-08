/**
 * Management provider-middleware routes.
 *
 * Provider middleware is one ordered list per provider.  Each list
 * entry is a row in the unified `middleware_bindings` table scoped to
 * `target='provider'`.
 *
 * Endpoints:
 *
 *   GET    /management/backends                                            → list registered backend module keys
 *   GET    /management/provider-middlewares                                → list available provider middleware modules
 *   GET    /management/providers/:providerId/middlewares                   → list provider-scope bindings for a provider
 *   POST   /management/providers/:providerId/middlewares                   → create a provider-scope binding
 *   PATCH  /management/providers/:providerId/middlewares/:bindingId        → update a binding
 *   DELETE /management/providers/:providerId/middlewares/:bindingId        → delete a binding
 */

import { readJsonBody } from '../core/json-body.mjs';
import { sendJson } from '../core/responses.mjs';
import { BadRequestError } from '../core/errors.mjs';
import * as bindingsDao from '../db/dao/middleware-bindings-dao.mjs';
import { requestRuntimeRefresh } from '../runtime/registry/runtime-refresh.mjs';
import { sendNotFound } from './route-response-helpers.mjs';

/**
 * Reshape a `middleware_bindings` row into the canonical provider
 * middleware binding shape: a flat ordered entry with no phase column.
 */
function shapeProviderBinding(row) {
    return {
        id: row.id,
        provider_id: row.target_id,
        middleware_key: row.middleware_key,
        sort_order: row.sort_order,
        enabled: row.enabled,
        settings: row.settings || {},
        created_at: row.created_at,
        updated_at: row.updated_at,
    };
}

/**
 * GET /management/provider-middlewares
 * Returns the list of available provider middleware modules from the
 * native registry so the dashboard can render an assignment picker.
 */
export async function handleListProviderMiddlewares(ctx) {
    const { res, appCtx } = ctx;
    const registry = appCtx.services.providerMiddlewareRegistry;
    const middlewares = [];
    if (registry && typeof registry.listKeys === 'function') {
        for (const key of registry.listKeys()) {
            const mod = registry.get(key);
            if (!mod?.meta) continue;
            middlewares.push({
                key,
                name: mod.meta.name || key,
                description: mod.meta.description || '',
                version: mod.meta.version || '1.0.0',
                scope: 'provider',
                defaultSettings: mod.meta.defaultSettings || {},
            });
        }
    }
    sendJson(res, 200, { middlewares });
}

/**
 * GET /management/backends
 * Returns the registered backend module inventory from the backend
 * catalog.  Each backend is a terminal middleware that fulfills an
 * external request.
 */
export async function handleListBackends(ctx) {
    const { res, appCtx } = ctx;
    const catalog = appCtx.services.backendCatalog;
    const backends = [];
    if (catalog && typeof catalog.listKeys === 'function') {
        for (const key of catalog.listKeys()) {
            const backendModule = catalog.getBackend?.(key);
            backends.push({
                key,
                name: backendModule?.manifest?.displayName || key,
                kind: backendModule?.manifest?.kind || 'external_api',
            });
        }
    }
    sendJson(res, 200, { backends });
}

/**
 * GET /management/providers/:providerId/middlewares
 * Returns a flat ordered array of bindings.
 */
export async function handleListProviderMiddlewareBindings(ctx) {
    const { res, params, appCtx } = ctx;
    const { pool } = appCtx;
    const rows = await bindingsDao.listByTarget(
        pool,
        'provider',
        params.providerId
    );
    const bindings = rows
        .map(shapeProviderBinding)
        .sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0));
    sendJson(res, 200, { bindings });
}

/**
 * POST /management/providers/:providerId/middlewares
 */
export async function handleCreateProviderMiddlewareBinding(ctx) {
    const { req, res, params, appCtx } = ctx;
    const { pool } = appCtx;
    const body = await readJsonBody(req);

    const middlewareKey = body?.middlewareKey;
    if (!middlewareKey) {
        throw new BadRequestError('middlewareKey is required');
    }

    const row = await bindingsDao.create(pool, {
        scope: 'provider',
        targetId: params.providerId,
        middlewareKey,
        sortOrder: body.sortOrder ?? body.sort_order ?? 100,
        enabled: body.enabled ?? true,
        settings: body.settings || {},
    });

    requestRuntimeRefresh(appCtx, {
        snapshot: true,
        reason: 'provider.middleware.create',
    });
    sendJson(res, 201, { binding: shapeProviderBinding(row) });
}

/**
 * PATCH /management/providers/:providerId/middlewares/:bindingId
 */
export async function handleUpdateProviderMiddlewareBinding(ctx) {
    const { req, res, params, appCtx } = ctx;
    const { pool } = appCtx;
    const body = await readJsonBody(req);
    if (!body || Object.keys(body).length === 0) {
        throw new BadRequestError('Empty update body');
    }

    const fields = {};
    if (body.sortOrder !== undefined) fields.sortOrder = body.sortOrder;
    if (body.sort_order !== undefined) fields.sortOrder = body.sort_order;
    if (body.enabled !== undefined) fields.enabled = body.enabled;
    if (body.settings !== undefined) fields.settings = body.settings;

    const row = await bindingsDao.update(pool, params.bindingId, fields);
    if (!row) {
        sendNotFound(res, 'Binding');
        return;
    }

    requestRuntimeRefresh(appCtx, {
        snapshot: true,
        reason: 'provider.middleware.update',
    });
    sendJson(res, 200, { binding: shapeProviderBinding(row) });
}

/**
 * DELETE /management/providers/:providerId/middlewares/:bindingId
 */
export async function handleDeleteProviderMiddlewareBinding(ctx) {
    const { res, params, appCtx } = ctx;
    const { pool } = appCtx;
    const ok = await bindingsDao.del(pool, params.bindingId);
    if (!ok) {
        sendNotFound(res, 'Binding');
        return;
    }
    requestRuntimeRefresh(appCtx, {
        snapshot: true,
        reason: 'provider.middleware.delete',
    });
    sendJson(res, 200, { ok: true });
}
