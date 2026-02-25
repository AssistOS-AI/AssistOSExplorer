/**
 * OpenRouter pricing fallback.
 * Fetches and caches the full OpenRouter model list, providing
 * a lookup by model ID (exact or suffix match) for input/output pricing.
 * Prices are returned as $/1M tokens.
 */

const OPENROUTER_MODELS_URL = 'https://openrouter.ai/api/v1/models';
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

let cachedPriceMap = null;
let cacheTimestamp = 0;
let fetchPromise = null;

/**
 * Fetch the full OpenRouter model list and build a price map.
 * Returns Map<modelId, { input_price, output_price }> ($/1M tokens).
 */
async function fetchOpenRouterPricing() {
  try {
    const resp = await fetch(OPENROUTER_MODELS_URL, {
      signal: AbortSignal.timeout(15000),
    });
    if (!resp.ok) return new Map();
    const data = await resp.json();
    const models = data.data || [];
    const priceMap = new Map();
    for (const m of models) {
      if (!m.id) continue;
      let input_price = 0, output_price = 0;
      if (m.pricing?.prompt) input_price = parseFloat(m.pricing.prompt) * 1_000_000;
      if (m.pricing?.completion) output_price = parseFloat(m.pricing.completion) * 1_000_000;
      input_price = Math.round(input_price * 1000) / 1000;
      output_price = Math.round(output_price * 1000) / 1000;
      if (input_price || output_price) {
        priceMap.set(m.id, { input_price, output_price });
      }
    }
    return priceMap;
  } catch {
    return new Map();
  }
}

/**
 * Get the cached price map, refreshing if stale.
 * Deduplicates concurrent fetches.
 */
async function getPriceMap() {
  if (cachedPriceMap && (Date.now() - cacheTimestamp) < CACHE_TTL_MS) {
    return cachedPriceMap;
  }
  if (!fetchPromise) {
    fetchPromise = fetchOpenRouterPricing().then(map => {
      cachedPriceMap = map;
      cacheTimestamp = Date.now();
      fetchPromise = null;
      return map;
    }).catch(() => {
      fetchPromise = null;
      return cachedPriceMap || new Map();
    });
  }
  return fetchPromise;
}

/**
 * Look up pricing for a model ID.
 * Tries exact match first, then suffix match (e.g. "gemini-2.5-pro"
 * matches "google/gemini-2.5-pro" on OpenRouter).
 * Returns { input_price, output_price } or null.
 */
export async function lookupOpenRouterPricing(modelId) {
  const priceMap = await getPriceMap();
  // Exact match (e.g. "google/gemini-2.5-pro")
  if (priceMap.has(modelId)) return priceMap.get(modelId);
  // Suffix match: find an OpenRouter ID that ends with /modelId
  for (const [key, val] of priceMap) {
    if (key.endsWith('/' + modelId)) return val;
  }
  return null;
}

/**
 * Batch-enrich an array of model objects in-place.
 * Only touches models where input_price === 0 && output_price === 0.
 * Each model object should have { id, input_price, output_price }.
 */
export async function enrichWithOpenRouterPricing(models) {
  const needsPricing = models.filter(m => m.input_price === 0 && m.output_price === 0);
  if (needsPricing.length === 0) return;
  const priceMap = await getPriceMap();
  for (const m of needsPricing) {
    // Try exact match
    let price = priceMap.get(m.id);
    // Try suffix match
    if (!price) {
      for (const [key, val] of priceMap) {
        if (key.endsWith('/' + m.id)) { price = val; break; }
      }
    }
    if (price) {
      m.input_price = price.input_price;
      m.output_price = price.output_price;
    }
  }
}
