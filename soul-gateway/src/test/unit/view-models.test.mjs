import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
    toProviderView,
    toProviderList,
} from '../../management/provider-view.mjs';
import {
    toDiscoveryView,
    toDiscoveryList,
} from '../../management/model-discovery-view.mjs';

describe('management/provider-view', () => {
    it('aliases provider_key to name and preserves other fields', () => {
        const row = {
            id: 'p1',
            provider_key: 'codex',
            display_name: 'OpenAI Codex',
            adapter_key: 'codex-api',
            base_url: 'https://chatgpt.com/backend-api/codex',
            enabled: true,
            oauth_adapter_key: 'openai-codex',
        };
        const view = toProviderView(row);

        assert.equal(view.name, 'codex');
        assert.equal(view.id, 'p1');
        assert.equal(view.provider_key, 'codex');
        assert.equal(view.display_name, 'OpenAI Codex');
        assert.equal(view.adapter_key, 'codex-api');
        assert.equal(view.base_url, 'https://chatgpt.com/backend-api/codex');
        assert.equal(view.enabled, true);
        assert.equal(view.oauth_adapter_key, 'openai-codex');
    });

    it('prefers an explicit name when provider_key is absent', () => {
        const view = toProviderView({
            id: 'p1',
            name: 'custom',
            provider_key: null,
        });
        assert.equal(view.name, 'custom');
    });

    it('returns null for null input', () => {
        assert.equal(toProviderView(null), null);
    });

    describe('toProviderList', () => {
        it('maps rows and skips falsy entries', () => {
            const list = toProviderList([
                { id: 'p1', provider_key: 'codex', display_name: 'Codex' },
                null,
                {
                    id: 'p2',
                    provider_key: 'anthropic',
                    display_name: 'Anthropic',
                },
            ]);
            assert.equal(list.length, 2);
            assert.equal(list[0].name, 'codex');
            assert.equal(list[1].name, 'anthropic');
        });

        it('tolerates non-array input', () => {
            assert.deepEqual(toProviderList(null), []);
            assert.deepEqual(toProviderList(undefined), []);
            assert.deepEqual(toProviderList({}), []);
        });
    });
});

describe('management/model-discovery-view', () => {
    it('translates a backend discovery model object to the dashboard shape', () => {
        const backendModel = {
            modelId: 'gpt-5.4',
            displayName: 'GPT-5.4',
            contextWindow: 1_000_000,
            maxOutputTokens: 32768,
            supportsTools: true,
            supportsStreaming: true,
            supportsVision: true,
        };
        const view = toDiscoveryView(backendModel, { providerName: 'codex' });

        assert.equal(view.id, 'gpt-5.4');
        assert.equal(view.display_name, 'GPT-5.4');
        assert.equal(view.owned_by, 'codex');
        assert.equal(view.input_price, 0);
        assert.equal(view.output_price, 0);
        assert.equal(view.context_window, 1_000_000);
        assert.equal(view.max_output_tokens, 32768);
        assert.equal(view.supports_tools, true);
        assert.equal(view.supports_streaming, true);
        assert.equal(view.supports_vision, true);
    });

    it('accepts already-flat legacy shapes (id/input_price/output_price/owned_by)', () => {
        const view = toDiscoveryView({
            id: 'gpt-4o',
            display_name: 'GPT-4o',
            owned_by: 'openai',
            input_price: 2.5,
            output_price: 10,
        });
        assert.equal(view.id, 'gpt-4o');
        assert.equal(view.owned_by, 'openai');
        assert.equal(view.input_price, 2.5);
        assert.equal(view.output_price, 10);
    });

    it('falls back to provider name for owned_by when the backend omits it', () => {
        const view = toDiscoveryView(
            { modelId: 'claude-sonnet-4' },
            { providerName: 'anthropic' }
        );
        assert.equal(view.owned_by, 'anthropic');
    });

    it('defaults display_name to the model id when neither is provided', () => {
        const view = toDiscoveryView({ modelId: 'gpt-5' });
        assert.equal(view.display_name, 'gpt-5');
    });

    it('returns null when the backend object has no identifier', () => {
        assert.equal(toDiscoveryView({ displayName: 'Nameless' }), null);
        assert.equal(toDiscoveryView(null), null);
    });

    it('coerces numeric-string prices into numbers and defaults to 0 on NaN', () => {
        const view = toDiscoveryView({
            modelId: 'm',
            input_price: '1.5',
            output_price: 'not-a-number',
        });
        assert.equal(view.input_price, 1.5);
        assert.equal(view.output_price, 0);
    });

    describe('toDiscoveryList', () => {
        it('translates an array of backend discovery models', () => {
            const list = toDiscoveryList(
                [
                    { modelId: 'a', displayName: 'A' },
                    { modelId: 'b', displayName: 'B' },
                ],
                { providerName: 'codex' }
            );
            assert.equal(list.length, 2);
            assert.equal(list[0].id, 'a');
            assert.equal(list[0].owned_by, 'codex');
            assert.equal(list[1].id, 'b');
        });

        it('filters out models without an id', () => {
            const list = toDiscoveryList([
                { modelId: 'a' },
                { displayName: 'Nameless' },
                { modelId: 'c' },
            ]);
            assert.equal(list.length, 2);
            assert.equal(list[0].id, 'a');
            assert.equal(list[1].id, 'c');
        });

        it('tolerates non-array input', () => {
            assert.deepEqual(toDiscoveryList(null), []);
            assert.deepEqual(toDiscoveryList(undefined), []);
            assert.deepEqual(toDiscoveryList({}), []);
        });
    });
});
