/**
 * Built-in search provider plugin.
 *
 * Dispatches to the appropriate search API based on providerModelId:
 *   tavily, brave, exa, serper, jina, duckduckgo, searxng, gemini
 *
 * Returns formatted search results as NormalizedChunks.
 */

import { request as httpsRequest } from 'node:https';
import { request as httpRequest } from 'node:http';
import {
  ProviderAuthError,
  ProviderRateLimitError,
  ProviderQuotaError,
  ProviderModelNotFoundError,
} from '../../../core/errors.mjs';
import { HTTP_STATUS } from '../../../core/constants.mjs';
import { classifyTransportOrServerError, getProviderStatus } from '../error-helpers.mjs';
import * as searchConverter from '../converters/search-converter.mjs';

// ── Manifest ────────────────────────────────────────────────────────

const manifest = {
  key: 'search-builtin',
  kind: 'search',
  authStrategy: 'api_key',
  supportsStreaming: false,
  supportsTools: false,
  supportedFormats: ['openai_chat'],
  // Dispatcher plugin: routes to one of 8 search engines (Tavily,
  // Brave, Exa, Serper, Jina, DuckDuckGo, SearXNG, Gemini grounding)
  // based on the resolved model's provider_model_id. Each engine is
  // surfaced through its own preset in provider-presets.mjs with the
  // correct base_url. Hide the raw `search-builtin` key from the
  // dropdown — picking it directly would leave the user with a blank
  // base_url and nothing meaningful to point at.
  hidden: true,
};

// ── Engine ↔ canonical hostname map ─────────────────────────────────
//
// Used by resolveEngineKey() to figure out which search engine a
// provider represents when the call site doesn't already have a
// resolved model in scope (e.g. the lifecycle Test button). Each
// entry is the hostname produced by the matching preset's base_url
// in provider-presets.mjs.
const ENGINE_HOSTNAMES = Object.freeze({
  'api.tavily.com': 'tavily',
  'api.search.brave.com': 'brave',
  'api.exa.ai': 'exa',
  'google.serper.dev': 'serper',
  's.jina.ai': 'jina',
  'api.duckduckgo.com': 'duckduckgo',
  'html.duckduckgo.com': 'duckduckgo',
  'generativelanguage.googleapis.com': 'gemini',
});

// ── Search provider endpoints ───────────────────────────────────────

const SEARCH_PROVIDERS = {
  tavily: {
    displayName: 'Tavily Search',
    url: 'https://api.tavily.com/search',
    authHeader: null, // uses body param
    buildBody(query, secret, options) {
      return JSON.stringify({
        api_key: secret,
        query,
        search_depth: options.depth || 'basic',
        max_results: options.maxResults || 10,
        include_answer: false,
      });
    },
    extractResults: searchConverter.extractTavilyResults,
  },
  brave: {
    displayName: 'Brave Search',
    url: 'https://api.search.brave.com/res/v1/web/search',
    authHeader: 'X-Subscription-Token',
    buildUrl(query, options) {
      const params = new URLSearchParams({
        q: query,
        count: String(options.maxResults || 10),
      });
      return `https://api.search.brave.com/res/v1/web/search?${params}`;
    },
    extractResults: searchConverter.extractBraveResults,
  },
  exa: {
    displayName: 'Exa Search',
    url: 'https://api.exa.ai/search',
    authHeader: 'x-api-key',
    buildBody(query, _secret, options) {
      return JSON.stringify({
        query,
        num_results: options.maxResults || 10,
        use_autoprompt: true,
        type: 'neural',
      });
    },
    extractResults: searchConverter.extractExaResults,
  },
  serper: {
    displayName: 'Serper Search',
    url: 'https://google.serper.dev/search',
    authHeader: 'X-API-KEY',
    buildBody(query, _secret, options) {
      return JSON.stringify({
        q: query,
        num: options.maxResults || 10,
      });
    },
    extractResults: searchConverter.extractSerperResults,
  },
  jina: {
    displayName: 'Jina Reader',
    url: 'https://s.jina.ai/',
    authHeader: 'Authorization',
    authPrefix: 'Bearer ',
    buildUrl(query) {
      return `https://s.jina.ai/${encodeURIComponent(query)}`;
    },
    headers: { Accept: 'application/json' },
    extractResults: searchConverter.extractJinaResults,
  },
  duckduckgo: {
    displayName: 'DuckDuckGo',
    url: 'https://api.duckduckgo.com/',
    authHeader: null, // no auth needed
    buildUrl(query) {
      const params = new URLSearchParams({
        q: query,
        format: 'json',
        no_redirect: '1',
        no_html: '1',
      });
      return `https://api.duckduckgo.com/?${params}`;
    },
    method: 'GET',
    extractResults: searchConverter.extractDuckDuckGoResults,
  },
  searxng: {
    displayName: 'SearXNG',
    authHeader: null,
    buildUrl(query, options) {
      const base = options.searxng_url || 'https://searx.be';
      const params = new URLSearchParams({
        q: query,
        format: 'json',
        categories: 'general',
      });
      return `${base}/search?${params}`;
    },
    method: 'GET',
    extractResults: searchConverter.extractSearxngResults,
  },
  gemini: {
    displayName: 'Gemini Grounding',
    url: 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent',
    authHeader: null, // uses query param
    buildUrl(_query, options) {
      const key = options.gemini_key || '';
      return `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${key}`;
    },
    buildBody(query) {
      return JSON.stringify({
        contents: [{ parts: [{ text: query }] }],
        tools: [{ google_search: {} }],
      });
    },
    extractResults: searchConverter.extractGeminiResults,
  },
};

// ── Plugin ──────────────────────────────────────────────────────────

export const providerPlugin = {
  manifest,

  formatConverter: searchConverter,

  async init() {},

  async shutdown() {},

  validateProviderRecord(providerRecord) {
    // Search providers can have different settings per search engine
  },

  validateModelRecord(modelRecord) {
    const engineId = modelRecord.provider_model_id || modelRecord.model_key;
    const engineKey = engineId.replace(/^search-/, '');
    // deep-research is a valid meta-engine
    if (engineKey === 'deep-research') return;
    if (!SEARCH_PROVIDERS[engineKey] && !SEARCH_PROVIDERS[engineId]) {
      throw new Error(
        `Unknown search engine: ${engineId}. ` +
        `Supported: ${Object.keys(SEARCH_PROVIDERS).join(', ')}, deep-research`,
      );
    }
  },

  async discoverModels() {
    const models = Object.entries(SEARCH_PROVIDERS).map(([key, sp]) => ({
      modelId: `search-${key}`,
      displayName: sp.displayName,
      contextWindow: null,
      maxOutputTokens: null,
      supportsTools: false,
      supportsStreaming: false,
      supportsVision: false,
    }));
    // Add deep-research meta-engine
    models.push({
      modelId: 'search-deep-research',
      displayName: 'Deep Research (multi-engine)',
      contextWindow: null,
      maxOutputTokens: null,
      supportsTools: false,
      supportsStreaming: false,
      supportsVision: false,
    });
    return models;
  },

  async testConnection(ctx) {
    const secret = ctx.credentialLease?.secret;
    const engineKey = resolveEngineKey(ctx.providerRecord, ctx);

    // No engine could be identified. The credential decryption
    // already succeeded (we wouldn't be here otherwise), so we can
    // still answer the credential-presence question — we just can't
    // name the upstream service.
    if (!engineKey) {
      return secret
        ? { ok: true, detail: 'Search credentials present (engine unknown)' }
        : { ok: false, detail: 'No API key configured' };
    }

    const engine = SEARCH_PROVIDERS[engineKey];

    // DuckDuckGo and SearXNG don't require auth — short-circuit
    // before we look at the credential at all.
    if (!engine.authHeader && engineKey !== 'tavily' && engineKey !== 'gemini') {
      return { ok: true, detail: `${engine.displayName} does not require authentication` };
    }

    if (!secret && engineKey !== 'duckduckgo' && engineKey !== 'searxng') {
      return { ok: false, detail: `${engine.displayName}: no API key configured` };
    }

    return { ok: true, detail: `${engine.displayName} credentials present` };
  },

  async execute(ctx) {
    const { request: normalizedReq, resolvedModel, providerRecord, credentialLease } = ctx;
    const secret = credentialLease?.secret || '';
    const settings = providerRecord?.settings || {};

    // Extract query from the last user message
    const query = extractSearchQuery(normalizedReq);
    if (!query) {
      const stream = emptyResultStream(ctx.requestId);
      return { accountId: credentialLease?.accountId || null, stream, abort: async () => {} };
    }

    const engineId = resolvedModel.provider_model_id || resolvedModel.model_key;
    const engineKey = engineId.replace(/^search-/, '');

    // Deep research: query multiple engines in parallel, deduplicate and rank
    if (engineKey === 'deep-research') {
      return executeDeepResearch(ctx, query, secret, settings);
    }

    const engine = SEARCH_PROVIDERS[engineKey];
    if (!engine) {
      throw new Error(`Unknown search engine: ${engineKey}`);
    }

    const maxResults = settings.max_results || 10;
    const options = { maxResults, ...settings };

    // Build request
    let urlStr;
    let method = engine.method || 'POST';
    let body = null;
    const headers = { ...(engine.headers || {}), 'Content-Type': 'application/json' };

    if (engine.buildUrl) {
      urlStr = engine.buildUrl(query, options);
    } else {
      urlStr = engine.url;
    }

    if (method === 'POST' && engine.buildBody) {
      body = engine.buildBody(query, secret, options);
    }

    // Auth header
    if (engine.authHeader && secret) {
      const prefix = engine.authPrefix || '';
      headers[engine.authHeader] = prefix + secret;
    }

    // Execute the search
    const rawResponse = await doSearchRequest(urlStr, method, headers, body);
    const results = engine.extractResults(rawResponse);

    // Convert to normalized chunks
    const chunks = searchConverter.toNormalizedChunks(results, query, {
      requestId: ctx.requestId,
      model: engineId,
      provider: 'search-builtin',
    });

    const stream = arrayToAsyncGenerator(chunks);
    return {
      accountId: credentialLease?.accountId || null,
      stream,
      abort: async () => {},
    };
  },

  classifyError(error, _ctx) {
    const status = getProviderStatus(error);

    if (status === HTTP_STATUS.UNAUTHORIZED || status === HTTP_STATUS.FORBIDDEN) {
      return new ProviderAuthError('search', error.message);
    }
    if (status === HTTP_STATUS.TOO_MANY_REQUESTS) {
      return new ProviderRateLimitError('search');
    }
    if (status === HTTP_STATUS.NOT_FOUND) {
      return new ProviderModelNotFoundError('search', 'unknown');
    }
    if (status >= HTTP_STATUS.INTERNAL_SERVER_ERROR && status < 600) {
      return classifyTransportOrServerError('search', error, status);
    }
    return classifyTransportOrServerError('search', error);
  },
};

// ── Helpers ─────────────────────────────────────────────────────────

/**
 * Resolve which search engine a provider record represents. Used by
 * lifecycle entry points (testConnection, future discoverModels
 * filtering) where there is no resolved model in scope and the
 * engine has to be inferred from the provider row itself.
 *
 * Resolution order, most specific to least:
 *   1. ctx.resolvedModel.provider_model_id — the execution path
 *      passes this in, and it's the only signal that's exact
 *      (the user explicitly chose which engine to invoke).
 *   2. providerRecord.settings.engine — explicit override for
 *      providers running a forked endpoint behind a custom URL.
 *   3. providerRecord.provider_key — matches the preset key for
 *      anything added via the Add Provider dropdown
 *      (provider_key === 'exa', 'brave', 'tavily', …).
 *   4. providerRecord.base_url hostname — last resort, covers
 *      providers that have been renamed but still point at a
 *      canonical engine endpoint.
 *
 * Returns the engine key (e.g. 'exa') or null if nothing matches.
 *
 * @param {object} providerRecord  raw or aliased provider row
 * @param {object} [ctx]           plugin context (for resolvedModel)
 * @returns {string|null}
 */
function resolveEngineKey(providerRecord, ctx = {}) {
  // 1. Resolved model wins — most specific signal.
  const resolvedRaw = ctx.resolvedModel?.provider_model_id
    || ctx.resolvedModel?.providerModelId;
  if (resolvedRaw) {
    const stripped = String(resolvedRaw).replace(/^search-/, '');
    if (SEARCH_PROVIDERS[stripped]) return stripped;
  }

  // 2. Explicit settings.engine override.
  const explicit = providerRecord?.settings?.engine;
  if (explicit && SEARCH_PROVIDERS[explicit]) return explicit;

  // 3. provider_key matches a preset key directly.
  const providerKey = providerRecord?.provider_key || providerRecord?.providerKey;
  if (providerKey) {
    const normalized = String(providerKey).toLowerCase();
    if (SEARCH_PROVIDERS[normalized]) return normalized;
    // Tolerate suffixed names like "exa-direct", "tavily-prod" by
    // matching against any engine key that prefixes the provider_key.
    for (const engineKey of Object.keys(SEARCH_PROVIDERS)) {
      if (normalized.startsWith(engineKey)) return engineKey;
    }
  }

  // 4. base_url hostname as the final fallback.
  const baseUrl = providerRecord?.base_url || providerRecord?.baseUrl;
  if (baseUrl) {
    try {
      const host = new URL(baseUrl).hostname.toLowerCase();
      if (ENGINE_HOSTNAMES[host]) return ENGINE_HOSTNAMES[host];
    } catch {
      // Malformed base_url — fall through to null.
    }
  }

  return null;
}

function extractSearchQuery(normalizedReq) {
  const messages = normalizedReq.messages || [];
  // Use the last user message as the search query
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'user') {
      const content = messages[i].content;
      if (typeof content === 'string') return content;
      if (Array.isArray(content)) {
        const text = content.find((p) => p.type === 'text');
        return text?.text || '';
      }
    }
  }
  return '';
}

async function* emptyResultStream(requestId) {
  yield { type: 'message_start', data: { id: requestId, model: 'search', role: 'assistant' } };
  yield { type: 'text_delta', data: { text: 'No search query provided.' } };
  yield { type: 'done', data: { finish_reason: 'stop', model: 'search' } };
}

async function* arrayToAsyncGenerator(arr) {
  for (const item of arr) {
    yield item;
  }
}

async function doSearchRequest(urlStr, method, headers, body) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlStr);
    const isHttps = url.protocol === 'https:';
    const reqFn = isHttps ? httpsRequest : httpRequest;

    const opts = {
      hostname: url.hostname,
      port: url.port || (isHttps ? 443 : 80),
      path: url.pathname + url.search,
      method,
      headers,
    };

    if (body) {
      opts.headers['Content-Length'] = Buffer.byteLength(body);
    }

    const req = reqFn(opts, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        if (res.statusCode >= 400) {
          const err = new Error(`Search API error: ${res.statusCode}`);
          err.status = res.statusCode;
          try { err.body = JSON.parse(raw); } catch { err.body = {}; }
          reject(err);
          return;
        }
        try {
          resolve(JSON.parse(raw));
        } catch {
          resolve({ raw });
        }
      });
      res.on('error', reject);
    });

    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

// ── Deep Research ────────────────────────────────────────────────────

/**
 * Query multiple search providers in parallel, deduplicate and rank results,
 * produce a synthesized response.
 */
async function executeDeepResearch(ctx, query, secret, settings) {
  const maxResults = settings.deep_research_max_results || 20;

  // Determine which engines to query (configurable or all available)
  const configuredEngines = settings.deep_research_providers
    ? settings.deep_research_providers.split(',').map(s => s.trim())
    : Object.keys(SEARCH_PROVIDERS);

  // Query all configured engines in parallel, collecting results
  const allResults = [];
  const enginePromises = configuredEngines.map(async (engineKey) => {
    const engine = SEARCH_PROVIDERS[engineKey];
    if (!engine) return;

    try {
      let urlStr, method = engine.method || 'POST', body = null;
      const headers = { ...(engine.headers || {}), 'Content-Type': 'application/json' };

      if (engine.buildUrl) urlStr = engine.buildUrl(query, { maxResults: 5 });
      else urlStr = engine.url;

      if (method === 'POST' && engine.buildBody) {
        body = engine.buildBody(query, secret, { maxResults: 5 });
      }

      if (engine.authHeader && secret) {
        headers[engine.authHeader] = (engine.authPrefix || '') + secret;
      }

      const rawResponse = await doSearchRequest(urlStr, method, headers, body);
      const results = engine.extractResults(rawResponse);
      for (const r of results) {
        r._source = engineKey;
        allResults.push(r);
      }
    } catch {
      // Individual engine failure is non-fatal for deep research
    }
  });

  await Promise.allSettled(enginePromises);

  // Deduplicate by URL
  const seen = new Set();
  const unique = [];
  for (const r of allResults) {
    const key = r.url || r.title;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(r);
  }

  // Rank by score (if available) and take top N
  unique.sort((a, b) => (b.score || 0) - (a.score || 0));
  const topResults = unique.slice(0, maxResults);

  // Format as synthesized response
  const engineCount = new Set(topResults.map(r => r._source)).size;
  const formatted = searchConverter.formatDeepResearchResults(topResults, query, engineCount);

  async function* stream() {
    yield { type: 'message_start' };
    yield { type: 'text_delta', text: formatted };
    yield { type: 'usage', input_tokens: Math.ceil(query.length / 4), output_tokens: Math.ceil(formatted.length / 4) };
    yield { type: 'done', finish_reason: 'stop' };
    return { usage: { input_tokens: Math.ceil(query.length / 4), output_tokens: Math.ceil(formatted.length / 4) }, rawResponse: null, responseMeta: { engines: engineCount, results: topResults.length } };
  }

  return { accountId: null, stream: stream(), abort: async () => {} };
}
