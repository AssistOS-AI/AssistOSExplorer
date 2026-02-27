import { readJsonBody, sendJson, sendError } from '../utils/http-helpers.mjs';
import * as dao from '../db/tiers-dao.mjs';

export const handleTiers = {
  async list(req, res) {
    const tiers = await dao.listTiers();

    // Agent-facing /v1/tiers — OpenAI-compatible-ish format, enabled only
    if (req.url.startsWith('/v1/tiers')) {
      sendJson(res, {
        object: 'list',
        data: tiers.filter(t => t.is_enabled).map(t => ({
          name: t.name,
          display_name: t.display_name || t.name,
          models: t.models || [],
          fallback: t.fallback_tier || null,
          sort_order: t.sort_order ?? 100,
        })),
      });
      return;
    }

    // Dashboard — full rows
    sendJson(res, tiers);
  },

  async create(req, res) {
    const body = await readJsonBody(req);
    if (!body?.name || !Array.isArray(body?.models)) {
      return sendError(res, 400, 'name and models (array) are required');
    }
    try {
      const tier = await dao.createTier(body);
      sendJson(res, tier, 201);
    } catch (err) {
      if (err.code === '23505') return sendError(res, 409, 'Tier name already exists');
      throw err;
    }
  },

  async update(req, res, params) {
    const body = await readJsonBody(req);
    const tier = await dao.updateTier(params.id, body);
    if (!tier) return sendError(res, 404, 'Tier not found');
    sendJson(res, tier);
  },

  async remove(req, res, params) {
    const tier = await dao.deleteTier(params.id);
    if (!tier) return sendError(res, 404, 'Tier not found');
    sendJson(res, { ok: true });
  },

  async toggle(req, res, params) {
    const tier = await dao.toggleTier(params.id);
    if (!tier) return sendError(res, 404, 'Tier not found');
    sendJson(res, tier);
  },
};
