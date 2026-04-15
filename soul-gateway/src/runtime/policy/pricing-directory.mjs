/**
 * External pricing / model-metadata directory.
 *
 * The directory is sourced from an OpenRouter-style `/models` response and is
 * shared by:
 * - request-time external-directory pricing lookup
 * - provider model auto-provisioning fallback when upstream discovery omits
 *   pricing / context / tags
 * - management list responses that need to overlay missing metadata onto
 *   already-persisted rows
 */

export const DEFAULT_PRICING_DIRECTORY_URL =
    'https://openrouter.ai/api/v1/models';

const DEFAULT_REFRESH_MS = 21_600_000; // 6 hours

/**
 * Curated rewrite rules for provider model ids whose namespace differs
 * from the upstream OpenRouter catalog. Matching stays strict: each entry
 * rewrites an input id to one (and only one) additional candidate, and
 * the rewritten candidate still has to match an entry in the directory
 * via `id` or `canonical_slug` — adversarial inputs like
 * `nvidia/nonexistent-model` stay unresolved.
 *
 * Do not add fuzzy/regex-wildcard rules here. Every entry must correspond
 * to a concrete gateway provider and a known upstream namespace.
 */
export const OPENROUTER_ALIAS_REWRITERS = Object.freeze([
    // NVIDIA's API Catalog uses vendor sub-namespaces that do not match
    // OpenRouter's. Rewrites so the provider-supplied id resolves.
    {
        providerKey: 'nvidia',
        match: /^meta\//,
        replace: 'meta-llama/',
    },
    {
        providerKey: 'nvidia',
        match: /^deepseek-ai\//,
        replace: 'deepseek/',
    },
    {
        providerKey: 'nvidia',
        match: /^mistralai\//,
        replace: 'mistralai/',
    },
    // Codex-API providers dispense OpenAI models under their own key.
    {
        providerKey: 'codex-api',
        match: /^/,
        prepend: 'openai/',
    },
    // GitHub Copilot vends a mix of OpenAI, Anthropic, and Google models.
    // Prefix rules are strict so an unknown Copilot model stays
    // unresolved instead of silently landing on the wrong vendor.
    {
        providerKey: 'copilot',
        match: /^gpt-/,
        prepend: 'openai/',
    },
    {
        providerKey: 'copilot',
        match: /^o[134]/,
        prepend: 'openai/',
    },
    {
        providerKey: 'copilot',
        match: /^claude-/,
        prepend: 'anthropic/',
    },
    {
        providerKey: 'copilot',
        match: /^gemini-/,
        prepend: 'google/',
    },
]);

/**
 * Generate deterministic alias candidates for `(providerKey, modelId)`.
 * Each candidate is a fully-qualified canonical id string that the
 * directory's index will either match exactly or reject. Returns an
 * empty array when no rewriter applies.
 */
export function generateOpenRouterAliasCandidates(providerKey, modelId) {
    if (typeof providerKey !== 'string' || typeof modelId !== 'string') {
        return [];
    }
    const out = new Set();
    for (const rule of OPENROUTER_ALIAS_REWRITERS) {
        if (rule.providerKey !== providerKey) continue;
        if (rule.match && !rule.match.test(modelId)) continue;
        if (typeof rule.prepend === 'string') {
            out.add(`${rule.prepend}${modelId}`);
        } else if (typeof rule.replace === 'string' && rule.match) {
            out.add(modelId.replace(rule.match, rule.replace));
        }
    }
    return [...out];
}

function parseOptionalNumber(value) {
    if (value === undefined || value === null || value === '') {
        return null;
    }
    const numeric = Number(value);
    return Number.isFinite(numeric) ? numeric : null;
}

function parsePerMillionPrice(value) {
    const numeric = parseOptionalNumber(value);
    return numeric === null ? null : Number((numeric * 1_000_000).toFixed(12));
}

function normalizeLookupKey(value) {
    if (typeof value !== 'string') {
        return null;
    }
    const normalized = value.trim().toLowerCase();
    return normalized.length > 0 ? normalized : null;
}

function getLeafSlug(value) {
    if (typeof value !== 'string' || value.length === 0) {
        return null;
    }
    const parts = value.split('/');
    const slug = parts[parts.length - 1] || '';
    return slug || null;
}

function addUniqueIndex(index, rawKey, entry) {
    const key = normalizeLookupKey(rawKey);
    if (!key) {
        return;
    }
    if (!index.has(key)) {
        index.set(key, entry);
        return;
    }
    if (index.get(key) === entry) {
        return;
    }
    index.set(key, null);
}

function detectPricingMode({
    inputPricePerMillion,
    outputPricePerMillion,
    requestPriceUsd,
}) {
    const hasTokenPricing =
        inputPricePerMillion !== null || outputPricePerMillion !== null;
    const hasRequestPricing = requestPriceUsd !== null;

    const tokenPricesZero =
        (inputPricePerMillion === null || inputPricePerMillion === 0) &&
        (outputPricePerMillion === null || outputPricePerMillion === 0);
    const requestPriceZero =
        requestPriceUsd === null || requestPriceUsd === 0;

    if ((hasTokenPricing || hasRequestPricing) && tokenPricesZero && requestPriceZero) {
        return 'free';
    }
    if (hasTokenPricing) {
        return 'token';
    }
    if (hasRequestPricing) {
        return 'request';
    }
    return 'external_directory';
}

function buildDirectoryTags(model, pricingMode) {
    const tags = new Set();
    const architecture = model?.architecture || {};
    const inputModalities = Array.isArray(architecture.input_modalities)
        ? architecture.input_modalities
        : [];
    const outputModalities = Array.isArray(architecture.output_modalities)
        ? architecture.output_modalities
        : [];
    const supportedParameters = Array.isArray(model?.supported_parameters)
        ? model.supported_parameters
        : [];

    if (
        inputModalities.includes('image') ||
        outputModalities.includes('image')
    ) {
        tags.add('vision');
    }
    if (
        inputModalities.includes('audio') ||
        outputModalities.includes('audio')
    ) {
        tags.add('audio');
    }
    if (
        supportedParameters.includes('tools') ||
        supportedParameters.includes('tool_choice')
    ) {
        tags.add('tool-calling');
    }
    if (
        supportedParameters.includes('structured_outputs') ||
        supportedParameters.includes('response_format')
    ) {
        tags.add('structured-outputs');
    }
    if (model?.top_provider?.is_moderated === true) {
        tags.add('moderated');
    }
    if (pricingMode === 'free') {
        tags.add('free');
    }

    return [...tags].sort();
}

function buildDirectoryEntry(model) {
    if (!model?.id) {
        return null;
    }

    const inputPricePerMillion = parsePerMillionPrice(model?.pricing?.prompt);
    const outputPricePerMillion = parsePerMillionPrice(
        model?.pricing?.completion
    );
    const requestPriceUsd = parseOptionalNumber(model?.pricing?.request);
    const pricingMode = detectPricingMode({
        inputPricePerMillion,
        outputPricePerMillion,
        requestPriceUsd,
    });

    const architecture = model?.architecture || {};
    const inputModalities = Array.isArray(architecture.input_modalities)
        ? architecture.input_modalities
        : [];
    const outputModalities = Array.isArray(architecture.output_modalities)
        ? architecture.output_modalities
        : [];
    const supportedParameters = Array.isArray(model?.supported_parameters)
        ? model.supported_parameters
        : [];

    return {
        id: model.id,
        canonicalSlug: model.canonical_slug || null,
        displayName: model.name || model.id,
        description: model.description || null,
        pricingMode,
        inputPricePerMillion,
        outputPricePerMillion,
        requestPriceUsd,
        isFree: pricingMode === 'free',
        contextWindow:
            parseOptionalNumber(model.context_length) ??
            parseOptionalNumber(model?.top_provider?.context_length),
        maxOutputTokens:
            parseOptionalNumber(model?.top_provider?.max_completion_tokens) ??
            parseOptionalNumber(model.max_completion_tokens) ??
            parseOptionalNumber(model.max_output_tokens),
        supportsTools:
            supportedParameters.length > 0
                ? supportedParameters.includes('tools') ||
                  supportedParameters.includes('tool_choice')
                : null,
        supportsVision:
            inputModalities.includes('image') ||
            outputModalities.includes('image'),
        tags: buildDirectoryTags(model, pricingMode),
    };
}

export class PricingDirectory {
    /**
     * @param {{ url?: string|null, refreshIntervalMs?: number, log?: object }} [opts]
     */
    constructor(opts = {}) {
        this._refreshMs = opts.refreshIntervalMs ?? DEFAULT_REFRESH_MS;
        this._log = opts.log ?? null;
        this._url = opts.url ?? null;
        this._entries = new Map();
        this._entriesById = new Map();
        this._entriesByCanonicalSlug = new Map();
        this._entriesByUniqueName = new Map();
        this._entriesByUniqueLeafSlug = new Map();
        this._lastFetchedAt = 0;
        this._refreshPromise = null;
    }

    /**
     * Fetch pricing / metadata data from an external URL.
     *
     * Expected response format (OpenRouter-style):
     * ```json
     * {
     *   "data": [
     *     {
     *       "id": "openai/gpt-4",
     *       "name": "GPT-4",
     *       "context_length": 8192,
     *       "pricing": { "prompt": "0.00003", "completion": "0.00006" }
     *     }
     *   ]
     * }
     * ```
     *
     * @param {string} url
     */
    async load(url, log = null) {
        this._url = url;
        const logger = log || this._log;
        const isInitial = this._entries.size === 0;
        try {
            const res = await fetch(url);
            if (!res.ok) {
                const msg = `pricing directory fetch failed: HTTP ${res.status}`;
                if (isInitial) {
                    throw new Error(msg);
                }
                if (logger) {
                    logger.warn(msg, { url, status: res.status });
                }
                return;
            }

            const body = await res.json();
            const models = body.data || body.models || [];

            const newEntries = new Map();
            const idIndex = new Map();
            const canonicalIndex = new Map();
            const nameIndex = new Map();
            const leafSlugIndex = new Map();

            for (const model of models) {
                const entry = buildDirectoryEntry(model);
                if (!entry) {
                    continue;
                }

                const idKey = normalizeLookupKey(entry.id);
                if (idKey) {
                    idIndex.set(idKey, entry);
                }
                addUniqueIndex(canonicalIndex, entry.canonicalSlug, entry);
                addUniqueIndex(nameIndex, entry.displayName, entry);
                addUniqueIndex(leafSlugIndex, getLeafSlug(entry.id), entry);
                addUniqueIndex(
                    leafSlugIndex,
                    getLeafSlug(entry.canonicalSlug),
                    entry
                );
                newEntries.set(entry.id, entry);
            }

            this._entries = newEntries;
            this._entriesById = idIndex;
            this._entriesByCanonicalSlug = canonicalIndex;
            this._entriesByUniqueName = nameIndex;
            this._entriesByUniqueLeafSlug = leafSlugIndex;
            this._lastFetchedAt = Date.now();
        } catch (err) {
            if (isInitial) {
                throw err;
            }
            if (logger) {
                logger.error('pricing directory refresh failed', {
                    url,
                    error: err.message,
                });
            }
        }
    }

    async refreshIfNeeded(log = null, { force = false } = {}) {
        if (!this._url) {
            return this;
        }
        if (!force && this._entries.size > 0 && !this.isStale) {
            return this;
        }
        if (this._refreshPromise) {
            return this._refreshPromise;
        }
        this._refreshPromise = this.load(this._url, log).finally(() => {
            this._refreshPromise = null;
        });
        await this._refreshPromise;
        return this;
    }

    lookup(providerKey, modelId) {
        const entry = this.lookupModel(providerKey, modelId);
        if (!entry) {
            return null;
        }
        return {
            pricingMode: entry.pricingMode,
            inputPricePerMillion: entry.inputPricePerMillion,
            outputPricePerMillion: entry.outputPricePerMillion,
            requestPriceUsd: entry.requestPriceUsd,
            isFree: entry.isFree,
        };
    }

    lookupModel(providerKey, modelId, { modelKey = null, displayName = null } = {}) {
        const exactCandidates = [];
        if (providerKey && modelId) {
            exactCandidates.push(`${providerKey}/${modelId}`);
        }
        if (modelId) {
            exactCandidates.push(modelId);
        }
        if (modelKey) {
            exactCandidates.push(modelKey);
        }
        if (displayName) {
            exactCandidates.push(displayName);
        }

        for (const candidate of exactCandidates) {
            const key = normalizeLookupKey(candidate);
            if (!key) {
                continue;
            }
            const idMatch = this._entriesById.get(key);
            if (idMatch) {
                return { ...idMatch, matchedBy: 'id' };
            }
            const canonicalMatch = this._entriesByCanonicalSlug.get(key);
            if (canonicalMatch) {
                return { ...canonicalMatch, matchedBy: 'canonical_slug' };
            }
            const nameMatch = this._entriesByUniqueName.get(key);
            if (nameMatch) {
                return { ...nameMatch, matchedBy: 'name' };
            }
        }

        // Curated alias candidates — only resolve when the rewritten id
        // is itself an exact id/canonical_slug match, so adversarial
        // inputs stay unresolved.
        const aliasCandidates = [];
        if (providerKey && modelId) {
            aliasCandidates.push(
                ...generateOpenRouterAliasCandidates(providerKey, modelId)
            );
        }
        if (providerKey && modelKey) {
            const leafModelKey = getLeafSlug(modelKey);
            if (leafModelKey && leafModelKey !== modelId) {
                aliasCandidates.push(
                    ...generateOpenRouterAliasCandidates(
                        providerKey,
                        leafModelKey
                    )
                );
            }
        }
        for (const candidate of aliasCandidates) {
            const key = normalizeLookupKey(candidate);
            if (!key) {
                continue;
            }
            const idMatch = this._entriesById.get(key);
            if (idMatch) {
                return { ...idMatch, matchedBy: 'alias' };
            }
            const canonicalMatch = this._entriesByCanonicalSlug.get(key);
            if (canonicalMatch) {
                return { ...canonicalMatch, matchedBy: 'alias' };
            }
        }

        const slugCandidates = new Set();
        if (modelId) {
            slugCandidates.add(getLeafSlug(modelId));
        }
        if (modelKey) {
            slugCandidates.add(getLeafSlug(modelKey));
        }

        for (const slug of slugCandidates) {
            const key = normalizeLookupKey(slug);
            if (!key) {
                continue;
            }
            const slugMatch = this._entriesByUniqueLeafSlug.get(key);
            if (slugMatch) {
                return { ...slugMatch, matchedBy: 'leaf_slug' };
            }
        }

        return null;
    }

    get isStale() {
        if (!this._url) {
            return false;
        }
        if (this._entries.size === 0) {
            return true;
        }
        return Date.now() - this._lastFetchedAt >= this._refreshMs;
    }

    get size() {
        return this._entries.size;
    }

    get url() {
        return this._url;
    }
}
