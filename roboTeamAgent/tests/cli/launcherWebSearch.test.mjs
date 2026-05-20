import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { action } from '../achilles-cli/src/skills/launch-web-search/src/index.mjs';

describe('launch-web-search fallback cskill', () => {
    it('treats provider-looking @web-search text as ordinary chat input', async () => {
        const context = { providerLauncherResults: [] };
        const result = await action({
            prompt: '@web-search latest Node.js release',
            context,
        });

        assert.equal(result.ok, false);
        assert.equal(result.cacheable, false);
        assert.equal(result.diagnostics.deprecatedToken, true);
        assert.equal(result.diagnostics.providerAvailability, 'disabled');
        assert.match(result.result_text, /ordinary chat text/);
        assert.equal(context.providerLauncherResults.length, 1);
        assert.equal(context.providerLauncherResults[0].result.diagnostics.deprecatedToken, true);
    });

    it('keeps natural web prompts unavailable until a deployed launcher overrides it', async () => {
        const result = await action({
            prompt: 'Search online for recent release notes.',
            context: {},
        });

        assert.equal(result.ok, false);
        assert.equal(result.cacheable, false);
        assert.equal(result.diagnostics.providerAvailability, 'disabled');
        assert.equal(result.diagnostics.promptProvided, true);
        assert.match(result.result_text, /not deployed/);
    });
});
