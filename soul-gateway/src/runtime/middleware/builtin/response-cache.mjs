/**
 * Built-in middleware: Response Cache
 *
 * Pre-hook: hash prompt + model, check in-memory LRU cache.
 *           On hit, abort with cached response (SyntheticResponseAbort).
 * Post-hook: store the response in cache.
 *
 * @type {import('../middleware-catalog.mjs').MiddlewareMeta}
 */

import { createHash } from 'node:crypto';

/**
 * Simple bounded LRU cache.
 * Uses a Map (insertion-ordered) with eviction on overflow.
 */
class LruCache {
  #map = new Map();
  #maxEntries;
  #ttlMs;

  constructor(maxEntries, ttlMs) {
    this.#maxEntries = maxEntries;
    this.#ttlMs = ttlMs;
  }

  get(key) {
    const entry = this.#map.get(key);
    if (!entry) return undefined;
    if (Date.now() - entry.createdAt > this.#ttlMs) {
      this.#map.delete(key);
      return undefined;
    }
    // Move to end (most-recently used)
    this.#map.delete(key);
    this.#map.set(key, entry);
    return entry.value;
  }

  set(key, value) {
    if (this.#map.has(key)) this.#map.delete(key);
    this.#map.set(key, { value, createdAt: Date.now() });
    if (this.#map.size > this.#maxEntries) {
      // Evict oldest (first key)
      const oldest = this.#map.keys().next().value;
      this.#map.delete(oldest);
    }
  }

  get size() {
    return this.#map.size;
  }

  clear() {
    this.#map.clear();
  }
}

/** Module-level cache instance (shared across all requests). */
let _cache = null;

function getCache(settings) {
  if (!_cache) {
    _cache = new LruCache(
      settings.maxEntries || 10_000,
      settings.ttlMs || 300_000,
    );
  }
  return _cache;
}

export const meta = {
  key: 'response-cache',
  name: 'Response Cache',
  description: 'In-memory LRU cache keyed by prompt hash + model. Returns cached responses for identical requests.',
  version: '1.0.0',
  defaultSettings: {
    ttlMs: 300_000,       // 5 minutes
    maxEntries: 10_000,
    hashAlgorithm: 'sha256',
  },
  hooks: 'both',
};

/**
 * Build a deterministic cache key from the request model + messages.
 */
function buildCacheKey(request, algorithm) {
  const h = createHash(algorithm);
  h.update(request.model || '');
  const messages = request.messages || [];
  for (const msg of messages) {
    h.update(msg.role || '');
    h.update(typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content || ''));
  }
  // Include temperature/top_p so different sampling params don't collide
  if (request.temperature != null) h.update(String(request.temperature));
  if (request.top_p != null) h.update(String(request.top_p));
  return h.digest('hex');
}

/**
 * Pre-hook: check cache, abort with synthetic response on hit.
 * @param {Object} ctx
 * @param {Object} settings
 */
export async function pre(ctx, settings) {
  const cache = getCache(settings);
  const key = buildCacheKey(ctx.request, settings.hashAlgorithm || 'sha256');

  // Stash the key in request-scoped middleware state for the post-hook to use.
  if (ctx.state?.set) {
    ctx.state.set('response-cache:key', key);
  }

  const cached = cache.get(key);
  if (cached) {
    ctx.log.debug('Response cache hit', { cacheKey: key.slice(0, 12) });
    ctx.abort.success(cached);
    // abort.success throws — control never reaches here
  }
}

/**
 * Post-hook: store the response in cache.
 * @param {Object} ctx
 * @param {Object} settings
 */
export async function post(ctx, settings) {
  if (!ctx.response) return;

  const cache = getCache(settings);
  const key = ctx.state?.get ? ctx.state.get('response-cache:key') : null;
  if (!key) return;

  cache.set(key, ctx.response);
  ctx.log.debug('Response cached', { cacheKey: key.slice(0, 12) });
}

/** Exposed for testing. */
export function _resetCache() {
  if (_cache) _cache.clear();
  _cache = null;
}

export function _getCacheInstance() {
  return _cache;
}
