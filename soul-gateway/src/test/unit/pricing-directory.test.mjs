import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
    PricingDirectory,
} from '../../runtime/policy/pricing-directory.mjs';

describe('PricingDirectory', () => {
    let originalFetch;

    beforeEach(() => {
        originalFetch = globalThis.fetch;
    });

    afterEach(() => {
        globalThis.fetch = originalFetch;
    });

    it('loads OpenRouter model metadata and exposes pricing / context lookups', async () => {
        globalThis.fetch = async () =>
            new Response(
                JSON.stringify({
                    data: [
                        {
                            id: 'google/gemma-3-27b-it',
                            canonical_slug: 'google/gemma-3-27b-it',
                            name: 'Google: Gemma 3 27B',
                            context_length: 131072,
                            pricing: {
                                prompt: '0.00000027',
                                completion: '0.00000040',
                            },
                            top_provider: {
                                max_completion_tokens: 8192,
                                is_moderated: true,
                            },
                            architecture: {
                                input_modalities: ['text', 'image'],
                                output_modalities: ['text'],
                            },
                            supported_parameters: [
                                'tools',
                                'tool_choice',
                                'structured_outputs',
                            ],
                        },
                    ],
                }),
                {
                    status: 200,
                    headers: { 'Content-Type': 'application/json' },
                }
            );

        const directory = new PricingDirectory({
            url: 'https://openrouter.ai/api/v1/models',
        });
        await directory.refreshIfNeeded();

        const pricing = directory.lookup('nvidia', 'google/gemma-3-27b-it');
        assert.equal(pricing.pricingMode, 'token');
        assert.equal(pricing.inputPricePerMillion, 0.27);
        assert.equal(pricing.outputPricePerMillion, 0.4);

        const model = directory.lookupModel('nvidia', 'google/gemma-3-27b-it');
        assert.equal(model.contextWindow, 131072);
        assert.equal(model.maxOutputTokens, 8192);
        assert.deepEqual(model.tags, [
            'moderated',
            'structured-outputs',
            'tool-calling',
            'vision',
        ]);
    });

    it('resolves a known provider-namespace mismatch via the curated alias map', async () => {
        globalThis.fetch = async () =>
            new Response(
                JSON.stringify({
                    data: [
                        {
                            id: 'meta-llama/llama-3.1-8b-instruct',
                            canonical_slug: 'meta-llama/llama-3.1-8b-instruct',
                            name: 'Meta Llama 3.1 8B Instruct',
                            context_length: 131072,
                            pricing: {
                                prompt: '0.00000020',
                                completion: '0.00000020',
                            },
                            top_provider: {
                                max_completion_tokens: 8192,
                                is_moderated: false,
                            },
                            architecture: {
                                input_modalities: ['text'],
                                output_modalities: ['text'],
                            },
                            supported_parameters: ['tools'],
                        },
                    ],
                }),
                {
                    status: 200,
                    headers: { 'Content-Type': 'application/json' },
                }
            );

        const directory = new PricingDirectory({
            url: 'https://openrouter.ai/api/v1/models',
        });
        await directory.refreshIfNeeded();

        // `nvidia/meta/llama-3.1-8b-instruct` is rewritten by the alias
        // map to `meta-llama/llama-3.1-8b-instruct`, which matches the
        // upstream id exactly. Alias rewriting wins over leaf-slug match
        // because an exact id match is strictly more specific than a
        // deduplicated-leaf match.
        const model = directory.lookupModel(
            'nvidia',
            'meta/llama-3.1-8b-instruct'
        );
        assert.equal(model.id, 'meta-llama/llama-3.1-8b-instruct');
        assert.equal(model.matchedBy, 'alias');
    });

    it('still falls back to leaf-slug match when no alias rule applies', async () => {
        globalThis.fetch = async () =>
            new Response(
                JSON.stringify({
                    data: [
                        {
                            id: 'example-org/example-chat-13b',
                            canonical_slug: 'example-org/example-chat-13b',
                            name: 'Example Chat 13B',
                            context_length: 8192,
                            pricing: { prompt: '0', completion: '0' },
                            architecture: {
                                input_modalities: ['text'],
                                output_modalities: ['text'],
                            },
                            supported_parameters: [],
                        },
                    ],
                }),
                { status: 200, headers: { 'Content-Type': 'application/json' } }
            );

        const directory = new PricingDirectory({
            url: 'https://openrouter.ai/api/v1/models',
        });
        await directory.refreshIfNeeded();

        const model = directory.lookupModel(
            'some-other-provider',
            'weird-prefix/example-chat-13b'
        );
        assert.equal(model.id, 'example-org/example-chat-13b');
        assert.equal(model.matchedBy, 'leaf_slug');
    });

    it('leaves adversarial inputs unresolved (no fuzzy match)', async () => {
        globalThis.fetch = async () =>
            new Response(
                JSON.stringify({
                    data: [
                        {
                            id: 'meta-llama/llama-3.1-8b-instruct',
                            canonical_slug: 'meta-llama/llama-3.1-8b-instruct',
                            name: 'Meta Llama 3.1 8B Instruct',
                            context_length: 131072,
                            pricing: { prompt: '0', completion: '0' },
                            architecture: {
                                input_modalities: ['text'],
                                output_modalities: ['text'],
                            },
                            supported_parameters: [],
                        },
                    ],
                }),
                { status: 200, headers: { 'Content-Type': 'application/json' } }
            );

        const directory = new PricingDirectory({
            url: 'https://openrouter.ai/api/v1/models',
        });
        await directory.refreshIfNeeded();

        // Neither exact nor alias nor leaf slug matches — directory must
        // return null rather than guess a similar entry.
        assert.equal(
            directory.lookupModel('nvidia', 'nonexistent/total-mystery-model'),
            null
        );
    });
});
