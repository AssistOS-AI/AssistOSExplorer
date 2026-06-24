import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const manifestPath = join(here, '../../../manifest.json');

describe('soul-gateway manifest AXL_PROXY_* env', () => {
    it('declares the three AXL_PROXY_* env entries', () => {
        const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
        const env = manifest.profiles.default.env;
        assert.ok(env.AXL_PROXY_API_KEY, 'AXL_PROXY_API_KEY declared');
        assert.equal(env.AXL_PROXY_API_KEY.required, false);
        assert.ok('default' in env.AXL_PROXY_API_KEY);
        assert.ok(env.AXL_PROXY_BASE_URL, 'AXL_PROXY_BASE_URL declared');
        assert.equal(env.AXL_PROXY_BASE_URL.required, false);
        assert.equal(env.AXL_PROXY_DISCOVERY_MODE.default, 'auto');
    });
});
