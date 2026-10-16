/**
 * Built-in middleware: Response Cache
 *
 * Caches buffered responses by request hash and short-circuits on hits.
 */

import { createHash } from 'node:crypto';
import { abortSuccess } from '../../kernel/abort.mjs';
import {
    createCanonicalStream,
    isCanonicalStream,
} from '../../kernel/canonical-stream.mjs';

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
let _cacheConfig = null;

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
            merged.hashAlgorithm || 'sha256',
            ctx.route?.kind || ctx.route?.format || 'openai_chat'
        );

        if (ctx.state?.set) {
            ctx.state.set('response-cache:key', key);
        }

        const cached = cache.get(key);
        if (cached) {
            ctx.metadata.cacheHit = true;
            ctx.log.debug('Response cache hit', { cacheKey: key.slice(0, 12) });
            abortSuccess(ctx, materializeCacheEntry(cached));
        }

        ctx.metadata.cacheHit = false;
        await next();

        if (!ctx.response) {
            return;
        }

        const streamed = wrapStreamingResponse(ctx.response, cache, key, ctx.log);
        if (streamed) {
            ctx.response = streamed;
            return;
        }

        const response = cloneForCache(ctx.response);
        if (response) {
            cache.set(key, { kind: 'buffered', response });
            ctx.log.debug('Response cached', { cacheKey: key.slice(0, 12) });
        }
    };
}

function getCache(settings) {
    const maxEntries = settings.maxEntries || 10_000;
    const ttlMs = settings.ttlMs || 300_000;
    if (
        !_cache ||
        !_cacheConfig ||
        _cacheConfig.maxEntries !== maxEntries ||
        _cacheConfig.ttlMs !== ttlMs
    ) {
        _cache = new LruCache(maxEntries, ttlMs);
        _cacheConfig = { maxEntries, ttlMs };
    }
    return _cache;
}

function buildCacheKey(request, algorithm, routeKind) {
    const hash = createHash(algorithm);
    hash.update(stableStringify({ routeKind, request }));
    return hash.digest('hex');
}

function wrapStreamingResponse(response, cache, key, log) {
    if (isCanonicalStream(response)) {
        return createCanonicalStream(
            cacheStreamEvents(response, cache, key, log, {
                kind: 'stream',
                meta: cloneForCache(response.meta || {}),
            }),
            response.meta || {}
        );
    }

    if (response?.stream && isCanonicalStream(response.stream)) {
        const envelope = cloneForCache({ ...response, stream: null });
        return {
            ...response,
            stream: createCanonicalStream(
                cacheStreamEvents(response.stream, cache, key, log, {
                    kind: 'stream-envelope',
                    meta: cloneForCache(response.stream.meta || {}),
                    envelope,
                }),
                response.stream.meta || {}
            ),
        };
    }

    return null;
}

async function* cacheStreamEvents(stream, cache, key, log, entryBase) {
    const events = [];
    let completed = false;
    try {
        for await (const event of stream) {
            const snapshot = cloneForCache(event);
            if (snapshot) {
                events.push(snapshot);
            }
            yield event;
        }
        completed = true;
    } finally {
        if (completed) {
            cache.set(key, { ...entryBase, events });
            log?.debug?.('Response stream cached', {
                cacheKey: key.slice(0, 12),
                events: events.length,
            });
        }
    }
}

function materializeCacheEntry(entry) {
    if (!entry || typeof entry !== 'object') {
        return cloneForCache(entry);
    }

    if (entry.kind === 'buffered') {
        return cloneForCache(entry.response);
    }

    if (entry.kind === 'stream') {
        return createCanonicalStream(replayEvents(entry.events), entry.meta || {});
    }

    if (entry.kind === 'stream-envelope') {
        return {
            ...(cloneForCache(entry.envelope) || {}),
            stream: createCanonicalStream(replayEvents(entry.events), entry.meta || {}),
        };
    }

    return cloneForCache(entry);
}

async function* replayEvents(events = []) {
    for (const event of events) {
        yield cloneForCache(event);
    }
}

function cloneForCache(value) {
    if (value == null) return value;
    try {
        return JSON.parse(JSON.stringify(value));
    } catch {
        return null;
    }
}

function stableStringify(value) {
    if (value === null || typeof value !== 'object') {
        return JSON.stringify(value);
    }
    if (Array.isArray(value)) {
        return `[${value.map(stableStringify).join(',')}]`;
    }
    const keys = Object.keys(value).sort();
    return `{${keys
        .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
        .join(',')}}`;
}

export function _resetCache() {
    if (_cache) {
        _cache.clear();
    }
    _cache = null;
    _cacheConfig = null;
}

export function _getCacheInstance() {
    return _cache;
}
