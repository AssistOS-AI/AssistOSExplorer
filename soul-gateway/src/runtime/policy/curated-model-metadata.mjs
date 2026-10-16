/**
 * Curated model-metadata fallback.
 *
 * This static table captures gateway-specific billing semantics and a
 * small set of exact-model price/context overrides that are not reliably
 * available from provider `/models` responses or the OpenRouter catalog.
 *
 * The data is intentionally explicit and reviewable:
 * - provider-level free-model rules where the legacy product was uniform
 * - exact-model overrides for rows that carried real numeric prices or
 *   context in the legacy baseline
 *
 * This module is pure. It does not fetch, read files, or consult the DB.
 */

export const CURATED_FREE_PROVIDER_KEYS = Object.freeze([
    'nvidia',
]);

export const CURATED_MODEL_METADATA = Object.freeze({
    'copilot/gpt-4.1-mini': Object.freeze({
        isFree: true,
    }),
    'copilot/gpt-4.1': Object.freeze({
        isFree: true,
        contextWindow: 1_000_000,
    }),
    'copilot/gpt-4o': Object.freeze({
        isFree: true,
        contextWindow: 128_000,
    }),
    'copilot/gpt-4o-mini': Object.freeze({
        isFree: true,
        contextWindow: 128_000,
    }),
    'copilot/gpt-5-mini': Object.freeze({
        isFree: true,
        contextWindow: 128_000,
    }),
    'mistral/codestral-latest': Object.freeze({
        isFree: true,
        inputPricePerMillion: 0.3,
        outputPricePerMillion: 0.9,
    }),
    'nvidia/google/gemma-2-27b-it': Object.freeze({
        isFree: true,
        inputPricePerMillion: 0.65,
        outputPricePerMillion: 0.65,
    }),
    'nvidia/google/gemma-3-12b-it': Object.freeze({
        isFree: true,
        inputPricePerMillion: 0.04,
        outputPricePerMillion: 0.13,
    }),
    'nvidia/google/gemma-3-27b-it': Object.freeze({
        isFree: true,
        inputPricePerMillion: 0.08,
        outputPricePerMillion: 0.16,
    }),
    'nvidia/google/gemma-3-4b-it': Object.freeze({
        isFree: true,
        inputPricePerMillion: 0.04,
        outputPricePerMillion: 0.08,
    }),
    'nvidia/google/gemma-3n-e4b-it': Object.freeze({
        isFree: true,
        inputPricePerMillion: 0.02,
        outputPricePerMillion: 0.04,
    }),
    'nvidia/mistralai/mistral-large': Object.freeze({
        isFree: true,
        inputPricePerMillion: 2,
        outputPricePerMillion: 6,
    }),
    'nvidia/nvidia/llama-3.1-nemotron-70b-instruct': Object.freeze({
        isFree: true,
        inputPricePerMillion: 1.2,
        outputPricePerMillion: 1.2,
    }),
    'nvidia/nvidia/llama-3.3-nemotron-super-49b-v1.5': Object.freeze({
        isFree: true,
        inputPricePerMillion: 0.1,
        outputPricePerMillion: 0.4,
    }),
    'nvidia/nvidia/nemotron-3-nano-30b-a3b': Object.freeze({
        isFree: true,
        inputPricePerMillion: 0.05,
        outputPricePerMillion: 0.2,
    }),
    'nvidia/nvidia/nemotron-3-super-120b-a12b': Object.freeze({
        isFree: true,
        inputPricePerMillion: 0.1,
        outputPricePerMillion: 0.5,
    }),
    'nvidia/nvidia/nemotron-nano-12b-v2-vl': Object.freeze({
        isFree: true,
        inputPricePerMillion: 0.2,
        outputPricePerMillion: 0.6,
    }),
    'nvidia/openai/gpt-oss-120b': Object.freeze({
        isFree: true,
        inputPricePerMillion: 0.039,
        outputPricePerMillion: 0.19,
    }),
    'nvidia/openai/gpt-oss-20b': Object.freeze({
        isFree: true,
        inputPricePerMillion: 0.03,
        outputPricePerMillion: 0.14,
    }),
    'nvidia/qwen/qwen3-next-80b-a3b-instruct': Object.freeze({
        isFree: true,
        inputPricePerMillion: 0.09,
        outputPricePerMillion: 1.1,
    }),
    'nvidia/qwen/qwen3-next-80b-a3b-thinking': Object.freeze({
        isFree: true,
        inputPricePerMillion: 0.098,
        outputPricePerMillion: 0.78,
    }),
    'nvidia/qwen/qwen3.5-122b-a10b': Object.freeze({
        isFree: true,
        inputPricePerMillion: 0.26,
        outputPricePerMillion: 2.08,
    }),
    'nvidia/qwen/qwen3.5-397b-a17b': Object.freeze({
        isFree: true,
        inputPricePerMillion: 0.39,
        outputPricePerMillion: 2.34,
    }),
});

function resolveModelKey(envelope) {
    if (typeof envelope?.modelKey === 'string' && envelope.modelKey.length > 0) {
        return envelope.modelKey;
    }
    if (
        typeof envelope?.providerKey === 'string' &&
        envelope.providerKey.length > 0 &&
        typeof envelope?.providerModelId === 'string' &&
        envelope.providerModelId.length > 0
    ) {
        return `${envelope.providerKey}/${envelope.providerModelId}`;
    }
    return null;
}

/**
 * Resolve curated metadata for a canonical enrichment envelope.
 *
 * Returns `null` when no provider-level or exact-model override applies.
 */
export function lookupCuratedModelMetadata(envelope) {
    if (!envelope || typeof envelope !== 'object') {
        throw new Error('lookupCuratedModelMetadata requires an envelope object');
    }

    const providerKey =
        typeof envelope.providerKey === 'string' ? envelope.providerKey : null;
    const modelKey = resolveModelKey(envelope);
    const exact = modelKey ? CURATED_MODEL_METADATA[modelKey] || null : null;
    const appliedRules = [];
    const result = {};

    if (providerKey && CURATED_FREE_PROVIDER_KEYS.includes(providerKey)) {
        result.isFree = true;
        appliedRules.push(`provider:${providerKey}`);
    }

    if (exact) {
        if (exact.isFree === true) {
            result.isFree = true;
        }
        if (exact.inputPricePerMillion !== undefined) {
            result.inputPricePerMillion = exact.inputPricePerMillion;
        }
        if (exact.outputPricePerMillion !== undefined) {
            result.outputPricePerMillion = exact.outputPricePerMillion;
        }
        if (exact.requestPriceUsd !== undefined) {
            result.requestPriceUsd = exact.requestPriceUsd;
        }
        if (exact.contextWindow !== undefined) {
            result.contextWindow = exact.contextWindow;
        }
        if (Array.isArray(exact.tags) && exact.tags.length > 0) {
            result.tags = [...exact.tags];
        }
        appliedRules.push(`model:${modelKey}`);
    }

    if (appliedRules.length === 0) {
        return null;
    }

    return {
        ...result,
        provenance: {
            source: 'curated-model-metadata',
            appliedRules,
            matchedBy:
                exact && providerKey && CURATED_FREE_PROVIDER_KEYS.includes(providerKey)
                    ? 'provider_rule+exact_model'
                    : exact
                      ? 'exact_model'
                      : 'provider_rule',
            modelKey,
        },
    };
}
