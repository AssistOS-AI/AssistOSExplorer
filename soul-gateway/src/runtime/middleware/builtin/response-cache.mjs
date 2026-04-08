/**
 * Built-in middleware: Response Cache
 *
 * Caches buffered responses by request hash and short-circuits on hits.
 */

import { createHash } from 'node:crypto';
import { abortSuccess } from '../../kernel/abort.mjs';

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
        this.#map.delete(key);
        this.#map.set(key, entry);
        return entry.value;
    }

    set(key, value) {
        if (this.#map.has(key)) {
            this.#map.delete(key);
        }
        this.#map.set(key, { value, createdAt: Date.now() });
        if (this.#map.size > this.#maxEntries) {
            const oldest = this.#map.keys().next().value;
            this.#map.delete(oldest);
        }
    }

    clear() {
        this.#map.clear();
    }

    get size() {
        return this.#map.size;
    }
}

let _cache = null;

export const meta = Object.freeze({
    key: 'response-cache',
    name: 'Response Cache',
    description:
        'In-memory LRU cache keyed by prompt hash + model. Returns cached responses for identical requests.',
    version: '2.0.0',
    scope: 'gateway',
    defaultSettings: Object.freeze({
        ttlMs: 300_000,
        maxEntries: 10_000,
        hashAlgorithm: 'sha256',
    }),
});

export function factory(settings = {}) {
    const merged = { ...meta.defaultSettings, ...settings };
    const cache = getCache(merged);

    return async function responseCache(ctx, next) {
        const key = buildCacheKey(
            ctx.request || {},
            merged.hashAlgorithm || 'sha256'
        );

        if (ctx.state?.set) {
            ctx.state.set('response-cache:key', key);
        }

        const cached = cache.get(key);
        if (cached) {
            ctx.log.debug('Response cache hit', { cacheKey: key.slice(0, 12) });
            abortSuccess(ctx, cached);
        }

        await next();

        if (!ctx.response) {
            return;
        }

        cache.set(key, ctx.response);
        ctx.log.debug('Response cached', { cacheKey: key.slice(0, 12) });
    };
}

function getCache(settings) {
    if (!_cache) {
        _cache = new LruCache(
            settings.maxEntries || 10_000,
            settings.ttlMs || 300_000
        );
    }
    return _cache;
}

function buildCacheKey(request, algorithm) {
    const hash = createHash(algorithm);
    hash.update(request.model || '');
    const messages = request.messages || [];
    for (const message of messages) {
        hash.update(message.role || '');
        hash.update(
            typeof message.content === 'string'
                ? message.content
                : JSON.stringify(message.content || '')
        );
    }
    if (request.temperature != null) hash.update(String(request.temperature));
    if (request.top_p != null) hash.update(String(request.top_p));
    return hash.digest('hex');
}

export function _resetCache() {
    if (_cache) {
        _cache.clear();
    }
    _cache = null;
}

export function _getCacheInstance() {
    return _cache;
}
