/**
 * External pricing directory.
 *
 * Fetches model pricing from an external API (e.g. OpenRouter /api/v1/models)
 * and caches it for a configurable interval. Graceful failure — if the fetch
 * fails, the directory continues with whatever it last had.
 */

const DEFAULT_REFRESH_MS = 21_600_000; // 6 hours

export class PricingDirectory {
    /**
     * @param {{ refreshIntervalMs?: number, log?: object }} [opts]
     */
    constructor(opts = {}) {
        this._refreshMs = opts.refreshIntervalMs ?? DEFAULT_REFRESH_MS;
        this._log = opts.log ?? null;
        /** @type {Map<string, { inputPricePerMillion: number, outputPricePerMillion: number }>} */
        this._prices = new Map();
        this._lastFetchedAt = 0;
        this._url = null;
    }

    /**
     * Fetch pricing data from an external URL.
     *
     * Expected response format (OpenRouter-style):
     * ```json
     * { "data": [{ "id": "openai/gpt-4", "pricing": { "prompt": "0.00003", "completion": "0.00006" } }] }
     * ```
     *
     * @param {string} url
     */
    async load(url, log = null) {
        this._url = url;
        const isInitial = this._prices.size === 0;
        try {
            const res = await fetch(url);
            if (!res.ok) {
                const msg = `pricing directory fetch failed: HTTP ${res.status}`;
                if (isInitial) throw new Error(msg);
                if (log) log.warn(msg, { url, status: res.status });
                return;
            }

            const body = await res.json();
            const models = body.data || body.models || [];

            const newPrices = new Map();
            for (const m of models) {
                if (!m.id || !m.pricing) continue;

                const promptPrice = parseFloat(m.pricing.prompt);
                const completionPrice = parseFloat(m.pricing.completion);

                if (isNaN(promptPrice) || isNaN(completionPrice)) continue;

                // OpenRouter prices are per-token; convert to per-million
                newPrices.set(m.id, {
                    inputPricePerMillion: promptPrice * 1_000_000,
                    outputPricePerMillion: completionPrice * 1_000_000,
                });
            }

            this._prices = newPrices;
            this._lastFetchedAt = Date.now();
        } catch (err) {
            if (isInitial) throw err;
            if (log) {
                log.error('pricing directory refresh failed', {
                    url,
                    error: err.message,
                });
            }
        }
    }

    /**
     * Look up pricing for a specific provider/model combination.
     *
     * Tries multiple key formats:
     *   1. "{providerKey}/{modelId}" (e.g. "openai/gpt-4")
     *   2. "{modelId}" alone
     *
     * @param {string} providerKey
     * @param {string} modelId
     * @returns {{ inputPricePerMillion: number, outputPricePerMillion: number } | null}
     */
    lookup(providerKey, modelId) {
        // Try provider/model format first
        const fullKey = `${providerKey}/${modelId}`;
        if (this._prices.has(fullKey)) return this._prices.get(fullKey);

        // Try model ID alone
        if (this._prices.has(modelId)) return this._prices.get(modelId);

        return null;
    }

    /**
     * Whether the directory needs a refresh.
     */
    get isStale() {
        if (!this._url) return false;
        return Date.now() - this._lastFetchedAt >= this._refreshMs;
    }

    /**
     * Number of models in the directory.
     */
    get size() {
        return this._prices.size;
    }
}
