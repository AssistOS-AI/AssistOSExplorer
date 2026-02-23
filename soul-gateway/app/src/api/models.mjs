import { readJsonBody, sendJson, sendError } from '../utils/http-helpers.mjs';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as dao from '../db/models-dao.mjs';
import { listProviders } from 'achillesAgentLib/utils/LLMProviders/providers/providerRegistry.mjs';

function loadLLMConfig() {
  // Resolve path relative to this file → ../../node_modules/achillesAgentLib/LLMConfig.json
  const dir = dirname(fileURLToPath(import.meta.url));
  const configPath = join(dir, '..', '..', 'node_modules', 'achillesAgentLib', 'LLMConfig.json');
  return JSON.parse(readFileSync(configPath, 'utf-8'));
}

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

  async providerModels(req, res, params) {
    const key = params.key;
    const config = loadLLMConfig();
    const provider = config.providers?.[key];
    if (!provider) return sendError(res, 404, `Provider "${key}" not found in LLMConfig`);

    // Derive /models URL from baseURL (strip /chat/completions, /messages, /completions, /responses)
    let baseURL = provider.baseURL
      .replace(/\/chat\/completions\/?$/, '')
      .replace(/\/messages\/?$/, '')
      .replace(/\/completions\/?$/, '')
      .replace(/\/responses\/?$/, '');
    const modelsURL = baseURL + '/models';

    // Get API key from env
    const apiKey = provider.apiKeyEnv ? process.env[provider.apiKeyEnv] : '';

    try {
      const resp = await fetch(modelsURL, {
        headers: apiKey ? { 'Authorization': `Bearer ${apiKey}` } : {},
        signal: AbortSignal.timeout(10000),
      });
      if (!resp.ok) {
        return sendError(res, 502, `Provider returned ${resp.status}: ${await resp.text()}`);
      }
      const data = await resp.json();
      // Handle both OpenAI format { data: [...] } and plain array
      const models = Array.isArray(data) ? data : (data.data || []);

      // Build enriched model list with pricing
      const enriched = models
        .map(m => {
          const id = m.id || m.name;
          if (!id) return null;
          let input_price = 0;
          let output_price = 0;
          // OpenRouter includes pricing.prompt / pricing.completion in $/token
          if (m.pricing?.prompt) input_price = parseFloat(m.pricing.prompt) * 1_000_000;
          if (m.pricing?.completion) output_price = parseFloat(m.pricing.completion) * 1_000_000;
          // Round to avoid floating-point noise
          input_price = Math.round(input_price * 1000) / 1000;
          output_price = Math.round(output_price * 1000) / 1000;
          return { id, input_price, output_price };
        })
        .filter(Boolean)
        .sort((a, b) => a.id.localeCompare(b.id));

      // Merge LLMConfig.json pricing as fallback for models without upstream pricing
      const configModels = config.models || [];
      for (const em of enriched) {
        if (em.input_price === 0 && em.output_price === 0) {
          // Try exact provider+name match first, then name-only across all providers
          const match = configModels.find(cm => cm.provider === key && cm.name === em.id)
            || configModels.find(cm => cm.name === em.id)
            || configModels.find(cm => cm.name === em.id.split('/').pop())
            || configModels.find(cm => cm.name.split('/').pop() === em.id);
          if (match) {
            em.input_price = match.inputPrice || 0;
            em.output_price = match.outputPrice || 0;
          }
        }
      }

      sendJson(res, enriched);
    } catch (err) {
      sendError(res, 502, `Failed to fetch models from ${key}: ${err.message}`);
    }
  },
};
