import { readJsonBody, sendJson, sendError } from '../utils/http-helpers.mjs';
import * as dao from '../db/providers-dao.mjs';
import { listProviders as listLLMConfigProviders } from 'achillesAgentLib/utils/LLMProviders/providers/providerRegistry.mjs';

const PROVIDER_TEMPLATES = {
  nvidia:     { display_name: 'NVIDIA',              protocol: 'openai',    base_url: 'https://integrate.api.nvidia.com/v1/chat/completions' },
  fireworks:  { display_name: 'Fireworks AI',        protocol: 'openai',    base_url: 'https://api.fireworks.ai/inference/v1/chat/completions' },
  groq:       { display_name: 'Groq',                protocol: 'openai',    base_url: 'https://api.groq.com/openai/v1/chat/completions' },
  together:   { display_name: 'Together AI',         protocol: 'openai',    base_url: 'https://api.together.xyz/v1/chat/completions' },
  deepseek:   { display_name: 'DeepSeek',            protocol: 'openai',    base_url: 'https://api.deepseek.com/v1/chat/completions' },
  deepinfra:  { display_name: 'DeepInfra',           protocol: 'openai',    base_url: 'https://api.deepinfra.com/v1/openai/chat/completions' },
  perplexity: { display_name: 'Perplexity',          protocol: 'openai',    base_url: 'https://api.perplexity.ai/chat/completions' },
  openai:     { display_name: 'OpenAI (Direct)',     protocol: 'openai',    base_url: 'https://api.openai.com/v1/chat/completions' },
  anthropic:  { display_name: 'Anthropic (Direct)',  protocol: 'anthropic', base_url: 'https://api.anthropic.com/v1/messages' },
  google:     { display_name: 'Google AI',           protocol: 'google',    base_url: 'https://generativelanguage.googleapis.com/v1beta/models/' },
  mistral:    { display_name: 'Mistral',             protocol: 'openai',    base_url: 'https://api.mistral.ai/v1/chat/completions' },
  xai:        { display_name: 'xAI (Grok)',          protocol: 'openai',    base_url: 'https://api.x.ai/v1/chat/completions' },
  cohere:     { display_name: 'Cohere',              protocol: 'openai',    base_url: 'https://api.cohere.com/v2/chat' },
  custom:     { display_name: 'Custom',              protocol: 'openai',    base_url: '' },
};

function stripBaseUrl(url) {
  return url
    .replace(/\/chat\/completions\/?$/, '')
    .replace(/\/messages\/?$/, '')
    .replace(/\/completions\/?$/, '')
    .replace(/\/responses\/?$/, '');
}

export const handleProviders = {
  async list(req, res) {
    const providers = await dao.listProviders();
    sendJson(res, providers);
  },

  async create(req, res) {
    const body = await readJsonBody(req);
    if (!body?.name || !body?.base_url || !body?.api_key) {
      return sendError(res, 400, 'name, base_url, and api_key are required');
    }
    // Reject names that collide with built-in LLMConfig providers
    const builtIn = listLLMConfigProviders();
    if (builtIn.includes(body.name)) {
      return sendError(res, 409, `Provider name "${body.name}" conflicts with built-in provider`);
    }
    try {
      const provider = await dao.createProvider(body);
      sendJson(res, provider, 201);
    } catch (err) {
      if (err.code === '23505') {
        return sendError(res, 409, `Provider "${body.name}" already exists`);
      }
      throw err;
    }
  },

  async update(req, res, params) {
    const body = await readJsonBody(req);
    const provider = await dao.updateProvider(params.id, body);
    if (!provider) return sendError(res, 404, 'Provider not found');
    sendJson(res, provider);
  },

  async remove(req, res, params) {
    const provider = await dao.deleteProvider(params.id);
    if (!provider) return sendError(res, 404, 'Provider not found');
    sendJson(res, { ok: true });
  },

  async templates(req, res) {
    sendJson(res, PROVIDER_TEMPLATES);
  },

  async test(req, res, params) {
    const provider = await dao.getProviderById(params.id);
    if (!provider) return sendError(res, 404, 'Provider not found');

    const apiKey = await dao.getProviderApiKey(params.id);
    if (!apiKey) return sendJson(res, { ok: false, error: 'No API key configured' });

    const base = stripBaseUrl(provider.base_url);
    try {
      const resp = await fetch(base + '/models', {
        headers: apiKey ? { 'Authorization': `Bearer ${apiKey}` } : {},
        signal: AbortSignal.timeout(10000),
      });
      if (!resp.ok) {
        const text = await resp.text().catch(() => '');
        return sendJson(res, { ok: false, error: `${resp.status}: ${text.slice(0, 200)}` });
      }
      const data = await resp.json();
      const models = Array.isArray(data) ? data : (data.data || []);
      sendJson(res, { ok: true, model_count: models.length });
    } catch (err) {
      sendJson(res, { ok: false, error: err.message });
    }
  },

  async discover(req, res, params) {
    const provider = await dao.getProviderById(params.id);
    if (!provider) return sendError(res, 404, 'Provider not found');

    const apiKey = await dao.getProviderApiKey(params.id);
    if (!apiKey) return sendError(res, 400, 'No API key configured');

    const base = stripBaseUrl(provider.base_url);
    try {
      const resp = await fetch(base + '/models', {
        headers: apiKey ? { 'Authorization': `Bearer ${apiKey}` } : {},
        signal: AbortSignal.timeout(15000),
      });
      if (!resp.ok) {
        return sendError(res, 502, `Provider returned ${resp.status}: ${await resp.text().catch(() => '')}`);
      }
      const data = await resp.json();
      const models = Array.isArray(data) ? data : (data.data || []);

      const enriched = models
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

      sendJson(res, enriched);
    } catch (err) {
      sendError(res, 502, `Failed to fetch models: ${err.message}`);
    }
  },
};
