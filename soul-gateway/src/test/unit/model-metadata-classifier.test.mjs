import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
    PREDEFINED_MODEL_TAGS,
    TOOL_CALLING_PROVIDER_KEYS,
    NO_TOOL_CALLING_MODEL_KEYS,
    classifyModelMetadata,
    enrichModelMetadata,
} from '../../runtime/policy/model-metadata-classifier.mjs';
import {
    CURATED_FREE_PROVIDER_KEYS,
} from '../../runtime/policy/curated-model-metadata.mjs';

function makeEnvelope(overrides = {}) {
    return {
        providerKey: null,
        providerModelId: null,
        modelKey: null,
        displayName: null,
        pricingMode: null,
        inputPricePerMillion: null,
        outputPricePerMillion: null,
        requestPriceUsd: null,
        isFree: null,
        contextWindow: null,
        maxOutputTokens: null,
        supportsTools: null,
        supportsVision: null,
        supportsStreaming: null,
        capabilities: {},
        tags: [],
        metadata: {},
        ...overrides,
    };
}

describe('PREDEFINED_MODEL_TAGS', () => {
    it('is a frozen sorted union of capability-signal and family tags', () => {
        assert.ok(Object.isFrozen(PREDEFINED_MODEL_TAGS));
        const sorted = [...PREDEFINED_MODEL_TAGS].sort();
        assert.deepEqual([...PREDEFINED_MODEL_TAGS], sorted);
        for (const tag of [
            'tool-calling',
            'vision',
            'free',
            'coding',
            'reasoning',
            'agentic',
            'fast',
            'long-context',
            'multimodal',
            'embeddings',
        ]) {
            assert.ok(
                PREDEFINED_MODEL_TAGS.includes(tag),
                `expected PREDEFINED_MODEL_TAGS to include ${tag}`
            );
        }
    });
});

describe('classifyModelMetadata — family rules', () => {
    it('tags a codex model as coding/reasoning/agentic', () => {
        const { tags } = classifyModelMetadata(
            makeEnvelope({
                providerKey: 'codex-api',
                providerModelId: 'gpt-5-codex',
                modelKey: 'codex-api/gpt-5-codex',
            })
        );
        for (const tag of ['coding', 'reasoning', 'agentic']) {
            assert.ok(tags.includes(tag), `missing ${tag}`);
        }
    });

    it('tags gpt-4o family as fast/chat', () => {
        const { tags } = classifyModelMetadata(
            makeEnvelope({
                providerKey: 'openai',
                providerModelId: 'gpt-4o',
                modelKey: 'openai/gpt-4o',
            })
        );
        for (const tag of ['fast', 'chat']) {
            assert.ok(tags.includes(tag), `missing ${tag}`);
        }
    });

    it('tags llava-style models as multimodal but not vision (vision needs signal)', () => {
        const { tags } = classifyModelMetadata(
            makeEnvelope({
                providerKey: 'nvidia',
                providerModelId: 'llava-1.5-7b',
                modelKey: 'nvidia/llava-1.5-7b',
            })
        );
        assert.ok(tags.includes('multimodal'));
        assert.ok(!tags.includes('vision'));
        assert.ok(!tags.includes('audio'));
        assert.ok(!tags.includes('tool-calling')); // nvidia not in trusted list
    });

    it('tags embeddings models as embeddings', () => {
        const { tags } = classifyModelMetadata(
            makeEnvelope({
                providerKey: 'nvidia',
                providerModelId: 'nv-embed-v2',
                modelKey: 'nvidia/nv-embed-v2',
            })
        );
        assert.ok(tags.includes('embeddings'));
    });

    it('adds long-context when contextWindow >= 131_072', () => {
        const { tags } = classifyModelMetadata(
            makeEnvelope({
                providerKey: 'openai',
                providerModelId: 'gpt-custom',
                modelKey: 'openai/gpt-custom',
                contextWindow: 131_072,
            })
        );
        assert.ok(tags.includes('long-context'));
    });

    it('does not add long-context when contextWindow is below the threshold', () => {
        const { tags } = classifyModelMetadata(
            makeEnvelope({
                providerKey: 'openai',
                providerModelId: 'gpt-custom',
                modelKey: 'openai/gpt-custom',
                contextWindow: 8192,
            })
        );
        assert.ok(!tags.includes('long-context'));
    });

    it('never emits capability-signal tags (vision/audio/free/structured-outputs/moderated)', () => {
        const { tags } = classifyModelMetadata(
            makeEnvelope({
                providerKey: 'openai',
                providerModelId: 'gpt-4o-vision',
                modelKey: 'openai/gpt-4o-vision',
                pricingMode: 'free',
                isFree: true,
            })
        );
        for (const forbidden of [
            'vision',
            'audio',
            'free',
            'structured-outputs',
            'moderated',
            'function-calling',
        ]) {
            assert.ok(
                !tags.includes(forbidden),
                `classifier must never emit ${forbidden}`
            );
        }
    });
});

describe('classifyModelMetadata — tool-calling augmentation', () => {
    it('adds tool-calling when provider is in TOOL_CALLING_PROVIDER_KEYS', () => {
        for (const providerKey of TOOL_CALLING_PROVIDER_KEYS) {
            const { tags } = classifyModelMetadata(
                makeEnvelope({
                    providerKey,
                    providerModelId: 'custom-model',
                    modelKey: `${providerKey}/custom-model`,
                })
            );
            assert.ok(
                tags.includes('tool-calling'),
                `expected tool-calling for ${providerKey}`
            );
        }
    });

    it('does not augment tool-calling for untrusted providers', () => {
        const { tags } = classifyModelMetadata(
            makeEnvelope({
                providerKey: 'random-provider',
                providerModelId: 'random-model',
                modelKey: 'random-provider/random-model',
            })
        );
        assert.ok(!tags.includes('tool-calling'));
    });

    it('does not augment tool-calling for opted-out model keys', () => {
        for (const modelKey of NO_TOOL_CALLING_MODEL_KEYS) {
            const providerKey = modelKey.split('/')[0];
            const providerModelId = modelKey.split('/').slice(1).join('/');
            const { tags } = classifyModelMetadata(
                makeEnvelope({
                    providerKey,
                    providerModelId,
                    modelKey,
                })
            );
            assert.ok(
                !tags.includes('tool-calling'),
                `expected ${modelKey} to be excluded from tool-calling augmentation`
            );
        }
    });

    it('does not re-add tool-calling when it is already present', () => {
        const envelope = makeEnvelope({
            providerKey: 'openai',
            providerModelId: 'gpt-4o',
            modelKey: 'openai/gpt-4o',
            tags: ['tool-calling'],
        });
        const { tags } = classifyModelMetadata(envelope);
        // classifier output should not duplicate tool-calling (Set semantics).
        assert.equal(
            tags.filter((t) => t === 'tool-calling').length,
            0,
            'classifier should not add tool-calling when already present on input'
        );
    });

    it('does not augment tool-calling when the provider explicitly reports supportsTools:false', () => {
        const { tags } = classifyModelMetadata(
            makeEnvelope({
                providerKey: 'openai',
                providerModelId: 'gpt-4o',
                modelKey: 'openai/gpt-4o',
                supportsTools: false,
                capabilities: { supportsTools: false },
            })
        );
        assert.ok(
            !tags.includes('tool-calling'),
            'trusted-provider augmentation must respect explicit supportsTools:false'
        );
    });
});

describe('enrichModelMetadata — precedence', () => {
    it('fills missing pricing/context/tags from the directory', () => {
        const envelope = makeEnvelope({
            providerKey: 'nvidia',
            providerModelId: 'google/gemma-3-27b-it',
            modelKey: 'nvidia/google/gemma-3-27b-it',
        });
        const directory = {
            lookupModel() {
                return {
                    id: 'google/gemma-3-27b-it',
                    canonicalSlug: 'google/gemma-3-27b-it',
                    matchedBy: 'id',
                    pricingMode: 'token',
                    inputPricePerMillion: 0.27,
                    outputPricePerMillion: 0.4,
                    requestPriceUsd: null,
                    isFree: false,
                    contextWindow: 131_072,
                    maxOutputTokens: 8192,
                    supportsTools: true,
                    supportsVision: true,
                    tags: ['tool-calling', 'vision'],
                    description: 'Gemma 3 27B Instruct',
                };
            },
        };
        const enriched = enrichModelMetadata(envelope, {
            pricingDirectory: directory,
        });
        assert.equal(enriched.pricingMode, 'token');
        assert.equal(enriched.inputPricePerMillion, 0.27);
        assert.equal(enriched.capabilities.contextWindow, 131_072);
        assert.equal(enriched.capabilities.maxOutputTokens, 8192);
        assert.ok(enriched.tags.includes('tool-calling'));
        assert.ok(enriched.tags.includes('vision'));
        assert.equal(enriched.metadata.openrouter.matchedBy, 'id');
        assert.equal(
            enriched.metadata.openrouter.description,
            'Gemma 3 27B Instruct'
        );
    });

    it('does not overwrite provider-supplied pricing even when the directory disagrees', () => {
        const envelope = makeEnvelope({
            providerKey: 'nvidia',
            providerModelId: 'google/gemma-3-27b-it',
            modelKey: 'nvidia/google/gemma-3-27b-it',
            pricingMode: 'token',
            inputPricePerMillion: 99,
            outputPricePerMillion: 100,
        });
        const directory = {
            lookupModel() {
                return {
                    id: 'google/gemma-3-27b-it',
                    canonicalSlug: 'google/gemma-3-27b-it',
                    matchedBy: 'id',
                    pricingMode: 'token',
                    inputPricePerMillion: 0.27,
                    outputPricePerMillion: 0.4,
                    requestPriceUsd: null,
                    isFree: false,
                    contextWindow: 131_072,
                    maxOutputTokens: 8192,
                    supportsTools: true,
                    supportsVision: true,
                    tags: ['tool-calling', 'vision'],
                    description: null,
                };
            },
        };
        const enriched = enrichModelMetadata(envelope, {
            pricingDirectory: directory,
        });
        assert.equal(enriched.pricingMode, 'token');
        assert.equal(enriched.inputPricePerMillion, 99);
        assert.equal(enriched.outputPricePerMillion, 100);
    });

    it('preserves provider-supplied capability false-values against directory optimism', () => {
        const envelope = makeEnvelope({
            providerKey: 'nvidia',
            providerModelId: 'google/gemma-3-27b-it',
            modelKey: 'nvidia/google/gemma-3-27b-it',
            supportsVision: false,
            capabilities: { supportsVision: false },
        });
        const directory = {
            lookupModel() {
                return {
                    id: 'google/gemma-3-27b-it',
                    canonicalSlug: 'google/gemma-3-27b-it',
                    matchedBy: 'id',
                    pricingMode: 'token',
                    inputPricePerMillion: 0.27,
                    outputPricePerMillion: 0.4,
                    requestPriceUsd: null,
                    isFree: false,
                    contextWindow: 131_072,
                    maxOutputTokens: 8192,
                    supportsTools: true,
                    supportsVision: true,
                    tags: ['tool-calling', 'vision'],
                };
            },
        };
        const enriched = enrichModelMetadata(envelope, {
            pricingDirectory: directory,
        });
        assert.equal(enriched.supportsVision, false);
        assert.equal(enriched.capabilities.supportsVision, false);
        assert.ok(
            !enriched.tags.includes('vision'),
            'directory must not add vision when provider explicitly reports supportsVision:false'
        );
    });

    it('fills missing directory capability tags even when provider tags are only partially populated', () => {
        const envelope = makeEnvelope({
            providerKey: 'nvidia',
            providerModelId: 'google/gemma-3-27b-it',
            modelKey: 'nvidia/google/gemma-3-27b-it',
            supportsTools: true,
            capabilities: { supportsTools: true },
            tags: ['tool-calling'],
        });
        const directory = {
            lookupModel() {
                return {
                    id: 'google/gemma-3-27b-it',
                    canonicalSlug: 'google/gemma-3-27b-it',
                    matchedBy: 'id',
                    pricingMode: 'token',
                    inputPricePerMillion: 0.27,
                    outputPricePerMillion: 0.4,
                    requestPriceUsd: null,
                    isFree: false,
                    contextWindow: 131_072,
                    maxOutputTokens: 8192,
                    supportsTools: true,
                    supportsVision: true,
                    tags: ['tool-calling', 'vision'],
                };
            },
        };
        const enriched = enrichModelMetadata(envelope, {
            pricingDirectory: directory,
        });
        assert.ok(enriched.tags.includes('tool-calling'));
        assert.ok(
            enriched.tags.includes('vision'),
            'directory should fill the missing capability tag instead of treating tags as all-or-nothing'
        );
    });

    it('runs classifier when the directory is absent', () => {
        const envelope = makeEnvelope({
            providerKey: 'openai',
            providerModelId: 'gpt-4o',
            modelKey: 'openai/gpt-4o',
        });
        const enriched = enrichModelMetadata(envelope);
        assert.ok(enriched.tags.includes('chat'));
        assert.ok(enriched.tags.includes('fast'));
        assert.ok(enriched.tags.includes('tool-calling'));
        assert.equal(
            enriched.metadata.classifier.source,
            'model-metadata-classifier'
        );
    });

    it('can be called with enableClassifier:false to isolate directory precedence', () => {
        const envelope = makeEnvelope({
            providerKey: 'openai',
            providerModelId: 'gpt-4o',
            modelKey: 'openai/gpt-4o',
        });
        const enriched = enrichModelMetadata(envelope, {
            enableClassifier: false,
        });
        assert.deepEqual(enriched.tags, []);
        assert.equal(enriched.metadata.classifier, undefined);
    });

    it('returns a new envelope and does not mutate the input', () => {
        const envelope = makeEnvelope({
            providerKey: 'openai',
            providerModelId: 'gpt-4o',
            modelKey: 'openai/gpt-4o',
        });
        const beforeTags = [...envelope.tags];
        const beforeMetadata = { ...envelope.metadata };
        const beforeCapabilities = { ...envelope.capabilities };
        enrichModelMetadata(envelope);
        assert.deepEqual(envelope.tags, beforeTags);
        assert.deepEqual(envelope.metadata, beforeMetadata);
        assert.deepEqual(envelope.capabilities, beforeCapabilities);
    });

    it('records classifier provenance separately from directory provenance', () => {
        const envelope = makeEnvelope({
            providerKey: 'openai',
            providerModelId: 'gpt-4o',
            modelKey: 'openai/gpt-4o',
        });
        const directory = {
            lookupModel() {
                return {
                    id: 'openai/gpt-4o',
                    canonicalSlug: 'openai/gpt-4o',
                    matchedBy: 'id',
                    pricingMode: 'token',
                    inputPricePerMillion: 1,
                    outputPricePerMillion: 2,
                    requestPriceUsd: null,
                    isFree: false,
                    contextWindow: 128_000,
                    maxOutputTokens: 16_384,
                    supportsTools: true,
                    supportsVision: false,
                    tags: ['tool-calling'],
                };
            },
        };
        const enriched = enrichModelMetadata(envelope, {
            pricingDirectory: directory,
        });
        assert.equal(enriched.metadata.openrouter.source, 'openrouter');
        assert.equal(
            enriched.metadata.classifier.source,
            'model-metadata-classifier'
        );
        assert.ok(Array.isArray(enriched.metadata.classifier.tagsAdded));
    });

    it('applies curated free-provider rules even when the directory reports token pricing', () => {
        for (const providerKey of CURATED_FREE_PROVIDER_KEYS) {
            const envelope = makeEnvelope({
                providerKey,
                providerModelId: 'google/gemma-3-12b-it',
                modelKey: `${providerKey}/google/gemma-3-12b-it`,
            });
            const directory = {
                lookupModel() {
                    return {
                        id: 'google/gemma-3-12b-it',
                        canonicalSlug: 'google/gemma-3-12b-it',
                        matchedBy: 'alias',
                        pricingMode: 'token',
                        inputPricePerMillion: 0.04,
                        outputPricePerMillion: 0.13,
                        requestPriceUsd: null,
                        isFree: false,
                        contextWindow: 131_072,
                        maxOutputTokens: 8192,
                        supportsTools: true,
                        supportsVision: false,
                        tags: ['tool-calling'],
                    };
                },
            };

            const enriched = enrichModelMetadata(envelope, {
                pricingDirectory: directory,
            });

            assert.equal(enriched.isFree, true);
            assert.equal(enriched.inputPricePerMillion, 0.04);
            assert.equal(enriched.outputPricePerMillion, 0.13);
            assert.equal(
                enriched.metadata.curated.source,
                'curated-model-metadata'
            );
            assert.ok(
                enriched.metadata.curated.appliedRules.includes(
                    `provider:${providerKey}`
                )
            );
        }
    });

    it('fills exact curated model price/context overrides when the directory misses', () => {
        const envelope = makeEnvelope({
            providerKey: 'copilot',
            providerModelId: 'gpt-4o',
            modelKey: 'copilot/gpt-4o',
        });

        const enriched = enrichModelMetadata(envelope);

        assert.equal(enriched.isFree, true);
        assert.equal(enriched.contextWindow, 128_000);
        assert.equal(enriched.capabilities.contextWindow, 128_000);
        assert.equal(enriched.metadata.curated.matchedBy, 'exact_model');
        assert.ok(
            enriched.metadata.curated.appliedRules.includes(
                'model:copilot/gpt-4o'
            )
        );
    });

    it('does not let curated overrides replace provider-supplied token prices', () => {
        const envelope = makeEnvelope({
            providerKey: 'mistral',
            providerModelId: 'codestral-latest',
            modelKey: 'mistral/codestral-latest',
            pricingMode: 'token',
            inputPricePerMillion: 9,
            outputPricePerMillion: 10,
        });

        const enriched = enrichModelMetadata(envelope);

        assert.equal(enriched.inputPricePerMillion, 9);
        assert.equal(enriched.outputPricePerMillion, 10);
        assert.equal(enriched.isFree, true);
    });
});
