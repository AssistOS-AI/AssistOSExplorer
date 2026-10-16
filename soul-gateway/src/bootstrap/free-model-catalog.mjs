/**
 * Catalog for the first-start free model defaults: the restricted provider,
 * the verified baseline of free models, and the public compatibility tiers.
 *
 * Tier child lists and per-tier timeouts come from measured requests against
 * the free catalog (first-token latency, completed answers, zero cost).
 * Models measured as unfit back no tier; see `TAG_TIER_EXCLUDED_MODEL_IDS`.
 *
 * @module bootstrap/free-model-catalog
 */

import {
    FREE_MODEL_EXECUTION_POLICY,
    FREE_ONLY_SETTING,
} from '../runtime/providers/free-model-policy.mjs';

export const FREE_PROVIDER_KEY = 'openrouter-free';

export const FREE_PROVIDER_SPEC = Object.freeze({
    providerKey: FREE_PROVIDER_KEY,
    displayName: 'OpenRouter (free models)',
    kind: 'external_api',
    adapterKey: 'openai-api',
    authStrategy: 'api_key',
    baseUrl: 'https://openrouter.ai/api/v1',
    supportsStreaming: true,
    supportsTools: true,
    settings: Object.freeze({
        [FREE_ONLY_SETTING]: true,
        discovery_path: '/models/user',
        openrouter_title: 'Ploinky Soul Gateway',
    }),
});

// Direct-model defaults written to the baseline rows. The same policy
// applies at run time to every model a sync adds to a free-only provider.
export const MODEL_RETRY_POLICY = FREE_MODEL_EXECUTION_POLICY;

/**
 * Free models that a catalog sync still stores (they stay callable as direct
 * models under the free-model execution policy) but that never join an auto
 * tag tier, because measurement showed them unfit to serve a fallback:
 *
 *   - `nvidia/nemotron-3.5-lightning:free` answered HTTP 200 and then sent no
 *     events for 45 seconds in repeated measurements.
 *   - `openrouter/free` routed a plain coding prompt to a safety classifier
 *     and returned a verdict instead of an answer.
 *
 * The sync marks such rows with `TAG_TIER_EXCLUDED_METADATA_KEY`; the tag-tier
 * code reads only that flag and knows no provider or model name.
 */
export const TAG_TIER_EXCLUDED_MODEL_IDS = Object.freeze([
    'nvidia/nemotron-3.5-lightning:free',
    'openrouter/free',
]);

function baseline(id, displayName, { vision, contextWindow }) {
    return Object.freeze({
        providerModelId: id,
        displayName,
        capabilities: Object.freeze({
            supportsTools: true,
            supportsStreaming: true,
            supportsVision: vision,
            contextWindow,
        }),
        tags: Object.freeze(
            ['free', 'tool-calling', ...(vision ? ['vision'] : [])].sort()
        ),
    });
}

export const FREE_BASELINE_MODELS = Object.freeze([
    baseline(
        'nex-agi/nex-n2.5-mini:free',
        'Nex N2.5 Mini (free)',
        { vision: true, contextWindow: 262144 }
    ),
    baseline(
        'cohere/north-mini-code:free',
        'Cohere North Mini Code (free)',
        { vision: false, contextWindow: 256000 }
    ),
    baseline(
        'liquid/lfm-2.5-2.6b:free',
        'Liquid LFM 2.5 2.6B (free)',
        { vision: false, contextWindow: 65536 }
    ),
    baseline(
        'dots-studio/dots-3-note-preview:free',
        'dots.3 Note Preview (free)',
        { vision: true, contextWindow: 512000 }
    ),
    baseline(
        'nvidia/nemotron-3-super-120b-a12b:free',
        'Nemotron 3 Super 120B (free)',
        { vision: false, contextWindow: 262144 }
    ),
    baseline(
        'nvidia/nemotron-3-ultra-550b-a55b:free',
        'Nemotron 3 Ultra 550B (free)',
        { vision: false, contextWindow: 1000000 }
    ),
    baseline(
        'nex-agi/nex-n2.5-pro:free',
        'Nex N2.5 Pro (free)',
        { vision: true, contextWindow: 262144 }
    ),
    baseline(
        'google/gemma-4-26b-a4b-it:free',
        'Gemma 4 26B A4B (free)',
        { vision: true, contextWindow: 262144 }
    ),
    baseline(
        'qwen/qwen3.8-27b:free',
        'Qwen 3.8 27B (free)',
        { vision: true, contextWindow: 262144 }
    ),
]);

const NO_REASONING = Object.freeze({ reasoning: { enabled: false } });
const LOW_REASONING = Object.freeze({ reasoning: { effort: 'low' } });

function child(providerModelId, settings = {}) {
    return Object.freeze({ providerModelId, settings: Object.freeze(settings) });
}

// `fast` disables reasoning, so its silence window and first-content cap are
// the same value.
function interactive(requestParams) {
    return {
        requestTimeoutMs: 8_000,
        retryPolicy: {
            firstEventTimeoutMs: 3_500,
            firstContentTimeoutMs: 3_500,
            streamIdleTimeoutMs: 8_000,
        },
        requestParams,
    };
}

function webAssist() {
    return { ...thorough(10_000, 30_000, 45_000), requestParams: LOW_REASONING };
}

// A reasoning child may think for a long time while it streams reasoning:
// the silence window restarts on that activity, and the first-content cap
// bounds the whole wait for its answer.
function thorough(firstEventTimeoutMs, firstContentTimeoutMs, requestTimeoutMs) {
    return {
        requestTimeoutMs,
        retryPolicy: {
            firstEventTimeoutMs,
            firstContentTimeoutMs,
            streamIdleTimeoutMs: 60_000,
        },
    };
}

/**
 * Tier definitions. `cascadeBudgetMs` caps the whole fallback walk: `fast`
 * answers or fails before a 12-second interactive deadline such as editor
 * autocomplete. `plan` also receives the shared `vision` alias, so every
 * child accepts image input; `web-assist` needs function tools, which every
 * child has.
 */
export const FREE_TIER_SPECS = Object.freeze({
    fast: Object.freeze({
        cascadeBudgetMs: 11_000,
        maxAttempts: 3,
        children: [
            child('nex-agi/nex-n2.5-mini:free', interactive(NO_REASONING)),
            child('cohere/north-mini-code:free', interactive(NO_REASONING)),
            child('liquid/lfm-2.5-2.6b:free', interactive(NO_REASONING)),
        ],
    }),
    code: Object.freeze({
        cascadeBudgetMs: 240_000,
        maxAttempts: 4,
        children: [
            child('nvidia/nemotron-3-super-120b-a12b:free', thorough(20_000, 90_000, 180_000)),
            child('cohere/north-mini-code:free', thorough(20_000, 90_000, 180_000)),
            child('nex-agi/nex-n2.5-pro:free', thorough(20_000, 90_000, 180_000)),
            child('nex-agi/nex-n2.5-mini:free', thorough(20_000, 90_000, 180_000)),
        ],
    }),
    plan: Object.freeze({
        cascadeBudgetMs: 240_000,
        maxAttempts: 4,
        children: [
            child('nex-agi/nex-n2.5-pro:free', thorough(20_000, 90_000, 180_000)),
            child('dots-studio/dots-3-note-preview:free', thorough(20_000, 90_000, 180_000)),
            child('qwen/qwen3.8-27b:free', thorough(20_000, 90_000, 180_000)),
            child('nex-agi/nex-n2.5-mini:free', thorough(20_000, 90_000, 180_000)),
        ],
    }),
    write: Object.freeze({
        cascadeBudgetMs: 240_000,
        maxAttempts: 4,
        children: [
            child('nvidia/nemotron-3-super-120b-a12b:free', thorough(20_000, 90_000, 180_000)),
            child('nex-agi/nex-n2.5-pro:free', thorough(20_000, 90_000, 180_000)),
            child('dots-studio/dots-3-note-preview:free', thorough(20_000, 90_000, 180_000)),
            child('nex-agi/nex-n2.5-mini:free', thorough(20_000, 90_000, 180_000)),
        ],
    }),
    deep: Object.freeze({
        cascadeBudgetMs: 300_000,
        maxAttempts: 4,
        children: [
            child('nvidia/nemotron-3-ultra-550b-a55b:free', thorough(30_000, 120_000, 240_000)),
            child('nvidia/nemotron-3-super-120b-a12b:free', thorough(30_000, 120_000, 240_000)),
            child('nex-agi/nex-n2.5-pro:free', thorough(30_000, 120_000, 240_000)),
            child('dots-studio/dots-3-note-preview:free', thorough(30_000, 120_000, 240_000)),
        ],
    }),
    ultra: Object.freeze({
        cascadeBudgetMs: 300_000,
        maxAttempts: 3,
        children: [
            child('nvidia/nemotron-3-ultra-550b-a55b:free', thorough(30_000, 120_000, 240_000)),
            child('nex-agi/nex-n2.5-pro:free', thorough(30_000, 120_000, 240_000)),
            child('nvidia/nemotron-3-super-120b-a12b:free', thorough(30_000, 120_000, 240_000)),
        ],
    }),
    'web-assist': Object.freeze({
        cascadeBudgetMs: 60_000,
        maxAttempts: 4,
        children: [
            child('nex-agi/nex-n2.5-mini:free', webAssist()),
            child('dots-studio/dots-3-note-preview:free', webAssist()),
            child('nex-agi/nex-n2.5-pro:free', webAssist()),
            child('google/gemma-4-26b-a4b-it:free', webAssist()),
        ],
    }),
});

// Public compatibility tier names. Auto tag tiers never claim these keys, so a
// tag that shares a name (for example `fast`) cannot pre-empt the tier.
export const PUBLIC_TIER_KEYS = Object.freeze(Object.keys(FREE_TIER_SPECS));

export function freeModelKey(providerModelId) {
    return `${FREE_PROVIDER_KEY}/${providerModelId}`;
}
