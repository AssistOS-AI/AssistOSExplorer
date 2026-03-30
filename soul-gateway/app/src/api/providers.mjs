import { readJsonBody, sendJson, sendError } from '../utils/http-helpers.mjs';
import * as dao from '../db/providers-dao.mjs';
import { upsertModel, getModelsByProviderConfigId, getTierByName, createTier, updateModel } from '../db/models-dao.mjs';
import { createLogger } from '../utils/logger.mjs';
import { buildModelName } from '../utils/model-naming.mjs';
import * as authManager from '../providers/auth-manager.mjs';

const syncLog = createLogger('provider-sync');

const PROVIDER_TEMPLATES = {
  // OAuth providers (managed auth)
  copilot:    { display_name: 'GitHub Copilot',      protocol: 'openai',    base_url: 'https://api.githubcopilot.com/chat/completions', billing_type: 'subscription', auth_type: 'managed' },
  kiro:       { display_name: 'Kiro (AWS Claude)',   protocol: 'openai',    base_url: 'https://q.us-east-1.amazonaws.com/generateAssistantResponse', billing_type: 'subscription', auth_type: 'managed' },
  codex:      { display_name: 'OpenAI Codex (OAuth)',protocol: 'openai',    base_url: 'https://api.openai.com/v1/chat/completions', auth_type: 'managed' },
  gemini_oauth: { display_name: 'Google Gemini (OAuth)', protocol: 'openai', base_url: 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions', auth_type: 'managed' },
  anthropic_oauth: { display_name: 'Anthropic Claude (OAuth)', protocol: 'openai', base_url: 'https://api.anthropic.com/v1/messages', auth_type: 'managed' },
  // API key providers
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
    if (!body?.name || !body?.base_url) {
      return sendError(res, 400, 'name and base_url are required');
    }
    if (body.auth_type !== 'managed' && !body.api_key) {
      return sendError(res, 400, 'api_key is required for non-OAuth providers');
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

    // Managed auth providers: check credential status instead of hitting base_url
    if (provider.auth_type === 'managed') {
      try {
        const status = await authManager.getAuthStatus(provider.name);
        if (status.status === 'active') {
          return sendJson(res, { ok: true, message: `Authenticated (${status.accounts.length} account${status.accounts.length !== 1 ? 's' : ''})` });
        }
        if (status.status === 'no_accounts') {
          return sendJson(res, { ok: false, error: 'No accounts configured. Click Manage to add one.' });
        }
        return sendJson(res, { ok: false, error: `Auth status: ${status.status}` });
      } catch (err) {
        return sendJson(res, { ok: false, error: err.message });
      }
    }

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

    // Managed auth providers: try to discover models using OAuth credentials
    if (provider.auth_type === 'managed') {
      try {
        const creds = await authManager.getCredentials(provider.name);
        if (!creds) {
          return sendError(res, 400, 'Provider not authenticated. Add an account first.');
        }
        // Strip the chat/completions path to get the base API URL for /models
        const base = stripBaseUrl(provider.base_url);
        const resp = await fetch(base + '/models', {
          headers: creds.headers || { 'Authorization': `Bearer ${creds.token}` },
          signal: AbortSignal.timeout(15000),
        });
        if (!resp.ok) {
          // Fallback 1: adapter has knownModels list (e.g., Codex token can't list models)
          const adapter = authManager.getAdapter(provider.name);
          if (adapter?.knownModels?.length) {
            return sendJson(res, adapter.knownModels.map(id => ({
              id, input_price: 0, output_price: 0, owned_by: provider.name,
            })));
          }
          // Fallback 2: return already-configured models from DB
          const dbModels = await getModelsByProviderConfigId(provider.id);
          if (dbModels.length > 0) {
            return sendJson(res, dbModels.map(m => ({
              id: m.provider_model || m.name,
              input_price: parseFloat(m.input_price) || 0,
              output_price: parseFloat(m.output_price) || 0,
              owned_by: provider.name,
            })));
          }
          const text = await resp.text().catch(() => '');
          return sendError(res, 502, `Provider returned ${resp.status}: ${text.slice(0, 200)}`);
        }
        const data = await resp.json();
        const models = Array.isArray(data) ? data : (data.data || []);
        const seen = new Set();
        const enriched = models
          .map(m => {
            const id = m.id || m.name;
            if (!id || seen.has(id)) return null;
            seen.add(id);
            return { id, input_price: 0, output_price: 0, owned_by: m.owned_by || provider.name };
          })
          .filter(Boolean)
          .sort((a, b) => a.id.localeCompare(b.id));
        return sendJson(res, enriched);
      } catch (err) {
        // Fallback to DB models on error
        const dbModels = await getModelsByProviderConfigId(provider.id);
        if (dbModels.length > 0) {
          return sendJson(res, dbModels.map(m => ({
            id: m.provider_model || m.name,
            input_price: parseFloat(m.input_price) || 0,
            output_price: parseFloat(m.output_price) || 0,
            owned_by: provider.name,
          })));
        }
        return sendError(res, 502, `Failed to discover models: ${err.message}`);
      }
    }

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

      const seen = new Set();
      const enriched = models
        .map(m => {
          const id = m.id || m.name;
          if (!id || seen.has(id)) return null;
          seen.add(id);
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

  /**
   * Sync models from a provider: discover models, upsert model_configs,
   * and update the search tier if applicable.
   */
  async sync(req, res, params) {
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
        return sendError(res, 502, `Provider returned ${resp.status}`);
      }

      const data = await resp.json();
      const rawModels = Array.isArray(data) ? data : (data.data || []);

      const synced = [];
      const discoveredNames = new Set();

      for (const m of rawModels) {
        const id = m.id || m.name;
        if (!id) continue;
        discoveredNames.add(id);

        const modelName = buildModelName(provider.name, id);
        const model = await upsertModel({
          name: modelName,
          display_name: id,
          provider_key: provider.name,
          provider_model: id,
          mode: m.mode || 'fast',
          input_price: parseFloat(m.input_price) || 0,
          output_price: parseFloat(m.output_price) || 0,
          is_free: Boolean(m.is_free),
          sort_order: m.sort_order ?? 100,
          provider_config_id: provider.id,
        });
        synced.push(model.name);
      }

      // Disable models from this provider that are no longer discovered
      // Build set of expected names (with axl/ prefix) from discovered raw IDs
      const expectedNames = new Set([...discoveredNames].map(id => buildModelName(provider.name, id)));
      const existingModels = await getModelsByProviderConfigId(provider.id);
      let disabledCount = 0;
      for (const existing of existingModels) {
        if (!expectedNames.has(existing.name) && existing.is_enabled) {
          const { query: dbQuery } = await import('../db/init.mjs');
          await dbQuery('UPDATE model_configs SET is_enabled = false WHERE id = $1', [existing.id]);
          disabledCount++;
        }
      }

      // Update search tier if it exists (or create it)
      if (synced.length > 0) {
        const searchTier = await getTierByName('search');
        if (searchTier) {
          // Merge: keep existing models, add new ones
          const tierModels = new Set(searchTier.model_refs || []);
          for (const name of synced) tierModels.add(name);
          // Remove disabled models
          for (const existing of existingModels) {
            if (!expectedNames.has(existing.name)) tierModels.delete(existing.name);
          }
          await updateModel(searchTier.id, { model_refs: [...tierModels] });
          syncLog.info(`Updated search tier with ${tierModels.size} models`);
        } else {
          await createTier({
            name: 'search',
            display_name: 'Web Search',
            model_refs: synced,
            sort_order: 50,
          });
          syncLog.info(`Created search tier with ${synced.length} models`);
        }
      }

      syncLog.info(`Synced ${synced.length} models from ${provider.name}, disabled ${disabledCount}`);
      sendJson(res, { ok: true, synced, disabled: disabledCount });
    } catch (err) {
      sendError(res, 502, `Sync failed: ${err.message}`);
    }
  },

  // GET /api/v1/providers/:id/auth/status
  async authStatus(req, res, params) {
    const provider = await dao.getProviderById(params.id);
    if (!provider) return sendError(res, 404, 'Provider not found');
    if (provider.auth_type !== 'managed') return sendJson(res, { auth_type: 'api_key' });
    const status = await authManager.getAuthStatus(provider.name);
    sendJson(res, { auth_type: 'managed', ...status });
  },

  // POST /api/v1/providers/:id/auth/start
  async authStart(req, res, params) {
    const provider = await dao.getProviderById(params.id);
    if (!provider) return sendError(res, 404, 'Provider not found');
    if (provider.auth_type !== 'managed') return sendError(res, 400, 'Not a managed auth provider');
    try {
      const result = await authManager.startAuth(provider.name);
      sendJson(res, result);
    } catch (err) {
      sendError(res, 500, err.message);
    }
  },

  // GET /api/v1/providers/:id/auth/poll
  async authPoll(req, res, params) {
    const provider = await dao.getProviderById(params.id);
    if (!provider) return sendError(res, 404, 'Provider not found');
    try {
      const result = await authManager.pollAuth(provider.name);
      sendJson(res, result);
    } catch (err) {
      sendJson(res, { status: 'error', error: err.message });
    }
  },

  // DELETE /api/v1/providers/:id/auth/accounts/:idx
  async authRemoveAccount(req, res, params) {
    const provider = await dao.getProviderById(params.id);
    if (!provider) return sendError(res, 404, 'Provider not found');
    await authManager.removeAccount(provider.name, parseInt(params.idx));
    sendJson(res, { ok: true });
  },

  // POST /api/v1/providers/:id/auth/reset-quota
  async authResetQuota(req, res, params) {
    const provider = await dao.getProviderById(params.id);
    if (!provider) return sendError(res, 404, 'Provider not found');
    await authManager.resetQuota(provider.name);
    sendJson(res, { ok: true });
  },

  // POST /api/v1/providers/:id/auth/callback — manual callback for PKCE flows
  // User pastes the callback URL from the browser when localhost:PORT isn't reachable
  async authCallback(req, res, params) {
    const provider = await dao.getProviderById(params.id);
    if (!provider) return sendError(res, 404, 'Provider not found');
    if (provider.auth_type !== 'managed') return sendError(res, 400, 'Not a managed auth provider');
    const body = await readJsonBody(req);
    if (!body?.code || !body?.state) {
      return sendError(res, 400, 'code and state are required. Paste the full callback URL or provide {code, state} JSON.');
    }
    try {
      const result = await authManager.handlePKCECallback(provider.name, body.code, body.state);
      sendJson(res, { status: 'complete', ...result });
    } catch (err) {
      sendError(res, 500, err.message);
    }
  },
};
