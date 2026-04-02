import { createProvider } from '../search-providers/registry.mjs';
import { createLogger } from '../../utils/logger.mjs';
import { randomUUID } from 'node:crypto';

const log = createLogger('search-converter');

// ---- Search provider config ----

const SEARCH_PROVIDERS = {
  tavily:    { type: 'tavily',    envKey: 'TAVILY_API_KEY',  requiresKey: true  },
  brave:     { type: 'brave',     envKey: 'BRAVE_API_KEY',   requiresKey: true  },
  exa:       { type: 'exa',       envKey: 'EXA_API_KEY',     requiresKey: true  },
  serper:    { type: 'serper',    envKey: 'SERPER_API_KEY',  requiresKey: true  },
  gemini:    { type: 'gemini',    envKey: 'GEMINI_API_KEY',  requiresKey: true  },
  duckduckgo:{ type: 'duckduckgo', envKey: null,             requiresKey: false },
  searxng:   { type: 'searxng',   envKey: null,              requiresKey: false },
  jina:      { type: 'jina',      envKey: 'JINA_API_KEY',   requiresKey: false },
};

// Model name → search provider mapping
const MODEL_PROVIDER_MAP = {
  'Tavily-search':     'tavily',
  'tavily-search':     'tavily',
  'brave-search':      'brave',
  'exa-search':        'exa',
  'serper-search':     'serper',
  'gemini-search':     'gemini',
  'duckduckgo-search': 'duckduckgo',
  'searxng-search':    'searxng',
  'jina-search':       'jina',
};

// DB-loaded API keys cache (from search_gateway.search_providers and provider_configs)
let dbKeysLoaded = false;
const dbKeys = new Map();

async function loadDbKeys() {
  if (dbKeysLoaded) return;
  dbKeysLoaded = true;
  try {
    const { query } = await import('../../db/init.mjs');
    const { decrypt } = await import('../../utils/crypto.mjs');

    // Source 1: search_gateway schema (same PostgreSQL instance)
    try {
      const { rows } = await query(
        `SELECT provider_type, encrypted_api_key FROM search_gateway.search_providers WHERE is_enabled = true AND encrypted_api_key IS NOT NULL`
      ).catch(() => ({ rows: [] }));
      for (const row of rows) {
        try {
          const key = decrypt(row.encrypted_api_key);
          if (key) dbKeys.set(row.provider_type, key);
        } catch {}
      }
    } catch {
      // search_gateway schema may not exist — that's fine
    }

    // Source 2: provider_configs (search providers added via dashboard UI)
    try {
      const { rows } = await query(
        `SELECT name, encrypted_api_key FROM provider_configs WHERE encrypted_api_key IS NOT NULL AND billing_type = 'search'`
      ).catch(() => ({ rows: [] }));
      for (const row of rows) {
        if (dbKeys.has(row.name)) continue; // search_gateway takes priority
        try {
          const key = decrypt(row.encrypted_api_key);
          if (key) dbKeys.set(row.name, key);
        } catch {}
      }
    } catch {}

    if (dbKeys.size > 0) {
      log.info(`Loaded ${dbKeys.size} search API keys from DB`);
    }
  } catch {
    // DB may not be ready yet — that's fine
  }
}

function getSearchApiKey(providerType) {
  const cfg = SEARCH_PROVIDERS[providerType];
  if (!cfg) return null;
  // First check env var
  if (cfg.envKey) {
    const envKey = process.env[cfg.envKey];
    if (envKey) return envKey;
  }
  // Fall back to DB-loaded key
  return dbKeys.get(providerType) || null;
}

async function getEnabledProviders() {
  await loadDbKeys();
  const enabled = [];
  for (const [name, cfg] of Object.entries(SEARCH_PROVIDERS)) {
    if (cfg.requiresKey) {
      const key = getSearchApiKey(name);
      if (key) enabled.push({ name, type: cfg.type, apiKey: key });
    } else {
      enabled.push({ name, type: cfg.type, apiKey: null });
    }
  }
  return enabled;
}

// ---- Query extraction ----

function extractQuery(messages) {
  if (!Array.isArray(messages) || messages.length === 0) {
    return { query: '', params: {} };
  }

  let lastUserContent = '';
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role === 'user') {
      lastUserContent = typeof msg.content === 'string'
        ? msg.content
        : Array.isArray(msg.content)
          ? msg.content.filter(c => c.type === 'text').map(c => c.text).join(' ')
          : '';
      break;
    }
  }

  if (!lastUserContent.trim()) {
    return { query: '', params: {} };
  }

  try {
    const parsed = JSON.parse(lastUserContent);
    if (parsed && typeof parsed.query === 'string') {
      const { query, ...params } = parsed;
      return { query: query.trim(), params };
    }
  } catch {}

  return { query: lastUserContent.trim(), params: {} };
}

// ---- Result formatting ----

function formatResultsMarkdown(results, query, providerName, latencyMs) {
  if (!results || results.length === 0) {
    return `No results found for: "${query}"`;
  }

  const lines = [`## Search Results for: "${query}"\n`];

  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    const title = r.title || 'Untitled';
    const url = r.url || '';
    const snippet = r.snippet || r.content?.slice(0, 300) || '';

    lines.push(`### ${i + 1}. [${title}](${url})`);
    if (snippet) lines.push(snippet);
    const meta = [];
    if (r.source) meta.push(`**Source:** ${r.source}`);
    if (r.published_date) meta.push(`**Published:** ${r.published_date}`);
    if (meta.length) lines.push(meta.join(' | '));
    lines.push('');
  }

  lines.push('---');
  lines.push(`*${results.length} results from ${providerName} | ${latencyMs}ms*`);

  return lines.join('\n');
}

// ---- Deep research (multi-provider) ----

async function* deepResearch(messages, signal) {
  const { query, params } = extractQuery(messages);
  if (!query) {
    yield { type: 'text_delta', text: 'No search query found in messages.' };
    yield { type: 'done', fullText: 'No search query found in messages.', toolCalls: null, usage: null, stopReason: 'stop' };
    return;
  }

  const providers = await getEnabledProviders();
  if (providers.length === 0) {
    yield { type: 'text_delta', text: 'No search providers configured.' };
    yield { type: 'done', fullText: 'No search providers configured.', toolCalls: null, usage: null, stopReason: 'stop' };
    return;
  }

  const startTime = Date.now();
  yield { type: 'text_delta', text: `Searching across ${providers.length} providers...\n\n` };

  let fullText = `Searching across ${providers.length} providers...\n\n`;
  const allResults = [];

  const searchPromises = providers.map(async (prov) => {
    try {
      const provider = createProvider(prov.type, prov.apiKey, null, {});
      const results = await provider.search(query, params);
      return { name: prov.name, results: results.map(r => ({ ...r, _provider: prov.name })), error: null };
    } catch (err) {
      return { name: prov.name, results: [], error: err.message };
    }
  });

  const providerResults = await Promise.all(searchPromises);

  for (const pr of providerResults) {
    if (pr.error) {
      const msg = `${pr.name}: search failed (${pr.error})\n`;
      yield { type: 'text_delta', text: msg };
      fullText += msg;
    } else {
      const msg = `Found ${pr.results.length} results from ${pr.name}\n`;
      yield { type: 'text_delta', text: msg };
      fullText += msg;
      allResults.push(...pr.results);
    }
  }

  // Deduplicate by URL
  const seen = new Set();
  const deduped = allResults.filter(r => {
    if (!r.url || seen.has(r.url)) return false;
    seen.add(r.url);
    return true;
  });

  const latencyMs = Date.now() - startTime;
  const markdown = '\n---\n\n' + formatResultsMarkdown(deduped, query, `${providers.length} providers`, latencyMs);
  yield { type: 'text_delta', text: markdown };
  fullText += markdown;

  yield { type: 'done', fullText, toolCalls: null, usage: null, stopReason: 'stop' };
}

// ---- Single provider search ----

async function* singleSearch(providerType, messages, signal) {
  await loadDbKeys();
  const { query, params } = extractQuery(messages);
  if (!query) {
    yield { type: 'text_delta', text: 'No search query found in messages.' };
    yield { type: 'done', fullText: 'No search query found in messages.', toolCalls: null, usage: null, stopReason: 'stop' };
    return;
  }

  const apiKey = getSearchApiKey(providerType);
  const cfg = SEARCH_PROVIDERS[providerType];
  if (cfg?.requiresKey && !apiKey) {
    const msg = `Search provider "${providerType}" requires an API key (${cfg.envKey}).`;
    yield { type: 'text_delta', text: msg };
    yield { type: 'done', fullText: msg, toolCalls: null, usage: null, stopReason: 'stop' };
    return;
  }

  const startTime = Date.now();

  try {
    const provider = createProvider(providerType, apiKey, null, {});
    const results = await provider.search(query, params);
    const latencyMs = Date.now() - startTime;
    const markdown = formatResultsMarkdown(results, query, providerType, latencyMs);

    yield { type: 'text_delta', text: markdown };
    yield { type: 'done', fullText: markdown, toolCalls: null, usage: null, stopReason: 'stop' };
  } catch (err) {
    const msg = `Search error (${providerType}): ${err.message}`;
    log.error(msg);
    yield { type: 'error', error: new Error(msg) };
  }
}

// ---- Main dispatch ----

export default {
  name: 'search',

  /**
   * Dispatch a search request. Called by upstream-dispatch for search models.
   *
   * @param {Array} messages - Chat messages
   * @param {object} payload - Full request payload
   * @param {string} baseUrl - Not used (search is internal)
   * @param {object} headers - Not used
   * @param {AbortSignal} [signal]
   * @yields typed chunks matching soul-gateway's stream format
   */
  async* dispatch(messages, payload, baseUrl, headers, signal) {
    const model = payload.model;
    const providerType = MODEL_PROVIDER_MAP[model];

    if (model === 'deep-research') {
      yield* deepResearch(messages, signal);
      return;
    }

    if (providerType) {
      yield* singleSearch(providerType, messages, signal);
      return;
    }

    // Unknown search model — try treating model name as provider type
    const fallbackType = model.replace(/-search$/, '');
    if (SEARCH_PROVIDERS[fallbackType]) {
      yield* singleSearch(fallbackType, messages, signal);
      return;
    }

    const msg = `Unknown search model: "${model}". Available: ${Object.keys(MODEL_PROVIDER_MAP).join(', ')}, deep-research`;
    yield { type: 'text_delta', text: msg };
    yield { type: 'done', fullText: msg, toolCalls: null, usage: null, stopReason: 'stop' };
  },

  /**
   * Return list of available search models based on configured API keys.
   */
  getAvailableModels() {
    const models = [];
    for (const [modelName, providerType] of Object.entries(MODEL_PROVIDER_MAP)) {
      const cfg = SEARCH_PROVIDERS[providerType];
      if (cfg?.requiresKey && !getSearchApiKey(providerType)) continue;
      models.push(modelName);
    }
    // Always include deep-research if any provider is available
    if (models.length > 0) {
      models.push('deep-research');
    }
    return models;
  },
};
