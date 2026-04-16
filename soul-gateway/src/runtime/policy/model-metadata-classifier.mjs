/**
 * Model-metadata classifier.
 *
 * Owns the curated family-tag taxonomy, the deterministic family rules,
 * and the provider→tool-calling augmentation table. Also exposes
 * `enrichModelMetadata()`, the single place that defines the precedence
 * between provider-supplied data, the external pricing directory, and
 * the local classifier.
 *
 * Precedence inside `enrichModelMetadata`:
 *   1. Provider-supplied metadata (authoritative for pricing/context/
 *      capability tags when it exists).
 *   2. Pricing directory (fills missing pricing/context/capability
 *      tags and attaches `metadata.openrouter` provenance).
 *   3. Curated static overrides (fills exact-model gaps and applies
 *      gateway billing semantics such as `isFree:true` for known
 *      free-provider catalogs; never overwrites provider/directory
 *      price or context values that already exist).
 *   4. Classifier (adds curated family tags plus provider-based
 *      tool-calling augmentation; never overwrites capability tags
 *      and never infers `free`).
 *
 * This module is a pure helper: no side effects, no network access,
 * no DB access. All state it reads comes from its inputs.
 */

/**
 * Canonical tag vocabulary. Used by `GET /management/models/tags` to
 * return a stable filter vocabulary (`PREDEFINED_MODEL_TAGS ∪ stored
 * tags`) even when the DB has no rows.
 *
 * The list is the union of:
 *   - capability-signal tags emitted by provider discovery and the
 *     pricing directory (`vision`, `audio`, `tool-calling`,
 *     `function-calling`, `structured-outputs`, `moderated`, `free`,
 *     `multimodal`, `embeddings`, `retrieval`)
 *   - curated family/purpose tags emitted by this classifier
 *     (`fast`, `reasoning`, `coding`, `agentic`, `search`, `chat`,
 *     `long-context`, `instruction-following`, `multilingual`,
 *     `creative`, `writing`, `research`, `thinking`, `roleplay`,
 *     `finance`, `medical`)
 */
export const PREDEFINED_MODEL_TAGS = Object.freeze([
    'agentic',
    'audio',
    'chat',
    'coding',
    'creative',
    'embeddings',
    'fast',
    'finance',
    'free',
    'function-calling',
    'instruction-following',
    'long-context',
    'medical',
    'moderated',
    'multilingual',
    'multimodal',
    'reasoning',
    'research',
    'retrieval',
    'roleplay',
    'search',
    'structured-outputs',
    'thinking',
    'tool-calling',
    'vision',
    'writing',
]);

/**
 * Providers whose models are trusted to support tool calling even when
 * the upstream `/models` response omits the `tools` parameter. This
 * matches the old main-branch provider list from `app/src/db/init.mjs`.
 */
export const TOOL_CALLING_PROVIDER_KEYS = Object.freeze([
    'anthropic',
    'axiologic_kiro',
    'axiologic_proxy',
    'codex-api',
    'copilot',
    'google',
    'kiro-api',
    'mistral',
    'openai',
    'opencode',
    'opencode_anthropic',
    'opencode_responses',
    'openrouter',
    'xai',
]);

/**
 * Models that must never be tagged `tool-calling` even when the provider
 * is in `TOOL_CALLING_PROVIDER_KEYS`. Entries use the `<providerKey>/<modelId>`
 * or `<modelKey>` shape. The old main branch excluded these explicitly.
 */
export const NO_TOOL_CALLING_MODEL_KEYS = Object.freeze([
    'copilot/gpt-4o',
    'copilot/gpt-4.1',
]);

/**
 * Curated family rules ported from the old branch's `seedModelTags`
 * (proxies-main-branch/soul-gateway/app/src/db/init.mjs). The rules are
 * deterministic and order-independent: every matching rule contributes
 * its tags to the output set.
 *
 * Capability-signal tags (`vision`, `audio`, `tool-calling`,
 * `function-calling`, `structured-outputs`, `moderated`, `free`) are
 * intentionally **not** produced by these rules — those are owned by
 * provider/directory data. A family match for `llava` adds `multimodal`
 * but not `vision`; `vision` has to come from a real modality signal.
 */
import { lookupCuratedModelMetadata } from './curated-model-metadata.mjs';

const FAMILY_RULES = Object.freeze([
    // Search models ---------------------------------------------------
    { match: /(^|\/)search\//, tags: ['search'] },

    // Code-specialised model families --------------------------------
    {
        match: /codex/,
        tags: ['coding', 'reasoning', 'agentic'],
    },
    { match: /codestral/, tags: ['coding', 'fast'] },
    { match: /codegemma/, tags: ['coding'] },
    { match: /codelion/, tags: ['coding'] },
    { match: /starcoder/, tags: ['coding'] },
    { match: /-coder/, tags: ['coding', 'agentic'] },
    { match: /(^|\/)code[- ]/, tags: ['coding'] },

    // Claude families -------------------------------------------------
    {
        match: /opus/,
        tags: ['reasoning', 'coding', 'agentic', 'long-context'],
    },
    {
        match: /sonnet/,
        tags: ['coding', 'agentic', 'fast'],
    },
    { match: /haiku/, tags: ['fast', 'chat'] },

    // GPT families — specific before broad ---------------------------
    {
        match: /gpt-5.*codex/,
        tags: ['coding', 'reasoning', 'agentic'],
    },
    {
        match: /gpt-5.*mini/,
        tags: ['fast', 'chat'],
    },
    {
        match: /gpt-5\.[1234]/,
        tags: ['reasoning', 'coding'],
    },
    { match: /gpt-5/, tags: ['reasoning', 'chat'] },
    { match: /gpt-4o/, tags: ['fast', 'chat'] },
    { match: /gpt-4\.1/, tags: ['fast', 'chat'] },
    { match: /gpt-/, tags: ['chat'] },

    // Gemini / Gemma --------------------------------------------------
    {
        match: /gemini.*pro/,
        tags: ['reasoning', 'long-context', 'multimodal'],
    },
    { match: /gemini.*flash/, tags: ['fast', 'chat'] },
    { match: /gemma/, tags: ['chat', 'fast'] },

    // Grok / DeepSeek / Qwen / Llama ---------------------------------
    { match: /grok/, tags: ['chat', 'reasoning'] },
    { match: /deepseek/, tags: ['coding', 'reasoning'] },
    { match: /qwen/, tags: ['coding', 'multilingual'] },
    { match: /llama/, tags: ['chat', 'reasoning'] },

    // Mistral family --------------------------------------------------
    { match: /mixtral/, tags: ['fast', 'multilingual'] },
    { match: /mistral/, tags: ['chat', 'multilingual'] },

    // Vision / multimodal families (add `multimodal`; `vision` comes
    // from a real modality signal only) ------------------------------
    { match: /vlm/, tags: ['multimodal'] },
    { match: /llava/, tags: ['multimodal'] },
    { match: /paligemma/, tags: ['multimodal'] },
    { match: /kosmos/, tags: ['multimodal'] },
    { match: /fuyu/, tags: ['multimodal'] },
    { match: /neva/, tags: ['multimodal'] },
    { match: /vila/, tags: ['multimodal'] },
    { match: /cogvlm/, tags: ['multimodal'] },

    // Embeddings / retrieval -----------------------------------------
    { match: /embed/, tags: ['embeddings'] },
    { match: /(^|[-/])e5-/, tags: ['embeddings'] },
    { match: /(^|[-/])bge-/, tags: ['embeddings'] },
    { match: /rerank/, tags: ['retrieval'] },

    // Smaller families / regional / writer ---------------------------
    { match: /phi-/, tags: ['fast', 'reasoning'] },
    { match: /(^|[-/])yi-/, tags: ['chat', 'multilingual'] },
    { match: /nemotron/, tags: ['reasoning', 'chat'] },
    { match: /raptor/, tags: ['fast', 'chat'] },
    { match: /minimax/, tags: ['chat', 'multilingual'] },
    { match: /jamba/, tags: ['chat', 'long-context'] },
    { match: /dbrx/, tags: ['chat', 'reasoning'] },
    { match: /arctic/, tags: ['chat'] },
    { match: /falcon/, tags: ['chat'] },
    { match: /mpt-/, tags: ['chat'] },
    { match: /baichuan/, tags: ['chat', 'multilingual'] },
    { match: /internlm/, tags: ['chat', 'multilingual'] },
    { match: /chatglm/, tags: ['chat', 'multilingual'] },
    { match: /sea-lion/, tags: ['chat', 'multilingual'] },
    { match: /solar/, tags: ['chat'] },
    { match: /zephyr/, tags: ['chat'] },
    { match: /command-/, tags: ['chat'] },
    { match: /kimi/, tags: ['coding', 'agentic'] },
    { match: /glm-/, tags: ['chat', 'reasoning'] },

    // Writer / Palmyra -----------------------------------------------
    {
        match: /palmyra-creative/,
        tags: ['creative', 'writing'],
    },
    {
        match: /palmyra-fin/,
        tags: ['finance', 'reasoning'],
    },
    {
        match: /palmyra-med/,
        tags: ['medical', 'research'],
    },
    { match: /palmyra/, tags: ['writing', 'chat'] },
    { match: /writer/, tags: ['writing'] },

    // Regional multilingual ------------------------------------------
    { match: /eurollm/, tags: ['multilingual', 'chat'] },
    { match: /swallow/, tags: ['multilingual', 'chat'] },
    { match: /taiwan/, tags: ['multilingual', 'chat'] },
    { match: /zamba/, tags: ['chat', 'fast'] },

    // Thinking / reasoning-explicit ----------------------------------
    { match: /thinker/, tags: ['reasoning', 'thinking'] },
    { match: /apriel/, tags: ['chat', 'reasoning'] },

    // Auto-routers / agentic markers ---------------------------------
    { match: /(^|\/)auto($|[-/])/, tags: ['agentic'] },

    // Catch-alls -----------------------------------------------------
    {
        match: /instruct/,
        tags: ['chat', 'instruction-following'],
    },
    { match: /-chat/, tags: ['chat'] },
    { match: /\/chat/, tags: ['chat'] },
    { match: /-7b/, tags: ['chat'] },
    { match: /-8b/, tags: ['chat'] },
    { match: /-13b/, tags: ['chat'] },
    { match: /-14b/, tags: ['chat'] },
    { match: /-32b/, tags: ['chat'] },
    { match: /-32k/, tags: ['long-context'] },
    { match: /-70b/, tags: ['chat', 'reasoning'] },
    { match: /-122b/, tags: ['chat', 'reasoning'] },
]);

// Long-context threshold — lifted from the old branch heuristic that
// treated 131K+ context as `long-context` when the model name didn't
// already imply it.
const LONG_CONTEXT_THRESHOLD = 131_072;

function lowercaseOrEmpty(value) {
    return typeof value === 'string' ? value.toLowerCase() : '';
}

function collectHaystack(envelope) {
    return [
        lowercaseOrEmpty(envelope?.modelKey),
        lowercaseOrEmpty(envelope?.providerModelId),
        lowercaseOrEmpty(envelope?.displayName),
    ]
        .filter((s) => s.length > 0)
        .join('\n');
}

function resolveContextWindow(envelope) {
    const direct = envelope?.contextWindow;
    if (typeof direct === 'number' && Number.isFinite(direct)) {
        return direct;
    }
    const fromCapabilities = envelope?.capabilities?.contextWindow;
    if (
        typeof fromCapabilities === 'number' &&
        Number.isFinite(fromCapabilities)
    ) {
        return fromCapabilities;
    }
    return null;
}

/**
 * Pure classifier: given a canonical metadata envelope, return the set
 * of family tags and the provider-augmentation tags this classifier
 * would contribute.
 *
 * Does not consult external state and does not mutate its input.
 * Returns a stable `{ tags: sorted string[] }` shape so callers can
 * inspect what the classifier alone would add.
 *
 * The classifier intentionally does not emit capability-signal tags
 * (`vision`, `audio`, `tool-calling`/`function-calling` from direct
 * signal, `structured-outputs`, `moderated`, `free`).
 */
export function classifyModelMetadata(envelope) {
    const inferred = new Set();
    const haystack = collectHaystack(envelope);

    if (haystack.length > 0) {
        for (const rule of FAMILY_RULES) {
            if (rule.match.test(haystack)) {
                for (const tag of rule.tags) {
                    inferred.add(tag);
                }
            }
        }
    }

    const contextWindow = resolveContextWindow(envelope);
    if (contextWindow !== null && contextWindow >= LONG_CONTEXT_THRESHOLD) {
        inferred.add('long-context');
    }

    // Provider-based tool-calling augmentation. Only contributes when
    // the provider is in the trusted list AND the model isn't on the
    // opt-out list AND the envelope doesn't already carry `tool-calling`
    // from a real capability signal.
    const providerKey = envelope?.providerKey || null;
    const modelKey = envelope?.modelKey || null;
    const existingTags = Array.isArray(envelope?.tags) ? envelope.tags : [];
    const supportsTools =
        envelope?.supportsTools ?? envelope?.capabilities?.supportsTools ?? null;
    if (
        providerKey &&
        TOOL_CALLING_PROVIDER_KEYS.includes(providerKey) &&
        !NO_TOOL_CALLING_MODEL_KEYS.includes(modelKey) &&
        supportsTools !== false &&
        !existingTags.includes('tool-calling') &&
        !existingTags.includes('function-calling')
    ) {
        inferred.add('tool-calling');
    }

    return {
        tags: [...inferred].sort(),
    };
}

function mergeCapabilityTags(existingTags, candidateTags, envelope) {
    const mergedTags = new Set(Array.isArray(existingTags) ? existingTags : []);
    const supportsTools =
        envelope?.supportsTools ?? envelope?.capabilities?.supportsTools ?? null;
    const supportsVision =
        envelope?.supportsVision ?? envelope?.capabilities?.supportsVision ?? null;

    for (const tag of candidateTags || []) {
        if (mergedTags.has(tag)) {
            continue;
        }
        if (tag === 'tool-calling' && supportsTools === false) {
            continue;
        }
        if (tag === 'vision' && supportsVision === false) {
            continue;
        }
        if (tag === 'free' && envelope?.isFree !== true) {
            continue;
        }
        mergedTags.add(tag);
    }

    return [...mergedTags].sort();
}

function mergeDirectoryProvenance(existingMetadata, entry) {
    const metadata = { ...(existingMetadata || {}) };
    metadata.openrouter = {
        ...(metadata.openrouter || {}),
        source: 'openrouter',
        id: entry.id,
        canonicalSlug: entry.canonicalSlug,
        matchedBy: entry.matchedBy,
    };
    if (entry.description && !metadata.openrouter.description) {
        metadata.openrouter.description = entry.description;
    }
    return metadata;
}

function applyDirectoryEntry(envelope, entry) {
    const next = {
        ...envelope,
        capabilities: { ...(envelope.capabilities || {}) },
        metadata: mergeDirectoryProvenance(envelope.metadata || {}, entry),
    };

    const hasPricing =
        (envelope.pricingMode != null &&
            envelope.pricingMode !== 'external_directory') ||
        envelope.inputPricePerMillion != null ||
        envelope.outputPricePerMillion != null ||
        envelope.requestPriceUsd != null;

    if (!hasPricing) {
        next.pricingMode = entry.pricingMode;
        next.inputPricePerMillion = entry.inputPricePerMillion;
        next.outputPricePerMillion = entry.outputPricePerMillion;
        next.requestPriceUsd = entry.requestPriceUsd;
        if (envelope.isFree == null || envelope.isFree === false) {
            next.isFree = entry.isFree === true;
        }
    }

    if (
        next.capabilities.contextWindow == null &&
        entry.contextWindow != null
    ) {
        next.capabilities.contextWindow = entry.contextWindow;
    }
    if (next.contextWindow == null && entry.contextWindow != null) {
        next.contextWindow = entry.contextWindow;
    }
    if (
        next.capabilities.maxOutputTokens == null &&
        entry.maxOutputTokens != null
    ) {
        next.capabilities.maxOutputTokens = entry.maxOutputTokens;
    }
    if (next.maxOutputTokens == null && entry.maxOutputTokens != null) {
        next.maxOutputTokens = entry.maxOutputTokens;
    }
    if (
        next.capabilities.supportsTools == null &&
        entry.supportsTools != null
    ) {
        next.capabilities.supportsTools = entry.supportsTools;
    }
    if (next.supportsTools == null && entry.supportsTools != null) {
        next.supportsTools = entry.supportsTools;
    }
    if (
        next.capabilities.supportsVision == null &&
        entry.supportsVision != null
    ) {
        next.capabilities.supportsVision = entry.supportsVision;
    }
    if (next.supportsVision == null && entry.supportsVision != null) {
        next.supportsVision = entry.supportsVision;
    }

    if (Array.isArray(entry.tags) && entry.tags.length > 0) {
        next.tags = mergeCapabilityTags(envelope.tags, entry.tags, next);
    }

    return next;
}

function detectCuratedPricingMode(entry) {
    const hasRequestPricing = entry?.requestPriceUsd != null;
    const hasTokenPricing =
        entry?.inputPricePerMillion != null ||
        entry?.outputPricePerMillion != null;

    if (hasRequestPricing) {
        return 'request';
    }
    if (hasTokenPricing) {
        return 'token';
    }
    return null;
}

function mergeCuratedProvenance(existingMetadata, provenance) {
    const metadata = { ...(existingMetadata || {}) };
    metadata.curated = {
        ...(metadata.curated || {}),
        ...(provenance || {}),
    };
    return metadata;
}

function applyCuratedEntry(envelope, entry) {
    const next = {
        ...envelope,
        capabilities: { ...(envelope.capabilities || {}) },
        metadata: mergeCuratedProvenance(
            envelope.metadata || {},
            entry?.provenance || null
        ),
    };

    if (entry?.isFree === true) {
        next.isFree = true;
    }

    const hasPricing =
        (envelope.pricingMode != null &&
            envelope.pricingMode !== 'external_directory') ||
        envelope.inputPricePerMillion != null ||
        envelope.outputPricePerMillion != null ||
        envelope.requestPriceUsd != null;
    if (!hasPricing) {
        if (entry?.inputPricePerMillion != null) {
            next.inputPricePerMillion = entry.inputPricePerMillion;
        }
        if (entry?.outputPricePerMillion != null) {
            next.outputPricePerMillion = entry.outputPricePerMillion;
        }
        if (entry?.requestPriceUsd != null) {
            next.requestPriceUsd = entry.requestPriceUsd;
        }
        const curatedPricingMode = detectCuratedPricingMode(entry);
        if (
            curatedPricingMode &&
            (next.pricingMode == null || next.pricingMode === 'external_directory')
        ) {
            next.pricingMode = curatedPricingMode;
        }
    }

    if (
        next.capabilities.contextWindow == null &&
        entry?.contextWindow != null
    ) {
        next.capabilities.contextWindow = entry.contextWindow;
    }
    if (next.contextWindow == null && entry?.contextWindow != null) {
        next.contextWindow = entry.contextWindow;
    }

    if (Array.isArray(entry?.tags) && entry.tags.length > 0) {
        next.tags = mergeCapabilityTags(envelope.tags, entry.tags, next);
    }

    return next;
}

function applyClassifierTags(envelope) {
    const { tags: classifierTags } = classifyModelMetadata(envelope);
    if (classifierTags.length === 0) {
        return envelope;
    }

    const existingTags = Array.isArray(envelope.tags) ? envelope.tags : [];
    const merged = new Set(existingTags);
    const added = [];
    for (const tag of classifierTags) {
        if (!merged.has(tag)) {
            merged.add(tag);
            added.push(tag);
        }
    }
    if (added.length === 0) {
        return envelope;
    }

    const nextMetadata = { ...(envelope.metadata || {}) };
    nextMetadata.classifier = {
        ...(nextMetadata.classifier || {}),
        source: 'model-metadata-classifier',
        tagsAdded: added,
    };

    return {
        ...envelope,
        tags: [...merged].sort(),
        metadata: nextMetadata,
    };
}

/**
 * Enrich a canonical metadata envelope.
 *
 * Precedence (see module header):
 *   1. Provider-supplied fields win.
 *   2. `pricingDirectory.lookupModel(...)` fills remaining gaps
 *      (pricing, context, capabilities, tags) and attaches
 *      `metadata.openrouter` provenance.
 *   3. `lookupCuratedModelMetadata(...)` applies exact static gateway
 *      overrides (billing semantics plus a small number of price/context
 *      fills) and attaches `metadata.curated` provenance.
 *   4. Classifier adds curated family tags and the provider
 *      tool-calling augmentation. It never overwrites capability tags
 *      and never infers `free`.
 *
 * Every input field that already carries a non-null value is preserved.
 * The function is pure: it returns a new envelope and never mutates
 * its argument. Pass `enableClassifier: false` to skip the classifier
 * stage (used by tests that want to isolate directory precedence).
 *
 * @param {object} envelope
 * @param {{ pricingDirectory?: object|null, enableClassifier?: boolean }} [deps]
 */
export function enrichModelMetadata(envelope, deps = {}) {
    if (!envelope || typeof envelope !== 'object') {
        throw new Error('enrichModelMetadata requires an envelope object');
    }
    const { pricingDirectory = null, enableClassifier = true } = deps;

    let result = {
        ...envelope,
        capabilities: { ...(envelope.capabilities || {}) },
        metadata: { ...(envelope.metadata || {}) },
        tags: Array.isArray(envelope.tags) ? [...envelope.tags] : [],
    };

    if (pricingDirectory && typeof pricingDirectory.lookupModel === 'function') {
        const entry = pricingDirectory.lookupModel(
            envelope.providerKey || null,
            envelope.providerModelId || null,
            {
                modelKey: envelope.modelKey || null,
                displayName: envelope.displayName || null,
            }
        );
        if (entry) {
            result = applyDirectoryEntry(result, entry);
        }
    }

    const curatedEntry = lookupCuratedModelMetadata(result);
    if (curatedEntry) {
        result = applyCuratedEntry(result, curatedEntry);
    }

    if (enableClassifier) {
        result = applyClassifierTags(result);
    }

    result.tags = [...new Set(result.tags)].sort();
    return result;
}
