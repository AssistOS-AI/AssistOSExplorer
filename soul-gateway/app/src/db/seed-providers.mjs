import { query } from './init.mjs';
import { createProvider, getProviderByName, getProviderApiKey } from './providers-dao.mjs';
import { upsertModel, getModelsByProviderConfigId, getTierByName, createTier, updateModel } from './models-dao.mjs';
import { createLogger } from '../utils/logger.mjs';
import { buildModelName } from '../utils/model-naming.mjs';

const log = createLogger('seed-providers');

const SEED_PROVIDERS = [
  { name: 'openrouter',         display_name: 'OpenRouter',            protocol: 'openai',    base_url: 'https://openrouter.ai/api/v1/chat/completions',                envVar: 'OPENROUTER_API_KEY' },
  { name: 'axiologic_proxy',    display_name: 'CLIProxyAPI',           protocol: 'openai',    base_url: 'http://10.0.2.2:8317/v1/chat/completions',                     envVar: 'AXIOLOGIC_PROXY_API_KEY' },
  { name: 'axiologic_kiro',     display_name: 'Kiro Gateway',         protocol: 'openai',    base_url: 'http://10.0.2.2:8000/v1/chat/completions',                     envVar: 'KIRO_PROXY_API_KEY',      billing_type: 'subscription' },
  { name: 'copilot',            display_name: 'Copilot Gateway',      protocol: 'openai',    base_url: 'http://10.0.2.2:4141/v1/chat/completions',                     envVar: 'COPILOT_API_KEY',         billing_type: 'subscription' },
  { name: 'opencode',           display_name: 'OpenCode',             protocol: 'openai',    base_url: 'https://opencode.ai/zen/v1/chat/completions',                  envVar: 'OPENCODE_API_KEY' },
  { name: 'opencode_anthropic', display_name: 'OpenCode (Anthropic)', protocol: 'anthropic', base_url: 'https://opencode.ai/zen/v1/messages',                          envVar: 'OPENCODE_API_KEY' },
  { name: 'opencode_responses', display_name: 'OpenCode (Responses)', protocol: 'openai',    base_url: 'https://opencode.ai/zen/v1/responses',                        envVar: 'OPENCODE_API_KEY' },
  { name: 'openai',             display_name: 'OpenAI',               protocol: 'openai',    base_url: 'https://api.openai.com/v1/chat/completions',                   envVar: 'OPENAI_API_KEY' },
  { name: 'anthropic',          display_name: 'Anthropic',            protocol: 'anthropic', base_url: 'https://api.anthropic.com/v1/messages',                         envVar: 'ANTHROPIC_API_KEY' },
  { name: 'google',             display_name: 'Google AI',            protocol: 'google',    base_url: 'https://generativelanguage.googleapis.com/v1beta/models/',      envVar: 'GEMINI_API_KEY' },
  { name: 'xai',                display_name: 'xAI',                  protocol: 'openai',    base_url: 'https://api.x.ai/v1/chat/completions',                         envVar: 'XAI_API_KEY' },
  { name: 'mistral',            display_name: 'Mistral',              protocol: 'openai',    base_url: 'https://api.mistral.ai/v1/chat/completions',                   envVar: 'MISTRAL_API_KEY' },
  { name: 'search_gateway',    display_name: 'Search Gateway',       protocol: 'openai',    base_url: 'http://10.0.2.2:8043/v1/chat/completions',                     envVar: 'SEARCH_GATEWAY_API_KEY' },
  { name: 'search',            display_name: 'Web Search (Built-in)', protocol: 'openai',   base_url: '',                                                              envVar: null,                      auth_type: 'internal', alwaysSeed: true },
];

/**
 * Auto-seed provider_configs from environment variables.
 * Idempotent: only creates providers that don't already exist in the DB.
 * After seeding, links existing models to their DB providers.
 */
export async function seedProviders() {
  let seededCount = 0;
  const seededNames = [];

  for (const seed of SEED_PROVIDERS) {
    // Internal providers (no API key needed) vs API key providers
    const apiKey = seed.envVar ? process.env[seed.envVar] : null;
    if (!apiKey && !seed.alwaysSeed) continue;

    const existing = await getProviderByName(seed.name);
    if (existing) continue;

    try {
      await createProvider({
        name: seed.name,
        display_name: seed.display_name,
        protocol: seed.protocol,
        base_url: seed.base_url,
        api_key: apiKey || null,
        billing_type: seed.billing_type,
        auth_type: seed.auth_type,
      });
      seededCount++;
      seededNames.push(seed.name);
      log.info(`Seeded provider: ${seed.name}`);
    } catch (err) {
      log.warn(`Failed to seed provider ${seed.name}: ${err.message}`);
    }
  }

  if (seededCount > 0) {
    log.info(`Seeded ${seededCount} providers: ${seededNames.join(', ')}`);
  }

  // Link existing models to DB providers
  await linkModelsToProviders();

  // Auto-sync search-gateway models if provider is configured
  await syncSearchGateway();

  // Auto-seed built-in search models
  await seedSearchModels();
}

/**
 * For models that have provider_config_id IS NULL, try to link them
 * to a DB provider matching their provider_key.
 */
async function linkModelsToProviders() {
  const { rows: unlinkedModels } = await query(`
    SELECT mc.id, mc.provider_key
    FROM model_configs mc
    WHERE mc.provider_config_id IS NULL
      AND mc.provider_key IS NOT NULL
  `);

  if (unlinkedModels.length === 0) return;

  // Build a map of provider name → provider id
  const { rows: providers } = await query('SELECT id, name FROM provider_configs');
  const providerMap = new Map(providers.map(p => [p.name, p.id]));

  let linkedCount = 0;
  for (const model of unlinkedModels) {
    const providerId = providerMap.get(model.provider_key);
    if (!providerId) continue;

    await query(
      'UPDATE model_configs SET provider_config_id = $1 WHERE id = $2',
      [providerId, model.id]
    );
    linkedCount++;
  }

  if (linkedCount > 0) {
    log.info(`Linked ${linkedCount} models to DB providers`);
  }
}

/**
 * Auto-sync models from search-gateway if it's configured as a provider.
 * Discovers models from search-gateway's /v1/models and upserts them into model_configs.
 * Creates/updates the "search" tier with all discovered search models.
 */
async function syncSearchGateway() {
  const provider = await getProviderByName('search_gateway');
  if (!provider) return;

  let apiKey;
  try {
    apiKey = await getProviderApiKey(provider.id);
  } catch (err) {
    log.warn('Could not decrypt search_gateway API key (encryption key may have changed)', { error: err.message });
    return;
  }
  if (!apiKey) return;

  const base = provider.base_url
    .replace(/\/chat\/completions\/?$/, '/models')
    .replace(/\/messages\/?$/, '/models');

  try {
    const resp = await fetch(base, {
      headers: { 'Authorization': `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(10000),
    });
    if (!resp.ok) {
      log.warn(`Search gateway sync: ${base} returned ${resp.status}`);
      return;
    }

    const data = await resp.json();
    const rawModels = Array.isArray(data) ? data : (data.data || []);
    const synced = [];

    for (const m of rawModels) {
      const id = m.id || m.name;
      if (!id) continue;

      const modelName = buildModelName(provider.name, id);
      await upsertModel({
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
        tags: ['search'],
      });
      synced.push(modelName);
    }

    if (synced.length > 0) {
      // Update or create search tier
      const searchTier = await getTierByName('search');
      if (searchTier) {
        const tierModels = new Set(searchTier.model_refs || []);
        for (const name of synced) tierModels.add(name);
        await updateModel(searchTier.id, { model_refs: [...tierModels] });
      } else {
        await createTier({
          name: 'search',
          display_name: 'Web Search',
          model_refs: synced,
          sort_order: 50,
        });
      }
      log.info(`Synced ${synced.length} search-gateway models: ${synced.join(', ')}`);
    }
  } catch (err) {
    log.warn(`Search gateway sync failed: ${err.message}`);
  }
}

/**
 * Auto-seed built-in search models for the internal search provider.
 * Creates models for each search provider that has an API key configured,
 * plus DuckDuckGo (free, no key needed) and deep-research.
 */
async function seedSearchModels() {
  const provider = await getProviderByName('search');
  if (!provider) return;

  const SEARCH_MODELS = [
    { model: 'duckduckgo-search', display: 'DuckDuckGo Search', free: true, envKey: null },
    { model: 'Tavily-search',     display: 'Tavily Search',     free: true, envKey: 'TAVILY_API_KEY' },
    { model: 'brave-search',      display: 'Brave Search',      free: true, envKey: 'BRAVE_API_KEY' },
    { model: 'exa-search',        display: 'Exa Search',        free: true, envKey: 'EXA_API_KEY' },
    { model: 'serper-search',     display: 'Serper Search',     free: true, envKey: 'SERPER_API_KEY' },
    { model: 'gemini-search',     display: 'Gemini Search',     free: true, envKey: 'GEMINI_API_KEY' },
    { model: 'jina-search',       display: 'Jina Search',       free: true, envKey: null },
    { model: 'deep-research',     display: 'Deep Research',     free: false, envKey: null },
  ];

  const synced = [];

  for (const sm of SEARCH_MODELS) {
    // Skip models that require an API key that isn't set
    if (sm.envKey && !process.env[sm.envKey]) continue;

    const modelName = buildModelName(provider.name, sm.model);
    await upsertModel({
      name: modelName,
      display_name: sm.display,
      provider_key: provider.name,
      provider_model: sm.model,
      mode: 'fast',
      input_price: 0,
      output_price: 0,
      is_free: sm.free,
      sort_order: 100,
      provider_config_id: provider.id,
      tags: ['search'],
    });
    synced.push(modelName);
  }

  if (synced.length > 0) {
    // Update or create search tier
    const searchTier = await getTierByName('search');
    if (searchTier) {
      const tierModels = new Set(searchTier.model_refs || []);
      for (const name of synced) tierModels.add(name);
      await updateModel(searchTier.id, { model_refs: [...tierModels] });
    }
    log.info(`Seeded ${synced.length} built-in search models: ${synced.join(', ')}`);
  }
}
