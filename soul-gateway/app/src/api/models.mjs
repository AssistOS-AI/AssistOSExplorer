import { readJsonBody, sendJson, sendError } from '../utils/http-helpers.mjs';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as dao from '../db/models-dao.mjs';
import { listProviders } from 'achillesAgentLib/utils/LLMProviders/providers/providerRegistry.mjs';
import { enrichWithOpenRouterPricing } from '../pipeline/openrouter-pricing.mjs';

function loadLLMConfig() {
  // Resolve path relative to this file → ../../node_modules/achillesAgentLib/LLMConfig.json
  const dir = dirname(fileURLToPath(import.meta.url));
  const configPath = join(dir, '..', '..', 'node_modules', 'achillesAgentLib', 'LLMConfig.json');
  return JSON.parse(readFileSync(configPath, 'utf-8'));
}

/**
 * Fetch /models from a provider and return a Map of id → { input_price, output_price }.
 * Handles OpenRouter-style pricing ($/token) and standard formats.
 */
async function fetchProviderPricing(providerConfig) {
  const baseURL = providerConfig.baseURL
    .replace(/\/chat\/completions\/?$/, '')
    .replace(/\/messages\/?$/, '')
    .replace(/\/completions\/?$/, '')
    .replace(/\/responses\/?$/, '');
  const apiKey = providerConfig.apiKeyEnv ? process.env[providerConfig.apiKeyEnv] : '';
  const resp = await fetch(baseURL + '/models', {
    headers: apiKey ? { 'Authorization': `Bearer ${apiKey}` } : {},
    signal: AbortSignal.timeout(10000),
  });
  if (!resp.ok) return new Map();
  const data = await resp.json();
  const models = Array.isArray(data) ? data : (data.data || []);
  const priceMap = new Map();
  for (const m of models) {
    const id = m.id || m.name;
    if (!id) continue;
    let input_price = 0, output_price = 0;
    if (m.pricing?.prompt) input_price = parseFloat(m.pricing.prompt) * 1_000_000;
    if (m.pricing?.completion) output_price = parseFloat(m.pricing.completion) * 1_000_000;
    input_price = Math.round(input_price * 1000) / 1000;
    output_price = Math.round(output_price * 1000) / 1000;
    if (input_price || output_price) {
      priceMap.set(id, { input_price, output_price });
    }
  }
  return priceMap;
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
          mode: m.mode || 'deep',
          input_price: parseFloat(m.input_price) || 0,
          output_price: parseFloat(m.output_price) || 0,
          context_window: m.context_window || null,
          sort_order: m.sort_order ?? 100,
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

    try {
      // Step 1: Fetch models from the requested provider
      const baseURL = provider.baseURL
        .replace(/\/chat\/completions\/?$/, '')
        .replace(/\/messages\/?$/, '')
        .replace(/\/completions\/?$/, '')
        .replace(/\/responses\/?$/, '');
      const apiKey = provider.apiKeyEnv ? process.env[provider.apiKeyEnv] : '';
      const resp = await fetch(baseURL + '/models', {
        headers: apiKey ? { 'Authorization': `Bearer ${apiKey}` } : {},
        signal: AbortSignal.timeout(10000),
      });
      if (!resp.ok) {
        return sendError(res, 502, `Provider returned ${resp.status}: ${await resp.text()}`);
      }
      const data = await resp.json();
      const models = Array.isArray(data) ? data : (data.data || []);

      // Step 2: Expand wildcard (*) entries by fetching from their upstream provider
      const wildcards = models.filter(m => (m.id || m.name) === '*' && m.owned_by);
      const nonWildcards = models.filter(m => (m.id || m.name) !== '*');
      const existingIds = new Set(nonWildcards.map(m => m.id || m.name));

      for (const wc of wildcards) {
        const upstream = wc.owned_by;
        const upstreamProvider = config.providers?.[upstream];
        if (upstreamProvider) {
          try {
            const upstreamBaseURL = upstreamProvider.baseURL
              .replace(/\/chat\/completions\/?$/, '')
              .replace(/\/messages\/?$/, '')
              .replace(/\/completions\/?$/, '')
              .replace(/\/responses\/?$/, '');
            const upstreamKey = upstreamProvider.apiKeyEnv ? process.env[upstreamProvider.apiKeyEnv] : '';
            const upResp = await fetch(upstreamBaseURL + '/models', {
              headers: upstreamKey ? { 'Authorization': `Bearer ${upstreamKey}` } : {},
              signal: AbortSignal.timeout(15000),
            });
            if (upResp.ok) {
              const upData = await upResp.json();
              const upModels = Array.isArray(upData) ? upData : (upData.data || []);
              for (const um of upModels) {
                const modelId = um.id || um.name;
                if (modelId && !existingIds.has(modelId)) {
                  nonWildcards.push({ ...um, id: modelId, owned_by: um.owned_by || upstream });
                  existingIds.add(modelId);
                }
              }
            }
          } catch { /* best-effort wildcard expansion */ }
        }
      }

      // Step 3: Build enriched model list with inline pricing
      const enriched = nonWildcards
        .map(m => {
          const id = m.id || m.name;
          if (!id) return null;
          let input_price = 0, output_price = 0;
          if (m.pricing?.prompt) input_price = parseFloat(m.pricing.prompt) * 1_000_000;
          if (m.pricing?.completion) output_price = parseFloat(m.pricing.completion) * 1_000_000;
          input_price = Math.round(input_price * 1000) / 1000;
          output_price = Math.round(output_price * 1000) / 1000;
          return { id, input_price, output_price, owned_by: m.owned_by || '' };
        })
        .filter(Boolean)
        .sort((a, b) => a.id.localeCompare(b.id));

      // Step 4: LLMConfig.json pricing as fallback
      const configModels = config.models || [];
      for (const em of enriched) {
        if (em.input_price === 0 && em.output_price === 0) {
          const match = configModels.find(cm => cm.provider === key && cm.name === em.id)
            || (em.owned_by && configModels.find(cm => cm.provider === em.owned_by && cm.name === em.id));
          if (match) {
            em.input_price = match.inputPrice || 0;
            em.output_price = match.outputPrice || 0;
          }
        }
      }

      // Step 5: For models still missing pricing, detect upstream providers from
      // owned_by and fetch pricing directly from them (e.g. a proxy returns
      // owned_by:"openrouter" — we fetch openrouter's /models for pricing)
      const needsPricing = enriched.filter(em => em.input_price === 0 && em.output_price === 0);
      if (needsPricing.length > 0) {
        // Group models by their owned_by provider
        const byProvider = new Map();
        for (const em of needsPricing) {
          const upstream = em.owned_by;
          if (upstream && upstream !== key && config.providers?.[upstream]) {
            if (!byProvider.has(upstream)) byProvider.set(upstream, []);
            byProvider.get(upstream).push(em);
          }
        }
        // Fetch pricing from each upstream provider in parallel
        const fetches = [...byProvider.entries()].map(async ([providerKey, models]) => {
          try {
            const priceMap = await fetchProviderPricing(config.providers[providerKey]);
            for (const em of models) {
              const price = priceMap.get(em.id);
              if (price) {
                em.input_price = price.input_price;
                em.output_price = price.output_price;
              }
            }
          } catch { /* upstream pricing fetch is best-effort */ }
        });
        await Promise.all(fetches);
      }

      // Step 6: Final fallback — look up any remaining 0/0 models on OpenRouter
      await enrichWithOpenRouterPricing(enriched);

      sendJson(res, enriched);
    } catch (err) {
      sendError(res, 502, `Failed to fetch models from ${key}: ${err.message}`);
    }
  },
};
