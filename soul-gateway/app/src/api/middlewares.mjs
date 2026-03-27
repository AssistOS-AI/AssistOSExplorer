import { readJsonBody, sendJson, sendError } from '../utils/http-helpers.mjs';
import * as mwDao from '../db/middlewares-dao.mjs';
import { scanMiddlewares } from '../pipeline/middleware-loader.mjs';

export const handleMiddlewares = {
  // GET /api/v1/middlewares
  async list(req, res) {
    const middlewares = await mwDao.listMiddlewares();
    sendJson(res, middlewares);
  },

  // GET /api/v1/middlewares/:id
  async get(req, res, params) {
    const mw = await mwDao.getMiddlewareById(params.id);
    if (!mw) return sendError(res, 404, 'Middleware not found');
    sendJson(res, mw);
  },

  // PUT /api/v1/middlewares/:id
  async update(req, res, params) {
    const body = await readJsonBody(req);
    const mw = await mwDao.updateMiddleware(params.id, body);
    if (!mw) return sendError(res, 404, 'Middleware not found');
    sendJson(res, mw);
  },

  // POST /api/v1/middlewares/rescan
  async rescan(req, res) {
    const discovered = await scanMiddlewares();
    sendJson(res, { discovered, count: discovered.length });
  },

  // GET /api/v1/tiers/:id/middlewares
  async tierMiddlewares(req, res, params) {
    const list = await mwDao.getModelMiddlewares(params.id);
    sendJson(res, list);
  },

  // POST /api/v1/tiers/:id/middlewares
  async assignToTier(req, res, params) {
    const body = await readJsonBody(req);
    if (!body?.middleware_id) return sendError(res, 400, 'middleware_id required');
    try {
      const result = await mwDao.assignMiddlewareToModel(params.id, body.middleware_id, {
        is_enabled: body.is_enabled ?? true,
        sort_order: body.sort_order ?? 100,
        settings: body.settings || {},
      });
      sendJson(res, result, 201);
    } catch (err) {
      if (err.code === '23505') return sendError(res, 409, 'Middleware already assigned to this tier');
      throw err;
    }
  },

  // PUT /api/v1/tiers/:id/middlewares/:mwId
  async updateTierMiddleware(req, res, params) {
    const body = await readJsonBody(req);
    const result = await mwDao.updateModelMiddleware(params.mwId, body);
    if (!result) return sendError(res, 404, 'Tier-middleware assignment not found');
    sendJson(res, result);
  },

  // DELETE /api/v1/tiers/:id/middlewares/:mwId
  async removeTierMiddleware(req, res, params) {
    const result = await mwDao.removeModelMiddleware(params.mwId);
    if (!result) return sendError(res, 404, 'Not found');
    sendJson(res, { ok: true });
  },

  // PUT /api/v1/tiers/:id/middlewares/reorder
  async reorder(req, res, params) {
    const body = await readJsonBody(req);
    if (!Array.isArray(body?.ordered_ids)) return sendError(res, 400, 'ordered_ids array required');
    await mwDao.reorderModelMiddlewares(params.id, body.ordered_ids);
    const list = await mwDao.getModelMiddlewares(params.id);
    sendJson(res, list);
  },

  // --- Model-middleware endpoints ---

  // GET /api/v1/models/:id/middlewares
  async modelMiddlewares(req, res, params) {
    const list = await mwDao.getModelMiddlewares(params.id);
    sendJson(res, list);
  },

  // POST /api/v1/models/:id/middlewares
  async assignToModel(req, res, params) {
    const body = await readJsonBody(req);
    if (!body?.middleware_id) return sendError(res, 400, 'middleware_id required');
    try {
      const result = await mwDao.assignMiddlewareToModel(params.id, body.middleware_id, {
        is_enabled: body.is_enabled ?? true,
        sort_order: body.sort_order ?? 100,
        settings: body.settings || {},
      });
      sendJson(res, result, 201);
    } catch (err) {
      if (err.code === '23505') return sendError(res, 409, 'Middleware already assigned to this model');
      throw err;
    }
  },

  // PUT /api/v1/models/:id/middlewares/:mwId
  async updateModelMiddleware(req, res, params) {
    const body = await readJsonBody(req);
    const result = await mwDao.updateModelMiddleware(params.mwId, body);
    if (!result) return sendError(res, 404, 'Model-middleware assignment not found');
    sendJson(res, result);
  },

  // DELETE /api/v1/models/:id/middlewares/:mwId
  async removeModelMiddleware(req, res, params) {
    const result = await mwDao.removeModelMiddleware(params.mwId);
    if (!result) return sendError(res, 404, 'Not found');
    sendJson(res, { ok: true });
  },

  // PUT /api/v1/models/:id/middlewares/reorder
  async reorderModelMiddlewares(req, res, params) {
    const body = await readJsonBody(req);
    if (!Array.isArray(body?.ordered_ids)) return sendError(res, 400, 'ordered_ids array required');
    await mwDao.reorderModelMiddlewares(params.id, body.ordered_ids);
    const list = await mwDao.getModelMiddlewares(params.id);
    sendJson(res, list);
  },
};
