import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { readEnv } from '../../config/env.mjs';

describe('readEnv AXL_PROXY_*', () => {
    it('defaults key/base-url to null and discovery-mode to auto', () => {
        const env = readEnv({});
        assert.equal(env.AXL_PROXY_API_KEY, null);
        assert.equal(env.AXL_PROXY_BASE_URL, null);
        assert.equal(env.AXL_PROXY_DISCOVERY_MODE, 'auto');
    });

    it('reads provided values', () => {
        const env = readEnv({
            AXL_PROXY_API_KEY: 'k',
            AXL_PROXY_BASE_URL: 'https://soul.axiologic.dev/v1',
            AXL_PROXY_DISCOVERY_MODE: 'off',
        });
        assert.equal(env.AXL_PROXY_API_KEY, 'k');
        assert.equal(env.AXL_PROXY_BASE_URL, 'https://soul.axiologic.dev/v1');
        assert.equal(env.AXL_PROXY_DISCOVERY_MODE, 'off');
    });
});
