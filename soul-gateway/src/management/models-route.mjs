/**
 * Management model routes.
 *
 * GET    /management/models
 * POST   /management/models
 * GET    /management/models/:modelId
 * PATCH  /management/models/:modelId
 * DELETE /management/models/:modelId
 * POST   /management/models/:modelId/enable
 * POST   /management/models/:modelId/disable
 */

import { readJsonBody } from '../core/json-body.mjs';
import { sendJson } from '../core/responses.mjs';
import { BadRequestError } from '../core/errors.mjs';
import * as modelsDao from '../db/dao/models-dao.mjs';
import * as providersDao from '../db/dao/providers-dao.mjs';
import { requestRuntimeRefresh } from '../runtime/registry/runtime-refresh.mjs';
import { PREDEFINED_MODEL_TAGS } from '../runtime/policy/model-metadata-classifier.mjs';
import { sendNotFound } from './route-response-helpers.mjs';

/**
 * GET /management/models
 */
export async function handleListModels(ctx) {
    const { res, query, appCtx } = ctx;
    const { pool } = appCtx;

    const enabled =
        query.enabled !== undefined ? query.enabled === 'true' : null;
    const limit = Math.min(parseInt(query.limit, 10) || 500, 1000);
    const offset = parseInt(query.offset, 10) || 0;

    const rows = await modelsDao.list(pool, {
        enabled,
        limit,
        offset,
    });
    const { enrichStoredModelRows } = await import(
        '../runtime/providers/auto-provisioner.mjs'
    );
    const enrichedRows = await enrichStoredModelRows(appCtx, rows);
    sendJson(res, 200, { data: enrichedRows });
}

/**
 * POST /management/models
 */
export async function handleCreateModel(ctx) {
    const { req, res, appCtx } = ctx;
    const { pool } = appCtx;
    const body = await readJsonBody(req);

    if (
        !body ||
        !body.modelKey ||
        !body.displayName ||
        !body.providerId ||
        !body.providerModelId
    ) {
        throw new BadRequestError(
            'Missing required fields: modelKey, displayName, providerId, providerModelId'
        );
    }

    const row = await modelsDao.create(pool, {
        modelKey: body.modelKey,
        displayName: body.displayName,
        providerId: body.providerId,
        providerModelId: body.providerModelId,
        enabled: body.enabled ?? true,
        concurrencyLimit: body.concurrencyLimit ?? 3,
        queueTimeoutMs: body.queueTimeoutMs ?? 60_000,
        requestTimeoutMs: body.requestTimeoutMs ?? 120_000,
        pricingMode: body.pricingMode ?? 'external_directory',
        inputPricePerMillion: body.inputPricePerMillion ?? null,
        outputPricePerMillion: body.outputPricePerMillion ?? null,
        requestPriceUsd: body.requestPriceUsd ?? null,
        tags: body.tags ?? [],
        capabilities: body.capabilities ?? {},
        metadata: body.metadata ?? {},
    });

    // Refresh runtime snapshot after mutation
    requestRuntimeRefresh(appCtx, { snapshot: true, reason: 'model.create' });

    sendJson(res, 201, { model: row });
}

/**
 * GET /management/models/:modelId
 */
export async function handleGetModel(ctx) {
    const { res, params, appCtx } = ctx;
    const { pool } = appCtx;

    const row = await modelsDao.findById(pool, params.modelId);
    if (!row) {
        sendNotFound(res, 'Model');
        return;
    }

    sendJson(res, 200, { model: row });
}

/**
 * PATCH /management/models/:modelId
 */
export async function handleUpdateModel(ctx) {
    const { req, res, params, appCtx } = ctx;
    const { pool } = appCtx;
    const body = await readJsonBody(req);

    if (!body || Object.keys(body).length === 0) {
        throw new BadRequestError('Empty update body');
    }

    const allowed = [
        'modelKey',
        'displayName',
        'providerId',
        'providerModelId',
        'enabled',
        'concurrencyLimit',
        'queueTimeoutMs',
        'requestTimeoutMs',
        'pricingMode',
        'inputPricePerMillion',
        'outputPricePerMillion',
        'requestPriceUsd',
        'rateLimitOverride',
        'budgetOverride',
        'loopOverride',
        'responseFilterOverride',
        'retryPolicy',
        'capabilities',
        'tags',
        'isFree',
        'metadata',
    ];

    const fields = {};
    for (const k of allowed) {
        if (body[k] !== undefined) fields[k] = body[k];
    }

    const row = await modelsDao.update(pool, params.modelId, fields);
    if (!row) {
        sendNotFound(res, 'Model');
        return;
    }

    // Refresh runtime snapshot after mutation
    requestRuntimeRefresh(appCtx, { snapshot: true, reason: 'model.update' });

    sendJson(res, 200, { model: row });
}

/**
 * DELETE /management/models/:modelId
 */
export async function handleDeleteModel(ctx) {
    const { res, params, appCtx } = ctx;
    const { pool } = appCtx;

    const ok = await modelsDao.del(pool, params.modelId);
    if (!ok) {
        sendNotFound(res, 'Model');
        return;
    }

    // Also clean up aliases
    const aliasDao = await import('../db/dao/model-aliases-dao.mjs');
    await aliasDao.deleteByModel(pool, params.modelId);

    // Refresh runtime snapshot after mutation
    requestRuntimeRefresh(appCtx, { snapshot: true, reason: 'model.delete' });

    sendJson(res, 200, { ok: true });
}

/**
 * POST /management/models/:modelId/enable
 */
export async function handleEnableModel(ctx) {
    const { res, params, appCtx } = ctx;
    const { pool } = appCtx;

    const row = await modelsDao.enable(pool, params.modelId);
    if (!row) {
        sendNotFound(res, 'Model');
        return;
    }

    // Refresh runtime snapshot after mutation
    requestRuntimeRefresh(appCtx, { snapshot: true, reason: 'model.enable' });

    sendJson(res, 200, { model: row });
}

/**
 * POST /management/models/:modelId/disable
 */
export async function handleDisableModel(ctx) {
    const { res, params, appCtx } = ctx;
    const { pool } = appCtx;

    const row = await modelsDao.disable(pool, params.modelId);
    if (!row) {
        sendNotFound(res, 'Model');
        return;
    }

    // Refresh runtime snapshot after mutation
    requestRuntimeRefresh(appCtx, { snapshot: true, reason: 'model.disable' });

    sendJson(res, 200, { model: row });
}

/**
 * GET /management/models/providers
 * List all configured providers so the Models page can recover even
 * when a provider has not seeded any model rows yet.
 */
export async function handleListModelProviders(ctx) {
    const { res, appCtx } = ctx;
    const { pool } = appCtx;

    const { rows } = await pool.query(
        `SELECT id AS provider_id, provider_key, display_name
     FROM providers
     WHERE enabled = true
     ORDER BY provider_key ASC`
    );
    sendJson(res, 200, { data: rows });
}

/**
 * GET /management/models/providers/:key/models
 * Discover models for a given provider key so the Models page can
 * recover from failed/partial registry sync.
 */
export async function handleListProviderModels(ctx) {
    const { res, params, appCtx } = ctx;
    const provider = await providersDao.findByKey(appCtx.pool, params.key);
    if (!provider) {
        sendJson(res, 200, { data: [] });
        return;
    }

    const {
        discoverProviderModels,
        enrichDiscoveryDescriptors,
        normalizeDiscoveryDescriptor,
    } = await import('../runtime/providers/auto-provisioner.mjs');
    const discoveries = await discoverProviderModels(appCtx, provider);
    const enrichedDiscoveries = await enrichDiscoveryDescriptors(
        appCtx,
        provider,
        discoveries
    );
    const rows = enrichedDiscoveries.map((discovery) => {
        const normalized = normalizeDiscoveryDescriptor(provider, discovery);
        return {
            provider_model_id: normalized.providerModelId,
            display_name: normalized.displayName,
            pricing_mode: normalized.pricingMode,
            input_price_per_million: normalized.inputPricePerMillion,
            output_price_per_million: normalized.outputPricePerMillion,
            request_price_usd: normalized.requestPriceUsd,
            is_free: normalized.isFree,
            capabilities: normalized.capabilities,
            tags: normalized.tags,
            metadata: normalized.metadata,
        };
    });

    sendJson(res, 200, { data: rows });
}

/**
 * GET /management/models/tags
 *
 * Returns the union of the curated `PREDEFINED_MODEL_TAGS` taxonomy and
 * the distinct tags actually stored on model rows, sorted alphabetically.
 * The union keeps the dashboard tag-filter vocabulary stable even when
 * no model row has been tagged yet (the pre-refactor behavior returned
 * only distinct stored tags, which left the filter empty on fresh DBs).
 */
export async function handleListModelTags(ctx) {
    const { res, appCtx } = ctx;
    const { pool } = appCtx;

    const { rows } = await pool.query(
        `SELECT DISTINCT json_each.value AS tag
     FROM models, json_each(models.tags)
     WHERE json_each.value IS NOT NULL AND json_each.value <> ''
     ORDER BY tag ASC`
    );
    const merged = new Set(PREDEFINED_MODEL_TAGS);
    for (const r of rows) {
        if (typeof r.tag === 'string' && r.tag.length > 0) {
            merged.add(r.tag);
        }
    }
    sendJson(res, 200, { data: [...merged].sort() });
}
