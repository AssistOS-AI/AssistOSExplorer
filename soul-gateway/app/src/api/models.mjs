import { readJsonBody, sendJson, sendError } from '../utils/http-helpers.mjs';
import * as dao from '../db/models-dao.mjs';
import * as providersDao from '../db/providers-dao.mjs';
import { handleProviders } from './providers.mjs';
import { lookupOpenRouterPricing } from '../pipeline/openrouter-pricing.mjs';
import { PREDEFINED_TAGS } from '../utils/model-naming.mjs';

export const handleModels = {
  async list(req, res, query) {
    const enabledOnly = query?.enabled === 'true';
    const models = await dao.listModels(enabledOnly);

    // Enrich token-priced models with 0/0 pricing from OpenRouter
    for (const m of models) {
      if ((m.pricing_type || 'token') === 'token' &&
          parseFloat(m.input_price) === 0 && parseFloat(m.output_price) === 0 &&
          m.provider_model) {
        const orPricing = await lookupOpenRouterPricing(m.provider_model);
        if (orPricing) {
          m.input_price = orPricing.input_price;
          m.output_price = orPricing.output_price;
        }
      }
    }

    // For /v1/models (OpenAI-compatible format)
    if (req.url.startsWith('/v1/models')) {
      sendJson(res, {
        object: 'list',
        data: models.filter(m => m.is_enabled).map(m => ({
          id: m.name,
          object: 'model',
          created: Math.floor(new Date(m.created_at).getTime() / 1000),
          owned_by: 'soul-gateway',
          mode: m.mode || 'deep',
          input_price: parseFloat(m.input_price) || 0,
          output_price: parseFloat(m.output_price) || 0,
          context_window: m.context_window || null,
          sort_order: m.sort_order ?? 100,
          is_free: Boolean(m.is_free),
          billing_type: m.billing_type || 'api_key',
          tags: m.tags || [],
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
      if (err.code === '23505') {
        // Idempotent: return existing model instead of error
        const existing = await dao.getModelByName(body.name);
        return sendJson(res, existing, 200);
      }
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
    const dbProviders = await providersDao.listProviders();
    sendJson(res, dbProviders.map(p => ({ key: p.name, source: 'database', id: p.id, protocol: p.protocol })));
  },

  async tags(req, res) {
    sendJson(res, PREDEFINED_TAGS);
  },

  async providerModels(req, res, params) {
    const key = params.key;
    const dbProvider = await providersDao.getProviderByName(key);
    if (!dbProvider) {
      return sendError(res, 404, `Provider "${key}" not found`);
    }
    return handleProviders.discover(req, res, { id: dbProvider.id });
  },
};
