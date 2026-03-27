import { readJsonBody, sendJson, sendError } from '../utils/http-helpers.mjs';
import { listTiers, createTier, updateModel, toggleModel, deleteModel } from '../db/models-dao.mjs';
import { query } from '../db/init.mjs';

export const handleTiers = {
  async list(req, res) {
    const tiers = await listTiers();

    // Agent-facing /v1/tiers — OpenAI-compatible-ish format, enabled only
    if (req.url.startsWith('/v1/tiers')) {
      sendJson(res, {
        object: 'list',
        data: tiers.filter(t => t.is_enabled).map(t => ({
          name: t.name,
          display_name: t.display_name || t.name,
          models: t.model_refs || [],
          fallback: t.fallback_model || null,
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
    if (!body?.name) {
      return sendError(res, 400, 'name is required');
    }
    const tierData = {
      name: body.name,
      display_name: body.display_name,
      model_refs: body.model_refs || body.models || [],
      fallback_model: body.fallback_model || body.fallback_tier || null,
      sort_order: body.sort_order,
    };
    try {
      const tier = await createTier(tierData);
      sendJson(res, tier, 201);
    } catch (err) {
      if (err.code === '23505') return sendError(res, 409, 'Tier name already exists');
      throw err;
    }
  },

  async update(req, res, params) {
    const body = await readJsonBody(req);
    const mappedBody = { ...body };
    // Accept both old and new field names
    if (body.models && !body.model_refs) mappedBody.model_refs = body.models;
    if (body.fallback_tier && !body.fallback_model) mappedBody.fallback_model = body.fallback_tier;
    delete mappedBody.models;
    delete mappedBody.fallback_tier;
    const tier = await updateModel(params.id, mappedBody);
    if (!tier) return sendError(res, 404, 'Tier not found');
    // Auto-enable all models referenced in this tier
    if (tier.model_refs?.length) {
      await query('UPDATE model_configs SET is_enabled = true WHERE name = ANY($1)', [tier.model_refs]);
    }
    sendJson(res, tier);
  },

  async remove(req, res, params) {
    const tier = await deleteModel(params.id);
    if (!tier) return sendError(res, 404, 'Tier not found');
    sendJson(res, { ok: true });
  },

  async toggle(req, res, params) {
    const tier = await toggleModel(params.id);
    if (!tier) return sendError(res, 404, 'Tier not found');
    sendJson(res, tier);
  },
};
