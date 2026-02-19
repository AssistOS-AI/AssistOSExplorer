import { readJsonBody, sendJson, sendError } from '../utils/http-helpers.mjs';
import * as dao from '../db/models-dao.mjs';
import { listProviders } from 'achillesAgentLib/utils/LLMProviders/providers/providerRegistry.mjs';

export const handleModels = {
  async list(req, res, query) {
    const enabledOnly = query?.enabled === 'true';
    const models = await dao.listModels(enabledOnly);

    // For /v1/models (OpenAI-compatible format)
    if (req.url.startsWith('/v1/models')) {
      sendJson(res, {
        object: 'list',
        data: models.filter(m => m.is_enabled).map(m => ({
          id: m.name,
          object: 'model',
          created: Math.floor(new Date(m.created_at).getTime() / 1000),
          owned_by: 'soul-gateway',
        })),
      });
      return;
    }

    sendJson(res, models);
  },

  async create(req, res) {
    const body = await readJsonBody(req);
    if (!body?.name || !body?.provider_key || !body?.provider_model) {
      return sendError(res, 400, 'name, provider_key, and provider_model are required');
    }
    try {
      const model = await dao.createModel(body);
      sendJson(res, model, 201);
    } catch (err) {
      if (err.code === '23505') return sendError(res, 409, 'Model name already exists');
      throw err;
    }
  },

  async update(req, res, params) {
    const body = await readJsonBody(req);
    const model = await dao.updateModel(params.id, body);
    if (!model) return sendError(res, 404, 'Model not found');
    sendJson(res, model);
  },

  async toggle(req, res, params) {
    const model = await dao.toggleModel(params.id);
    if (!model) return sendError(res, 404, 'Model not found');
    sendJson(res, model);
  },

  async remove(req, res, params) {
    const model = await dao.deleteModel(params.id);
    if (!model) return sendError(res, 404, 'Model not found');
    sendJson(res, { ok: true });
  },

  async providers(req, res) {
    sendJson(res, listProviders());
  },
};
