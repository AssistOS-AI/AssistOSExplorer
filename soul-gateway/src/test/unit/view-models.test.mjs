import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
    toProviderView,
    toProviderList,
} from '../../management/provider-view.mjs';

describe('management/provider-view', () => {
    it('preserves DB fields in the view', () => {
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

        assert.equal(view.id, 'p1');
        assert.equal(view.provider_key, 'codex');
        assert.equal(view.display_name, 'OpenAI Codex');
        assert.equal(view.adapter_key, 'codex-api');
        assert.equal(view.base_url, 'https://chatgpt.com/backend-api/codex');
        assert.equal(view.enabled, true);
        assert.equal(view.oauth_adapter_key, 'openai-codex');
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
            assert.equal(list[0].provider_key, 'codex');
            assert.equal(list[1].provider_key, 'anthropic');
        });

        it('tolerates non-array input', () => {
            assert.deepEqual(toProviderList(null), []);
            assert.deepEqual(toProviderList(undefined), []);
            assert.deepEqual(toProviderList({}), []);
        });
    });
});
