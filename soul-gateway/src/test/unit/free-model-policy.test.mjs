import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
    assertFreeOnlyExecution,
    hardenFreeOnlyParams,
    isApprovedFreeModelId,
    isExplicitZeroPrice,
    isFreeOnlyProvider,
    isGeneralChatModelId,
    isStrictlyFreeCatalogEntry,
} from '../../runtime/providers/free-model-policy.mjs';
import { applyModelRequestParams } from '../../runtime/backends/model-request-params.mjs';

function entry(overrides = {}) {
    return {
        id: 'vendor/model:free',
        pricing: { prompt: '0', completion: '0', request: '0', image: '0' },
        architecture: { input_modalities: ['text'], output_modalities: ['text'] },
        ...overrides,
    };
}

describe('free-only model identifiers', () => {
    it('accepts explicit :free ids and the free router id', () => {
        for (const id of ['vendor/model:free', 'nex-agi/nex-n2.5-mini:free', 'openrouter/free']) {
            assert.equal(isApprovedFreeModelId(id), true, id);
        }
    });

    it('rejects paid, auto-routing, padded, and malformed ids', () => {
        for (const id of [
            'openai/gpt-4o',
            'openrouter/auto',
            'vendor/model:freeish',
            'vendor/model:free ',
            ' vendor/model:free',
            'model:free',
            'vendor/:free',
            '',
            null,
            42,
        ]) {
            assert.equal(isApprovedFreeModelId(id), false, String(id));
        }
    });

    it('rejects an id that carries another variant besides :free', () => {
        for (const id of ['openai/gpt-4o:online:free', 'vendor/model:thinking:free', 'vendor/model:free:free']) {
            assert.equal(isApprovedFreeModelId(id), false, id);
            assert.equal(isStrictlyFreeCatalogEntry(entry({ id })).reason, 'id-not-free-form', id);
        }
    });

    it('keeps moderation classifiers out of general chat use', () => {
        assert.equal(isGeneralChatModelId('nvidia/nemotron-3.5-content-safety:free'), false);
        assert.equal(isGeneralChatModelId('meta/llama-guard-4:free'), false);
        assert.equal(isGeneralChatModelId('nex-agi/nex-n2.5-mini:free'), true);
    });

    // Every chat identifier a real free catalog offered, against every
    // identifier form of a classifier, reranker or embedding model. The
    // exclusion is a name test, so each token added here is checked against
    // the whole chat list to prove it overlaps none of them.
    const GENERAL_CHAT_IDS = [
        'nex-agi/nex-n2.5-mini:free',
        'cohere/north-mini-code:free',
        'liquid/lfm-2.5-2.6b:free',
        'dots-studio/dots-3-note-preview:free',
        'nvidia/nemotron-3-super-120b-a12b:free',
        'nvidia/nemotron-3-ultra-550b-a55b:free',
        'nex-agi/nex-n2.5-pro:free',
        'google/gemma-4-26b-a4b-it:free',
        'qwen/qwen3.8-27b:free',
        'nvidia/nemotron-3.5-lightning:free',
        'openrouter/free',
        'poolside/laguna-s-2.1:free',
        'z-ai/glm-5.2:free',
        'inclusionai/ling-3.0-flash-fin:free',
        'thinkingmachines/inkling:free',
        'thinkingmachines/inkling-small:free',
        'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free',
        'poolside/laguna-xs-2.1:free',
        'google/gemma-4-31b-it:free',
        'inclusionai/ling-3.0-flash-sante:free',
        'inclusionai/ling-3.0-flash-vl:free',
    ];

    const NON_CHAT_IDS = [
        'nvidia/nemotron-3.5-content-safety:free',
        'meta-llama/llama-guard-4-12b:free',
        'openai/omni-moderation:free',
        'x/text-embedding-3:free',
        'google/shieldgemma-2-4b-it:free',
        'cohere/rerank-v3.5:free',
    ];

    it('admits every general chat identifier of the measured catalog', () => {
        for (const id of GENERAL_CHAT_IDS) {
            assert.equal(isGeneralChatModelId(id), true, id);
        }
    });

    it('rejects classifiers, rerankers and embedding models', () => {
        for (const id of NON_CHAT_IDS) {
            assert.equal(isGeneralChatModelId(id), false, id);
        }
    });

    it('rejects a chat model whose name merely contains an excluded token', () => {
        // Accepted cost of a name test: such a model is only unavailable.
        assert.equal(isGeneralChatModelId('vendor/vanguard-7b:free'), false);
        assert.equal(isGeneralChatModelId('vendor/embedded-chat:free'), false);
    });
});

describe('explicit zero prices', () => {
    it('accepts numeric zero and zero decimal strings only', () => {
        for (const value of [0, '0', '0.0', '0.000000', '00']) {
            assert.equal(isExplicitZeroPrice(value), true, JSON.stringify(value));
        }
    });

    it('rejects missing, malformed, negative, nonzero, boolean, blank, and nonfinite values', () => {
        for (const value of [
            undefined, null, false, true, '', ' ', ' 0', '0 ', '-0', -0,
            '-1', -1, '0.0000001', 1e-9, 'NaN', NaN, Infinity, 'Infinity',
            '0x0', '1e-9', '0e0', {}, [],
        ]) {
            assert.equal(isExplicitZeroPrice(value), false, String(value));
        }
    });
});

describe('catalog admission', () => {
    it('admits a free chat entry with every present dimension zero', () => {
        assert.deepEqual(isStrictlyFreeCatalogEntry(entry()), { ok: true, reason: null });
    });

    it('requires explicit prompt and completion prices', () => {
        assert.equal(isStrictlyFreeCatalogEntry(entry({ pricing: { completion: '0' } })).ok, false);
        assert.equal(isStrictlyFreeCatalogEntry(entry({ pricing: { prompt: '0' } })).ok, false);
        assert.equal(isStrictlyFreeCatalogEntry(entry({ pricing: undefined })).ok, false);
        assert.equal(isStrictlyFreeCatalogEntry(entry({ pricing: [] })).ok, false);
    });

    it('rejects a nonzero or malformed secondary dimension', () => {
        for (const pricing of [
            { prompt: '0', completion: '0', request: '0.01' },
            { prompt: '0', completion: '0', image: '-1' },
            { prompt: '0', completion: '0', web_search: null },
            { prompt: '0', completion: '0', internal_reasoning: true },
            { prompt: '0', completion: '0', overrides: { long: { prompt: '0.000002' } } },
        ]) {
            assert.equal(isStrictlyFreeCatalogEntry(entry({ pricing })).ok, false, JSON.stringify(pricing));
        }
        assert.equal(
            isStrictlyFreeCatalogEntry(entry({ pricing: { prompt: '0', completion: '0', overrides: { long: { prompt: '0' } } } })).ok,
            true
        );
    });

    it('rejects a secondary dimension that states no price at all', () => {
        for (const pricing of [
            { prompt: '0', completion: '0', web_search: {} },
            { prompt: '0', completion: '0', overrides: { long: {} } },
        ]) {
            assert.equal(isStrictlyFreeCatalogEntry(entry({ pricing })).ok, false, JSON.stringify(pricing));
        }
        assert.equal(isStrictlyFreeCatalogEntry(entry({ pricing: { prompt: '0', completion: '0', web_search: '0' } })).ok, true);
    });

    it('rejects an entry that declares no modalities', () => {
        for (const architecture of [undefined, null, [], 'text->text']) {
            assert.equal(isStrictlyFreeCatalogEntry(entry({ architecture })).reason, 'architecture-missing', String(architecture));
        }
    });

    it('rejects zero-priced entries with a paid id form', () => {
        assert.equal(isStrictlyFreeCatalogEntry(entry({ id: 'openai/gpt-4o' })).reason, 'id-not-free-form');
        assert.equal(isStrictlyFreeCatalogEntry(entry({ id: 'openrouter/auto' })).ok, false);
    });

    it('rejects endpoints that are not text chat', () => {
        const embed = entry({ architecture: { input_modalities: ['text'], output_modalities: ['embeddings'] } });
        const audio = entry({ architecture: { input_modalities: ['audio'], output_modalities: ['text'] } });
        const imageOut = entry({ architecture: { input_modalities: ['text'], output_modalities: ['image'] } });
        assert.equal(isStrictlyFreeCatalogEntry(embed).ok, false);
        assert.equal(isStrictlyFreeCatalogEntry(audio).reason, 'no-text-input');
        assert.equal(isStrictlyFreeCatalogEntry(imageOut).reason, 'no-text-output');
    });
});

describe('execution admission and request hardening', () => {
    const freeProvider = { providerKey: 'openrouter-free', settings: { free_only: true } };

    it('only applies to providers that opted in', () => {
        assert.equal(isFreeOnlyProvider(freeProvider), true);
        assert.equal(isFreeOnlyProvider({ settings: { free_only: 'true' } }), false);
        assert.equal(isFreeOnlyProvider({ settings: {} }), false);
        assert.doesNotThrow(() => assertFreeOnlyExecution({ settings: {} }, 'openai/gpt-4o'));
    });

    it('blocks a paid model id as a model-scoped, non-retryable failure', () => {
        assert.throws(
            () => assertFreeOnlyExecution(freeProvider, 'openai/gpt-4o'),
            (err) => err.policyBlocked === true && err.retryable === false && err.cascade === true
        );
        assert.doesNotThrow(() => assertFreeOnlyExecution(freeProvider, 'vendor/model:free'));
    });

    it('forces zero price ceilings and strips paid routing fields after other merges', () => {
        const hardened = hardenFreeOnlyParams({
            stream: true,
            max_tokens: 64,
            model: 'openai/gpt-4o',
            messages: [{ role: 'user', content: 'override' }],
            models: ['openai/gpt-4o'],
            route: 'fallback',
            plugins: [{ id: 'web' }],
            transforms: ['middle-out'],
            web_search_options: { search_context_size: 'high' },
            tools: [{ type: 'function', function: { name: 'lookup', parameters: { type: 'object' } } }],
            provider: { max_price: { prompt: 10, completion: 10 }, sort: 'price' },
        });
        assert.deepEqual(hardened.provider.max_price, { prompt: 0, completion: 0, request: 0, image: 0 });
        assert.equal(hardened.provider.sort, 'price');
        for (const field of ['model', 'messages', 'models', 'route', 'plugins', 'transforms', 'web_search_options']) {
            assert.equal(Object.hasOwn(hardened, field), false, field);
        }
        assert.equal(hardened.max_tokens, 64);
        assert.equal(hardened.tools.length, 1, 'client function tools are not paid routing');
    });

    it('lets tier children tune reasoning only', () => {
        const params = applyModelRequestParams(
            { stream: true },
            { reasoning: { enabled: false }, model: 'openai/gpt-4o', provider: { max_price: { prompt: 9 } } }
        );
        assert.deepEqual(params, { stream: true, reasoning: { enabled: false } });
    });
});
