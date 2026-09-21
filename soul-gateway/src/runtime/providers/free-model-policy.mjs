/**
 * Free-only provider policy.
 *
 * A provider whose `settings.free_only` is `true` may only discover and
 * execute models that are provably free.  The policy is provider-scoped:
 * other OpenAI-compatible providers are unaffected.
 *
 * Three layers enforce it, and none replaces the upstream account limits
 * (a zero credit limit and a model allowlist on the key):
 *
 *   1. Catalog admission (`isStrictlyFreeCatalogEntry`): a discovered entry
 *      needs an approved free ID form, explicit zero prompt and completion
 *      prices, zero for every other billable dimension that is present, and
 *      declared text chat input and output modalities.
 *   2. Execution admission (`assertFreeOnlyExecution`): the model ID sent
 *      upstream must still have an approved free form, whatever a model row
 *      or operator override says.
 *   3. Request hardening (`hardenFreeOnlyParams`): OpenRouter price ceilings
 *      are forced to zero and request fields that could add paid fallback
 *      models, routes, or plugins are removed after every other merge.
 *
 * The provider also fixes how its models execute
 * (`withFreeOnlyExecutionDefaults`): a direct model on a free-only provider
 * whose row does not set a field of its retry policy gets the free-model
 * value, so a model added by any catalog sync is bounded like the baseline.
 *
 * @module runtime/providers/free-model-policy
 */

import { ProviderAuthError } from '../../core/errors.mjs';

export const FREE_ONLY_SETTING = 'free_only';

const FREE_ROUTER_MODEL_ID = 'openrouter/free';
// One vendor segment, one model segment, and the `:free` variant as the only
// suffix: a second variant (`vendor/model:online:free`) could select paid
// behaviour, so an identifier with another colon is not a free form.
const FREE_ID_RE = /^[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*:free$/i;
const ZERO_STRING_RE = /^0+(?:\.0+)?$/;
const REQUIRED_PRICE_KEYS = Object.freeze(['prompt', 'completion']);
const PAID_ROUTING_FIELDS = Object.freeze([
    'model',
    'messages',
    'models',
    'route',
    'plugins',
    'transforms',
    // Paid web search; `max_price` has no dimension that bounds it.
    'web_search_options',
]);
const ZERO_PRICE_CEILING = Object.freeze({
    prompt: 0,
    completion: 0,
    request: 0,
    image: 0,
});

// Classifiers, rerankers and embedding models answer with verdicts, scores
// or vectors, not assistant text, so they are never stored for a free-only
// provider even when free. The test is the identifier, because a catalog
// entry carries no machine-readable task: every token below is a word
// vendors put in such an identifier. Admitting a chat model by mistake is
// the failure that matters, so the tokens stay this narrow; rejecting a
// chat model whose name merely contains one (`vendor/vanguard-7b:free`,
// `vendor/embedded-chat:free`) only makes that model unavailable.
const NON_CHAT_ID_RE =
    /(safety|shield|guard|moderation|embed|rerank|classif|reward)/i;

/**
 * Execution policy for every direct model on a free-only provider. One
 * attempt: a retry of a busy free model spends shared daily quota and rarely
 * helps, so failover goes to the next tier child instead. The silence window
 * (`firstEventTimeoutMs`) restarts on upstream liveness such as reasoning;
 * the first-content cap bounds a model that never starts its answer; a
 * committed stream ends one idle deadline after its last event and, whatever
 * liveness it keeps producing, `max(streamIdleTimeoutMs,
 * firstContentTimeoutMs)` after its last content event; the cooldown is
 * short because free capacity recovers quickly. Inside a cascade, a reply the
 * token limit cut off before any content fails over like an empty one
 * (`lengthWithoutContentFails`), because the gateway chose the model and the
 * next child may answer within the caller's limit; a direct request keeps the
 * length finish. Row fields and tier child settings win.
 */
export const FREE_MODEL_EXECUTION_POLICY = Object.freeze({
    maxAttempts: 1,
    firstEventTimeoutMs: 30_000,
    firstContentTimeoutMs: 120_000,
    streamIdleTimeoutMs: 60_000,
    cooldownMs: 60_000,
    lengthWithoutContentFails: true,
});

export function isFreeOnlyProvider(providerRecord) {
    const settings = providerRecord?.settings || {};
    return settings[FREE_ONLY_SETTING] === true;
}

export function isApprovedFreeModelId(modelId) {
    if (typeof modelId !== 'string') return false;
    const id = modelId.trim();
    if (id !== modelId || id.length === 0) return false;
    return id === FREE_ROUTER_MODEL_ID || FREE_ID_RE.test(id);
}

export function isGeneralChatModelId(modelId) {
    return isApprovedFreeModelId(modelId) && !NON_CHAT_ID_RE.test(modelId);
}

/**
 * True only for an explicit numeric zero: the number 0 or a decimal string
 * of zeros. Booleans, null, empty or whitespace strings, negatives, and
 * non-finite values are rejected.
 */
export function isExplicitZeroPrice(value) {
    if (typeof value === 'number') {
        return Number.isFinite(value) && value === 0 && !Object.is(value, -0);
    }
    if (typeof value === 'string') {
        return value.length > 0 && value.trim() === value && ZERO_STRING_RE.test(value);
    }
    return false;
}

// A nested price dimension must itself state its prices: an empty object
// states none, so it is not proof of a zero price.
function allLeavesZero(value) {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
        const leaves = Object.values(value);
        return leaves.length > 0 && leaves.every(allLeavesZero);
    }
    return isExplicitZeroPrice(value);
}

/**
 * Decide whether a raw OpenAI-compatible `/models` entry (OpenRouter shape)
 * is admissible for a free-only provider.
 *
 * @param {object} entry
 * @returns {{ ok: boolean, reason: string|null }}
 */
export function isStrictlyFreeCatalogEntry(entry) {
    const id = entry?.id;
    if (!isApprovedFreeModelId(id)) return { ok: false, reason: 'id-not-free-form' };
    const pricing = entry?.pricing;
    if (!pricing || typeof pricing !== 'object' || Array.isArray(pricing)) {
        return { ok: false, reason: 'pricing-missing' };
    }
    for (const key of REQUIRED_PRICE_KEYS) {
        if (!Object.hasOwn(pricing, key)) {
            return { ok: false, reason: `pricing-${key}-missing` };
        }
    }
    for (const [key, value] of Object.entries(pricing)) {
        if (!allLeavesZero(value)) {
            return { ok: false, reason: `pricing-${key}-not-zero` };
        }
    }
    // The modalities are the only evidence that the endpoint is chat, so an
    // entry without them is not admitted.
    const architecture = entry?.architecture;
    if (!architecture || typeof architecture !== 'object' || Array.isArray(architecture)) {
        return { ok: false, reason: 'architecture-missing' };
    }
    const input = Array.isArray(architecture.input_modalities)
        ? architecture.input_modalities
        : [];
    const output = Array.isArray(architecture.output_modalities)
        ? architecture.output_modalities
        : [];
    if (!input.includes('text')) return { ok: false, reason: 'no-text-input' };
    if (!output.includes('text')) return { ok: false, reason: 'no-text-output' };
    if (output.includes('embeddings')) return { ok: false, reason: 'embeddings' };
    return { ok: true, reason: null };
}

/**
 * Reject execution of a model ID that is not an approved free form on a
 * free-only provider. The error is model-scoped: a cascade may continue
 * with another free child, but a retry cannot succeed.
 */
export function assertFreeOnlyExecution(providerRecord, modelId) {
    if (!isFreeOnlyProvider(providerRecord)) return;
    if (isApprovedFreeModelId(modelId)) return;
    const error = new ProviderAuthError(
        providerRecord?.providerKey || 'free-only',
        `Model ${String(modelId)} is blocked by the free-only provider policy`
    );
    error.policyBlocked = true;
    throw error;
}

/**
 * Retry policy a direct model runs with: on a free-only provider the
 * free-model execution policy with the row's own fields on top, otherwise
 * the row's policy unchanged.
 *
 * @param {object} retryPolicy   the model row's `retry_policy`
 * @param {object} providerRecord
 * @returns {object}
 */
export function withFreeOnlyExecutionDefaults(retryPolicy, providerRecord) {
    const own = retryPolicy && typeof retryPolicy === 'object' ? retryPolicy : {};
    if (!isFreeOnlyProvider(providerRecord)) return own;
    return { ...FREE_MODEL_EXECUTION_POLICY, ...own };
}

/**
 * Return request parameters for a free-only provider with zero price
 * ceilings enforced and paid-routing fields removed. Applied after every
 * other merge (including `settings.extra_body`) so nothing can undo it.
 */
export function hardenFreeOnlyParams(params = {}) {
    const hardened = { ...params };
    for (const field of PAID_ROUTING_FIELDS) delete hardened[field];
    const provider =
        hardened.provider && typeof hardened.provider === 'object'
            ? { ...hardened.provider }
            : {};
    provider.max_price = { ...ZERO_PRICE_CEILING };
    hardened.provider = provider;
    return hardened;
}

export default {
    FREE_ONLY_SETTING,
    FREE_MODEL_EXECUTION_POLICY,
    isFreeOnlyProvider,
    isApprovedFreeModelId,
    isGeneralChatModelId,
    isExplicitZeroPrice,
    isStrictlyFreeCatalogEntry,
    assertFreeOnlyExecution,
    hardenFreeOnlyParams,
    withFreeOnlyExecutionDefaults,
};
